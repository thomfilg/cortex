/**
 * Cortex Daemon
 * Optional shared HTTP server: ONE process holds the database and the
 * embedding model, serving any number of Claude Code instances.
 *
 * Endpoints:
 *   GET  /health    - liveness + version (used for the auto-update handshake)
 *   POST /mcp       - MCP JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /stats     - statusline data (?projectId= for project stats)
 *   POST /restore   - formatted restoration context
 *   POST /archive   - archive a session (async: true -> queued, returns 202)
 *   POST /shutdown  - graceful shutdown (used when a newer plugin build takes over)
 *
 * Singleton: on EADDRINUSE, if a healthy daemon of the SAME version holds
 * the port we exit quietly; a DIFFERENT version is asked to shut down and
 * we take over (this is how the daemon auto-updates with the plugin).
 */

import * as http from 'http';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { initDb, closeDb, getStats, getProjectStats, getStorageKind, compactDatabase, type CompactOptions } from './database.js';
import { handleMcpRequest, type MCPRequest } from './tools.js';
import { archiveSession, formatArchiveResult, buildRestorationContext, formatRestorationContext } from './archive.js';
import { loadConfig, getDaemonPort, getDaemonInfoPath, markAutoSaved } from './config.js';
import { recordSavePoint } from './analytics.js';
import { getDaemonHealth, stopDaemon } from './daemon-client.js';
import { isServerMode, getBindHost, getServerToken, isAuthorized } from './daemon-auth.js';
import { runBackup, isBackupDue } from './backup.js';
import { runSync, isSyncDue, type SyncOptions } from './sync.js';
import { vectorSearch } from './search.js';
import { VERSION } from './version.js';
import type { Storage } from './storage.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const startedAt = Date.now();

// Database loads once, lazily awaited by handlers (loading a large DB can
// take seconds; /health responds immediately so clients see us come up).
// The daemon prefers the native (better-sqlite3) backend: file-backed with
// WAL, so the DB is not held in RAM; falls back to sql.js when unavailable.
let dbPromise: Promise<Storage> | null = null;
let dbReady = false;
function getDb(): Promise<Storage> {
  if (!dbPromise) {
    dbPromise = initDb({ preferNative: loadConfig().daemon.storage !== 'wasm' });
    dbPromise.then(() => { dbReady = true; }).catch(() => undefined);
  }
  return dbPromise;
}

// Serialize write-heavy operations: single writer, one at a time
let writeChain: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = writeChain.then(job);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

interface ArchiveRequestBody {
  transcriptPath: string;
  projectId?: string | null;
  contextPercent?: number;
  markAutoSave?: boolean;
  async?: boolean;
  /** Remote path: uploaded transcript content the server parses in place. */
  transcriptContent?: string;
  /** Client identity override for attribution (remote path). */
  identity?: { user: string | null; environment: string | null };
}

async function runArchive(body: ArchiveRequestBody): Promise<{ archived: number; skipped: number; duplicates: number; formatted: string }> {
  const db = await getDb();
  const projectId = body.projectId ?? null;
  const result = await archiveSession(db, body.transcriptPath, projectId, {
    transcriptContent: body.transcriptContent,
    identity: body.identity,
  });

  if (body.markAutoSave) {
    // Update shared auto-save state so statuslines across sessions reflect it.
    // archived === 0 is recorded too, preventing immediate re-trigger loops.
    markAutoSaved(body.transcriptPath, body.contextPercent ?? 0, result.archived);
  }
  if (result.archived > 0) {
    recordSavePoint(body.contextPercent ?? 0, result.archived);
  }

  return { ...result, formatted: formatArchiveResult(result) };
}

function enqueueArchive(body: ArchiveRequestBody): Promise<{ archived: number; skipped: number; duplicates: number; formatted: string }> {
  return enqueue(() => runArchive(body));
}

// ============================================================================
// HTTP plumbing
// ============================================================================

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

/**
 * Parse a JSON request body, returning null on malformed input
 * (callers respond 400 instead of throwing into the 500 path)
 */
