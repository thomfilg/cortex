/**
 * Cortex Identity Module
 *
 * Single source of truth for the three identity values stamped onto every
 * memory so a shared brain can attribute and scope recall:
 *   - user         who authored the memory
 *   - project      which codebase it belongs to
 *   - environment  which machine/context it came from (dynamic)
 *
 * Resolution precedence for each value:
 *   env var  >  config (project-root .cortex, then global ~/.cortex)  >  auto
 *
 * `category` is NOT resolved here - it is chosen per-write (default 'project');
 * see src/types.ts (MemoryCategory) and src/search.ts for how it scopes recall.
 */

import * as fs from 'fs';
import * as os from 'os';
import type { Config } from './types.js';
import { getProjectId } from './stdin.js';

/**
 * Normalize an identity token into a safe, stable label:
 * lowercase, non-alphanumeric runs collapsed to a single '-', trimmed.
 */
export function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * OS account name, sanitized. Best-effort - falls back to 'unknown'.
 */
function osUsername(): string {
  try {
    const name = os.userInfo().username;
    if (name) return sanitizeLabel(name);
  } catch {
    /* os.userInfo can throw on exotic setups */
  }
  const envName = process.env.USER || process.env.USERNAME || process.env.LOGNAME;
  return envName ? sanitizeLabel(envName) : 'unknown';
}

/**
 * Resolve the user identity.
 * CORTEX_USER env > config.identity.user > OS username.
 */
export function resolveUser(config: Config): string {
  const fromEnv = process.env.CORTEX_USER;
  if (fromEnv && fromEnv.trim()) return sanitizeLabel(fromEnv.trim());

  const fromConfig = config.identity?.user;
  if (fromConfig && fromConfig.trim()) return sanitizeLabel(fromConfig.trim());

  return osUsername();
}

/**
 * Resolve the stable project name.
 * config.project (set in project-root .cortex/config.json) > cwd basename.
 */
export function resolveProject(cwd: string | undefined, config: Config): string {
  const fromConfig = config.project;
  if (fromConfig && fromConfig.trim()) return sanitizeLabel(fromConfig.trim());

  return sanitizeLabel(getProjectId(cwd));
}

/**
 * Detect whether we are running inside Claude Code on the web / a remote
 * managed container. Best-effort: checks a set of known env markers. The
 * CORTEX_ENVIRONMENT override always wins over this, so false negatives are
 * cheap to correct.
 */
function isClaudeWeb(): boolean {
  if (process.env.CLAUDE_CODE_WEB || process.env.CLAUDE_CODE_REMOTE) return true;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'web') return true;
  // The web/remote runner routes outbound HTTPS through an agent proxy and
  // ships a dedicated CA bundle; treat that as a strong signal.
  try {
    if (fs.existsSync('/root/.ccr/ca-bundle.crt')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Detect Windows Subsystem for Linux.
 */
function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Human-readable OS label used inside environment names.
 */
function platformLabel(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return process.platform;
  }
}

/**
 * Auto-detect the environment label:
 *   claude-web  |  <user>-wsl  |  <user>-<platform>
 */
function detectEnvironment(user: string): string {
  if (isClaudeWeb()) return 'claude-web';
  if (isWSL()) return sanitizeLabel(`${user}-wsl`);
  return sanitizeLabel(`${user}-${platformLabel()}`);
}

/**
 * Resolve the environment label.
 * CORTEX_ENVIRONMENT env > config.identity.environment > auto-detect.
 */
export function resolveEnvironment(config: Config): string {
  const fromEnv = process.env.CORTEX_ENVIRONMENT;
  if (fromEnv && fromEnv.trim()) return sanitizeLabel(fromEnv.trim());

  const fromConfig = config.identity?.environment;
  if (fromConfig && fromConfig.trim()) return sanitizeLabel(fromConfig.trim());

  return detectEnvironment(resolveUser(config));
}

/**
 * Fully resolved identity for the current session/write.
 */
export interface ResolvedIdentity {
  user: string;
  project: string;
  environment: string;
}

/**
 * Resolve all identity values at once.
 */
export function resolveIdentity(cwd: string | undefined, config: Config): ResolvedIdentity {
  return {
    user: resolveUser(config),
    project: resolveProject(cwd, config),
    environment: resolveEnvironment(config),
  };
}
