/**
 * Cortex Remote Hook Wiring Tests
 * Verifies the shared-backend predicate and that requestDaemonArchive, in
 * remote mode, uploads transcript content + client identity + bearer auth to
 * the remote /archive endpoint (the hook path for auto-archive over remote).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const {
  isSharedBackendEnabled,
  requestDaemonArchive,
} = await import('../dist/index.js');

const ENV_KEYS = ['CORTEX_REMOTE_URL', 'CORTEX_REMOTE_TOKEN', 'CORTEX_USER', 'CORTEX_ENVIRONMENT', 'CORTEX_DATA_DIR'];

describe('isSharedBackendEnabled', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rh-'));
  });
  afterEach(() => {
    const dir = process.env.CORTEX_DATA_DIR;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir && dir.includes('cortex-rh-')) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('false with no daemon and no remote', () => {
    assert.strictEqual(isSharedBackendEnabled(), false);
  });

  test('true when remote is enabled via env', () => {
    process.env.CORTEX_REMOTE_URL = 'https://brain.example';
    assert.strictEqual(isSharedBackendEnabled(), true);
  });
});

describe('requestDaemonArchive over remote uploads content + identity + auth', () => {
  let server;
  let baseUrl;
  let captured;
  let tmpDir;
  let transcriptPath;
  const saved = {};

  before(async () => {
    // Capture server standing in for the remote brain.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured = {
          method: req.method,
          url: req.url,
          auth: req.headers['authorization'],
          body: body ? JSON.parse(body) : null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ archived: 2, skipped: 0, duplicates: 0, formatted: 'ok' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rh-arch-'));
    transcriptPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hello brain"}}\n');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rh-cfg-'));
    process.env.CORTEX_REMOTE_URL = baseUrl;
    process.env.CORTEX_REMOTE_TOKEN = 'hook-token';
    process.env.CORTEX_USER = 'alice';
    process.env.CORTEX_ENVIRONMENT = 'alice-wsl';
    captured = null;
  });
  afterEach(() => {
    const dir = process.env.CORTEX_DATA_DIR;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir && dir.includes('cortex-rh-cfg-')) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sends transcriptContent, client identity, and bearer token', async () => {
    const result = await requestDaemonArchive({
      transcriptPath,
      projectId: 'shared-proj',
      timeoutMs: 3000,
    });

    assert.deepStrictEqual(result, { archived: 2, skipped: 0, duplicates: 0, formatted: 'ok' });
    assert.ok(captured, 'server received a request');
    assert.strictEqual(captured.url, '/archive');
    assert.strictEqual(captured.auth, 'Bearer hook-token');
    // Uploaded the actual file content (server can't read the client disk)
    assert.match(captured.body.transcriptContent, /hello brain/);
    // Attributed to the client, not the server
    assert.deepStrictEqual(captured.body.identity, { user: 'alice', environment: 'alice-wsl' });
    assert.strictEqual(captured.body.projectId, 'shared-proj');
  });
});
