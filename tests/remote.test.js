/**
 * Cortex Remote Shared-Brain Adapter Tests
 * Covers server-side auth/binding (daemon-auth) and client-side remote
 * resolution (base URL, token, lifecycle guards).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const {
  // server side
  isServerMode,
  getBindHost,
  getServerToken,
  isAuthorized,
  // client side
  isRemoteModeEnabled,
  getRemoteUrl,
  getRemoteToken,
  getDaemonBaseUrl,
  spawnDaemonDetached,
  stopDaemon,
  ensureDaemon,
} = await import('../dist/index.js');

const ENV_KEYS = [
  'CORTEX_SERVER',
  'CORTEX_SERVER_TOKEN',
  'CORTEX_REMOTE_URL',
  'CORTEX_REMOTE_TOKEN',
  'CORTEX_DATA_DIR',
];

describe('daemon-auth (server side)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    // Isolate config so loadConfig() doesn't read a real ~/.cortex
    process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-remote-'));
  });
  afterEach(() => {
    const dir = process.env.CORTEX_DATA_DIR;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir && dir.includes('cortex-remote-')) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('local daemon: loopback bind, no server mode', () => {
    assert.strictEqual(isServerMode([]), false);
    assert.strictEqual(getBindHost([]), '127.0.0.1');
  });

  test('CORTEX_SERVER=1 => public bind + server mode', () => {
    process.env.CORTEX_SERVER = '1';
    assert.strictEqual(isServerMode([]), true);
    assert.strictEqual(getBindHost([]), '0.0.0.0');
  });

  test('--server flag also enables server mode', () => {
    assert.strictEqual(isServerMode(['node', 'daemon.js', '--server']), true);
    assert.strictEqual(getBindHost(['--server']), '0.0.0.0');
  });

  test('no token configured => auth open (local daemon unchanged)', () => {
    assert.strictEqual(getServerToken(), null);
    assert.strictEqual(isAuthorized(undefined), true);
    assert.strictEqual(isAuthorized('Bearer anything'), true);
  });

  test('token configured => only the matching bearer is authorized', () => {
    process.env.CORTEX_SERVER_TOKEN = 's3cret-token';
    assert.strictEqual(getServerToken(), 's3cret-token');
    assert.strictEqual(isAuthorized('Bearer s3cret-token'), true);
    assert.strictEqual(isAuthorized('bearer s3cret-token'), true); // scheme case-insensitive
    assert.strictEqual(isAuthorized('Bearer wrong'), false);
    assert.strictEqual(isAuthorized('s3cret-token'), false); // missing scheme
    assert.strictEqual(isAuthorized(undefined), false);
    assert.strictEqual(isAuthorized(''), false);
  });

  test('token check is length-safe (no crash on mismatched lengths)', () => {
    process.env.CORTEX_SERVER_TOKEN = 'short';
    assert.strictEqual(isAuthorized('Bearer a-much-longer-token-value'), false);
  });
});

describe('remote resolution (client side)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-remote-'));
  });
  afterEach(() => {
    const dir = process.env.CORTEX_DATA_DIR;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir && dir.includes('cortex-remote-')) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no remote config => local daemon base URL, remote mode off', () => {
    assert.strictEqual(isRemoteModeEnabled(), false);
    assert.strictEqual(getRemoteUrl(), null);
    assert.match(getDaemonBaseUrl(), /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('CORTEX_REMOTE_URL enables remote mode and sets the base URL', () => {
    process.env.CORTEX_REMOTE_URL = 'https://brain.example.dev/';
    assert.strictEqual(isRemoteModeEnabled(), true);
    // trailing slash stripped
    assert.strictEqual(getRemoteUrl(), 'https://brain.example.dev');
    assert.strictEqual(getDaemonBaseUrl(), 'https://brain.example.dev');
  });

  test('token comes only from CORTEX_REMOTE_TOKEN', () => {
    assert.strictEqual(getRemoteToken(), null);
    process.env.CORTEX_REMOTE_TOKEN = '  tok-123  ';
    assert.strictEqual(getRemoteToken(), 'tok-123'); // trimmed
  });

  test('remote mode never spawns or stops a local daemon', async () => {
    process.env.CORTEX_REMOTE_URL = 'https://brain.example.dev';
    process.env.CORTEX_REMOTE_TOKEN = 'tok';
    assert.strictEqual(spawnDaemonDetached(), false);
    assert.strictEqual(await stopDaemon(), false);
  });

  test('ensureDaemon returns false when the remote is unreachable (no fallback spawn)', async () => {
    // Unroutable port on localhost; remote mode must probe, not spawn.
    process.env.CORTEX_REMOTE_URL = 'http://127.0.0.1:1';
    process.env.CORTEX_REMOTE_TOKEN = 'tok';
    const ok = await ensureDaemon(1000);
    assert.strictEqual(ok, false);
  });
});
