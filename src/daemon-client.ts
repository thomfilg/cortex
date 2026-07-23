/**
 * Cortex Daemon Client
 * Helpers used by the stdio proxy, hooks, and statusline to talk to the
 * shared HTTP daemon: health checks, auto-spawn, version handshake
 * (auto-restart the daemon when the plugin was updated), and MCP forwarding.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { getDaemonPort, getDaemonInfoPath, isRemoteModeEnabled, getRemoteUrl, getRemoteToken } from './config.js';
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
  storage?: string;
}

export interface DaemonStats {
  version: string;
  storage?: string;
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

/**
 * Base URL of the backend. In remote (shared-brain) mode this is the
 * configured remote URL; otherwise the localhost daemon.
 */
export function getDaemonBaseUrl(): string {
  const remote = getRemoteUrl();
  if (remote) return remote;
  return `http://127.0.0.1:${getDaemonPort()}`;
}

/**
 * Build request headers, adding a Bearer token in remote mode. The token is
 * env-only (CORTEX_REMOTE_TOKEN); its absence in remote mode is a hard error
 * rather than an unauthenticated request.
 */
function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (isRemoteModeEnabled()) {
    const token = getRemoteToken();
    if (!token) {
      throw new Error('Remote mode is enabled but CORTEX_REMOTE_TOKEN is not set');
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
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
      headers: buildHeaders(body !== undefined),
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
  // Never spawn a local process for a remote backend we don't own.
  if (isRemoteModeEnabled()) return false;
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
  // Never shut down a shared remote server: it is not ours to stop, and its
  // pid is on another host.
  if (isRemoteModeEnabled()) return false;
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
  // Remote mode: we do NOT own the server. Never spawn, replace, or shut it
  // down - only probe reachability. A version mismatch is a warning, not a
  // failure (the operator controls the server's version independently).
  if (isRemoteModeEnabled()) {
    const remoteHealth = await getDaemonHealth(Math.min(waitMs, 3000));
    if (remoteHealth && remoteHealth.version !== VERSION) {
      console.error(
        `[cortex] Remote brain version ${remoteHealth.version} differs from plugin ${VERSION}`
      );
    }
    return remoteHealth !== null;
  }

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
 * Vector-search the daemon for auto-recall, or null if unreachable.
 * Timestamps come back as ISO strings and are revived to Dates here.
 */
export async function requestDaemonRecall(params: {
  query: string;
  projectId: string | null;
  limit?: number;
  minScore?: number;
  timeoutMs?: number;
}): Promise<Array<{ id: number; score: number; content: string; timestamp: Date; projectId: string | null }> | null> {
  const { timeoutMs = 8000, ...body } = params;
  try {
    const response = (await daemonFetch('/recall', { method: 'POST', body, timeoutMs })) as {
      results: Array<{ id: number; score: number; content: string; timestamp: string; projectId: string | null }>;
    };
    return response.results.map((r) => ({ ...r, timestamp: new Date(r.timestamp) }));
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
