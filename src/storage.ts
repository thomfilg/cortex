/**
 * Cortex Storage Backends
 *
 * The query layer (database.ts) talks to a minimal Storage interface that
 * matches the subset of the sql.js Database API the codebase uses. Two
 * backends satisfy it:
 *
 * - WASM (sql.js): the classic backend. The whole database file is loaded
 *   into memory and persisted by rewriting the entire file. Zero native
 *   dependencies - remains the default for per-process (classic) mode.
 *   The sql.js Database object satisfies Storage structurally; no wrapper.
 *
 * - NATIVE (better-sqlite3): real file-backed SQLite used by the daemon.
 *   Pages are read on demand (the DB no longer lives in RAM), writes are
 *   WAL transactions (KBs appended, not a full-file rewrite), and crash
 *   safety comes from SQLite journaling instead of temp-file+rename.
 *   better-sqlite3 is an OPTIONAL dependency: if it is missing or fails to
 *   load, callers fall back to the WASM backend.
 */

import type { SqlValue } from 'sql.js';

export interface ExecResult {
  columns: string[];
  values: SqlValue[][];
}

/**
 * Subset of the sql.js Database API used by the query layer.
 * sql.js's Database satisfies this structurally.
 */
export interface Storage {
  exec(sql: string, params?: SqlValue[]): ExecResult[];
  run(sql: string, params?: SqlValue[]): unknown;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

export type StorageKind = 'wasm' | 'native';

// better-sqlite3 is loaded dynamically and only in daemon mode; its types
// are not a hard dependency of the build
/* eslint-disable @typescript-eslint/no-explicit-any */

export class NativeStorage implements Storage {
  private lastChanges = 0;

  constructor(private db: any) {}

  exec(sql: string, params: SqlValue[] = []): ExecResult[] {
    const stmt = this.db.prepare(sql);
    if (stmt.reader) {
      const columns = stmt.columns().map((c: any) => c.name as string);
      const values = stmt.raw(true).all(...params) as SqlValue[][];
      // sql.js returns [] (not an empty result set) when there are no rows
      return values.length > 0 ? [{ columns, values }] : [];
    }
    const info = stmt.run(...params);
    this.lastChanges = info.changes;
    return [];
  }

  run(sql: string, params: SqlValue[] = []): void {
    const stmt = this.db.prepare(sql);
    if (stmt.reader) {
      // Statements like PRAGMA return rows; sql.js's run() ignores them
      stmt.raw(true).all(...params);
      return;
    }
    const info = stmt.run(...params);
    this.lastChanges = info.changes;
  }

  getRowsModified(): number {
    return this.lastChanges;
  }

  export(): Uint8Array {
    return this.db.serialize();
  }

  close(): void {
    try {
      // Fold the WAL into the main file so backups/copies see everything
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint is best-effort; close regardless
    }
    this.db.close();
  }
}

/**
 * Try to open the database with better-sqlite3.
 * Returns null when the module is unavailable (not installed, native build
 * failed) or the file cannot be opened - callers fall back to sql.js.
 */
export async function tryOpenNative(dbPath: string): Promise<NativeStorage | null> {
  try {
    const mod: any = await import('better-sqlite3');
    const BetterSqlite3 = mod.default ?? mod;
    const db = new BetterSqlite3(dbPath);
    // WAL: concurrent-safe journaling, small transactional writes
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    // mmap: reads go through the OS page cache - fast after warmup, and the
    // memory is reclaimable by the OS instead of pinned process RSS
    db.pragma('mmap_size = 1073741824');
    return new NativeStorage(db);
  } catch {
    return null;
  }
}
