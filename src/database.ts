/**
 * Cortex Database Module
 * SQLite database with vector storage using sql.js
 * FTS5 is optional - falls back to LIKE search if unavailable
 */

import * as fs from 'fs';
import * as os from 'os';
import initSqlJs, { Database as SqlJsDatabase, SqlValue } from 'sql.js';
import { getDatabasePath, ensureDataDir, getBackupsDir, ensureBackupsDir, cleanupActiveConfigTempFile } from './config.js';
import * as path from 'path';
import { tryOpenNative, NativeStorage, type Storage, type StorageKind } from './storage.js';
import type { Memory, MemoryInput, DbStats, SessionTurn, TurnInput, MemoryCategory, RecallScope, RecallScopeMode } from './types.js';
import * as crypto from 'crypto';

// ============================================================================
// Database Initialization
// ============================================================================

let dbInstance: Storage | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;
let fts5Available = false;
let initPromise: Promise<Storage> | null = null;
let storageKind: StorageKind = 'wasm';

/**
 * Which backend the current database handle uses
 */
export function getStorageKind(): StorageKind {
  return storageKind;
}

// Track in-progress temp file for cleanup on process kill
let activeTempPath: string | null = null;

/**
 * Clean up orphaned temp files from previous crashed processes.
 * These are left behind when a process is killed between writeFileSync and renameSync.
 * Handles both memory.db.tmp.* and other *.tmp.* files (sessions.json, etc.)
 */
function cleanupOrphanedTempFiles(): void {
  const dataDir = path.dirname(getDatabasePath());
  try {
    const files = fs.readdirSync(dataDir);
    const currentPid = process.pid;
    for (const file of files) {
      // Match *.tmp.{pid}.{timestamp} pattern
      const match = file.match(/\.tmp\.(\d+)\.\d+$/);
      if (!match) continue;
      const filePid = parseInt(match[1], 10);
      // Skip temp files from our own process (in-progress write)
      if (filePid === currentPid) continue;
      try {
        // Check if the owning process is still alive
        process.kill(filePid, 0);
        // Process exists — skip its temp file
      } catch {
        // Process is dead — safe to remove orphaned temp file
        try {
          fs.unlinkSync(path.join(dataDir, file));
        } catch {
          // Ignore removal errors
        }
      }
    }
  } catch {
    // Non-fatal — don't block startup
  }
}

// Clean up in-progress temp files on signal-based termination
function cleanupAllTempFiles(): void {
  if (activeTempPath) {
    try { fs.unlinkSync(activeTempPath); } catch { /* best effort */ }
    activeTempPath = null;
  }
  cleanupActiveConfigTempFile();
}

// Register signal handlers once (covers both database and config temp files)
const signals = os.constants.signals;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    cleanupAllTempFiles();
    process.exit(128 + signals[sig]);
  });
}

/**
 * Check whether a table (including virtual tables) exists
 */
function hasTable(db: Storage, name: string): boolean {
  const result = db.exec(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Initialize the database and load or create it.
 * Uses promise-based mutex to prevent concurrent initialization.
 *
 * Backends:
 * - default: sql.js (WASM, whole file in memory) - classic behavior
 * - preferNative: better-sqlite3 (file-backed, WAL) - used by the daemon;
 *   falls back to sql.js automatically when unavailable.
 *   CORTEX_STORAGE=wasm forces the sql.js backend regardless.
 */
export async function initDb(options: { preferNative?: boolean } = {}): Promise<Storage> {
  if (dbInstance) {
    return dbInstance;
  }

  // Wait for in-progress initialization
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      ensureDataDir();
      const dbPath = getDatabasePath();

      // Clean up orphaned temp files from previous crashed processes
      cleanupOrphanedTempFiles();

      // Create backup before loading existing database
      // (native note: a -wal file from a crashed daemon is replayed on open;
      // the backup copy of the main file may miss those last transactions)
      createBackupOnStartup();

      // Native backend: real file-backed SQLite. Pages load on demand
      // instead of the whole DB living in RAM, and writes are WAL
      // transactions instead of full-file rewrites.
      if (options.preferNative && process.env.CORTEX_STORAGE !== 'wasm') {
        const native = await tryOpenNative(dbPath);
        if (native) {
          try {
            // Never create FTS5 tables here: the file must stay writable by
            // the sql.js backend, whose bundled build lacks FTS5 (see
            // createSchema docs). Keyword search uses the LIKE fallback.
            createSchema(native, { includeFts: false });
            // If the file somehow already has an FTS index, use it natively
            fts5Available = hasTable(native, 'memories_fts');
            const validation = validateDatabase(native);
            if (!validation.valid) {
              throw new Error(`validation failed: ${validation.errors.join('; ')}`);
            }
            storageKind = 'native';
            dbInstance = native;
            return native;
          } catch (error) {
            try { native.close(); } catch { /* ignore */ }
            console.error(`[cortex] Native storage unusable (${error instanceof Error ? error.message : String(error)}) - falling back to sql.js`);
          }
        }
      }

      // sql.js (WASM) backend - classic behavior
      storageKind = 'wasm';
      if (!SQL) {
        SQL = await initSqlJs();
      }

      // Load existing database or create new one
      if (fs.existsSync(dbPath)) {
        let loadedDb: SqlJsDatabase | null = null;
        let needsRecovery = false;

        try {
          const buffer = fs.readFileSync(dbPath);
          loadedDb = new SQL.Database(buffer);

          // Validate the database
          const validation = validateDatabase(loadedDb);
          if (!validation.valid) {
            needsRecovery = true;
            loadedDb.close();
            loadedDb = null;
          }
        } catch {
          needsRecovery = true;
        }

        // Attempt recovery from backups if needed
        if (needsRecovery) {
          loadedDb = attemptRecovery();
          if (loadedDb) {
            // Save recovered database to main path
            const data = loadedDb.export();
            const tempPath = `${dbPath}.tmp.${process.pid}.${Date.now()}`;
            activeTempPath = tempPath;
            fs.writeFileSync(tempPath, Buffer.from(data));
            fs.renameSync(tempPath, dbPath);
            activeTempPath = null;
          }
        }

        if (loadedDb) {
          dbInstance = loadedDb;
          // Check if FTS5 table exists
          try {
            dbInstance.exec(`SELECT 1 FROM memories_fts LIMIT 1`);
            fts5Available = true;
          } catch {
            fts5Available = false;
          }
        } else {
          // All recovery attempts failed, create fresh database
          dbInstance = new SQL.Database();
          createSchema(dbInstance);
        }
      } else {
        dbInstance = new SQL.Database();
        createSchema(dbInstance);
      }

      return dbInstance;
    } catch (error) {
      initPromise = null;  // Allow retry on failure
      throw error;
    }
  })();

  return initPromise;
}

