#!/usr/bin/env node
// Repository-local, zero-runtime-dependency Codex replay diagnostic.
// Parsing remains independent of the dashboard parser; pricing deliberately
// shares the maintained rate module. This compares an all-rollout cumulative
// snapshot with one excluding explicitly marked subagent rollouts. It is not
// a dashboard parity oracle: no ledger fallback, per-turn/day/model allocation,
// or context analysis is performed. Historical JSON keys are kept for callers.
//
// PRIVACY: files are read and parsed locally (including their JSON bodies), but
// only aggregate numeric counts leave this process. No transcript strings,
// paths, prompts, titles, ids, or timestamps are printed or retained in reports.
// Run from this repository: node scripts/codex-usage-diagnostic.mjs [--root path] [--json]
// No network access or disk writes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costOf, PRICES_AS_OF } from '../src/lib/pricing.mjs';

// ── CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`
codex-usage-diagnostic.mjs — read-only, aggregate-only Codex usage check

  --root <path>   directory to scan for rollout-*.jsonl (default: ~/.codex/sessions)
  --json          print machine-readable JSON instead of the human-readable report
  --help          show this message

Reads local rollout JSON and prints only counts and token/cost totals.
No prompts, titles, session ids, file paths, or timestamps appear in reports.
`.trim());
  process.exit(0);
}
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : path.join(os.homedir(), '.codex', 'sessions');
const asJson = args.includes('--json');

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
//    Does not include transcript strings in the returned aggregate. ─────────

function parseRollout(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  let threadSource = null;
  let seenMeta = false;
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
      if (!seenMeta && typeof p.thread_source === 'string') threadSource = p.thread_source;
      seenMeta = true;
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
    if (p.type === 'agent_message' || (p.type === 'item_completed' && p.item?.type === 'AgentMessage')) hasResponse = true;
  }

  if (!hasResponse || !lastUsage) return null; // no assistant turn → not a session, per usage-index.mjs

  const cacheRead = Number(lastUsage.cached_input_tokens) || 0;
  const gross = Number(lastUsage.input_tokens) || 0;
  return {
    threadSource, // unknown without metadata; this diagnostic does not read the Codex ledger
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
    user: sessions.filter((s) => s.threadSource === 'user').length,
    unknown: sessions.filter((s) => s.threadSource === null).length,
    subagent: subagentSessions.length,
    other: sessions.filter((s) => s.threadSource !== null && !['user', 'subagent'].includes(s.threadSource)).length,
  },
  tokens: {
    beforeFix_allSessions: { ...before, total: totalTok(before) },
    afterFix_excludingSubagentReplays: { ...after, total: totalTok(after) },
    excludedAsSubagentReplay: { ...excluded, total: totalTok(excluded) },
    pctOfTotalTokensExcluded: pct(totalTok(excluded), totalTok(before)),
    pctOfTotalCostExcluded: pct(excluded.cost, before.cost),
  },
  costEstimateNote: `Uses repository pricing as of ${PRICES_AS_OF}; estimates are API equivalents, not billing. Independent cumulative snapshot, not full dashboard parity; missing thread source remains unknown and is included.`,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const usd = (n) => `$${Math.round(n).toLocaleString()}`;
  const tok = (n) => n.toLocaleString();
  console.log('Codex usage diagnostic — Bug B (subagent thread-replay) check');
  console.log('='.repeat(64));
  console.log('No prompts, titles, session ids, file paths, or timestamps below.');
  console.log('Only aggregate counts and estimates are shown.\n');
  console.log(`Rollout files found:        ${report.rolloutFilesFound}`);
  console.log(`Counted as real sessions:   ${report.parsedAsSessions}  (>=1 assistant reply)`);
  console.log(`Skipped (unreadable / no reply): ${report.unreadableOrNoAssistantTurn}\n`);
  console.log(`thread_source = "user": ${report.threadSourceCounts.user}`);
  console.log(`thread_source = "subagent":          ${report.threadSourceCounts.subagent}`);
  console.log(`thread_source = unknown:             ${report.threadSourceCounts.unknown}`);
  console.log(`thread_source = other:               ${report.threadSourceCounts.other}`);
  console.log('');
  console.log('ALL rollouts (historical replay-inclusive comparison):');
  console.log(`  tokens: ${tok(before.input + before.output + before.cacheRead)}  (input ${tok(before.input)} · output ${tok(before.output)} · cache-read ${tok(before.cacheRead)})`);
  console.log(`  API-equivalent cost estimate: ${usd(before.cost)}\n`);
  console.log('EXCLUDING explicitly marked subagent rollouts:');
  console.log(`  tokens: ${tok(after.input + after.output + after.cacheRead)}  (input ${tok(after.input)} · output ${tok(after.output)} · cache-read ${tok(after.cacheRead)})`);
  console.log(`  API-equivalent cost estimate: ${usd(after.cost)}\n`);
  console.log(`Excluded as subagent replay: ${tok(totalTok(excluded))} tokens (${report.tokens.pctOfTotalTokensExcluded}% of before-fix total), ~${usd(excluded.cost)} (${report.tokens.pctOfTotalCostExcluded}% of before-fix cost)`);
  console.log(`\n${report.costEstimateNote}`);
}
