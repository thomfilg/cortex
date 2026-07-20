/**
 * Cortex Memory Sync Module (Tier 2)
 *
 * Bidirectional memory sync between machines (or team members) through a
 * shared rclone remote. NOT file-level sync of memory.db - that would be
 * last-writer-wins and destroy concurrent work. Instead:
 *
 * - Each device appends ONLY to its own changelog folder on the remote
 *   (<remote>/<deviceId>/<seq>.jsonl.gz), so there are no write conflicts
 *   by construction.
 * - A changelog line is either an addition ({"t":"add",...} with content,
 *   embedding, and metadata) or a tombstone ({"t":"del","h":hash}).
 * - Reconciliation is set-union keyed on content_hash (UNIQUE in the
 *   schema): pulls INSERT OR IGNORE additions and apply tombstones.
 *   Tombstones also suppress re-import of locally deleted content.
 * - memories.origin_device records where a row came from: NULL = authored
 *   locally (gets pushed), a device id = imported (never re-pushed, which
 *   prevents echo loops).
 *
 * All devices must use the same embedding model (embeddings travel in the
 * changelog and are compared cross-device by vector search).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { getDataDir, loadConfig } from './config.js';
import { rclone } from './backup.js';
import type { Storage } from './storage.js';
import type { SyncConfig } from './types.js';

const CHANGELOG_SUFFIX = '.jsonl.gz';
const MAX_LINES_PER_FILE = 5000;
const SEQ_PAD = 8;

// ============================================================================
// Changelog line formats
// ============================================================================

interface AddLine {
  t: 'add';
  h: string;        // content_hash
  c: string;        // content
  e: string;        // embedding, base64
  p: string | null; // project_id
  s: string;        // source_session
  ts: string;       // timestamp ISO
}

interface DelLine {
  t: 'del';
  h: string;  // content_hash
  ts: string; // deleted_at ISO
}

type ChangeLine = AddLine | DelLine;

// ============================================================================
// State (~/.cortex/sync-state.json)
// ============================================================================

export interface SyncState {
  deviceId: string | null;
  lastSyncAt: string | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  /** Highest memories.id already pushed */
  lastPushedMemoryId: number;
  /** Highest sync_tombstones rowid already pushed */
  lastPushedTombstoneRowid: number;
  /** Next changelog sequence number to upload */
  nextSeq: number;
  /** Per-peer-device: highest changelog seq already applied */
  peers: Record<string, number>;
}

const EMPTY_SYNC_STATE: SyncState = {
  deviceId: null,
  lastSyncAt: null,
  lastResult: null,
  lastError: null,
  lastPushedMemoryId: 0,
  lastPushedTombstoneRowid: 0,
  nextSeq: 1,
  peers: {},
};

export function getSyncStatePath(): string {
  return path.join(getDataDir(), 'sync-state.json');
}

