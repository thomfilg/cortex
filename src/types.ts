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
  /** Hook event name (e.g. "UserPromptSubmit") when invoked as a hook */
  hook_event_name?: string;
  /** Session id, present in hook invocations */
  session_id?: string;
  /** The user's prompt text (UserPromptSubmit hook only) */
  prompt?: string;
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
  /** Identity of the authoring session (shared-brain attribution). */
  user?: string | null;
  environment?: string | null;
  /** Generalization axis that scopes recall; defaults to 'project'. */
  category?: MemoryCategory | null;
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

/**
 * How recall scopes results by the `category` generalization axis.
 * - auto: the smart union - global + this user's + this environment's + this
 *   project's memories (each branch gated by the matching identity value).
 * - project | environment | user | global: a single pure slice.
 * - all: no category/identity filter (the whole shared brain).
 */
export type RecallScopeMode =
  | 'auto'
  | 'project'
  | 'environment'
  | 'user'
  | 'global'
  | 'all';

/**
 * Identity values that a scope filter matches against. Missing values simply
 * make the corresponding branch match nothing (never a SQL error).
 */
export interface RecallScope {
  mode?: RecallScopeMode;
  user?: string | null;
  environment?: string | null;
  /** Matched against the project_id column. */
  project?: string | null;
}

export interface SearchOptions {
  projectScope?: boolean;
  projectId?: string;
  limit?: number;
  includeAllProjects?: boolean;
  /**
   * Category-aware scope. When provided it REPLACES the legacy projectId
   * filter. When omitted, the legacy projectId/projectScope behavior is used
   * unchanged (backward compatible).
   */
  scope?: RecallScope;
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

/**
 * Opt-in automatic recall: a UserPromptSubmit hook searches memory for
 * fragments semantically related to the user's prompt and injects the top
 * matches as context. Relevance is gated on cosine similarity; injected
 * fragments are deduplicated per session. Default: disabled.
 */
export interface RecallConfig {
  /** Enable the UserPromptSubmit auto-recall hook */
  auto: boolean;
  /** Minimum cosine similarity (0-1) for a memory to be injected */
  minScore: number;
  /** Maximum memories injected per prompt */
  maxResults: number;
  /** Approximate token budget for the injected block */
  tokenBudget: number;
  /** Prompts shorter than this many characters are ignored */
  minPromptLength: number;
}

/**
 * Identity of the session writing a memory. Populated into the memories
 * table so a shared brain (see RemoteConfig) can attribute and scope recall.
 * Both fields are usually null in config and resolved dynamically at runtime
 * (env var > this config > auto-detect). See src/identity.ts.
 */
export interface IdentityConfig {
  /** Override the resolved user; null = env var or OS username */
  user: string | null;
  /** Override the resolved environment label; null = auto-detect */
  environment: string | null;
}

/**
 * Opt-in remote shared-brain backend. When enabled, the plugin talks to a
 * remote Cortex daemon over HTTP instead of (or in addition to) a local DB,
 * so every session across machines shares one memory store.
 *
 * The auth token is NEVER stored here - it is read from the
 * CORTEX_REMOTE_TOKEN environment variable at request time. This keeps a
 * committed project-level .cortex/config.json free of secrets.
 */
export interface RemoteConfig {
  enabled: boolean;
  /** Base URL of the shared brain, e.g. "https://cortex.myteam.dev". null = unconfigured */
  url: string | null;
}

/**
 * The generalization axis of a memory - "where is this knowledge true?".
 * Drives automatic recall scoping (see src/search.ts):
 * - global: always eligible
 * - user: scoped to the same user, across machines/projects
 * - environment: scoped to the same machine/context, across projects
 * - project: scoped to the same project (default)
 */
export type MemoryCategory = 'global' | 'user' | 'environment' | 'project';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'global',
  'user',
  'environment',
  'project',
] as const;

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
  recall: RecallConfig;
  identity: IdentityConfig;
  remote: RemoteConfig;
  /** Stable project name; set in project-root .cortex/config.json. null = derive from cwd */
  project: string | null;
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
  | 'sync'
  | 'auto-recall';

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
