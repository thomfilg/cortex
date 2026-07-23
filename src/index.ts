/**
 * Cortex v2.0 - Main Entry Point
 * Handles statusline display, CLI commands, and hook events
 */

import { readStdin, readStdinWithResult, getProjectId, getContextPercent, formatDuration, formatCompactNumber } from './stdin.js';
import { loadConfig, updateConfig, ensureDataDir, applyPreset, getDataDir, isSetupComplete, markSetupComplete, saveCurrentSession, shouldAutoSave, markAutoSaved, resetAutoSaveState, loadAutoSaveState, isAutoSaveStateCurrentSession, wasRecentlySaved, isSaving, setSavingState, isShowingSavingIndicator, getLastSaveTimeAgo, configureClaudeStatusline, buildCortexStatuslineCommand, getChainedStatuslineCommand, getProjectConfigDir, getProjectConfigPath, isRemoteModeEnabled, getRemoteUrl, getRemoteToken, type ConfigPreset } from './config.js';
import { resolveUser, resolveProject, resolveEnvironment, resolveIdentity, sanitizeLabel } from './identity.js';
import { ensureDaemon, spawnDaemonDetached, stopDaemon, getDaemonHealth, getDaemonStats, requestDaemonArchive, requestDaemonRestore, requestDaemonRecall, daemonFetch, getDaemonBaseUrl, type DaemonStats } from './daemon-client.js';
import { isServerMode, getBindHost, getServerToken, isAuthorized } from './daemon-auth.js';
import { VERSION } from './version.js';
import { spawn, execSync } from 'child_process';
import { initDb, getStats, getProjectStats, formatBytes, closeDb, saveDb, searchByVector, searchByKeyword, validateDatabase, isFts5Enabled, getBackupFiles, compactDatabase, getStorageKind, insertMemory, deleteMemory, getMemory, buildScopeClause } from './database.js';
import { verifyModel, getModelName, embedQuery } from './embeddings.js';
import { hybridSearch, vectorSearch, formatSearchResults } from './search.js';
import { isPromptEligible, selectForInjection, formatInjection, loadRecallState, getInjectedIds, recordInjection, getRecallStatePath } from './recall-auto.js';
import { archiveSession, formatArchiveResult, buildRestorationContext, formatRestorationContext } from './archive.js';
import { startSession, recordSavePoint } from './analytics.js';
import { runBackup, isBackupDue, loadBackupState, getBackupStatePath, type BackupResult } from './backup.js';
import { runSync, isSyncDue, loadSyncState, getSyncStatePath, ensureDeviceId, type SyncResult } from './sync.js';
import type { StdinData, CommandName, Config } from './types.js';

// ============================================================================
// ANSI Colors for Terminal Output
// ============================================================================

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;2;72;150;140m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  darkGray: '\x1b[38;5;240m',        // Darker grey for separators
  brick: '\x1b[38;2;217;119;87m',    // Claude terracotta/brick #D97757
};

// ============================================================================
// Debug Logging (for diagnosing hook execution)
// ============================================================================

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEBUG_ENABLED = process.env.CORTEX_DEBUG === '1' || process.env.CORTEX_DEBUG === 'true';
const DEBUG_LOG_DIR = join(homedir(), '.cortex', 'logs');
const DEBUG_LOG_FILE = join(DEBUG_LOG_DIR, 'hook-debug.log');

