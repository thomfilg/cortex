# Cortex HTTP Daemon — Opt-in Shared-Server Mode

**Goal:** Add an **optional** daemon mode where N concurrent Claude Code instances share one database + one embedding model, instead of each loading their own. **The current per-instance stdio mode stays the default and is unchanged** — daemon mode is a config toggle (`daemon.enabled`), off by default.

**Status:** Phases 1–2 implemented (2026-07-20): `src/tools.ts`, `src/daemon.ts`, `src/daemon-client.ts`, `src/version.ts`, proxy mode in `mcp-server.ts`, daemon branches in `index.ts` hooks/statusline, setup/configure integration, auto-update version handshake. Pending: `build:daemon` script in package.json (file is write-protected). Phase 3 not started.

---

## 1. Measured evidence (why this matters)

Measured on this machine while ~11 Claude sessions were running:

| Metric | Value |
|---|---|
| `mcp-server.js` processes | **8** |
| Total RSS of those processes | **6.2 GB** (~780 MB avg each; max 1.27 GB) |
| `~/.cortex/memory.db` size | **690 MB** |
| `~/.cortex/backups/` size | **6.9 GB** (backups created 255 ms apart) |
| Stray `~/.cortex/auto-save-state.zip` | **3 GB** (from March — dead weight) |
| Claude CLI processes themselves | 3.6 GB (11 procs — *not* fixable by cortex) |

### Root causes (all three, not just the MCP server)

1. **Per-instance stdio server, eager DB load.** `.mcp.json` spawns `node dist/mcp-server.js` per Claude instance. `main()` calls `initDb()` eagerly at spawn (`src/mcp-server.ts:871-873`) — before any tool is used. sql.js loads the **entire 690 MB DB file into WASM memory**, so every instance pays ~700 MB+ just for cortex to exist. Instances that call a tool also load the ONNX embedding model (+~400 MB → the 1.27 GB process).

