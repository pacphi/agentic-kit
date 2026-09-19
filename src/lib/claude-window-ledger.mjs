// claude-window-ledger.mjs — read side of the Claude context-window ledger.
//
// Claude transcripts never record the model's context window, so a pressure
// sample (input tokens ÷ window) has no denominator (ADR-0042 forbids
// substituting a catalogue maximum: Claude offers 200K and 1M variants of one
// model). The statusline payload DOES carry the real window
// (`context_window.context_window_size`); the kit's statusline template appends
// a per-session change log `[{t, size, model}]` to
// `<configDir>/claude-context-windows/<session_id>.json`
// (src/templates/statusline-footer.cjs, rufloWindowTeeSegment).
//
// This module is the pure reader: it validates the session id, tolerates
// absent/corrupt/oversized ledgers (→ null), and resolves the window in effect
// at a message timestamp. It NEVER guesses: unknown is null.
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_WINDOW_DIR = 'claude-context-windows';

/** A real ledger is <= 64 entries of ~90 bytes; anything larger is not ours. */
export const MAX_LEDGER_BYTES = 64 * 1024;

/** How far BEFORE the ledger's first entry a message may sit and still take the
 *  first entry's window. The first entry's `t` is when the statusline first
 *  observed the session, which normally precedes or closely follows the first
 *  assistant message; a message older than this tolerance ran before any
 *  observation and its window is unknown. */
export const WINDOW_LEAD_TOLERANCE_MS = 120_000;

/** Same rule the writer applies: the id becomes a filename, so no separators,
 *  dots or traversal. A subagent id (`parent/stem`) fails it by construction. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Absolute ledger path for a session, or null when the id is unsafe. */
export function claudeWindowLedgerPath(configDir, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return null;
  if (typeof configDir !== 'string' || !configDir) return null;
  return path.join(configDir, CLAUDE_WINDOW_DIR, `${sessionId}.json`);
}

/** {mtimeMs, size} of the session's ledger file, or null when absent/unsafe.
 *  The usage index folds this into a Claude entry's cache key so a ledger that
 *  appears or grows after a transcript was parsed forces a re-parse. */
export function statClaudeWindowLedger(configDir, sessionId) {
  const file = claudeWindowLedgerPath(configDir, sessionId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch { return null; }
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const { t, size, model } = e;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  return { t, size, model: typeof model === 'string' ? model : null };
}

/** The session's validated, time-ordered window log, or null when there is
 *  nothing trustworthy to read (absent, corrupt, oversized, empty). */
export function readClaudeWindowLog(configDir, sessionId) {
  const file = claudeWindowLedgerPath(configDir, sessionId);
  if (!file) return null;
  try {
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    const log = parsed.map(cleanEntry).filter(Boolean).sort((a, b) => a.t - b.t);
    return log.length ? log : null;
  } catch { return null; }
}

/**
 * The context window in effect at `atMs`: the size of the latest entry with
 * `t <= atMs`. A message before the first entry takes the first entry's size
 * only when that entry is within WINDOW_LEAD_TOLERANCE_MS after it; otherwise
 * the window is unknown (null) — never a guess.
 */
export function windowAt(log, atMs) {
  if (!Array.isArray(log) || !log.length) return null;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  let inEffect = null;
  for (const entry of log) {
    if (entry.t > atMs) break;
    inEffect = entry;
  }
  if (inEffect) return inEffect.size;
  return log[0].t - atMs <= WINDOW_LEAD_TOLERANCE_MS ? log[0].size : null;
}
