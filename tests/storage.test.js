import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The native backend is optional: skip the suite when better-sqlite3 is
// not installed or its native build is unavailable on this machine.
let nativeAvailable = true;
try {
  await import('better-sqlite3');
} catch {
  nativeAvailable = false;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-storage-test-'));
process.env.CORTEX_DATA_DIR = tmpDir;

const { initDb, closeDb, compactDatabase } = await import('../dist/index.js');

describe('native storage backend', { skip: !nativeAvailable }, () => {
  test('opens natively, persists via WAL without saveDb, and reopens', async () => {
    const db = await initDb({ preferNative: true });

    // Insert directly through the Storage interface (no embedding model needed)
    db.run(
      `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['native backend roundtrip content', 'hash-native-1', Buffer.alloc(12), 'proj-a', 'session-1', new Date().toISOString()]
    );

    const rows = db.exec(`SELECT content, project_id FROM memories WHERE content_hash = ?`, ['hash-native-1']);
    assert.equal(rows[0].values[0][0], 'native backend roundtrip content');
    assert.equal(rows[0].values[0][1], 'proj-a');

    // Close WITHOUT calling saveDb: native writes must already be durable
    closeDb();

    // Reopen and verify persistence (also exercises the initPromise reset fix)
    const db2 = await initDb({ preferNative: true });
    const rows2 = db2.exec(`SELECT COUNT(*) FROM memories`);
    assert.equal(rows2[0].values[0][0], 1);

    // FTS5 tables must NOT be created by the native backend: the bundled
    // sql.js build lacks FTS5, so an FTS table + triggers in the shared file
    // would break every write on a later sql.js (fallback/classic) open
    const fts = db2.exec(`SELECT name FROM sqlite_master WHERE name = 'memories_fts'`);
    assert.deepEqual(fts, []);

    // exec-based DELETE reports rows modified (forget-project code path)
    db2.exec(`DELETE FROM memories WHERE project_id = ?`, ['proj-a']);
    assert.equal(db2.getRowsModified(), 1);

    closeDb();
  });

  test('empty result sets match sql.js shape (empty array)', async () => {
    const db = await initDb({ preferNative: true });
    const empty = db.exec(`SELECT * FROM memories WHERE id = -1`);
    assert.deepEqual(empty, []);
    closeDb();
  });
});

test('wasm backend remains the default', async () => {
  const db = await initDb();
  // sql.js Database exposes export(); result must be a Uint8Array
  assert.ok(db.export() instanceof Uint8Array);
  closeDb();
});

describe('compactDatabase', () => {
  test('prunes turns/progress, keeps memories unless explicitly asked', async () => {
    const db = await initDb(); // wasm path

    // Seed 60 turns
    for (let i = 0; i < 60; i++) {
      db.run(
        `INSERT INTO session_turns (role, content, project_id, session_id, turn_index, timestamp)
         VALUES ('user', ?, 'p', 's', ?, ?)`,
        [`turn ${i}`, i, new Date(Date.now() - i * 1000).toISOString()]
      );
    }

    // Seed one old (400 days) and one recent memory
    const oldTs = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp)
       VALUES ('old memory content', 'compact-old', ?, 'p', 's', ?)`,
      [Buffer.alloc(12), oldTs]
    );
    db.run(
      `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp)
       VALUES ('new memory content', 'compact-new', ?, 'p', 's', ?)`,
      [Buffer.alloc(12), new Date().toISOString()]
    );

    // Default: memories are NEVER pruned
    const report = compactDatabase(db, { keepTurns: 10 });
    assert.equal(report.turnsDeleted, 50);
    assert.equal(report.memoriesDeleted, 0);
    assert.equal(db.exec(`SELECT COUNT(*) FROM memories`)[0].values[0][0], 2);
    assert.equal(db.exec(`SELECT COUNT(*) FROM session_turns`)[0].values[0][0], 10);
    assert.ok(typeof report.sizeBefore === 'number' && typeof report.sizeAfter === 'number');

    // Explicit opt-in prunes only memories older than the cutoff
    // (memories.timestamp is ISO format - regression guard for the cutoff comparison)
    const report2 = compactDatabase(db, { keepTurns: 10, pruneMemoriesOlderThanDays: 30 });
    assert.equal(report2.memoriesDeleted, 1);
    const remaining = db.exec(`SELECT content_hash FROM memories`);
    assert.equal(remaining[0].values.length, 1);
    assert.equal(remaining[0].values[0][0], 'compact-new');

    closeDb();
  });
});
