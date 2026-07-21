/**
 * Cortex Auto-Recall
 * UserPromptSubmit hook logic: search memory for context relevant to the
 * user's prompt and inject the top matches into the conversation.
 *
 * Relevance is gated on raw cosine similarity (vector search only) rather
 * than RRF rank scores: rank-based scores are nearly flat across ranks and
 * cannot express "nothing here is actually related", which is the common
 * case this feature must stay silent on.
 *
 * Session de-duplication: each injected memory id is recorded per session
 * in ~/.cortex/recall-state.json so the same fragment is never injected
 * twice into one conversation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, atomicWriteFileSync } from './config.js';
import type { RecallConfig } from './types.js';

/** Minimal shape auto-recall needs; both daemon and local search satisfy it */
export interface RecallCandidate {
  id: number;
  score: number;
  content: string;
  timestamp: Date;
  projectId: string | null;
}

// ============================================================================
// Prompt eligibility
// ============================================================================

/**
 * Decide whether a prompt should trigger an auto-recall search at all.
 * Skips slash/bang commands, pasted hook noise, and prompts too short to
 * carry meaningful intent.
 */
export function isPromptEligible(prompt: string, config: RecallConfig): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < config.minPromptLength) return false;
  // Slash commands and shell escapes are operational, not topical
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return false;
  // Our own injected block bouncing back (paranoia guard)
  if (trimmed.startsWith('[cortex:')) return false;
  return true;
}

// ============================================================================
// Result selection
// ============================================================================

/**
 * Filter search results down to what should actually be injected:
 * above the similarity threshold, not already injected this session,
 * capped at maxResults and the token budget (~4 chars per token).
 */
export function selectForInjection(
  results: RecallCandidate[],
  config: RecallConfig,
  alreadyInjected: Set<number>
): RecallCandidate[] {
  const budgetChars = config.tokenBudget * 4;
  const selected: RecallCandidate[] = [];
  let usedChars = 0;

  for (const result of results) {
    if (selected.length >= config.maxResults) break;
    if (result.score < config.minScore) continue;
    if (alreadyInjected.has(result.id)) continue;

    // Trim overly long fragments rather than dropping them
    const content = result.content.length > 600
      ? result.content.substring(0, 600) + '...'
      : result.content;
    const cost = content.length + 40; // + per-entry framing overhead

    // continue (not break): a long fragment near the budget edge should
    // not block shorter, still-relevant ones behind it
    if (usedChars + cost > budgetChars) continue;
    usedChars += cost;
    selected.push({ ...result, content });
  }

  return selected;
}

/**
 * Format selected memories as the context block printed to stdout
 * (UserPromptSubmit stdout is appended to the conversation context).
 */
export function formatInjection(results: RecallCandidate[], projectId: string | null): string {
  const lines: string[] = [];
  const scope = projectId ? ` (project: ${projectId})` : '';
  lines.push(`[cortex:auto-recall] Relevant memories from past sessions${scope}:`);

  results.forEach((result, index) => {
    const pct = Math.round(result.score * 100);
    const age = formatAge(result.timestamp);
    lines.push(`${index + 1}. (${pct}% match • ${age}) ${result.content}`);
  });

  return lines.join('\n');
}

function formatAge(date: Date): string {
  if (!date || isNaN(date.getTime())) return 'unknown age';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

// ============================================================================
// Per-session injection state
// ============================================================================

const MAX_TRACKED_SESSIONS = 20;

interface RecallSessionState {
  injectedIds: number[];
  updatedAt: string;
}

interface RecallState {
  sessions: Record<string, RecallSessionState>;
}

export function getRecallStatePath(): string {
  return path.join(getDataDir(), 'recall-state.json');
}

export function loadRecallState(): RecallState {
  try {
    const raw = fs.readFileSync(getRecallStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as RecallState;
    if (parsed && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
      return parsed;
    }
  } catch {
    // Missing or corrupt: start fresh
  }
  return { sessions: {} };
}

/** Set of memory ids already injected into the given session */
export function getInjectedIds(state: RecallState, sessionId: string): Set<number> {
  return new Set(state.sessions[sessionId]?.injectedIds ?? []);
}

/**
 * Record newly injected ids for a session and persist, pruning the state
 * to the most recently active sessions so the file never grows unbounded.
 */
export function recordInjection(state: RecallState, sessionId: string, ids: number[]): void {
  const existing = state.sessions[sessionId]?.injectedIds ?? [];
  state.sessions[sessionId] = {
    injectedIds: [...new Set([...existing, ...ids])],
    updatedAt: new Date().toISOString(),
  };

  const entries = Object.entries(state.sessions)
    .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
    .slice(0, MAX_TRACKED_SESSIONS);
  state.sessions = Object.fromEntries(entries);

  try {
    fs.mkdirSync(getDataDir(), { recursive: true });
    atomicWriteFileSync(getRecallStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: losing dedup state only risks a repeat injection
  }
}
