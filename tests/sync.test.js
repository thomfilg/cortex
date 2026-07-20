/**
 * Cortex Sync Module Tests
 * Unit tests for state/due logic plus a two-device end-to-end sync through
 * a local-directory rclone remote (skipped when rclone is not installed).
 *
 * Device A runs in-process (CORTEX_DATA_DIR set before import); device B
 * runs through the CLI in a subprocess with its own data dir.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const BASE = path.join(os.tmpdir(), 'cortex-sync-test-' + Date.now());
const DEVICE_A_DIR = path.join(BASE, 'device-a');
const DEVICE_B_DIR = path.join(BASE, 'device-b');
const REMOTE_DIR = path.join(BASE, 'remote');
process.env.CORTEX_DATA_DIR = DEVICE_A_DIR;

const {
  runSync, isSyncDue, loadSyncState, getSyncStatePath, ensureDeviceId,
  initDb, closeDb, saveDb, insertMemory, deleteMemory,
} = await import('../dist/index.js');

const INDEX_JS = new URL('../dist/index.js', import.meta.url).pathname;

function hasRclone() {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SYNC_CONFIG = {
  enabled: true,
  remote: REMOTE_DIR,
  intervalMinutes: 60,
  projects: null,
};

function writeConfig(dir, sync) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    sync,
    // Point away from any real daemon on the default port: the CLI probes
    // daemon health regardless of daemon.enabled
    daemon: { enabled: false, port: 49179, storage: 'auto' },
  }));
}

/** Run `cortex sync` as device B (own data dir, own DB) */
function syncDeviceB(...flags) {
  return execFileSync(process.execPath, [INDEX_JS, 'sync', ...flags], {
    env: { ...process.env, CORTEX_DATA_DIR: DEVICE_B_DIR },
    encoding: 'utf8',
    timeout: 120000,
  });
}

/** Read device B's memories via a subprocess (its own initDb + env) */
function readDeviceBMemories() {
  const script = `
    const { initDb, closeDb } = await import('file://${INDEX_JS}');
    const db = await initDb();
    const rows = db.exec('SELECT content_hash, content, origin_device FROM memories ORDER BY id');
    console.log(JSON.stringify(rows.length ? rows[0].values : []));
    closeDb();
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CORTEX_DATA_DIR: DEVICE_B_DIR },
    encoding: 'utf8',
    timeout: 60000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/** Delete a memory on device B by hash (through deleteMemory so it tombstones) */
function deleteOnDeviceB(hash) {
  const script = `
    const { initDb, closeDb } = await import('file://${INDEX_JS}');
    const db = await initDb();
    const row = db.exec('SELECT id FROM memories WHERE content_hash = ?', ['${hash}']);
    const { deleteMemory } = await import('file://${INDEX_JS}');
    deleteMemory(db, row[0].values[0][0]);
    closeDb();
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CORTEX_DATA_DIR: DEVICE_B_DIR },
    encoding: 'utf8',
    timeout: 60000,
  });
}

function fakeEmbedding(seed) {
  const arr = new Float32Array(8);
  for (let i = 0; i < arr.length; i++) arr[i] = seed + i;
  return arr;
}

