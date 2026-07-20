/**
 * Cortex TypeScript Types
 */

// ============================================================================
// Stdin Data (from Claude Code)
// Matches Claude Code's actual JSON structure
// ============================================================================

/**
 * Discriminated union for stdin read results with error context
 */
export type StdinReadResult =
  | { success: true; data: StdinData }
  | { success: false; data: null; error: StdinReadError };

export interface StdinReadError {
  type: 'empty' | 'parse_error' | 'read_error' | 'tty';
  message: string;
  raw?: string;
}

export interface StdinData {
  transcript_path?: string;
  cwd?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    // Native percentage fields (Claude Code v2.1.6+)
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
}

// ============================================================================
// Database Types
// ============================================================================

export interface Memory {
  id: number;
  content: string;
  contentHash: string;
  embedding: Float32Array;
  projectId: string | null;
  sourceSession: string;
  timestamp: Date;
}

/**
 * Input type for creating a new memory
 * contentHash is computed from content, id is auto-generated
 */
export type MemoryInput = Omit<Memory, 'id' | 'contentHash'>;

export interface DbStats {
  fragmentCount: number;
  projectCount: number;
  sessionCount: number;
  dbSizeBytes: number;
  oldestTimestamp: Date | null;
  newestTimestamp: Date | null;
}

export interface ProjectStats {
  fragmentCount: number;
  sessionCount: number;
  lastArchive: Date | null;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchResult {
  id: number;
  score: number;
  content: string;
  source: 'vector' | 'keyword' | 'hybrid';
  timestamp: Date;
  projectId: string | null;
}

export interface SearchOptions {
  projectScope?: boolean;
  projectId?: string;
  limit?: number;
  includeAllProjects?: boolean;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface StatuslineConfig {
  enabled: boolean;
  showFragments: boolean;
  showLastArchive: boolean;
  showContext: boolean;
  chainedCommand?: string;
}

export interface ArchiveConfig {
  projectScope: boolean;
  minContentLength: number;
}

// MonitorConfig removed - no longer using context threshold warnings

export interface AutosaveConfig {
  // Save on session end (logout, exit, close)
  onSessionEnd: boolean;

  // Save before compact (/clear, /compact, auto-compact)
  onPreCompact: boolean;

  // Time interval trigger (approximate - checked during tool use)
  // Replaced by Context Step
  contextStep: {
    enabled: boolean;
    step: number;     // Save every X% increase
  };
}

export interface RestorationConfig {
  tokenBudget: number;      // Max tokens for restoration context (default 2000)
  messageCount: number;     // Number of semantic fragments to restore (default 5)
  turnCount: number;        // Number of raw conversation turns to restore (default 3)
}

export interface SetupConfig {
  completed: boolean;
  completedAt: string | null;
}

export interface AwarenessConfig {
  enabled: boolean;
  userName: string | null;
  timezone: string | null;
}

/**
 * Opt-in shared daemon mode.
 * When enabled, MCP requests and hook/statusline data go through one
 * shared HTTP daemon (single DB + embedding model) instead of each
 * process loading its own. Default: disabled (classic per-process mode).
 */
export interface DaemonConfig {
  enabled: boolean;
  port: number;
  /**
   * Storage backend for the daemon:
   * - 'auto' (default): use native better-sqlite3 when available
   *   (file-backed, WAL - the DB no longer lives in RAM), else sql.js
   * - 'wasm': force the classic sql.js backend
   * Classic (non-daemon) mode always uses sql.js regardless.
   */
  storage: 'auto' | 'wasm';
}

/**
 * Opt-in remote backup: periodic gzip snapshots of the database uploaded
 * to an rclone remote (Google Drive, S3, Dropbox, ...). The daemon runs the
 * schedule; `cortex backup` is the manual path. Default: disabled.
 */
export interface BackupConfig {
  enabled: boolean;
  /** rclone remote path, e.g. "gdrive:cortex-backups". null = unconfigured */
  remote: string | null;
  /** Minutes between scheduled backups (daemon mode) */
  intervalMinutes: number;
  /** Remote snapshots to keep; older ones are rotated out */
  keep: number;
}

/**
 * Opt-in bidirectional memory sync through a shared rclone remote.
 * Each device appends only its own changelog files; reconciliation is
 * set-union on content_hash plus tombstones for deletions. All devices
 * must use the same embedding model. Default: disabled.
 */
export interface SyncConfig {
  enabled: boolean;
  /** rclone remote path for changelogs, e.g. "gdrive:cortex-sync". null = unconfigured */
  remote: string | null;
  /** Minutes between scheduled syncs (daemon mode) */
  intervalMinutes: number;
  /** Only push memories from these projects (null = all). Pulls are unfiltered. */
  projects: string[] | null;
}

export interface Config {
  statusline: StatuslineConfig;
  archive: ArchiveConfig;
  autosave: AutosaveConfig;
  restoration: RestorationConfig;
  setup: SetupConfig;
  awareness: AwarenessConfig;
  daemon: DaemonConfig;
  backup: BackupConfig;
  sync: SyncConfig;
}

// ============================================================================
// Archive Types
// ============================================================================

export interface ArchiveResult {
  archived: number;
  skipped: number;
  duplicates: number;
}

export interface ArchiveOptions {
  onProgress?: (current: number, total: number) => void;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

/**
 * Result of parsing a transcript file with statistics
 */
export interface ParseResult {
  messages: TranscriptMessage[];
  stats: {
    totalLines: number;
    parsedLines: number;
    skippedLines: number;
    emptyLines: number;
    parseErrors: number;
  };
}

// ============================================================================
// Session Turn Types (for precise restoration after /clear)
// ============================================================================

export interface SessionTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  projectId: string | null;
  sessionId: string;
  turnIndex: number;
  timestamp: Date;
}

export interface TurnInput {
  role: 'user' | 'assistant';
  content: string;
  projectId: string | null;
  sessionId: string;
  turnIndex: number;
  timestamp: Date;
}

// ============================================================================
// CLI Command Types
// ============================================================================

export type CommandName =
  | 'statusline'
  | 'session-start'
  | 'session-end'
  | 'background-save'
  | 'monitor'
  | 'context-check'
  | 'pre-compact'
  | 'smart-compact'
  | 'post-tool'
  | 'clear-reminder'
  | 'save'
  | 'archive'
  | 'recall'
  | 'search'
  | 'stats'
  | 'configure'
  | 'setup'
  | 'test-embed'
  | 'check-db'
  | 'ensure-daemon'
  | 'daemon-status'
  | 'daemon-stop'
  | 'compact'
  | 'backup'
  | 'sync';

// ============================================================================
// Analytics Types
// ============================================================================

export interface SessionSavePoint {
  timestamp: string;
  contextPercent: number;
  fragmentsSaved: number;
}

export interface SessionMetrics {
  sessionId: string;
  projectId: string | null;
  startTime: string;
  endTime: string | null;
  peakContextPercent: number;
  savePoints: SessionSavePoint[];
  clearCount: number;
  recallCount: number;
  fragmentsCreated: number;
  restorationUsed: boolean;
}

export interface AnalyticsSummary {
  totalSessions: number;
  totalFragments: number;
  averageContextAtSave: number;
  sessionsProlonged: number;
  thisWeek: {
    sessions: number;
    fragmentsCreated: number;
    recallsUsed: number;
  };
}

export interface AnalyticsData {
  version: number;
  sessions: SessionMetrics[];
  currentSession: SessionMetrics | null;
}

export interface CommandContext {
  stdin: StdinData | null;
  args: string[];
  projectId: string | null;
}
