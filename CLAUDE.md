# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Cortex is a Claude Code plugin that provides persistent local memory with cross-session recall. It uses vector embeddings and hybrid search to store and retrieve meaningful context from past sessions.

**Key Features:**
- Automated context management with configurable thresholds
- Smart compaction: save, clear, and restore continuity
- MCP server exposing memory tools to Claude
- Session analytics and insights
- Colored statusline with progress bar
- Granular memory saving with `cortex_remember`

## Build Commands

```bash
npm install            # Install dependencies
npm run build          # Build both index.js and mcp-server.js
npm run build:index    # Build main entry point only
npm run build:mcp      # Build MCP server only
npm run typecheck      # Type check without emitting

# Test with sample stdin data
echo '{"cwd":"/home/user/project","context_window":{"used_percentage":45}}' | node dist/index.js stats
```

## Architecture

### Data Flow

```
Claude Code → stdin JSON → parse → command router → handler → stdout
                                        ↓
                               SQLite + Embeddings
                                        ↓
                              ~/.cortex/memory.db

MCP Client → JSON-RPC → mcp-server.js → tools → database
```

### Core Components

| File | Purpose |
|------|---------|
| `src/index.ts` | Command router and handlers |
| `src/mcp-server.ts` | MCP server exposing tools |
| `src/stdin.ts` | Parse Claude Code's JSON input |
| `src/types.ts` | TypeScript interfaces |
| `src/database.ts` | SQLite schema, queries, FTS5 |
| `src/embeddings.ts` | BGE model loading, vector generation |
| `src/search.ts` | Hybrid search (vector + keyword + RRF) |
| `src/archive.ts` | Transcript parsing, content extraction, restoration context |
| `src/config.ts` | Configuration management |
| `src/analytics.ts` | Session tracking and insights |

### Database Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT UNIQUE,
  embedding BLOB NOT NULL,
  project_id TEXT,
  source_session TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content);