2. **Statusline/hook I/O storm.** Claude runs the statusline command after every assistant message (300 ms debounce). Each render spawns `node dist/index.js statusline`, which:
   - `initDb()` → reads 690 MB + copies into WASM (~1.4 GB transient RSS) — `src/index.ts:216`
   - `createBackupOnStartup()` → **copies the 690 MB file to backups/** — `src/database.ts:108,183`
   - on exit, `closeDb()` in `main()`'s `finally` → `saveDb()` **re-exports and rewrites the entire 690 MB DB** — `src/index.ts:159`, `src/database.ts:536-542`

   Across ~11 sessions this is GBs of disk writes per minute on WSL2. The backup dir (backups 255 ms apart) proves the churn. This is likely as much of the system slowdown as the resident RAM.

3. **Multi-writer hazard.** 8+ processes each hold a full in-memory DB copy and write the whole file back on save. Concurrent saves are last-writer-wins **lost updates**. The recent atomic-write/temp-file fixes (commits `a75f5af`, `3bba2fd`) treat the symptom; a single-writer daemon removes the cause.

### One piece of good news

The MCP server has **zero dependence on per-instance cwd**. Scoping comes from explicit `projectId` tool params and the shared `~/.cortex/sessions.json` (written by hooks). `getProjectId` is imported in `mcp-server.ts` but never used by any handler. → **A shared daemon is a drop-in for the MCP surface; no tool API changes needed.**

---

## 2. What Claude Code supports (verified against official docs)

| Question | Answer |
|---|---|
| Stateless Streamable HTTP (no `Mcp-Session-Id`) | ✅ Sufficient — POST returning `application/json`; no GET/SSE stream required |
| Auth on localhost | ✅ None required |
| Statusline cadence | After each assistant message, 300 ms debounce (confirms the I/O storm multiplier) |
| Prior art for shared local MCP daemons | None documented — lifecycle glue (pidfile, health, version handshake) is custom |

Key enabler in the existing code: the hand-rolled JSON-RPC layer (`src/mcp-server.ts:717-865`) is already transport-agnostic — `handleRequest(request) → response`. It lifts straight onto `http.createServer`.

> Note: Claude Code also supports `{"type": "http"}` directly in a plugin's `.mcp.json`, which would remove even the proxy process — but it's a static file, so it can't be a per-user opt-in. The proxy design below keeps stdio as the transport Claude Code sees, making daemon mode a pure config toggle. The `.mcp.json` flip remains a possible future default once daemon mode is proven.

---

## 3. Target architecture (opt-in)

```
DAEMON MODE OFF (default — today's behavior, unchanged):

Claude #N ──stdio── mcp-server.js (full local mode: own DB copy + model)
statusline/hooks ── node dist/index.js (local DB load, as today)

DAEMON MODE ON (config: daemon.enabled = true):

Claude #1 ──stdio── mcp-server.js [PROXY ~50MB] ──HTTP──┐
Claude #2 ──stdio── mcp-server.js [PROXY ~50MB] ──HTTP──┤
...                                                     ├── cortex daemon (ONE process)
Claude #8 ──stdio── mcp-server.js [PROXY ~50MB] ──HTTP──┤    127.0.0.1:4983
                                                        │    ├─ POST /mcp      (MCP JSON-RPC)
statusline ── thin HTTP client (~40MB, no DB I/O) ──────┤    ├─ GET  /health   (version, pid)
hooks ── thin HTTP clients ─────────────────────────────┘    ├─ GET  /stats    (statusline)
                                                             ├─ POST /restore
The proxy auto-starts the daemon if it's not running,        ├─ POST /archive  (queued, deduped)
so there is NO startup race. If the daemon can't start,      └─ POST /shutdown
the proxy falls back to full local mode (today's behavior).  │
                                                             1 × sql.js DB + 1 × ONNX model
                                                             single writer → ~/.cortex/memory.db
```

---

## 4. The plan

### Phase 1 — daemon + proxy mode (core)

1. **Config:** add `daemon: { enabled: false, port: 4983 }` to the config schema (`src/types.ts`, `src/config.ts` Zod schema + defaults). Port precedence: `CORTEX_PORT` env > `config.daemon.port` > 4983. Add `~/.cortex/daemon.json` `{pid, port, version, startedAt}` helpers.

2. **`src/tools.ts` (new):** move `TOOLS` + all `handle*` tool functions + the JSON-RPC dispatch out of `src/mcp-server.ts` (`:58-865`). They are already pure `(db, params)` functions — pure extraction, shared by stdio server and daemon. Centralize `VERSION` (import from `package.json` at build time — also removes the "stale version in mcp-server.ts" release-checklist pain).

3. **`src/daemon.ts` (new entry → `dist/daemon.js`):**
   - `http.createServer` bound to `127.0.0.1:<port>`.
   - `POST /mcp` — reuse the shared JSON-RPC dispatch. Notifications (no `id`) → `202`. Responses `Content-Type: application/json`. Hand-rolled transport (~60 lines, zero new deps, matches codebase style).
   - `GET /health` → `{ name, version, pid, uptime, fragments }`.
   - Internal REST for hooks/statusline: `GET /stats?projectId=`, `POST /restore`, `POST /archive` (accepts `async: true` → `202` immediately, work queued), `POST /shutdown`.
   - **Singleton protocol:** on `EADDRINUSE` → `GET /health` of the occupant. Same version → exit 0 quietly. Version mismatch (plugin was updated) → `POST /shutdown`, retry bind. Write `daemon.json` after successful listen.
   - **Archive queue:** one promise-chain serializes archive ops — concurrency becomes *correct*, replacing the file-lock dance in `src/config.ts:634-678` (which stays for the non-daemon path).
   - Graceful shutdown: SIGTERM/SIGINT → `closeDb()` (saves) → remove `daemon.json` → exit (override the exit-only handlers registered by `database.ts`).
   - `package.json`: add `build:daemon` esbuild target (same externals).

4. **`src/mcp-server.ts` becomes mode-aware (no `.mcp.json` change):**
   - `daemon.enabled === false` (default) → **identical to today**: local `initDb()`, stdio JSON-RPC.
   - `daemon.enabled === true` → **proxy mode**: never calls `initDb()`/embedder. Ensures the daemon is running (spawn `dist/daemon.js` detached+unref, poll `/health` ≤ 10 s — DB load takes a few seconds), then forwards each stdin JSON-RPC line as `POST /mcp` and prints the response. If the daemon cannot be started → **fall back to full local mode** so nothing ever breaks.

5. **Toggle UX:** `node dist/index.js configure daemon on|off` (+ surface it in the `/cortex-configure` skill). New CLI commands: `ensure-daemon`, `daemon-status`, `daemon-stop`.

### Phase 2 — hooks + statusline over HTTP when daemon mode is on

6. **`handleStatusline` (`src/index.ts:211`):** if daemon enabled → `GET /stats` (~200 ms timeout) instead of `initDb()`; autosave trigger → `POST /archive {async: true}` instead of the inline `archiveSession` (`:239`) / background-save spawn (`:309`). If the daemon is unreachable → render without the fragment count and fire ensure-daemon (never block, never load the DB). Daemon disabled → current code path, byte-for-byte.

7. **Same branching for `post-tool`, `pre-compact`, `session-end`, `session-start`:** daemon on → HTTP endpoints (daemon returns pre-formatted restoration/archive text; client prints); connection failure → legacy local path as fallback. Daemon off → unchanged.

   Result per statusline render in daemon mode: ✂️ 690 MB read + WASM copy + 690 MB backup copy + 690 MB rewrite → a ~40 MB transient node doing one HTTP GET. Backup-on-startup happens once per daemon start (backups become meaningful again).

8. **Release:** non-breaking, opt-in → **v2.2.0** minor. Follow the CLAUDE.md release checklist. Docs: new "Daemon mode (experimental)" section in README + CHANGELOG.

### Phase 3 — getting under 1 GB (recommended follow-up, daemon-mode only)

9. **DB diet.** With sql.js, the 690 MB DB is the daemon's RSS floor. 690 MB of memories smells like the 5%-context-step autosave across ~11 parallel sessions generating near-duplicate fragments (plus `session_turns` bloat). Audit composition; add retention/compaction policy.

10. **Swap daemon storage to `better-sqlite3`.** A single-writer daemon makes a native dep + WAL feasible. File-backed paging means the DB no longer lives in RAM, FTS5 is guaranteed, and the daemon lands ~400–600 MB. sql.js stays for the default (non-daemon) mode.

11. **Debounced persistence in the daemon:** batch `saveDb()` (dirty flag + short timer + on shutdown) so each remember/archive doesn't rewrite 690 MB.

12. **Housekeeping (today, no code):** delete ~6.9 GB `~/.cortex/backups` churn + the 3 GB `auto-save-state.zip` → ~10 GB disk reclaimed.

---

## 5. Expected numbers

| | Daemon OFF (today / default) | Daemon ON (Phase 1–2) | Daemon ON (Phase 3) |
|---|---|---|---|
| Resident cortex RSS (8 sessions) | **6.2 GB** (8 × ~780 MB) | **~1.6 GB** (8 × ~50 MB proxy + 1.2 GB daemon) | **~0.9 GB** |
| Per statusline render | ~1.4 GB transient + ~1.4 GB disk I/O | ~40 MB, one HTTP GET | same |
| Per Claude instance | ~780 MB | ~50 MB (thin proxy) | ~50 MB |
| Data-loss risk | last-writer-wins across N writers | single writer, queued | single writer + WAL |

*Honesty note:* the Claude CLI processes themselves (3.6 GB for 11) are untouched by any of this.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Startup race | **Eliminated by the proxy design** — the proxy brings the daemon up before forwarding; Claude Code only ever sees a working stdio server |
| Daemon can't start (port blocked, etc.) | Proxy falls back to full local mode; hooks fall back to legacy path — worst case is today's behavior |
| Localhost exposure: any local process can query memories | Bind 127.0.0.1 only; optional bearer token later if needed |
| Multi-user machine: fixed port clash → cross-user daemon | Per-user `CORTEX_PORT` |
| Version skew: old daemon serving after plugin update | `/health` version handshake → new spawn tells old daemon to shut down and takes over |
| Daemon crash mid-session | Proxy health-checks per request-failure and respawns; stateless HTTP self-heals |
| Regression risk for default-mode users | Default path is untouched by design; daemon logic is additive branches + new files |

---

## 7. Suggested PR breakdown

- **PR 1 (Phases 1–2):** config toggle, `src/tools.ts` extraction, `src/daemon.ts`, proxy mode in `mcp-server.ts`, thin hook/statusline branches, build target, v2.2.0 release notes.
- **PR 2 (Phase 3):** retention/compaction, `better-sqlite3` daemon backend, debounced saves.
- **Now, no PR:** delete `~/.cortex/backups/*` bloat + `auto-save-state.zip` (~10 GB disk).
