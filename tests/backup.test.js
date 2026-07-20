/**
 * Cortex Backup Module Tests
 * Tests backup state handling, due-schedule logic, and the local backup
 * path end-to-end against a local-directory rclone remote (skipped when
 * rclone is not installed).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Isolated data dir must be set before importing the bundle
const TEST_DATA_DIR = path.join(os.tmpdir(), 'cortex-backup-test-' + Date.now());
const TEST_REMOTE_DIR = path.join(TEST_DATA_DIR, 'remote');
process.env.CORTEX_DATA_DIR = TEST_DATA_DIR;

const { runBackup, isBackupDue, loadBackupState, getBackupStatePath, initDb, closeDb } =
  await import('../dist/index.js');

function hasRclone() {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeConfig(backup) {
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'config.json'),
    JSON.stringify({ backup })
  );
}

function writeState(state) {
  fs.writeFileSync(getBackupStatePath(), JSON.stringify(state));
}

const ENABLED_CONFIG = {
  enabled: true,
  remote: TEST_REMOTE_DIR,
  intervalMinutes: 60,
  keep: 2,
};

describe('Backup', () => {
  before(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_REMOTE_DIR, { recursive: true });
  });

  after(() => {
    closeDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe('loadBackupState', () => {
    test('returns empty state when file is missing', () => {
      const state = loadBackupState();
      assert.strictEqual(state.lastBackupAt, null);
      assert.strictEqual(state.lastResult, null);
    });

    test('returns empty state on corrupted file', () => {
      fs.writeFileSync(getBackupStatePath(), 'not json{');
      const state = loadBackupState();
      assert.strictEqual(state.lastBackupAt, null);
      fs.unlinkSync(getBackupStatePath());
    });

    test('merges partial state with defaults', () => {
      writeState({ lastBackupAt: '2026-01-01T00:00:00Z', lastResult: 'ok' });
      const state = loadBackupState();
      assert.strictEqual(state.lastBackupAt, '2026-01-01T00:00:00Z');
      assert.strictEqual(state.lastResult, 'ok');
      assert.strictEqual(state.lastError, null);
      fs.unlinkSync(getBackupStatePath());
    });
  });

  describe('isBackupDue', () => {
    test('false when disabled', () => {
      assert.strictEqual(isBackupDue({ ...ENABLED_CONFIG, enabled: false }), false);
    });

    test('false when no remote configured', () => {
      assert.strictEqual(isBackupDue({ ...ENABLED_CONFIG, remote: null }), false);
    });

    test('true when never backed up', () => {
      assert.strictEqual(isBackupDue(ENABLED_CONFIG), true);
    });

    test('true when last backup errored', () => {
      writeState({ lastBackupAt: new Date().toISOString(), lastResult: 'error' });
      assert.strictEqual(isBackupDue(ENABLED_CONFIG), true);
      fs.unlinkSync(getBackupStatePath());
    });

    test('false within interval, true after it elapses', () => {
      writeState({ lastBackupAt: new Date().toISOString(), lastResult: 'ok' });
      assert.strictEqual(isBackupDue(ENABLED_CONFIG), false);

      const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      writeState({ lastBackupAt: old, lastResult: 'ok' });
      assert.strictEqual(isBackupDue(ENABLED_CONFIG), true);
      fs.unlinkSync(getBackupStatePath());
    });
  });

  describe('runBackup (local rclone remote)', { skip: !hasRclone() }, () => {
    test('fails with a clear error when no remote configured', async () => {
      writeConfig({ ...ENABLED_CONFIG, remote: null });
      // Config errors throw before any state is recorded
      await assert.rejects(() => runBackup(), /remote/i);
      assert.strictEqual(loadBackupState().lastResult, null);
    });

    test('uploads a gzip snapshot and records state', async () => {
      // Create a real database file first
      const db = await initDb();
      db.run(
        `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp)
         VALUES ('backup test memory', 'backup-test-hash', x'00', 'test', 'sess', '2026-01-01T00:00:00Z')`
      );
      closeDb();

      writeConfig(ENABLED_CONFIG);
      const result = await runBackup();

      assert.match(result.remoteName, /^memory-.*\.db\.gz$/);
      assert.ok(result.sizeBytes > 0);
      assert.ok(fs.existsSync(path.join(TEST_REMOTE_DIR, result.remoteName)));

      const state = loadBackupState();
      assert.strictEqual(state.lastResult, 'ok');
      assert.strictEqual(state.lastRemoteName, result.remoteName);

      // Temp snapshot files are cleaned up
      const tmpDir = path.join(TEST_DATA_DIR, 'backup-tmp');
      assert.deepStrictEqual(fs.readdirSync(tmpDir), []);
    });

    test('rotates old snapshots beyond keep', async () => {
      // Seed fake older snapshots (ISO-sortable names)
      const oldNames = [
        'memory-2020-01-01T00-00-00.db.gz',
        'memory-2020-01-02T00-00-00.db.gz',
        'memory-2020-01-03T00-00-00.db.gz',
      ];
      for (const name of oldNames) {
        fs.writeFileSync(path.join(TEST_REMOTE_DIR, name), 'x');
      }

      writeConfig(ENABLED_CONFIG); // keep: 2
      const result = await runBackup();

      const remaining = fs.readdirSync(TEST_REMOTE_DIR).sort();
      assert.strictEqual(remaining.length, 2);
      // Newest two survive: the fresh upload + the newest prior snapshot
      assert.ok(remaining.includes(result.remoteName));
      assert.ok(result.rotatedOut.length >= 2);
      assert.ok(!remaining.includes('memory-2020-01-01T00-00-00.db.gz'));
    });
  });
});
