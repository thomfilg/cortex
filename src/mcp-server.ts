/**
 * Cortex MCP Server (stdio entry point)
 *
 * Two modes, selected by config (~/.cortex/config.json -> daemon.enabled):
 *
 * - LOCAL (default): classic behavior — this process loads the database
 *   and embedding model and serves MCP over stdio, exactly as before.
 *
 * - PROXY (daemon.enabled = true): this process stays thin (never loads
 *   the database or model). It ensures the shared HTTP daemon is running
 *   (starting it and auto-replacing outdated versions), then forwards
 *   JSON-RPC lines to it. If the daemon cannot be started, it falls back
 *   to LOCAL mode so memory tools always work.
 */

import * as readline from 'readline';
import { initDb } from './database.js';
import { loadConfig, isRemoteModeEnabled } from './config.js';
import { handleMcpRequest, type MCPRequest, type MCPResponse } from './tools.js';
import { ensureDaemon, forwardMcpRequest } from './daemon-client.js';
import type { Storage } from './storage.js';

type ServerMode = 'local' | 'proxy';

async function resolveMode(): Promise<ServerMode> {
  const config = loadConfig();

  // Remote (shared-brain) mode: always proxy to the remote server. We do NOT
  // fall back to a local DB when unreachable - that would silently diverge
  // the shared brain (local writes never reach the server). Per-request
  // failures surface as MCP errors instead (see dispatchProxy).
  if (isRemoteModeEnabled()) {
    await ensureDaemon(); // probe + warn on version mismatch; never spawns remotely
    return 'proxy';
  }

  if (!config.daemon.enabled) {
    return 'local';
  }

  // Daemon mode requested: bring the shared daemon up (spawns it if needed,
  // replaces it if it's running an older plugin version)
  const daemonReady = await ensureDaemon();
  if (daemonReady) {
    return 'proxy';
  }

  console.error('[cortex] Daemon mode enabled but daemon could not be started - falling back to local mode');
  return 'local';
}

async function dispatchProxy(request: MCPRequest): Promise<MCPResponse> {
  try {
    return await forwardMcpRequest(request);
  } catch {
    // Daemon may have restarted (e.g. plugin update replaced it) - recover once
    const recovered = await ensureDaemon();
    if (recovered) {
      try {
        return await forwardMcpRequest(request);
      } catch (retryError) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32603,
            message: `Cortex daemon unreachable: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: 'Cortex daemon unreachable and could not be restarted',
      },
    };
  }
}

async function main() {
  const mode = await resolveMode();

  let db: Storage | null = null;
  if (mode === 'local') {
    db = await initDb();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      // Notifications have no 'id' field and must not receive a response
      // Note: id: null is a valid request ID per JSON-RPC 2.0, so we check field presence
      if (!('id' in message)) {
        return;
      }

      const request = message as MCPRequest;
      const response =
        mode === 'proxy'
          ? await dispatchProxy(request)
          : await handleMcpRequest(db as Storage, request);
      console.log(JSON.stringify(response));
    } catch (error) {
      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: error instanceof Error ? error.message : String(error),
        },
      };
      console.log(JSON.stringify(errorResponse));
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('MCP Server error:', error);
  process.exit(1);
});
