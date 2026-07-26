#!/usr/bin/env node
// codex-usage-diagnostic.mjs — standalone, zero-dependency (Node built-ins
// only), read-only diagnostic for the two Codex usage-scorecard bugs fixed in
// this branch (see docs/USAGE-SCORECARD-METRICS.md Appendix A):
//
//   Bug A — Codex model rows always showed 0 responses (display-only, no $/tok effect).
//   Bug B — a rollout whose session_meta.thread_source is "subagent" replays its
//           parent thread's ENTIRE prior token history as duplicate events before
//           its own new turns (openai/codex thread_spawn behavior — see
//           ccusage/ccusage#950, which measured up to 91x cost inflation from
//           exactly this). The old code counted that replayed total as real spend.
//
// This script reproduces BOTH the OLD (buggy) and NEW (fixed) token totals
// side by side, computed independently from this diagnostic's own small
// reimplementation of the relevant parsing logic — not by importing the fix
// itself — so the comparison is a genuine check, not a tautology:
//
//   "before" should match what your CURRENT (unpatched) dashboard shows you.
//   "after"  is what it will show once this branch's fix lands.
//
// PRIVACY: this script never reads, stores, or prints session titles, prompts,
// message bodies, file paths, session ids, or working directories. It reads
// only three fields per rollout line: `type`, `session_meta.thread_source`,
// and the numeric fields inside `token_count.info.total_token_usage`. The
// entire printed report is aggregate counts — safe to paste back in full.
//
// USAGE:
//   node codex-usage-diagnostic.mjs                # scans ~/.codex/sessions
//   node codex-usage-diagnostic.mjs --root <path>   # scan a different root
//   node codex-usage-diagnostic.mjs --json          # machine-readable output
//   node codex-usage-diagnostic.mjs --help
//
// Requires Node 18+. No npm install, no network access, no writes to disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`
codex-usage-diagnostic.mjs — read-only, aggregate-only Codex usage check

  --root <path>   directory to scan for rollout-*.jsonl (default: ~/.codex/sessions)
  --json          print machine-readable JSON instead of the human-readable report
  --help          show this message

