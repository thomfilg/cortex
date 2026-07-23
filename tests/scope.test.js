/**
 * Cortex Category-Aware Recall Scoping Tests
 * Verifies buildScopeClause SQL and that searchByVector/searchByKeyword honor
 * a RecallScope, returning the correct slice of the shared brain per mode.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const {
  initDb,
  insertMemory,
  searchByVector,
  searchByKeyword,
  buildScopeClause,
  closeDb,
} = await import('../dist/index.js');

function mockEmbedding(seed = 1) {
  const e = new Float32Array(768);
  for (let i = 0; i < 768; i++) e[i] = Math.sin(seed + i * 0.1);
  return e;
}

const SESSION = { user: 'thomfilg', environment: 'wsl', project: 'pA' };

// Return the set of ids matched by a scope for a fixed query embedding.
function idsForScope(db, scope) {
  const rows = searchByVector(db, mockEmbedding(1), undefined, 100, scope);
  return new Set(rows.map((r) => r.id));
}

describe('buildScopeClause', () => {
  test('all => empty clause', () => {
    assert.deepStrictEqual(buildScopeClause({ mode: 'all' }), { clause: '', params: [] });
  });
  test('project => project rows or legacy null category', () => {
    const { clause, params } = buildScopeClause({ mode: 'project', project: 'pA' });
    assert.match(clause, /category = 'project' OR .*category IS NULL/);
    assert.deepStrictEqual(params, ['pA']);
  });
  test('environment => environment + env match, no project constraint', () => {
    const { clause, params } = buildScopeClause({ mode: 'environment', environment: 'wsl' });
    assert.match(clause, /category = 'environment' AND environment = \?/);
    assert.deepStrictEqual(params, ['wsl']);
  });
  test('auto => four-branch union with user/env/project params', () => {
    const { params } = buildScopeClause({ mode: 'auto', user: 'u', environment: 'e', project: 'p' });
    assert.deepStrictEqual(params, ['u', 'e', 'p']);
  });
  test('alias prefixes columns', () => {
    const { clause } = buildScopeClause({ mode: 'global' }, 'm');
    assert.strictEqual(clause, "m.category = 'global'");
  });
});

describe('searchByVector honors RecallScope', () => {
  let db;
  const ids = {};

  before(async () => {
    process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-scope-'));
    db = await initDb();

    const add = (key, category, user, environment, projectId) => {
      const r = insertMemory(db, {
        content: `memory ${key} about authentication systems`,
        embedding: mockEmbedding(1),
        projectId,
        sourceSession: 'test',
        timestamp: new Date(),
        user,
        environment,
        category,
      });
      ids[key] = r.id;
    };

    add('A', 'global', 'someone', 'anywhere', 'pA');
    add('B', 'user', 'thomfilg', 'e1', 'pA');
    add('C', 'user', 'other-user', 'e1', 'pA');
    add('D', 'environment', 'u2', 'wsl', 'pA');
    add('E', 'environment', 'u2', 'wsl', 'pB');
    add('F', 'project', 'u3', 'e3', 'pA');
    add('G', 'project', 'u3', 'e3', 'pB');

    // H: legacy row with NULL category (inserted raw, bypassing the default)
    db.run(
      `INSERT INTO memories (content, content_hash, embedding, project_id, source_session, timestamp, category)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        'legacy memory H about authentication',
        crypto.randomUUID(),
        Buffer.from(mockEmbedding(1).buffer),
        'pA',
        'legacy',
        new Date().toISOString(),
      ]
    );
    const hRow = db.exec(`SELECT id FROM memories WHERE source_session = 'legacy'`);
    ids.H = hRow[0].values[0][0];
  });

  after(async () => {
    const dir = process.env.CORTEX_DATA_DIR;
    try { await closeDb(); } catch { /* ignore */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("auto = global + my user + my environment + my project (incl. legacy null)", () => {
    const got = idsForScope(db, { mode: 'auto', ...SESSION });
    assert.deepStrictEqual(got, new Set([ids.A, ids.B, ids.D, ids.E, ids.F, ids.H]));
    assert.ok(!got.has(ids.C), 'excludes other user');
    assert.ok(!got.has(ids.G), 'excludes other project');
  });

  test('project = this project only (project category or legacy null)', () => {
    const got = idsForScope(db, { mode: 'project', ...SESSION });
    assert.deepStrictEqual(got, new Set([ids.F, ids.H]));
  });

  test('environment = this machine across all projects', () => {
    const got = idsForScope(db, { mode: 'environment', ...SESSION });
    assert.deepStrictEqual(got, new Set([ids.D, ids.E]));
  });

  test('user = my cross-project preferences only', () => {
    const got = idsForScope(db, { mode: 'user', ...SESSION });
    assert.deepStrictEqual(got, new Set([ids.B]));
  });

  test('global = universal facts only', () => {
    const got = idsForScope(db, { mode: 'global', ...SESSION });
    assert.deepStrictEqual(got, new Set([ids.A]));
  });

  test('all = the entire shared brain', () => {
    const got = idsForScope(db, { mode: 'all', ...SESSION });
    assert.strictEqual(got.size, 8);
  });

  test('searchByKeyword honors scope too', () => {
    const rows = searchByKeyword(db, 'authentication', undefined, 100, { mode: 'environment', ...SESSION });
    const got = new Set(rows.map((r) => r.id));
    assert.deepStrictEqual(got, new Set([ids.D, ids.E]));
  });
});