function debugLog(context: string, message: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return;

  try {
    if (!existsSync(DEBUG_LOG_DIR)) {
      mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${context}] ${message}${data ? '\n  DATA: ' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') : ''}\n`;

    appendFileSync(DEBUG_LOG_FILE, logEntry);
  } catch {
    // Silent fail - don't break on logging errors
  }
}

// ============================================================================
// Command Router
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] as CommandName | undefined;

  debugLog('main', `Command invoked: ${command || 'statusline (default)'}`, {
    args,
    cwd: process.cwd(),
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
    projectDir: process.env.CLAUDE_PROJECT_DIR,
  });

  try {
    switch (command) {
      case 'statusline':
        await handleStatusline();
        break;

      case 'session-start':
        await handleSessionStart();
        break;

      case 'background-save':
        await handleBackgroundSave(args);
        break;

      case 'session-end':
        await handleSessionEnd();
        break;

      // Legacy commands mapped to new handlers or no-op
      case 'monitor':
      case 'context-check':
        // No-op for legacy monitor/context-check
        break;

      case 'clear-reminder':
      case 'post-tool':
        await handlePostTool();
        break;

      case 'pre-compact':
        await handlePreCompact();
        break;

      // Map smart-compact to pre-compact logic (same intent)
      case 'smart-compact':
        await handlePreCompact();
        break;

      case 'save':
      case 'archive':
        await handleSave(args.slice(1));
        break;

      case 'recall':
      case 'search':
        await handleRecall(args.slice(1));
        break;

      case 'stats':
        await handleStats();
        break;

      case 'setup':
        await handleSetup(args.slice(1));
        break;

      case 'ensure-daemon':
        await handleEnsureDaemon();
        break;

      case 'daemon-status':
        await handleDaemonStatus();
        break;

      case 'daemon-stop':
        await handleDaemonStop();
        break;

      case 'compact':
        await handleCompact(args.slice(1));
        break;

      case 'backup':
        await handleBackup(args.slice(1));
        break;

      case 'sync':
        await handleSync(args.slice(1));
        break;

      case 'auto-recall':
        await handleAutoRecall();
        break;

      case 'configure':
        await handleConfigure(args.slice(1));
        break;

      case 'test-embed':
        await handleTestEmbed(args[1] || 'hello world');
        break;

      case 'check-db':
        await handleCheckDb();
        break;

      default:
        // Default: show statusline if no command
        await handleStatusline();
        break;
    }
    debugLog('main', `Command completed successfully: ${command || 'statusline'}`);
  } catch (error) {
    debugLog('main', `Command failed: ${command}`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error(`[Cortex Error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

// ============================================================================
// Chained Statusline Helper
// ============================================================================

const CHAINED_COMMAND_TIMEOUT_MS = 500;

/**
 * Execute the chained statusline command and return its output
 * Returns null if no chained command, command fails, or times out
 * Only uses the first line of output
 *
 * Note: Uses shell execution because statusline commands may contain
 * pipes, redirects, or shell expansions. The command is from the user's
 * own config (their original statusline), not untrusted input.
 */
function executeChainedStatusline(): string | null {
  const chainedCommand = getChainedStatuslineCommand();
  if (!chainedCommand) {
    return null;
  }

  try {
    // execSync with shell is appropriate here because:
    // 1. The command is from user's own config, not untrusted input
    // 2. Statusline commands may need shell features (pipes, expansions)
    const output = execSync(chainedCommand, {
      timeout: CHAINED_COMMAND_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Only use the first line
    const firstLine = output.trim().split('\n')[0];
    return firstLine || null;
  } catch (error) {
    // Log error to debug but don't break statusline
    debugLog('executeChainedStatusline', 'Chained command failed', {
      command: chainedCommand,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// Statusline Handler
// ============================================================================

async function handleStatusline() {
  const stdin = await readStdin();
  const config = loadConfig();
  const daemonMode = config.daemon.enabled;

  // Daemon mode: the statusline never touches the database directly -
  // it asks the shared daemon and spawns it if it's not running.
  // Classic mode: initialize database locally, exactly as before.
  let remoteStats: DaemonStats | null = null;
  let db: Awaited<ReturnType<typeof initDb>> | null = null;

  if (daemonMode) {
    remoteStats = await getDaemonStats(null, 300);
    if (!remoteStats || remoteStats.version !== VERSION) {
      // Not running, or running an outdated build (plugin was updated):
      // spawn our build - it replaces an outdated occupant automatically
      spawnDaemonDetached();
    }
  } else {
    db = await initDb();
  }

  // Track context for logic and display
  let contextPercent = 0;
  if (stdin?.cwd) {
    contextPercent = getContextPercent(stdin);

    // Keep session info updated for MCP tools (in case SessionStart didn't fire on resume)
    const projectId = getProjectId(stdin.cwd);
    if (stdin.transcript_path) {
      saveCurrentSession(stdin.transcript_path, projectId === 'unknown' ? null : projectId);
    }

    // Check context step autosave (runs regardless of statusline display setting)
    if (config.autosave.contextStep.enabled && stdin.transcript_path) {
      if (shouldAutoSave(contextPercent, stdin.transcript_path)) {
        if (daemonMode) {
          // Queue the archive on the daemon (fast 202 ack) - the embedding
          // work happens in the daemon, not in this transient process
          setSavingState(true, stdin.transcript_path);
          const queued = await requestDaemonArchive({
            transcriptPath: stdin.transcript_path,
            // 'unknown' (root dir) means no project: store as global
            projectId: projectId === 'unknown' ? null : projectId,
            contextPercent,
            markAutoSave: true,
            async: true,
            // Statusline is the hottest path: never stall the render
            timeoutMs: 500,
          });
          if (!queued) {
            setSavingState(false, null);
            spawnDaemonDetached();
          }
        } else {
          const result = await archiveSession(db!, stdin.transcript_path, projectId);

          if (result.archived > 0) {
            markAutoSaved(stdin.transcript_path, contextPercent, result.archived);
            recordSavePoint(contextPercent, result.archived);
            // Metadata for debug/hooks if needed
          } else {
            // Update state to avoid retry
            markAutoSaved(stdin.transcript_path, contextPercent, 0);
          }
        }
      }
    }
  }

  // === Statusline display (only if enabled) ===
  if (config.statusline.enabled) {
    // Daemon unreachable -> null: render without the count for this refresh
    const fragmentCount = daemonMode
      ? remoteStats?.fragmentCount ?? null
      : getStats(db!).fragmentCount;
    const parts: string[] = [];

    // Execute chained statusline first (if configured)
    const chainedOutput = executeChainedStatusline();
    if (chainedOutput) {
      parts.push(chainedOutput);
      parts.push(`${ANSI.darkGray}|${ANSI.reset}`);
    }

    // Cortex statusline
    parts.push(`${ANSI.brick}Ψ${ANSI.reset}`);

    // Memory count
    if (config.statusline.showFragments && fragmentCount !== null) {
      parts.push(formatCompactNumber(fragmentCount));
    }

    // Context usage with circle strip
    if (config.statusline.showContext) {
      const contextStrip = createContextStrip(contextPercent);
      parts.push(contextStrip);
    }

    // Inline indicator: Saving (Animated) → Autosaved → ✓ Xm
    if (isShowingSavingIndicator()) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const frame = frames[Math.floor(Date.now() / 80) % frames.length];
      parts.push(`${ANSI.yellow}${frame} Saving${ANSI.reset}`);
    } else if (wasRecentlySaved()) {
      parts.push(`${ANSI.green}✓ Autosaved${ANSI.reset}`);
    } else {
      // Show persistent time indicator if we have a recent save
      const timeAgo = getLastSaveTimeAgo(stdin?.transcript_path ?? null);
      if (timeAgo) {
        parts.push(`${ANSI.green}✓${ANSI.reset} ${ANSI.dim}${timeAgo}${ANSI.reset}`);
      }

      // Check if we should trigger a new save
      // (daemon mode already queued its archive above - this background-save
      // spawn is the classic per-process path only)
      if (!daemonMode && stdin?.transcript_path && config.autosave.contextStep.enabled) {
        if (shouldAutoSave(contextPercent, stdin.transcript_path)) {
          // START BACKGROUND SAVE
          setSavingState(true, stdin.transcript_path);

          const scriptPath = process.argv[1];
          const nodePath = process.argv[0];

          // Pass necessary context via args
          const childArgs = ['background-save'];
          if (stdin.transcript_path) childArgs.push(`--transcript=${stdin.transcript_path}`);
          if (stdin.cwd) childArgs.push(`--cwd=${stdin.cwd}`);
          childArgs.push(`--percent=${contextPercent}`);

          try {
            const subprocess = spawn(nodePath, [scriptPath, ...childArgs], {
              detached: true,
              stdio: 'ignore',
              env: process.env
            });
            subprocess.unref();
            // Note: "Saving" will show on next statusline refresh via isShowingSavingIndicator()
          } catch (e) {
            // Fallback (clear state on error)
            setSavingState(false, null);
          }
        }
      }
    }

    // Output main statusline (no separators)
    console.log(parts.join(' '));
  }
}

/**
 * Create a context strip with 5 circles (each = 20%)
 * ● = filled, ○ = empty
 * Color: brick (<70%), yellow (70-84%), red (>=85%)
 */
function createContextStrip(percent: number): string {
  const totalCircles = 5;
  const filled = Math.round((percent / 100) * totalCircles);
  const empty = totalCircles - filled;

  // Color based on percentage: brick → yellow → red
  let color: string;
  if (percent < 70) {
    color = ANSI.brick;
  } else if (percent < 85) {
    color = ANSI.yellow;
  } else {
    color = ANSI.red;
  }

  const filledCircles = '●'.repeat(filled);
  const emptyCircles = '○'.repeat(empty);

  return `${color}${filledCircles}${ANSI.dim}${emptyCircles}${ANSI.reset} ${percent}%`;
}

// ============================================================================
// Hook Handlers
// ============================================================================

function buildAwarenessContext(config: Config): string | null {
  if (!config.awareness.enabled) return null;

  const lines: string[] = [];
  if (config.awareness.userName) {
    lines.push(`User: ${config.awareness.userName}`);
  }

  if (config.awareness.timezone !== 'off') {
    const tz = config.awareness.timezone
      || Intl.DateTimeFormat().resolvedOptions().timeZone;

    const now = new Date();
    let formattedDate: string;
    let formattedTime: string;
    let resolvedTz = tz;

    try {
      formattedDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: tz,
      }).format(now);
      formattedTime = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true,
        timeZone: tz,
      }).format(now);
    } catch {
      // Invalid timezone — fall back to auto-detect
      resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      formattedDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: resolvedTz,
      }).format(now);
      formattedTime = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true,
        timeZone: resolvedTz,
      }).format(now);
    }

    lines.push(`Date: ${formattedDate}`);
    lines.push(`Time: ${formattedTime} (${resolvedTz})`);
  }

  return lines.join('\n');
}

async function handleSessionStart() {
  debugLog('handleSessionStart', 'Hook invoked');
  const stdin = await readStdin();
  debugLog('handleSessionStart', 'Stdin received', { hasStdin: !!stdin, cwd: stdin?.cwd, transcriptPath: stdin?.transcript_path });
  const config = loadConfig();

  // Check if setup is completed
  if (!config.setup.completed) {
    debugLog('handleSessionStart', 'Setup not completed, showing first-run message');
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.yellow}First run detected. Run ${ANSI.cyan}/cortex-setup${ANSI.reset} to initialize.`);
    return;
  }

  // Reset auto-save state for new session
  resetAutoSaveState();

  // Get project ID, treating 'unknown' (from root dir "/") as null
  const rawProjectId = stdin?.cwd ? getProjectId(stdin.cwd) : null;
  const projectId = rawProjectId === 'unknown' ? null : rawProjectId;

  // Save current session info for MCP tools to use
  if (stdin?.transcript_path) {
    saveCurrentSession(stdin.transcript_path, projectId);
  }

  // Start analytics session
  startSession(projectId);

  // Daemon mode: bring the shared daemon up (spawning/replacing as needed)
  // and render from it - this process never loads the database
  if (config.daemon.enabled) {
    const handled = await sessionStartViaDaemon(config, projectId);
    if (handled) return;
    // Daemon unavailable: fall through to the classic local path
  }

  // Initialize database
  const db = await initDb();

  // Get project stats
  const projectStats = projectId ? getProjectStats(db, projectId) : null;

  // Always try to build restoration context (may have turns even without memories)
  const restoration = await buildRestorationContext(db, projectId, {
    messageCount: config.restoration.messageCount,
    tokenBudget: config.restoration.tokenBudget,
  });

  if (projectStats && projectStats.fragmentCount > 0) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}${projectStats.fragmentCount} memories for ${ANSI.bold}${projectId}${ANSI.reset}`);
  } else if (projectId) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}Ready for ${ANSI.bold}${projectId}${ANSI.reset} (no memories yet)`);
  } else {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}Session started`);
  }

  // Awareness context
  const awareness = buildAwarenessContext(config);

  // Show restoration context if we have any content (turns or memories)
  if (restoration.hasContent || awareness) {
    console.log('');
    console.log(`${ANSI.dim}--- Restoration Context ---${ANSI.reset}`);
    if (awareness) {
      console.log(awareness);
      if (restoration.hasContent) console.log('');
    }
    if (restoration.hasContent) {
      console.log(formatRestorationContext(restoration));
    }
    console.log(`${ANSI.dim}---------------------------${ANSI.reset}`);
  }
}

/**
 * Session start via the shared daemon (daemon mode).
 * Returns false when the daemon can't be reached so the caller can fall
 * back to the classic local path.
 */
async function sessionStartViaDaemon(config: Config, projectId: string | null): Promise<boolean> {
  // SessionStart hook timeout is 10s; leave room for the fallback path
  const ready = await ensureDaemon(8000);
  if (!ready) return false;

  const stats = await getDaemonStats(projectId, 3000);
  if (!stats) return false;

  const fragmentCount = stats.project?.fragmentCount ?? 0;

  if (projectId && fragmentCount > 0) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}${fragmentCount} memories for ${ANSI.bold}${projectId}${ANSI.reset}`);
  } else if (projectId) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}Ready for ${ANSI.bold}${projectId}${ANSI.reset} (no memories yet)`);
  } else {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}Session started`);
  }

  const restoration = await requestDaemonRestore({
    projectId,
    messageCount: config.restoration.messageCount,
    tokenBudget: config.restoration.tokenBudget,
  });

  const awareness = buildAwarenessContext(config);
  const hasRestoration = restoration?.hasContent ?? false;

  if (hasRestoration || awareness) {
    console.log('');
    console.log(`${ANSI.dim}--- Restoration Context ---${ANSI.reset}`);
    if (awareness) {
      console.log(awareness);
      if (hasRestoration) console.log('');
    }
    if (hasRestoration && restoration) {
      console.log(restoration.formatted);
    }
    console.log(`${ANSI.dim}---------------------------${ANSI.reset}`);
  }

  return true;
}

