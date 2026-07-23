/**
 * Cortex Remote Transcript Archive Tests
 * Verifies parseTranscriptContent parity with parseTranscript, and that
 * archiveSession can archive from uploaded content with a client identity
 * override (the remote shared-brain write path).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const {
  parseTranscript,
  parseTranscriptContent,
  archiveSession,
  initDb,
  closeDb,
  embedQuery,
} = await import('../dist/index.js');

// archiveSession embeds content, which needs the ONNX model (+ sharp). That
// isn't available in every environment, so pre-flight once and skip the
// embedding-dependent tests when it can't load (they still run in CI/with model).
let embeddingsAvailable = false;
try {
  await embedQuery('preflight');
  embeddingsAvailable = true;
} catch {
  embeddingsAvailable = false;
}

// A small realistic JSONL transcript (Claude Code wrapped format).
const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'We decided to adopt the RRF fusion approach for hybrid search ranking.' }, timestamp: '2026-01-01T00:00:00Z' }),
  '',
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will implement reciprocal rank fusion with k=60 for combining the vector and keyword result sets in the search module.' }] }, timestamp: '2026-01-01T00:01:00Z' }),
  '{ not valid json',
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The recency decay uses a seven day half life applied after fusion.' }] }, timestamp: '2026-01-01T00:02:00Z' }),
];
const TRANSCRIPT = TRANSCRIPT_LINES.join('\n');

describe('parseTranscriptContent parity', () => {
  let tmpDir;
  let filePath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-parse-'));
    filePath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(filePath, TRANSCRIPT);
  });
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('content parse equals file parse', async () => {
    const fromFile = await parseTranscript(filePath, 0);
    const fromContent = await parseTranscriptContent(TRANSCRIPT, 0);
    assert.deepStrictEqual(fromContent.messages, fromFile.messages);
    assert.deepStrictEqual(fromContent.stats, fromFile.stats);
    assert.strictEqual(fromContent.messages.length, 3);
    assert.strictEqual(fromContent.stats.parseErrors, 1);
    assert.strictEqual(fromContent.stats.emptyLines, 1);
  });

  test('startLine offset is honored (incremental)', async () => {
    const full = await parseTranscriptContent(TRANSCRIPT, 0);
    const partial = await parseTranscriptContent(TRANSCRIPT, 3);
    assert.ok(partial.messages.length < full.messages.length);
    // totalLines still counts skipped-forward lines
    assert.strictEqual(partial.stats.totalLines, full.stats.totalLines);
  });

  test('trailing newline does not change line counts', async () => {
    const a = await parseTranscriptContent(TRANSCRIPT, 0);
    const b = await parseTranscriptContent(TRANSCRIPT + '\n', 0);
    assert.strictEqual(a.stats.totalLines, b.stats.totalLines);
  });
});

describe('archiveSession from uploaded content', () => {
  let tmp;
  const savedDataDir = process.env.CORTEX_DATA_DIR;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-rarch-'));
    process.env.CORTEX_DATA_DIR = tmp;
  });
  after(async () => {
    try { await closeDb(); } catch { /* ignore */ }
    if (savedDataDir === undefined) delete process.env.CORTEX_DATA_DIR;
    else process.env.CORTEX_DATA_DIR = savedDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('archives from content (no file) and attributes to client identity', { skip: !embeddingsAvailable ? 'embedding model unavailable' : false }, async () => {
    const db = await initDb();

    // transcriptPath is only used to derive the session id; the file does not
    // exist on this "server". Content + identity come from the client.
    const result = await archiveSession(db, '/client/machine/session-remote.jsonl', 'shared-proj', {
      transcriptContent: TRANSCRIPT,
      identity: { user: 'alice', environment: 'alice-macos' },
    });

    assert.ok(result.archived > 0, 'should archive at least one fragment from content');

    const rows = db.exec(
      `SELECT user, environment, category, project_id FROM memories WHERE user = 'alice'`
    );
    assert.ok(rows.length > 0 && rows[0].values.length > 0, 'memories attributed to the client user');
    for (const row of rows[0].values) {
      assert.strictEqual(row[0], 'alice');
      assert.strictEqual(row[1], 'alice-macos');
      assert.strictEqual(row[2], 'project');
      assert.strictEqual(row[3], 'shared-proj');
    }
  });

  test('empty content archives nothing without throwing', { skip: !embeddingsAvailable ? 'embedding model unavailable' : false }, async () => {
    const db = await initDb();
    const result = await archiveSession(db, '/client/empty.jsonl', 'p', {
      transcriptContent: '',
      identity: { user: 'bob', environment: 'bob-wsl' },
    });
    assert.strictEqual(result.archived, 0);
  });
});