Prints only counts and token/cost totals. Never reads or prints prompts,
titles, session ids, file paths, or timestamps of any individual session.
`.trim());
  process.exit(0);
}
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : path.join(os.homedir(), '.codex', 'sessions');
const asJson = args.includes('--json');

// ── minimal OpenAI rate table, for a $ estimate only ────────────────────
// Kept intentionally tiny (Codex-relevant entries only) and mirrors
// src/lib/pricing.mjs as of 2026-07-25. If this script is run long after
// that date, treat the $ figures as directional, not exact — re-check
// src/lib/pricing.mjs for the current table. Same cache multipliers as
// Anthropic's own published rates (0.1x read, 1.25x write); see
// docs/USAGE-SCORECARD-METRICS.md §13 for the citations behind those two
// numbers.
const RATES = [
  ['gpt-5.6-sol', 5, 30],
  ['gpt-5.6-terra', 2.5, 15],
  ['gpt-5.6-luna', 1, 6],
  ['gpt-5.5-pro', 30, 180],
  ['gpt-5.5', 5, 30],
  ['gpt-5.4-mini', 0.75, 4.5],
  ['gpt-5.4-nano', 0.2, 1.25],
  ['gpt-5.4-pro', 30, 180],
  ['gpt-5.4', 2.5, 15],
  ['gpt-5.3-codex', 1.75, 14],
];
const FALLBACK_RATE = [3, 15]; // unrecognized model: mid-line estimate, never $0
// Codex rollouts report no separate cache-write figure (parseCodex always
// passes cacheWrite: 0 — see src/lib/usage-index.mjs), so only the read
// multiplier is needed here.
const CACHE_READ_MULTIPLIER = 0.1;

function rateFor(model) {
  const id = String(model || '').toLowerCase();
  const hit = RATES.find(([key]) => id === key || id.startsWith(`${key}-`));
  return hit ? [hit[1], hit[2]] : FALLBACK_RATE;
}

function costOf({ model, input, output, cacheRead }) {
  const [rin, rout] = rateFor(model);
  const inputUnits = (Number(input) || 0) + (Number(cacheRead) || 0) * CACHE_READ_MULTIPLIER;
  return (inputUnits * Number(rin) + (Number(output) || 0) * Number(rout)) / 1e6;
}

// ── walk root/<yyyy>/<mm>/<dd>/rollout-*.jsonl ──────────────────────────

function readDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function findRolloutFiles(rootDir) {
  const out = [];
  for (const y of readDirSafe(rootDir)) {
    if (!y.isDirectory()) continue;
    for (const m of readDirSafe(path.join(rootDir, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of readDirSafe(path.join(rootDir, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(rootDir, y.name, m.name, d.name);
        for (const f of readDirSafe(dir)) {
          if (f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) {
            out.push(path.join(dir, f.name));
          }
        }
      }
    }
  }
  return out;
}

// ── parse one rollout: mirrors src/lib/usage-index.mjs's parseCodex, but
//    extracts ONLY thread_source, model, and the last cumulative token_count.
//    Never reads or retains message text, prompts, ids, or paths. ─────────

function parseRollout(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  let threadSource = null;
  let model = 'unknown';
  let lastUsage = null;
  let hasResponse = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 123 /* '{' */) continue;
    let e;
    try { e = JSON.parse(trimmed); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const p = e.payload ?? {};

    if (e.type === 'session_meta') {
      if (typeof p.thread_source === 'string') threadSource = p.thread_source;
      continue;
    }
    if (e.type === 'turn_context') {
      if (typeof p.model === 'string') model = p.model;
      continue;
    }
    if (e.type !== 'event_msg') continue;

    if (p.type === 'token_count') {
      const t = p.info?.total_token_usage;
      if (t && typeof t === 'object') lastUsage = t;
      continue;
    }
    if (p.type === 'agent_message') hasResponse = true;
  }

  if (!hasResponse || !lastUsage) return null; // no assistant turn → not a session, per usage-index.mjs

  const cacheRead = Number(lastUsage.cached_input_tokens) || 0;
  const gross = Number(lastUsage.input_tokens) || 0;
  return {
    threadSource: threadSource ?? 'user', // absent field == "user" (openai/codex#23001: older rollouts predate the field)
    model,
    input: Math.max(0, gross - cacheRead),
    output: Number(lastUsage.output_tokens) || 0,
    cacheRead,
  };
}

// ── run ──────────────────────────────────────────────────────────────────

const files = findRolloutFiles(root);
const sessions = [];
let unparsed = 0;
for (const f of files) {
  const s = parseRollout(f);
  if (s) sessions.push(s); else unparsed++;
}

const subagentSessions = sessions.filter((s) => s.threadSource === 'subagent');
const otherThreadSources = [...new Set(
  sessions.map((s) => s.threadSource).filter((v) => v !== 'user' && v !== 'subagent'),
)];

function sumTokens(list) {
  return list.reduce(
    (acc, s) => {
      acc.input += s.input; acc.output += s.output; acc.cacheRead += s.cacheRead;
      acc.cost += costOf(s);
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cost: 0 },
  );
}

const before = sumTokens(sessions); // what the OLD, buggy code counts — every session, replays included
const after = sumTokens(sessions.filter((s) => s.threadSource !== 'subagent')); // what the FIXED code counts
const excluded = sumTokens(subagentSessions);

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (part, whole) => (whole ? round2((part / whole) * 100) : 0);
const totalTok = (t) => t.input + t.output + t.cacheRead;

const report = {
  rolloutFilesFound: files.length,
  parsedAsSessions: sessions.length,
  unreadableOrNoAssistantTurn: unparsed,
  threadSourceCounts: {
    user: sessions.length - subagentSessions.length - sessions.filter((s) => otherThreadSources.includes(s.threadSource)).length,
    subagent: subagentSessions.length,
    other: otherThreadSources.length ? otherThreadSources : undefined,
  },
  tokens: {
    beforeFix_allSessions: { ...before, total: totalTok(before) },
    afterFix_excludingSubagentReplays: { ...after, total: totalTok(after) },
    excludedAsSubagentReplay: { ...excluded, total: totalTok(excluded) },
    pctOfTotalTokensExcluded: pct(totalTok(excluded), totalTok(before)),
    pctOfTotalCostExcluded: pct(excluded.cost, before.cost),
  },
  costEstimateNote: 'Uses a small embedded OpenAI rate table (gpt-5.x family) mirroring src/lib/pricing.mjs as of 2026-07-25 — directional, not authoritative. See docs/USAGE-SCORECARD-METRICS.md §13.2.',
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const usd = (n) => `$${Math.round(n).toLocaleString()}`;
  const tok = (n) => n.toLocaleString();
  console.log('Codex usage diagnostic — Bug B (subagent thread-replay) check');
  console.log('='.repeat(64));
  console.log('No prompts, titles, session ids, file paths, or timestamps below.');
  console.log('This entire block is safe to paste back in full.\n');
  console.log(`Rollout files scanned root: ${root}`);
  console.log(`Rollout files found:        ${report.rolloutFilesFound}`);
  console.log(`Counted as real sessions:   ${report.parsedAsSessions}  (>=1 assistant reply)`);
  console.log(`Skipped (unreadable / no reply): ${report.unreadableOrNoAssistantTurn}\n`);
  console.log(`thread_source = "user" (or absent): ${report.threadSourceCounts.user}`);
  console.log(`thread_source = "subagent":          ${report.threadSourceCounts.subagent}`);
  if (report.threadSourceCounts.other) {
    console.log(`thread_source = other values seen:   ${report.threadSourceCounts.other.join(', ')}`);
  }
  console.log('');
  console.log('BEFORE the fix (what your current dashboard shows — verify this matches):');
  console.log(`  tokens: ${tok(before.input + before.output + before.cacheRead)}  (input ${tok(before.input)} · output ${tok(before.output)} · cache-read ${tok(before.cacheRead)})`);
  console.log(`  API-equivalent cost estimate: ${usd(before.cost)}\n`);
  console.log('AFTER the fix (excludes thread_source:"subagent" rollouts):');
  console.log(`  tokens: ${tok(after.input + after.output + after.cacheRead)}  (input ${tok(after.input)} · output ${tok(after.output)} · cache-read ${tok(after.cacheRead)})`);
  console.log(`  API-equivalent cost estimate: ${usd(after.cost)}\n`);
  console.log(`Excluded as subagent replay: ${tok(totalTok(excluded))} tokens (${report.tokens.pctOfTotalTokensExcluded}% of before-fix total), ~${usd(excluded.cost)} (${report.tokens.pctOfTotalCostExcluded}% of before-fix cost)`);
  console.log(`\n${report.costEstimateNote}`);
}