```

### Search Algorithm

1. **Vector Search**: Query embedding vs stored embeddings (cosine similarity)
2. **Keyword Search**: FTS5 full-text search on content
3. **RRF Fusion**: Reciprocal Rank Fusion with k=60
4. **Recency Decay**: 7-day half-life for time weighting
5. **Result**: Top 5 sorted by combined score

### Stdin Format (Claude Code)

The plugin receives JSON via stdin from Claude Code:

```json
{
  "cwd": "/path/to/project",
  "transcript_path": "/path/to/session.jsonl",
  "model": {
    "id": "claude-opus-4-5-20251101",
    "display_name": "Opus"
  },
  "context_window": {
    "context_window_size": 200000,
    "used_percentage": 45
  }
}
```

## Plugin Structure

```
cortex/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata
├── .mcp.json            # MCP server configuration
├── skills/
│   ├── cortex-setup/SKILL.md     # Setup wizard (/cortex-setup)
│   ├── cortex-configure/SKILL.md # Configuration (/cortex-configure)
│   └── cortex-manage/SKILL.md    # Memory management (/cortex-manage)
├── hooks/
│   └── hooks.json       # SessionStart, PostToolUse, PreCompact
├── src/                 # TypeScript source
├── dist/
│   ├── index.js         # Compiled entry point
│   ├── mcp-server.js    # MCP server
│   └── sql-wasm.wasm    # SQLite WebAssembly
└── package.json
```

## MCP Tools

The MCP server exposes these tools:

| Tool | Purpose | Permission |
|------|---------|------------|
| `cortex_recall` | Search memory | Read-only |
| `cortex_remember` | Save specific insight/decision | Safe |
| `cortex_save` | Archive session (alias: cortex_archive) | Safe |
| `cortex_archive` | Archive session (canonical name) | Safe |
| `cortex_stats` | Get statistics | Read-only |
| `cortex_restore` | Get restoration context | Read-only |
| `cortex_update` | Update memory content or project | Safe |
| `cortex_rename_project` | Bulk move memories to new project | Safe |
| `cortex_delete` | Delete memory fragment | **Requires confirmation** |
| `cortex_forget_project` | Delete project memories | **Requires confirmation** |
| `cortex_analytics` | Get usage analytics | Read-only |

### Key Tool Distinction

- **`cortex_remember`**: Save a specific fact/decision during conversation. Does NOT require transcript path. Use for granular saving.
- **`cortex_save`/`cortex_archive`**: Archive entire session. Requires transcript path. Use for bulk session backup.

## Skills (User-Invocable Commands)

Skills are for multi-step workflows. Atomic operations (stats, recall, save) use MCP tools directly.

| Skill | Command | Purpose |
|-------|---------|---------|
| cortex-setup | `/cortex-setup` | First-time initialization |
| cortex-configure | `/cortex-configure` | Adjust settings |
| cortex-manage | `/cortex-manage` | Delete/manage memories |

## Hooks

| Hook | Trigger | Handler | Purpose |
|------|---------|---------|---------|
| `UserPromptSubmit` | Each user prompt | `auto-recall` | Inject relevant memories (opt-in) |
| `SessionStart` | New session | `session-start` | Show memory count, start analytics |
| `PostToolUse` | After any tool | `context-check` | Monitor context, auto-save/clear |
| `PreCompact` | Before compaction | `smart-compact` | Save + restoration context |

### Auto-Recall (opt-in)

When `recall.auto` is true, the `UserPromptSubmit` hook vector-searches the
archive for fragments semantically related to the prompt and injects the top
matches (project-scoped) as context. Relevance is gated on raw cosine
similarity — NOT the RRF rank scores used by `cortex_recall`, which are
nearly flat across ranks and cannot express "nothing relevant". Injected
fragment ids are deduplicated per session (`~/.cortex/recall-state.json`,
pruned to the 20 most recent sessions). Prompts that are too short, slash
commands, or `!` shell escapes are skipped.

Enable with `node dist/index.js configure recall on` (`off`, `status`).
Daemon mode is recommended: with a daemon the search is one HTTP call to
`POST /recall`; without one each prompt loads the embedding model
in-process. In daemon mode there is deliberately NO local fallback when the
daemon is unreachable or predates `/recall` (a native/WAL database must not
be opened by sql.js mid-flight) — the hook stays silent instead.

`recall` config keys: `auto` (default false), `minScore` (default 0.62,
calibrated on a real archive: related prompts scored 0.67–0.69, off-topic
0.53–0.54), `maxResults` (3), `tokenBudget` (500), `minPromptLength` (12).

## Configuration

Config file: `~/.cortex/config.json`

```json
{
  "statusline": {
    "enabled": true,
    "showFragments": true,
    "showLastArchive": true,
    "showContext": true,
    "contextWarningThreshold": 70
  },
  "archive": {
    "autoOnCompact": true,
    "projectScope": true,
    "minContentLength": 50
  },
  "monitor": {
    "tokenThreshold": 70
  },
  "automation": {
    "autoSaveThreshold": 70,
    "autoClearThreshold": 80,
    "autoClearEnabled": false,
    "restorationTokenBudget": 1000,
    "restorationMessageCount": 5
  },
  "setup": {
    "completed": true,
    "completedAt": "2024-01-15T10:30:00Z"
  },
  "awareness": {
    "enabled": false,
    "userName": null,
    "timezone": null
  },
  "backup": {
    "enabled": false,
    "remote": null,
    "intervalMinutes": 1440,
    "keep": 7
  },
  "sync": {
    "enabled": false,
    "remote": null,
    "intervalMinutes": 60,
    "projects": null
  },
  "recall": {
    "auto": false,
    "minScore": 0.62,
    "maxResults": 3,
    "tokenBudget": 500,
    "minPromptLength": 12
  }
}
```

### Automation Settings

- `autoSaveThreshold`: Context % to trigger auto-save (default: 70)
- `autoClearThreshold`: Context % to trigger auto-clear (default: 80)
- `autoClearEnabled`: Enable automatic context clear (default: false)
- `restorationTokenBudget`: Max tokens for restoration context (default: 1000)
- `restorationMessageCount`: Messages to restore after clear (default: 5)

### Remote Backup Settings

Opt-in gzip snapshots of the database uploaded to an rclone remote (Google
Drive, S3, Dropbox, ...). Requires `rclone` on PATH with a configured remote
(`rclone config`).

- `backup.enabled`: enable scheduled backups — the daemon runs the schedule (default: false)
- `backup.remote`: rclone remote path, e.g. `"gdrive:cortex-backups"` (default: null)
- `backup.intervalMinutes`: minutes between scheduled backups (default: 1440 = daily)
- `backup.keep`: remote snapshots to retain; older rotated out (default: 7)

Manual: `node dist/index.js backup` (`--status` shows last-backup info).
With a daemon running, backups route through its `POST /backup` endpoint
(consistent `VACUUM INTO` snapshot serialized behind other writes); without
one, the CLI snapshots the file directly. On daemon shutdown a due backup is
handed to a detached `backup --if-due` child. State: `~/.cortex/backup-state.json`.

### Memory Sync Settings

Opt-in bidirectional sync of memories between machines/team members through
a shared rclone remote. NOT file-level DB sync (that would be
last-writer-wins): each device appends only its own changelog files
(`<sync.remote>/<deviceId>/<seq>.jsonl.gz`); reconciliation is set-union on
`content_hash` plus tombstones for deletions (recorded by `cortex_delete`,
`cortex_update`, `cortex_forget_project`). All devices must use the same
embedding model.

- `sync.enabled`: enable scheduled sync — the daemon runs the schedule (default: false)
- `sync.remote`: shared rclone remote path, e.g. `"gdrive:cortex-sync"` (default: null)
- `sync.intervalMinutes`: minutes between scheduled syncs (default: 60)
- `sync.projects`: allowlist of projects to push, null = all. Pulls are unfiltered.

Manual: `node dist/index.js sync` (`--push`, `--pull`, `--status`). With a
daemon running, sync routes through its `POST /sync` endpoint (writes are
serialized behind other writers); there is NO local fallback while a
pre-sync daemon holds the DB — restart the daemon instead. State (device id,
push watermarks, per-peer applied seq): `~/.cortex/sync-state.json`. Schema:
`memories.origin_device` (NULL = authored locally, pushed; peer id =
imported, never re-pushed) and `sync_tombstones`.

### Remote Shared Brain (adapter)

Opt-in "shared brain": point every session (across machines, WSL, Claude on
the web) at ONE remote Cortex server so all sessions read and write the same
live memory store. Unlike sync (asynchronous rclone changelogs), this is a
single source of truth — every recall reads the live shared DB. **Local mode
stays the default**; remote is off unless configured.

Three backend modes, resolved per call: `local` (default sql.js) → `daemon`
(localhost shared daemon) → `remote` (shared server). Remote wins when
enabled. The remote wire protocol is the daemon's existing HTTP endpoints
(`/mcp`, `/recall`, `/restore`, `/stats`, `/health`), so remote reuses them
verbatim over an authenticated, configurable base URL.

**Client env vars:**
- `CORTEX_REMOTE_URL` — shared brain base URL (also flips remote mode on).
  Alternatively set `remote.enabled`/`remote.url` in config.
- `CORTEX_REMOTE_TOKEN` — bearer token. **Env only, never persisted** — this
  is what keeps a committed project `.cortex/config.json` secret-free.

**Server env vars** (running the shared server, `node dist/daemon.js --server`):
- `CORTEX_SERVER=1` (or `--server`) — bind `0.0.0.0` instead of loopback.
- `CORTEX_SERVER_TOKEN` — expected bearer token; every route except `/health`
  returns 401 without it. The server refuses to start in public mode if this
  is unset (no unauthenticated public brain).

In remote mode the client never spawns, replaces, or shuts down the server
(it is not ours to manage); `ensureDaemon` only probes `/health` and warns on
a version mismatch. There is deliberately NO local fallback when the remote is
unreachable — MCP requests return a clear error rather than silently writing
to a divergent local DB.

**Identity columns** (`memories.user`, `memories.environment`,
`memories.category`; `project` = `project_id`) attribute every memory in the
shared brain. `user`/`project`/`environment` resolve via env > config > auto
(see `src/identity.ts`; environment auto-detects `claude-web` / `<user>-wsl` /
`<user>-<platform>`). `category` (`global`|`user`|`environment`|`project`,
default `project`) is the generalization axis that scopes recall — see below.

**Config layering:** `loadConfig(cwd?)` merges defaults → global
`~/.cortex/config.json` → project-root `./.cortex/config.json` (nearest above
cwd) → env. The project `.cortex/` folder holds config only (never the DB);
teams commit it to share `project` + `remote.url`.

**Attribution over remote:** writes must be attributed to the authoring
machine, not the server. In remote mode the MCP stdio proxy augments
`cortex_remember`/`cortex_save`/`cortex_archive` before forwarding — injecting
the client's resolved `user`/`environment` — and for the archive tools it
resolves the transcript path locally and uploads the transcript CONTENT (the
server can't read the client's disk). The server parses the uploaded content
(`archiveSession` accepts `transcriptContent` + an `identity` override; see
`parseTranscriptContent`). So `cortex_save`/`cortex_archive` and
`cortex_remember`, `cortex_recall`, restore, stats, and management tools all
work fully over remote.

Known limitation: automation hooks (auto-recall, statusline, auto-archive)
still gate on `daemon.enabled`; routing them through remote is a follow-up
(the MCP tool surface already works over remote).

### Category-Scoped Recall

`cortex_recall` accepts a `scope` (`auto`|`project`|`environment`|`user`|
`global`|`all`, default `auto`). `auto` is the smart union: `global` memories
+ this user's + this environment's + this project's, each branch gated by the
session's resolved identity. Explicit modes are pure slices — e.g. `scope:
'environment'` returns this machine's memories across ALL projects (debugging
an environment issue), `scope: 'project'` narrows to the current repo.
`includeAllProjects: true` maps to `all` (whole brain). Legacy rows with NULL
category behave as `project`.

## Setup Flow

On first run:
1. Run `/cortex-setup` to initialize
2. Setup wizard creates `~/.cortex` directory
3. Initializes database and downloads embedding model
4. Configures statusline in `~/.claude/settings.json`
5. Marks setup as complete

After setup:
- Statusline appears in Claude Code (requires restart)
- Use `/cortex-configure` to adjust settings
- Memory tools are available via MCP

## Analytics

Analytics are stored at `~/.cortex/analytics.json` and track:
- Session metrics (peak context, save points, recalls)
- Usage patterns
- Recommendations for optimization

## Dependencies

- **sql.js**: SQLite via WebAssembly (bundled)
- **@xenova/transformers**: ONNX embeddings (external)
- **@anthropic-ai/sdk**: API types (external)

## Release Checklist

1. **Version bump** — update ALL of these files:
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json`
   - (`serverInfo.version` is injected from package.json at build time via
     `--define:__CORTEX_VERSION__` — no source edit needed since v2.2.0)
2. **Verify no stale versions** — `grep -r "OLD_VERSION" package.json .claude-plugin/ src/`
3. **Update CHANGELOG.md** — add entry at top
4. **Build** — `npm run build` (rebuilds dist/ with new version)
5. **Typecheck** — `npx tsc --noEmit`
6. **Commit** — `chore: release vX.Y.Z`
7. **Tag** — `git tag vX.Y.Z`
8. **Push** — `git push && git push --tags`
9. **GitHub release** — `gh release create vX.Y.Z`
   - **Check previous release first**: `gh release view <prev-tag>` and match its format
   - Must include the "Updating from v2.x" section with plugin update commands, setup instructions, restart note, and the marketplace-first warning link
   - Include "Full Changelog" compare link

## Development Notes

- Uses esbuild for bundling with external dependencies
- sql-wasm.wasm must be copied to dist/ during build
- Embedding model is downloaded on first use (~33MB)
- Database is persisted at ~/.cortex/memory.db
- Analytics are stored at ~/.cortex/analytics.json
- Tool Search is handled automatically by Claude Code (activates at 10% context usage)
