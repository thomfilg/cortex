/**
 * Cortex Version
 * Injected from package.json at build time via esbuild --define
 * (see build scripts in package.json), so there is a single source
 * of truth for the version.
 *
 * Used by the MCP initialize response and the daemon version handshake:
 * clients compare their bundled VERSION against the daemon's /health
 * version and restart the daemon on mismatch, so a plugin update
 * automatically replaces a running daemon.
 */

declare const __CORTEX_VERSION__: string | undefined;

export const VERSION: string =
  typeof __CORTEX_VERSION__ !== 'undefined' && __CORTEX_VERSION__
    ? __CORTEX_VERSION__
    : '0.0.0-dev';
