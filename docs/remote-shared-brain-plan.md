# Cortex Remote Shared-Brain Adapter — Implementation Plan

Branch: `claude/plugin-remote-server-adapter-25px4k`.

## Implementation status

- ✅ **A. Identity module** (`src/identity.ts`) — user/project/environment resolution.
- ✅ **B. Config layering** (`src/config.ts`) — project-root `.cortex/`, env overrides, remote helpers.
- ✅ **C. Schema + migration** — `user`/`environment`/`category` columns, write stamping.
- ✅ **C1. Category-aware recall** — `buildScopeClause`, `cortex_recall` `scope` param (default `auto`).
- ✅ **E/F. Remote transport + auth** — `remote` mode in `daemon-client.ts`, server mode in
  `daemon.ts` (`daemon-auth.ts`: bind `0.0.0.0` under `CORTEX_SERVER`, `CORTEX_SERVER_TOKEN`
  bearer auth), proxy wiring in `mcp-server.ts`, local-ownership assumptions neutralized.
- ✅ **Remote transcript archive** — `parseTranscriptContent` + `archiveSession({transcriptContent,
  identity})`; the MCP proxy uploads transcript content and injects client identity so
  `cortex_save`/`cortex_archive` work over remote with correct attribution. All content-based ops
  work over remote today.
- ⬜ **D. Sync changelog identity fields** — carry `user`/`environment` across devices (follow-up).
- ⬜ **Hook paths over remote** — auto-recall/statusline/auto-archive hooks still gate on
  `daemon.enabled`; routing them through remote is a follow-up (MCP tool surface already works).

---

## Goal

Let Cortex optionally point every Claude Code session — across machines, WSL,
and Claude-on-web — at **one shared memory backend** ("shared brain"), while
keeping the current **local sql.js backend as the default**. Add identity
columns (`user`, `project`, `environment`) so memories know who/where they
came from, resolve config from a project-root `.cortex/` folder, and take all
authentication from **environment variables only**.

## Design decisions (settled)

