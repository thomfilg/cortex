#!/usr/bin/env node
/**
 * Migrate a LOCAL Cortex database into a REMOTE shared-brain server.
 *
 * Reads every memory from ~/.cortex/memory.db (or --db / CORTEX_DATA_DIR) and
 * re-saves it into the remote Cortex server via the authenticated /mcp
 * `cortex_remember` endpoint. The server re-embeds each memory and dedups by
 * content hash, so this is IDEMPOTENT — re-running skips anything already there.
 *
 * Preserved: content, context, projectId, category, user, environment.
 * NOT preserved (limitations of the remember tool):
 *   - original timestamp  -> becomes the import time (affects recency decay)
 *   - embedding           -> regenerated server-side from content
 *   - source_session      -> not carried over
 *
 * Usage:
 *   node scripts/migrate-local-to-remote.mjs --dry-run
 *   node scripts/migrate-local-to-remote.mjs --confirm
 *   node scripts/migrate-local-to-remote.mjs --confirm --project myrepo --limit 100
 *
 * Connection (flags override env):
 *   --url    <url>    remote base url   (or CORTEX_REMOTE_URL)
 *   --token  <token>  bearer token      (or CORTEX_REMOTE_TOKEN)
 *   --db     <path>   local memory.db   (or CORTEX_DATA_DIR/memory.db, or ~/.cortex/memory.db)
 *
 * Options:
 *   --dry-run         read + report only, write NOTHING (default if neither given)
 *   --confirm         actually push to the remote
 *   --project <id>    only migrate memories whose project_id matches
 *   --limit <n>       migrate at most n memories
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { dryRun: false, confirm: false, project: null, limit: Infinity, url: null, token: null, db: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--confirm') a.confirm = true;
    else if (v === '--project') a.project = argv[++i];
    else if (v === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (v === '--url') a.url = argv[++i];
    else if (v === '--token') a.token = argv[++i];
    else if (v === '--db') a.db = argv[++i];
    else if (v === '-h' || v === '--help') { a.help = true; }
    else { console.error(`Unknown argument: ${v}`); process.exit(2); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readHelp());
  process.exit(0);
}
// Default to a safe dry-run when neither flag is given.
if (!args.confirm && !args.dryRun) args.dryRun = true;

function readHelp() {
  return `migrate-local-to-remote — push local Cortex memories to a remote shared brain
  --dry-run          report only, write nothing (default)
  --confirm          actually migrate
  --project <id>     only this project
  --limit <n>        cap number migrated
  --url / --token    remote base url + bearer (or CORTEX_REMOTE_URL / CORTEX_REMOTE_TOKEN)
  --db <path>        local memory.db (or CORTEX_DATA_DIR/memory.db, or ~/.cortex/memory.db)`;
}

// ---- resolve connection + db ----------------------------------------------
const remoteUrl = (args.url || process.env.CORTEX_REMOTE_URL || '').replace(/\/+$/, '');
const remoteToken = args.token || process.env.CORTEX_REMOTE_TOKEN || '';
const dbPath =
  args.db ||
  (process.env.CORTEX_DATA_DIR ? join(process.env.CORTEX_DATA_DIR, 'memory.db') : join(homedir(), '.cortex', 'memory.db'));

function fail(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

if (!remoteUrl) fail('No remote URL. Pass --url or set CORTEX_REMOTE_URL.');
if (!remoteToken) fail('No remote token. Pass --token or set CORTEX_REMOTE_TOKEN (env-only, never persisted).');
if (!existsSync(dbPath)) fail(`Local database not found at ${dbPath}. Pass --db to point at it.`);

// ---- open local db (read-only) --------------------------------------------
let Database;
try {
  Database = require(join(repoRoot, 'node_modules', 'better-sqlite3'));
} catch (e) {
  fail(`Could not load better-sqlite3 from the repo (${e.message}). Run \`npm install\` in ${repoRoot}.`);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Legacy databases (pre-v2.6) may lack user/environment/category columns.
const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
const has = (c) => cols.has(c);
const sel = [
  'id',
  'content',
  has('project_id') ? 'project_id' : 'NULL AS project_id',
  has('category') ? 'category' : "'project' AS category",
  has('user') ? 'user' : 'NULL AS user',
  has('environment') ? 'environment' : 'NULL AS environment',
  has('timestamp') ? 'timestamp' : 'NULL AS timestamp',
].join(', ');

let where = '';
const params = [];
if (args.project) { where = 'WHERE project_id = ?'; params.push(args.project); }
const rows = db
  .prepare(`SELECT ${sel} FROM memories ${where} ORDER BY id ASC`)
  .all(...params)
  .filter((r) => r.content && r.content.trim().length > 0);
db.close();

const total = rows.length;
const toMigrate = rows.slice(0, args.limit);

// ---- remote helpers -------------------------------------------------------
async function health() {
  const res = await fetch(`${remoteUrl}/health`, { method: 'GET' });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

let rpcId = 0;
async function remember(row) {
  rpcId++;
  const argsObj = { content: row.content };
  if (row.project_id) argsObj.projectId = row.project_id;
  if (row.category) argsObj.category = row.category;
  if (row.user !== null && row.user !== undefined) argsObj.user = row.user;
  if (row.environment !== null && row.environment !== undefined) argsObj.environment = row.environment;

  const res = await fetch(`${remoteUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'cortex_remember', arguments: argsObj } }),
  });
  if (res.status === 401) throw new Error('401 Unauthorized — check CORTEX_REMOTE_TOKEN');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const text = json?.result?.content?.[0]?.text;
  if (!text) throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  const parsed = JSON.parse(text);
  if (parsed.success === false) throw new Error(parsed.error || 'remember failed');
  return parsed.isDuplicate ? 'duplicate' : 'inserted';
}

// ---- run ------------------------------------------------------------------
async function main() {
  console.log('Cortex local → remote migration');
  console.log(`  local db : ${dbPath}`);
  console.log(`  remote   : ${remoteUrl}`);
  console.log(`  memories : ${total} total${args.project ? ` in project "${args.project}"` : ''}${toMigrate.length < total ? `, migrating first ${toMigrate.length} (--limit)` : ''}`);
  console.log(`  columns  : user=${has('user')} environment=${has('environment')} category=${has('category')}`);

  let hc;
  try { hc = await health(); } catch (e) { fail(`Remote unreachable at ${remoteUrl}/health (${e.message}).`); }
  console.log(`  server   : cortex-daemon v${hc.version} (storage: ${hc.storage})`);

  if (args.dryRun) {
    console.log(`\n[dry-run] Would migrate ${toMigrate.length} memories. Re-run with --confirm to write.`);
    process.exit(0);
  }

  console.log(`\nMigrating ${toMigrate.length} memories…`);
  let inserted = 0, duplicate = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < toMigrate.length; i++) {
    const row = toMigrate[i];
    try {
      const outcome = await remember(row);
      if (outcome === 'inserted') inserted++; else duplicate++;
    } catch (e) {
      failed++;
      failures.push({ id: row.id, error: e.message });
      // Auth failures are fatal — stop rather than hammer the server.
      if (/401/.test(e.message)) { console.error(`\n✗ ${e.message}`); break; }
    }
    if ((i + 1) % 25 === 0 || i + 1 === toMigrate.length) {
      process.stdout.write(`\r  ${i + 1}/${toMigrate.length}  (inserted ${inserted}, duplicate ${duplicate}, failed ${failed})`);
    }
  }
  process.stdout.write('\n');

  console.log(`\nDone: ${inserted} inserted, ${duplicate} already present, ${failed} failed.`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures.slice(0, 20)) console.log(`  - memory ${f.id}: ${f.error}`);
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
    process.exit(1);
  }
}

main().catch((e) => fail(e.message));
