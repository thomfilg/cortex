/**
 * Cortex Daemon Client
 * Helpers used by the stdio proxy, hooks, and statusline to talk to the
 * shared HTTP daemon: health checks, auto-spawn, version handshake
 * (auto-restart the daemon when the plugin was updated), and MCP forwarding.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { getDaemonPort, getDaemonInfoPath } from './config.js';
import { VERSION } from './version.js';
import type { MCPRequest, MCPResponse } from './tools.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonHealth {
  name: string;
  version: string;
  pid: number;
  port: number;
  uptime: number;
}

export interface DaemonStats {
  version: string;
  fragmentCount: number;
  projectCount: number;
  sessionCount: number;
  dbSizeBytes: number;
  project?: {
    fragmentCount: number;
    sessionCount: number;
    lastArchive: string | null;
  };
}

// ============================================================================
// HTTP helpers
// ============================================================================

export function getDaemonBaseUrl(): string {
  return `http://127.0.0.1:${getDaemonPort()}`;
}

/**
 * Fetch from the daemon with a timeout. Throws on network error/timeout.
 */
export async function daemonFetch(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<unknown> {
  const { method = 'GET', body, timeoutMs = 1000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${getDaemonBaseUrl()}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 202) {
      const errBody = await response.text().catch(() => '');
      throw new Error(
        `Daemon responded ${response.status} for ${path}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`
      );
    }

    // 202 (accepted, async work queued) may have an empty body
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get daemon health, or null if the daemon is not reachable
 */
export async function getDaemonHealth(timeoutMs: number = 500): Promise<DaemonHealth | null> {
  try {
    const health = await daemonFetch('/health', { timeoutMs });
    return health as DaemonHealth;
  } catch {
    return null;
  }
}

// ============================================================================
// Daemon lifecycle
// ============================================================================

/**
 * Resolve the daemon script path (sibling of the calling bundle in dist/)
 */
function getDaemonScriptPath(): string {
  // Same URL->path convention used elsewhere in this codebase (index.ts setup)
  return decodeURIComponent(new URL('./daemon.js', import.meta.url).pathname);
}

/**
 * Spawn the daemon detached (fire and forget).
 * Safe to call when a daemon is already running: the new process detects
 * the healthy same-version occupant and exits quietly.
 */
export function spawnDaemonDetached(): boolean {
  try {
    const daemonPath = getDaemonScriptPath();
    if (!fs.existsSync(daemonPath)) {
      return false;
    }
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask a running daemon to shut down gracefully, falling back to SIGTERM
 * via the pid recorded in daemon.json.
 */
export async function stopDaemon(): Promise<boolean> {
  let requested = false;
  try {
    await daemonFetch('/shutdown', { method: 'POST', timeoutMs: 1500 });
    requested = true;
  } catch {
    // Fall back to signal via pidfile
    try {
      const infoPath = getDaemonInfoPath();
      if (fs.existsSync(infoPath)) {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid?: number };
        if (info.pid) {
          process.kill(info.pid, 'SIGTERM');
          requested = true;
        }
      }
    } catch {
      // Nothing else we can do
    }
  }
  return requested;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure a daemon of OUR version is running.
 *
 * - Healthy daemon with matching version -> done.
 * - Healthy daemon with a DIFFERENT version (plugin was updated) ->
 *   ask it to shut down, then spawn the new build (auto-update).
 * - No daemon -> spawn one and wait for it to come up (the daemon loads
 *   the database at startup, which can take a few seconds for large DBs).
 *
 * Returns true when a matching-version daemon is reachable.
 */
export async function ensureDaemon(waitMs: number = 10000): Promise<boolean> {
  const health = await getDaemonHealth();

  if (health && health.version === VERSION) {
    return true;
  }

  if (health && health.version !== VERSION) {
    // Plugin updated: replace the old daemon with our build
    await stopDaemon();
    // Wait for the old daemon to release the port
    const shutdownDeadline = Date.now() + 3000;
    while (Date.now() < shutdownDeadline) {
      if (!(await getDaemonHealth(300))) break;
      await delay(150);
    }
  }

  if (!spawnDaemonDetached()) {
    return false;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const current = await getDaemonHealth(400);
    if (current && current.version === VERSION) {
      return true;
    }
    await delay(200);
  }

  return false;
}

// ============================================================================
// High-level operations
// ============================================================================

/**
 * Forward an MCP JSON-RPC request to the daemon.
 * No aggressive timeout: tool calls (e.g. archiving a large session)
 * can legitimately take a while; Claude Code applies its own MCP timeout.
 */
export async function forwardMcpRequest(request: MCPRequest, timeoutMs: number = 300000): Promise<MCPResponse> {
  const response = await daemonFetch('/mcp', { method: 'POST', body: request, timeoutMs });
  return response as MCPResponse;
}

/**
 * Get stats from the daemon, or null if unreachable
 */
export async function getDaemonStats(projectId?: string | null, timeoutMs: number = 400): Promise<DaemonStats | null> {
  try {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const stats = await daemonFetch(`/stats${query}`, { timeoutMs });
    return stats as DaemonStats;
  } catch {
    return null;
  }
}

/**
 * Request an archive through the daemon.
 * With async=true the daemon queues the work and returns immediately (202),
 * which is what hooks with tight timeouts (statusline, post-tool) use.
 */
export async function requestDaemonArchive(params: {
  transcriptPath: string;
  projectId: string | null;
  contextPercent?: number;
  markAutoSave?: boolean;
  async?: boolean;
  timeoutMs?: number;
}): Promise<{ archived: number; skipped: number; duplicates: number; formatted?: string } | null> {
  const { timeoutMs = params.async ? 1500 : 55000, ...body } = params;
  try {
    const result = await daemonFetch('/archive', { method: 'POST', body, timeoutMs });
    return result as { archived: number; skipped: number; duplicates: number; formatted?: string };
  } catch {
    return null;
  }
}

/**
 * Get formatted restoration context from the daemon, or null if unreachable
 */
export async function requestDaemonRestore(params: {
  projectId: string | null;
  messageCount: number;
  tokenBudget: number;
  timeoutMs?: number;
}): Promise<{ hasContent: boolean; formatted: string } | null> {
  const { timeoutMs = 8000, ...body } = params;
  try {
    const result = await daemonFetch('/restore', { method: 'POST', body, timeoutMs });
    return result as { hasContent: boolean; formatted: string };
  } catch {
    return null;
  }
}