- **Local is the default.** Remote is opt-in via `remote.enabled` + `remote.url`.
- **`project`**: explicit stable name from `.cortex/config.json`; fall back to
  cwd basename (today's `getProjectId`).
- **`user`**: `CORTEX_USER` env → `.cortex`/global config → **OS username**.
- **`environment`**: dynamic. `CORTEX_ENVIRONMENT` env → config → auto-detect
  (`claude-web` / `<user>-wsl` / `<user>-<platform>`).
- **`category`**: generalization axis chosen per-write —
  `global` | `user` | `environment` | `project` (default `project`). Drives
  automatic recall scoping; overridable via a `scope` arg on `cortex_recall`.
- **Auth**: `CORTEX_REMOTE_TOKEN` env only. Never persisted to any config file.
- **Config precedence**: env vars > project `./.cortex/config.json` > global
  `~/.cortex/config.json` > defaults.
- **Data location**: DB stays at `~/.cortex/memory.db` (local mode) or on the
  remote. The project `.cortex/` folder holds **config only**, never the DB.

---

## Work breakdown

### A. Identity module — new `src/identity.ts`

Single source of truth for the three identity values. Pure, dependency-light,
importable by hooks, tools, archive, and sync.

```ts
resolveUser(cfg): string            // CORTEX_USER → cfg.identity.user → os.userInfo().username
resolveProject(cwd, cfg): string    // cfg.project (project file) → getProjectId(cwd)
resolveEnvironment(cfg): string     // CORTEX_ENVIRONMENT → cfg.identity.environment → auto
```

Auto-detect for `environment`:
1. `claude-web` — detect the remote-container signature (env markers present in
   Claude Code on the web); pin as `claude-web`.
2. WSL — `/proc/version` contains `microsoft` (case-insensitive) → `<user>-wsl`.
3. else → `<user>-<platform>` where platform ∈ {`windows`,`macos`,`linux`}.

`getProjectId` (`src/stdin.ts:134`) stays as the basename fallback used by
`resolveProject`.

`category` is not resolved here — it is chosen per-write (default `project`),
not derived from the environment. See §C1.

### B. Config layering — `src/config.ts`

1. `getProjectConfigDir(cwd)`: walk up from `cwd` looking for a `.cortex/`
   directory; return its path or null. (Stops at filesystem root / home.)
2. `loadConfig(cwd?)`: today it reads only `~/.cortex/config.json`. New order,
   deep-merged, later wins:
   `defaults` → global file → project file (`<projectDir>/.cortex/config.json`)
   → env overrides. Existing Zod validation runs on the merged result.
3. New config shape (all optional, additive to the current schema):
   ```jsonc
   {
     "identity": { "user": null, "environment": null },  // usually null → resolved
     "project": null,                                     // project file sets this
     "remote": { "enabled": false, "url": null }          // token NEVER here
   }
   ```
4. Env overrides applied last: `CORTEX_REMOTE_URL`, `CORTEX_USER`,
   `CORTEX_ENVIRONMENT` (token is read at request time, not merged into config).
5. `.gitignore` guidance in docs: `.cortex/` is safe to commit **because** no
   secrets live in it; teams commit it to share `project` + `remote.url`.

### C. Schema + migration — `src/database.ts`

Additive `ALTER TABLE`, mirroring the existing `origin_device` migration
(`database.ts:482`), guarded by a "column exists?" check:

```sql
ALTER TABLE memories ADD COLUMN user TEXT;
ALTER TABLE memories ADD COLUMN environment TEXT;
ALTER TABLE memories ADD COLUMN category TEXT DEFAULT 'project';
-- `project`: reuse existing project_id column; expose as `project` in the
-- query/return layer. (No destructive rename in v1 to keep sql.js/native and
-- old DBs compatible.)
```

Old rows keep `NULL` (treated as "legacy/unknown"; NULL category behaves as
`project`). Indexes on `(user)`, `(environment)`, `(project_id)`, `(category)`
for filtered recall.

Write paths that must stamp the new values:
- `storeManualMemory` (`cortex_remember`) — also accepts a `category` enum
- `archiveSession` / `appendSessionTurns` (`src/archive.ts`) — default `project`
- sync import `applyLines` (`src/sync.ts`) — carry origin identity + category,
  don't overwrite with the importer's identity.

Read paths (`searchByVector`, `searchByLike`, `hybridSearch` in `src/search.ts`,
`database.ts`) gain optional filters `{ user?, environment?, project? }` **and**
category-aware scoping (see §C1).

### C1. `category` — generalization axis / smart-scoped recall

`user`/`project`/`environment` record **who/where** a memory came from.
`category` records **where the knowledge is true**, which lets recall widen or
narrow automatically:

| `category` | Holds across | Recall scopes by | Example |
|-----------|--------------|------------------|---------|
| `global` | everything | *(no filter)* | "user prefers conventional commits" |
| `user` | all machines & projects | `user` | "reviews PRs before merging" |
| `environment` | all projects on that machine/context | `environment` | "WSL: node-gyp needs python3 symlink" |
| `project` *(default)* | this codebase | `project` | "build runs build:daemon via esbuild" |

**Default recall = a union each category self-selects into**, given the
session's resolved identity:

```sql
WHERE category = 'global'
   OR (category = 'user'        AND user        = :user)
   OR (category = 'environment' AND environment = :environment)
   OR (category IN ('project') OR category IS NULL) AND project = :project
```

A session sees: everything global + its user prefs + this machine's environment
lore + this project's specifics — never another project's internals.

**Explicit override** on `cortex_recall` via a `scope` arg for deliberate
widen/narrow:
- environment bug → `scope: 'environment'` drops the project constraint →
  cross-project fixes for that machine.
- tight focus → `scope: 'project'` → project rows only.

`category` is plain `TEXT` — vocabulary stays extensible without migration.

### D. Sync changelog — `src/sync.ts`

`AddLine` gains `u` (user) and `env` (environment) fields so imported memories
retain origin identity across devices. `applyLines` writes them through.
Backward compatible: absent fields → `NULL`. (Still gated behind existing
`content_hash` set-union; no protocol-breaking change.)

### E. Remote transport (the adapter) — `src/daemon-client.ts` + `src/daemon.ts`

Introduce a third mode alongside `local` and `daemon`: **`remote`**.

Client (`daemon-client.ts`):
- `getDaemonBaseUrl()` → `getBackendBaseUrl()`: returns `remote.url` when
  `remote.enabled`, else `http://127.0.0.1:<port>`.
- Every request adds `Authorization: Bearer ${process.env.CORTEX_REMOTE_TOKEN}`
  when in remote mode. Missing token → throw a clear error (no fallthrough).
- In remote mode, **disable** process lifecycle: no `spawnDaemonDetached`, no
  `stopDaemon`, no version takeover — you don't own the server. `ensureDaemon`
  becomes a no-op (assume-up) for remote; a failed request surfaces as an error
  / silent-skip depending on caller (auto-recall stays silent).

Server (`daemon.ts`):
- Bind `0.0.0.0` when started in server mode (`CORTEX_SERVER=1` or a
  `--server` flag); keep `127.0.0.1` default for the local daemon.
- Auth middleware on **every** route: compare `Authorization` bearer against
  `CORTEX_SERVER_TOKEN` env; 401 on mismatch. Health may stay unauthenticated
  (version handshake) but returns no data.
- Trust identity from the authenticated request context; still accept per-write
  `user`/`environment`/`project` in the MCP payload (the client already knows
  them via the identity module).
- TLS terminated by a reverse proxy (documented), or optional built-in.

The wire protocol (`POST /mcp`, `/recall`, `/stats`, `/restore`, `/archive`)
is unchanged — remote reuses it verbatim.

### F. Neutralize "I own the daemon" assumptions

- `mcp-server.ts:38` fallback-to-local: in remote mode there is no local file;
  unreachable remote → return an MCP error, never `initDb()`.
- `index.ts` auto-recall (`~970`): already skips silently when the daemon is
  down in daemon mode; extend the same silence to remote mode.
- Version takeover (`daemon.ts:483-517`): only applies to the localhost daemon.
  Remote never triggers it.

### G. Docs + config surfaces

- `CLAUDE.md`: new "Remote shared brain" section (modes, env vars, `.cortex/`
  layering, identity columns).
- `README` / setup skill: env-var list — `CORTEX_REMOTE_TOKEN`,
  `CORTEX_REMOTE_URL`, `CORTEX_USER`, `CORTEX_ENVIRONMENT`, `CORTEX_SERVER`,
  `CORTEX_SERVER_TOKEN`.
- Server deployment note: Docker image running `dist/daemon.js --server` with
  `better-sqlite3` (native WAL) for safe concurrent multi-session access.

---

## Env var reference

| Var | Side | Purpose |
|-----|------|---------|
| `CORTEX_REMOTE_URL` | client | Shared-brain base URL (or set in `.cortex/config.json`). |
| `CORTEX_REMOTE_TOKEN` | client | Bearer auth. **Env only.** |
| `CORTEX_USER` | client | Override user identity (else OS username). |
| `CORTEX_ENVIRONMENT` | client | Override environment label (else auto). |
| `CORTEX_SERVER` | server | Run daemon in public server mode (bind 0.0.0.0). |
| `CORTEX_SERVER_TOKEN` | server | Expected bearer token; rejects mismatches. |

## Backward compatibility & rollout

- Nothing above changes default behavior: no `remote.enabled`, no env, no
  `.cortex/` folder → identical to today (local sql.js).
- Schema migration is additive; old DBs open unchanged.
- Sync changelog additions are optional fields; mixed-version peers interop.

## Suggested build order

1. `identity.ts` + config layering (B, A) — no behavior change yet.
2. Schema migration + stamp writes + filtered reads (C) — populate columns
   locally.
3. Sync changelog fields (D).
4. Remote transport + auth + server mode (E, F).
5. Docs (G).

Each step is independently testable and shippable.