export function loadSyncState(): SyncState {
  try {
    const raw = fs.readFileSync(getSyncStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { ...EMPTY_SYNC_STATE, ...parsed, peers: { ...(parsed.peers ?? {}) } };
  } catch {
    return { ...EMPTY_SYNC_STATE, peers: {} };
  }
}

function saveSyncState(state: SyncState): void {
  fs.writeFileSync(getSyncStatePath(), JSON.stringify(state, null, 2));
}

/**
 * Stable per-machine device id, generated once. Hostname keeps it
 * recognizable in the remote folder listing; the suffix disambiguates
 * reinstalls and identical hostnames.
 */
export function ensureDeviceId(state: SyncState): string {
  if (state.deviceId) return state.deviceId;
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'device';
  state.deviceId = `${host}-${crypto.randomBytes(3).toString('hex')}`;
  saveSyncState(state);
  return state.deviceId;
}

/**
 * A scheduled sync is due when enabled+configured and the last successful
 * sync is older than the configured interval.
 */
export function isSyncDue(config: SyncConfig): boolean {
  if (!config.enabled || !config.remote) return false;
  const state = loadSyncState();
  if (state.lastResult !== 'ok' || !state.lastSyncAt) return true;
  return Date.now() - new Date(state.lastSyncAt).getTime() >= config.intervalMinutes * 60 * 1000;
}

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
  const dir = path.join(getDataDir(), 'sync-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seqName(seq: number): string {
  return `${String(seq).padStart(SEQ_PAD, '0')}${CHANGELOG_SUFFIX}`;
}

function embeddingToBase64(value: unknown): string {
  // sql.js returns Uint8Array, better-sqlite3 returns Buffer
  return Buffer.from(value as Uint8Array).toString('base64');
}

// ============================================================================
// Push: export local changes as changelog files
// ============================================================================

interface PushResult {
  memories: number;
  tombstones: number;
  files: number;
}

interface PushEntry {
  line: ChangeLine;
  /** memories.id backing this line (adds only) */
  memoryId?: number;
  /** sync_tombstones rowid backing this line (dels only) */
  tombstoneRowid?: number;
}

function collectLocalChanges(db: Storage, state: SyncState, config: SyncConfig): {
  entries: PushEntry[];
  /** Highest scanned local memories.id, including project-filtered rows */
  scannedMaxMemoryId: number;
} {
  const entries: PushEntry[] = [];

  let memoryQuery = `
    SELECT id, content, content_hash, embedding, project_id, source_session, timestamp
    FROM memories WHERE id > ? AND origin_device IS NULL`;
  const params: (string | number)[] = [state.lastPushedMemoryId];
  if (config.projects && config.projects.length > 0) {
    memoryQuery += ` AND project_id IN (${config.projects.map(() => '?').join(',')})`;
    params.push(...config.projects);
  }
  memoryQuery += ` ORDER BY id`;

  const memoryRows = db.exec(memoryQuery, params);
  if (memoryRows.length > 0) {
    for (const row of memoryRows[0].values) {
      entries.push({
        memoryId: row[0] as number,
        line: {
          t: 'add',
          h: row[2] as string,
          c: row[1] as string,
          e: embeddingToBase64(row[3]),
          p: row[4] as string | null,
          s: row[5] as string,
          ts: row[6] as string,
        },
      });
    }
  }

  // The final watermark must advance past project-filtered rows too, or
  // excluded rows would be re-scanned forever
  let scannedMaxMemoryId = state.lastPushedMemoryId;
  const maxIdResult = db.exec(`SELECT COALESCE(MAX(id), 0) FROM memories WHERE origin_device IS NULL`);
  if (maxIdResult.length > 0) {
    scannedMaxMemoryId = Math.max(scannedMaxMemoryId, maxIdResult[0].values[0][0] as number);
  }

  const tombRows = db.exec(
    `SELECT rowid, content_hash, deleted_at FROM sync_tombstones
     WHERE rowid > ? AND origin_device IS NULL ORDER BY rowid`,
    [state.lastPushedTombstoneRowid]
  );
  if (tombRows.length > 0) {
    for (const row of tombRows[0].values) {
      entries.push({
        tombstoneRowid: row[0] as number,
        line: { t: 'del', h: row[1] as string, ts: row[2] as string },
      });
    }
  }

  return { entries, scannedMaxMemoryId };
}

async function pushChanges(db: Storage, state: SyncState, config: SyncConfig, remote: string): Promise<PushResult> {
  const deviceId = ensureDeviceId(state);
  const { entries, scannedMaxMemoryId } = collectLocalChanges(db, state, config);

  const result: PushResult = {
    memories: entries.filter((e) => e.line.t === 'add').length,
    tombstones: entries.filter((e) => e.line.t === 'del').length,
    files: 0,
  };

  for (let offset = 0; offset < entries.length; offset += MAX_LINES_PER_FILE) {
    const chunk = entries.slice(offset, offset + MAX_LINES_PER_FILE);
    const name = seqName(state.nextSeq);
    const localPath = path.join(tmpDir(), name);
    try {
      const jsonl = chunk.map((e) => JSON.stringify(e.line)).join('\n') + '\n';
      fs.writeFileSync(localPath, zlib.gzipSync(jsonl, { level: 6 }));
      await rclone(['copyto', localPath, `${remote}/${deviceId}/${name}`]);
    } finally {
      try { fs.unlinkSync(localPath); } catch { /* already gone */ }
    }
    // Advance seq AND watermarks per uploaded chunk: a later chunk's
    // failure retries only the remaining rows (under a fresh seq) instead
    // of re-uploading already-pushed chunks as duplicate files
    state.nextSeq += 1;
    result.files += 1;
    for (const e of chunk) {
      if (e.memoryId !== undefined) {
        state.lastPushedMemoryId = Math.max(state.lastPushedMemoryId, e.memoryId);
      }
      if (e.tombstoneRowid !== undefined) {
        state.lastPushedTombstoneRowid = Math.max(state.lastPushedTombstoneRowid, e.tombstoneRowid);
      }
    }
    saveSyncState(state);
  }

  // Cover project-filtered rows after everything uploaded
  state.lastPushedMemoryId = Math.max(state.lastPushedMemoryId, scannedMaxMemoryId);
  saveSyncState(state);
  return result;
}

// ============================================================================
// Pull: apply other devices' changelogs
// ============================================================================

interface PullResult {
  added: number;
  deleted: number;
  files: number;
  peers: string[];
  /** Per-peer errors that did not abort the sync (retried next run) */
  errors: string[];
}

interface RemoteEntry {
  Name: string;
  IsDir: boolean;
}

function applyLines(db: Storage, lines: ChangeLine[], peerDevice: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;

  db.run('BEGIN');
  try {
    for (const line of lines) {
      if (line.t === 'add') {
        // Locally (or anywhere) deleted content stays deleted
        const tombstoned = db.exec(
          `SELECT 1 FROM sync_tombstones WHERE content_hash = ? LIMIT 1`,
          [line.h]
        );
        if (tombstoned.length > 0 && tombstoned[0].values.length > 0) continue;

        db.run(
          `INSERT OR IGNORE INTO memories (content, content_hash, embedding, project_id, source_session, timestamp, origin_device)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [line.c, line.h, Buffer.from(line.e, 'base64'), line.p, line.s, line.ts, peerDevice]
        );
        added += db.getRowsModified();
      } else if (line.t === 'del') {
        db.run(`DELETE FROM memories WHERE content_hash = ?`, [line.h]);
        deleted += db.getRowsModified();
        // Import the tombstone (marked with its origin so it is not
        // re-pushed by us) to suppress future re-imports
        db.run(
          `INSERT OR IGNORE INTO sync_tombstones (content_hash, deleted_at, origin_device) VALUES (?, ?, ?)`,
          [line.h, line.ts, peerDevice]
        );
      }
    }
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }

  return { added, deleted };
}

async function pullChanges(db: Storage, state: SyncState, remote: string): Promise<PullResult> {
  const deviceId = ensureDeviceId(state);
  const result: PullResult = { added: 0, deleted: 0, files: 0, peers: [], errors: [] };

  let dirs: RemoteEntry[];
  try {
    dirs = JSON.parse(await rclone(['lsjson', '--dirs-only', '--', remote])) as RemoteEntry[];
  } catch (error) {
    // A remote that does not exist yet (nothing pushed from anywhere) is
    // an empty sync, not a failure
    if (error instanceof Error && /not found|directory not found/i.test(error.message)) {
      return result;
    }
    throw error;
  }

  for (const dir of dirs) {
    const peer = dir.Name;
    if (!dir.IsDir || peer === deviceId) continue;

    // One broken peer must not block the others: catch per-peer and report
    try {
      const files = JSON.parse(
        await rclone(['lsjson', '--files-only', '--', `${remote}/${peer}`])
      ) as RemoteEntry[];

      const pending = files
        .map((f) => f.Name)
        .filter((n) => n.endsWith(CHANGELOG_SUFFIX))
        .map((n) => ({ name: n, seq: parseInt(n.slice(0, -CHANGELOG_SUFFIX.length), 10) }))
        .filter((f) => Number.isFinite(f.seq) && f.seq > (state.peers[peer] ?? 0))
        .sort((a, b) => a.seq - b.seq);

      if (pending.length > 0) {
        result.peers.push(peer);
      }

      for (const file of pending) {
        const localPath = path.join(tmpDir(), `${peer}-${file.name}`);
        let lines: ChangeLine[];
        try {
          await rclone(['copyto', `${remote}/${peer}/${file.name}`, localPath]);
          const jsonl = zlib.gunzipSync(fs.readFileSync(localPath)).toString('utf8');
          lines = jsonl
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as ChangeLine);
        } finally {
          try { fs.unlinkSync(localPath); } catch { /* already gone */ }
        }

        const applied = applyLines(db, lines, peer);
        result.added += applied.added;
        result.deleted += applied.deleted;
        result.files += 1;

        // Advance per-file so a later failure never re-applies this one
        state.peers[peer] = file.seq;
        saveSyncState(state);
      }
    } catch (error) {
      // Stop at the failing file for THIS peer (its later files must wait
      // to preserve per-peer ordering) but keep syncing other peers; the
      // stuck file retries on the next run
      result.errors.push(`${peer}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

// ============================================================================
// Orchestration
// ============================================================================

export interface SyncResult {
  deviceId: string;
  pushed: PushResult;
  pulled: PullResult;
  durationMs: number;
}

export interface SyncOptions {
  push?: boolean;
  pull?: boolean;
}

/**
 * Run a sync cycle: pull first (so our push happens on top of the freshest
 * state), then push. Throws on failure after recording it in sync-state.
 */
export async function runSync(db: Storage, options: SyncOptions = {}): Promise<SyncResult> {
  const { push = true, pull = true } = options;
  const config = loadConfig().sync;
  if (!config.remote) {
    throw new Error('No sync remote configured (set sync.remote, e.g. "gdrive:cortex-sync")');
  }

  const started = Date.now();
  const state = loadSyncState();
  const deviceId = ensureDeviceId(state);

  try {
    const pulled = pull
      ? await pullChanges(db, state, config.remote)
      : { added: 0, deleted: 0, files: 0, peers: [], errors: [] };
    const pushed = push
      ? await pushChanges(db, state, config, config.remote)
      : { memories: 0, tombstones: 0, files: 0 };

    state.lastSyncAt = new Date().toISOString();
    state.lastResult = 'ok';
    state.lastError = null;
    saveSyncState(state);

    return { deviceId, pushed, pulled, durationMs: Date.now() - started };
  } catch (error) {
    state.lastResult = 'error';
    state.lastError = error instanceof Error ? error.message : String(error);
    saveSyncState(state);
    throw error;
  }
}
