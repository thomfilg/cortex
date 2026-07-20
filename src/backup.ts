/**
 * Cortex Remote Backup Module
 *
 * Periodic gzip snapshots of the database uploaded to a remote via rclone
 * (Google Drive, S3, Dropbox, ... - any rclone remote). Scheduling lives in
 * the daemon (interval check + best-effort on shutdown); `cortex backup` is
 * the manual path for classic mode.
 *
 * Snapshot strategies (all produce a consistent .db file):
 * - native handle (daemon): VACUUM INTO - atomic, compacted, safe under WAL
 * - wasm handle: export() bytes (the in-memory copy is always consistent)
 * - no handle (CLI, daemon not running): checkpoint any leftover WAL via a
 *   short-lived native connection, then copy the file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { getDataDir, getDatabasePath, loadConfig } from './config.js';
import { tryOpenNative, type Storage, type StorageKind } from './storage.js';
import type { BackupConfig } from './types.js';

const RCLONE_TIMEOUT_MS = 15 * 60 * 1000; // uploads of ~200MB on slow links
const SNAPSHOT_PREFIX = 'memory-';
const SNAPSHOT_SUFFIX = '.db.gz';

// ============================================================================
// State (~/.cortex/backup-state.json)
// ============================================================================

export interface BackupState {
  lastBackupAt: string | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  lastRemoteName: string | null;
  lastSizeBytes: number | null;
  lastDurationMs: number | null;
}

const EMPTY_STATE: BackupState = {
  lastBackupAt: null,
  lastResult: null,
  lastError: null,
  lastRemoteName: null,
  lastSizeBytes: null,
  lastDurationMs: null,
};

export function getBackupStatePath(): string {
  return path.join(getDataDir(), 'backup-state.json');
}

export function loadBackupState(): BackupState {
  try {
    const raw = fs.readFileSync(getBackupStatePath(), 'utf8');
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<BackupState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveBackupState(state: BackupState): void {
  try {
    fs.writeFileSync(getBackupStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // State is advisory; never fail a backup over it
  }
}

/**
 * A scheduled backup is due when none has ever succeeded, or the last
 * successful one is older than the configured interval.
 */
export function isBackupDue(config: BackupConfig): boolean {
  if (!config.enabled || !config.remote) return false;
  const state = loadBackupState();
  if (state.lastResult !== 'ok' || !state.lastBackupAt) return true;
  const elapsed = Date.now() - new Date(state.lastBackupAt).getTime();
  return elapsed >= config.intervalMinutes * 60 * 1000;
}

// ============================================================================
// rclone
// ============================================================================

function rclone(args: string[], timeoutMs: number = RCLONE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`rclone ${args[0]} failed: ${stderr?.trim() || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function rcloneAvailable(): Promise<boolean> {
  try {
    await rclone(['version'], 5000);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Snapshot creation
// ============================================================================

function snapshotTmpDir(): string {
  const dir = path.join(getDataDir(), 'backup-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotName(): string {
  // memory-2026-07-20T17-45-00.db.gz (filesystem/Drive-safe timestamp)
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
  return `${SNAPSHOT_PREFIX}${stamp}${SNAPSHOT_SUFFIX}`;
}

/**
 * Snapshot from a live database handle (daemon path).
 */
export function createSnapshotFromDb(db: Storage, kind: StorageKind, outPath: string): void {
  if (kind === 'native') {
    // Atomic consistent copy, also compacts free pages
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    db.run('VACUUM INTO ?', [outPath]);
  } else {
    fs.writeFileSync(outPath, db.export());
  }
}

/**
 * Snapshot from the database file without a long-lived handle (CLI path).
 * Prefers VACUUM INTO through a short-lived native connection: under WAL
 * that yields a consistent snapshot even while another process (a daemon)
 * is writing. Falls back to a plain file copy when native is unavailable
 * (wasm writers rewrite the whole file atomically, so the copy is safe).
 */
export async function createSnapshotFromFile(outPath: string): Promise<void> {
  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  const native = await tryOpenNative(dbPath);
  if (native) {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      native.run('VACUUM INTO ?', [outPath]);
      return;
    } finally {
      native.close();
    }
  }

  fs.copyFileSync(dbPath, outPath);
}

async function gzipFile(srcPath: string, destPath: string): Promise<void> {
  await pipeline(
    fs.createReadStream(srcPath),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(destPath)
  );
}

// ============================================================================
// Upload + rotation
// ============================================================================

interface RemoteEntry {
  Name: string;
}

async function rotateRemote(remote: string, keep: number): Promise<string[]> {
  // keep <= 0 means "never rotate" (retain everything)
  if (keep <= 0) return [];
  let listing: RemoteEntry[];
  try {
    listing = JSON.parse(await rclone(['lsjson', '--files-only', '--', remote])) as RemoteEntry[];
  } catch {
    // Listing failures must not fail the backup that just uploaded
    return [];
  }

  const snapshots = listing
    .map((e) => e.Name)
    .filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith(SNAPSHOT_SUFFIX))
    .sort()
    .reverse(); // newest first (ISO timestamps sort lexicographically)

  const excess = snapshots.slice(keep);
  const removed: string[] = [];
  for (const name of excess) {
    try {
      await rclone(['deletefile', `${remote}/${name}`]);
      removed.push(name);
    } catch {
      // Leave strays; next rotation retries
    }
  }
  return removed;
}

// ============================================================================
// Orchestration
// ============================================================================

export interface BackupResult {
  remoteName: string;
  sizeBytes: number;
  durationMs: number;
  rotatedOut: string[];
}

export interface BackupSource {
  /** Live handle (daemon). When absent, snapshots from the file on disk. */
  db?: Storage;
  kind?: StorageKind;
}

/**
 * Run a full backup: snapshot -> gzip -> upload -> rotate.
 * Throws on failure (after recording it in backup-state.json).
 */
export async function runBackup(source: BackupSource = {}): Promise<BackupResult> {
  const config = loadConfig().backup;
  if (!config.remote) {
    throw new Error('No backup remote configured (set backup.remote, e.g. "gdrive:cortex-backups")');
  }
  if (!(await rcloneAvailable())) {
    throw new Error('rclone not found on PATH - install it and run `rclone config` to add your remote');
  }

  const started = Date.now();
  const tmpDir = snapshotTmpDir();
  const name = snapshotName();
  const rawPath = path.join(tmpDir, name.replace(/\.gz$/, ''));
  const gzPath = path.join(tmpDir, name);

  try {
    if (source.db && source.kind) {
      createSnapshotFromDb(source.db, source.kind, rawPath);
    } else {
      await createSnapshotFromFile(rawPath);
    }

    await gzipFile(rawPath, gzPath);
    const sizeBytes = fs.statSync(gzPath).size;

    await rclone(['copyto', gzPath, `${config.remote}/${name}`]);
    const rotatedOut = await rotateRemote(config.remote, config.keep);

    const result: BackupResult = {
      remoteName: name,
      sizeBytes,
      durationMs: Date.now() - started,
      rotatedOut,
    };
    saveBackupState({
      lastBackupAt: new Date().toISOString(),
      lastResult: 'ok',
      lastError: null,
      lastRemoteName: name,
      lastSizeBytes: sizeBytes,
      lastDurationMs: result.durationMs,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveBackupState({
      ...loadBackupState(),
      lastResult: 'error',
      lastError: message,
    });
    throw error;
  } finally {
    for (const p of [rawPath, gzPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Already gone
      }
    }
  }
}
