---
name: cortex-migrate-remote
description: Migrate local Cortex memories into a remote shared-brain server. Use when the user says "migrate my memories to the remote", "push my local memory to the shared brain", "seed the remote server with my memories", "move ~/.cortex to the remote", or wants a one-time bulk copy of their local memory.db into a remote Cortex server.
allowed-tools: Bash, Read, AskUserQuestion
user-invocable: true
---

# Migrate Local Memories → Remote Shared Brain

One-time bulk copy of the user's **local** Cortex database into a **remote**
shared-brain server. This is a one-off migration to seed a remote brain with
existing history — not an ongoing sync (for continuous replication the user
already has `sync.*` and the remote adapter).

The work is done by `scripts/migrate-local-to-remote.mjs`. Your job is to gather
the connection details, run a **dry-run first**, show the user the plan, then run
the real migration on their confirmation.

## How it works

The script reads every memory from the local `memory.db` and re-saves each into
the remote via the authenticated `cortex_remember` endpoint. The server
re-embeds and **dedups by content hash**, so the migration is **idempotent** —
re-running it skips anything already present.

**Preserved:** content, project, category, user, environment.
**Not preserved** (limitations of the remember tool, tell the user):
- original timestamp → becomes import time (affects recency decay)
- embedding → regenerated server-side from the content
- source_session → not carried over

## Steps

1. **Resolve connection.** The script needs:
   - Remote base URL — `--url` or `CORTEX_REMOTE_URL`
   - Bearer token — `--token` or `CORTEX_REMOTE_TOKEN` (env-only, never persist it
     to a file)
   - Local DB — `--db`, else `CORTEX_DATA_DIR/memory.db`, else `~/.cortex/memory.db`

   If the URL or token is unknown, ask the user (use AskUserQuestion). Never write
   the token into config or commit it.

2. **Dry-run first (always).** This writes nothing and reports how many memories
   would migrate and which identity columns the local DB has:

   ```bash
   node scripts/migrate-local-to-remote.mjs --dry-run
   # or with explicit connection:
   CORTEX_REMOTE_URL=https://brain.example.com CORTEX_REMOTE_TOKEN=… \
     node scripts/migrate-local-to-remote.mjs --db ~/.cortex/memory.db --dry-run
   ```

   Show the user the count and the server version line. If the local DB is large,
   warn that the server re-embeds every memory (this takes time).

3. **Confirm, then migrate.** After the user approves, run with `--confirm`:

   ```bash
   node scripts/migrate-local-to-remote.mjs --confirm
   ```

   Optional narrowing:
   - `--project <id>` — migrate only one project
   - `--limit <n>` — cap the number migrated (good for a first small batch)

4. **Report the result.** The script prints `N inserted, M already present,
   K failed`. Relay that. If there are failures, they're listed with the memory
   id and error; a `401` stops the run early (bad/expired token).

## Safety

- Default is dry-run — the script refuses to write unless `--confirm` is given.
- It opens the local DB **read-only**; the source is never modified.
- Idempotent: safe to re-run after a partial or interrupted migration.
- The remote must be reachable and the token valid, or the script exits with a
  clear error before touching anything.

## Example

```bash
# 1. see what would happen
CORTEX_REMOTE_URL=https://brain.example.com CORTEX_REMOTE_TOKEN=$TOK \
  node scripts/migrate-local-to-remote.mjs --dry-run

# 2. migrate one project as a test
CORTEX_REMOTE_URL=https://brain.example.com CORTEX_REMOTE_TOKEN=$TOK \
  node scripts/migrate-local-to-remote.mjs --confirm --project my-repo

# 3. migrate everything
CORTEX_REMOTE_URL=https://brain.example.com CORTEX_REMOTE_TOKEN=$TOK \
  node scripts/migrate-local-to-remote.mjs --confirm
```