describe('Sync', () => {
  before(() => {
    fs.mkdirSync(REMOTE_DIR, { recursive: true });
    writeConfig(DEVICE_A_DIR, SYNC_CONFIG);
    writeConfig(DEVICE_B_DIR, SYNC_CONFIG);
  });

  after(() => {
    closeDb();
    fs.rmSync(BASE, { recursive: true, force: true });
  });

  describe('state & scheduling', () => {
    test('loadSyncState returns defaults on missing file', () => {
      const state = loadSyncState();
      assert.strictEqual(state.deviceId, null);
      assert.strictEqual(state.nextSeq, 1);
      assert.deepStrictEqual(state.peers, {});
    });

    test('ensureDeviceId generates a stable id and persists it', () => {
      const state = loadSyncState();
      const id = ensureDeviceId(state);
      assert.match(id, /^[a-z0-9-]+-[0-9a-f]{6}$/);
      assert.strictEqual(ensureDeviceId(loadSyncState()), id);
    });

    test('isSyncDue respects enabled/remote/interval', () => {
      assert.strictEqual(isSyncDue({ ...SYNC_CONFIG, enabled: false }), false);
      assert.strictEqual(isSyncDue({ ...SYNC_CONFIG, remote: null }), false);
      assert.strictEqual(isSyncDue(SYNC_CONFIG), true); // never synced

      const state = loadSyncState();
      state.lastSyncAt = new Date().toISOString();
      state.lastResult = 'ok';
      fs.writeFileSync(getSyncStatePath(), JSON.stringify(state));
      assert.strictEqual(isSyncDue(SYNC_CONFIG), false);

      state.lastSyncAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      fs.writeFileSync(getSyncStatePath(), JSON.stringify(state));
      assert.strictEqual(isSyncDue(SYNC_CONFIG), true);
    });
  });

  describe('two-device end-to-end', { skip: !hasRclone() }, () => {
    let db;
    let hashKeep;
    let hashDelete;

    test('device A pushes its memories', async () => {
      db = await initDb();
      const m1 = insertMemory(db, {
        content: 'shared memory that stays',
        embedding: fakeEmbedding(1),
        projectId: 'proj-x',
        sourceSession: 'sess-a',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });
      const m2 = insertMemory(db, {
        content: 'shared memory that gets deleted on B',
        embedding: fakeEmbedding(2),
        projectId: 'proj-x',
        sourceSession: 'sess-a',
        timestamp: new Date('2026-01-02T00:00:00Z'),
      });
      assert.strictEqual(m1.isDuplicate, false);
      assert.strictEqual(m2.isDuplicate, false);
      saveDb(db);

      const rows = db.exec('SELECT content_hash, content FROM memories ORDER BY id')[0].values;
      hashKeep = rows[0][0];
      hashDelete = rows[1][0];

      const result = await runSync(db);
      assert.strictEqual(result.pushed.memories, 2);
      assert.strictEqual(result.pushed.files, 1);
      assert.strictEqual(result.pulled.added, 0);

      // Changelog landed under A's device folder on the remote
      const deviceId = loadSyncState().deviceId;
      const files = fs.readdirSync(path.join(REMOTE_DIR, deviceId));
      assert.deepStrictEqual(files, ['00000001.jsonl.gz']);
    });

    test('device B pulls A\'s memories', () => {
      const out = syncDeviceB();
      assert.match(out, /Pulled: 2 memories/);

      const rows = readDeviceBMemories();
      assert.strictEqual(rows.length, 2);
      const hashes = rows.map((r) => r[0]);
      assert.ok(hashes.includes(hashKeep) && hashes.includes(hashDelete));
      // Imported rows carry A's device id (never re-pushed)
      assert.ok(rows.every((r) => r[2] !== null));
    });

    test('B re-sync pushes nothing back (no echo loop)', () => {
      const out = syncDeviceB();
      assert.match(out, /Pushed: 0 memories, 0 deletions/);
      assert.match(out, /Pulled: 0 memories/);
    });

    test('a deletion on B tombstones and propagates to A', async () => {
      deleteOnDeviceB(hashDelete);
      const out = syncDeviceB();
      assert.match(out, /Pushed: 0 memories, 1 deletions/);

      // A pulls the tombstone
      const result = await runSync(db);
      assert.strictEqual(result.pulled.deleted, 1);

      const rows = db.exec('SELECT content_hash FROM memories ORDER BY id')[0].values;
      assert.deepStrictEqual(rows.map((r) => r[0]), [hashKeep]);

      // Tombstone recorded locally: content cannot be re-imported
      const tomb = db.exec('SELECT 1 FROM sync_tombstones WHERE content_hash = ?', [hashDelete]);
      assert.ok(tomb.length > 0 && tomb[0].values.length > 0);
    });

    test('new memory on A after tombstone still syncs to B', async () => {
      insertMemory(db, {
        content: 'second wave memory',
        embedding: fakeEmbedding(3),
        projectId: 'proj-y',
        sourceSession: 'sess-a2',
        timestamp: new Date('2026-01-03T00:00:00Z'),
      });
      saveDb(db);

      const pushResult = await runSync(db);
      assert.strictEqual(pushResult.pushed.memories, 1);

      const out = syncDeviceB();
      assert.match(out, /Pulled: 1 memories/);
      const rows = readDeviceBMemories();
      // B has: keep + second wave (deleted one stays deleted)
      assert.strictEqual(rows.length, 2);
      assert.ok(!rows.map((r) => r[0]).includes(hashDelete));
    });

    test('corrupt changelog from one peer does not abort the sync', async () => {
      // Fake peer with a truncated/corrupt gzip changelog
      const badPeerDir = path.join(REMOTE_DIR, 'bad-peer-000000');
      fs.mkdirSync(badPeerDir, { recursive: true });
      fs.writeFileSync(path.join(badPeerDir, '00000001.jsonl.gz'), 'not gzip at all');

      const result = await runSync(db);
      assert.strictEqual(result.pulled.errors.length, 1);
      assert.match(result.pulled.errors[0], /bad-peer-000000/);
      // Sync still completed and recorded success
      assert.strictEqual(loadSyncState().lastResult, 'ok');
      // The corrupt file was not marked applied - it will retry
      assert.strictEqual(loadSyncState().peers['bad-peer-000000'], undefined);

      fs.rmSync(badPeerDir, { recursive: true, force: true });
    });

    test('pushes over 5000 lines split into multiple chunk files', async () => {
      db.run('BEGIN');
      for (let i = 0; i < 5001; i++) {
        insertMemory(db, {
          content: `bulk memory number ${i}`,
          embedding: fakeEmbedding(i),
          projectId: 'bulk',
          sourceSession: 'sess-bulk',
          timestamp: new Date('2026-02-01T00:00:00Z'),
        });
      }
      db.run('COMMIT');
      saveDb(db);

      const result = await runSync(db);
      assert.strictEqual(result.pushed.memories, 5001);
      assert.strictEqual(result.pushed.files, 2);

      // Watermark advanced past everything: nothing left to push
      const again = await runSync(db);
      assert.strictEqual(again.pushed.memories, 0);
      assert.strictEqual(again.pushed.files, 0);
    });
  });
});