/**
 * Handle Session End Hook
 */
async function handleSessionEnd() {
  debugLog('handleSessionEnd', 'Hook invoked');
  const stdin = await readStdin();
  const config = loadConfig();

  if (!config.autosave.onSessionEnd) {
    debugLog('handleSessionEnd', 'Disabled by config');
    return;
  }

  if (!stdin?.transcript_path) {
    debugLog('handleSessionEnd', 'No transcript path - aborting');
    return;
  }

  const projectId = stdin.cwd ? getProjectId(stdin.cwd) : null;

  // Always save before session ends
  console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.cyan}Saving session before exit...`);

  // Daemon mode: archive through the shared daemon (hook timeout is 30s)
  if (config.daemon.enabled && (await ensureDaemon(5000))) {
    const result = await requestDaemonArchive({
      transcriptPath: stdin.transcript_path,
      projectId,
      timeoutMs: 20000,
    });
    if (result) {
      if (result.archived > 0) {
        console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.green}Saved ${result.archived} memories`);
      }
      return;
    }
    // Daemon call failed: fall through to local archive
  }

  const db = await initDb();
  const result = await archiveSession(db, stdin.transcript_path, projectId);

  if (result.archived > 0) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.green}Saved ${result.archived} memories`);
  }
}

/**
 * Handle Post Tool Execution Hook
 * Checks context step to trigger autosave
 */
async function handlePostTool() {
  const stdin = await readStdin();
  const config = loadConfig();

  if (!stdin?.transcript_path) return;

  // Check context step autosave
  if (config.autosave.contextStep.enabled) {
    const currentPercent = getContextPercent(stdin);

    // Check if we should save based on step increase
    if (shouldAutoSave(currentPercent, stdin.transcript_path)) {
      if (config.daemon.enabled) {
        // Daemon mode: queue on the shared daemon (fast 202 ack) - this
        // hook has a 2s timeout and must never load the DB or model
        setSavingState(true, stdin.transcript_path);
        const queued = await requestDaemonArchive({
          transcriptPath: stdin.transcript_path,
          projectId: stdin.cwd ? getProjectId(stdin.cwd) : null,
          contextPercent: currentPercent,
          markAutoSave: true,
          async: true,
          timeoutMs: 800,
        });
        if (!queued) {
          setSavingState(false, null);
          spawnDaemonDetached();
        }
      } else {
        await performAutosave(stdin, 'context step');
      }
    }
  }
}

/**
 * Helper to perform autosave
 */
async function performAutosave(stdin: StdinData, trigger: string) {
  if (!stdin.transcript_path) return;

  const db = await initDb();
  const projectId = stdin.cwd ? getProjectId(stdin.cwd) : null;
  const contextPercent = getContextPercent(stdin);

  // Perform archive
  const result = await archiveSession(db, stdin.transcript_path, projectId);

  if (result.archived > 0) {
    // Save successful - update state
    markAutoSaved(stdin.transcript_path, contextPercent, result.archived);

    // Record analytics
    recordSavePoint(contextPercent, result.archived);

    // Log to debug only (user sees indicator in statusline)
    debugLog('autosave', `Saved ${result.archived} fragments`, { trigger, contextPercent });
  } else {
    // No content saved (maybe empty or duplicate), but mark point to avoid re-checking immediately
    markAutoSaved(stdin.transcript_path, contextPercent, 0);
  }
}

// Legacy handlers removed: handleMonitor, handleClearReminder, handleContextCheck,
// handleSmartCompact (the 'smart-compact' command routes to handlePreCompact)

async function handleBackgroundSave(args: string[]) {
  // Parse args manually since we can't read stdin
  let transcriptPath = '';
  let cwd = '';
  let contextPercent = 0;

  for (const arg of args) {
    if (arg.startsWith('--transcript=')) transcriptPath = arg.slice('--transcript='.length);
    else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
    else if (arg.startsWith('--percent=')) contextPercent = parseFloat(arg.slice('--percent='.length));
  }

  if (!transcriptPath) {
    setSavingState(false, null);
    return;
  }

  try {
    const db = await initDb();
    const projectId = cwd ? getProjectId(cwd) : null;

    const result = await archiveSession(db, transcriptPath, projectId);

    if (result.archived > 0) {
      markAutoSaved(transcriptPath, contextPercent, result.archived);
      recordSavePoint(contextPercent, result.archived);
    } else {
      // Prevent infinite loop if nothing new
      markAutoSaved(transcriptPath, contextPercent, 0);
    }
    // markAutoSaved sets isSaving=false
  } catch (error) {
    // Ensure we clear the lock even on error
    setSavingState(false, null);
  }
}

async function handlePreCompact() {
  debugLog('handlePreCompact', 'Hook invoked');
  const stdin = await readStdin();
  debugLog('handlePreCompact', 'Stdin received', { hasStdin: !!stdin, cwd: stdin?.cwd, transcriptPath: stdin?.transcript_path });
  const config = loadConfig();

  // Clear the persistent save notification (user is running /clear)
  resetAutoSaveState();

  if (!config.autosave.onPreCompact) {
    debugLog('handlePreCompact', 'Disabled by config');
    return;
  }

  if (!stdin?.transcript_path) {
    debugLog('handlePreCompact', 'No transcript path - aborting');
    console.log(`${ANSI.brick}Ψ${ANSI.reset} No transcript available for archiving`);
    return;
  }

  const projectId = config.archive.projectScope && stdin.cwd
    ? getProjectId(stdin.cwd)
    : null;

  // Daemon mode: archive + restoration through the shared daemon
  // (hook timeout is 60s; fall back to local mode if the daemon fails)
  if (config.daemon.enabled && (await ensureDaemon(5000))) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} Auto-archiving before compact...`);
    const result = await requestDaemonArchive({
      transcriptPath: stdin.transcript_path,
      projectId,
      contextPercent: getContextPercent(stdin),
      timeoutMs: 45000,
    });

    if (result) {
      console.log(`${ANSI.brick}Ψ${ANSI.reset} Archived ${result.archived} fragments (${result.duplicates} duplicates skipped)`);

      const restoration = await requestDaemonRestore({
        projectId,
        messageCount: config.restoration.messageCount,
        tokenBudget: config.restoration.tokenBudget,
      });

      const awareness = buildAwarenessContext(config);
      const hasRestoration = restoration?.hasContent ?? false;

      if (hasRestoration || awareness) {
        console.log('');
        console.log(`${ANSI.cyan}=== Restoration Context ===${ANSI.reset}`);
        if (awareness) {
          console.log(awareness);
          if (hasRestoration) console.log('');
        }
        if (hasRestoration && restoration) {
          console.log(restoration.formatted);
        }
        console.log(`${ANSI.cyan}===========================${ANSI.reset}`);
      }
      return;
    }
    // Daemon call failed: fall through to local archive
  }

  const db = await initDb();

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Auto-archiving before compact...`);

  const result = await archiveSession(db, stdin.transcript_path, projectId, {
    onProgress: (current, total) => {
      process.stdout.write(`\r${ANSI.brick}Ψ${ANSI.reset} Embedding ${current}/${total}...`);
    },
  });

  console.log('');
  console.log(`${ANSI.brick}Ψ${ANSI.reset} Archived ${result.archived} fragments (${result.duplicates} duplicates skipped)`);

  // Build restoration context for after compact
  const restoration = await buildRestorationContext(db, projectId, {
    messageCount: config.restoration.messageCount,
    tokenBudget: config.restoration.tokenBudget,
  });

  const awareness = buildAwarenessContext(config);

  if (restoration.hasContent || awareness) {
    console.log('');
    console.log(`${ANSI.cyan}=== Restoration Context ===${ANSI.reset}`);
    if (awareness) {
      console.log(awareness);
      if (restoration.hasContent) console.log('');
    }
    if (restoration.hasContent) {
      console.log(formatRestorationContext(restoration));
    }
    console.log(`${ANSI.cyan}===========================${ANSI.reset}`);
  }
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleSave(args: string[]) {
  const stdin = await readStdin();
  const config = loadConfig();

  // Parse arguments
  let transcriptPath = '';
  let forceGlobal = false;

  for (const arg of args) {
    if (arg === '--all' || arg === '--global') {
      forceGlobal = true;
    } else if (arg.startsWith('--transcript=')) {
      transcriptPath = arg.slice('--transcript='.length);
    } else if (!arg.startsWith('--')) {
      transcriptPath = arg;
    }
  }

  // Get transcript path from stdin if not provided
  if (!transcriptPath && stdin?.transcript_path) {
    transcriptPath = stdin.transcript_path;
  }

  if (!transcriptPath) {
    console.log('Usage: cortex save [--transcript=PATH] [--global]');
    console.log('       Or pipe stdin data from Claude Code');
    return;
  }

  const db = await initDb();
  const projectId = forceGlobal
    ? null
    : config.archive.projectScope && stdin?.cwd
      ? getProjectId(stdin.cwd)
      : null;

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Archiving session${projectId ? ` to ${projectId}` : ' (global)'}...`);

  const result = await archiveSession(db, transcriptPath, projectId, {
    onProgress: (current, total) => {
      process.stdout.write(`\r${ANSI.brick}Ψ${ANSI.reset} Processing ${current}/${total}...`);
    },
  });

  console.log('');
  console.log(formatArchiveResult(result));
}