// ============================================================================
// Database Backup & Recovery
// ============================================================================

const MAX_BACKUPS = 5;

/**
 * Create a backup of the database before loading
 * Only creates backup if the database file exists and has content
 */
function createBackupOnStartup(): void {
  const dbPath = getDatabasePath();

  if (!fs.existsSync(dbPath)) {
    return;
  }

  const stats = fs.statSync(dbPath);
  if (stats.size === 0) {
    return;
  }

  ensureBackupsDir();
  const backupsDir = getBackupsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `memory.db.backup.${timestamp}`);

  try {
    fs.copyFileSync(dbPath, backupPath);
    rotateBackups();
  } catch {
    // Backup failures are non-fatal
  }
}

/**
 * Rotate backups, keeping only the most recent MAX_BACKUPS
 */
function rotateBackups(): void {
  const backupsDir = getBackupsDir();

  if (!fs.existsSync(backupsDir)) {
    return;
  }

  const files = fs.readdirSync(backupsDir)
    .filter(f => f.startsWith('memory.db.backup.'))
    .map(f => ({
      name: f,
      path: path.join(backupsDir, f),
      mtime: fs.statSync(path.join(backupsDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);  // Newest first

  // Remove old backups
  for (let i = MAX_BACKUPS; i < files.length; i++) {
    try {
      fs.unlinkSync(files[i].path);
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * Get list of available backup files, sorted by date (newest first)
 */
export function getBackupFiles(): string[] {
  const backupsDir = getBackupsDir();

  if (!fs.existsSync(backupsDir)) {
    return [];
  }

  return fs.readdirSync(backupsDir)
    .filter(f => f.startsWith('memory.db.backup.'))
    .map(f => path.join(backupsDir, f))
    .sort((a, b) => {
      const aTime = fs.statSync(a).mtime.getTime();
      const bTime = fs.statSync(b).mtime.getTime();
      return bTime - aTime;  // Newest first
    });
}

/**
 * Database validation result
 */
export interface DatabaseValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  tablesFound: string[];
  integrityCheck: boolean;
  fts5Available: boolean;
  embeddingDimension: number | null;
}

/**
 * Validate database structure and integrity
 */
export function validateDatabase(db: Storage): DatabaseValidationResult {
  const result: DatabaseValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    tablesFound: [],
    integrityCheck: false,
    fts5Available: false,
    embeddingDimension: null,
  };

  // Check required tables
  const requiredTables = ['memories', 'session_turns', 'session_summaries'];
  try {
    const tablesResult = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
    if (tablesResult.length > 0) {
      result.tablesFound = tablesResult[0].values.map(row => row[0] as string);
    }

    for (const table of requiredTables) {
      if (!result.tablesFound.includes(table)) {
        result.errors.push(`Missing required table: ${table}`);
        result.valid = false;
      }
    }
  } catch (error) {
    result.errors.push(`Failed to query tables: ${error instanceof Error ? error.message : String(error)}`);
    result.valid = false;
  }

  // Run SQLite integrity check
  try {
    const integrityResult = db.exec(`PRAGMA integrity_check`);
    if (integrityResult.length > 0 && integrityResult[0].values.length > 0) {
      const status = integrityResult[0].values[0][0] as string;
      result.integrityCheck = status === 'ok';
      if (!result.integrityCheck) {
        result.errors.push(`Integrity check failed: ${status}`);
        result.valid = false;
      }
    }
  } catch (error) {
    result.errors.push(`Integrity check error: ${error instanceof Error ? error.message : String(error)}`);
    result.valid = false;
  }

  // Check FTS5 availability
  try {
    db.exec(`SELECT 1 FROM memories_fts LIMIT 1`);
    result.fts5Available = true;
  } catch {
    result.fts5Available = false;
    result.warnings.push('FTS5 table not available - keyword search will use fallback');
  }

  // Check embedding dimension
  try {
    const embeddingResult = db.exec(`SELECT embedding FROM memories LIMIT 1`);
    if (embeddingResult.length > 0 && embeddingResult[0].values.length > 0) {
      const embeddingBlob = embeddingResult[0].values[0][0] as Buffer;
      if (embeddingBlob) {
        result.embeddingDimension = embeddingBlob.length / 4;  // Float32 = 4 bytes
        if (result.embeddingDimension !== 768) {
          result.warnings.push(`Embedding dimension is ${result.embeddingDimension}, expected 768`);
        }
      }
    }
  } catch {
    // No embeddings yet is fine
  }

  return result;
}

/**
 * Attempt to recover database from backups
 * Returns the first valid database or null if all backups are corrupt
 */
function attemptRecovery(): SqlJsDatabase | null {
  if (!SQL) {
    return null;
  }

  const backups = getBackupFiles();

  for (const backupPath of backups) {
    try {
      const buffer = fs.readFileSync(backupPath);
      const db = new SQL.Database(buffer);

      // Validate the backup
      const validation = validateDatabase(db);
      if (validation.valid) {
        return db;
      }

      // Invalid backup, close and try next
      db.close();
    } catch {
      // Corrupt backup, try next
    }
  }

  return null;
}

// ============================================================================
// FTS5 Support
// ============================================================================

/**
 * Check if FTS5 is available
 */
function checkFts5(db: Storage): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(test)`);
    db.exec(`DROP TABLE _fts5_test`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create database schema
 *
 * includeFts: the FTS5 virtual table + triggers may only be created when
 * EVERY backend that might open this file supports FTS5. The bundled sql.js
 * build does not, so a natively-created FTS table would break all writes on
 * any later sql.js open (triggers reference a missing module). The native
 * backend therefore passes includeFts: false and keyword search uses the
 * existing LIKE fallback on both backends.
 */
function createSchema(db: Storage, options: { includeFts?: boolean } = {}): void {
  const { includeFts = true } = options;
  // Main memories table
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      embedding BLOB NOT NULL,
      project_id TEXT,
      source_session TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      origin_device TEXT
    )
  `);

  // Migration for databases created before sync support: NULL origin_device
  // means "created locally" (the only truth pre-sync)
  try {
    db.run(`ALTER TABLE memories ADD COLUMN origin_device TEXT`);
  } catch {
    // Column already exists
  }

  // Migration for the shared-brain identity columns. Additive; old rows keep
  // NULL (treated as legacy/unknown). `category` declares the generalization
  // axis that scopes recall (global | user | environment | project); a NULL
  // category behaves as 'project'. See src/identity.ts and src/search.ts.
  for (const col of ['user TEXT', 'environment TEXT', "category TEXT DEFAULT 'project'"]) {
    try {
      db.run(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {
      // Column already exists
    }
  }

  // Sync tombstones: deletions that must propagate to (and suppress
  // re-import from) other devices. origin_device NULL = deleted locally.
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      content_hash TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      origin_device TEXT
    )
  `);

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_environment ON memories(environment)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);

  // Session turns table (for precise restoration after /clear)
  db.run(`
    CREATE TABLE IF NOT EXISTS session_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_project ON session_turns(project_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_session ON session_turns(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON session_turns(timestamp DESC)`);

  // Session summaries table (captures session-level context without full transcript)
  db.run(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      session_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      key_decisions TEXT,
      key_outcomes TEXT,
      blockers TEXT,
      context_at_save INTEGER,
      fragments_saved INTEGER,
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_summaries_timestamp ON session_summaries(timestamp DESC)`);

  // Session progress table (for incremental indexing)
  db.run(`
    CREATE TABLE IF NOT EXISTS session_progress (
      session_id TEXT PRIMARY KEY,
      last_processed_line INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Try to create FTS5 virtual table (may not be available in all sql.js builds)
  fts5Available = includeFts ? checkFts5(db) : false;

  if (includeFts && fts5Available) {
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='id'
        )
      `);

      // Triggers to keep FTS5 in sync
      db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        END
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
    } catch {
      fts5Available = false;
    }
  }
}

/**
 * Save database to disk using atomic write pattern
 * Uses temp-file + rename to prevent corruption on crash.
 * No-op for the native backend: writes are already durable WAL transactions.
 */
export function saveDb(db: Storage): void {
  if (storageKind === 'native') {
    return;
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  const dbPath = getDatabasePath();

  // Atomic write: temp file + rename
  const tempPath = `${dbPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    activeTempPath = tempPath;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, dbPath);  // Atomic on POSIX
    activeTempPath = null;
  } catch (error) {
    activeTempPath = null;
    // Clean up temp file if write/rename failed
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (dbInstance) {
    saveDb(dbInstance); // no-op for native (WAL is already durable)
    dbInstance.close(); // native adapter checkpoints the WAL on close
    dbInstance = null;
  }
  // Allow a fresh open after close (initPromise caches the CLOSED handle otherwise)
  initPromise = null;
  storageKind = 'wasm';
}

/**
 * Check if FTS5 is enabled
 */
export function isFts5Enabled(): boolean {
  return fts5Available;
}

// ============================================================================
// Memory Operations
// ============================================================================

/**
 * Generate content hash for deduplication
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content.trim()).digest('hex').substring(0, 16);
}

/**
 * Convert Float32Array to Buffer for storage
 */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Convert Buffer back to Float32Array
 */
function bufferToEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/**
 * Insert a new memory
 */
export function insertMemory(
  db: Storage,
  memory: MemoryInput
): { id: number; isDuplicate: boolean } {
  const hash = hashContent(memory.content);

  // Check for duplicate
  const existing = db.exec(
    `SELECT id FROM memories WHERE content_hash = ?`,
    [hash]
  );

  if (existing.length > 0 && existing[0].values.length > 0) {
    return { id: existing[0].values[0][0] as number, isDuplicate: true };
  }

  // Insert new memory. Identity columns are additive: callers that don't
  // supply them get NULL user/environment and category 'project'.
  db.run(
    `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp, user, environment, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memory.content,
      hash,
      embeddingToBuffer(memory.embedding),
      memory.projectId,
      memory.sourceSession,
      memory.timestamp.toISOString(),
      memory.user ?? null,
      memory.environment ?? null,
      memory.category ?? 'project',
    ]
  );

  // Get the inserted ID
  const result = db.exec(`SELECT last_insert_rowid()`);
  const id = result[0].values[0][0] as number;

  return { id, isDuplicate: false };
}

/**
 * Get memory by ID
 */
export function getMemory(db: Storage, id: number): Memory | null {
  const result = db.exec(
    `SELECT id, content, content_hash, embedding, project_id, source_session, timestamp
     FROM memories WHERE id = ?`,
    [id]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return null;
  }

  const row = result[0].values[0];
  return {
    id: row[0] as number,
    content: row[1] as string,
    contentHash: row[2] as string,
    embedding: bufferToEmbedding(row[3] as Buffer),
    projectId: row[4] as string | null,
    sourceSession: row[5] as string,
    timestamp: new Date(row[6] as string),
  };
}

/**
 * Check if content already exists
 */
export function contentExists(db: Storage, content: string): boolean {
  const hash = hashContent(content);
  const result = db.exec(
    `SELECT 1 FROM memories WHERE content_hash = ? LIMIT 1`,
    [hash]
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Record a tombstone so a deletion propagates through sync and the
 * deleted content is not re-imported from other devices.
 */
export function recordTombstone(db: Storage, contentHash: string, originDevice: string | null = null): void {
  db.run(
    `INSERT OR REPLACE INTO sync_tombstones (content_hash, deleted_at, origin_device) VALUES (?, ?, ?)`,
    [contentHash, new Date().toISOString(), originDevice]
  );
}

/**
 * Delete memory by ID (tombstoned so the deletion syncs).
 * Delete + tombstone are atomic: a crash between them would otherwise
 * leave sync in a permanently diverged state.
 */
export function deleteMemory(db: Storage, id: number): boolean {
  const existing = db.exec(`SELECT content_hash FROM memories WHERE id = ?`, [id]);
  if (existing.length === 0 || existing[0].values.length === 0) {
    return false;
  }
  const hash = existing[0].values[0][0] as string;

  db.run('BEGIN');
  try {
    db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    const deleted = db.getRowsModified() > 0;
    if (deleted) {
      recordTombstone(db, hash);
    }
    db.run('COMMIT');
    return deleted;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * Store a manual memory (from cortex_remember tool)
 * Unlike insertMemory, this creates a unique session ID for manual entries
 */
export function storeManualMemory(
  db: Storage,
  content: string,
  embedding: Float32Array,
  projectId: string | null,
  context?: string,
  identity?: { user?: string | null; environment?: string | null; category?: MemoryCategory | null }
): { id: number; isDuplicate: boolean } {
  // Combine content with context if provided
  const fullContent = context
    ? `${content}\n\n[Context: ${context}]`
    : content;

  // Generate a unique session identifier for manual entries
  const sessionId = `manual-${Date.now()}`;

  return insertMemory(db, {
    content: fullContent,
    embedding,
    projectId,
    sourceSession: sessionId,
    timestamp: new Date(),
    user: identity?.user ?? null,
    environment: identity?.environment ?? null,
    category: identity?.category ?? 'project',
  });
}

/**
 * Update memory content by ID
 */
export function updateMemory(
  db: Storage,
  id: number,
  newContent: string,
  newEmbedding: Float32Array
): boolean {
  const newHash = hashContent(newContent);

  // For sync, an update is delete(old content) + add(new content):
  // tombstone the old hash and mark the row as locally authored so it
  // is pushed as a fresh addition
  const existing = db.exec(`SELECT content_hash FROM memories WHERE id = ?`, [id]);
  const oldHash = existing.length > 0 && existing[0].values.length > 0
    ? (existing[0].values[0][0] as string)
    : null;

  db.run(
    `UPDATE memories SET content = ?, content_hash = ?, embedding = ?, origin_device = NULL WHERE id = ?`,
    [newContent, newHash, embeddingToBuffer(newEmbedding), id]
  );

  const updated = db.getRowsModified() > 0;
  if (updated && oldHash && oldHash !== newHash) {
    recordTombstone(db, oldHash);
  }
  return updated;
}

/**
 * Update memory project ID
 */
export function updateMemoryProjectId(
  db: Storage,
  id: number,
  newProjectId: string | null
): boolean {
  db.run(
    `UPDATE memories SET project_id = ? WHERE id = ?`,
    [newProjectId, id]
  );

  return db.getRowsModified() > 0;
}

/**
 * Bulk rename project - move all memories from one project to another
 */
export function renameProject(
  db: Storage,
  oldProjectId: string,
  newProjectId: string
): number {
  db.run(
    `UPDATE memories SET project_id = ? WHERE project_id = ?`,
    [newProjectId, oldProjectId]
  );

  return db.getRowsModified();
}

/**
 * Get recent memories for a project, sorted by timestamp
 */
export function getRecentMemories(
  db: Storage,
  projectId: string | null,
  limit: number = 10
): Array<{ id: number; content: string; timestamp: Date; projectId: string | null }> {
  let query = `SELECT id, content, project_id, timestamp FROM memories`;
  const params: (string | number)[] = [];

  if (projectId !== null) {
    query += ` WHERE project_id = ?`;
    params.push(projectId);
  }

  query += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const result = db.exec(query, params);

  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  return result[0].values.map((row: SqlValue[]) => ({
    id: row[0] as number,
    content: row[1] as string,
    projectId: row[2] as string | null,
    timestamp: new Date(row[3] as string),
  }));
}

/**
 * Delete all memories for a project (each tombstoned so the deletion
 * syncs). Tombstones + delete are one atomic transaction.
 */
export function deleteProjectMemories(db: Storage, projectId: string): number {
  const now = new Date().toISOString();
  db.run('BEGIN');
  try {
    db.run(
      `INSERT OR REPLACE INTO sync_tombstones (content_hash, deleted_at, origin_device)
       SELECT content_hash, ?, NULL FROM memories WHERE project_id = ?`,
      [now, projectId]
    );
    db.run(`DELETE FROM memories WHERE project_id = ?`, [projectId]);
    const deleted = db.getRowsModified();
    db.run('COMMIT');
    return deleted;
  } catch (error) {
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

// ============================================================================
// Search Operations
// ============================================================================

/**
 * Build a category-aware WHERE fragment (without the leading WHERE) plus its
 * bound params from a RecallScope. See RecallScopeMode for the semantics.
 *
 * `alias` is the optional table alias prefix (e.g. 'm' for joined queries).
 * Null identity values yield `col = NULL`, which SQLite treats as never-true,
 * so a missing user/environment simply prunes that branch - never an error.
 */
export function buildScopeClause(
  scope: RecallScope,
  alias: string = ''
): { clause: string; params: (string | null)[] } {
  const a = alias ? `${alias}.` : '';
  const mode: RecallScopeMode = scope.mode ?? 'auto';
  const user = scope.user ?? null;
  const environment = scope.environment ?? null;
  const project = scope.project ?? null;

  switch (mode) {
    case 'all':
      return { clause: '', params: [] };
    case 'global':
      return { clause: `${a}category = 'global'`, params: [] };
    case 'user':
      return { clause: `${a}category = 'user' AND ${a}user = ?`, params: [user] };
    case 'environment':
      return { clause: `${a}category = 'environment' AND ${a}environment = ?`, params: [environment] };
    case 'project':
      return {
        clause: `(${a}category = 'project' OR ${a}category IS NULL) AND ${a}project_id = ?`,
        params: [project],
      };
    case 'auto':
    default:
      return {
        clause:
          `(${a}category = 'global'` +
          ` OR (${a}category = 'user' AND ${a}user = ?)` +
          ` OR (${a}category = 'environment' AND ${a}environment = ?)` +
          ` OR ((${a}category = 'project' OR ${a}category IS NULL) AND ${a}project_id = ?))`,
        params: [user, environment, project],
      };
  }
}

/**
 * Build the legacy project-only WHERE fragment (backward-compatible path used
 * when no RecallScope is supplied). undefined projectId = no filter.
 */
function buildLegacyProjectClause(
  projectId: string | null | undefined,
  alias: string = ''
): { clause: string; params: (string | null)[] } {
  const a = alias ? `${alias}.` : '';
  if (projectId === undefined) return { clause: '', params: [] };
  if (projectId === null) return { clause: `${a}project_id IS NULL`, params: [] };
  return { clause: `${a}project_id = ?`, params: [projectId] };
}

/**
 * Search memories by vector similarity (cosine distance)
 */
export function searchByVector(
  db: Storage,
  queryEmbedding: Float32Array,
  projectId?: string | null,
  limit: number = 10,
  scope?: RecallScope
): Array<{ id: number; content: string; score: number; timestamp: Date; projectId: string | null }> {
  // Get all memories. A RecallScope, when present, replaces the legacy
  // projectId filter with category-aware scoping.
  let query = `SELECT id, content, embedding, project_id, timestamp FROM memories`;
  const { clause, params } = scope
    ? buildScopeClause(scope)
    : buildLegacyProjectClause(projectId);
  if (clause) query += ` WHERE ${clause}`;

  const result = db.exec(query, params);

  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  // Calculate cosine similarity for each memory
  const scored = result[0].values.map((row: SqlValue[]) => {
    const embedding = bufferToEmbedding(row[2] as Buffer);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    return {
      id: row[0] as number,
      content: row[1] as string,
      score: similarity,
      timestamp: new Date(row[4] as string),
      projectId: row[3] as string | null,
    };
  });

  type ScoredResult = { id: number; content: string; score: number; timestamp: Date; projectId: string | null };
  // Sort by score descending and limit
  return scored.sort((a: ScoredResult, b: ScoredResult) => b.score - a.score).slice(0, limit);
}

/**
 * Search memories using keyword matching
 * Uses FTS5 if available, falls back to LIKE queries
 */
export function searchByKeyword(
  db: Storage,
  query: string,
  projectId?: string | null,
  limit: number = 10,
  scope?: RecallScope
): Array<{ id: number; content: string; score: number; timestamp: Date; projectId: string | null }> {
  const cleanQuery = query.replace(/['"]/g, '').trim();

  if (!cleanQuery) {
    return [];
  }

  // Try FTS5 first if available
  if (fts5Available) {
    try {
      return searchByFts5(db, cleanQuery, projectId, limit, scope);
    } catch {
      // Fall through to LIKE search
    }
  }

  // Fallback to LIKE search
  return searchByLike(db, cleanQuery, projectId, limit, scope);
}

/**
 * FTS5 full-text search
 */
function searchByFts5(
  db: Storage,
  query: string,
  projectId?: string | null,
  limit: number = 10,
  scope?: RecallScope
): Array<{ id: number; content: string; score: number; timestamp: Date; projectId: string | null }> {
  let sql = `
    SELECT m.id, m.content, m.project_id, m.timestamp,
           bm25(memories_fts) as rank
    FROM memories_fts f
    JOIN memories m ON f.rowid = m.id
    WHERE memories_fts MATCH ?
  `;

  const params: (string | null)[] = [query];

  const { clause, params: scopeParams } = scope
    ? buildScopeClause(scope, 'm')
    : buildLegacyProjectClause(projectId, 'm');
  if (clause) {
    sql += ` AND ${clause}`;
    params.push(...scopeParams);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit.toString());

  const result = db.exec(sql, params);

  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  return result[0].values.map((row: SqlValue[]) => ({
    id: row[0] as number,
    content: row[1] as string,
    projectId: row[2] as string | null,
    timestamp: new Date(row[3] as string),
    score: Math.abs(row[4] as number), // BM25 returns negative scores
  }));
}

/**
 * LIKE-based keyword search (fallback when FTS5 unavailable)
 */
function searchByLike(
  db: Storage,
  query: string,
  projectId?: string | null,
  limit: number = 10,
  scope?: RecallScope
): Array<{ id: number; content: string; score: number; timestamp: Date; projectId: string | null }> {
  // Split query into words for multi-word search
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  // Build LIKE conditions for each word
  const conditions = words.map(() => `LOWER(content) LIKE ?`);
  const params: (string | null)[] = words.map((w) => `%${w}%`);

  let sql = `
    SELECT id, content, project_id, timestamp,
           LENGTH(content) as len
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `;

  const { clause, params: scopeParams } = scope
    ? buildScopeClause(scope)
    : buildLegacyProjectClause(projectId);
  if (clause) {
    sql += ` AND ${clause}`;
    params.push(...scopeParams);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit.toString());

  const result = db.exec(sql, params);

  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  return result[0].values.map((row: SqlValue[], index: number) => ({
    id: row[0] as number,
    content: row[1] as string,
    projectId: row[2] as string | null,
    timestamp: new Date(row[3] as string),
    // Simple score based on position (earlier = higher score)
    score: 1 - index * 0.1,
  }));
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get database statistics
 */
export function getStats(db: Storage): DbStats {
  const fragmentResult = db.exec(`SELECT COUNT(*) FROM memories`);
  const fragmentCount = fragmentResult[0]?.values[0]?.[0] as number ?? 0;

  const projectResult = db.exec(`SELECT COUNT(DISTINCT project_id) FROM memories WHERE project_id IS NOT NULL`);
  const projectCount = projectResult[0]?.values[0]?.[0] as number ?? 0;

  const sessionResult = db.exec(`SELECT COUNT(DISTINCT source_session) FROM memories`);
  const sessionCount = sessionResult[0]?.values[0]?.[0] as number ?? 0;

  const oldestResult = db.exec(`SELECT MIN(timestamp) FROM memories`);
  const oldestStr = oldestResult[0]?.values[0]?.[0] as string | null;
  const oldestTimestamp = oldestStr ? new Date(oldestStr) : null;

  const newestResult = db.exec(`SELECT MAX(timestamp) FROM memories`);
  const newestStr = newestResult[0]?.values[0]?.[0] as string | null;
  const newestTimestamp = newestStr ? new Date(newestStr) : null;

  // Get database file size
  const dbPath = getDatabasePath();
  let dbSizeBytes = 0;
  if (fs.existsSync(dbPath)) {
    dbSizeBytes = fs.statSync(dbPath).size;
  }

  return {
    fragmentCount,
    projectCount,
    sessionCount,
    dbSizeBytes,
    oldestTimestamp,
    newestTimestamp,
  };
}

/**
 * List all projects with their fragment counts
 */
export function listProjects(db: Storage): Array<{ projectId: string; fragmentCount: number }> {
  const result = db.exec(`
    SELECT project_id, COUNT(*) as count
    FROM memories
    WHERE project_id IS NOT NULL
    GROUP BY project_id
    ORDER BY count DESC
  `);

  if (!result[0]) return [];

  return result[0].values.map((row) => ({
    projectId: row[0] as string,
    fragmentCount: row[1] as number,
  }));
}

/**
 * Get stats for a specific project
 */
export function getProjectStats(db: Storage, projectId: string): {
  fragmentCount: number;
  sessionCount: number;
  lastArchive: Date | null;
} {
  const fragmentResult = db.exec(
    `SELECT COUNT(*) FROM memories WHERE project_id = ?`,
    [projectId]
  );
  const fragmentCount = fragmentResult[0]?.values[0]?.[0] as number ?? 0;

  const sessionResult = db.exec(
    `SELECT COUNT(DISTINCT source_session) FROM memories WHERE project_id = ?`,
    [projectId]
  );
  const sessionCount = sessionResult[0]?.values[0]?.[0] as number ?? 0;

  const lastResult = db.exec(
    `SELECT MAX(timestamp) FROM memories WHERE project_id = ?`,
    [projectId]
  );
  const lastStr = lastResult[0]?.values[0]?.[0] as string | null;
  const lastArchive = lastStr ? new Date(lastStr) : null;

  return {
    fragmentCount,
    sessionCount,
    lastArchive,
  };
}

// ============================================================================
// Session Turn Operations (for precise restoration)
// ============================================================================

/**
 * Insert a session turn
 */
export function insertTurn(db: Storage, turn: TurnInput): number {
  db.run(
    `INSERT INTO session_turns (role, content, project_id, session_id, turn_index, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [turn.role, turn.content, turn.projectId, turn.sessionId, turn.turnIndex, turn.timestamp.toISOString()]
  );
  const result = db.exec(`SELECT last_insert_rowid()`);
  return result[0].values[0][0] as number;
}

/**
 * Get recent turns for a project, ordered chronologically
 */
export function getRecentTurns(
  db: Storage,
  projectId: string | null,
  limit: number = 6
): SessionTurn[] {
  let query = `
    SELECT id, role, content, project_id, session_id, turn_index, timestamp
    FROM session_turns
  `;
  const params: (string | number)[] = [];

  if (projectId !== null) {
    query += ` WHERE project_id = ?`;
    params.push(projectId);
  }

  query += ` ORDER BY timestamp DESC, turn_index DESC LIMIT ?`;
  params.push(limit);

  const result = db.exec(query, params);
  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  // Reverse to chronological order
  return result[0].values.map((row: SqlValue[]) => ({
    id: row[0] as number,
    role: row[1] as 'user' | 'assistant',
    content: row[2] as string,
    projectId: row[3] as string | null,
    sessionId: row[4] as string,
    turnIndex: row[5] as number,
    timestamp: new Date(row[6] as string),
  })).reverse();
}

/**
 * Clear old turns, keeping only the most recent N per project
 */
export function clearOldTurns(db: Storage, keepCount: number = 10): number {
  // Delete turns older than the most recent keepCount
  db.run(`
    DELETE FROM session_turns
    WHERE id NOT IN (
      SELECT id FROM session_turns
      ORDER BY timestamp DESC, turn_index DESC
      LIMIT ?
    )
  `, [keepCount]);
  return db.getRowsModified();
}

/**
 * Clear all turns for a project (called before saving new turns)
 */
export function clearProjectTurns(db: Storage, projectId: string | null): number {
  if (projectId === null) {
    db.run(`DELETE FROM session_turns WHERE project_id IS NULL`);
  } else {
    db.run(`DELETE FROM session_turns WHERE project_id = ?`, [projectId]);
  }
  return db.getRowsModified();
}

// ============================================================================
// Session Summary Operations
// ============================================================================

export interface SessionSummaryInput {
  projectId: string | null;
  sessionId: string;
  summary: string;
  keyDecisions?: string[];
  keyOutcomes?: string[];
  blockers?: string[];
  contextAtSave?: number;
  fragmentsSaved?: number;
  timestamp: Date;
}

/**
 * Insert or update a session summary
 */
export function upsertSessionSummary(db: Storage, input: SessionSummaryInput): number {
  db.run(
    `INSERT OR REPLACE INTO session_summaries
     (project_id, session_id, summary, key_decisions, key_outcomes, blockers, context_at_save, fragments_saved, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.projectId,
      input.sessionId,
      input.summary,
      input.keyDecisions?.join('\n') || null,
      input.keyOutcomes?.join('\n') || null,
      input.blockers?.join('\n') || null,
      input.contextAtSave || null,
      input.fragmentsSaved || null,
      input.timestamp.toISOString(),
    ]
  );
  const result = db.exec(`SELECT last_insert_rowid()`);
  return result[0].values[0][0] as number;
}

/**
 * Get recent session summaries for a project
 */
export function getRecentSummaries(
  db: Storage,
  projectId: string | null,
  limit: number = 5
): Array<{
  id: number;
  sessionId: string;
  summary: string;
  keyDecisions: string[];
  keyOutcomes: string[];
  timestamp: Date;
}> {
  let query = `
    SELECT id, session_id, summary, key_decisions, key_outcomes, timestamp
    FROM session_summaries
  `;
  const params: (string | number)[] = [];

  if (projectId !== null) {
    query += ` WHERE project_id = ?`;
    params.push(projectId);
  }

  query += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const result = db.exec(query, params);
  if (result.length === 0 || result[0].values.length === 0) {
    return [];
  }

  return result[0].values.map((row: SqlValue[]) => ({
    id: row[0] as number,
    sessionId: row[1] as string,
    summary: row[2] as string,
    keyDecisions: (row[3] as string | null)?.split('\n').filter(Boolean) || [],
    keyOutcomes: (row[4] as string | null)?.split('\n').filter(Boolean) || [],
    timestamp: new Date(row[5] as string),
  }));
}

// ============================================================================
// Session Progress Operations
// ============================================================================

/**
 * Get last processed line number for a session
 */
export function getSessionProgress(db: Storage, sessionId: string): number {
  try {
    const result = db.exec(
      `SELECT last_processed_line FROM session_progress WHERE session_id = ?`,
      [sessionId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return 0;
    }
    return result[0].values[0][0] as number;
  } catch {
    return 0; // Table might not exist yet if not migrated
  }
}

/**
 * Update session progress
 */
export function updateSessionProgress(db: Storage, sessionId: string, lastLine: number): void {
  try {
    db.run(
      `INSERT OR REPLACE INTO session_progress (session_id, last_processed_line) VALUES (?, ?)`,
      [sessionId, lastLine]
    );
  } catch (e) {
    console.error('Failed to update session progress:', e);
  }
}

// ============================================================================
// Compaction / Retention
// ============================================================================

export interface CompactOptions {
  /** Keep only the most recent N session turns (default 50) */
  keepTurns?: number;
  /** Delete session_progress rows not updated in N days (default 30) */
  progressMaxAgeDays?: number;
  /** DESTRUCTIVE: delete memories older than N days. Off unless provided. */
  pruneMemoriesOlderThanDays?: number | null;
}

export interface CompactResult {
  turnsDeleted: number;
  progressDeleted: number;
  memoriesDeleted: number;
  sizeBefore: number;
  sizeAfter: number;
}

/**
 * Compact the database: prune bookkeeping tables, optionally age out old
 * memories, then VACUUM to reclaim disk space.
 *
 * Memory pruning is opt-in only - restoration turns and progress rows are
 * transient bookkeeping, but memories are the user's data.
 */
export function compactDatabase(db: Storage, options: CompactOptions = {}): CompactResult {
  const {
    keepTurns = 50,
    progressMaxAgeDays = 30,
    pruneMemoriesOlderThanDays = null,
  } = options;

  const dbPath = getDatabasePath();
  const sizeBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

  const result: CompactResult = {
    turnsDeleted: 0,
    progressDeleted: 0,
    memoriesDeleted: 0,
    sizeBefore,
    sizeAfter: sizeBefore,
  };

  // Prune restoration turns beyond the most recent keepTurns
  try {
    result.turnsDeleted = clearOldTurns(db, keepTurns);
  } catch {
    // Table may not exist on very old databases
  }

  // Prune stale incremental-indexing progress rows
  // (updated_at uses CURRENT_TIMESTAMP format, so compare via datetime())
  try {
    db.run(
      `DELETE FROM session_progress WHERE updated_at < datetime('now', ?)`,
      [`-${Math.max(1, Math.floor(progressMaxAgeDays))} days`]
    );
    result.progressDeleted = db.getRowsModified();
  } catch {
    // Table may not exist on very old databases
  }

  // Optional destructive pruning of old memories
  // (memories.timestamp is an ISO string, so compare against an ISO cutoff)
  if (pruneMemoriesOlderThanDays !== null && pruneMemoriesOlderThanDays > 0) {
    const cutoff = new Date(Date.now() - pruneMemoriesOlderThanDays * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM memories WHERE timestamp < ?`, [cutoff]);
    result.memoriesDeleted = db.getRowsModified();
  }

  // Reclaim free pages
  // (discriminate on the handle itself, not module state, so this function
  // stays correct for any Storage passed in)
  db.run('VACUUM');
  if (db instanceof NativeStorage) {
    // Fold the WAL so the on-disk size reflects the vacuumed database
    db.run(`PRAGMA wal_checkpoint(TRUNCATE)`);
  } else {
    // sql.js: persist the vacuumed in-memory database to disk
    saveDb(db);
  }

  result.sizeAfter = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  return result;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}
