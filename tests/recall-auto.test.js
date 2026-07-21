/**
 * Cortex Auto-Recall Tests
 * Unit tests for prompt eligibility, injection selection (threshold,
 * dedup, budget), formatting, and per-session state handling.
 * The end-to-end CLI path is covered indirectly: it composes these pure
 * functions with the already-tested search/daemon layers.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DIR = path.join(os.tmpdir(), 'cortex-recall-test-' + Date.now());
process.env.CORTEX_DATA_DIR = TEST_DIR;

const {
  isPromptEligible, selectForInjection, formatInjection,
  loadRecallState, getInjectedIds, recordInjection, getRecallStatePath,
  loadConfig,
} = await import('../dist/index.js');

const CONFIG = {
  auto: true,
  minScore: 0.7,
  maxResults: 3,
  tokenBudget: 500,
  minPromptLength: 12,
};

function candidate(id, score, content, daysAgo = 1) {
  return {
    id,
    score,
    content,
    timestamp: new Date(Date.now() - daysAgo * 86400000),
    projectId: 'proj-x',
  };
}

describe('Auto-Recall', () => {
  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('isPromptEligible', () => {
    test('accepts a normal question', () => {
      assert.strictEqual(isPromptEligible('how did we configure the daemon port?', CONFIG), true);
    });

    test('rejects short prompts', () => {
      assert.strictEqual(isPromptEligible('ok', CONFIG), false);
      assert.strictEqual(isPromptEligible('yes please', CONFIG), false);
    });

    test('rejects slash commands and shell escapes', () => {
      assert.strictEqual(isPromptEligible('/cortex-setup please run it', CONFIG), false);
      assert.strictEqual(isPromptEligible('! npm test --watch things', CONFIG), false);
    });

    test('rejects our own injected block', () => {
      assert.strictEqual(isPromptEligible('[cortex:auto-recall] something long enough', CONFIG), false);
    });

    test('respects a custom minPromptLength', () => {
      assert.strictEqual(isPromptEligible('short one', { ...CONFIG, minPromptLength: 5 }), true);
    });
  });

  describe('selectForInjection', () => {
    test('filters below-threshold results', () => {
      const results = [
        candidate(1, 0.85, 'highly relevant'),
        candidate(2, 0.69, 'just under threshold'),
        candidate(3, 0.3, 'noise'),
      ];
      const selected = selectForInjection(results, CONFIG, new Set());
      assert.deepStrictEqual(selected.map((r) => r.id), [1]);
    });

    test('skips already-injected ids', () => {
      const results = [candidate(1, 0.9, 'seen before'), candidate(2, 0.8, 'new one')];
      const selected = selectForInjection(results, CONFIG, new Set([1]));
      assert.deepStrictEqual(selected.map((r) => r.id), [2]);
    });

    test('caps at maxResults', () => {
      const results = [1, 2, 3, 4, 5].map((i) => candidate(i, 0.9, `memory ${i}`));
      const selected = selectForInjection(results, CONFIG, new Set());
      assert.strictEqual(selected.length, 3);
    });

    test('respects the token budget', () => {
      // Budget of 100 tokens = ~400 chars; each entry ~340 chars incl. overhead
      const long = 'x'.repeat(300);
      const results = [candidate(1, 0.9, long), candidate(2, 0.9, long), candidate(3, 0.9, long)];
      const selected = selectForInjection(results, { ...CONFIG, tokenBudget: 100 }, new Set());
      assert.strictEqual(selected.length, 1);
    });

    test('trims overly long fragments instead of dropping them', () => {
      const results = [candidate(1, 0.9, 'y'.repeat(2000))];
      const selected = selectForInjection(results, CONFIG, new Set());
      assert.strictEqual(selected.length, 1);
      assert.ok(selected[0].content.length <= 603);
      assert.ok(selected[0].content.endsWith('...'));
    });

    test('returns empty when nothing qualifies', () => {
      const results = [candidate(1, 0.2, 'irrelevant')];
      assert.deepStrictEqual(selectForInjection(results, CONFIG, new Set()), []);
    });
  });

  describe('formatInjection', () => {
    test('formats a labeled block with scores and ages', () => {
      const out = formatInjection([candidate(1, 0.87, 'daemon runs on port 4983', 2)], 'proj-x');
      assert.match(out, /^\[cortex:auto-recall\] Relevant memories from past sessions \(project: proj-x\):/);
      assert.match(out, /1\. \(87% match • 2d ago\) daemon runs on port 4983/);
    });

    test('omits project scope when null', () => {
      const out = formatInjection([candidate(1, 0.8, 'global fact')], null);
      assert.match(out, /past sessions:/);
      assert.ok(!out.includes('(project:'));
    });
  });

  describe('config migration', () => {
    test('a pre-2.5.0 config without a recall key gets defaults (auto stays off)', () => {
      // Simulate an existing user's config file that predates auto-recall
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(path.join(TEST_DIR, 'config.json'), JSON.stringify({
        statusline: { enabled: false },
        daemon: { enabled: true, port: 4983, storage: 'auto' },
      }));

      const config = loadConfig();
      assert.strictEqual(config.recall.auto, false);
      assert.strictEqual(config.recall.minScore, 0.62);
      assert.strictEqual(config.recall.maxResults, 3);
      assert.ok(Number.isFinite(config.recall.tokenBudget));
      // The user's own values survive the merge
      assert.strictEqual(config.statusline.enabled, false);

      fs.rmSync(path.join(TEST_DIR, 'config.json'), { force: true });
    });
  });

  describe('recall state', () => {
    test('loadRecallState returns empty state on missing file', () => {
      const state = loadRecallState();
      assert.deepStrictEqual(state.sessions, {});
    });

    test('recordInjection persists and getInjectedIds reads back', () => {
      const state = loadRecallState();
      recordInjection(state, 'sess-1', [10, 20]);
      recordInjection(state, 'sess-1', [20, 30]);

      const reloaded = loadRecallState();
      assert.deepStrictEqual([...getInjectedIds(reloaded, 'sess-1')].sort((a, b) => a - b), [10, 20, 30]);
      assert.deepStrictEqual([...getInjectedIds(reloaded, 'sess-other')], []);
      assert.ok(fs.existsSync(getRecallStatePath()));
    });

    test('state is pruned to the most recent sessions', () => {
      const state = loadRecallState();
      for (let i = 0; i < 30; i++) {
        recordInjection(state, `sess-prune-${i}`, [i]);
      }
      const reloaded = loadRecallState();
      assert.ok(Object.keys(reloaded.sessions).length <= 20);
      // The most recently recorded session survives
      assert.ok(reloaded.sessions['sess-prune-29']);
    });

    test('missing session_id fallback key behaves like any other session', () => {
      const state = loadRecallState();
      recordInjection(state, 'unknown-session', [77]);
      const reloaded = loadRecallState();
      assert.deepStrictEqual([...getInjectedIds(reloaded, 'unknown-session')], [77]);
    });

    test('corrupt state file falls back to empty state', () => {
      fs.writeFileSync(getRecallStatePath(), 'not json{{{');
      assert.deepStrictEqual(loadRecallState().sessions, {});
    });
  });
});