async function handleRecall(args: string[]) {
  const stdin = await readStdin();

  // Parse arguments
  let query = '';
  let includeAll = false;

  for (const arg of args) {
    if (arg === '--all' || arg === '--global') {
      includeAll = true;
    } else if (!arg.startsWith('--')) {
      query += (query ? ' ' : '') + arg;
    }
  }

  if (!query) {
    console.log('Usage: cortex recall <query> [--all]');
    console.log('       --all: Search across all projects');
    return;
  }

  const db = await initDb();
  const projectId = stdin?.cwd ? getProjectId(stdin.cwd) : null;

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Searching${includeAll ? ' all projects' : projectId ? ` in ${projectId}` : ''}...`);

  const results = await hybridSearch(db, query, {
    projectScope: !includeAll,
    projectId: projectId || undefined,
    includeAllProjects: includeAll,
    limit: 5,
  });

  console.log(formatSearchResults(results));
}

/**
 * UserPromptSubmit hook: inject memories relevant to the user's prompt.
 * Anything printed to stdout is appended to the conversation context, so
 * this handler prints EITHER a well-formed injection block or nothing.
 * All failures are silent (stderr only) - a memory feature must never
 * break prompt submission.
 */
async function handleAutoRecall() {
  const stdin = await readStdin();
  const config = loadConfig();

  if (!config.recall.auto) return;

  const prompt = stdin?.prompt ?? '';
  if (!isPromptEligible(prompt, config.recall)) return;

  const sessionId = stdin?.session_id ?? 'unknown-session';
  const projectId = stdin?.cwd ? getProjectId(stdin.cwd) : null;

  const state = loadRecallState();
  const alreadyInjected = getInjectedIds(state, sessionId);

  // Fetch more than maxResults so threshold + dedup still leave choices
  const fetchLimit = config.recall.maxResults * 3;

  // Daemon-first: the daemon holds the model, so search is a cheap HTTP
  // round-trip. Fallback loads the embedding model in-process (slower;
  // daemon mode is recommended when auto-recall is on).
  let results = await requestDaemonRecall({
    query: prompt,
    projectId,
    limit: fetchLimit,
    minScore: config.recall.minScore,
  });

  if (results === null) {
    // In daemon mode, never open the DB locally as a fallback: the daemon
    // may hold it in native/WAL form, which sql.js would read stale (and
    // its close-time write-back could lose WAL contents). Skip instead.
    if (config.daemon.enabled) {
      debugLog('handleAutoRecall', 'Daemon unreachable or missing /recall; skipping (daemon mode)');
      return;
    }
    try {
      const db = await initDb();
      results = await vectorSearch(db, prompt, {
        projectScope: projectId !== null,
        projectId: projectId ?? undefined,
        limit: fetchLimit,
      });
    } catch (error) {
      debugLog('handleAutoRecall', 'Local search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const selected = selectForInjection(results, config.recall, alreadyInjected);
  if (selected.length === 0) return;

  console.log(formatInjection(selected, projectId));
  recordInjection(state, sessionId, selected.map((r) => r.id));
}

async function handleStats() {
  const stdin = await readStdin();
  const db = await initDb();
  const stats = getStats(db);

  const lines: string[] = [];
  lines.push('');
  lines.push('Cortex Memory Stats');
  lines.push('------------------------');
  lines.push(`  Fragments: ${stats.fragmentCount}`);
  lines.push(`  Projects:  ${stats.projectCount}`);
  lines.push(`  Sessions:  ${stats.sessionCount}`);
  lines.push(`  DB Size:   ${formatBytes(stats.dbSizeBytes)}`);
  lines.push(`  Model:     ${getModelName()}`);

  if (stats.oldestTimestamp) {
    lines.push(`  Oldest:    ${stats.oldestTimestamp.toLocaleDateString()}`);
  }

  if (stats.newestTimestamp) {
    lines.push(`  Newest:    ${stats.newestTimestamp.toLocaleDateString()}`);
  }

  // Project-specific stats if we have stdin
  if (stdin?.cwd) {
    const projectId = getProjectId(stdin.cwd);
    const projectStats = getProjectStats(db, projectId);

    lines.push('');
    lines.push(`Project: ${projectId}`);
    lines.push(`  Fragments: ${projectStats.fragmentCount}`);
    lines.push(`  Sessions:  ${projectStats.sessionCount}`);

    if (projectStats.lastArchive) {
      lines.push(`  Last Save: ${formatDuration(projectStats.lastArchive)}`);
    }
  }

  console.log(lines.join('\n'));
}

async function handleSetup(setupArgs: string[] = []) {
  console.log(`${ANSI.brick}Ψ${ANSI.reset} Setting up Cortex...`);

  // Ensure data directory exists
  ensureDataDir();
  console.log(`  ✓ Data directory: ${getDataDir()}`);

  // Initialize database
  const db = await initDb();
  saveDb(db);
  console.log('  ✓ Database initialized');

  // Check and install dependencies if needed
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const pluginDir = new URL('.', import.meta.url).pathname.replace('/dist/', '');
  const nodeModulesPath = `${pluginDir}/node_modules`;

  if (!fs.existsSync(nodeModulesPath)) {
    console.log('  ⏳ Installing dependencies (first run only)...');

    const { execSync } = await import('child_process');
    try {
      execSync('npm install', {
        cwd: pluginDir,
        stdio: 'pipe',
        timeout: 120000
      });
      console.log('  ✓ Dependencies installed');
    } catch (installError) {
      console.log(`  ✗ Install failed: ${installError instanceof Error ? installError.message : String(installError)}`);
      console.log('');
      console.log('Manual fix:');
      console.log(`  cd ${pluginDir} && npm install`);
      return;
    }
  }

  // Verify embedding model
  console.log('  ⏳ Loading embedding model (first run may take a minute)...');
  const modelStatus = await verifyModel();

  if (modelStatus.success) {
    console.log(`  ✓ Model loaded: ${modelStatus.model} (${modelStatus.dimensions}d)`);
  } else {
    console.log(`  ✗ Model failed: ${modelStatus.error}`);
    return;
  }

  // Configure statusline in ~/.claude/settings.json
  console.log('  ⏳ Configuring statusline...');
  const claudeDir = path.join(os.homedir(), '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');

  // Get plugin path - use CLAUDE_PLUGIN_ROOT env var or derive from current location
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || pluginDir;

  // Configure statusline (chains with existing non-Cortex statuslines)
  const statuslineResult = configureClaudeStatusline(claudeSettingsPath, pluginRoot);

  if (statuslineResult.configured && statuslineResult.chained) {
    console.log('  ✓ Statusline configured (chained with existing)');
    console.log(`    Your original statusline will run first, followed by Cortex.`);
    console.log(`    Original: ${statuslineResult.chainedCommand}`);
  } else if (statuslineResult.configured) {
    console.log('  ✓ Statusline configured');
  } else if (statuslineResult.skipped) {
    console.log('  ⚠ Statusline skipped (existing configuration detected)');
    console.log('');
    console.log(`${ANSI.yellow}Existing statusline:${ANSI.reset}`);
    console.log(`  ${statuslineResult.existingCommand}`);
    console.log('');
    console.log('To use Cortex statusline instead, either:');
    console.log('  1. Remove the existing statusLine from ~/.claude/settings.json');
    console.log('  2. Or manually set it to:');
    console.log(`     "statusLine": { "type": "command", "command": "node ${pluginRoot}/dist/index.js statusline" }`);
  }

  // Optional shared daemon mode (one DB + one model for ALL sessions)
  if (setupArgs.includes('--daemon')) {
    const current = loadConfig();
    updateConfig({ daemon: { ...current.daemon, enabled: true } });
    console.log('  ⏳ Enabling shared daemon mode (single DB + model for all sessions)...');
    const daemonReady = await ensureDaemon();
    if (daemonReady) {
      console.log('  ✓ Daemon running');
    } else {
      console.log('  ⚠ Daemon could not be started - sessions will fall back to local mode');
    }
  } else {
    console.log('');
    console.log(`${ANSI.dim}Tip: running many Claude Code sessions? Enable shared daemon mode so they${ANSI.reset}`);
    console.log(`${ANSI.dim}all share ONE database + embedding model (large RAM/disk savings):${ANSI.reset}`);
    console.log(`${ANSI.dim}  /cortex-configure daemon on   (or: node dist/index.js configure daemon on)${ANSI.reset}`);
  }

  // Mark setup as complete
  markSetupComplete();
  console.log('  ✓ Setup marked complete');

  // Save current session so MCP tools can access transcript path
  const stdin = await readStdin();
  if (stdin?.transcript_path) {
    const projectId = stdin.cwd ? getProjectId(stdin.cwd) : null;
    saveCurrentSession(stdin.transcript_path, projectId);
    console.log('  ✓ Session registered');
  }

  console.log('');
  console.log(`${ANSI.brick}Ψ${ANSI.reset} Setup complete!`);
  console.log('');
  console.log(`${ANSI.yellow}Now restart Claude Code to enable memory tools${ANSI.reset}`);
  console.log('');
  console.log('Commands available:');
  console.log('  /cortex:save     - Archive session context');
  console.log('  /cortex:recall   - Search memories');
  console.log('  /cortex:stats    - View memory statistics');
  console.log('  /cortex:configure - Adjust settings');
}

async function handleConfigure(args: string[]) {
  // Daemon (shared server) mode toggle: configure daemon on|off|status
  if (args[0] === 'daemon') {
    const action = args[1];
    const current = loadConfig();

    if (action === 'on' || action === 'enable') {
      updateConfig({ daemon: { ...current.daemon, enabled: true } });
      console.log(`${ANSI.brick}Ψ${ANSI.reset} Daemon mode ${ANSI.green}enabled${ANSI.reset} (shared server on 127.0.0.1:${current.daemon.port})`);
      const ready = await ensureDaemon();
      console.log(ready ? '  ✓ Daemon started' : '  ⚠ Daemon could not be started (will retry on next session)');
      console.log('  Restart Claude Code sessions to route memory tools through the daemon.');
    } else if (action === 'off' || action === 'disable') {
      updateConfig({ daemon: { ...current.daemon, enabled: false } });
      await stopDaemon();
      console.log(`${ANSI.brick}Ψ${ANSI.reset} Daemon mode ${ANSI.yellow}disabled${ANSI.reset} (classic per-process mode)`);
      console.log('  Restart Claude Code sessions to apply.');
    } else {
      const health = await getDaemonHealth();
      console.log(`Daemon mode:    ${current.daemon.enabled ? 'enabled' : 'disabled'} (port ${current.daemon.port})`);
      console.log(`Daemon process: ${health ? `running v${health.version} (pid ${health.pid}, up ${health.uptime}s)` : 'not running'}`);
      if (health && health.version !== VERSION) {
        console.log(`${ANSI.yellow}Note: daemon is v${health.version} but plugin is v${VERSION} - it will be replaced on next use.${ANSI.reset}`);
      }
    }
    return;
  }

  if (args[0] === 'recall') {
    const action = args[1];
    const current = loadConfig();

    if (action === 'on' || action === 'enable') {
      updateConfig({ recall: { ...current.recall, auto: true } });
      console.log(`${ANSI.brick}Ψ${ANSI.reset} Auto-recall ${ANSI.green}enabled${ANSI.reset}`);
      console.log(`  Relevant memories (similarity >= ${current.recall.minScore}) are injected on each prompt.`);
      if (!current.daemon.enabled) {
        console.log(`  ${ANSI.yellow}Tip:${ANSI.reset} enable daemon mode (configure daemon on) - without it each prompt loads the embedding model.`);
      }
      console.log('  Restart Claude Code sessions to activate the hook.');
    } else if (action === 'off' || action === 'disable') {
      updateConfig({ recall: { ...current.recall, auto: false } });
      console.log(`${ANSI.brick}Ψ${ANSI.reset} Auto-recall ${ANSI.yellow}disabled${ANSI.reset}`);
    } else {
      console.log(`Auto-recall:  ${current.recall.auto ? 'enabled' : 'disabled'}`);
      console.log(`  minScore:        ${current.recall.minScore} (cosine similarity threshold)`);
      console.log(`  maxResults:      ${current.recall.maxResults}`);
      console.log(`  tokenBudget:     ${current.recall.tokenBudget}`);
      console.log(`  minPromptLength: ${current.recall.minPromptLength}`);
    }
    return;
  }

  const preset = args[0] as ConfigPreset | undefined;

  if (preset && ['full', 'essential', 'minimal'].includes(preset)) {
    const config = applyPreset(preset);
    console.log(`${ANSI.brick}Ψ${ANSI.reset} Applied "${preset}" preset`);
    console.log('');
    console.log('Configuration:');
    console.log(`  Statusline: ${config.statusline.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Auto-archive (PreCompact): ${config.autosave.onPreCompact ? 'enabled' : 'disabled'}`);
    console.log(`  Auto-save (Context Step): ${config.autosave.contextStep.enabled ? config.autosave.contextStep.step + '%' : 'disabled'}`);
    return;
  }

  console.log('Usage: cortex configure <preset>');
  console.log('       cortex configure daemon on|off|status');
  console.log('');
  console.log('Presets:');
  console.log('  full      - All features enabled (statusline, auto-archive, auto-save)');
  console.log('  essential - Statusline + auto-archive only');
  console.log('  minimal   - Commands only (no hooks/statusline)');
  console.log('');
  console.log('Daemon mode:');
  console.log('  daemon on     - Share ONE database + embedding model across all sessions');
  console.log('  daemon off    - Classic per-process mode (default)');
  console.log('  daemon status - Show daemon mode config and process state');
  console.log('');
  console.log('Auto-recall:');
  console.log('  recall on     - Inject relevant memories on each prompt (UserPromptSubmit)');
  console.log('  recall off    - Disable auto-recall (default)');
  console.log('  recall status - Show auto-recall config');
}

async function handleTestEmbed(text: string) {
  console.log(`${ANSI.brick}Ψ${ANSI.reset} Testing embedding for: "${text}"`);

  const result = await verifyModel();

  if (result.success) {
    console.log(`  Model: ${result.model}`);
    console.log(`  Dimensions: ${result.dimensions}`);
    console.log('  ✓ Embedding generation working');
  } else {
    console.log(`  ✗ Error: ${result.error}`);
  }
}

// ============================================================================
// Daemon Commands
// ============================================================================

async function handleEnsureDaemon() {
  const config = loadConfig();
  if (!config.daemon.enabled) {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} Daemon mode is disabled. Enable with: configure daemon on`);
    return;
  }

  const ready = await ensureDaemon();
  if (ready) {
    const health = await getDaemonHealth();
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.green}Daemon running${ANSI.reset} v${health?.version} (pid ${health?.pid}, port ${health?.port})`);
  } else {
    console.log(`${ANSI.brick}Ψ${ANSI.reset} ${ANSI.red}Failed to start daemon${ANSI.reset}`);
    process.exitCode = 1;
  }
}

async function handleDaemonStatus() {
  const config = loadConfig();
  const health = await getDaemonHealth();

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Cortex Daemon`);
  console.log(`  Mode:    ${config.daemon.enabled ? `${ANSI.green}enabled${ANSI.reset}` : 'disabled'} (port ${config.daemon.port})`);
  if (health) {
    console.log(`  Process: running v${health.version} (pid ${health.pid}, up ${health.uptime}s)`);
    if (health.version !== VERSION) {
      console.log(`  ${ANSI.yellow}⚠ Daemon is v${health.version}, plugin is v${VERSION} - it will be auto-replaced on next use${ANSI.reset}`);
    }
  } else {
    console.log('  Process: not running');
  }
}

