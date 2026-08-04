// Codex's own thread ledger (~/.codex/state_N.sqlite) — the authoritative
// source for per-thread attribution that the rollout JSONL can only guess at.
//
// Codex ≥0.140 maintains a `threads` table with a pre-aggregated `tokens_used`
// column plus `thread_source` ('user' | 'subagent') and `source`
// ('cli' | 'exec' | 'subagent'), and a `thread_spawn_edges` table recording
// parent→child delegation. That replaces the kit's heuristic subagent-replay
// guard (a `session_meta.thread_source` sniff, PR #60) with Codex's own
// bookkeeping: a subagent rollout replays its parent's ENTIRE token history
// (ccusage/ccusage#950 measured up to 91x inflation), so knowing which threads
// are subagents is what keeps the totals honest.
//
// Deliberate limits:
//   - READ-ONLY, always. `withDb` opens readonly and swallows every error —
//     a locked or half-migrated db yields null, never a crash and never a lock
//     held against the codex CLI itself.
//   - The filename suffix (`state_5`) is a MIGRATION GENERATION, not a stable
//     name. We glob `state_*.sqlite` and take the highest generation rather
//     than hardcoding today's.
//   - Column names are probed before use: a future migration that drops or
//     renames a column degrades this module to null (callers fall back to the
//     JSONL heuristic), not to a throw.
import fs from 'node:fs';
import path from 'node:path';
import { codexDir } from './paths.mjs';
import { withDb } from './sqlite.mjs';
import { resolveProjectIdentity } from './live/project-label.mjs';
import { workspaceFromSource } from './live/git-workspace.mjs';

function ledgerTimestamp(row, milliseconds, seconds) {
  const millis = Number(row[milliseconds]);
  const value = Number.isFinite(millis) && millis > 0
    ? millis : Number(row[seconds]) * 1000;
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Newest-generation state db file under ~/.codex, or null. Exported for test
 *  via the `dir` override. */
export function codexStateDb(dir = codexDir()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const gens = names
    .map((n) => /^state_(\d+)\.sqlite$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ name: m[0], gen: Number(m[1]) }))
    .sort((a, b) => b.gen - a.gen);
  return gens.length ? path.join(dir, gens[0].name) : null;
}

/**
 * Read Codex's thread ledger. Returns
 *   { threads: Map<id, {
 *       tokensUsed, threadSource, source, model, gitBranch, agentNickname, agentRole
 *     }>,
 *     parents: Map<childId, parentId> }
 * or null when the db is absent, unreadable, or shaped unexpectedly.
 *
 * @param {{ dir?: string, file?: string }} [opts] test seams
 */
export function readCodexState(opts = {}) {
  const file = opts.file ?? codexStateDb(opts.dir);
  if (!file) return null;
  return withDb(file, (db) => {
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
    // id + thread_source are what the attribution fix rests on; without them
    // this ledger cannot answer the question and the caller must fall back.
    if (!cols.has('id') || !cols.has('thread_source')) return null;
    // agent_nickname and agent_role are explicit orchestration metadata. Do not
    // read `title` or `name`: those may be derived from user task content.
    const pick = ['id', 'thread_source']
      .concat([
        'tokens_used', 'source', 'model', 'git_branch', 'agent_nickname', 'agent_role',
        'cwd', 'model_provider', 'provider', 'status',
        'created_at', 'updated_at', 'recency_at',
        'created_at_ms', 'updated_at_ms', 'recency_at_ms',
      ].filter((c) => cols.has(c)));
    const threads = new Map();
    for (const row of db.prepare(`SELECT ${pick.join(', ')} FROM threads`).all()) {
      const project = typeof row.cwd === 'string' ? resolveProjectIdentity(row.cwd) : null;
      const createdAt = ledgerTimestamp(row, 'created_at_ms', 'created_at');
      const updatedAt = ledgerTimestamp(row, 'updated_at_ms', 'updated_at');
      const recencyAt = ledgerTimestamp(row, 'recency_at_ms', 'recency_at');
      const sourceAt = updatedAt ?? recencyAt ?? createdAt;
      threads.set(String(row.id), {
        tokensUsed: Number(row.tokens_used) || 0,
        threadSource: typeof row.thread_source === 'string' ? row.thread_source : null,
        source: typeof row.source === 'string' ? row.source : null,
        model: typeof row.model === 'string' ? row.model : null,
        gitBranch: typeof row.git_branch === 'string' ? row.git_branch : null,
        agentNickname: typeof row.agent_nickname === 'string' ? row.agent_nickname : null,
        agentRole: typeof row.agent_role === 'string' ? row.agent_role : null,
        project: project?.label ?? null,
        projectKey: project?.key ?? null,
        // codex's threads schema names this model_provider; the bare provider
        // spelling is kept for tolerance of older/forked ledgers.
        provider: typeof row.model_provider === 'string' ? row.model_provider
          : (typeof row.provider === 'string' ? row.provider : null),
        status: typeof row.status === 'string' ? row.status : null,
        createdAt,
        updatedAt: sourceAt,
        recencyAt,
        workspace: sourceAt ? workspaceFromSource({
          cwd: row.cwd, branch: row.git_branch, project: project?.label,
          capturedAt: sourceAt, source: 'codex-state',
        }) : null,
      });
    }
    const parents = new Map();
    try {
      for (const e of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all()) {
        if (e.child_thread_id != null && e.parent_thread_id != null) {
          parents.set(String(e.child_thread_id), String(e.parent_thread_id));
        }
      }
    } catch { /* the edges table is additive detail — attribution works without it */ }
    return { threads, parents };
  }, null);
}
