/**
 * Cortex Daemon Auth & Binding
 *
 * Pure helpers for the daemon's public "server mode": deciding the bind host,
 * reading the env-only server token, and constant-time bearer-token checks.
 * Kept separate from daemon.ts so they are unit-testable without launching the
 * HTTP server (importing daemon.ts runs main()).
 */

import * as crypto from 'crypto';

/**
 * Public server mode is opt-in via CORTEX_SERVER=1 (or --server). It binds all
 * interfaces so other machines can reach the shared brain; the default local
 * daemon stays bound to loopback only.
 */
export function isServerMode(argv: string[] = process.argv): boolean {
  const flag = process.env.CORTEX_SERVER;
  return argv.includes('--server') || flag === '1' || flag === 'true';
}

export function getBindHost(argv: string[] = process.argv): string {
  return isServerMode(argv) ? '0.0.0.0' : '127.0.0.1';
}

/** Expected bearer token for public server mode (env-only). */
export function getServerToken(): string | null {
  const token = process.env.CORTEX_SERVER_TOKEN;
  return token && token.trim() ? token.trim() : null;
}

/**
 * Constant-time bearer-token check. When no CORTEX_SERVER_TOKEN is configured
 * the daemon requires no auth (the classic loopback-only local daemon) - a
 * public server without a token is refused at startup instead (see daemon.ts).
 */
export function isAuthorized(authHeader: string | undefined): boolean {
  const expected = getServerToken();
  if (!expected) return true; // local daemon, no auth
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}