async function handleDaemonStop() {
  const requested = await stopDaemon();
  console.log(
    requested
      ? `${ANSI.brick}Ψ${ANSI.reset} Daemon stop requested`
      : `${ANSI.brick}Ψ${ANSI.reset} Daemon not running`
  );
}

/**
 * Compact the database: prune bookkeeping tables, optionally age out old
 * memories (--prune-days=N, destructive, off by default), then VACUUM.
 * Routes through the daemon when one is running so compaction never races
 * another writer.
 */
async function handleCompact(args: string[]) {
  let keepTurns = 50;
  let pruneDays: number | null = null;

  for (const arg of args) {
    if (arg.startsWith('--keep-turns=')) {
      keepTurns = parseInt(arg.slice('--keep-turns='.length), 10) || 50;
    } else if (arg.startsWith('--prune-days=')) {
      const parsed = parseInt(arg.slice('--prune-days='.length), 10);
      pruneDays = Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
    }
  }

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Compacting database${pruneDays ? ` (pruning memories older than ${pruneDays} days)` : ''}...`);

  interface CompactReport {
    turnsDeleted: number;
    progressDeleted: number;
    memoriesDeleted: number;
    sizeBefore: number;
    sizeAfter: number;
    storage?: string;
  }

  let report: CompactReport;

  const health = await getDaemonHealth();
  if (health) {
    // A daemon owns the database - compact through it (VACUUM on a large
    // DB can take a while, so allow a long timeout)
    const result = await daemonFetch('/compact', {
      method: 'POST',
      body: { keepTurns, pruneMemoriesOlderThanDays: pruneDays },
      timeoutMs: 600000,
    }).catch((error) => {
      console.log(`${ANSI.red}Compaction via daemon failed: ${error instanceof Error ? error.message : String(error)}${ANSI.reset}`);
      return null;
    });
    if (!result) {
      process.exitCode = 1;
      return;
    }
    report = result as CompactReport;
  } else {
    const config = loadConfig();
    if (config.daemon.enabled) {
      console.log(`${ANSI.yellow}⚠ Daemon mode is enabled but no daemon is running - compacting locally.${ANSI.reset}`);
      console.log(`${ANSI.yellow}  Make sure no other Cortex sessions are writing while this runs.${ANSI.reset}`);
    }
    const db = await initDb();
    report = { ...compactDatabase(db, { keepTurns, pruneMemoriesOlderThanDays: pruneDays }), storage: getStorageKind() };
  }

  console.log('');
  console.log('Compaction Complete');
  console.log('-------------------');
  console.log(`  Turns pruned:    ${report.turnsDeleted}`);
  console.log(`  Progress pruned: ${report.progressDeleted}`);
  if (pruneDays) {
    console.log(`  Memories pruned: ${report.memoriesDeleted}`);
  }
  console.log(`  Size:            ${formatBytes(report.sizeBefore)} -> ${formatBytes(report.sizeAfter)}`);
  if (report.storage) {
    console.log(`  Backend:         ${report.storage}`);
  }
}

/**
 * Remote backup: snapshot -> gzip -> rclone upload -> rotate.
 * Routes through the daemon when one is running (consistent snapshot from
 * the live handle); otherwise snapshots straight from the file.
 * Flags: --status (show last backup), --if-due (exit quietly unless the
 * scheduled interval has elapsed), --direct (skip the daemon and snapshot
 * from the file - used by the daemon's shutdown handoff, whose DB handle
 * is already closed while its port is still briefly open).
 */
async function handleBackup(args: string[]) {
  const config = loadConfig();
  const ifDue = args.includes('--if-due');
  const direct = args.includes('--direct');

  if (args.includes('--status')) {
    const state = loadBackupState();
    console.log(`${ANSI.brick}Ψ${ANSI.reset} Cortex Backup`);
    console.log(`  Scheduled: ${config.backup.enabled ? `${ANSI.green}enabled${ANSI.reset} (every ${config.backup.intervalMinutes}min, keep ${config.backup.keep})` : 'disabled'}`);
    console.log(`  Remote:    ${config.backup.remote ?? `${ANSI.yellow}not configured${ANSI.reset}`}`);
    if (state.lastBackupAt) {
      console.log(`  Last:      ${state.lastBackupAt} (${state.lastResult})${state.lastRemoteName ? ` ${ANSI.dim}${state.lastRemoteName}${ANSI.reset}` : ''}`);
    } else {
      console.log('  Last:      never');
    }
    if (state.lastError) {
      console.log(`  ${ANSI.red}Error: ${state.lastError}${ANSI.reset}`);
    }
    return;
  }

  if (!config.backup.remote) {
    if (ifDue) return;
    console.log(`${ANSI.yellow}⚠ No backup remote configured.${ANSI.reset}`);
    console.log('  1. Install rclone and run `rclone config` to add a remote (e.g. Google Drive as "gdrive")');
    console.log('  2. Set backup.remote in ~/.cortex/config.json, e.g. "gdrive:cortex-backups"');
    console.log('  3. Optionally set backup.enabled=true for scheduled backups (daemon mode)');
    process.exitCode = 1;
    return;
  }

  if (ifDue && !isBackupDue(config.backup)) {
    return;
  }

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Backing up to ${config.backup.remote}...`);

  let result: BackupResult | null = null;
  const health = direct ? null : await getDaemonHealth();
  if (health) {
    // A daemon owns the database - snapshot through it (upload of a large
    // snapshot can take a while, so allow a long timeout). A pre-backup
    // daemon (older version) 404s the route - fall through to the local
    // path, which snapshots safely via VACUUM INTO on a second connection.
    try {
      result = (await daemonFetch('/backup', {
        method: 'POST',
        timeoutMs: 20 * 60 * 1000,
      })) as BackupResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        console.log(`${ANSI.red}Backup via daemon failed: ${message}${ANSI.reset}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  if (!result) {
    try {
      result = await runBackup();
    } catch (error) {
      console.log(`${ANSI.red}Backup failed: ${error instanceof Error ? error.message : String(error)}${ANSI.reset}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`  ${ANSI.green}✓${ANSI.reset} Uploaded ${result.remoteName} (${formatBytes(result.sizeBytes)} in ${Math.round(result.durationMs / 1000)}s)`);
  if (result.rotatedOut.length > 0) {
    console.log(`  ${ANSI.dim}Rotated out ${result.rotatedOut.length} old snapshot(s)${ANSI.reset}`);
  }
}

/**
 * Bidirectional memory sync through a shared rclone remote.
 * Routes through the daemon when one is running (sync writes to the DB and
 * must be serialized with other writers). Without a daemon, syncs locally.
 * Flags: --status, --push (push only), --pull (pull only).
 */
async function handleSync(args: string[]) {
  const config = loadConfig();

  if (args.includes('--status')) {
    const state = loadSyncState();
    console.log(`${ANSI.brick}Ψ${ANSI.reset} Cortex Sync`);
    console.log(`  Scheduled: ${config.sync.enabled ? `${ANSI.green}enabled${ANSI.reset} (every ${config.sync.intervalMinutes}min)` : 'disabled'}`);
    console.log(`  Remote:    ${config.sync.remote ?? `${ANSI.yellow}not configured${ANSI.reset}`}`);
    console.log(`  Device:    ${state.deviceId ?? `${ANSI.dim}(assigned on first sync)${ANSI.reset}`}`);
    console.log(`  Projects:  ${config.sync.projects ? config.sync.projects.join(', ') : 'all'}`);
    if (state.lastSyncAt) {
      console.log(`  Last:      ${state.lastSyncAt} (${state.lastResult})`);
    } else {
      console.log('  Last:      never');
    }
    const peerNames = Object.keys(state.peers);
    if (peerNames.length > 0) {
      console.log(`  Peers:     ${peerNames.map((p) => `${p} (seq ${state.peers[p]})`).join(', ')}`);
    }
    if (state.lastError) {
      console.log(`  ${ANSI.red}Error: ${state.lastError}${ANSI.reset}`);
    }
    return;
  }

  if (!config.sync.remote) {
    console.log(`${ANSI.yellow}⚠ No sync remote configured.${ANSI.reset}`);
    console.log('  1. Install rclone and run `rclone config` to add a remote (shared by all devices)');
    console.log('  2. Set sync.remote in ~/.cortex/config.json, e.g. "gdrive:cortex-sync"');
    console.log('  3. Optionally set sync.enabled=true for scheduled syncs (daemon mode)');
    console.log('  All devices must use the same embedding model.');
    process.exitCode = 1;
    return;
  }

  const options = {
    push: !args.includes('--pull'),
    pull: !args.includes('--push'),
  };

  console.log(`${ANSI.brick}Ψ${ANSI.reset} Syncing with ${config.sync.remote}...`);

  let result: SyncResult;
  const health = await getDaemonHealth();
  if (health) {
    // A daemon owns the database - sync must go through it. Unlike backup
    // there is no safe local fallback: sync WRITES, and a concurrent
    // full-file save from the daemon would clobber those writes.
    try {
      result = (await daemonFetch('/sync', {
        method: 'POST',
        body: options,
        timeoutMs: 30 * 60 * 1000,
      })) as SyncResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('404')) {
        console.log(`${ANSI.red}The running daemon (v${health.version}) predates sync support. Restart it (node dist/index.js daemon-stop) and retry.${ANSI.reset}`);
      } else {
        console.log(`${ANSI.red}Sync via daemon failed: ${message}${ANSI.reset}`);
      }
      process.exitCode = 1;
      return;
    }
  } else {
    try {
      const db = await initDb();
      result = await runSync(db, options);
      saveDb(db);
    } catch (error) {
      console.log(`${ANSI.red}Sync failed: ${error instanceof Error ? error.message : String(error)}${ANSI.reset}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`  ${ANSI.green}✓${ANSI.reset} Device ${result.deviceId} synced in ${Math.round(result.durationMs / 1000)}s`);
  console.log(`  Pushed: ${result.pushed.memories} memories, ${result.pushed.tombstones} deletions (${result.pushed.files} file(s))`);
  console.log(`  Pulled: ${result.pulled.added} memories, ${result.pulled.deleted} deletions from ${result.pulled.peers.length} peer(s)`);
  for (const err of result.pulled.errors ?? []) {
    console.log(`  ${ANSI.yellow}⚠ Peer skipped this run: ${err}${ANSI.reset}`);
  }
}

async function handleCheckDb() {
  console.log(`${ANSI.brick}Ψ${ANSI.reset} Database Integrity Check`);
  console.log('================================');

  let hasErrors = false;

  try {
    const db = await initDb();
    const validation = validateDatabase(db);

    // Schema validation
    console.log('');
    console.log('Schema Validation:');
    if (validation.tablesFound.length > 0) {
      console.log(`  Tables found: ${validation.tablesFound.join(', ')}`);
    }
    if (validation.errors.length === 0) {
      console.log(`  ${ANSI.green}✓${ANSI.reset} All required tables present`);
    } else {
      for (const error of validation.errors) {
        console.log(`  ${ANSI.red}✗${ANSI.reset} ${error}`);
        hasErrors = true;
      }
    }

    // SQLite integrity check
    console.log('');
    console.log('SQLite Integrity:');
    if (validation.integrityCheck) {
      console.log(`  ${ANSI.green}✓${ANSI.reset} PRAGMA integrity_check passed`);
    } else {
      console.log(`  ${ANSI.red}✗${ANSI.reset} Integrity check failed`);
      hasErrors = true;
    }

    // FTS5 availability
    console.log('');
    console.log('FTS5 Full-Text Search:');
    if (validation.fts5Available) {
      console.log(`  ${ANSI.green}✓${ANSI.reset} FTS5 table available`);
    } else {
      console.log(`  ${ANSI.yellow}⚠${ANSI.reset} FTS5 not available (using LIKE fallback)`);
    }

    // Embedding dimension check
    console.log('');
    console.log('Embeddings:');
    if (validation.embeddingDimension !== null) {
      if (validation.embeddingDimension === 768) {
        console.log(`  ${ANSI.green}✓${ANSI.reset} Embedding dimension: ${validation.embeddingDimension} (expected)`);
      } else {
        console.log(`  ${ANSI.yellow}⚠${ANSI.reset} Embedding dimension: ${validation.embeddingDimension} (expected 768)`);
      }
    } else {
      console.log(`  ${ANSI.dim}No embeddings stored yet${ANSI.reset}`);
    }

    // Backup status
    console.log('');
    console.log('Backups:');
    const backups = getBackupFiles();
    if (backups.length > 0) {
      console.log(`  ${ANSI.green}✓${ANSI.reset} ${backups.length} backup(s) available`);
    } else {
      console.log(`  ${ANSI.yellow}⚠${ANSI.reset} No backups found`);
    }

    // Warnings
    if (validation.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (const warning of validation.warnings) {
        console.log(`  ${ANSI.yellow}⚠${ANSI.reset} ${warning}`);
      }
    }

    // Summary
    console.log('');
    console.log('--------------------------------');
    if (hasErrors) {
      console.log(`${ANSI.red}Database has errors. Consider restoring from backup.${ANSI.reset}`);
      process.exit(1);
    } else if (validation.warnings.length > 0) {
      console.log(`${ANSI.yellow}Database is functional with ${validation.warnings.length} warning(s).${ANSI.reset}`);
    } else {
      console.log(`${ANSI.green}Database is healthy.${ANSI.reset}`);
    }
  } catch (error) {
    console.log(`${ANSI.red}✗ Failed to check database: ${error instanceof Error ? error.message : String(error)}${ANSI.reset}`);
    process.exit(1);
  }
}

// ============================================================================
// Exports for testing
// ============================================================================

export {
  handleStatusline,
  handleSessionStart,
  handleSessionEnd,
  handlePostTool,
  handlePreCompact,
  handleSave,
  handleRecall,
  handleStats,
  handleSetup,
  handleConfigure,
  handleCheckDb,
  // Export helpers for testing
  shouldAutoSave,
  markAutoSaved,
  resetAutoSaveState,
  loadAutoSaveState,
  archiveSession,
  initDb,
  closeDb,
  hybridSearch,
  compactDatabase,
  getStorageKind,
  // Export statusline configuration for testing
  configureClaudeStatusline,
  buildCortexStatuslineCommand,
  // Export stdin helpers for testing
  readStdinWithResult,
  getContextPercent,
  getProjectId,
  formatDuration,
  // Export backup helpers for testing
  runBackup,
  isBackupDue,
  loadBackupState,
  getBackupStatePath,
  // Export sync helpers for testing
  runSync,
  isSyncDue,
  loadSyncState,
  getSyncStatePath,
  ensureDeviceId,
  insertMemory,
  deleteMemory,
  saveDb,
  // Export auto-recall helpers for testing
  isPromptEligible,
  selectForInjection,
  formatInjection,
  loadRecallState,
  getInjectedIds,
  recordInjection,
  getRecallStatePath,
  vectorSearch,
  embedQuery,
  loadConfig,
  // Export identity + project-config helpers for testing
  resolveUser,
  resolveProject,
  resolveEnvironment,
  resolveIdentity,
  sanitizeLabel,
  getProjectConfigDir,
  getProjectConfigPath,
  getMemory,
  buildScopeClause,
  searchByKeyword,
  searchByVector,
  // Export remote-adapter helpers for testing
  isRemoteModeEnabled,
  getRemoteUrl,
  getRemoteToken,
  getDaemonBaseUrl,
  isServerMode,
  getBindHost,
  getServerToken,
  isAuthorized,
  spawnDaemonDetached,
  stopDaemon,
  ensureDaemon
};

// Run main only when executed directly (not when imported)
// Check if this file is the entry point by looking for CORTEX_CLI environment marker
// or if running as CLI (has command line args that look like CLI usage)
const isDirectRun = process.argv[1]?.endsWith('index.js') ||
                    process.argv[1]?.endsWith('index.ts') ||
                    process.env.CORTEX_CLI === '1';
const isTestImport = process.argv[1]?.includes('node:test') ||
                     process.argv[1]?.includes('/test') ||
                     process.env.NODE_TEST_CONTEXT;

if (isDirectRun || (!isTestImport && process.argv.length > 1)) {
  main();
}