function parseBody<T>(raw: string): T | null {
  try {
    return JSON.parse(raw || '{}') as T;
  } catch {
    return null;
  }
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = `${req.method} ${url.pathname}`;

  // Auth gate (public server mode only): /health stays open so the client
  // version handshake works without credentials, but reveals no data.
  if (route !== 'GET /health' && !isAuthorized(req.headers['authorization'])) {
    respondJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  switch (route) {
    case 'GET /health': {
      respondJson(res, 200, {
        name: 'cortex-daemon',
        version: VERSION,
        pid: process.pid,
        port: getDaemonPort(),
        uptime: Math.round((Date.now() - startedAt) / 1000),
        storage: dbReady ? getStorageKind() : 'loading',
      });
      return;
    }

    case 'POST /mcp': {
      const raw = await readBody(req);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        respondJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error', data: error instanceof Error ? error.message : String(error) },
        });
        return;
      }

      // Notifications (no id) require no response
      if (!('id' in message)) {
        res.writeHead(202).end();
        return;
      }

      const db = await getDb();
      const response = await handleMcpRequest(db, message as unknown as MCPRequest);
      respondJson(res, 200, response);
      return;
    }

    case 'GET /stats': {
      const db = await getDb();
      const stats = getStats(db);
      const payload: Record<string, unknown> = {
        version: VERSION,
        storage: getStorageKind(),
        fragmentCount: stats.fragmentCount,
        projectCount: stats.projectCount,
        sessionCount: stats.sessionCount,
        dbSizeBytes: stats.dbSizeBytes,
      };

      const projectId = url.searchParams.get('projectId');
      if (projectId) {
        const projectStats = getProjectStats(db, projectId);
        payload.project = {
          fragmentCount: projectStats.fragmentCount,
          sessionCount: projectStats.sessionCount,
          lastArchive: projectStats.lastArchive?.toISOString() || null,
        };
      }

      respondJson(res, 200, payload);
      return;
    }

    case 'POST /restore': {
      const body = parseBody<{
        projectId?: string | null;
        messageCount?: number;
        tokenBudget?: number;
      }>(await readBody(req));
      if (!body) {
        respondJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const db = await getDb();
      const restoration = await buildRestorationContext(db, body.projectId ?? null, {
        messageCount: body.messageCount ?? 5,
        tokenBudget: body.tokenBudget ?? 2000,
      });
      respondJson(res, 200, {
        hasContent: restoration.hasContent,
        formatted: restoration.hasContent ? formatRestorationContext(restoration) : '',
      });
      return;
    }

    case 'POST /archive': {
      const body = parseBody<ArchiveRequestBody>(await readBody(req));
      if (!body) {
        respondJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!body.transcriptPath) {
        respondJson(res, 400, { error: 'transcriptPath is required' });
        return;
      }

      if (body.async) {
        // Queue and acknowledge immediately (statusline/post-tool hooks
        // have tight timeouts and must not wait for embedding work)
        enqueueArchive(body).catch(() => undefined);
        respondJson(res, 202, { queued: true });
        return;
      }

      const result = await enqueueArchive(body);
      respondJson(res, 200, result);
      return;
    }

    case 'POST /compact': {
      const body = parseBody<CompactOptions>(await readBody(req));
      if (!body) {
        respondJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      // Queued behind archives: compaction and writes never interleave
      const db = await getDb();
      const report = await enqueue(async () => compactDatabase(db, body));
      respondJson(res, 200, { ...report, storage: getStorageKind() });
      return;
    }

    case 'POST /backup': {
      // Queued behind archives/compaction: the snapshot never races a writer
      const db = await getDb();
      const result = await enqueue(() => runBackup({ db, kind: getStorageKind() }));
      respondJson(res, 200, result);
      return;
    }

    case 'POST /sync': {
      const body = parseBody<SyncOptions>(await readBody(req));
      if (!body) {
        respondJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      // Queued behind archives/compaction/backup: sync writes never race
      const db = await getDb();
      const result = await enqueue(() => runSync(db, body));
      respondJson(res, 200, result);
      return;
    }

    case 'POST /recall': {
      const body = parseBody<{
        query?: string;
        projectId?: string | null;
        limit?: number;
        minScore?: number;
      }>(await readBody(req));
      if (!body) {
        respondJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!body.query) {
        respondJson(res, 400, { error: 'query is required' });
        return;
      }
      // Read-only: not enqueued behind the write chain. Cosine scores are
      // returned raw so the caller applies its own relevance threshold.
      const db = await getDb();
      const results = await vectorSearch(db, body.query, {
        projectScope: body.projectId != null,
        projectId: body.projectId ?? undefined,
        limit: body.limit ?? 10,
      });
      const minScore = body.minScore ?? 0;
      respondJson(res, 200, {
        results: results
          .filter((r) => r.score >= minScore)
          .map((r) => ({
            id: r.id,
            score: r.score,
            content: r.content,
            timestamp: r.timestamp.toISOString(),
            projectId: r.projectId,
          })),
      });
      return;
    }

    case 'POST /shutdown': {
      respondJson(res, 200, { shuttingDown: true });
      setTimeout(() => shutdown(0), 50);
      return;
    }

    default: {
      respondJson(res, 404, { error: `Unknown route: ${route}` });
    }
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

function writeDaemonInfo(port: number): void {
  try {
    fs.writeFileSync(
      getDaemonInfoPath(),
      JSON.stringify({ pid: process.pid, port, version: VERSION, startedAt: new Date(startedAt).toISOString() }, null, 2)
    );
  } catch {
    // Non-fatal
  }
}

function removeDaemonInfo(): void {
  try {
    const infoPath = getDaemonInfoPath();
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid?: number };
      // Only remove our own record (a replacement daemon may have written its own)
      if (info.pid === process.pid) {
        fs.unlinkSync(infoPath);
      }
    }
  } catch {
    // Non-fatal
  }
}

// ============================================================================
// Scheduled backup
// ============================================================================

const BACKUP_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let backupRunning = false;
let syncRunning = false;

function startBackupScheduler(): void {
  const timer = setInterval(() => {
    // Config is re-read each tick so toggling backup.*/sync.* applies live
    const config = loadConfig();

    if (!shuttingDown && !backupRunning && isBackupDue(config.backup)) {
      backupRunning = true;
      void getDb()
        .then((db) => enqueue(() => runBackup({ db, kind: getStorageKind() })))
        .then((result) => {
          console.error(`[cortex-daemon] Backup uploaded: ${result.remoteName} (${Math.round(result.sizeBytes / 1024 / 1024)}MB in ${Math.round(result.durationMs / 1000)}s)`);
        })
        .catch((error) => {
          console.error(`[cortex-daemon] Backup failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          backupRunning = false;
        });
    }

    if (!shuttingDown && !syncRunning && isSyncDue(config.sync)) {
      syncRunning = true;
      void getDb()
        .then((db) => enqueue(() => runSync(db)))
        .then((result) => {
          console.error(`[cortex-daemon] Sync: pushed ${result.pushed.memories}+${result.pushed.tombstones}, pulled ${result.pulled.added}+${result.pulled.deleted} in ${Math.round(result.durationMs / 1000)}s`);
        })
        .catch((error) => {
          console.error(`[cortex-daemon] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          syncRunning = false;
        });
    }
  }, BACKUP_CHECK_INTERVAL_MS);
  timer.unref();
}

/**
 * On shutdown a due backup can't run in-process (we exit immediately), so
 * hand it to a detached `cortex backup --if-due` that snapshots from the
 * just-checkpointed file.
 */
function spawnShutdownBackup(): void {
  try {
    if (!isBackupDue(loadConfig().backup)) return;
    const indexPath = decodeURIComponent(new URL('./index.js', import.meta.url).pathname);
    if (!fs.existsSync(indexPath)) return;
    // --direct: we are still listening on the port but our DB handle is
    // closed - the child must snapshot from the file, not route back to us
    const child = spawn(process.execPath, [indexPath, 'backup', '--if-due', '--direct'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    // Best-effort; the scheduler catches up on next daemon start
  }
}

let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // Persist and close the database (only if it was ever opened)
    if (dbPromise) {
      closeDb();
    }
  } catch {
    // Persisting is best-effort on shutdown
  }
  // After closeDb: WAL is folded, the file is complete for a snapshot
  spawnShutdownBackup();
  removeDaemonInfo();
  process.exit(code);
}

async function main(): Promise<void> {
  // database.ts registers exit-immediately signal handlers at import time;
  // the daemon needs graceful shutdown (save DB, remove pidfile) instead
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.removeAllListeners(sig);
    process.on(sig, () => shutdown(0));
  }

  // Refuse to expose a public server without a token: binding 0.0.0.0 with no
  // auth would leave the shared brain open to the network.
  if (isServerMode() && !getServerToken()) {
    console.error('[cortex-daemon] CORTEX_SERVER mode requires CORTEX_SERVER_TOKEN to be set - refusing to start unauthenticated on a public interface');
    process.exit(1);
  }

  const port = getDaemonPort();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      try {
        respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } catch {
        // Response already sent/closed
      }
    });
  });

  let attempts = 0;
  let handlingBindError = false;
  const MAX_ATTEMPTS = 3;

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') {
      console.error(`[cortex-daemon] Server error: ${error.message}`);
      process.exit(1);
    }

    // Guard against overlapping error events (concurrent session starts can
    // race here); only one takeover attempt runs at a time
    if (handlingBindError) return;
    handlingBindError = true;

    // Port occupied: same-version daemon -> we're redundant, exit quietly.
    // Different version (plugin was updated) -> ask it to stop and take over.
    void (async () => {
      const occupant = await getDaemonHealth(600);

      if (occupant && occupant.version === VERSION) {
        process.exit(0);
      }

      attempts++;
      if (attempts >= MAX_ATTEMPTS) {
        console.error(`[cortex-daemon] Port ${port} is busy and could not be reclaimed`);
        process.exit(1);
      }

      if (occupant) {
        await stopDaemon();
      }
      setTimeout(() => {
        handlingBindError = false;
        server.listen(port, getBindHost());
      }, 750);
    })();
  });

  const bindHost = getBindHost();
  server.listen(port, bindHost, () => {
    writeDaemonInfo(port);
    console.error(`[cortex-daemon] v${VERSION} listening on ${bindHost}:${port} (pid ${process.pid})`);
    startBackupScheduler();
    // Start loading the database in the background so first requests are fast
    void getDb().catch((error) => {
      console.error(`[cortex-daemon] Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });
}

main().catch((error) => {
  console.error('[cortex-daemon] Fatal:', error);
  process.exit(1);
});
