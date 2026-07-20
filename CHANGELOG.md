# Changelog

## 2.4.0

### Features

- **Opt-in bidirectional memory sync across machines and team members.**
  Share the memory database between computers through the same rclone remote
  used for backups - without file-level sync (which would be last-writer-wins
  and destroy concurrent work). Each device appends only its own changelog
  files (`<sync.remote>/<deviceId>/<seq>.jsonl.gz`), so there are no write
  conflicts by construction; reconciliation is set-union on `content_hash`
  plus tombstones for deletions. `cortex_delete`, `cortex_update`, and
  `cortex_forget_project` now record tombstones so deletions propagate and
  deleted content is never re-imported. Configure `sync.remote` (e.g.
  `"gdrive:cortex-sync"`) and `sync.enabled` in `~/.cortex/config.json`; the
  daemon runs the schedule (`sync.intervalMinutes`, default hourly) via a new
  `POST /sync` endpoint, or run `node dist/index.js sync` manually
  (`--push`/`--pull`/`--status`). Optional `sync.projects` allowlist limits
  which projects are pushed (e.g. for team sharing). All devices must use the
  same embedding model. Schema migration adds `memories.origin_device` and a
  `sync_tombstones` table automatically.

### Bug Fixes

- **Stub out the `sharp` native dependency (fixes hooks crashing after plugin
  install).** `@xenova/transformers` imports `sharp` unconditionally for its
  image pipelines, but cortex only ever uses text embeddings. The real `sharp`
  needs a native libvips binding whose install script plugin installs often
  skip (`--ignore-scripts`), leaving every cortex hook/command crashing with
  `Cannot find module '../build/Release/sharp-linux-x64.node'`. An npm
  `overrides` entry now replaces `sharp` with a bundled no-op stub
  (`vendor/sharp-stub`) that satisfies the import with no native build. Text
  embeddings are unaffected; anything that would actually process an image
  throws a clear "not supported" error instead.

## 2.3.0

### Features

- **Opt-in remote backup (Google Drive & any rclone remote).** Periodic gzip
  snapshots of the database uploaded to an rclone remote with configurable
  rotation. Configure `backup.remote` (e.g. `"gdrive:cortex-backups"`) and
  `backup.enabled` in `~/.cortex/config.json`; requires `rclone` on PATH with
  a configured remote. In daemon mode the daemon runs the schedule
  (`backup.intervalMinutes`, default daily) via a new `POST /backup` endpoint
  and hands off a due backup on shutdown to a detached child. Without a
  daemon, run `node dist/index.js backup` manually (`--status` shows the last
  backup). Snapshots are consistent regardless of backend: `VACUUM INTO` on
  native/WAL, in-memory export on sql.js. Old remote snapshots beyond
  `backup.keep` (default 7) are rotated out. State: `~/.cortex/backup-state.json`.

## 2.2.0

### Features

- **Opt-in shared daemon mode.** One local HTTP server (127.0.0.1, default port
  4983) holds the database and embedding model for ALL Claude Code sessions,
  instead of every session loading its own copy. When `daemon.enabled` is true,
  the stdio MCP server becomes a thin proxy and hooks/statusline become thin
  HTTP clients. Classic per-session mode remains the default and is unchanged.
  Enable with `configure daemon on` (or during `/cortex-setup`). Measured on a
  690MB database: 8 sessions went from ~6.2GB resident to a single shared daemon.
- **Optional native storage backend (daemon only).** The daemon prefers
  better-sqlite3 (real file-backed SQLite with WAL journaling): the database is
  read page-on-demand through the OS cache instead of living in process memory,
  and each write is a small transaction instead of a full-file rewrite. Falls
  back to sql.js automatically when better-sqlite3 is unavailable
  (`optionalDependencies`; run `npm rebuild better-sqlite3` in the plugin
  directory if the native build was skipped). Same database file format - no
  migration. Measured: daemon anonymous RSS dropped from ~780MB to ~20MB.
- **Daemon auto-update.** Clients compare their build version against the
  daemon's `/health` version and replace an outdated daemon automatically after
  a plugin update.
- **Database compaction.** New `compact` command (and daemon `POST /compact`)
  prunes restoration bookkeeping and VACUUMs. Memories are NEVER deleted unless
  `--prune-days=N` is passed explicitly.
- **New commands:** `configure daemon on|off|status`, `ensure-daemon`,
  `daemon-status`, `daemon-stop`, `compact`, `setup --daemon`.

### Bug Fixes

- Fix `closeDb()` leaving a cached closed handle: reopening the database after
  close now returns a fresh connection.
- Single-writer daemon eliminates the multi-session lost-update hazard on
  concurrent saves; archive operations are serialized in a queue.
- Statusline/hook processes no longer load, back up, and rewrite the entire
  database on every render in daemon mode.
- Version is now injected from package.json at build time (removes the stale
  `serverInfo.version` release-checklist step).

## 2.1.4

### Bug Fixes

- **Fix orphaned temp files leaking disk space (~37GB observed).**
  Atomic writes (`writeFileSync` → `renameSync`) left behind `memory.db.tmp.*`
  files when processes were killed (SIGTERM) between the write and rename.
  Added signal handlers (SIGTERM/SIGINT/SIGHUP) to clean up in-progress temp
  files, and startup cleanup to remove orphaned temp files from dead processes.

- **Fix `process.exit(1)` skipping `finally { closeDb() }` in main error handler.**
  Changed to `process.exitCode = 1` so the database is properly closed on errors.

- **Fix MCPResponse type to allow `null` id per JSON-RPC 2.0 spec.**
  Parse error responses must use `id: null` when the request ID is unknown.

## 2.1.3

### Bug Fixes

- **MCP server: ignore JSON-RPC notifications instead of sending invalid responses.**
  After the `initialize` handshake, Claude Code sends a `notifications/initialized`
  message (a JSON-RPC notification with no `id` field). The server incorrectly
  treated this as a request, responded with an error containing `id: undefined`,
  and caused Claude Code to drop the STDIO connection ("1 MCP server failed").
  Notifications are now silently ignored as required by the JSON-RPC 2.0 spec.
