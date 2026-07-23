/**
 * Cortex Identity & Config Layering Tests
 * Covers src/identity.ts (user/project/environment resolution) and the
 * project-root .cortex/ config layering in src/config.ts, plus the additive
 * identity/category columns round-tripping through the DB.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const {
  resolveUser,
  resolveProject,
  resolveEnvironment,
  resolveIdentity,
  sanitizeLabel,
  getProjectConfigDir,
  loadConfig,
  initDb,
  insertMemory,
  getMemory,
  closeDb,
} = await import('../dist/index.js');

// Minimal 768-dim embedding
function mockEmbedding(seed = 1) {
  const e = new Float32Array(768);
  for (let i = 0; i < 768; i++) e[i] = Math.sin(seed + i * 0.1);
  return e;
}

// A config whose identity/project fields are all null (force resolution paths)
function baseConfig(overrides = {}) {
  return {
    identity: { user: null, environment: null },
    project: null,
    remote: { enabled: false, url: null },
    ...overrides,
  };
}

describe('Identity Module', () => {
  const savedEnv = {};
  const envKeys = ['CORTEX_USER', 'CORTEX_ENVIRONMENT', 'CORTEX_REMOTE_URL', 'CORTEX_DATA_DIR'];

  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('sanitizeLabel normalizes to safe tokens', () => {
    assert.strictEqual(sanitizeLabel('Thomas Filgueiras'), 'thomas-filgueiras');
    assert.strictEqual(sanitizeLabel('  UPPER__case!! '), 'upper-case');
    assert.strictEqual(sanitizeLabel('###'), 'unknown');
  });

  test('resolveUser: CORTEX_USER env wins', () => {
    process.env.CORTEX_USER = 'EnvUser';
    assert.strictEqual(resolveUser(baseConfig({ identity: { user: 'cfguser', environment: null } })), 'envuser');
  });

  test('resolveUser: config beats OS username', () => {
    assert.strictEqual(resolveUser(baseConfig({ identity: { user: 'CfgUser', environment: null } })), 'cfguser');
  });

  test('resolveUser: falls back to OS username (non-empty)', () => {
    const u = resolveUser(baseConfig());
    assert.ok(typeof u === 'string' && u.length > 0);
  });

  test('resolveProject: config.project wins over cwd basename', () => {
    assert.strictEqual(resolveProject('/home/x/some-dir', baseConfig({ project: 'My Project' })), 'my-project');
  });

  test('resolveProject: falls back to cwd basename', () => {
    assert.strictEqual(resolveProject('/home/x/cortex', baseConfig()), 'cortex');
  });

  test('resolveEnvironment: CORTEX_ENVIRONMENT env wins', () => {
    process.env.CORTEX_ENVIRONMENT = 'Claude-Web';
    assert.strictEqual(resolveEnvironment(baseConfig()), 'claude-web');
  });

  test('resolveEnvironment: config beats auto-detect', () => {
    assert.strictEqual(resolveEnvironment(baseConfig({ identity: { user: null, environment: 'CI-Box' } })), 'ci-box');
  });

  test('resolveEnvironment: auto-detect returns a non-empty label', () => {
    const e = resolveEnvironment(baseConfig());
    assert.ok(typeof e === 'string' && e.length > 0);
  });

  test('resolveIdentity returns all three values', () => {
    process.env.CORTEX_USER = 'alice';
    process.env.CORTEX_ENVIRONMENT = 'laptop';
    const id = resolveIdentity('/home/alice/proj', baseConfig());
    assert.deepStrictEqual(id, { user: 'alice', project: 'proj', environment: 'laptop' });
  });
});

describe('Project-root .cortex config layering', () => {
  let tmp;
  const savedEnv = {};
  const envKeys = ['CORTEX_DATA_DIR', 'CORTEX_REMOTE_URL'];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cfg-'));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    // Isolate the global data dir so we don't read a real ~/.cortex
    process.env.CORTEX_DATA_DIR = path.join(tmp, 'global');
    fs.mkdirSync(process.env.CORTEX_DATA_DIR, { recursive: true });
    delete process.env.CORTEX_REMOTE_URL;
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('getProjectConfigDir walks up to nearest .cortex', () => {
    const projRoot = path.join(tmp, 'repo');
    const nested = path.join(projRoot, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(projRoot, '.cortex'), { recursive: true });

    assert.strictEqual(getProjectConfigDir(nested), path.join(projRoot, '.cortex'));
    assert.strictEqual(getProjectConfigDir(path.join(tmp, 'no-such')), null);
  });

  test('project .cortex/config.json overrides global config', () => {
    const projRoot = path.join(tmp, 'repo2');
    fs.mkdirSync(path.join(projRoot, '.cortex'), { recursive: true });
    fs.writeFileSync(
      path.join(projRoot, '.cortex', 'config.json'),
      JSON.stringify({ project: 'shared-brain', remote: { enabled: true, url: 'https://brain.example' } })
    );

    const cfg = loadConfig(projRoot);
    assert.strictEqual(cfg.project, 'shared-brain');
    assert.strictEqual(cfg.remote.enabled, true);
    assert.strictEqual(cfg.remote.url, 'https://brain.example');

    // Without cwd, only the global layer is read (backward compatible)
    const globalOnly = loadConfig();
    assert.strictEqual(globalOnly.project, null);
  });

  test('CORTEX_REMOTE_URL env overrides everything', () => {
    process.env.CORTEX_REMOTE_URL = 'https://env.example';
    const cfg = loadConfig();
    assert.strictEqual(cfg.remote.url, 'https://env.example');
    assert.strictEqual(cfg.remote.enabled, true);
  });
});

describe('Identity columns round-trip', () => {
  let tmp;
  const savedDataDir = process.env.CORTEX_DATA_DIR;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-db-'));
    process.env.CORTEX_DATA_DIR = tmp;
  });
  after(async () => {
    try { await closeDb(); } catch { /* ignore */ }
    if (savedDataDir === undefined) delete process.env.CORTEX_DATA_DIR;
    else process.env.CORTEX_DATA_DIR = savedDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('insertMemory persists user/environment/category; defaults category to project', async () => {
    const db = await initDb();

    const withIdentity = insertMemory(db, {
      content: 'WSL: node-gyp needs a python3 symlink',
      embedding: mockEmbedding(2),
      projectId: 'cortex',
      sourceSession: 'test',
      timestamp: new Date(),
      user: 'thomfilg',
      environment: 'thomfilg-wsl',
      category: 'environment',
    });
    assert.strictEqual(withIdentity.isDuplicate, false);

    // Read raw columns
    const row = db.exec('SELECT user, environment, category FROM memories WHERE id = ?', [withIdentity.id]);
    assert.deepStrictEqual(row[0].values[0], ['thomfilg', 'thomfilg-wsl', 'environment']);

    // Omitting identity => NULL user/environment and default category 'project'
    const bare = insertMemory(db, {
      content: 'plain memory with no identity',
      embedding: mockEmbedding(3),
      projectId: 'cortex',
      sourceSession: 'test',
      timestamp: new Date(),
    });
    const bareRow = db.exec('SELECT user, environment, category FROM memories WHERE id = ?', [bare.id]);
    assert.deepStrictEqual(bareRow[0].values[0], [null, null, 'project']);
  });
});
