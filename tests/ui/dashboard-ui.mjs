#!/usr/bin/env node
//
// dashboard-ui.mjs — end-to-end VISUAL verification of the dashboard.
//
// The unit and route suites prove the server returns correct JSON and that the
// served HTML contains the right element ids. Neither proves the page RENDERS
// that data correctly, and every bug that reached the browser during the
// usage-scorecard build was of exactly that kind:
//
//   · projectTree[].categories was an array, the renderer did Object.keys() on
//     it, and every project chip read "0 [object Object]"
//   · byProject[].minutes was never emitted, so every project row read "0m"
//   · byCategory[].confidence was never emitted, so every category read "0.00"
//   · readSession().meta had no cost, so every transcript header read "$0.00"
//
// All four passed their own tests. None is visible without rendering the page.
// Hence the central assertion here: **no rendering artifact may appear in
// visible text** — `undefined`, `NaN`, `[object Object]`, `Invalid Date`, a
// bare `null`. That single net catches this whole class.
//
// Drives the SYSTEM Chrome (playwright `channel: 'chrome'`) so nothing is
// downloaded; CI runners ship Chrome already.
//
//   node tests/ui/dashboard-ui.mjs            # deterministic fixture corpus
//   node tests/ui/dashboard-ui.mjs --real     # YOUR live transcripts
//   node tests/ui/dashboard-ui.mjs --headed   # watch it drive
//
// Screenshots land in .ui-artifacts/ (gitignored) for human review.
// Exit 0 = pass.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { readIndex, readSession, maskSecrets } from '../../src/lib/usage-index.mjs';
import { modelIdentityKey } from '../../src/lib/model-inventory/contracts.mjs';
// The About area's directory is authored DATA, not a renderer — importing it
// here asserts the real contract ("one card per directory entry") instead of a
// hardcoded 15 that rots the day an entry is added. This is not the thing the
// formatter restatements below refuse to do: those would compute an expectation
// with the code under test; this names the input the code under test consumes.
import { directoryEntries } from '../../src/lib/dashboard/about-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHOTS = path.join(ROOT, '.ui-artifacts');

const REAL = process.argv.includes('--real');
const HEADED = process.argv.includes('--headed');

let passed = 0;
const failures = [];
const ok = (name) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, why) => { failures.push({ name, why }); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

// ── the artifact net ─────────────────────────────────────────────────────────
// Deliberately matched against VISIBLE text (innerText), not HTML: an id or a
// data-attribute may legitimately contain these tokens, but a human must never
// read them. `$0.00`/`0m` are NOT here — zero is a legitimate value; those get
// targeted assertions below instead, where we know a non-zero was expected.
const ARTIFACTS = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\[object [A-Z]\w+\]/,
  /\bInvalid Date\b/,
  /\$NaN/,
  /\bnull\b/,
  // Internal design-record ids are for contributors, not the person reading
  // the panel — an "ADR-0010" in visible text is documentation leaking into UI.
  /\bADR-\d/,
];

async function visibleText(page, selector) {
  return page.$eval(selector, (el) => el.innerText).catch(() => '');
}

function artifactsIn(text) {
  return ARTIFACTS.filter((re) => re.test(text)).map((re) => String(re));
}

// Fixture and --real runs write DIFFERENT content, so a shared filename means a
// reviewer can only ever hold one mode's evidence — and the second run silently
// destroys the first. Suffixing by mode is fixed here, once, rather than at each
// call site: every artifact gets the protection, including the ones added later.
async function shoot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}${REAL ? '-real' : ''}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// ── formatter restatements ───────────────────────────────────────────────────
// Independent restatements of the page's own fmtHours/fmtMins/fmtTok/fmtNum.
// Deliberately NOT imported from the renderer: a check that computes its
// expectation with the code under test proves only that the code agrees with
// itself, which is the failure mode this whole harness exists to catch.
const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
const fmtHours = (sec) => { const h = (Number(sec) || 0) / 3600; return `${h >= 10 ? Math.round(h) : h.toFixed(1)}h`; };
const fmtMins = (m) => { m = Number(m) || 0; return m >= 60 ? `${Math.round(m / 60)}h` : `${Math.round(m)}m`; };
const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-US');

// ── the extended fixture corpus (ADR-0009 follow-ups) ────────────────────────
// Three of the follow-ups need corpus shapes the checked-in fixtures do not
// have: a turn over MAX_TURN_CHARS, a session inside a git worktree, and an
// engaged/open/summed ladder whose three tiers actually DIFFER (on the shipped
// fixtures all three collapse to 0.4h, so a tooltip printing the same figure
// three times would pass). They are materialised into a TEMP COPY rather than
// committed, because tests/kit/usage-index.test.mjs asserts exact totals over
// the checked-in corpus and this file does not own that suite.
const TRUNC_ID = 'uitrunc01';
const WT_ID = 'uiwtree01';
const WT_NAME = 'phase-1';
// MAX_TURN_CHARS is 40 000. 128 412 is comfortably over it AND formats to a
// distinct magnitude ("128.4K" vs "40.0K"), so a badge that prints one figure,
// or prints the same figure twice, cannot pass by coincidence.
const TRUNC_SHOWN = 40_000;
const TRUNC_ORIGINAL = 128_412;
// What usage-index.mjs appends to an abridged turn, so the harness can subtract
// it when comparing the badge's claim against the rendered body.
const TRUNC_MARKER = '\n…[truncated]';

function bigText(n) {
  // No `null`/`NaN`/`undefined` substrings — the body flows through the
  // artifact net, and a fixture that trips it would be a false positive.
  const unit = 'the quick brown fox jumps over the lazy dog. ';
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

const jsonl = (...lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

function extendedCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-corpus-'));
  const claude = path.join(dir, 'claude');
  const codex = path.join(dir, 'codex');
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'usage', 'claude'), claude, { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'usage', 'codex'), codex, { recursive: true });

  const usr = (id, cwd, at, text) => ({
    type: 'user', sessionId: id, cwd, isSidechain: false, timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const asst = (id, cwd, at, text) => ({
    type: 'assistant', sessionId: id, cwd, isSidechain: false, timestamp: at,
    message: {
      role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  });

  // Active 11:00–11:05, then 85 minutes of silence, then active 12:30–12:35.
  // The gap exceeds IDLE_GAP_MS, so engaged < open for this session; the
  // worktree session below sits INSIDE its span, so open < summed. That is what
  // makes the three tiers distinguishable in the KPI tooltip.
  fs.writeFileSync(path.join(claude, '-Users-me-proj', `${TRUNC_ID}.jsonl`), jsonl(
    { type: 'ai-title', aiTitle: 'Paste a very long build log', sessionId: TRUNC_ID },
    usr(TRUNC_ID, '/Users/me/proj', '2026-07-24T11:00:00.000Z', bigText(TRUNC_ORIGINAL)),
    asst(TRUNC_ID, '/Users/me/proj', '2026-07-24T11:05:00.000Z', 'Read the log.'),
    usr(TRUNC_ID, '/Users/me/proj', '2026-07-24T12:30:00.000Z', 'anything in there?'),
    asst(TRUNC_ID, '/Users/me/proj', '2026-07-24T12:35:00.000Z', 'One warning.'),
  ));

  // A dropped/rate-limited turn: model "<synthetic>", isApiErrorMessage, zero
  // usage. Present so the "N dropped/errored turns excluded" qualifier under
  // the models caption actually RENDERS here — with no exception in the corpus
  // the element stayed empty, and the caption's line-wrap defect (the count
  // orphaned onto the next line, reading as part of the caption) was invisible
  // to this harness until it was seen by eye.
  const EXC_ID = 'exc00001';
  fs.writeFileSync(path.join(claude, '-Users-me-proj', `${EXC_ID}.jsonl`), jsonl(
    { type: 'ai-title', aiTitle: 'Session that hit a rate limit', sessionId: EXC_ID },
    usr(EXC_ID, '/Users/me/proj', '2026-07-24T13:00:00.000Z', 'keep going'),
    asst(EXC_ID, '/Users/me/proj', '2026-07-24T13:01:00.000Z', 'Working on it.'),
    {
      type: 'assistant', sessionId: EXC_ID, cwd: '/Users/me/proj', isSidechain: false,
      timestamp: '2026-07-24T13:02:00.000Z', isApiErrorMessage: true,
      message: {
        role: 'assistant', model: '<synthetic>',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'API Error: 429 rate limit exceeded' }],
      },
    },
  ));

  // <repo>/.git/worktrees/<rest> — collapses to project "proj" with worktree
  // "phase-1" (ADR-0009 §4b), so this row must render a chip and aaaa1111 must not.
  const wtCwd = `/Users/me/proj/.git/worktrees/${WT_NAME}`;
  const wtDir = path.join(claude, `-Users-me-proj--git-worktrees-${WT_NAME}`);
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, `${WT_ID}.jsonl`), jsonl(
    { type: 'ai-title', aiTitle: 'Rebase the phase-1 worktree', sessionId: WT_ID },
    usr(WT_ID, wtCwd, '2026-07-24T11:30:00.000Z', 'rebase this worktree onto main'),
    asst(WT_ID, wtCwd, '2026-07-24T11:40:00.000Z', 'Rebased.'),
  ));

  slideCorpusIntoWindow([claude, codex]);
  return { claude, codex };
}

/** The fixtures and the sessions written above are all pinned to FIXTURE_EPOCH.
 *  The kit suites cope with that by pinning `now` (see usage-index.test.mjs's
 *  header), but this harness drives a REAL server against the real clock and
 *  the panel requests a 14-day window, so a fixed date is a dated bomb: the
 *  corpus passed every run until it turned 14 days old, then every
 *  session-dependent assertion went blind at once against unchanged code.
 *
 *  Shifting the copied corpus keeps it permanently inside the window. The shift
 *  is a WHOLE NUMBER OF DAYS so every relative fact the assertions actually
 *  test survives it — the 85-minute idle gap that separates the three time
 *  tiers, the worktree session nested inside another's span, and each turn's
 *  local time-of-day, which the punchcard buckets by hour. */
const FIXTURE_EPOCH = '2026-07-24';
function slideCorpusIntoWindow(roots) {
  const DAY = 86_400_000;
  // Land the corpus a few days back: comfortably inside the 14-day default,
  // and never in the future, which would read as an unfinished session.
  const target = Date.now() - 3 * DAY;
  const shiftDays = Math.round((target - Date.parse(`${FIXTURE_EPOCH}T00:00:00.000Z`)) / DAY);
  if (shiftDays <= 0) return; // fixtures are already recent enough
  const shiftMs = shiftDays * DAY;
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(ISO, (stamp) => {
        const at = Date.parse(stamp);
        return Number.isFinite(at) ? new Date(at + shiftMs).toISOString() : stamp;
      }));
    }
  };
  for (const root of roots) walk(root);
}

// ── views under test ─────────────────────────────────────────────────────────
// ORDER IS THE CONTRACT, not an implementation detail: About leads because it
// is the orientation surface (ADR-0026) and System trails because it is the
// machine-resource family (ADR-0025). The array below is also what the
// primary-navigation assertion compares against, so a reordered tab bar fails
// here rather than being silently absorbed.
const TABS = [
  ['about', '#panel-about'],
  ['overview', '#area-overview'],
  ['usage', '#panel-usage'],
  ['observability', '#panel-observability'],
  ['system', '#area-system'],
];
const PRIMARY_LABELS = ['About', 'Overview', 'Usage', 'Observability', 'System'];
const OVERVIEW_VIEWS = [
  ['summary', '#panel-overview'],
  ['hosts', '#panel-hosts'],
  ['providers', '#panel-providers'],
  ['runtime', '#panel-runtime'],
  ['intel', '#panel-intel'],
];
const USAGE_VIEWS = [
  ['score', '#v-score'],
  ['limits', '#v-limits'],
  ['findings', '#v-findings'],
  ['prompts', '#v-prompts'],
  ['context', '#v-context'],
  ['hooks', '#v-hooks'],
  ['models', '#v-models'],
  ['sessions', '#v-sessions'],
];
// Eight sub-views, in order. Asserting the list here means a merge would fail
// loudly instead of quietly reducing the area. Advisory is deliberately its own
// area rather than a card: it is the only part of System that suggests an
// action, and everything else reports what is. Sessions owns the session-level
// detail Storage used to carry underneath its byte breakdown.
const SYSTEM_VIEWS = [
  ['summary', '#panel-sys-summary'],
  ['advisory', '#panel-sys-advisory'],
  ['sessions', '#panel-sys-sessions'],
  ['storage', '#panel-sys-storage'],
  ['runtime', '#panel-sys-runtime'],
  ['catalog', '#panel-sys-catalog'],
  ['projects', '#panel-sys-projects'],
  ['maintenance', '#panel-sys-maintenance'],
];

// /api/limits stub (ADR-0010): injected so the harness never spawns a real
// codex or reads ~/.config. Shape mirrors quota.mjs output, deliberately
// including the null-heavy edges (missing resetsAt, credit without expiry)
// that are exactly where fmtters leak "null"/"Invalid Date" into the DOM.
const LIMITS_STUB = async () => ({
  generatedAt: new Date().toISOString(),
  claude: {
    provider: 'claude', source: 'statusline', fetchedAt: Date.now() - 3 * 60_000,
    sessionId: 'ui-stub', windows: [
      { id: 'five_hour', label: '5h', usedPercent: 3, windowMinutes: 300, resetsAt: Math.round(Date.now() / 1000) + 7200 },
      { id: 'seven_day', label: 'weekly', usedPercent: 89, windowMinutes: 10080, resetsAt: Math.round(Date.now() / 1000) + 172800 },
      { id: 'seven_day_sonnet', label: 'weekly · sonnet', usedPercent: 46, windowMinutes: 10080, resetsAt: null },
    ],
  },
  codex: {
    provider: 'codex', source: 'app-server', fetchedAt: Date.now() - 60_000, planType: 'prolite',
    // Post-dedup shape (quota.mjs): app-server reports the weekly pool under
    // BOTH the named lane and the legacy generic `codex` one, and the
    // normalizer keeps the named copy — so what reaches the browser is a named
    // lane carrying both windows, never a generic twin. The long pool name is
    // the point: it is what the label column used to ellipsise.
    lanes: [
      {
        id: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', planType: 'prolite',
        windows: [
          { label: '5h', usedPercent: 7, windowMinutes: 300, resetsAt: Math.round(Date.now() / 1000) + 9000 },
          { label: 'weekly', usedPercent: 21, windowMinutes: 10080, resetsAt: Math.round(Date.now() / 1000) + 500000 },
        ],
      },
      // A named pool whose windows are all unusable still gets a row saying so.
      { id: 'codex_othermodel', name: 'GPT-5.3-Codex-Mini', planType: 'prolite', windows: [] },
    ],
    resetCredits: { availableCount: 2, credits: [{ status: 'available', title: 'Full reset', expiresAt: null }] },
  },
});

// /api/hooks stub: raw audit + bounded receipts. Dashboard Delivery must run
// this through buildHookDashboardReadModel before the browser sees it. The
// sentinel path/prose makes accidental raw forwarding visible.
const HOOKS_SECRET = 'TOKEN=ui-secret-value';
const hooksStub = ({ file, digest }) => async () => ({
  audit: {
    auditId: 'ui-hook-audit', mode: 'read-only', hosts: ['codex'], runtimeVersions: { codex: 'test' },
    reports: {
      codex: {
        hostSchema: { confidence: 'syntax-only' },
        sources: [{ file, status: 'valid', digest }],
        summary: { sources: 1, invalidSources: 0, hookOccurrences: 7, uniqueBehaviors: 7, configurationIssues: 0 },
        records: [{
          occurrenceId: 'ui-hook-occurrence', behaviorFingerprint: 'ui-hook-behavior', host: 'codex',
          event: 'Stop', matcher: '', type: 'command', indices: { group: 0, hook: 0 }, handler: { async: false },
          source: { file, baseDir: path.dirname(file), digest, sourceKind: 'project', authority: 'project-owned', generatedStatus: 'direct', owner: 'project-owner' },
          command: { normalized: 'TOKEN=<redacted> node stop.cjs', redacted: true },
          timeout: { declared: 5, effective: 3, units: 'seconds', status: 'clamped' },
          sideEffects: ['state-write-possible'], selected: true,
          diagnostics: [{
            code: 'aqe-npx-hot-path-fallback', severity: 'warning', category: 'reliability',
            message: HOOKS_SECRET,
          }],
        }, ...Array.from({ length: 6 }, (_, index) => ({
          occurrenceId: `ui-hook-occurrence-${index + 2}`,
          behaviorFingerprint: `ui-hook-behavior-${index + 2}`, host: 'codex',
          event: index === 0 ? 'PostToolUse' : 'Stop', matcher: `fixture-${index + 2}`,
          type: 'command', indices: { group: 0, hook: 0 }, handler: { async: false },
          source: { file, baseDir: path.dirname(file), digest, sourceKind: 'project',
            authority: 'project-owned', generatedStatus: 'direct', owner: 'project-owner' },
          timeout: { declared: 5, effective: 5, units: 'seconds', status: 'valid' },
          sideEffects: [], selected: true, diagnostics: index === 0 ? [{
            code: 'aqe-npx-hot-path-fallback', severity: 'warning', category: 'reliability',
            message: HOOKS_SECRET,
          }] : index === 1 ? [{
            code: 'dynamic-shell', severity: 'review', category: 'security', message: HOOKS_SECRET,
          }] : index === 2 ? [{
            code: 'trust-independent', severity: 'info', category: 'trust', message: HOOKS_SECRET,
          }] : [],
        }))],
        plan: [{ classification: 'upstream-required', target: 'agentic-qe', reason: HOOKS_SECRET }],
        coverage: { status: 'partial', gaps: ['runtime trust not observed'] },
      },
    },
  },
  receipts: [{
    hostId: 'codex', verb: 'Stop', outcome: 'nonzero-exit', durationMs: 42,
    command: HOOKS_SECRET, stdout: HOOKS_SECRET, stderr: HOOKS_SECRET,
  }],
});

// /api/status stub. Status is stubbed so the panel never shells out or hits the
// network; the point of this harness is the RENDERING, not the status collector.
//
// The rows carry MORE than Overview needs, because About's state chips are a
// JOIN over exactly these rows (ADR-0026) and a three-row payload would leave
// every chip reading "state unknown" — which is a real state, but then the
// installed/needs-attention/not-working states would go untested. The shapes
// that matter are deliberate:
//   · `codex` is enabled but ABSENT — the honest not-installed case, which must
//     render a full card with a "not working" chip, never an empty slot.
//   · `statusline` is ok while `codex-statusline` warns — one card joins both,
//     so the WORST of the pair has to drive the chip.
//   · nothing emits a `permissions` row, so that card must degrade to unknown:
//     an unjoined key is an unmeasured fact, never a satisfied one.
const STATUS_STUB = async () => ({
  overall: 'warn',
  rows: [
    { subsystem: 'versions', level: 'ok', message: 'ruflo 4.0.0 (latest)', fix: null },
    { subsystem: 'natives', level: 'fail', message: 'WASM fallback', fix: 'ak sync' },
    { subsystem: 'learning', level: 'warn', message: 'no patterns yet', fix: null },
    { subsystem: 'hosts', level: 'ok', message: 'claude enabled and installed', fix: null },
    { subsystem: 'hosts', level: 'fail', message: 'codex enabled but not installed', fix: 'ak setup' },
    { subsystem: 'hosts', level: 'ok', message: 'opencode enabled and installed', fix: null },
    { subsystem: 'agentdb', level: 'ok', message: 'store reachable', fix: null },
    { subsystem: 'agent-browser', level: 'ok', message: 'agent-browser 0.27.3 ready for Ruflo', fix: null },
    { subsystem: 'aqe', level: 'warn', message: 'fleet has never been initialized', fix: 'aqe init' },
    { subsystem: 'security', level: 'ok', message: 'scan clean', fix: null },
    { subsystem: 'ruvnet-brain', level: 'ok', message: 'knowledge base present', fix: null },
    { subsystem: 'self', level: 'ok', message: 'agentic-kit up to date', fix: null },
    { subsystem: 'mcp', level: 'ok', message: '3 servers registered at user scope', fix: null },
    { subsystem: 'blocks', level: 'ok', message: 'guidance blocks in sync', fix: null },
    { subsystem: 'statusline', level: 'ok', message: 'claude statusline installed', fix: null },
    { subsystem: 'codex-statusline', level: 'warn', message: 'codex statusline missing', fix: 'ak sync' },
    { subsystem: 'routing', level: 'ok', message: 'per-activity policy applied', fix: null },
    { subsystem: 'daemons', level: 'ok', message: '1 daemon running', fix: null },
  ],
  drift: [
    { pkg: 'ruflo', installed: '4.0.0', latest: '4.0.1', outdated: true },
    { pkg: 'agent-browser', installed: '0.27.3', latest: null, outdated: false },
  ],
});

// ── /api/system stub (ADR-0025) ──────────────────────────────────────────────
// Injected exactly the way `live` and `usage` are, and for a stronger reason:
// the real collector walks five trees and surveys every host process on the
// machine, so a UI harness that let it run would be slow, non-deterministic,
// and different on every developer's laptop. This stub answers the same wire
// shape the collector produces (walk.mjs's Measurement vocabulary) and counts
// the deep scans it is asked for, which is how "never auto-scan on open" below
// is proved rather than assumed.
const SYS_NOW = Date.now();
// Nine days back: past the ~7-day staleness horizon, so the freshness label's
// nudge is exercised. It is a MEASURED figure carried forward with ITS own asOf
// — the whole point of the deep tier — not a re-stamped current one.
const SYS_DEEP_ASOF = SYS_NOW - 9 * 24 * 3600 * 1000;
const meas = (value, partial = false) => ({
  value, status: 'measured', reason: null, asOf: SYS_DEEP_ASOF, partial,
});
const unmeasured = (reason) => ({ value: null, status: 'unknown', reason, asOf: null, partial: false });
// Deterministic day series — a generator, not a literal, so the window length
// is stated once and the growth panels have a visible shape to draw.
const growthDays = (base, n = 14) => Array.from({ length: n }, (_, i) => ({
  bytes: base + (i % 5) * Math.round(base / 4),
}));

const SYSTEM_PAYLOAD = {
  generatedAt: new Date(SYS_NOW).toISOString(),
  platform: 'darwin',
  runtime: {
    observedAt: new Date(SYS_NOW).toISOString(),
    // One attributable process and one that is not: the census must state WHY a
    // process could not be tied to a project (this is the shape the Windows
    // P/Invoke fallback degrades to) rather than blanking the cell or guessing.
    processes: meas([
      {
        host: 'claude', pid: 4242,
        project: { value: { label: 'agentic-kit', path: '/Users/me/proj' }, status: 'measured', reason: null, asOf: SYS_NOW, partial: false },
        uptimeMs: meas(5_400_000), cpuPercent: meas(3.5), rssBytes: meas(412_000_000),
      },
      {
        host: 'codex', pid: 4711,
        project: unmeasured('not attributable on this platform — the working directory is not readable'),
        uptimeMs: meas(900_000), cpuPercent: meas(0.8), rssBytes: meas(180_000_000),
      },
    ]),
    childProcessCount: meas(3),
    totals: { processCount: meas(2), rssBytes: meas(592_000_000), cpuPercent: meas(4.3) },
    machine: { physicalMemoryBytes: meas(34_359_738_368), cpuCount: meas(12) },
    daemons: {
      count: meas(1),
      // A MEASURED zero, and it must render as "0" — the fail-closed rule bans
      // fabricating a zero for something unmeasured, not reporting a real one.
      staleCount: meas(0),
      ttlSecs: 43_200, oldestAgeSecs: meas(7200),
      budget: unmeasured('no readable budget state'),
    },
  },
  install: {
    totals: {
      installBytes: meas(1_284_000_000),
      toolsPresent: meas(6),
      // DELIBERATELY ABSENT: this figure was never measured. A renderer that
      // prints 0 for a missing Measurement fails the "no fabricated zero"
      // assertion below; the honest render is "not measured yet".
    },
    disk: { totalBytes: meas(994_662_584_320), freeBytes: meas(211_000_000_000) },
    tools: [
      { label: 'ruflo', bytes: meas(612_000_000) },
      { label: 'agentic-qe', bytes: meas(318_000_000) },
      { label: 'agentic-kit', bytes: meas(96_000_000) },
      {
        tool: 'agent-browser', label: 'agent-browser', present: false, version: null,
        installMethod: 'absent', managed: true, updateOwner: 'agentic-kit', bytes: meas(0),
      },
      {
        tool: 'vibium', label: 'Vibium', present: true, version: '26.5.31',
        installMethod: 'npm', managed: false, updateOwner: 'agentic-qe',
        root: '/opt/npm/node_modules/vibium', bytes: meas(48_000_000),
      },
    ],
    sharedCaches: [
      { label: 'shared npm cache', bytes: meas(258_000_000) },
      {
        id: 'agent-browser', runtime: 'agent-browser', label: 'agent-browser Chrome for Testing',
        updateOwner: 'agentic-kit', path: '/Users/me/.agent-browser/browsers', bytes: meas(0),
        payload: { status: 'absent', revision: null, reason: 'browser payload cache absent' },
      },
      {
        id: 'vibium', runtime: 'vibium', label: 'Vibium Chrome for Testing',
        updateOwner: 'agentic-qe', path: '/Users/me/Library/Caches/vibium', bytes: meas(392_000_000),
        payload: { status: 'ready', revision: '148.0.7778.56', reason: null },
      },
    ],
  },
  storage: {
    totals: { bytes: meas(4_812_000_000) },
    categories: [
      {
        key: 'transcripts', label: 'transcripts', bytes: meas(3_100_000_000),
        children: [
          { key: 'claude', host: 'claude', bytes: meas(2_100_000_000) },
          { key: 'codex', host: 'codex', bytes: meas(820_000_000) },
          { key: 'opencode', host: 'opencode', bytes: meas(180_000_000) },
        ],
      },
      {
        key: 'ledgers-and-logs', label: 'ledgers and logs', bytes: meas(640_000_000),
        children: [
          { key: 'claude', host: 'claude', bytes: meas(420_000_000) },
          { key: 'codex', host: 'codex', bytes: meas(220_000_000) },
        ],
      },
      {
        key: 'learning-stores', label: 'learning stores', bytes: meas(812_000_000),
        children: [{ key: 'agentic-kit', host: 'agentic-kit', bytes: meas(812_000_000) }],
      },
      {
        key: 'kit-caches', label: 'kit caches', bytes: meas(260_000_000),
        children: [{ key: 'agentic-kit', host: 'agentic-kit', bytes: meas(260_000_000) }],
      },
    ],
    growth: {
      windowDays: 14, basis: 'file mtime and size only',
      hosts: [
        { host: 'claude', days: growthDays(21_000_000), perDayAvgBytes: meas(31_500_000), totalBytes: meas(441_000_000) },
        { host: 'codex', days: growthDays(6_000_000), perDayAvgBytes: meas(9_000_000), totalBytes: meas(126_000_000) },
      ],
    },
    reclaimables: [{
      label: 'transcripts older than the retention window',
      bytes: meas(410_000_000),
      rationale: 'past the 30 days the usage index reads, so nothing on this dashboard needs them',
      path: '/Users/me/.claude/projects',
      cleanupHint: 'ak system --help',
    }],
    topSessions: [
      { session: 'uitrunc01', host: 'claude', project: 'proj', bytes: 84_000_000, path: '/Users/me/.claude/projects/-Users-me-proj/uitrunc01.jsonl', attribution: 'cwd' },
      { session: 'orphan0001', host: 'codex', project: null, bytes: 51_000_000, path: '/Users/me/.codex/sessions/orphan0001.jsonl', attribution: 'none' },
    ],
  },
  // Never deep-scanned on this machine. The whole section is `null` rather than
  // an object of zeros — there is no numeric field for a renderer to misread.
  catalog: null,
  projects: {
    count: meas(2), truncated: false,
    projects: [
      {
        label: 'agentic-kit',
        loc: { total: meas(48_210), byLanguage: { JavaScript: 31_000, Markdown: 12_000, CSS: 3100, JSON: 2110 } },
        treeBytes: meas(42_000_000), gitBytes: meas(120_000_000), nodeModulesBytes: meas(310_000_000),
        totalBytes: meas(472_000_000), lastActivity: meas(SYS_NOW - 3_600_000),
        hosts: ['claude', 'codex'],
        remote: {
          status: 'linked', webUrl: 'https://github.com/example/agentic-kit',
          host: 'github.com', slug: 'example/agentic-kit', raw: 'git@github.com:example/agentic-kit.git',
        },
      },
      {
        // A linked repo on a snapshot too old to carry `hosts`. It must still be
        // listed: absent is not zero, and blanking it would be the fail-closed
        // rule inverted.
        label: 'legacy-snapshot-row',
        loc: { total: meas(1200), byLanguage: { Rust: 1200 } },
        treeBytes: meas(1_000), gitBytes: meas(1_000), nodeModulesBytes: meas(0),
        totalBytes: meas(2_000), lastActivity: meas(SYS_NOW - 7_200_000),
        remote: {
          status: 'linked', webUrl: 'https://github.com/example/legacy',
          host: 'github.com', slug: 'example/legacy', raw: 'git@github.com:example/legacy.git',
        },
      },
      {
        // Linked and worked in, but its figures were never measured. It must
        // still LIST, and must sort to the bottom in BOTH directions — an
        // absent figure is not a small one.
        label: 'zz-unmeasured',
        loc: { total: unmeasured('the working tree could not be read'), byLanguage: {} },
        treeBytes: meas(1), gitBytes: meas(1), nodeModulesBytes: meas(0),
        totalBytes: unmeasured('the working tree could not be read'),
        lastActivity: unmeasured('no readable entry'),
        hosts: ['claude'],
        remote: {
          status: 'linked', webUrl: 'https://github.com/example/unmeasured',
          host: 'github.com', slug: 'example/unmeasured', raw: 'git@github.com:example/unmeasured.git',
        },
      },
      {
        // Linked, but no host ever recorded a session here.
        label: 'never-worked-in',
        loc: { total: meas(10), byLanguage: { Rust: 10 } },
        treeBytes: meas(10), gitBytes: meas(10), nodeModulesBytes: meas(0),
        totalBytes: meas(20), lastActivity: meas(SYS_NOW - 9_200_000),
        hosts: [],
        remote: {
          status: 'linked', webUrl: 'https://github.com/example/untouched',
          host: 'github.com', slug: 'example/untouched', raw: 'git@github.com:example/untouched.git',
        },
      },
      {
        label: 'scratch',
        loc: { total: unmeasured('the working tree could not be read'), byLanguage: {} },
        treeBytes: meas(4_000_000), gitBytes: meas(1_000_000), nodeModulesBytes: meas(0),
        totalBytes: meas(5_000_000), lastActivity: unmeasured('no readable entry'),
        hosts: ['claude'],
        remote: { status: 'none', reason: 'local only, no git remote' },
      },
    ],
  },
  snapshot: {
    present: true,
    file: '/Users/me/.config/agentic-kit/footprint-snapshot.json',
    reason: null,
    completeness: { measured: 3, total: 4, missing: ['catalog'] },
    measured: true, asOf: SYS_DEEP_ASOF, ageMs: SYS_NOW - SYS_DEEP_ASOF,
    stale: true, staleAfterMs: 7 * 24 * 3600 * 1000,
  },
  cheapTier: { asOf: SYS_NOW, ttlMs: 60_000 },
  scan: {
    running: false, phase: 'idle', scanned: 0, total: 0, path: null,
    startedAt: null, finishedAt: null, durationMs: null, error: null, asOf: null,
  },
};

let systemDeepScans = 0;
const SYSTEM_STUB = {
  // Cloned per read for the same reason the real collector re-assembles: a
  // renderer that mutated the payload in place would silently corrupt every
  // later assertion, and a shared object would hide that.
  read: async () => JSON.parse(JSON.stringify(SYSTEM_PAYLOAD)),
  refreshDeep: async () => { systemDeepScans += 1; return { ok: true }; },
  scanState: () => ({ ...SYSTEM_PAYLOAD.scan }),
};

const MAINTENANCE_PAYLOAD = {
  schemaVersion: 1,
  mode: 'supervised',
  capabilities: { plan: true, apply: true, undo: true },
  asOf: new Date(Date.now() - 6 * 60_000).toISOString(),
  scan: {
    status: 'complete', checkedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    coverage: 'partial', providersChecked: 3, providersComplete: 2, providersTotal: 3,
  },
  freshness: { stale: false, complete: false },
  summary: {
    total: 4, updatesReady: 1, safeCleanup: 1, needsReview: 1, blocked: 1,
    recentChanges: 0, incompleteSources: 1, actionable: 2,
  },
  findings: [{
    id: 'plugin-update', bucket: 'updatesReady', statusLabel: 'Ready to apply',
    headline: '0.2.0 → 0.3.1',
    explanation: 'A compatible version is available from the same marketplace source.',
    resource: {
      kind: 'plugin', name: 'rust-optimizer', host: 'codex', scope: 'user',
      providerRef: 'rust-optimizer@rust-optimizer',
    },
    owner: 'Codex plugin manager',
    consumerHosts: { basis: 'catalog-presence', hosts: ['codex'], count: 1, truncated: false },
    evidence: {
      source: 'codex plugin list --json', authority: 'host-native',
      asOf: new Date(Date.now() - 6 * 60_000).toISOString(), completeness: 'complete', health: 'healthy', reasons: [],
    },
    versions: { installed: '0.2.0', effective: '0.2.0', recommended: '0.3.1', producer: '0.2.0' },
    impact: {
      summary: 'The owning plugin and its contributed capabilities would change.',
      capabilities: ['4 skills', '2 commands'], projects: ['agentic-kit', 'finima'],
      preserved: ['standalone skill-creator'],
    },
    nextAction: {
      operation: 'update', label: 'Upgrade rust-optimizer to 0.3.1',
      recommendation: 'Codex will replace only this plugin after you confirm the preview.',
      steps: ['Preview the update.', 'Confirm version 0.3.1 and the affected capabilities.', 'Apply the update and restart Codex.'],
      preserved: ['standalone skill-creator'],
      executable: true, safetyClass: 'safe-automatic eligible', restartRequired: true,
      rollback: 'compensating reinstall of 0.2.0',
    },
  }, {
    id: 'cache-cleanup', bucket: 'safeCleanup', statusLabel: 'Ready to apply',
    headline: 'Owner-native cache cleanup is available',
    explanation: 'This cache is reproducible and its owner reports a bounded cleanup operation.',
    resource: { kind: 'storage', name: 'Codex plugin download cache', host: 'codex', scope: 'user', providerRef: 'codex' },
    owner: 'Codex plugin manager',
    evidence: { source: 'deep scan', authority: 'agentic-kit observation', completeness: 'complete', health: 'healthy', reasons: [] },
    versions: {}, impact: { summary: 'Reproducible downloads would be removed and fetched again on demand.', preserved: ['installed plugins'] },
    nextAction: {
      operation: 'clean', label: 'Clear the Codex plugin download cache',
      recommendation: 'Codex can recreate every download in this cache.',
      steps: ['Preview the cleanup.', 'Confirm installed plugins are excluded.', 'Clear the cache and rescan.'],
      preserved: ['installed plugins'], executable: true,
      safetyClass: 'safe-automatic eligible', rollback: 're-fetch', restart: 'not-required',
    },
  }, {
    id: 'modified-skill', bucket: 'needsReview', statusLabel: 'Evidence incomplete',
    headline: 'Content changed after projection',
    explanation: '<img src=x onerror="globalThis.__maintXss=1"> is evidence text, not markup.',
    resource: { kind: 'skill', name: 'skill-creator', host: 'codex', scope: 'user', providerRef: 'agentic-kit projection' },
    owner: 'Ownership not proven',
    evidence: {
      source: 'bounded entrypoint digest', authority: 'local observation', completeness: 'partial', health: 'modified',
      reasons: ['The current digest does not match the receipt.', 'Supporting files were not fully readable.'],
    },
    versions: { installed: 'modified', contentDigest: 'sha256:ui-fixture' },
    impact: { summary: 'The skill is preserved while ownership is unresolved.', preserved: ['current modified content'] },
    relationship: {
      kind: 'same-name-different-definition', basis: 'different-definition', resolution: 'not-reported',
      memberCount: 2, truncated: false, members: [
        { role: 'project-copy', label: 'Observed project copy', host: 'codex', scope: 'project', projectLabel: 'agentic-kit', ownership: 'unknown', tracking: 'tracked', workingTree: 'clean' },
        { role: 'shared-copy', label: 'Observed shared copy', host: 'codex', scope: 'user', providerRef: 'agentic-kit projection', ownership: 'user-owned', tracking: 'unknown', workingTree: 'unknown' },
      ],
    },
    nextAction: {
      operation: 'review', label: 'Choose one definition, or rename the project copy',
      recommendation: 'The project and shared skill implement different behavior.',
      steps: ['Compare both definitions.', 'Choose the source of truth.', 'Rename or remove the unintended copy, then rescan.'],
      preserved: ['both copies until you decide'],
      blockedReason: 'Agentic Kit cannot infer which behavior you intend.',
    }, action: { safetyClass: 'approval-required' },
  }, {
    id: 'mcp-blocked', bucket: 'unsupportedOrBlocked', statusLabel: 'Cannot safely automate',
    headline: 'No host-native removal provider',
    explanation: 'Registration is observed, but the host does not expose a safe native lifecycle operation.',
    resource: { kind: 'mcp-server', name: 'legacy-tools', host: 'opencode', scope: 'user', providerRef: 'opencode config' },
    owner: 'OpenCode',
    evidence: { source: 'host config', authority: 'configuration', completeness: 'complete', health: 'unsupported', reasons: [] },
    versions: {}, impact: { summary: 'No automated change is proposed.', preserved: ['current registration'] },
    nextAction: {
      operation: 'remove', label: 'Remove legacy-tools with OpenCode’s MCP workflow',
      recommendation: 'The current registration remains active until you remove it in OpenCode.',
      steps: ['Open the OpenCode MCP configuration.', 'Remove only legacy-tools.', 'Restart OpenCode and run a deep System rescan.'],
      preserved: ['other MCP registrations'],
      blockedReason: 'OpenCode does not expose an exact removal action to this dashboard.',
    }, action: { safetyClass: 'upstream-required', reason: 'OpenCode does not expose an exact removal action to this dashboard.' },
  }],
  receipts: [],
};

let chainedMaintenanceScans = 0;
const MAINTENANCE_STUB = {
  async report() { return MAINTENANCE_PAYLOAD; },
  async scan() { chainedMaintenanceScans += 1; return MAINTENANCE_PAYLOAD; },
  async plan() { return {}; },
};

const MAINTENANCE_HISTORY = [
  'committed', 'rolled-back', 'aborted-no-change', 'recovered-no-change',
  'partial-recovery-required', 'unknown-recovery-required', 'applying',
  'verifying', 'refreshing-catalog', 'undoing',
].map((status, index) => ({
  id: `receipt-${status}`, status, headline: `Maintenance receipt ${index + 1}`,
  updatedAt: new Date(Date.now() - ((index + 1) * 60_000)).toISOString(),
  actionCount: 1,
  // Deliberately hostile eligibility proves that recovery and settled no-change
  // statuses cannot surface Undo merely because one boolean is malformed.
  undoEligible: true, undo: { eligible: true },
}));

const LIVE_SNAPSHOT = {
  schemaVersion: 1,
  cursor: 'live:3',
  projects: [{
    id: 'project:agentic-kit', label: 'agentic-kit',
    sessions: ['codex:ui-live-session', 'claude:ui-review-session', 'opencode:ui-opencode-session'],
    sessionCount: 3, childSessionCount: 1, liveCount: 1, presentCount: 1,
    workingCount: 1, completedCount: 1,
    hosts: { codex: 1, claude: 1, opencode: 1 },
    providers: { openai: 1, anthropic: 1, unknown: 1 }, updatedAt: new Date().toISOString(),
  }],
  health: {
    claude: { status: 'ok', files: 2, events: 8, errors: 0, lastError: null },
    codex: { status: 'error', files: 1, events: 3, errors: 1, lastError: '/Users/private/.codex/secret.jsonl invalid-json' },
  },
  sessions: [{
    id: 'ui-live-session', key: 'codex:ui-live-session', project: 'agentic-kit',
    projectKey: 'project:agentic-kit', host: 'codex', status: 'running', lifecycle: 'active',
    presence: { state: 'present', lastObservedAt: new Date().toISOString(), evidence: 'observed' },
    activity: { state: 'working', lastActivityAt: new Date().toISOString(), currentOperationId: 'ui-live-tool', evidence: 'observed' },
    coverage: { presence: 'observed', activity: 'events', actors: 'child-sessions', resources: 'lifecycle', hierarchy: 'observed', transcript: 'session', playback: 'session', providerIdentity: 'observed' },
    workspace: {
      key: 'workspace:0123456789abcdef', repositoryLabel: 'agentic-kit',
      directoryLabel: 'repo root', branchLabel: 'feature/observability', branchState: 'attached',
      changes: { additions: 42, deletions: 7, files: 3, binaryFiles: 0,
        basis: 'tracked-vs-head', completeness: 'untracked-and-binary-lines-excluded',
        capturedAt: new Date().toISOString() },
      capturedAt: new Date().toISOString(), source: 'git', confidence: 'observed',
    },
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'ui-live-session', kind: 'session', role: 'primary', host: 'codex',
        provider: 'openai', providerProvenance: 'observed',
        surface: 'native', status: 'running', confidence: 'observed' },
      { id: 'ui-live-agent', kind: 'subagent', label: 'Bohr', role: 'tester', host: 'codex', surface: 'ruflo', status: 'running', confidence: 'observed', lastAction: 'agent.output', model: '<synthetic>', observedAt: new Date().toISOString(), sourceAdapter: 'codex-rollout' },
      { id: 'ui-live-tool', kind: 'tool', label: 'Read', host: 'codex', surface: 'native', status: 'running', confidence: 'observed', lastAction: 'tool.started', observedAt: new Date().toISOString(), sourceAdapter: 'codex-rollout' },
      { id: 'ui-live-gate', kind: 'gate', role: 'qe-court', host: 'internal', surface: 'aqe', status: 'queued', confidence: 'planned' },
    ],
    edges: [
      { id: 'spawn', source: 'ui-live-session', target: 'ui-live-agent', action: 'agent.spawned', confidence: 'observed', signal: { kind: 'relationship', phase: 'observed' }, status: 'running' },
      { id: 'read', source: 'ui-live-agent', target: 'ui-live-tool', action: 'tool.started', confidence: 'observed', signal: { kind: 'operation', phase: 'started' }, status: 'running' },
      { id: 'gate', source: 'ui-live-agent', target: 'ui-live-gate', action: 'evaluation.requested', confidence: 'planned', signal: { kind: 'relationship', phase: 'planned' }, status: 'queued' },
    ],
  }, {
    id: 'ui-live-agent', key: 'codex:ui-live-agent', parentSessionId: 'ui-live-session',
    parentSessionKey: 'codex:ui-live-session', rootSessionKey: 'codex:ui-live-session',
    hierarchyState: 'child', navigationRoot: false,
    project: 'agentic-kit', projectKey: 'project:agentic-kit', host: 'codex',
    status: 'running', lifecycle: 'active', updatedAt: new Date().toISOString(),
    presence: { state: 'unknown', lastObservedAt: null, evidence: 'unknown' },
    activity: { state: 'working', lastActivityAt: new Date().toISOString(), currentOperationId: null, evidence: 'observed' },
    coverage: { presence: 'unavailable', activity: 'events', actors: 'child-sessions', resources: 'lifecycle', hierarchy: 'observed', transcript: 'session', playback: 'session', providerIdentity: 'observed' },
    nodes: [{ id: 'ui-live-agent', kind: 'session', role: 'tester', host: 'codex',
      provider: 'openai', providerProvenance: 'observed', status: 'running' }],
    edges: [],
  }, {
    id: 'ui-review-session', key: 'claude:ui-review-session', project: 'agentic-kit',
    projectKey: 'project:agentic-kit', host: 'claude', status: 'completed',
    presence: { state: 'unknown', lastObservedAt: null, evidence: 'unknown' },
    activity: { state: 'idle', lastActivityAt: new Date(Date.now() - 60_000).toISOString(), currentOperationId: null, evidence: 'observed' },
    coverage: { presence: 'unavailable', activity: 'events', actors: 'embedded-actors', resources: 'lifecycle', hierarchy: 'correlated', transcript: 'session', playback: 'session', providerIdentity: 'observed' },
    workspace: {
      key: 'workspace:fedcba9876543210', repositoryLabel: 'agentic-kit',
      directoryLabel: 'repo root', branchLabel: 'main', branchState: 'attached',
      changes: { additions: 8, deletions: 2, files: 2, binaryFiles: 0,
        basis: 'tracked-vs-head', completeness: 'untracked-and-binary-lines-excluded',
        capturedAt: new Date(Date.now() - 60_000).toISOString() },
      capturedAt: new Date(Date.now() - 60_000).toISOString(), source: 'git', confidence: 'observed',
    },
    startedAt: new Date(Date.now() - 180_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    nodes: [
      { id: 'ui-review-session', kind: 'session', host: 'claude',
        provider: 'anthropic', providerProvenance: 'observed', status: 'completed',
        sourceAdapter: 'claude-transcript' },
      { id: 'claude-reviewer', kind: 'subagent', label: 'Reviewer', role: 'reviewer',
        host: 'claude', status: 'completed', confidence: 'correlated',
        sourceAdapter: 'claude-transcript' },
    ],
    edges: [{ id: 'claude-contains', source: 'ui-review-session', target: 'claude-reviewer',
      action: 'contains', confidence: 'correlated',
      signal: { kind: 'relationship', phase: 'observed' }, status: 'completed' }],
  }, {
    id: 'ui-opencode-session', key: 'opencode:ui-opencode-session', project: 'agentic-kit',
    projectKey: 'project:agentic-kit', host: 'opencode', status: 'expired', lifecycle: 'historical',
    presence: { state: 'unknown', lastObservedAt: null, evidence: 'unknown' },
    activity: { state: 'idle', lastActivityAt: new Date(Date.now() - 120_000).toISOString(), currentOperationId: null, evidence: 'unknown' },
    coverage: { presence: 'observed', activity: 'presence-only', actors: 'unavailable', resources: 'unavailable', hierarchy: 'unavailable', transcript: 'unavailable', playback: 'unavailable', providerIdentity: 'unknown', workspaceIdentity: 'observed', gitBranch: 'observed', gitChanges: 'observed' },
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    workspace: {
      key: 'workspace:0011223344556677', repositoryLabel: 'agentic-kit',
      directoryLabel: 'repo root', branchLabel: 'feature/opencode', branchState: 'attached',
      changes: { additions: 5, deletions: 1, files: 1, binaryFiles: 0,
        basis: 'tracked-vs-head', completeness: 'untracked-and-binary-lines-excluded',
        capturedAt: new Date(Date.now() - 120_000).toISOString() },
      capturedAt: new Date(Date.now() - 120_000).toISOString(), source: 'git', confidence: 'observed',
    },
    nodes: [{ id: 'ui-opencode-session', kind: 'session', role: 'primary', host: 'opencode',
      provider: null, providerProvenance: 'unknown', status: 'expired' }],
    edges: [],
  }],
};

const LIVE_STUB = {
  start: async () => {},
  snapshot: async () => LIVE_SNAPSHOT,
  // The fixture is static, so History's ?window= is a no-op here — the real
  // LiveSessionsService history scan and pagination are covered by
  // tests/kit/live-service.test.mjs; this stub only needs to exist so the
  // Observability → History tab has something to render end-to-end.
  historySnapshot: async () => LIVE_SNAPSHOT,
  historyPage: async () => ({
    ...LIVE_SNAPSHOT,
    pagination: {
      pageSize: 100, offset: 0, returned: LIVE_SNAPSHOT.sessions.length,
      total: LIVE_SNAPSHOT.sessions.length, totalExact: true,
      hasMore: false, nextPageToken: null,
    },
    coverage: {
      complete: true, timeBasis: 'file-mtime', scannedAt: new Date().toISOString(),
      sources: {
        claude: { candidateFiles: 2, returnedFiles: 2, fileLimit: 8192, truncated: false },
        codex: { candidateFiles: 1, returnedFiles: 1, fileLimit: 8192, truncated: false },
      },
    },
  }),
  replay: async () => ({ reset: false, events: [] }),
  subscribe: () => () => {},
  close: async () => {},
};
const TRANSCRIPT_STUB = {
  open(host, id) {
    const event = {
      eventId: `tx-${host}-${id}:1`, sessionId: id, host, kind: 'message',
      actor: { id: 'ui-live-session', role: 'assistant', label: 'Codex' },
      text: 'Connected to the local transcript stream.',
    };
    return {
      snapshot: () => ({ schemaVersion: 1, cursor: event.eventId, events: [event] }),
      replay: () => ({ reset: false, events: [] }),
      subscribe: () => () => {},
    };
  },
  close() {},
};
const MODEL_AT = '2026-08-25T13:00:00.000Z';
const MODELS_STUB = {
  status: 'cached',
  snapshot: {
    schemaVersion: 1, snapshotId: 'models:ui-private', capturedAt: MODEL_AT,
    scope: { fingerprint: 'scope:ui-private', hosts: ['codex'], profileFingerprints: {} },
    sources: [{ id: 'codex-cache', owner: 'codex', ownerType: 'host', transport: 'file', network: 'never',
      mode: 'local', status: 'complete', complete: true, capturedAt: MODEL_AT,
      schema: 'codex-model-cache-v1', scopeFingerprint: 'scope:ui-private' },
    { id: 'ollama-catalog', owner: 'ollama', ownerType: 'provider', transport: 'http', network: 'local',
      mode: 'local', status: 'complete', complete: true, capturedAt: MODEL_AT,
      schema: 'ollama-api-v1', scopeFingerprint: 'scope:ui-private' },
    { id: 'anthropic-docs', owner: 'anthropic', ownerType: 'provider', transport: 'index', network: 'never',
      mode: 'local', status: 'complete', complete: true, capturedAt: MODEL_AT,
      sourceVersion: '2026-08-25', schema: 'anthropic-public-models-v1',
      scopeFingerprint: 'scope:ui-private' }],
    models: [{
      key: { host: 'opencode', provider: 'ui-private-provider', modelId: 'ui-private-deployment',
        scopeId: 'scope:ui-private', digest: 'ui-private-digest' },
      displayName: 'UI Private Deployment', aliases: [{ name: 'ui-private-alias',
        resolvesTo: 'ui-private-deployment', observedAt: MODEL_AT, evidenceRefs: ['ui-private-evidence'] }],
      variant: { reasoningEffort: 'high' }, visibility: 'visible', capabilities: { tools: true }, pricing: null,
      lifecycle: { state: 'retiring', replacement: 'ui-private-replacement',
        notice: 'https://developers.openai.com/api/docs/deprecations/', evidenceRefs: ['ui-lifecycle-notice'] },
      edges: [{ kind: 'first-party-migration', from: 'ui-private-deployment', to: 'ui-private-replacement',
        provenance: 'first-party', scopeFingerprint: 'scope:ui-private', evidenceRefs: ['ui-private-evidence'] }],
      dimensions: { configured: { value: true, evidenceRefs: ['ui-private-evidence'] },
        effective: { value: true, evidenceRefs: ['ui-private-evidence'] },
        observed: { value: true, evidenceRefs: ['ui-usage-observed'] },
        discoverable: { value: true, evidenceRefs: ['ui-private-evidence'] },
        entitled: { value: true, evidenceRefs: ['ui-usage-entitled'] },
        policyAllowed: { value: true, evidenceRefs: ['ui-usage-policy'] },
        routable: { value: true, evidenceRefs: ['ui-usage-routable'] } },
      evidence: [{ id: 'ui-private-evidence', field: 'catalog', source: 'codex-cache', class: 'catalog',
        capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] },
      { id: 'ui-lifecycle-notice', field: 'lifecycle', source: 'codex-cache', class: 'first-party',
        capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] },
      ...[
        ['ui-usage-observed', 'dimensions.observed'],
        ['ui-usage-entitled', 'dimensions.entitled'],
        ['ui-usage-policy', 'dimensions.policyAllowed'],
        ['ui-usage-routable', 'dimensions.routable'],
      ].map(([id, field]) => ({ id, field, source: 'usage-index', class: 'observed',
        capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] }))],
    }, {
      key: { host: 'claude', provider: null, modelId: 'claude-fable-5',
        scopeId: 'scope:ui-private', digest: null },
      displayName: 'Claude Fable 5', aliases: [], visibility: 'visible',
      variant: { lifecycleScope: 'Anthropic-operated platforms', availability: 'general',
        contextWindow: 1_000_000, retirementNotBefore: '2027-06-09' },
      capabilities: { tools: true, reasoning: true, contextLimit: 1_000_000, outputLimit: 128_000,
        input: { text: true, image: true }, output: { text: true } },
      pricing: { basis: 'per-million-tokens', input: 10, output: 50, currency: 'USD',
        evidenceRefs: ['ui-anthropic-evidence'] },
      lifecycle: { state: 'active', replacement: null,
        notice: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
        evidenceRefs: ['ui-anthropic-evidence'] }, edges: [],
      dimensions: { configured: { value: true, evidenceRefs: ['ui-private-evidence'] },
        effective: { value: true, evidenceRefs: ['ui-private-evidence'] },
        observed: { value: null, evidenceRefs: [] },
        discoverable: { value: true, evidenceRefs: ['ui-anthropic-evidence'] },
        entitled: { value: null, evidenceRefs: [] }, policyAllowed: { value: null, evidenceRefs: [] },
        routable: { value: null, evidenceRefs: [] }, recommended: { value: true, evidenceRefs: ['ui-anthropic-evidence'] } },
      evidence: [{ id: 'ui-anthropic-evidence', field: 'dimensions.discoverable',
        source: 'anthropic-docs', class: 'first-party', capturedAt: MODEL_AT,
        freshness: 'fresh', completeness: 'complete', scopeFingerprint: 'scope:ui-private', refs: [] },
      { id: 'ui-private-evidence', field: 'dimensions.configured', source: 'claude-config',
        class: 'configured', capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] }],
    }, ...Array.from({ length: 59 }, (_, i) => ({
      key: { host: i % 3 === 0 ? 'claude' : i % 3 === 1 ? 'codex' : 'opencode',
        provider: i % 2 === 0 ? 'ui-private-provider-a' : 'ui-private-provider-b',
        modelId: `catalog-model-${String(i + 2).padStart(2, '0')}`,
        scopeId: 'scope:ui-private', digest: `catalog-digest-${i + 2}` },
      displayName: `Catalog Model ${i + 2}`,
      publisher: i % 2 === 0 ? 'Catalog Lab A' : 'Catalog Lab B',
      selector: `catalog-provider/catalog-model-${i + 2}`,
      visibility: 'visible', capabilities: { tools: i % 2 === 0 }, pricing: i === 0
        ? { basis: 'per-million-tokens', input: 5, output: 15, currency: 'USD', evidenceRefs: [] }
        : i === 1 ? { basis: 'per-million-tokens', input: 1, output: 3, currency: 'USD', evidenceRefs: [] }
          : i === 2 ? { basis: 'per-million-tokens', input: 3, output: 9, currency: 'USD', evidenceRefs: [] }
            : null,
      lifecycle: { state: i % 11 === 0 ? 'retiring' : 'active', replacement: null,
        evidenceRefs: ['ui-private-evidence'] },
      dimensions: {
        configured: { value: true, evidenceRefs: ['ui-private-evidence'] },
        effective: { value: i % 4 === 0 ? null : true, evidenceRefs: ['ui-private-evidence'] },
        observed: { value: i % 5 === 0 ? true : null, evidenceRefs: ['ui-private-evidence'] },
        discoverable: { value: true, evidenceRefs: ['ui-private-evidence'] },
        entitled: { value: i % 7 === 0 ? false : null, evidenceRefs: ['ui-private-evidence'] },
        policyAllowed: { value: null, evidenceRefs: ['ui-private-evidence'] },
        routable: { value: null, evidenceRefs: ['ui-private-evidence'] },
      },
      evidence: [{ id: 'ui-private-evidence', field: 'catalog', source: 'codex-cache', class: 'catalog',
        capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] }],
    })), {
      key: { host: 'ollama', provider: 'ollama', modelId: 'qwen3-coder:30b',
        scopeId: 'scope:ui-private', digest: 'sha256:9e3f6a12abcd' },
      displayName: 'qwen3-coder:30b', aliases: [], visibility: 'visible',
      variant: { modifiedAt: '2026-08-24T10:00:00.000Z', parameterSize: '30.5B',
        quantizationLevel: 'Q4_K_M', format: 'gguf', family: 'qwen3', families: ['qwen3'],
        loaded: true, memoryBytes: 18_000_000_000, vramBytes: 12_000_000_000,
        expiresAt: '2026-08-25T14:00:00.000Z', contextWindow: 32_768,
        licenseSummary: 'Apache-2.0', advertisedCapabilities: ['completion', 'tools'] },
      capabilities: { toolcall: true, contextLimit: 32_768 },
      pricing: { basis: 'local-compute', input: 0, output: 0, currency: 'USD', evidenceRefs: [] },
      lifecycle: { state: 'unknown', replacement: null, evidenceRefs: [] }, edges: [],
      dimensions: { configured: { value: null, evidenceRefs: [] },
        effective: { value: null, evidenceRefs: [] }, observed: { value: null, evidenceRefs: [] },
        discoverable: { value: true, evidenceRefs: ['ui-ollama-evidence'] },
        entitled: { value: null, evidenceRefs: [] }, policyAllowed: { value: null, evidenceRefs: [] },
        routable: { value: null, evidenceRefs: [] } },
      evidence: [{ id: 'ui-ollama-evidence', field: 'variant.loaded', source: 'ollama-catalog', class: 'runtime',
        capturedAt: MODEL_AT, freshness: 'fresh', completeness: 'complete',
        scopeFingerprint: 'scope:ui-private', refs: [] }],
    }],
    bindings: [{ id: 'ui-private-binding', consumer: 'route:implementation', activity: 'implementation',
      host: 'opencode', provider: 'ui-private-provider', configured: 'ui-private-deployment',
      effective: 'ui-private-deployment', provenance: 'configured', consumerState: 'configured',
      evidenceRefs: ['ui-private-evidence'] },
    { id: 'ui-route-architecture', consumer: 'route:architecture', activity: 'architecture',
      host: 'claude', provider: 'ui-private-provider-a', configured: 'catalog-model-02',
      effective: 'catalog-model-02', provenance: 'configured', consumerState: 'configured',
      evidenceRefs: ['ui-private-evidence'] },
    { id: 'ui-route-design', consumer: 'route:design', activity: 'design',
      host: 'codex', provider: 'ui-private-provider-b', configured: 'catalog-model-03',
      effective: 'catalog-model-03', provenance: 'configured', consumerState: 'configured',
      evidenceRefs: ['ui-private-evidence'] },
    { id: 'ui-route-testing', consumer: 'route:testing', activity: 'testing',
      host: 'opencode', provider: 'ui-private-provider-a', configured: 'catalog-model-04',
      effective: 'catalog-model-04', provenance: 'configured', consumerState: 'configured',
      evidenceRefs: ['ui-private-evidence'] }],
    changes: Array.from({ length: 12 }, (_, i) => {
      const offset = i + 2;
      const key = {
        host: i % 3 === 0 ? 'claude' : i % 3 === 1 ? 'codex' : 'opencode',
        provider: i % 2 === 0 ? 'ui-private-provider-a' : 'ui-private-provider-b',
        modelId: `catalog-model-${String(offset).padStart(2, '0')}`,
        scopeId: 'scope:ui-private', digest: `catalog-digest-${offset}`,
      };
      return {
        kind: 'model-added', subject: modelIdentityKey(key), before: null, after: key,
        severity: 'info', provisional: false, evidenceRefs: ['ui-private-evidence'],
      };
    }), opportunities: [], diagnostics: [],
  },
  history: [{ snapshotId: 'models:ui-private', capturedAt: MODEL_AT }],
  comparison: { baseline: null, latest: 'models:ui-private', comparable: false, diagnostics: [] },
};

async function main() {
  // The usage API is injected rather than reaching for the real stores, so the
  // default run is deterministic AND cannot touch the user's live index cache.
  const roots = REAL ? undefined : extendedCorpus();
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-')), 'usage-index.json');
  const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-hooks-'));
  const hookSourceFile = path.join(hookRoot, 'settings.json');
  fs.writeFileSync(hookSourceFile, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `${HOOKS_SECRET} node stop.cjs`, timeout: 5 }] }] },
  }));
  const hookSourceDigest = createHash('sha256').update(fs.readFileSync(hookSourceFile)).digest('hex');
  const usage = {
    readIndex: async (o = {}) => {
      const value = await readIndex({ ...o, ...(roots ? { roots } : {}), cachePath });
      if (!REAL && value.context) value.context.attention = [{
        id: 'aaaa1111', sessionRef: 'claude-111111111111', host: 'claude', project: ' proj ',
        projectKey: 'project:1111111111111111',
        title: 'Context audit', start: '2026-07-24T10:00:00.000Z', state: 'handoff',
        peakBps: 9860, peakInputTokens: 255000, windowTokens: 258000,
      }, {
        id: 'bbbb2222', sessionRef: 'claude-222222222222', host: 'claude', project: 'PROJ',
        projectKey: 'project:1111111111111111',
        title: 'Performance review', start: '2026-07-24T11:00:00.000Z', state: 'compact',
        peakBps: 7200, peakInputTokens: 180000, windowTokens: 250000,
      }, {
        id: 'dddd4444', sessionRef: 'codex-444444444444', host: 'codex', project: 'other',
        projectKey: 'project:2222222222222222',
        title: 'Release review', start: '2026-07-24T09:00:00.000Z', state: 'warn',
        peakBps: 6400, peakInputTokens: 160000, windowTokens: 250000,
      }];
      return value;
    },
    readSession: (id, o = {}) => readSession(id, { ...o, ...(roots ? { roots } : {}), cachePath }),
    maskSecrets,
  };
  console.log(`\ncorpus: ${REAL ? 'REAL (~/.claude, ~/.codex)' : 'fixtures (deterministic)'}`);
  console.log(`cache : ${cachePath} (temp — your real index is untouched)\n`);

  const srv = await startDashboard({
    port: 0,
    fetchStatus: STATUS_STUB,
    usage,
    hooks: hooksStub({ file: hookSourceFile, digest: hookSourceDigest }),
    limits: LIMITS_STUB,
    live: LIVE_STUB,
    transcripts: TRANSCRIPT_STUB,
    models: MODELS_STUB,
    modelScopeKey: 'ab'.repeat(32),
    system: SYSTEM_STUB,
    maintenance: MAINTENANCE_STUB,
  });
  const ORIGIN = new URL(srv.url).origin;
  const modelHeaders = { 'x-dash-token': srv.token };
  const modelSummaryFixture = await fetch(`${ORIGIN}/api/models?view=summary`, { headers: modelHeaders })
    .then((response) => response.json());
  const modelSnapshotId = modelSummaryFixture.snapshot.snapshotId;
  const modelInventoryFixture = await fetch(`${ORIGIN}/api/models?view=inventory&offset=0&limit=50`
    + `&sort=lifecycle&direction=asc&relevance=relevant&snapshotId=${encodeURIComponent(modelSnapshotId)}`,
  { headers: modelHeaders }).then((response) => response.json());

  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });

  // A running full scan carries a long phase/count/elapsed sentence. It belongs
  // on its own status row; squeezing it between eight System tabs and a second,
  // redundant disabled label pushed both controls beyond the viewport.
  const runningScanPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await runningScanPage.route(/\/api\/system(\?|$)/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...SYSTEM_PAYLOAD,
      scan: {
        ...SYSTEM_PAYLOAD.scan,
        running: true,
        phase: 'consumers',
        scanned: 15,
        total: 15,
        startedAt: Date.now() - 103_000,
      },
    }),
  }));
  await runningScanPage.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
  await runningScanPage.click('#tab-system');
  await runningScanPage.waitForFunction(() => document.getElementById('system-freshness')
    ?.getAttribute('data-running') === '1');
  const runningScanLayout = await runningScanPage.evaluate(() => {
    const group = document.getElementById('secondary-system')?.getBoundingClientRect();
    const tabs = document.getElementById('system-seg')?.getBoundingClientRect();
    const status = document.getElementById('system-freshness')?.getBoundingClientRect();
    const button = document.getElementById('sys-rescan');
    return {
      statusText: document.getElementById('sys-asof')?.innerText,
      running: document.getElementById('system-freshness')?.getAttribute('data-running'),
      buttonHidden: button?.hidden,
      statusBelowTabs: !!status && !!tabs && status.top >= tabs.bottom - 1,
      statusInsideGroup: !!status && !!group
        && status.left >= group.left - 1 && status.right <= group.right + 1,
      documentFits: document.documentElement.scrollWidth <= globalThis.innerWidth,
    };
  });
  check('running full-scan progress gets a readable row without a duplicate action',
    runningScanLayout.running === '1'
      && /Full scan running.*Ranking disk use.*15 of 15/.test(runningScanLayout.statusText ?? '')
      && runningScanLayout.buttonHidden === true
      && runningScanLayout.statusBelowTabs
      && runningScanLayout.statusInsideGroup
      && runningScanLayout.documentFits,
    `running scan layout was ${JSON.stringify(runningScanLayout)}`);
  await runningScanPage.close();

  // A loopback dashboard token must survive in page memory even when browser
  // storage is disabled. Otherwise the Live bootstrap strips the fragment and
  // the main bootstrap silently sends 401s, leaving every real panel hidden
  // behind the gate.
  const storageBlockedPage = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await storageBlockedPage.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
    Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
    Storage.prototype.removeItem = () => { throw new Error('storage blocked'); };
  });
  const blockedStatus = [];
  storageBlockedPage.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/status') blockedStatus.push(response.status());
  });
  await storageBlockedPage.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
  await storageBlockedPage.waitForSelector('#area-overview:not([hidden])');
  await storageBlockedPage.waitForFunction(() => document.querySelectorAll('#area-overview .card').length > 0);
  const blockedStorageStartup = await storageBlockedPage.evaluate(() => ({
    gated: document.body.classList.contains('gated'),
    cards: document.querySelectorAll('#area-overview .card').length,
    visible: document.getElementById('area-overview')?.getBoundingClientRect().height > 0,
  }));
  check('a valid fragment token keeps the dashboard runnable when localStorage is blocked',
    blockedStorageStartup.gated === false && blockedStorageStartup.visible
      && blockedStorageStartup.cards > 0 && blockedStatus.includes(200),
    `blocked-storage startup was ${JSON.stringify(blockedStorageStartup)} with status ${blockedStatus.join(',')}`);
  await storageBlockedPage.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Anything the page logs as an error, or any request it fails, is a defect —
  // collected globally so a failure in one view is not silently swallowed.
  const consoleErrors = [];
  const failedRequests = [];
  const modelRequests = [];
  const hookRequests = [];
  // Every /api/limits call, with its window. Leaving Prompts resets a 365-day
  // selection, and the Limits loader must not have already fetched at the old
  // window — two in-flight requests for different spans would let a late
  // response paint year-wide figures under a chip row reading 30d.
  const limitsRequests = [];
  const maintenancePlanRequests = [];
  const maintenanceApplyRequests = [];
  const maintenanceUndoRequests = [];
  let maintenanceReportReads = 0;
  let maintenanceScanRequests = 0;
  const expectedHttpConsoleErrors = new Set();
  // Capture the LOCATION too. A bare "Failed to load resource" is
  // undiagnosable, and a console listener that records only the message makes
  // the harness's own failures impossible to act on.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    if (/status of 409 \(Conflict\)/.test(m.text()) && loc?.url && expectedHttpConsoleErrors.delete(loc.url)) return;
    const where = loc?.url ? ` @ ${loc.url}` : '';
    consoleErrors.push(`${m.text()}${where}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
  // The dashboard is a self-contained local page: every byte it loads comes
  // from the loopback server it was served by. A CDN font, a remote logo, or an
  // analytics beacon would be an egress the whole design forbids — and unlike a
  // DOM scan, this catches one added at RUNTIME by a script.
  const offOriginRequests = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\/models(?:\?|$)/.test(u)) modelRequests.push(u);
    if (/\/api\/hooks(?:\?|$)/.test(u)) hookRequests.push(u);
    if (/\/api\/limits(?:\?|$)/.test(u)) limitsRequests.push(u);
    if (u.startsWith(ORIGIN) || /^(data|blob|about|chrome-extension):/.test(u)) return;
    offOriginRequests.push(`${r.resourceType()} ${u}`);
  });
  page.on('requestfailed', (r) => {
    // Leaving Live (or the Intelligence view) deliberately closes its
    // EventSource. Chromium reports that client-side teardown as ERR_ABORTED
    // even though it is the expected, leak-preventing lifecycle behavior.
    if (/\/api\/live\/(?:events|intelligence|transcripts\/[^/]+\/[^/]+\/events)(?:\?.*)?$/.test(r.url())
      && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
  });
  await page.route(/\/api\/maintenance(?:\/(?:plans|apply|undo))?(?:\?|$)/, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (status, body) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (request.method() === 'GET' && pathname === '/api/maintenance') {
      if (new URL(request.url()).searchParams.get('refresh') === 'scan') {
        maintenanceScanRequests++;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      else maintenanceReportReads++;
      return reply(200, MAINTENANCE_PAYLOAD);
    }
    const body = request.postDataJSON();
    if (pathname === '/api/maintenance/plans') {
      maintenancePlanRequests.push(body);
      if (maintenancePlanRequests.length === 3) {
        return reply(200, { ok: false, code: 'PLAN_DRIFT', error: '<b>cap-ui-plan-secret</b>' });
      }
      return reply(200, {
        plan: {
          planId: `ui-plan-${maintenancePlanRequests.length}`, planDigest: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          actions: [{ id: 'provider-update', label: 'Update rust-optimizer' }],
        },
        capability: 'cap-ui-plan-secret',
        confirmation: {
          title: '<img src=x onerror="globalThis.__maintConfirmXss=1"> Update rust-optimizer?',
          summary: 'Install the compatible provider release and refresh its projected capabilities.',
          willChange: ['rust-optimizer 0.2.0 to 0.3.1', '<svg onload="globalThis.__maintConfirmXss=2">'],
          preserved: ['Standalone skill-creator', 'Project configuration'],
          restart: 'Restart Codex after the provider update.',
          rollback: 'Reinstall rust-optimizer 0.2.0 from the same provider.',
          actionLabel: 'Apply update', typedPhrase: 'APPLY rust-optimizer',
        },
      });
    }
    if (pathname === '/api/maintenance/apply') {
      maintenanceApplyRequests.push(body);
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (maintenanceApplyRequests.length === 2) {
        expectedHttpConsoleErrors.add(request.url());
        return reply(409, {
          ok: false, status: 'partial-recovery-required', effect: 'recovery-required',
          error: '<img src=x onerror="globalThis.__maintRecoveryXss=1"> cap-ui-plan-secret',
          receipt: {
            id: 'receipt-recovery-ui', status: 'partial-recovery-required',
            headline: 'rust-optimizer outcome needs recovery',
            summary: 'Provider dispatch could not be verified; inspect the native resource.',
            completedAt: new Date().toISOString(), undoEligible: false,
          },
        });
      }
      return reply(200, {
        ok: true, status: 'applied', receipt: {
          id: 'receipt-update-ui', status: 'applied', statusLabel: 'Applied',
          headline: 'rust-optimizer updated', summary: 'rust-optimizer was updated to 0.3.1.',
          completedAt: new Date().toISOString(), verification: 'Provider reports 0.3.1 active.',
          undoEligible: true, undo: { eligible: true, status: 'Eligible' },
        },
      });
    }
    if (pathname === '/api/maintenance/undo') {
      maintenanceUndoRequests.push(body);
      if (body.preview === true) {
        return reply(200, {
          capability: 'cap-ui-undo-secret', confirmation: {
            title: 'Undo rust-optimizer update?', summary: 'Restore the provider release recorded before this change.',
            willChange: ['rust-optimizer 0.3.1 to 0.2.0'], preserved: ['Standalone skill-creator'],
            restart: true, rollback: 'Reapply 0.3.1 with a new maintenance plan.', actionLabel: 'Undo change',
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      return reply(200, {
        ok: true, status: 'undone', receipt: {
          id: 'receipt-undo-ui', status: 'undone', statusLabel: 'Undone',
          headline: 'rust-optimizer update undone', summary: 'rust-optimizer was restored to 0.2.0.',
          completedAt: new Date().toISOString(), verification: 'Provider reports 0.2.0 active.', undoEligible: false,
        },
      });
    }
    return reply(404, { code: 'NOT_FOUND' });
  });
  await page.route(/\/api\/live\/playback\/(?:claude\/ui-review-session|codex\/ui-live-session)/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1, sessionKey: 'claude:ui-review-session',
      startAt: new Date(Date.now() - 180_000).toISOString(),
      endAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 120_000,
      events: [
        { eventId: 'review:1', at: new Date(Date.now() - 170_000).toISOString(),
          kind: 'message', actor: { id: 'ui-review-session', role: 'assistant' } },
        { eventId: 'review:2', at: new Date(Date.now() - 90_000).toISOString(),
          kind: 'tool', actor: { id: 'ui-review-session', role: 'assistant' },
          target: { id: 'review-tool', role: 'tool', label: 'Read' },
          relation: 'tool.started', tool: { callId: 'review-tool', name: 'Read', status: 'completed' } },
      ],
      transcript: { items: [
        { id: 'review-turn-1', role: 'user', text: 'Review this implementation' },
        { id: 'review-turn-2', role: 'assistant', text: 'Playback evidence loaded' },
      ] },
      seek: { requestedMs: null, atMs: 120_000, eventIndex: 0 },
      live: { cursor: 'review:1', eventsEndpoint: '/api/live/transcripts/claude/ui-review-session/events' },
    }),
  }));

  try {
    // The dashboard intentionally owns long-lived polling and EventSource
    // connections. DOM readiness plus the application shell is the stable
    // navigation contract; network-idle can never be guaranteed by a Live UI.
    await page.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-overview', { state: 'attached' });

    // ── ADR-0026 · About leads the bar but must NOT hijack the landing view ──
    // This runs FIRST, on a browser context that has never seen the dashboard,
    // because both facts under test are first-run facts: which panel a new user
    // lands on, and whether the one-shot nudge is showing. Any later assertion
    // would be reading a localStorage-remembered state instead.
    await page.waitForTimeout(400);
    const firstRun = await page.evaluate(() => ({
      selected: document.querySelector('#seg [aria-selected="true"]')?.dataset.tab,
      overviewVisible: !document.getElementById('area-overview')?.hidden
        && !document.getElementById('panel-overview')?.hidden,
      aboutVisible: !document.getElementById('panel-about')?.hidden,
      nudgeVisible: !document.getElementById('about-nudge')?.hidden,
      stored: localStorage.getItem('ak-dash-about-nudge'),
      // The nudge sits BELOW the triage summary by design: an introduction must
      // never displace a failing subsystem.
      belowSummary: (() => {
        const summary = document.getElementById('summary');
        const nudge = document.getElementById('about-nudge');
        if (!summary || !nudge || summary.hidden || nudge.hidden) return null;
        return nudge.getBoundingClientRect().top >= summary.getBoundingClientRect().bottom - 1;
      })(),
    }));
    check('Overview is still the default landing view, not About',
      firstRun.selected === 'overview' && firstRun.overviewVisible && !firstRun.aboutVisible,
      `first paint selected "${firstRun.selected}" with ${JSON.stringify(firstRun)}`);
    check('a first-run reader is pointed at About by a nudge, not by a hijacked default',
      firstRun.nudgeVisible && firstRun.stored === null,
      `nudge state was ${JSON.stringify(firstRun)}`);
    check('the nudge renders below the triage summary, never displacing it',
      firstRun.belowSummary !== false,
      'the About nudge was laid out above #summary — a failing subsystem must lead');

    await page.click('#about-nudge-x');
    const nudgeDismissed = await page.evaluate(() => ({
      hidden: document.getElementById('about-nudge')?.hidden,
      stored: localStorage.getItem('ak-dash-about-nudge'),
      tab: document.querySelector('#seg [aria-selected="true"]')?.dataset.tab,
    }));
    check('dismissing the nudge hides it without navigating anywhere',
      nudgeDismissed.hidden === true && nudgeDismissed.stored === '1'
        && nudgeDismissed.tab === 'overview',
      `after dismissal: ${JSON.stringify(nudgeDismissed)}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-overview', { state: 'attached' });
    await page.waitForTimeout(400);
    check('a dismissed nudge stays dismissed across a reload',
      await page.evaluate(() => document.getElementById('about-nudge')?.hidden) === true,
      'the nudge greeted a returning reader again — dismissal must persist like the poll and theme preferences');

    // Clearing the key and reloading proves the persistence is CAUSAL: without
    // it, a nudge that never rendered at all would pass the check above.
    await page.evaluate(() => localStorage.removeItem('ak-dash-about-nudge'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#about-nudge', { state: 'attached' });
    await page.waitForTimeout(400);
    check('the nudge returns once the remembered dismissal is cleared',
      await page.evaluate(() => document.getElementById('about-nudge')?.hidden) === false,
      'the nudge never came back — the reload check above would have been vacuous');
    await page.click('#about-nudge-go');
    await page.waitForSelector('#panel-about:not([hidden])');
    check('"Open About" opens the About area and counts as dismissing the tip',
      await page.evaluate(() => document.getElementById('about-nudge')?.hidden) === true
        && await page.evaluate(() => localStorage.getItem('ak-dash-about-nudge')) === '1',
      'Open About did not both navigate and retire the first-run tip');

    // ── every primary area renders, is non-empty, and is artifact-free ──
    for (const [tab, sel] of TABS) {
      await page.click(`[data-tab="${tab}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      if (tab === 'usage') await page.waitForTimeout(1200); // lazy fetch
      if (tab === 'live') await page.waitForTimeout(350); // segmented-thumb transition
      // System fetches /api/system on first open. Waiting on a rendered KPI (not
      // a timeout) means this cannot pass by screenshotting an empty grid.
      if (tab === 'system') await page.waitForSelector('#sys-kpis .sy-kpi', { timeout: 8000 }).catch(() => {});
      const text = await visibleText(page, sel);
      await shoot(page, `tab-${tab}`);

      check(`tab "${tab}" renders non-empty`, text.trim().length > 20,
        `panel had ${text.trim().length} chars of visible text`);
      const arts = artifactsIn(text);
      check(`tab "${tab}" is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} in visible text`);
    }
    // AMENDS ADR-0005's three-area contract. The stable primary areas are now
    // FIVE, in this exact order: About · Overview · Usage · Observability ·
    // System. Order is asserted, not just membership — About leads because it
    // is the orientation surface and System trails because it is the
    // machine-resource family; a bar that carried the same five in a different
    // order would be a different information architecture.
    const primaryNavigation = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('#seg > [data-tab]')].map((item) => item.childNodes[0]?.textContent.trim()),
      tabs: [...document.querySelectorAll('#seg > [data-tab]')].map((item) => item.dataset.tab),
      count: document.querySelectorAll('#seg > [data-tab]').length,
    }));
    check('dashboard exposes exactly five stable primary areas, in order',
      primaryNavigation.count === PRIMARY_LABELS.length
        && JSON.stringify(primaryNavigation.labels) === JSON.stringify(PRIMARY_LABELS)
        && JSON.stringify(primaryNavigation.tabs) === JSON.stringify(TABS.map(([tab]) => tab)),
      `primary navigation was ${JSON.stringify(primaryNavigation)}; the contract is `
      + `${JSON.stringify(PRIMARY_LABELS)}`);

    await page.click('[data-tab="overview"]');
    for (const [view, sel] of OVERVIEW_VIEWS) {
      await page.click(`[data-overview-view="${view}"]`);
      await page.waitForSelector(`${sel}:not([hidden])`);
      const presentation = await page.evaluate((selector) => {
        const panel = document.querySelector(selector);
        return {
          text: panel?.textContent,
          heading: panel?.querySelector('.view-heading h2')?.textContent,
          description: panel?.querySelector('.view-heading p')?.textContent,
        };
      }, sel);
      check(`Overview view "${view}" has a heading, description, and content`,
        presentation.heading?.trim().length > 3
          && presentation.description?.trim().length > 12
          && presentation.text?.trim().length > 20,
        `Overview presentation was ${JSON.stringify(presentation)}`);
    }

    // ── Intelligence: the project picker is a CONTROL, not a panel (ADR-0027) ──
    // Structural assertions only, so they hold on any machine: the panel's data
    // comes from a real census walk and its counts are whatever this machine
    // has. What must not vary is the shape.
    await page.click('[data-overview-view="intel"]');
    await page.waitForSelector('#panel-intel:not([hidden])');
    const intelShape = await page.evaluate(() => {
      const select = document.getElementById('intel-project-select');
      return {
        pickerStripGone: !document.getElementById('intel-picker'),
        redundantCaptionsGone: !document.getElementById('mw-note') && !document.getElementById('intel-picker-note'),
        pickerInHistoryHead: !!select?.closest('#history .strip-head'),
        labelled: !!document.querySelector('label[for="intel-project-select"]'),
        censusIsDisclosure: document.getElementById('mw-census')?.tagName === 'DETAILS',
      };
    });
    check('the standalone "project detail" strip is gone — the picker moved into learning over time',
      intelShape.pickerStripGone && intelShape.pickerInHistoryHead, JSON.stringify(intelShape));
    check('the captions that restated a count without explaining it are gone',
      intelShape.redundantCaptionsGone, JSON.stringify(intelShape));
    check('the picker keeps its label after moving',
      intelShape.labelled, 'a bare select in a heading row is unlabelled for a screen reader');
    check('the census explainer costs no vertical space until asked for',
      intelShape.censusIsDisclosure, JSON.stringify(intelShape));

    // The strip owning the picker must never hide itself: a project with no
    // history would otherwise take the only control for choosing another one
    // away with it.
    const historyVisible = await page.$eval('#history', (el) => !el.hidden);
    check('the strip that owns the picker stays visible even with nothing to chart',
      historyVisible, '#history was hidden, stranding the picker');

    const secondaryPositions = [];
    for (const [tab] of TABS) {
      await page.click(`[data-tab="${tab}"]`);
      secondaryPositions.push(await page.evaluate(() => {
        const group = document.querySelector('.secondary-group:not([hidden])');
        const rect = group?.getBoundingClientRect();
        return { tab: document.querySelector('#seg [aria-selected="true"]')?.dataset.tab, left: rect?.left, top: rect?.top };
      }));
    }
    check('secondary tabs stay left-aligned at one fixed location across primary areas',
      secondaryPositions.every((position) => Math.abs(position.left - secondaryPositions[0].left) <= 1
        && Math.abs(position.top - secondaryPositions[0].top) <= 1),
      `secondary positions were ${JSON.stringify(secondaryPositions)}`);

    // ═════════════════════════════════════════════════════════════════════════
    // ABOUT (ADR-0026 / docs/ddd/component-directory.md)
    //
    // The area is an authored directory joined with measured detection. Both
    // halves are load-bearing and fail differently: the editorial half must
    // render on any machine, and the detection half must never let an absent
    // component read as a present one. The assertions below pin that seam.
    // ═════════════════════════════════════════════════════════════════════════
    await page.click('[data-tab="about"]');
    await page.waitForSelector('#panel-about:not([hidden])');
    await page.waitForTimeout(200);
    await shoot(page, 'about');

    const DIRECTORY = directoryEntries();
    const readAbout = () => page.evaluate(() => {
      const cards = [...document.querySelectorAll('#panel-about .ab-card')];
      return {
        count: cards.length,
        sections: [...document.querySelectorAll('#panel-about .ab-cards')]
          .map((el) => ({ id: el.id, cards: el.children.length })),
        lede: document.getElementById('ab-hero-lede')?.textContent.trim() || '',
        entries: cards.map((card) => {
          const chip = card.querySelector('.ab-state');
          return {
            name: card.querySelector('.ab-name b')?.textContent.trim() || '',
            chip: chip?.textContent.trim() || '',
            state: chip?.dataset.state || '',
            reason: chip?.getAttribute('title') || '',
            tile: !!card.querySelector('.ab-tile'),
            tagline: card.querySelector('.ab-tagline')?.textContent.trim() || '',
            body: card.querySelector('.ab-body')?.textContent.trim() || '',
            detail: card.querySelector('.ab-detail')?.textContent.trim() || null,
            tail: card.querySelector('.ab-links, .ab-manage')?.textContent.trim() || null,
          };
        }),
      };
    });
    const about = await readAbout();
    const aboutBy = (name) => about.entries.find((entry) => entry.name === name);

    check('About renders exactly one card per directory entry, none missing',
      about.count === DIRECTORY.length
        && DIRECTORY.every((entry) => about.entries.some((card) => card.name === entry.name)),
      `${about.count} cards for ${DIRECTORY.length} directory entries; missing `
      + JSON.stringify(DIRECTORY.filter((e) => !about.entries.some((c) => c.name === e.name)).map((e) => e.name)));
    check('every About section carries at least one card',
      about.sections.length === 5 && about.sections.every((section) => section.cards > 0),
      `section fill was ${JSON.stringify(about.sections)}`);
    // A card with prose but no chip is the failure this area exists to prevent:
    // authored copy that reads as a claim about the machine. Every card states
    // a state, and every state states WHY (the chip's title).
    const chipless = about.entries.filter((entry) => !entry.chip || !entry.state || !entry.reason);
    check('every About card carries a state chip with a stated reason',
      chipless.length === 0,
      `${chipless.length} card(s) rendered without a chip/state/reason: `
      + JSON.stringify(chipless.map((entry) => entry.name)));
    const thin = about.entries.filter((entry) => entry.tagline.length < 12
      || entry.body.length < 60 || !entry.tile);
    check('every About card carries its icon, tagline, and paragraph',
      thin.length === 0,
      `${thin.length} card(s) were editorially thin: ${JSON.stringify(thin.map((e) => e.name))}`);

    // The honest not-installed state. `codex` is enabled in the status stub and
    // ABSENT on the machine; the card must still be a whole card — icon,
    // tagline, paragraph — with a chip that says it is not working and a detail
    // line naming the fix. An empty slot, or a green chip, is the defect.
    const codexCard = aboutBy('Codex');
    check('an absent component renders the honest not-installed state, not an empty slot',
      !!codexCard && codexCard.state === 'fail' && /not working/i.test(codexCard.chip)
        && codexCard.body.length > 60 && codexCard.tagline.length > 12
        && /not installed/i.test(String(codexCard.detail))
        && /ak setup/.test(String(codexCard.detail)),
      `the Codex card read ${JSON.stringify(codexCard)}`);
    const claudeCard = aboutBy('Claude Code');
    check('a detected component reads installed rather than merely "known"',
      !!claudeCard && claudeCard.state === 'ok' && /installed/i.test(claudeCard.chip)
        && claudeCard.detail === null,
      `the Claude Code card read ${JSON.stringify(claudeCard)}`);
    check('a component whose version is known carries it on the chip',
      /v4\.0\.0/.test(String(aboutBy('ruflo')?.chip)),
      `the ruflo chip read ${JSON.stringify(aboutBy('ruflo')?.chip)}`);
    check('the managed agent-browser card carries its observed compatible version',
      /installed.*v0\.27\.3/i.test(String(aboutBy('agent-browser')?.chip)),
      `the agent-browser chip read ${JSON.stringify(aboutBy('agent-browser')?.chip)}`);
    // One card, two status rows: the worst of the pair drives the chip, or
    // Codex's broken statusline would sit behind a green card.
    check('a card joining two subsystems takes the worse of the two',
      aboutBy('Statuslines')?.state === 'warn'
        && /codex statusline missing/i.test(String(aboutBy('Statuslines')?.detail)),
      `the Statuslines card read ${JSON.stringify(aboutBy('Statuslines'))}`);
    // The standing example from the directory itself: `ak status` emits no
    // permissions row, so this chip must degrade rather than assume.
    check('an unjoined surface degrades to unknown instead of assuming configured',
      aboutBy('Permission allowlist')?.state === 'unknown'
        && /unknown/i.test(String(aboutBy('Permission allowlist')?.chip)),
      `the Permission allowlist card read ${JSON.stringify(aboutBy('Permission allowlist'))}`);
    check('configured surfaces name the command that manages them',
      DIRECTORY.filter((entry) => entry.category === 'configured')
        .every((entry) => /^manage:/.test(String(aboutBy(entry.name)?.tail))),
      `configured tails were ${JSON.stringify(DIRECTORY.filter((e) => e.category === 'configured')
        .map((e) => aboutBy(e.name)?.tail))}`);

    // ═════════════════════════════════════════════════════════════════════════
    // SYSTEM (ADR-0025 / docs/ddd/machine-footprint.md)
    // ═════════════════════════════════════════════════════════════════════════
    await page.click('[data-tab="system"]');
    await page.waitForSelector('#area-system:not([hidden])');
    await page.waitForSelector('#sys-kpis .sy-kpi', { timeout: 8000 });
    for (const [view, sel] of SYSTEM_VIEWS) {
      await page.click(`[data-system-view="${view}"]`);
      await page.waitForSelector(`${sel}:not([hidden])`);
      await page.waitForTimeout(120);
      const presentation = await page.evaluate((selector) => {
        const panel = document.querySelector(selector);
        return {
          heading: panel?.querySelector('.view-heading h2')?.textContent?.trim(),
          description: panel?.querySelector('.view-heading p')?.textContent?.trim(),
          // Body text EXCLUDING the heading: a view whose only content is its
          // own title would otherwise pass on the heading alone.
          body: [...(panel?.querySelectorAll('.sy-card') || [])]
            .map((card) => card.innerText.trim()).join('\n'),
          cards: panel?.querySelectorAll('.sy-card').length || 0,
        };
      }, sel);
      await shoot(page, `system-${view}`);
      check(`System view "${view}" has a heading, description, and rendered cards`,
        presentation.heading?.length > 3 && presentation.description?.length > 12
          && presentation.cards > 0 && presentation.body.length > 40,
        `System presentation was ${JSON.stringify({ ...presentation, body: presentation.body.slice(0, 160) })}`);
      const arts = artifactsIn(await visibleText(page, sel));
      check(`System view "${view}" is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} in visible text`);
    }

    // Maintenance remains a reporting workbench even when its separate action
    // contract is enabled. One provider-owned finding gets one Preview control;
    // there is no bulk selection or eager mutation affordance.
    await page.click('[data-system-view="maintenance"]');
    await page.waitForSelector('#sys-maint-list [data-maint-key]');
    const maintenanceNav = await page.$$eval('#system-seg [data-system-view]', (buttons) => ({
      ids: buttons.map((button) => button.dataset.systemView),
      selected: buttons.filter((button) => button.getAttribute('aria-selected') === 'true').map((button) => button.dataset.systemView),
      tabStops: buttons.filter((button) => button.tabIndex === 0).map((button) => button.dataset.systemView),
    }));
    check('Maintenance is the last System sub-menu and owns the one roving tab stop',
      maintenanceNav.ids.at(-1) === 'maintenance'
        && JSON.stringify(maintenanceNav.selected) === JSON.stringify(['maintenance'])
        && JSON.stringify(maintenanceNav.tabStops) === JSON.stringify(['maintenance']),
      `System navigation was ${JSON.stringify(maintenanceNav)}`);

    const maintenanceReady = await page.evaluate(() => ({
      banner: document.getElementById('sys-maint-banner')?.innerText,
      scanStatus: document.getElementById('sys-maint-scan-status')?.innerText,
      scanButton: document.getElementById('sys-maint-scan')?.innerText,
      scanLive: document.getElementById('sys-maint-scan-status')?.getAttribute('aria-live'),
      findings: document.querySelectorAll('#sys-maint-list [data-maint-key]').length,
      checkboxes: document.querySelectorAll('#sys-maintenance input[type="checkbox"]').length,
      actionControls: document.querySelectorAll('#sys-maintenance [data-maint-action]').length,
      cleanAll: document.getElementById('sys-maintenance')?.innerText.includes('Clean all'),
      summary: document.getElementById('sys-maint-summary')?.innerText,
    }));
    check('Maintenance exposes only a provider-gated single-finding preview control',
      /Preview before changing/.test(String(maintenanceReady.banner))
        && /Authorization expires/.test(String(maintenanceReady.banner))
        && maintenanceReady.findings === 4
        && maintenanceReady.checkboxes === 0
        && maintenanceReady.actionControls === 1
        && maintenanceReady.cleanAll === false,
      `Maintenance boundary was ${JSON.stringify(maintenanceReady)}`);
    check('Maintenance distinguishes a provider check from the full System scan',
      /Uses the saved System inventory/.test(String(maintenanceReady.scanStatus))
        && /does not walk projects/.test(String(maintenanceReady.scanStatus))
        && /Check providers/.test(String(maintenanceReady.scanButton))
        && maintenanceReady.scanLive === 'polite',
      `Maintenance scan presentation was ${JSON.stringify(maintenanceReady)}`);
    check('Maintenance summarizes findings, action eligibility, incomplete evidence, and age without a hygiene score',
      /4\s+findings/.test(String(maintenanceReady.summary))
        && /2\s+actions ready/.test(String(maintenanceReady.summary))
        && /2 of 3 providers\s+scan coverage/.test(String(maintenanceReady.summary))
        && /evidence measured/.test(String(maintenanceReady.summary))
        && !/score/i.test(String(maintenanceReady.summary)),
      `Maintenance summary was ${JSON.stringify(maintenanceReady.summary)}`);

    const firstMaintenance = await page.$eval('#sys-maint-list [data-maint-key]', (button) => ({
      expanded: button.getAttribute('aria-expanded'), current: button.getAttribute('aria-current'),
      controls: button.getAttribute('aria-controls'), text: button.innerText,
    }));
    const firstMaintenanceDetail = await visibleText(page, '#sys-maint-detail');
    check('the ledger selects one finding and explains ownership, versions, impact, preservation, and the preview boundary',
      firstMaintenance.expanded === 'true' && firstMaintenance.current === 'true'
        && firstMaintenance.controls === 'sys-maint-detail'
        && /rust-optimizer/.test(firstMaintenance.text)
        && /Carried by codex/.test(firstMaintenance.text)
        && /Owner: Codex plugin manager/.test(firstMaintenance.text)
        && /Codex plugin manager/.test(firstMaintenanceDetail)
        && /0\.2\.0/.test(firstMaintenanceDetail) && /0\.3\.1/.test(firstMaintenanceDetail)
        && /standalone skill-creator/.test(firstMaintenanceDetail)
        && /Action: Upgrade rust-optimizer to 0\.3\.1/.test(firstMaintenance.text)
        && /Recommended action/.test(firstMaintenanceDetail)
        && /Preview update/.test(firstMaintenanceDetail)
        && /Nothing changes until you review and confirm/.test(firstMaintenanceDetail),
      `first finding was ${JSON.stringify(firstMaintenance)}; detail read ${JSON.stringify(firstMaintenanceDetail)}`);
    const maintenanceRowSuggestions = await page.$$eval('#sys-maint-list [data-maint-key]',
      (rows) => rows.map((row) => row.innerText));
    check('every Maintenance finding exposes a distinct direct action in the ledger',
      maintenanceRowSuggestions.length === MAINTENANCE_PAYLOAD.findings.length
        && maintenanceRowSuggestions.every((text) => /Action:\s*(Upgrade|Clear|Choose|Remove)\b/.test(text))
        && new Set(maintenanceRowSuggestions.map((text) => text.match(/Action:\s*(.*)/)?.[1])).size === maintenanceRowSuggestions.length,
      `row suggestions were ${JSON.stringify(maintenanceRowSuggestions)}`);

    const reportsBeforeRefresh = maintenanceReportReads;
    await page.waitForTimeout(1100);
    await page.click('#poll-now');
    await page.waitForTimeout(100);
    check('browser refresh rereads the saved Maintenance report without scanning providers',
      maintenanceReportReads === reportsBeforeRefresh + 1 && maintenanceScanRequests === 0,
      `report reads=${maintenanceReportReads}; scans=${maintenanceScanRequests}`);
    const explicitScan = page.waitForResponse((response) => response.url().includes('/api/maintenance?refresh=scan'));
    await page.click('#sys-maint-scan');
    await page.waitForTimeout(30);
    const maintenanceScanning = await page.evaluate(() => ({
      banner: document.getElementById('sys-maint-banner')?.innerText,
      status: document.getElementById('sys-maint-scan-status')?.innerText,
      button: document.getElementById('sys-maint-scan')?.innerText,
      disabled: document.getElementById('sys-maint-scan')?.disabled,
      rows: document.querySelectorAll('#sys-maint-list [data-maint-key]').length,
      previewDisabled: document.querySelector('#sys-maint-detail .mt-action.primary')?.disabled,
      rootBusy: document.getElementById('sys-maintenance')?.getAttribute('aria-busy'),
    }));
    check('a provider check keeps the saved report readable while withholding stale actions',
      /Provider check running/.test(String(maintenanceScanning.banner))
        && /saved report remains available/.test(String(maintenanceScanning.status))
        && /Checking providers/.test(String(maintenanceScanning.button))
        && maintenanceScanning.disabled === true && maintenanceScanning.rows === 4
        && maintenanceScanning.previewDisabled === true && maintenanceScanning.rootBusy === 'false',
      `provider-check state was ${JSON.stringify(maintenanceScanning)}`);
    await explicitScan;
    check('Check providers is the explicit provider-version measurement control',
      maintenanceScanRequests === 1,
      `explicit Maintenance scans=${maintenanceScanRequests}`);

    await page.click('#sys-maint-buckets [data-maint-bucket="needs-review"]');
    const reviewMaintenance = await page.evaluate(() => ({
      count: document.querySelectorAll('#sys-maint-list [data-maint-key]').length,
      status: document.getElementById('sys-maint-results')?.textContent,
      detail: document.getElementById('sys-maint-detail')?.innerText,
      active: document.querySelector('[data-maint-bucket="needs-review"]')?.getAttribute('aria-pressed'),
      xss: globalThis.__maintXss,
    }));
    check('finding-state filters are pressed buttons and announce the narrowed result count',
      reviewMaintenance.count === 1 && reviewMaintenance.active === 'true'
        && /Showing 1 finding/.test(String(reviewMaintenance.status)),
      `filtered Maintenance was ${JSON.stringify(reviewMaintenance)}`);
    check('partial evidence gives visible reasons and hostile evidence remains text',
      /Evidence needs attention/.test(String(reviewMaintenance.detail))
        && /current digest does not match/.test(String(reviewMaintenance.detail))
        && /<img src=x onerror=/.test(String(reviewMaintenance.detail))
        && reviewMaintenance.xss === undefined,
      `partial finding rendered ${JSON.stringify(reviewMaintenance)}`);
    check('relationship findings show compared copies and a concrete human procedure',
      /Observed copies/.test(String(reviewMaintenance.detail))
        && /Observed project copy/.test(String(reviewMaintenance.detail))
        && /Observed shared copy/.test(String(reviewMaintenance.detail))
        && /Choose one definition, or rename the project copy/.test(String(reviewMaintenance.detail))
        && /Not available here/.test(String(reviewMaintenance.detail))
        && !/Reporting only|Resources outside this finding/.test(String(reviewMaintenance.detail)),
      `relationship guidance was ${JSON.stringify(reviewMaintenance.detail)}`);

    await page.fill('#sys-maint-search', 'legacy-tools');
    check('search composes with category filters instead of silently resetting them',
      await page.$$eval('#sys-maint-list [data-maint-key]', (rows) => rows.length) === 0
        && /No findings match these filters/.test(await visibleText(page, '#sys-maint-list')),
      'a blocked MCP incorrectly survived the active Needs review filter');
    await page.click('#sys-maint-buckets [data-maint-bucket="blocked"]');
    const blockedMaintenance = await visibleText(page, '#sys-maintenance');
    check('unsupported resources say why they cannot be automated and preserve current state',
      /Cannot safely automate/.test(blockedMaintenance)
        && /No host-native removal provider/.test(blockedMaintenance)
        && /Remove legacy-tools with OpenCode’s MCP workflow/.test(blockedMaintenance)
        && /Not available here/.test(blockedMaintenance)
        && /other MCP registrations/.test(blockedMaintenance),
      `blocked finding read ${JSON.stringify(blockedMaintenance)}`);

    await page.fill('#sys-maint-search', '');
    await page.click('#sys-maint-buckets [data-maint-bucket="recent-changes"]');
    check('empty receipt history is directional rather than a blank pane',
      /No maintenance changes have receipts yet/.test(await visibleText(page, '#sys-maint-list')),
      'empty Recent changes did not explain what was absent');
    await page.click('#sys-maint-buckets [data-maint-bucket="all"]');
    await page.focus('#sys-maint-list [data-maint-key]');
    check('Maintenance rows and the overflow ledger retain visible keyboard focus',
      await page.$eval('#sys-maint-list [data-maint-key]', (button) => {
        const style = getComputedStyle(button);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      }) && await page.getAttribute('#sys-maint-list', 'tabindex') === '0',
      'the Maintenance ledger accepted keyboard focus without a visible indicator');
    await shoot(page, 'system-maintenance-ready');
    await page.setViewportSize({ width: 560, height: 780 });
    const maintenanceMobile = await page.evaluate(() => {
      const ledger = document.getElementById('sys-maint-list')?.getBoundingClientRect();
      const detail = document.getElementById('sys-maint-detail')?.getBoundingClientRect();
      return {
        columns: getComputedStyle(document.querySelector('.mt-workbench')).gridTemplateColumns,
        detailBelow: !!ledger && !!detail && detail.top >= ledger.bottom - 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    check('Maintenance stacks ledger and detail without page overflow on a narrow screen',
      maintenanceMobile.columns.trim().split(/\s+/).length === 1
        && maintenanceMobile.detailBelow && maintenanceMobile.pageOverflow === false,
      `narrow Maintenance layout was ${JSON.stringify(maintenanceMobile)}`);
    await shoot(page, 'system-maintenance-mobile');
    await page.setViewportSize({ width: 1440, height: 900 });

    // Preview is a real server round trip, but it is still not an action. The
    // short-lived capability is intentionally asserted absent from every
    // browser-persistent or user-visible surface.
    await page.click('#sys-maint-detail [data-maint-action="preview"]');
    await page.waitForSelector('#sys-maint-confirm[open] #sys-maint-typed');
    const firstPreview = await page.evaluate(() => ({
      title: document.getElementById('sys-maint-confirm-title')?.textContent,
      body: document.getElementById('sys-maint-confirm-body')?.innerText,
      applyLabel: document.getElementById('sys-maint-confirm-apply')?.textContent,
      disabled: document.getElementById('sys-maint-confirm-apply')?.disabled,
      xss: globalThis.__maintConfirmXss,
      secretInDom: document.documentElement.innerHTML.includes('cap-ui-plan-secret'),
      secretInUrl: location.href.includes('cap-ui-plan-secret'),
      secretInStorage: Object.values(localStorage).some((value) => value.includes('cap-ui-plan-secret')),
    }));
    check('Preview posts exactly one finding and renders hostile confirmation copy as text',
      JSON.stringify(maintenancePlanRequests) === JSON.stringify([{ findingIds: ['plugin-update'] }])
        && /<img src=x onerror=/.test(String(firstPreview.title))
        && /<svg onload=/.test(String(firstPreview.body))
        && /Standalone skill-creator/.test(String(firstPreview.body))
        && firstPreview.applyLabel === 'Apply update'
        && firstPreview.disabled === true
        && firstPreview.xss === undefined,
      `first preview was ${JSON.stringify(firstPreview)}; requests ${JSON.stringify(maintenancePlanRequests)}`);
    check('the plan capability stays out of DOM, URL, and browser storage',
      !firstPreview.secretInDom && !firstPreview.secretInUrl && !firstPreview.secretInStorage,
      `capability exposure was ${JSON.stringify(firstPreview)}`);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('sys-maint-confirm')?.open);
    check('Escape closes the native confirmation sheet and returns focus to Preview change',
      await page.evaluate(() => document.activeElement?.getAttribute('data-maint-action') === 'preview'),
      'confirmation focus did not return to its invoking control');

    await page.click('#sys-maint-detail [data-maint-action="preview"]');
    await page.waitForSelector('#sys-maint-confirm[open] #sys-maint-typed');
    await page.fill('#sys-maint-typed', 'APPLY rust');
    check('typed confirmation is exact before the provider action is enabled',
      await page.$eval('#sys-maint-confirm-apply', (button) => button.disabled),
      'a partial typed phrase enabled Apply');
    await page.fill('#sys-maint-typed', 'APPLY rust-optimizer');
    check('the exact typed phrase enables the named provider action',
      !(await page.$eval('#sys-maint-confirm-apply', (button) => button.disabled)),
      'the exact phrase did not enable Apply');
    await shoot(page, 'system-maintenance-confirmation');

    await page.click('#sys-maint-confirm-apply');
    const applyingState = await page.evaluate(() => ({
      dialogBusy: document.getElementById('sys-maint-confirm')?.getAttribute('aria-busy'),
      rootBusy: document.getElementById('sys-maintenance')?.getAttribute('aria-busy'),
      disabled: document.getElementById('sys-maint-confirm-apply')?.disabled,
      status: document.getElementById('sys-maint-confirm-status')?.textContent,
    }));
    check('an in-flight apply is announced and cannot be submitted twice',
      applyingState.dialogBusy === 'true' && applyingState.rootBusy === 'true'
        && applyingState.disabled === true && /Applying change/.test(String(applyingState.status)),
      `in-flight state was ${JSON.stringify(applyingState)}`);
    await page.evaluate(() => {
      document.getElementById('sys-maint-confirm-apply')?.click();
      document.getElementById('sys-maint-confirm-apply')?.click();
    });
    await page.waitForFunction(() => document.getElementById('sys-maint-confirm-title')?.textContent === 'Change recorded');
    check('Apply sends only the ephemeral capability, explicit confirmation, and typed phrase once',
      maintenanceApplyRequests.length === 1
        && maintenanceApplyRequests[0].capability === 'cap-ui-plan-secret'
        && maintenanceApplyRequests[0].confirm === true
        && maintenanceApplyRequests[0].typedPhrase === 'APPLY rust-optimizer'
        && Object.keys(maintenanceApplyRequests[0]).length === 3,
      `Apply requests were ${JSON.stringify(maintenanceApplyRequests)}`);
    check('a successful action becomes a retained receipt instead of a transient toast',
      /receipt-update-ui/.test(await visibleText(page, '#sys-maint-confirm'))
        && /Recent changes/.test(await visibleText(page, '#sys-maintenance')),
      `receipt sheet read ${JSON.stringify(await visibleText(page, '#sys-maint-confirm'))}`);
    await shoot(page, 'system-maintenance-receipt');
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => !document.getElementById('sys-maint-confirm')?.open);
    const retainedReceipt = await page.evaluate(() => ({
      recentPressed: document.querySelector('[data-maint-bucket="recent-changes"]')?.getAttribute('aria-pressed'),
      rows: document.querySelectorAll('#sys-maint-list [data-maint-key]').length,
      detail: document.getElementById('sys-maint-detail')?.innerText,
      undoControls: document.querySelectorAll('#sys-maint-detail [data-maint-action="undo"]').length,
    }));
    check('closing the receipt leaves it selected under Recent changes with Undo only when eligible',
      retainedReceipt.recentPressed === 'true' && retainedReceipt.rows === 1
        && /receipt-update-ui/.test(String(retainedReceipt.detail))
        && retainedReceipt.undoControls === 1,
      `retained receipt was ${JSON.stringify(retainedReceipt)}`);

    await page.click('#sys-maint-detail [data-maint-action="undo"]');
    await page.waitForFunction(() => document.getElementById('sys-maint-confirm-title')?.textContent === 'Undo rust-optimizer update?');
    check('Undo first previews one explicitly eligible receipt',
      JSON.stringify(maintenanceUndoRequests) === JSON.stringify([{ receiptId: 'receipt-update-ui', preview: true }])
        && /Standalone skill-creator/.test(await visibleText(page, '#sys-maint-confirm')),
      `Undo preview requests were ${JSON.stringify(maintenanceUndoRequests)}`);
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => document.getElementById('sys-maint-confirm-title')?.textContent === 'Undo recorded');
    check('confirmed Undo uses only its ephemeral capability and retains a second receipt',
      maintenanceUndoRequests.length === 2
        && JSON.stringify(maintenanceUndoRequests[1]) === JSON.stringify({ capability: 'cap-ui-undo-secret', confirm: true })
        && /receipt-undo-ui/.test(await visibleText(page, '#sys-maint-confirm')),
      `Undo flow was ${JSON.stringify(maintenanceUndoRequests)}`);
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => !document.getElementById('sys-maint-confirm')?.open);
    check('a receipt not marked undo-eligible exposes no Undo control',
      await page.$$eval('#sys-maint-detail [data-maint-action="undo"]', (buttons) => buttons.length) === 0,
      'the non-eligible undo receipt exposed another Undo');

    // A third preview deliberately receives drift after the original change.
    // Its server error body contains the old capability as hostile text; the
    // UI must use fixed recovery copy and never echo that body.
    await page.click('#sys-maint-buckets [data-maint-bucket="all"]');
    await page.click('#sys-maint-detail [data-maint-action="preview"]');
    await page.waitForFunction(() => document.getElementById('sys-maint-confirm-title')?.textContent === 'Evidence changed');
    const driftCopy = await visibleText(page, '#sys-maint-confirm');
    check('drift fails closed with specific recovery copy and no capability echo',
      /changed while the preview was being prepared/i.test(driftCopy) && /No change was requested/.test(driftCopy)
        && /preview current evidence again/.test(driftCopy) && !/cap-ui-plan-secret/.test(driftCopy),
      `drift copy was ${JSON.stringify(driftCopy)}`);
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => !document.getElementById('sys-maint-confirm')?.open);

    // A post-dispatch 409 is not a safe refusal. Its receipt must survive the
    // dialog and the UI must never replace uncertainty with "Nothing changed."
    await page.click('#sys-maint-detail [data-maint-action="preview"]');
    await page.waitForSelector('#sys-maint-confirm[open] #sys-maint-typed');
    await page.fill('#sys-maint-typed', 'APPLY rust-optimizer');
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => document.getElementById('sys-maint-confirm-title')?.textContent === 'Recovery required');
    const recoveryCopy = await page.evaluate(() => ({
      text: document.getElementById('sys-maint-confirm')?.innerText,
      xss: globalThis.__maintRecoveryXss,
      recentPressed: document.querySelector('[data-maint-bucket="recent-changes"]')?.getAttribute('aria-pressed'),
      selectedDetail: document.getElementById('sys-maint-detail')?.innerText,
    }));
    check('a recovery-required 409 retains its receipt and never claims the resource is unchanged',
      /provider may have changed this resource/i.test(String(recoveryCopy.text))
        && /receipt-recovery-ui/.test(String(recoveryCopy.text))
        && /retained under Recent changes/i.test(String(recoveryCopy.text))
        && !/Nothing changed/.test(String(recoveryCopy.text))
        && !/cap-ui-plan-secret/.test(String(recoveryCopy.text))
        && recoveryCopy.xss === undefined
        && recoveryCopy.recentPressed === 'true'
        && /receipt-recovery-ui/.test(String(recoveryCopy.selectedDetail)),
      `recovery outcome was ${JSON.stringify(recoveryCopy)}`);
    await page.click('#sys-maint-confirm-apply');
    await page.waitForFunction(() => !document.getElementById('sys-maint-confirm')?.open);
    const retainedRecovery = await page.evaluate(() => ({
      selected: document.querySelector('#sys-maint-list [aria-current="true"]')?.innerText,
      detail: document.getElementById('sys-maint-detail')?.innerText,
      undoControls: document.querySelectorAll('#sys-maint-detail [data-maint-action="undo"]').length,
    }));
    check('closing a recovery outcome leaves its non-undoable receipt selected for follow-up',
      /Recovery required/.test(String(retainedRecovery.selected))
        && /Provider dispatch could not be verified/.test(String(retainedRecovery.detail))
        && retainedRecovery.undoControls === 0,
      `retained recovery receipt was ${JSON.stringify(retainedRecovery)}`);

    const readOnlyPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await readOnlyPage.route(/\/api\/maintenance(?:\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...MAINTENANCE_PAYLOAD, mode: 'read-only',
        capabilities: { plan: true, apply: false, undo: false },
      }),
    }));
    await readOnlyPage.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
    await readOnlyPage.click('[data-tab="system"]');
    await readOnlyPage.click('[data-system-view="maintenance"]');
    await readOnlyPage.waitForFunction(() => /Actions are not enabled/.test(
      document.getElementById('sys-maint-banner')?.textContent || '',
    ));
    const readOnlyBoundary = await readOnlyPage.evaluate(() => ({
      banner: document.getElementById('sys-maint-banner')?.innerText,
      controls: document.querySelectorAll('#sys-maintenance [data-maint-action]').length,
    }));
    check('the same findings stay strictly report-only when apply capability is absent',
      /no change capability is available/.test(String(readOnlyBoundary.banner))
        && readOnlyBoundary.controls === 0,
      `read-only Maintenance was ${JSON.stringify(readOnlyBoundary)}`);
    await readOnlyPage.close();

    const retryPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
    let maintenanceAttempts = 0;
    await retryPage.route(/\/api\/maintenance(?:\?|$)/, (route) => {
      maintenanceAttempts++;
      return route.fulfill(maintenanceAttempts === 1 ? {
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary fixture failure' }),
      } : {
        status: 200, contentType: 'application/json', body: JSON.stringify(MAINTENANCE_PAYLOAD),
      });
    });
    await retryPage.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
    await retryPage.click('[data-tab="system"]');
    await retryPage.click('[data-system-view="maintenance"]');
    await retryPage.waitForSelector('[data-maint-retry]');
    check('a failed Maintenance read renders recovery guidance instead of a blank panel',
      /could not be read/i.test(await visibleText(retryPage, '#sys-maintenance'))
        && /Retry report/.test(await visibleText(retryPage, '#sys-maintenance')),
      'Maintenance failure did not expose its bounded retry');
    await retryPage.click('[data-maint-retry]');
    await retryPage.waitForSelector('#sys-maint-list [data-maint-key]');
    check('Retry report recovers the panel without restarting the dashboard',
      maintenanceAttempts === 2
        && await retryPage.$$eval('#sys-maint-list [data-maint-key]', (rows) => rows.length) === 4,
      `Maintenance retry made ${maintenanceAttempts} requests`);
    await retryPage.close();

    const historyPage = await browser.newPage({ viewport: { width: 1080, height: 760 } });
    await historyPage.route(/\/api\/maintenance(?:\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...MAINTENANCE_PAYLOAD,
        findings: [], receipts: MAINTENANCE_HISTORY,
        summary: {
          total: 0, updatesReady: 0, safeCleanup: 0, needsReview: 0, blocked: 0,
          recentChanges: MAINTENANCE_HISTORY.length, incompleteSources: 0, actionable: 0,
        },
      }),
    }));
    await historyPage.goto(srv.urlWithToken, { waitUntil: 'domcontentloaded' });
    await historyPage.click('[data-tab="system"]');
    await historyPage.click('[data-system-view="maintenance"]');
    await historyPage.click('#sys-maint-buckets [data-maint-bucket="recent-changes"]');
    await historyPage.waitForSelector('#sys-maint-list [data-maint-key]');
    const durableLedger = await visibleText(historyPage, '#sys-maint-list');
    const humanStatuses = [
      'Change recorded', 'Change rolled back', 'No change made', 'No change observed',
      'Recovery required', 'Apply interrupted', 'Verification interrupted',
      'Catalog refresh interrupted', 'Undo interrupted',
    ];
    check('durable terminal and recovery receipts use human labels and updatedAt ages',
      humanStatuses.every((label) => durableLedger.includes(label))
        && /Recorded \d+m ago/.test(durableLedger)
        && /Updated \d+m ago/.test(durableLedger)
        && !/time unknown/.test(durableLedger)
        && !/(aborted-no-change|recovered-no-change|partial-recovery-required|refreshing-catalog)/.test(durableLedger),
      `durable receipt ledger read ${JSON.stringify(durableLedger)}`);

    await historyPage.click('[data-maint-key="receipt:receipt-partial-recovery-required"]');
    const recoveryDetail = await historyPage.evaluate(() => ({
      text: document.getElementById('sys-maint-detail')?.innerText,
      undoControls: document.querySelectorAll('#sys-maint-detail [data-maint-action="undo"]').length,
    }));
    check('recovery-required history stays blocked and never exposes Undo',
      /Recovery required/.test(String(recoveryDetail.text))
        && /could not prove a complete outcome/.test(String(recoveryDetail.text))
        && /Updated\s+\d+m ago/.test(String(recoveryDetail.text))
        && recoveryDetail.undoControls === 0,
      `recovery receipt detail was ${JSON.stringify(recoveryDetail)}`);

    await historyPage.click('[data-maint-key="receipt:receipt-aborted-no-change"]');
    const noChangeDetail = await historyPage.evaluate(() => ({
      text: document.getElementById('sys-maint-detail')?.innerText,
      undoControls: document.querySelectorAll('#sys-maint-detail [data-maint-action="undo"]').length,
    }));
    check('a journal-proven no-change receipt is recorded without implying an undoable mutation',
      /No change made/.test(String(noChangeDetail.text))
        && /no provider action started/.test(String(noChangeDetail.text))
        && /Recorded\s+\d+m ago/.test(String(noChangeDetail.text))
        && noChangeDetail.undoControls === 0,
      `no-change receipt detail was ${JSON.stringify(noChangeDetail)}`);

    await historyPage.click('[data-maint-key="receipt:receipt-committed"]');
    const committedDetail = await historyPage.evaluate(() => ({
      text: document.getElementById('sys-maint-detail')?.innerText,
      undoControls: document.querySelectorAll('#sys-maint-detail [data-maint-action="undo"]').length,
    }));
    check('only a committed server-eligible receipt exposes guarded Undo',
      /Change recorded/.test(String(committedDetail.text))
        && /Recorded\s+\d+m ago/.test(String(committedDetail.text))
        && committedDetail.undoControls === 1,
      `committed receipt detail was ${JSON.stringify(committedDetail)}`);
    await shoot(historyPage, 'system-maintenance-recovery-history');
    await historyPage.close();

    // ── the fail-closed rule, where it is easiest to break (ADR-0023) ─────────
    // The catalog section has never been deep-scanned and one install figure was
    // never recorded. Neither may surface as a 0: an unmeasured quantity says so
    // and says why. A MEASURED zero (0 daemons past TTL) is a real answer and
    // must still read as 0 — the two are asserted together so a renderer cannot
    // satisfy one by breaking the other.
    await page.click('[data-system-view="summary"]');
    await page.waitForSelector('#panel-sys-summary:not([hidden])');
    const honesty = await page.evaluate(() => {
      const kpi = (label) => [...document.querySelectorAll('#sys-kpis .sy-kpi')]
        .find((card) => card.querySelector('.lbl')?.textContent.trim() === label);
      const readKpi = (label) => {
        const el = kpi(label);
        if (!el) return null;
        const unk = el.querySelector('.val .sy-unk');
        return {
          // The odometer's digit stacks put 0-9 in the DOM for every column, so
          // the CLAIMED value is data-od — reading innerText here would compare
          // against "0123456789" and prove nothing.
          odometer: el.querySelector('.val .od')?.getAttribute('data-od') ?? null,
          unknown: unk ? unk.textContent.trim() : null,
          unknownReason: unk ? unk.getAttribute('title') : null,
          sub: el.querySelector('.sub')?.innerText.trim() || '',
        };
      };
      const unknowns = [...document.querySelectorAll('#area-system .sy-unk')];
      return {
        catalog: readKpi('catalog'),
        install: readKpi('install footprint'),
        reasonless: unknowns.filter((el) => !el.getAttribute('title')).length,
        unknownCount: unknowns.length,
      };
    });
    check('an unmeasured section reports "not measured yet" instead of a fabricated 0',
      honesty.catalog && honesty.catalog.odometer === null
        && /not measured yet/i.test(String(honesty.catalog.unknown)),
      `the catalog KPI read ${JSON.stringify(honesty.catalog)} — a 0 here would invent an empty catalog`);
    check('an unmeasured figure beside measured ones degrades alone, not as a zero',
      honesty.install && honesty.install.odometer !== null
        && /not measured yet/i.test(honesty.install.sub)
        && !/\b0 native addons\b/.test(honesty.install.sub),
      `the install KPI read ${JSON.stringify(honesty.install)}`);
    check('every unmeasured figure states why it is unmeasured',
      honesty.unknownCount > 0 && honesty.reasonless === 0,
      `${honesty.reasonless} of ${honesty.unknownCount} unknown markers carried no reason`);
    const browserRuntimes = await page.$eval('#sys-browser-runtimes', (el) => ({
      rows: [...el.querySelectorAll('tbody tr')].map((row) => row.innerText.trim()),
      text: el.innerText,
    }));
    check('System exposes dependency ownership, install state, payload readiness, and cache cost for both browser runtimes',
      browserRuntimes.rows.length === 2
        && /agent-browser[\s\S]*agentic-kit[\s\S]*absent/i.test(browserRuntimes.rows[0])
        && /Vibium[\s\S]*agentic-qe[\s\S]*ready[\s\S]*148\.0\.7778\.56[\s\S]*392(?:\.0)? MB/i.test(browserRuntimes.rows[1]),
      `browser runtime rows were ${JSON.stringify(browserRuntimes.rows)}`);

    await page.click('[data-system-view="catalog"]');
    await page.waitForSelector('#panel-sys-catalog:not([hidden])');
    const neverScanned = await visibleText(page, '#sys-radar');
    check('a never-scanned section says so and points at Rescan',
      /not measured yet/i.test(neverScanned) && /rescan/i.test(neverScanned)
        && !/\b0\b/.test(neverScanned),
      `the unscanned catalog card read ${JSON.stringify(neverScanned)}`);

    await page.click('[data-system-view="runtime"]');
    await page.waitForSelector('#panel-sys-runtime:not([hidden])');
    const runtimeHonesty = await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('#sys-daemons .sy-tile')].map((tile) => ({
        value: tile.querySelector('.t-v')?.innerText.trim() || '',
        label: tile.querySelector('.t-l')?.innerText.trim() || '',
      })),
      procs: document.getElementById('sys-procs')?.innerText.trim() || '',
    }));
    const pastTtl = runtimeHonesty.tiles.find((tile) => /past TTL/i.test(tile.label));
    check('a measured zero is still rendered as 0',
      !!pastTtl && pastTtl.value === '0',
      `the "past TTL" tile read ${JSON.stringify(pastTtl)} — the fail-closed rule bans a `
      + 'fabricated zero, not a measured one');
    check('a process the census cannot attribute says so instead of blanking the cell',
      /not attributable/i.test(runtimeHonesty.procs),
      `the process census read ${JSON.stringify(runtimeHonesty.procs.slice(0, 240))}`);

    check('the daemon panel no longer carries an AI-worker budget tile',
      !runtimeHonesty.tiles.some((tile) => /budget/i.test(tile.label)),
      'no code path can populate it, so a permanent "unavailable" was removed rather than degraded');
    check('the pid column header is right-aligned with its numbers', await page.$eval(
      '#sys-procs thead th:nth-child(2)',
      (th) => th.textContent.trim() === 'pid' && getComputedStyle(th).textAlign === 'right',
    ), 'a numeric column whose header hangs off the far side reads as a different column');
    check('the never-persisted child-process footer is gone',
      !/child & MCP/i.test(runtimeHonesty.procs), 'a bare count with no denominator and no action');

    // ── Catalog filters + Projects filtering, on a payload that HAS them ──
    // The default SYSTEM_STUB deliberately ships `catalog: null` to prove the
    // never-scanned path, so the filters need their own payload rather than a
    // weakened fixture.
    const FILTER_SYSTEM = JSON.parse(JSON.stringify(SYSTEM_PAYLOAD));
    FILTER_SYSTEM.catalog = {
      asOf: SYS_DEEP_ASOF,
      hosts: ['claude', 'codex', 'opencode'],
      kinds: ['skill', 'agent', 'command'],
      scopes: ['user', 'project', 'plugin'],
      counts: { skill: meas(2), agent: meas(1), command: meas(1) },
      perHost: {},
      items: [
        { kind: 'skill', name: 'alpha-skill', hosts: ['claude'], sourceScopes: ['user'], presence: [] },
        { kind: 'skill', name: 'beta-skill', hosts: ['claude', 'codex'], sourceScopes: ['project', 'user'], presence: [], digestCoverage: { unique: 2 } },
        { kind: 'agent', name: 'gamma-agent', hosts: ['opencode'], sourceScopes: ['plugin'], presence: [{ provider: { ref: 'gamma@market', version: '1.2.3' } }] },
        { kind: 'command', name: 'delta-command', hosts: ['codex'], sourceScopes: ['user'], presence: [] },
      ],
      projects: [{
        project: '/repo/example', label: 'example', complete: true, launching: true,
        contextInclusion: { status: 'unknown', reason: 'host-owned' },
        guidance: [{ host: 'codex', message: '1 project-scoped skill observed', nextCommand: 'ak x skills plan --project "/repo/example"' }],
        byHost: Object.fromEntries(['claude', 'codex', 'opencode'].map((host) => [host, {
          sources: {
            project: { skill: meas(host === 'codex' ? 1 : 0), agent: meas(0), command: meas(0) },
            user: { skill: meas(2), agent: meas(0), command: meas(1) },
            plugin: { skill: meas(0), agent: meas(host === 'opencode' ? 1 : 0), command: meas(0) },
          },
          overlaps: { skillNames: meas(host === 'codex' ? 1 : 0), skillDigests: meas(0) },
        }])),
      }, {
        project: '/repo/secondary', label: 'secondary', complete: false, launching: false,
        contextInclusion: { status: 'unknown', reason: 'host-owned' },
        guidance: [{ host: 'codex', message: '4 project-scoped skills observed', nextCommand: 'ak x skills plan --project "/repo/secondary"' }],
        byHost: Object.fromEntries(['claude', 'codex', 'opencode'].map((host) => [host, {
          sources: {
            project: { skill: meas(host === 'codex' ? 4 : 0) },
            user: { skill: meas(2) },
            plugin: { skill: host === 'codex'
              ? { value: null, status: 'unknown', reason: 'native inventory unavailable', asOf: null, partial: false }
              : meas(0) },
          },
          overlaps: { skillNames: meas(host === 'codex' ? 1 : 0), skillDigests: meas(0) },
        }])),
      }, {
        project: '/repo/no-local-skills', label: 'no-local-skills', complete: true, launching: false,
        contextInclusion: { status: 'unknown', reason: 'host-owned' }, guidance: [],
        byHost: Object.fromEntries(['claude', 'codex', 'opencode'].map((host) => [host, {
          sources: { project: { skill: meas(0) }, user: { skill: meas(2) }, plugin: { skill: meas(3) } },
          overlaps: { skillNames: meas(0), skillDigests: meas(0) },
        }])),
      }],
      complete: true,
    };
    await page.route(/\/api\/system(\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(FILTER_SYSTEM),
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#tab-system');
    await page.click('[data-system-view="catalog"]');
    await page.waitForSelector('#sys-matrix tbody tr');

    const chipStates = () => page.$$eval('#sys-cat-kinds .chipf, #sys-cat-hosts .chipf',
      (els) => els.map((e) => e.getAttribute('aria-pressed')));
    const rowCount = () => page.$$eval('#sys-matrix tbody tr', (els) => els.length);

    check('every kind and host option starts selected, so the default view is the whole inventory',
      (await chipStates()).every((s) => s === 'true') && (await chipStates()).length === 6,
      `chips were ${JSON.stringify(await chipStates())}`);
    check('the filters are toggle buttons, announced as pressed', await page.$eval(
      '#sys-cat-kinds .chipf', (b) => b.tagName === 'BUTTON' && b.hasAttribute('aria-pressed')),
      'a filter a screen reader cannot read the state of is not a filter');
    check('no in-table kind heading rows remain — the pick list replaced them',
      (await page.$$('#sys-matrix .sy-kindrow')).length === 0, 'headings signposted but did not filter');
    check('every row still names its kind now the headings are gone',
      await page.$$eval('#sys-matrix tbody tr', (els) => els.every((e) => !!e.querySelector('.sy-kindtag'))),
      'a filtered list must never leave a name unexplained');
    check('unfiltered shows every item', await rowCount() === 4, `saw ${await rowCount()} of 4`);
    check('project pressure follows the two inventory panels as a full-width second row',
      await page.$eval('#panel-sys-catalog .sy-grid', (grid) => {
        const cards = [...grid.querySelectorAll(':scope > .sy-card')];
        const pressure = document.querySelector('#sys-pressure')?.closest('.sy-card');
        const profile = document.querySelector('#sys-radar')?.closest('.sy-card');
        const unique = document.querySelector('#sys-matrix')?.closest('.sy-card');
        if (!pressure || !profile || !unique) return false;
        const pressureBox = pressure.getBoundingClientRect();
        const profileBox = profile.getBoundingClientRect();
        const uniqueBox = unique.getBoundingClientRect();
        return cards.indexOf(pressure) > cards.indexOf(profile)
          && cards.indexOf(pressure) > cards.indexOf(unique)
          && pressureBox.top >= Math.max(profileBox.bottom, uniqueBox.bottom)
          && Math.abs(pressureBox.width - grid.getBoundingClientRect().width) < 2;
      }), 'project pressure did not render beneath both inventory cards at full width');
    check('Project skill pressure does not repeat its read-only boundary in the card header',
      await page.$eval('#sys-pressure', (el) => !/read-only evidence/i.test(
        el.closest('.sy-card')?.querySelector('.sy-head')?.innerText || '',
      )), 'the panel header still carries redundant read-only evidence chrome');
    const catalogViewport = await page.$eval('#sys-matrix .sy-catalog-scroll', (viewport) => {
      const body = viewport.querySelector('tbody');
      const originalCount = body.rows.length;
      while (body.rows.length < 8) body.append(body.rows[0].cloneNode(true));
      const box = viewport.getBoundingClientRect();
      const fullyVisible = [...body.rows].filter((row) => {
        const rowBox = row.getBoundingClientRect();
        return rowBox.top >= box.top && rowBox.bottom <= box.bottom + 0.5;
      });
      const result = {
        fullyVisible: fullyVisible.length,
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        rowHeights: [...body.rows].slice(0, 6).map((row) => row.getBoundingClientRect().height),
        headerHeight: viewport.querySelector('thead').getBoundingClientRect().height,
      };
      while (body.rows.length > originalCount) body.deleteRow(-1);
      return result;
    });
    check('the Unique across hosts viewport shows no more than five records before scrolling',
      catalogViewport.fullyVisible === 5
        && catalogViewport.scrollHeight > catalogViewport.clientHeight,
      `catalog viewport measured ${JSON.stringify(catalogViewport)}`);
    const pressureText = await visibleText(page, '#sys-pressure');
    const pressureProjects = await page.$$('#sys-pressure details.sy-pressure-project');
    check('project pressure groups once per relevant project instead of repeating project × host',
      pressureProjects.length === 2 && !/no-local-skills/.test(pressureText),
      `pressure rendered ${pressureProjects.length} disclosures and read ${JSON.stringify(pressureText)}`);
    check('the launching project is first and open while other projects stay summary-only',
      await page.$eval('#sys-pressure details:first-of-type', (d) => d.open && d.dataset.launching === 'true')
        && !(await page.$eval('#sys-pressure details:nth-of-type(2)', (d) => d.open)),
      'progressive disclosure did not prioritize the current project');
    check('inventory completeness and host-owned context are separate, non-contradictory facts',
      /Inventory complete/.test(pressureText)
        && (pressureText.match(/Context inclusion is not reported by these hosts/g) || []).length === 1
        && !/complete\s*[·-]\s*context unknown/i.test(pressureText),
      `pressure read ${JSON.stringify(pressureText)}`);
    check('collapsed projects hide full paths and repeated plan commands',
      !(await page.$eval('#sys-pressure details:nth-of-type(2)', (d) => d.innerText.includes('/repo/secondary')))
        && await page.$$eval('#sys-pressure details:nth-of-type(2) code', (els) => els.length) === 1,
      'a collapsed disclosure leaked its detailed path or repeated its command');
    await page.focus('#sys-pressure details:nth-of-type(2) summary');
    await page.keyboard.press('Enter');
    const secondaryText = await visibleText(page, '#sys-pressure details:nth-of-type(2)');
    check('expanding one project reveals source counts, visible unknown reason, and one read-only command',
      /Project skills|User skills|Plugin skills|native inventory unavailable|Read-only plan/.test(secondaryText)
        && await page.$$eval('#sys-pressure details:nth-of-type(2) code', (els) => els.length) === 1,
      `secondary project read ${JSON.stringify(secondaryText)}`);
    check('keyboard focus on a project disclosure remains visibly outlined',
      await page.$eval('#sys-pressure details:nth-of-type(2) summary', (summary) => {
        const style = getComputedStyle(summary);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      }), 'the summary accepted keyboard input but had no visible focus indicator');
    check('pressure disclosures use native accessible structure and scoped table headers',
      await page.$eval('#sys-pressure details:nth-of-type(2)', (d) => !!d.querySelector(':scope > summary'))
        && await page.$$eval('#sys-pressure details:nth-of-type(2) thead th[scope="col"]', (els) => els.length) === 6
        && await page.$$eval('#sys-pressure details:nth-of-type(2) tbody th[scope="row"]', (els) => els.length) === 1
        && await page.getAttribute('#sys-pressure .sy-pressure-list', 'tabindex') === '0',
      'native disclosure, headers, or focusable overflow region is missing');
    check('project pressure remains read-only with no destructive control labels',
      !/(apply|delete|remove|prune|upgrade)/i.test(await visibleText(page, '#sys-pressure button')),
      'the System view exposed a mutating action');
    await shoot(page, 'system-catalog-pressure');

    await page.click('#sys-cat-kinds .chipf:nth-child(2)'); // drop agents
    await page.click('#sys-cat-kinds .chipf:nth-child(3)'); // drop commands
    check('deselecting kinds narrows the table', await rowCount() === 2, `saw ${await rowCount()} of 2`);
    check('a narrowed table says how much it is hiding',
      /2 of 4/.test(await page.$eval('#sys-matrix .sy-liner', (e) => e.innerText)),
      'a filtered count that does not name the total reads as a shrinking machine');

    // host filter is OR, not AND: "carried by codex" keeps a codex+claude item.
    await page.click('#sys-cat-hosts .chipf:nth-child(1)'); // drop claude
    await page.click('#sys-cat-hosts .chipf:nth-child(3)'); // drop opencode
    check('the host filter matches ANY selected host, not all of them',
      await rowCount() === 1, `saw ${await rowCount()}; beta-skill is on claude AND codex, so codex alone keeps it`);

    await page.click('#sys-cat-kinds .chipf:nth-child(2)');
    await page.click('#sys-cat-kinds .chipf:nth-child(3)');
    await page.click('#sys-cat-hosts .chipf:nth-child(1)');
    await page.click('#sys-cat-hosts .chipf:nth-child(3)');
    check('re-selecting everything restores the full inventory',
      await rowCount() === 4 && (await chipStates()).every((s) => s === 'true'),
      `saw ${await rowCount()} rows and ${JSON.stringify(await chipStates())}`);

    await page.click('#sys-cat-scopes .chipf:nth-child(1)'); // drop user
    await page.click('#sys-cat-scopes .chipf:nth-child(2)'); // drop project
    check('source scope filter isolates plugin-contributed capabilities',
      await rowCount() === 1 && /gamma@market v1\.2\.3/.test(await visibleText(page, '#sys-matrix')),
      `source-filtered matrix read ${JSON.stringify(await visibleText(page, '#sys-matrix'))}`);
    check('catalog filter changes are announced',
      /1 of 4/.test(await page.$eval('#sys-cat-status', (e) => e.textContent)),
      'the live filter result count was not updated');

    await page.click('[data-system-view="projects"]');
    await page.waitForSelector('#sys-projects table');
    const projectRows = await page.$$eval('#sys-projects tbody tr', (els) => els.map((e) => ({
      linked: !!e.querySelector('a[href^="https:"]'), text: e.innerText,
    })));
    check('the Projects table lists only repositories with a remote',
      projectRows.length > 0 && projectRows.every((r) => r.linked),
      `${projectRows.filter((r) => !r.linked).length} unlinked row(s) survived the filter`);
    const projectNames = projectRows.map((r) => r.text.split('\n')[0]).join(' ');
    check('a linked repo no host ever worked in is excluded',
      !/never-worked-in/.test(projectNames), `rows were ${JSON.stringify(projectNames)}`);
    check('a linked repo from a snapshot with no hosts field is KEPT — absent is not zero',
      /legacy-snapshot-row/.test(projectNames),
      `an older snapshot cannot answer "was this worked in", and guessing no blanks the table`);
    const projectLiner = await page.$eval('#sys-projects .sy-liner', (e) => e.innerText);
    check('and states what it excluded rather than leaving the reader to subtract',
      /listed here/.test(projectLiner)
        && (projectRows.length === (SYSTEM_PAYLOAD.projects?.projects ?? []).length
          || /Excluded \d+ measured director/.test(projectLiner)),
      `the liner read ${JSON.stringify(projectLiner)}`);
    check('the language legend matches the ramp it describes',
      /top 5 languages/.test(await page.$eval('#sys-projects .sy-legend', (e) => e.innerText)),
      'the legend and LANG_TOP drifted apart');

    // ── sortable headers ──
    const projCol = (n) => page.$$eval(`#sys-projects tbody tr td:nth-child(${n})`,
      (els) => els.map((e) => e.innerText.split('\n')[0].trim()));
    const sortState = () => page.evaluate(() => ({
      aria: [...document.querySelectorAll('#sys-projects thead th')].map((t) => t.getAttribute('aria-sort')),
      active: [...document.querySelectorAll('#sys-projects .sy-sort.on')].length,
    }));

    const s0 = await sortState();
    const names0 = await projCol(1);
    check('the table opens sorted by project name, ascending',
      s0.aria[0] === 'ascending'
        && JSON.stringify(names0) === JSON.stringify([...names0].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))),
      `aria was ${JSON.stringify(s0.aria)} and the order ${JSON.stringify(names0)}`);
    check('every header is a sort control', await page.$$eval('#sys-projects thead th',
      (ths) => ths.every((t) => !!t.querySelector('button[data-proj-sort]'))),
      'a header without a control is a column the user cannot order by');

    await page.click('[data-proj-sort="project"]');
    const s1 = await sortState();
    check('clicking the active column reverses it',
      s1.aria[0] === 'descending'
        && JSON.stringify(await projCol(1)) === JSON.stringify([...names0].reverse()),
      `aria was ${JSON.stringify(s1.aria)}`);

    await page.click('[data-proj-sort="disk"]');
    const s2 = await sortState();
    check('only one column may be the active sort at a time',
      s2.active === 1 && s2.aria.filter((a) => a && a !== 'none').length === 1,
      `${s2.active} active control(s), aria ${JSON.stringify(s2.aria)}`);
    check('a size column opens largest-first, not ascending',
      s2.aria[3] === 'descending',
      'nobody opens a size column wanting the smallest row first');

    // The rule that matters: an unmeasured figure is not a small one.
    const diskDesc = await projCol(1);
    await page.click('[data-proj-sort="disk"]');
    const diskAsc = await projCol(1);
    // startsWith, not equality: a linked project's cell carries a trailing ↗.
    const endsWithUnmeasured = (rows) => rows[rows.length - 1].startsWith('zz-unmeasured');
    check('an unmeasured row sorts LAST in both directions',
      endsWithUnmeasured(diskDesc) && endsWithUnmeasured(diskAsc),
      `desc ended ${JSON.stringify(diskDesc.slice(-1))}, asc ended ${JSON.stringify(diskAsc.slice(-1))} `
      + '— ranking an absent figure presents it as a measured one');
    // Hand the page back exactly as the checks below expect to find it: the real
    // SYSTEM_STUB served again, the System area open, and its freshness label
    // populated. A bare reload would leave /api/system unfetched and the
    // staleness assertions reading an empty element.
    await page.unroute(/\/api\/system(\?|$)/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#tab-system');
    await page.waitForFunction(
      () => (document.getElementById('sys-asof')?.textContent ?? '').trim().length > 0,
      null, { timeout: 30_000 },
    );

    // ── the deep tier is user-triggered, and its age is stated ───────────────
    const freshness = await page.evaluate(() => {
      const el = document.getElementById('sys-asof');
      return {
        text: el?.textContent.trim(),
        stale: el?.getAttribute('data-stale'),
        title: el?.getAttribute('title'),
        rescanDisabled: document.getElementById('sys-rescan')?.disabled,
        fullScanLabel: document.getElementById('sys-rescan')?.innerText,
        live: el?.getAttribute('aria-live'),
      };
    });
    check('deep-tier figures are stamped with their own age, not presented as current',
      /9d ago/.test(String(freshness.text)),
      `the freshness label read ${JSON.stringify(freshness)} — the snapshot is nine days old`);
    check('past the staleness horizon the label nudges without scanning',
      freshness.stale === '1' && /stale/i.test(String(freshness.text))
        && freshness.rescanDisabled === false && /Full scan/.test(String(freshness.fullScanLabel))
        && freshness.live === 'polite',
      `staleness presentation was ${JSON.stringify(freshness)}`);
    check('opening System never starts a deep scan',
      systemDeepScans === 0,
      `${systemDeepScans} deep scan(s) had already run after opening the area and all five views`);

    const deepResponse = page.waitForResponse(
      (r) => r.url().includes('/api/system') && r.url().includes('refresh=deep'),
      { timeout: 8000 },
    ).catch(() => null);
    await page.click('#sys-rescan');
    await deepResponse;
    await page.waitForTimeout(200);
    check('Rescan is the only thing that starts a deep scan, and it starts exactly one',
      systemDeepScans === 1,
      `the collector saw ${systemDeepScans} deep scan(s) after one Rescan click`);
    await page.waitForTimeout(50);
    check('a successful deep System rescan refreshes Maintenance provider evidence once',
      chainedMaintenanceScans === 1,
      `the Maintenance service saw ${chainedMaintenanceScans} scan(s)`);

    // ── Observability: execution workspace + synchronized evidence ──
    await page.click('[data-tab="observability"]');
    await page.waitForSelector('#live-nodes .live-node', { timeout: 8000 });
    await page.waitForTimeout(80);
    const liveShape = await page.evaluate(() => ({
      sessions: document.querySelectorAll('#live-session-list > .live-session-family').length,
      childSessions: document.querySelectorAll('#live-session-list .live-session-child').length,
      nodes: document.querySelectorAll('#live-nodes .live-node').length,
      edges: document.querySelectorAll('#live-edges .live-edge').length,
      tools: document.querySelectorAll('#live-tools .live-tool').length,
      anchorCores: document.querySelectorAll('#live-nodes .node-core').length,
      workBubbles: document.querySelectorAll('#live-nodes .node-work').length,
      cardNodes: document.querySelectorAll('#live-nodes .node-card').length,
      graphRole: document.getElementById('live-graph')?.getAttribute('role'),
      transcriptRole: document.getElementById('live-transcript-list')?.getAttribute('role'),
      columns: getComputedStyle(document.querySelector('.live-workspace')).gridTemplateColumns,
      transport: getComputedStyle(document.getElementById('live-playback')).position,
      transportParent: document.getElementById('live-playback')?.parentElement?.className,
    }));
    check('live workspace renders agent anchors and owned tool satellites',
      liveShape.sessions === 1 && liveShape.childSessions === 1
        && liveShape.nodes === 3 && liveShape.tools >= 1
        && liveShape.edges >= 2,
      `shape was ${JSON.stringify(liveShape)}`);
    check('execution graph and transcript expose accessible live-region semantics',
      liveShape.graphRole === 'group' && liveShape.transcriptRole === 'log',
      `roles were ${JSON.stringify(liveShape)}`);
    check('cinematic map uses agent anchors and observed-work bubbles instead of card nodes',
      liveShape.anchorCores === liveShape.nodes && liveShape.workBubbles === liveShape.nodes
        && liveShape.cardNodes === 0,
      `cinematic primitives were ${JSON.stringify(liveShape)}`);
    check('desktop Live view is a persistent three-column workspace',
      liveShape.columns.split(' ').length === 3,
      `columns were ${JSON.stringify(liveShape.columns)}`);
    check('session transport is docked inside the center stage without overlay positioning',
      liveShape.transport === 'static' && /live-canvas-card/.test(liveShape.transportParent),
      `transport positioning was ${JSON.stringify(liveShape)}`);
    const streamExpanded = await page.evaluate(() => {
      globalThis.__akLiveSource = globalThis.AKLive.state.source;
      globalThis.__akStreamSource = globalThis.AKLive.state.transcript.source;
      const activity = document.querySelector('.live-canvas-card').getBoundingClientRect();
      const stream = document.getElementById('live-transcript-panel').getBoundingClientRect();
      return {
        activityWidth: activity.width,
        streamWidth: stream.width,
        bodyHidden: document.getElementById('live-transcript-body').hidden,
        expanded: document.getElementById('live-transcript-toggle').getAttribute('aria-expanded'),
        camera: { ...globalThis.AKLive.state.camera },
      };
    });
    await page.click('#live-transcript-toggle');
    await page.waitForTimeout(260);
    const streamCollapsed = await page.evaluate(() => {
      const activity = document.querySelector('.live-canvas-card').getBoundingClientRect();
      const stream = document.getElementById('live-transcript-panel').getBoundingClientRect();
      return {
        activityWidth: activity.width,
        streamWidth: stream.width,
        bodyHidden: document.getElementById('live-transcript-body').hidden,
        expanded: document.getElementById('live-transcript-toggle').getAttribute('aria-expanded'),
        workspaceState: document.getElementById('live-workspace').dataset.transcriptCollapsed,
        panelState: document.getElementById('live-transcript-panel').dataset.collapsed,
        persisted: localStorage.getItem('ak-dash-transcript-collapsed'),
        liveSourceActive: !!globalThis.AKLive.state.source,
        sameLiveSource: globalThis.__akLiveSource === globalThis.AKLive.state.source,
        sameTranscriptSource: globalThis.__akStreamSource === globalThis.AKLive.state.transcript.source,
        camera: { ...globalThis.AKLive.state.camera },
      };
    });
    await shoot(page, 'observability-stream-collapsed');
    check('Session Stream collapses to a persistent restore rail and Agent Activity reclaims its width',
      streamExpanded.expanded === 'true' && !streamExpanded.bodyHidden
        && streamCollapsed.expanded === 'false' && streamCollapsed.bodyHidden
        && streamCollapsed.workspaceState === 'true' && streamCollapsed.panelState === 'true'
        && streamCollapsed.streamWidth <= 46
        && streamCollapsed.activityWidth > streamExpanded.activityWidth + 150,
      `expanded=${JSON.stringify(streamExpanded)} collapsed=${JSON.stringify(streamCollapsed)}`);
    check('collapsing Session Stream preserves stream connections, map camera, and local preference',
      streamCollapsed.liveSourceActive && streamCollapsed.sameLiveSource
        && streamCollapsed.sameTranscriptSource && streamCollapsed.persisted === 'true'
        && JSON.stringify(streamCollapsed.camera) === JSON.stringify(streamExpanded.camera),
      `collapse state was ${JSON.stringify(streamCollapsed)}`);
    await page.click('#live-transcript-toggle');
    await page.waitForTimeout(260);
    const streamRestored = await page.evaluate(() => ({
      expanded: document.getElementById('live-transcript-toggle').getAttribute('aria-expanded'),
      bodyHidden: document.getElementById('live-transcript-body').hidden,
      persisted: localStorage.getItem('ak-dash-transcript-collapsed'),
      streamWidth: document.getElementById('live-transcript-panel').getBoundingClientRect().width,
      activityWidth: document.querySelector('.live-canvas-card').getBoundingClientRect().width,
    }));
    check('Session Stream expands in place and restores its prior panel allocation',
      streamRestored.expanded === 'true' && !streamRestored.bodyHidden
        && streamRestored.persisted === 'false'
        && Math.abs(streamRestored.streamWidth - streamExpanded.streamWidth) <= 2
        && Math.abs(streamRestored.activityWidth - streamExpanded.activityWidth) <= 2,
      `restored state was ${JSON.stringify(streamRestored)}`);
    const mapControls = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.live-view-tools button')];
      return {
        groups: document.querySelectorAll('.live-view-tools .live-control-group').length,
        labels: buttons.map((button) => button.textContent.trim()),
        heights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
        wrapping: buttons.map((button) => getComputedStyle(button).whiteSpace),
      };
    });
    check('map controls use compact non-wrapping segmented groups',
      mapControls.groups === 2
        && mapControls.heights.every((height) => height === mapControls.heights[0])
        && mapControls.wrapping.every((value) => value === 'nowrap')
        && ['Fit', 'Focus', 'Reset', 'Help'].every((label) => mapControls.labels.includes(label)),
      `map controls were ${JSON.stringify(mapControls)}`);
    const motionGrammar = await page.evaluate(() => ({
      flowing: document.querySelectorAll('#live-edges .live-edge[data-active="true"]').length,
      structural: document.querySelectorAll('#live-edges .live-edge[data-active="false"]').length,
      presenceAnimation: getComputedStyle(document.querySelector('[data-node="ui-live-session"] .node-aura')).animationName,
      workAnimation: getComputedStyle(document.querySelector('[data-node="ui-live-agent"] .node-status')).animationName,
      operationAnimation: getComputedStyle(document.querySelector('[data-node="ui-live-tool"] .live-tool-halo')).animationName,
    }));
    check('motion distinguishes one in-flight operation from static relationships',
      motionGrammar.flowing === 1 && motionGrammar.structural >= 2,
      `motion grammar was ${JSON.stringify(motionGrammar)}`);
    check('observed process presence uses a slow breathing halo',
      /live-breathe/.test(motionGrammar.presenceAnimation),
      `presence animation was ${JSON.stringify(motionGrammar.presenceAnimation)}`);
    check('meaningful actor and operation work retain their own pulse',
      /live-pulse/.test(motionGrammar.workAnimation)
        && /live-pulse/.test(motionGrammar.operationAnimation),
      `work animations were ${JSON.stringify(motionGrammar)}`);
    const overlapFree = await page.evaluate(() => {
      const actor = document.querySelector('[data-node="ui-live-agent"] .node-work')?.getBoundingClientRect();
      const tool = document.querySelector('[data-node="ui-live-tool"]')?.getBoundingClientRect();
      return actor && tool && (actor.right <= tool.left || tool.right <= actor.left
        || actor.bottom <= tool.top || tool.bottom <= actor.top);
    });
    check('automatic actor bundles keep work labels clear of tool cards',
      overlapFree, 'an actor work label intersected its owned tool card');
    await page.click('#live-legend-toggle');
    check('Legend / Help explains the visual and interaction grammar on demand',
      await page.locator('#live-legend').isVisible()
        && /Presence halo/.test(await visibleText(page, '#live-legend'))
        && /Drag actors or operations/.test(await visibleText(page, '#live-legend')),
      'legend did not expose status, motion, and drag help');
    await page.locator('#live-legend-close').click();
    await page.waitForFunction(() => document.getElementById('live-legend').hidden);
    check('Legend Close dismisses the dialog and returns focus to Help',
      await page.locator('#live-legend').isHidden()
        && await page.evaluate(() => document.activeElement?.id) === 'live-legend-toggle',
      'Legend Close did not dismiss the dialog accessibly');
    await page.locator('[data-node="ui-live-tool"]').hover();
    check('hovering a component exposes an evidence-aware description',
      await page.locator('#live-tooltip').isVisible()
        && /Tool/.test(await visibleText(page, '#live-tooltip')),
      'tool tooltip was missing or did not identify the component');
    await page.mouse.move(2, 2);
    const healthText = await visibleText(page, '#live-health');
    check('live adapter health renders only status and aggregate counters',
      /claude · ok · 2 files · 8 events · 0 errors/.test(healthText)
        && /codex · error · 1 files · 3 events · 1 errors/.test(healthText)
        && !/Users|secret|invalid-json/.test(healthText),
      `health text was ${JSON.stringify(healthText)}`);
    await page.click('#live-health-toggle');
    const healthPlacement = await page.locator('#live-health').boundingBox();
    const sourceTrigger = await page.locator('#live-health-toggle').boundingBox();
    check('source inspector stays within the viewport and does not cover its trigger',
      healthPlacement.x >= 0 && healthPlacement.y >= sourceTrigger.y + sourceTrigger.height
        && healthPlacement.x + healthPlacement.width <= 1440,
      `inspector ${JSON.stringify(healthPlacement)} trigger ${JSON.stringify(sourceTrigger)}`);
    await page.keyboard.press('Escape');
    check('Escape closes the source inspector and returns focus to its trigger',
      await page.locator('#live-health').isHidden()
        && await page.evaluate(() => document.activeElement?.id) === 'live-health-toggle',
      'source inspector did not close accessibly');
    const sessionIdentity = await visibleText(page, '[data-session="ui-live-session"]');
    check('session row leads with provider and status instead of an opaque id',
      /Codex/i.test(sessionIdentity) && /Working now/.test(sessionIdentity)
        && !/ui-live-session/.test(sessionIdentity),
      `session identity was ${JSON.stringify(sessionIdentity)}`);
    check('session state uses human evidence language instead of adapter absence',
      !/Status not reported/.test(await visibleText(page, '#panel-observability')),
      'Live view exposed the missing telemetry field instead of a human session state');
    check('internal model placeholders never leak into activity callouts',
      !/<synthetic>/.test(await visibleText(page, '#live-canvas'))
        && /Response produced/.test(await visibleText(page, '#live-canvas')),
      'activity callout exposed an internal placeholder or lost its semantic label');
    const workerFreshness = await visibleText(page, '.live-session-child');
    check('sessions without a start boundary show freshness instead of epoch-sized duration',
      /(Working now|Last active) · (just now|\d+s ago)/.test(workerFreshness)
        && !/\d{4,}h/.test(workerFreshness),
      `worker freshness was ${JSON.stringify(workerFreshness)}`);
    check('Live navigation is project-first and keeps sessions within the selected project',
      await page.locator('#live-project-list [data-project]').count() === 1
        && /1 session/.test(await visibleText(page, '#live-project-list')),
      'project catalog did not summarize its sessions');
    check('Live is the default and excludes historical root sessions',
      await page.getAttribute('[data-live-scope="live"]', 'aria-selected') === 'true'
        && await page.locator('[data-session="ui-review-session"]').count() === 0,
      'historical sessions leaked into the default Live scope');
    const observabilityTabs = await page.evaluate(() => ({
      parentClasses: document.getElementById('live-scope-tabs')?.className,
      roles: [...document.querySelectorAll('[data-live-scope]')].map((item) => item.getAttribute('role')),
    }));
    check('Observability uses the shared secondary segmented-tab presentation',
      /seg/.test(observabilityTabs.parentClasses)
        && /subseg/.test(observabilityTabs.parentClasses)
        && observabilityTabs.roles.every((role) => role === 'tab'),
      `Observability tabs were ${JSON.stringify(observabilityTabs)}`);
    await page.focus('[data-live-scope="live"]');
    await page.keyboard.press('ArrowRight');
    const keyboardHistory = await page.getAttribute('[data-live-scope="history"]', 'aria-selected');
    await page.keyboard.press('ArrowLeft');
    check('Observability secondary tabs support arrow-key navigation',
      keyboardHistory === 'true'
        && await page.getAttribute('[data-live-scope="live"]', 'aria-selected') === 'true',
      'Live/History tabs did not follow keyboard focus');
    check('Live navigator enters at projects and drills into a project session history',
      await page.getAttribute('#live-browser', 'data-level') === 'projects',
      'navigator did not enter at the project level');
    await page.click('#live-project-list [data-project]');
    check('project drill-in uses the same navigator with an explicit Back affordance',
      await page.getAttribute('#live-browser', 'data-level') === 'sessions'
        && await page.locator('#live-browser-back').isVisible(),
      'project selection did not reveal the session level');
    check('Live project drill-in contains only the active root session',
      await page.locator('#live-session-list [data-session]').first().getAttribute('data-session')
        === 'ui-live-session'
        && await page.locator('#live-session-list > .live-session-family').count() === 1,
      'the Live scope mixed in a historical root session');
    const liveSessionPresentation = await page.evaluate(() => {
      const row = document.querySelector('[data-session="ui-live-session"]');
      const icon = row?.querySelector('.live-host-icon');
      return {
        text: row?.textContent,
        label: row?.getAttribute('aria-label'),
        iconHost: icon?.dataset.host,
        iconViewBox: icon?.getAttribute('viewBox'),
        iconPaths: icon?.querySelectorAll('path').length,
        iconCircles: icon?.querySelectorAll('circle').length,
        branchIcon: row?.querySelector('.live-branch-icon') != null,
        role: row?.getAttribute('role'),
      };
    });
    check('Codex uses the official OpenAI mark and concise branch metadata',
      liveSessionPresentation.iconHost === 'codex'
        && liveSessionPresentation.iconViewBox === '146 227 268 267'
        && liveSessionPresentation.iconPaths === 1
        && liveSessionPresentation.iconCircles === 0
        && liveSessionPresentation.branchIcon
        && !/agentic-kit|Directory:|repo root|Branch:/.test(liveSessionPresentation.text)
        && /feature\/observability/.test(liveSessionPresentation.text)
        && /Branch: feature\/observability/.test(liveSessionPresentation.label)
        && /not attributed to this session/.test(liveSessionPresentation.label),
      `Codex session presentation was ${JSON.stringify(liveSessionPresentation)}`);
    check('session rows preserve native button semantics',
      liveSessionPresentation.role == null,
      `session role was ${JSON.stringify(liveSessionPresentation.role)}`);
    await page.click('[data-session="ui-live-session"]');
    const selectionWorkspace = await page.evaluate(() => {
      const details = document.getElementById('live-selection-body');
      return {
        text: details?.textContent,
        branchIcon: details?.querySelector('.live-detail-branch .live-branch-icon') != null,
      };
    });
    check('selecting a session exposes persistent workspace capture details',
      /Working tree at capture/.test(selectionWorkspace.text)
        && /\+42 \/ −7 lines/.test(selectionWorkspace.text)
        && /feature\/observability/.test(selectionWorkspace.text)
        && !/agentic-kit|repo root|Workspace/.test(selectionWorkspace.text)
        && selectionWorkspace.branchIcon,
      `session selection details were ${JSON.stringify(selectionWorkspace)}`);
    const boundedTools = await page.evaluate(() => {
      const session = globalThis.AKLive.state.snapshot.sessions
        .find((item) => item.key === 'codex:ui-live-session');
      for (let index = 0; index < 12; index++) {
        const id = `historical-tool-${index}`;
        session.nodes.push({
          id, kind: 'tool', toolName: index % 2 ? 'Read' : 'exec_command',
          status: 'completed', observedAt: new Date(Date.now() - index * 1000).toISOString(),
        });
        session.edges.push({
          id: `history-edge-${index}`, source: 'ui-live-session', target: id,
          action: 'tool.completed',
        });
      }
      globalThis.AKLive.render();
      return {
        visible: document.querySelectorAll('#live-tools .live-tool').length,
        history: document.querySelector('.node-history')?.textContent,
      };
    });
    check('completed tool history collapses into an owner-associated recent lane',
      boundedTools.visible === 7 && /earlier operations/.test(boundedTools.history),
      `bounded tool rendering was ${JSON.stringify(boundedTools)}`);
    await page.click('[data-live-scope="history"]');
    check('History shows retained projects without live root sessions',
      await page.getAttribute('[data-live-scope="history"]', 'aria-selected') === 'true'
        && await page.locator('#live-project-list [data-project]').count() === 1,
      'History did not expose the retained project catalog');
    await page.click('#live-project-list [data-project]');
    const historyRows = await page.locator('#live-session-list > .live-session-family > [data-session]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session')));
    check('History excludes the currently live root session',
      historyRows.filter((id) => id === 'ui-review-session').length === 1
        && historyRows.filter((id) => id === 'ui-opencode-session').length === 1
        && !historyRows.includes('ui-live-session'),
      `History rows were ${JSON.stringify(historyRows)}`);
    const openCodePresentation = await page.evaluate(() => {
      const row = document.querySelector('[data-session="ui-opencode-session"]');
      const icon = row?.querySelector('.live-host-icon');
      return {
        text: row?.textContent,
        iconHost: icon?.dataset.host,
        iconViewBox: icon?.getAttribute('viewBox'),
        paths: icon?.querySelectorAll('path').length,
        branchIcon: row?.querySelector('.live-branch-icon') != null,
      };
    });
    check('OpenCode uses its official square O asset with the shared session shell',
      openCodePresentation.iconHost === 'opencode'
        && openCodePresentation.iconViewBox === '0 0 300 300'
        && openCodePresentation.paths === 2
        && openCodePresentation.branchIcon
        && !/agentic-kit|Directory:|repo root|Branch:/.test(openCodePresentation.text)
        && /feature\/opencode/.test(openCodePresentation.text),
      `OpenCode presentation was ${JSON.stringify(openCodePresentation)}`);
    await page.click('[data-session="ui-review-session"]');
    await page.waitForSelector('#live-mode[data-mode="history"]');
    await page.waitForFunction(() => !document.getElementById('live-playback-range').disabled);
    check('Claude sidechain actors appear as nested worker views without fabricating sessions',
      await page.locator('[data-actor="claude-reviewer"]').count() === 1
        && /Worker view/.test(await visibleText(page, '[data-actor="claude-reviewer"]')),
      'Claude embedded actor was not exposed as a nested actor lens');
    check('completed sessions enter clearly distinguished historical playback',
      /HISTORY/.test(await visibleText(page, '#live-mode'))
        && !(await page.locator('#live-playback-range').isDisabled())
        && !(await page.locator('#live-resume-live').isVisible()),
      'History badge or playback controls were unavailable');
    const playbackLayout = await page.evaluate(() => {
      const canvas = document.getElementById('live-canvas')?.getBoundingClientRect();
      const playback = document.getElementById('live-playback')?.getBoundingClientRect();
      const guidance = document.getElementById('live-map-guidance')?.getBoundingClientRect();
      return {
        canvasBottom: canvas?.bottom,
        playbackTop: playback?.top,
        guidanceBottom: guidance?.bottom,
      };
    });
    check('History playback is reserved below the map and cannot cover map guidance',
      playbackLayout.canvasBottom <= playbackLayout.playbackTop + 1
        && playbackLayout.guidanceBottom < playbackLayout.playbackTop,
      `playback layout overlapped the map ${JSON.stringify(playbackLayout)}`);
    const historyMotion = await page.evaluate(() => ({
      working: document.querySelectorAll('#live-canvas [data-status="working"]').length,
      present: document.querySelectorAll('#live-canvas [data-presence="present"]').length,
      activeEdges: document.querySelectorAll('#live-canvas .live-edge[data-active="true"]').length,
      particles: document.querySelectorAll('#live-canvas .live-flow-dot, #live-canvas animateMotion').length,
      projectLive: document.querySelectorAll('#live-project-list [data-live="true"]').length,
      auraAnimation: getComputedStyle(document.querySelector('#live-canvas .node-aura')).animationName,
      followHidden: document.getElementById('live-transcript-follow').hidden,
      heading: document.getElementById('observability-title').textContent,
      connection: document.getElementById('live-state-text').textContent,
    }));
    check('History is neutral and inert even when retained records once said running',
      historyMotion.working === 0 && historyMotion.present === 0
        && historyMotion.activeEdges === 0 && historyMotion.particles === 0
        && historyMotion.projectLive === 0 && historyMotion.auraAnimation === 'none'
        && historyMotion.followHidden && /history/i.test(historyMotion.heading)
        && !/following agent activity/i.test(historyMotion.connection),
      `History leaked live presentation ${JSON.stringify(historyMotion)}`);
    const reviewToolsAtEnd = await page.locator('#live-tools .live-tool').count();
    await page.fill('#live-playback-range', '0');
    const reviewToolsAtStart = await page.locator('#live-tools .live-tool').count();
    check('seeking deterministically rebuilds the cinematic canvas at the playhead',
      reviewToolsAtEnd === 1 && reviewToolsAtStart === 0,
      `review tools changed ${reviewToolsAtEnd} -> ${reviewToolsAtStart}`);
    const playbackSpeeds = await page.locator('#live-playback-speed option')
      .evaluateAll((options) => options.map((option) => option.value));
    await page.selectOption('#live-playback-speed', '10');
    check('Historical playback offers and applies 5× and 10× review speeds',
      playbackSpeeds.includes('5') && playbackSpeeds.includes('10')
        && await page.evaluate(() => globalThis.AKLive.state.playback.speed) === 10,
      `playback speeds were ${JSON.stringify(playbackSpeeds)}`);
    await page.click('#live-playback-toggle');
    check('review controls expose play state, speed, seek, and resume-live',
      await page.getAttribute('#live-playback-toggle', 'aria-label') === 'Pause session review'
        && await page.locator('#live-playback-speed').isVisible(),
      'playback controls did not enter playing state');
    await page.click('#live-playback-toggle');
    await page.click('[data-live-scope="live"]');
    await page.click('#live-project-list [data-project]');
    await page.click('[data-session="ui-live-session"]');
    await page.waitForSelector('#live-mode[data-mode="live"]');
    check('an active session offers explicit review while it continues live',
      await page.locator('#live-enter-review').isVisible()
        && !(await page.locator('#live-resume-live').isVisible()),
      'active session did not offer Review session');
    await page.click('#live-enter-review');
    await page.waitForSelector('#live-mode[data-mode="review"]');
    check('active-session review exposes an explicit return to the livestream',
      await page.locator('#live-resume-live').isVisible(),
      'Resume live was missing from active review');
    await page.click('#live-resume-live');
    await page.waitForSelector('#live-mode[data-mode="live"]');
    check('Resume live deterministically restores live mode',
      await page.locator('#live-enter-review').isVisible()
        && !(await page.locator('#live-resume-live').isVisible()),
      'mode controls did not return to live');
    await page.waitForTimeout(120); // let the transcript SSE init/reset settle before local render assertions

    // Transcript rendering uses text-only escaping, folds sensitive high-volume
    // record kinds, searches locally, and synchronizes selection with the map.
    const transcriptInit = await page.evaluate(() => {
      globalThis.AKLive.addTranscript({
        reset: true,
        snapshot: { events: [{ eventId: 'nested-init', kind: 'message',
          text: 'nested snapshot event', actor: { id: 'ui-live-session', role: 'assistant' } }] },
      }, true);
      return {
        content: globalThis.AKLive.state.transcript.turns[0]?.content,
        session: globalThis.AKLive.state.transcript.session,
      };
    });
    check('transcript init consumes nested snapshot.events and keeps a canonical session key',
      transcriptInit.content === 'nested snapshot event'
        && transcriptInit.session === 'codex:ui-live-session',
      `transcript init state was ${JSON.stringify(transcriptInit)}`);
    await page.evaluate(() => globalThis.AKLive.addTranscript([
      { id: 't-user', role: 'user', content: 'Please inspect the parser', agentId: 'ui-live-session' },
      { id: 't-agent', role: 'assistant', content: 'Bohr is checking the parser', agentId: 'ui-live-agent' },
      { id: 't-think', role: 'thinking', content: 'private reasoning', agentId: 'ui-live-agent' },
      { id: 't-tool', role: 'tool', toolName: 'Read', content: '<img src=x onerror="globalThis.__liveXss=1">', agentId: 'ui-live-agent' },
      { id: 't-rich-tool', type: 'tool', toolName: 'exec_command', command: 'pnpm test',
        args: { cwd: '/masked/project' }, result: '136 passed', error: 'masked warning',
        agentId: 'ui-live-agent' },
    ], true));
    const transcript = await visibleText(page, '#live-transcript-list');
    check('persistent transcript distinguishes conversation, thinking, and tools',
      /Please inspect/.test(transcript) && /Bohr is checking/.test(transcript)
        && /Show thinking/.test(transcript) && /Show tool/.test(transcript),
      `transcript was ${JSON.stringify(transcript)}`);
    const transcriptOrder = await page.locator('#live-transcript-list .live-turn')
      .evaluateAll((turns) => turns.map((turn) => turn.dataset.turn));
    check('live transcript flows upward with newest evidence first',
      transcriptOrder[0] === 't-rich-tool'
        && transcriptOrder[transcriptOrder.length - 1] === 't-user',
      `transcript order was ${JSON.stringify(transcriptOrder)}`);
    check('transcript content is rendered defensively rather than interpreted as markup',
      await page.locator('#live-transcript-list img').count() === 0
        && await page.evaluate(() => globalThis.__liveXss) !== 1,
      'untrusted transcript markup reached the DOM');
    await page.locator('#live-transcript-list [data-turn="t-rich-tool"] details').click();
    const richTool = await page.locator(
      '#live-transcript-list [data-turn="t-rich-tool"] details',
    ).innerText();
    check('tool transcript preserves masked command, arguments, result, and error data',
      /pnpm test/.test(richTool) && richTool.includes('/masked/project')
        && /136 passed/.test(richTool) && /masked warning/.test(richTool),
      `rich tool record was ${JSON.stringify(richTool)}`);
    await page.fill('#live-transcript-search', 'Bohr');
    check('transcript search filters the current local stream',
      /Bohr is checking/.test(await visibleText(page, '#live-transcript-list'))
        && !/Please inspect/.test(await visibleText(page, '#live-transcript-list')),
      'search did not narrow transcript messages');
    await page.fill('#live-transcript-search', '');
    await page.locator('[data-node="ui-live-agent"]').focus();
    await page.keyboard.press('Enter');
    check('keyboard graph selection focuses the matching agent transcript',
      !/Please inspect/.test(await visibleText(page, '#live-transcript-list'))
        && /Bohr is checking/.test(await visibleText(page, '#live-transcript-list'))
        && await page.locator('#live-transcript-clear-filter').isVisible(),
      'agent selection and transcript filter diverged');
    await page.click('#live-transcript-clear-filter');

    // Camera controls preserve the point under the pointer and stay bounded.
    const camera0 = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    await page.click('#live-zoom-in');
    const cameraIn = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    check('Zoom in changes the map scale and readable percentage',
      cameraIn.k > camera0.k && /%/.test(await visibleText(page, '#live-zoom')),
      `camera ${JSON.stringify(camera0)} -> ${JSON.stringify(cameraIn)}`);
    await page.click('#live-zoom-out');
    check('Zoom out reverses the scale change',
      (await page.evaluate(() => globalThis.AKLive.state.camera.k)) < cameraIn.k,
      'zoom-out did not reduce scale');
    const canvasBox = await page.locator('#live-canvas').boundingBox();
    const cursor = { x: canvasBox.x + canvasBox.width * .72, y: canvasBox.y + canvasBox.height * .38 };
    const wheelInvariant = await page.evaluate(({ x, y }) => {
      const c = document.getElementById('live-canvas').getBoundingClientRect();
      const before = { ...globalThis.AKLive.state.camera };
      const local = { x: x - c.left, y: y - c.top };
      const world = { x: (local.x - before.x) / before.k, y: (local.y - before.y) / before.k };
      document.getElementById('live-canvas').dispatchEvent(new globalThis.WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -220, clientX: x, clientY: y,
      }));
      const after = { ...globalThis.AKLive.state.camera };
      return {
        before, after,
        projected: { x: after.x + world.x * after.k, y: after.y + world.y * after.k },
        local,
      };
    }, cursor);
    check('wheel zoom is centered on the pointer',
      wheelInvariant.after.k > wheelInvariant.before.k
        && Math.abs(wheelInvariant.projected.x - wheelInvariant.local.x) < .5
        && Math.abs(wheelInvariant.projected.y - wheelInvariant.local.y) < .5,
      `wheel invariant was ${JSON.stringify(wheelInvariant)}`);
    const clamps = await page.evaluate(() => {
      const c = document.getElementById('live-canvas'), r = c.getBoundingClientRect();
      for (let i = 0; i < 80; i++) c.dispatchEvent(new globalThis.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1000, clientX: r.left + 10, clientY: r.top + 10 }));
      const max = globalThis.AKLive.state.camera.k;
      for (let i = 0; i < 160; i++) c.dispatchEvent(new globalThis.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1000, clientX: r.left + 10, clientY: r.top + 10 }));
      return { max, min: globalThis.AKLive.state.camera.k };
    });
    check('wheel zoom clamps to safe minimum and maximum scales',
      clamps.max === 2.8 && clamps.min === .25, `clamps were ${JSON.stringify(clamps)}`);

    const panBefore = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    await page.mouse.move(canvasBox.x + 18, canvasBox.y + 18);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 83, canvasBox.y + 61, { steps: 4 });
    await page.mouse.up();
    const panAfter = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    check('dragging anywhere on empty canvas pans the execution map',
      Math.abs(panAfter.x - panBefore.x - 65) < 1
        && Math.abs(panAfter.y - panBefore.y - 43) < 1,
      `pan ${JSON.stringify(panBefore)} -> ${JSON.stringify(panAfter)}`);
    check('canvas overlays do not intercept pan gestures',
      await page.evaluate(() => getComputedStyle(document.getElementById('live-empty')).pointerEvents)
        === 'none',
      'empty-state overlay intercepted the draggable canvas');

    const nodeBox = await page.locator('[data-node="ui-live-agent"]').boundingBox();
    const dragBefore = await page.evaluate(() => ({
      transform: document.querySelector('[data-node="ui-live-agent"]').getAttribute('transform'),
      edge: document.querySelector('[data-target="ui-live-agent"]').getAttribute('d'),
    }));
    await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 70, nodeBox.y + nodeBox.height / 2 + 45, { steps: 5 });
    await page.mouse.up();
    const dragAfter = await page.evaluate(() => ({
      transform: document.querySelector('[data-node="ui-live-agent"]').getAttribute('transform'),
      edge: document.querySelector('[data-target="ui-live-agent"]').getAttribute('d'),
    }));
    check('dragging a node updates both its position and connected edge',
      dragAfter.transform !== dragBefore.transform && dragAfter.edge !== dragBefore.edge,
      `drag ${JSON.stringify(dragBefore)} -> ${JSON.stringify(dragAfter)}`);
    check('dragging an agent pins it in the visual model',
      await page.getAttribute('[data-node="ui-live-agent"]', 'data-pinned') === 'true',
      'dragged node was not pinned');
    const toolBox = await page.locator('[data-node="ui-live-tool"]').boundingBox();
    const toolBefore = await page.getAttribute('[data-node="ui-live-tool"]', 'transform');
    await page.mouse.move(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(toolBox.x + toolBox.width / 2 + 44, toolBox.y + toolBox.height / 2 + 30,
      { steps: 4 });
    await page.mouse.up();
    check('individual tool cards are draggable and pinned like actors',
      await page.getAttribute('[data-node="ui-live-tool"]', 'transform') !== toolBefore
        && await page.getAttribute('[data-node="ui-live-tool"]', 'data-pinned') === 'true',
      'tool card did not move into a pinned position');
    const cameraBeforeDelta = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    await page.evaluate(() => globalThis.AKLive.receive('delta', {
      eventId: 'live:position-persist', sessionId: 'ui-live-session',
      observedAt: new Date().toISOString(), host: 'codex', surface: 'native',
      action: 'agent.output', status: 'running',
      actor: { id: 'ui-live-agent', kind: 'subagent', label: 'Bohr', role: 'tester' },
      source: { confidence: 'observed' },
    }));
    check('manual node position persists across live updates',
      await page.getAttribute('[data-node="ui-live-agent"]', 'transform') === dragAfter.transform,
      'node snapped back after a delta');
    check('live deltas preserve the user camera',
      await page.evaluate((before) => {
        const after = globalThis.AKLive.state.camera;
        return after.x === before.x && after.y === before.y && after.k === before.k;
      }, cameraBeforeDelta),
      `camera changed from ${JSON.stringify(cameraBeforeDelta)} to ${
        JSON.stringify(await page.evaluate(() => globalThis.AKLive.state.camera))}`);
    await page.evaluate(() => globalThis.AKLive.receive('delta', {
      eventId: 'claude:same-native-id', sessionId: 'ui-live-session',
      sessionKey: 'claude:ui-live-session', project: 'agentic-kit',
      projectKey: 'project:agentic-kit', observedAt: new Date().toISOString(),
      host: 'claude', action: 'session.started', status: 'running',
      actor: { id: 'claude-session-node', kind: 'session' },
      source: { confidence: 'observed' },
    }));
    check('provider-qualified keys keep identical native session IDs isolated',
      await page.evaluate(() => {
        const sessions = globalThis.AKLive.state.snapshot.sessions;
        const codex = sessions.find((s) => s.key === 'codex:ui-live-session');
        const claude = sessions.find((s) => s.key === 'claude:ui-live-session');
        return !!codex && !!claude
          && !codex.nodes.some((node) => node.id === 'claude-session-node')
          && claude.nodes.some((node) => node.id === 'claude-session-node');
      }),
      'a Claude delta mutated the Codex session with the same native ID');
    await page.click('#live-reset-layout');
    check('Reset layout clears manual pins and restores automatic coordinates',
      await page.getAttribute('[data-node="ui-live-agent"]', 'data-pinned') === 'false'
        && await page.getAttribute('[data-node="ui-live-agent"]', 'transform') !== dragAfter.transform,
      'manual layout survived reset');
    await page.click('#live-fit');
    const fitted = await page.evaluate(() => ({ ...globalThis.AKLive.state.camera }));
    check('Fit computes a finite bounded camera for the current graph',
      Number.isFinite(fitted.x) && Number.isFinite(fitted.y)
        && fitted.k >= .25 && fitted.k <= 2.5 && fitted.k !== 1,
      `fit camera was ${JSON.stringify(fitted)}`);

    await page.setViewportSize({ width: 680, height: 820 });
    const responsive = await page.evaluate(() => {
      const workspace = getComputedStyle(document.querySelector('.live-workspace'));
      return { columns: workspace.gridTemplateColumns, canvasHeight: document.getElementById('live-canvas').clientHeight };
    });
    check('mobile layout stacks map and transcript with a usable canvas',
      responsive.columns.split(' ').length === 1 && responsive.canvasHeight > 300,
      `responsive styles were ${JSON.stringify(responsive)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#live-pause');
    check('Pause Live exposes its pressed state',
      await page.getAttribute('#live-pause', 'aria-pressed') === 'true',
      'aria-pressed did not become true');
    const stableBefore = await page.getAttribute('[data-node="ui-live-session"]', 'transform');
    await page.evaluate(() => globalThis.AKLive.receive('delta', {
      schemaVersion: 1, eventId: 'live:4', sessionId: 'ui-live-session',
      observedAt: new Date().toISOString(), host: 'codex', surface: 'ruflo',
      action: 'agent.spawned', status: 'running',
      actor: { id: 'ui-live-new', kind: 'subagent', role: 'reviewer' },
      target: null, source: { confidence: 'correlated' },
    }));
    check('Pause Live freezes queued topology changes',
      await page.locator('[data-node="ui-live-new"]').count() === 0,
      'queued node rendered while paused');
    await page.click('#live-pause');
    await page.waitForSelector('[data-node="ui-live-new"]');
    check('resume applies every queued topology change',
      await page.locator('[data-node="ui-live-new"]').count() === 1,
      'queued node did not render on resume');
    check('existing nodes retain stable coordinates when topology grows',
      await page.getAttribute('[data-node="ui-live-session"]', 'transform') === stableBefore,
      'existing node position changed');

    const emptyLive = await page.evaluate(() => {
      globalThis.__akSnapshotBeforeEmptyLive = structuredClone(globalThis.AKLive.state.snapshot);
      globalThis.AKLive.state.snapshot.sessions = globalThis.AKLive.state.snapshot.sessions.map((session) => ({
        ...session,
        status: session.status === 'failed' ? 'failed' : 'completed',
        lifecycle: 'historical',
        presence: { ...(session.presence || {}), state: 'absent' },
        activity: { ...(session.activity || {}), state: 'idle', currentOperationId: null },
      }));
      globalThis.AKLive.state.scope = 'live';
      globalThis.AKLive.state.project = null;
      globalThis.AKLive.state.selected = null;
      globalThis.AKLive.state.browserLevel = 'projects';
      globalThis.AKLive.render();
      return {
        projects: document.querySelectorAll('#live-project-list [data-project]').length,
        sessions: document.querySelectorAll('#live-session-list [data-session]').length,
        count: document.getElementById('live-project-count').textContent,
        summary: document.getElementById('live-view-summary').textContent,
      };
    });
    check('empty Live remains empty instead of borrowing recent History',
      emptyLive.projects === 0 && emptyLive.sessions === 0 && emptyLive.count === '0'
        && /No live sessions across 0 projects/.test(emptyLive.summary),
      `empty Live rendered ${JSON.stringify(emptyLive)}`);
    await page.click('[data-live-scope="history"]');
    check('the same retained sessions remain available only through History',
      await page.locator('#live-project-list [data-project]').count() > 0,
      'History did not reveal retained projects after empty Live');
    await page.evaluate(() => {
      globalThis.AKLive.state.snapshot = globalThis.__akSnapshotBeforeEmptyLive;
      delete globalThis.__akSnapshotBeforeEmptyLive;
      globalThis.AKLive.state.scope = 'live';
      globalThis.AKLive.state.project = null;
      globalThis.AKLive.state.selected = null;
      document.querySelectorAll('[data-live-scope]').forEach((item) => {
        item.setAttribute('aria-selected', String(item.dataset.liveScope === 'live'));
      });
      globalThis.AKLive.render();
    });

    await page.click('[data-tab="usage"]');
    check('leaving Live tears down graph and transcript EventSources',
      await page.evaluate(() => globalThis.AKLive.state.source === null
        && globalThis.AKLive.state.transcript.source === null
        && globalThis.AKLive.state.active === false),
      'a live source remained active');
    await page.click('[data-tab="observability"]');
    await page.waitForTimeout(250);
    check('returning to Live creates exactly one active stream',
      await page.evaluate(() => !!globalThis.AKLive.state.source && globalThis.AKLive.state.active === true),
      'live source did not reconnect');
    // ── every Usage sub-view ──
    await page.click('[data-tab="usage"]');
    await page.waitForTimeout(800);
    check('model inventory stays network-lazy until its tab opens', modelRequests.length === 0,
      `Models made ${modelRequests.length} request(s) before its tab opened: ${modelRequests.join(', ')}`);
    check('hook audit stays network-lazy until its tab opens', hookRequests.length === 0,
      `Hooks made ${hookRequests.length} request(s) before its tab opened: ${hookRequests.join(', ')}`);
    const usageSubmenu = await page.evaluate(() => [...document.querySelectorAll('#usage-seg [data-view]')]
      .map((button) => button.dataset.view));
    // Prompts sits between Findings and Sessions (spec §3 rail placement), so
    // the shipped order gained an entry. Models-before-Sessions — the ordering
    // decision this check was written to defend — is unchanged and still
    // asserted, alongside the full order so a future insertion is deliberate.
    check('Usage submenu puts Context and Hooks between Prompts and Models',
      JSON.stringify(usageSubmenu) === JSON.stringify(['score', 'limits', 'findings', 'prompts', 'context', 'hooks', 'models', 'sessions']),
      `Usage submenu was ${JSON.stringify(usageSubmenu)}`);
    const transcriptIndicatorAtRest = await page.evaluate(() => {
      const indicator = document.getElementById('usage-transcript-indicator');
      return {
        hidden: indicator?.hidden, tag: indicator?.tagName,
        dataView: indicator?.getAttribute('data-view'), role: indicator?.getAttribute('role'),
      };
    });
    check('Transcript is absent from navigation until a session is open',
      transcriptIndicatorAtRest.hidden === true && transcriptIndicatorAtRest.tag === 'SPAN'
        && transcriptIndicatorAtRest.dataView === null && transcriptIndicatorAtRest.role === null,
      `Transcript indicator at rest was ${JSON.stringify(transcriptIndicatorAtRest)}`);
    const modelPanelOwnership = await page.evaluate(() => [
      '#mli-observed-panel', '.mli-routes-panel', '#mli-catalog-explorer', '#mli-history', '#mli-consumers', '#mli-impact',
    ].map((selector) => ({ selector, owner: document.querySelector(selector)?.closest('.view')?.id ?? null })));
    check('every Models-only panel is structurally owned by the Models view',
      modelPanelOwnership.every(({ owner }) => owner === 'v-models'),
      `Models panel ownership was ${JSON.stringify(modelPanelOwnership)}`);
    for (const [view, sel] of USAGE_VIEWS) {
      await page.click(`[data-view="${view}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const text = await visibleText(page, sel);
      await shoot(page, `usage-${view}`);

      check(`usage/${view} renders`, text.trim().length > 10, 'view was effectively empty');
      const heading = await page.evaluate(() => ({
        title: document.getElementById('usage-view-title')?.textContent?.trim(),
        description: document.getElementById('usage-view-description')?.textContent?.trim(),
      }));
      check(`usage/${view} has a stable heading and light description`,
        heading.title?.length > 3 && heading.description?.length > 12,
        `heading was ${JSON.stringify(heading)}`);
      const arts = artifactsIn(text);
      check(`usage/${view} is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} — this is the class of bug unit tests cannot see`);
      if (view === 'limits') {
        // Truncation is what hid one pool being reported under two lanes: both
        // rows ellipsised to the same plausible prefix. Measure the RENDERED
        // row — a grid template that looks right in the stylesheet is not proof
        // the string fits. Bars must also share an x, or the panel stops
        // reading as a stack of comparable meters.
        const rows = await page.evaluate(() => ({
          labels: [...document.querySelectorAll('#u-lim-codex .mname, #u-lim-claude .mname')]
            .map((el) => ({ text: el.textContent, title: el.getAttribute('title'), clipped: el.scrollWidth > el.clientWidth })),
          barLefts: [...new Set([...document.querySelectorAll('#u-lim-codex .mbar')]
            .map((el) => Math.round(el.getBoundingClientRect().left)))],
        }));
        check('a Codex pool label renders in full at desktop width',
          rows.labels.length > 0 && rows.labels.every((l) => !l.clipped),
          `clipped: ${JSON.stringify(rows.labels.filter((l) => l.clipped))}`);
        check('every limits label carries its full text as a tooltip',
          rows.labels.every((l) => l.title === l.text),
          `labels were ${JSON.stringify(rows.labels)}`);
        check('limits meters all start at the same x',
          rows.barLefts.length === 1, `bar left edges were ${JSON.stringify(rows.barLefts)}`);
      }
      if (view === 'prompts') {
        const hostHelp = await page.evaluate(() => {
          const copy = document.getElementById('u-pr-hosts-copy');
          return {
            text: copy?.textContent?.replace(/\s+/g, ' ').trim(),
            visible: !!copy && copy.getClientRects().length > 0,
            tag: copy?.tagName, tabIndex: copy?.getAttribute('tabindex'),
            iconCount: document.querySelectorAll('.pr-infodot,.pr-tip').length,
          };
        });
        check('Host interplay uses visible explanatory copy instead of icon-only help',
          hostHelp.visible && hostHelp.tag === 'P' && hostHelp.tabIndex === null && hostHelp.iconCount === 0
            && /Tap share.*p90 length.*role openers.*Compare each host with itself/i.test(hostHelp.text),
          `Host interplay help was ${JSON.stringify(hostHelp)}`);
      }
      if (view === 'context') {
        const contextView = await page.evaluate(() => ({
          policy: document.getElementById('u-ctx-policy')?.textContent,
          states: [...document.querySelectorAll('#u-ctx-hosts .ctx-state')].map((node) => node.textContent),
          meters: [...document.querySelectorAll('#u-ctx-hosts [role="meter"]')].map((node) => ({
            text: node.textContent.trim(), now: node.getAttribute('aria-valuenow'),
            min: node.getAttribute('aria-valuemin'), max: node.getAttribute('aria-valuemax'),
          })),
          groups: [...document.querySelectorAll('#u-ctx-attention details')].map((node) => ({
            summary: node.querySelector('.ctx-att-project')?.textContent?.trim(), open: node.open,
            chevrons: node.querySelectorAll(':scope > summary > .ctx-att-chevron').length,
            firstChild: node.querySelector('summary')?.firstElementChild?.className,
          })),
          headers: [...document.querySelectorAll('#u-ctx-attention thead th')].map((node) => node.textContent.trim()),
          tableRegions: [...document.querySelectorAll('#u-ctx-attention .ctx-att-table-wrap')].map((node) => ({
            tabIndex: node.getAttribute('tabindex'), role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
          })),
        }));
        check('Context shows the canonical 5/7/10, 60/70/75, and 25 percent policy',
          /5%.*7%.*10%/.test(contextView.policy) && /60%.*70%.*75%/.test(contextView.policy)
            && /25%/.test(contextView.policy),
          `Context policy was ${JSON.stringify(contextView.policy)}`);
        check('Context exposes one evidence state and one semantic meter per supported host',
          contextView.states.length === 3 && contextView.meters.length === 3,
          `Context evidence was ${JSON.stringify(contextView)}`);
        check('unknown Context meters omit aria-valuenow while observed meters include it',
          contextView.meters.every((meter) => meter.min === '0' && meter.max === '100'
            && (/unknown/i.test(meter.text) ? meter.now === null : meter.now !== null)),
          `Context meters were ${JSON.stringify(contextView.meters)}`);
        check('Context normalizes repeated project occurrences into collapsed project rows',
          contextView.groups.length === 2 && contextView.groups[0].summary === 'proj'
            && contextView.groups.every((group) => group.open === false),
          `Context groups were ${JSON.stringify(contextView.groups)}`);
        check('every Context project row has an explicit disclosure chevron and no summary metrics',
          contextView.groups.every((group) => group.chevrons === 1
            && /chev ctx-att-chevron/.test(group.firstChild)
            && !/sessions? shown|peak/i.test(group.summary)),
          `Context group affordances were ${JSON.stringify(contextView.groups)}`);
        check('Context session tables are labelled keyboard-focusable scroll regions',
          contextView.tableRegions.every((region) => region.tabIndex === '0' && region.role === 'region'
            && /Sessions needing attention for project/.test(region.label)),
          `Context table regions were ${JSON.stringify(contextView.tableRegions)}`);
        check('Context measurements sit under explicit semantic column headers',
          JSON.stringify(contextView.headers.slice(0, 8)) === JSON.stringify([
            'Conversation', 'Session', 'Host', 'Recommended action', 'Peak pressure', 'Peak input', 'Context window', 'Started',
          ]), `Context headers were ${JSON.stringify(contextView.headers)}`);
        const contextSummary = page.locator('#u-ctx-attention details').first().locator('summary');
        await contextSummary.focus();
        await page.keyboard.press('Enter');
        check('Enter opens a focused Context project disclosure',
          await page.locator('#u-ctx-attention details').first().evaluate((node) => node.open),
          'Context disclosure did not open with Enter');
        await page.keyboard.press('Space');
        check('Space closes a focused Context project disclosure',
          !(await page.locator('#u-ctx-attention details').first().evaluate((node) => node.open)),
          'Context disclosure did not close with Space');
        await contextSummary.click();
        const contextRows = await page.evaluate(() => ({
          rows: [...document.querySelectorAll('#u-ctx-attention details:first-child tbody tr')].map((row) =>
            [...row.children].map((cell) => cell.textContent.trim())),
          href: document.querySelector('#u-ctx-attention details:first-child .ctx-session-link')?.getAttribute('href'),
          rawHandoff: document.getElementById('u-ctx-attention')?.textContent?.includes('handoff'),
        }));
        check('expanded Context sessions expose aligned values and actionable wording',
          contextRows.rows.length === 2 && contextRows.rows[0][0] === 'Context audit'
            && contextRows.rows[1][0] === 'Performance review'
            && contextRows.rows[0][3] === 'Start a new session'
            && contextRows.rows[0][4] === '98.6%' && contextRows.rows[0][5] === '255K'
            && contextRows.rows[0][6] === '258K' && contextRows.rawHandoff === false,
          `Context rows were ${JSON.stringify(contextRows)}`);
        check('Context session references are real deep links',
          contextRows.href === '#usage/aaaa1111', `Context href was ${JSON.stringify(contextRows.href)}`);
        await page.locator('#u-ctx-attention details:first-child .ctx-session-link').first().click();
        await page.waitForSelector('#v-transcript:not([hidden])');
        const transcriptIndicatorOpen = await page.evaluate(() => {
          const indicator = document.getElementById('usage-transcript-indicator');
          return {
            visible: !!indicator && !indicator.hidden && indicator.getClientRects().length > 0,
            current: indicator?.getAttribute('aria-current'), dataView: indicator?.getAttribute('data-view'),
            transcriptTabs: document.querySelectorAll('#usage-seg [data-view="transcript"]').length,
          };
        });
        check('a Context session reference opens the reported transcript',
          await page.evaluate(() => location.hash) === '#usage/aaaa1111'
            && /Add rate limiting to the API/.test(await visibleText(page, '#v-transcript')),
          `Context link navigated to ${await page.evaluate(() => location.hash)}`);
        check('Transcript appears only as a non-interactive current-view indicator',
          transcriptIndicatorOpen.visible && transcriptIndicatorOpen.current === 'page'
            && transcriptIndicatorOpen.dataView === null && transcriptIndicatorOpen.transcriptTabs === 0,
          `Transcript indicator was ${JSON.stringify(transcriptIndicatorOpen)}`);
        await page.click('[data-view="context"]');
      }
      if (view === 'hooks') {
        const hookView = await page.evaluate(() => ({
          text: document.getElementById('v-hooks')?.textContent,
          stopParent: document.getElementById('u-hook-stop')?.closest('.strip')?.querySelector('h2')?.textContent,
          runtimeParent: document.getElementById('u-hook-runtime')?.closest('.strip')?.querySelector('h2')?.textContent,
          definitionHeaders: [...document.querySelectorAll('#u-hook-stop thead th')].map((node) => node.textContent.trim()),
          findingHeaders: [...(document.querySelector('#u-hook-diagnostics .hook-finding-group thead')
            ?.querySelectorAll('th') ?? [])].map((node) => node.textContent.trim()),
          findingGroups: [...document.querySelectorAll('#u-hook-diagnostics .hook-finding-group')].map((node) => ({
            open: node.open, importance: node.dataset.hookFindingImportance,
            chevrons: node.querySelectorAll('.hook-finding-chevron').length,
            summary: node.querySelector('summary')?.textContent?.trim(),
          })),
          findingFilters: [...document.querySelectorAll('#u-hook-diagnostics [data-hook-importance]')]
            .map((node) => ({ value: node.dataset.hookImportance, pressed: node.getAttribute('aria-pressed') })),
          observations: document.querySelector('#u-hook-diagnostics .hook-observations')?.textContent,
          definitionViewport: (() => {
            const wrap = document.querySelector('#u-hook-stop .hook-definition-wrap');
            const rows = [...document.querySelectorAll('#u-hook-stop tbody > tr')];
            const header = document.querySelector('#u-hook-stop thead');
            return {
              clientHeight: wrap?.clientHeight, scrollHeight: wrap?.scrollHeight,
              rowCount: rows.length, rowHeight: rows[0]?.getBoundingClientRect().height,
              headerHeight: header?.getBoundingClientRect().height,
              tabIndex: wrap?.getAttribute('tabindex'),
              collapsed: rows.every((row) => !row.querySelector('details')?.open),
            };
          })(),
          evidencePanel: [...document.querySelectorAll('#v-hooks h2')]
            .some((heading) => heading.textContent.trim() === 'Evidence limits'),
          busy: document.getElementById('v-hooks')?.getAttribute('aria-busy'),
        }));
        check('Hooks fetches exactly once when first opened and settles its live status',
          hookRequests.length === 1 && hookView.busy === 'false',
          `Hook requests/state were ${JSON.stringify({ hookRequests, hookView })}`);
        check('Hooks separates definitions, findings, and runtime outcomes in user-facing language',
          hookView.stopParent === 'Hook definitions' && hookView.runtimeParent === 'Runtime outcomes'
            && /Hook may resolve a package when it runs/.test(hookView.text) && /1 retained receipt/.test(hookView.text),
          `Hooks content was ${JSON.stringify(hookView)}`);
        check('Hooks measurements sit under explicit semantic column headers',
          JSON.stringify(hookView.definitionHeaders) === JSON.stringify([
            'Lifecycle point', 'Definition', 'Host', 'Configured in', 'Placements', 'Findings',
          ]) && JSON.stringify(hookView.findingHeaders) === JSON.stringify([
            'Lifecycle point', 'Host', 'Configured in', 'Evidence', 'Action',
          ]), `Hook headers were ${JSON.stringify(hookView)}`);
        check('Hook findings group repeated placements with explicit disclosure affordances',
          hookView.findingGroups.length === 2 && hookView.findingGroups.every((group) => !group.open && group.chevrons === 1)
            && /2 affected definitions/.test(hookView.findingGroups[0].summary),
          `Hook finding groups were ${JSON.stringify(hookView.findingGroups)}`);
        check('Hook importance is a filter and informational evidence is separated from actions',
          JSON.stringify(hookView.findingFilters) === JSON.stringify([
            { value: 'all', pressed: 'true' }, { value: 'warning', pressed: 'false' }, { value: 'review', pressed: 'false' },
          ]) && /Observations, not actions/.test(hookView.observations),
          `Hook filters/observations were ${JSON.stringify({ filters: hookView.findingFilters, observations: hookView.observations })}`);
        const hookFindingSummary = page.locator('#u-hook-diagnostics .hook-finding-group').first().locator('summary');
        await hookFindingSummary.focus();
        await page.keyboard.press('Enter');
        check('Enter opens a focused Hook finding disclosure',
          await page.locator('#u-hook-diagnostics .hook-finding-group').first().evaluate((node) => node.open),
          'Hook finding disclosure did not open with Enter');
        await page.click('#u-hook-diagnostics [data-hook-importance="review"]');
        const filteredHookFindings = await page.evaluate(() => ({
          visible: [...document.querySelectorAll('#u-hook-diagnostics .hook-finding-group')]
            .filter((node) => !node.hidden).map((node) => node.dataset.hookFindingImportance),
          warningOpen: document.querySelector('#u-hook-diagnostics .hook-finding-group[data-hook-finding-importance="warning"]')?.open,
          status: document.querySelector('#u-hook-diagnostics .hook-finding-filter-status')?.textContent,
        }));
        check('Hook importance filtering preserves disclosure state and announces the result count',
          JSON.stringify(filteredHookFindings.visible) === JSON.stringify(['review'])
            && filteredHookFindings.warningOpen === true && /Showing 1 review finding\./.test(filteredHookFindings.status),
          `Filtered Hook findings were ${JSON.stringify(filteredHookFindings)}`);
        await page.click('#u-hook-diagnostics [data-hook-importance="all"]');
        const visibleDefinitionRows = (hookView.definitionViewport.clientHeight
          - hookView.definitionViewport.headerHeight) / hookView.definitionViewport.rowHeight;
        check('Hook definitions shows five collapsed rows in a keyboard-scrollable viewport',
          hookView.definitionViewport.rowCount === 7 && hookView.definitionViewport.collapsed
            && hookView.definitionViewport.tabIndex === '0'
            && hookView.definitionViewport.scrollHeight > hookView.definitionViewport.clientHeight
            && visibleDefinitionRows >= 4.8 && visibleDefinitionRows <= 5.2,
          `Hook definition viewport was ${JSON.stringify({ ...hookView.definitionViewport, visibleDefinitionRows })}`);
        check('Hooks keeps evidence limits beside affected measurements instead of a filler panel',
          hookView.evidencePanel === false && !/Evidence limits/.test(hookView.text),
          `Hooks evidence panel state was ${JSON.stringify(hookView)}`);
        await page.locator('#u-hook-stop .hook-definition-wrap').evaluate((node) => { node.scrollTop = 80; });
        const hookHeaderSticky = await page.evaluate(() => {
          const wrap = document.querySelector('#u-hook-stop .hook-definition-wrap');
          const header = document.querySelector('#u-hook-stop thead th');
          if (!wrap || !header) return null;
          return Math.abs(header.getBoundingClientRect().top - wrap.getBoundingClientRect().top) <= 1;
        });
        check('Hook definition headers stay visible while its internal viewport scrolls',
          hookHeaderSticky === true, `Hook sticky header state was ${hookHeaderSticky}`);
        check('Hooks does not turn an upstream classification into a fabricated call to action',
          /No evidence-backed action/.test(hookView.text) && !/Preview repair/.test(hookView.text),
          `Hooks action text was ${JSON.stringify(hookView.text)}`);
        check('Hooks never renders raw commands, paths, output, or diagnostic prose',
          !hookView.text.includes(HOOKS_SECRET), 'sanitized Hook delivery leaked its sentinel secret');
        const stopDefinitionRow = page.locator('#u-hook-stop tbody > tr').filter({ hasText: 'Stop' }).first();
        await stopDefinitionRow.locator('details summary').click();
        await stopDefinitionRow.locator('[data-hook-source]').click();
        await page.waitForFunction(() => document.querySelector('#u-hook-source-detail pre'));
        const sourceView = await page.evaluate(() => ({
          open: document.getElementById('u-hook-source-dialog')?.open,
          text: document.getElementById('u-hook-source-dialog')?.textContent,
          path: document.querySelector('#u-hook-source-detail .hook-source-facts code')?.textContent,
        }));
        check('Hooks opens the explicitly requested audited physical source in a read-only dialog',
          sourceView.open === true && sourceView.path === hookSourceFile
            && /Masked JSON definition/.test(sourceView.text) && !sourceView.text.includes('ui-secret-value'),
          `Hook source dialog was ${JSON.stringify(sourceView)}`);
        await page.locator('#u-hook-source-close').click();
      }
      if (view !== 'models') {
        const modelBoundary = await page.evaluate(() => {
          const models = document.getElementById('v-models');
          const active = document.getElementById(`v-${document.querySelector('#usage-seg [aria-selected="true"]')?.dataset.view}`);
          return {
            modelsHidden: models?.hidden === true,
            modelsDisplay: models ? getComputedStyle(models).display : null,
            modelsDisplayPriority: models?.style.getPropertyPriority('display'),
            modelsInert: models?.hasAttribute('inert') === true,
            modelPanelsInActiveView: active?.querySelectorAll('[id^="mli-"]').length ?? null,
            modelOnlyPanelsVisible: [...document.querySelectorAll(
              '#mli-observed-panel, .mli-routes-panel, #mli-catalog-explorer, #mli-history, #mli-consumers, #mli-impact',
            )].filter((node) => node.getClientRects().length > 0).length,
          };
        });
        check(`usage/${view} excludes Model lifecycle panels`,
          modelBoundary.modelsHidden && modelBoundary.modelsDisplay === 'none'
            && modelBoundary.modelsDisplayPriority === 'important' && modelBoundary.modelsInert
            && modelBoundary.modelPanelsInActiveView === 0 && modelBoundary.modelOnlyPanelsVisible === 0,
          `model boundary was ${JSON.stringify(modelBoundary)}`);
      }
    }

    // ── Models privacy, evidence disclosure, keyboard and narrow layout ──
    await page.click('[data-view="models"]');
    await page.waitForFunction(() => document.getElementById('mli-load-status')?.textContent?.includes('loaded'));
    check('Models loads summary before its first bounded inventory page',
      modelRequests.length >= 2
        && new URL(modelRequests[0]).searchParams.get('view') === 'summary'
        && new URL(modelRequests[0]).searchParams.get('days') === '14'
        && new URL(modelRequests[1]).searchParams.get('view') === 'inventory'
        && new URL(modelRequests[1]).searchParams.get('offset') === '0'
        && new URL(modelRequests[1]).searchParams.get('limit') === '50'
        && new URL(modelRequests[1]).searchParams.get('snapshotId') === modelSnapshotId
        && new URL(modelRequests[1]).searchParams.get('relevance') === 'relevant',
      `Models requests were ${JSON.stringify(modelRequests)}`);
    check('Models keeps the shared 7/14/30-day selector visible',
      await page.locator('#usage-days').isVisible(),
      'Models hid the window selector used by its observed-use evidence');
    check('Models renders aggregate observed-use evidence for the selected window',
      /^14 days · \d+ models?$/.test((await page.locator('#mli-observed-note').innerText()).trim())
        && await page.locator('#mli-observed tr').count() > 0,
      `observed note was ${JSON.stringify(await page.locator('#mli-observed-note').innerText())}`);
    const beforeThirtyDayModels = modelRequests.length;
    await page.click('#usage-days [data-days="30"]');
    await page.waitForFunction(() => document.getElementById('mli-observed-note')?.textContent?.startsWith('30 days'));
    check('changing the Models window refetches its observed-use summary only for that window',
      modelRequests.slice(beforeThirtyDayModels).some((url) => {
        const parsed = new URL(url);
        return parsed.searchParams.get('view') === 'summary' && parsed.searchParams.get('days') === '30';
      }), `Models requests were ${JSON.stringify(modelRequests.slice(beforeThirtyDayModels))}`);
    await page.click('#usage-days [data-days="14"]');
    await page.waitForFunction(() => document.getElementById('mli-observed-note')?.textContent?.startsWith('14 days'));
    const modelView = await visibleText(page, '#v-models');
    check('usage/models shows exact configured model names without opaque identifiers',
      /Your routes/.test(modelView) && /ui-private-deployment/.test(modelView)
        && /ui-private-provider/.test(modelView)
        && !/model-[a-f0-9]{12}|provider-[a-f0-9]{12}|scope-[a-f0-9]{12}/.test(modelView),
      `Models privacy projection was ${JSON.stringify(modelView.slice(0, 400))}`);
    const attentionView = await visibleText(page, '#mli-attention');
    check('Models attention names the route, current model, replacement, action, and cited notice',
      /implementation · primary/.test(attentionView)
        && /UI Private Deployment/.test(attentionView)
        && /ui-private-replacement/.test(attentionView)
        && /ak models plan --activity implementation --to opencode:ui-private-replacement/.test(attentionView)
        && await page.getAttribute('#mli-attention a', 'href') === 'https://developers.openai.com/api/docs/deprecations/',
      `attention panel was ${JSON.stringify(attentionView)}`);
    check('catalog explorer stays collapsed until requested',
      await page.getAttribute('#mli-catalog-explorer', 'open') === null,
      'catalog explorer should not compete with the operating routes');
    const catalogChevron = page.locator('#mli-catalog-explorer > summary .chev');
    check('catalog explorer uses the shared chevron affordance before opening',
      await catalogChevron.textContent() === '›' && await catalogChevron.getAttribute('aria-hidden') === 'true',
      'catalog explorer did not expose the shared directional chevron');
    await page.locator('#mli-catalog-explorer > summary').click();
    await page.waitForTimeout(250);
    check('catalog explorer rotates its chevron when open',
      await page.getAttribute('#mli-catalog-explorer', 'open') !== null
        && await catalogChevron.evaluate((node) => getComputedStyle(node).transform !== 'none'),
      'catalog chevron did not communicate its expanded state');
    const catalogView = await visibleText(page, '#mli-catalog-explorer');
    check('catalog explorer is available without leaking opaque implementation identifiers',
      /Explore catalog/.test(catalogView)
        && /UI Private Deployment/.test(catalogView)
        && !/model-[a-f0-9]{12}|provider-[a-f0-9]{12}|scope-[a-f0-9]{12}/.test(catalogView),
      `Models privacy projection was ${JSON.stringify(modelView.slice(0, 400))}`);
    const consumerPanel = await page.evaluate(() => {
      const panel = document.querySelector('#mli-consumers .mli-consumer-scroll');
      return panel ? { overflowY: getComputedStyle(panel).overflowY, maxHeight: getComputedStyle(panel).maxHeight } : null;
    });
    check('Models consumers are a bounded, scrollable operator panel',
      !!consumerPanel && /(auto|scroll)/.test(consumerPanel.overflowY) && consumerPanel.maxHeight !== 'none',
      `consumer panel was ${JSON.stringify(consumerPanel)}`);
    check('Models consumers contain named routes rather than opaque or unclassified bindings',
      /implementation · primary/.test(await visibleText(page, '#mli-consumers'))
        && !/Configured consumer|activity-[a-f0-9]{12}|binding-[a-f0-9]{12}/.test(await visibleText(page, '#mli-consumers')),
      `consumer panel was ${JSON.stringify((await visibleText(page, '#mli-consumers')).slice(0, 500))}`);
    const historyPanel = await page.evaluate(() => {
      const panel = document.querySelector('#mli-history .mli-history-scroll');
      const table = panel?.querySelector('table');
      return panel ? {
        overflowY: getComputedStyle(panel).overflowY,
        maxHeight: getComputedStyle(panel).maxHeight,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        region: panel.getAttribute('role'),
        label: panel.getAttribute('aria-label'),
        tabindex: panel.getAttribute('tabindex'),
        columns: table?.querySelectorAll('thead th').length ?? 0,
        rows: table?.querySelectorAll('tbody tr').length ?? 0,
      } : null;
    });
    check('Models change history is a bounded, internally scrollable semantic table',
      !!historyPanel && /(auto|scroll)/.test(historyPanel.overflowY)
        && historyPanel.maxHeight !== 'none'
        && historyPanel.scrollHeight > historyPanel.clientHeight
        && historyPanel.region === 'region' && !!historyPanel.label && historyPanel.tabindex === '0'
        && historyPanel.columns === 6 && historyPanel.rows === 12,
      `change history panel was ${JSON.stringify(historyPanel)}`);
    const historyText = await visibleText(page, '#mli-history');
    check('Models change history uses exact human model facts instead of identity hashes or enum labels',
      /Model added/.test(historyText) && /Catalog Model 2/.test(historyText)
        && /ui-private-provider-a/.test(historyText) && /Claude/.test(historyText)
        && /Appeared in the latest inventory/.test(historyText) && /Confirmed/.test(historyText)
        && !/model-added|identity-[a-f0-9]{12}/.test(historyText)
        && /12 changes · 1 retained snapshot/.test(await visibleText(page, '#mli-history-note')),
      `change history was ${JSON.stringify(historyText.slice(0, 700))}`);
    check('Models removes low-value source coverage from the live surface',
      await page.locator('#mli-sources').count() === 0,
      'source coverage should remain documented rather than occupy the operator view');
    check('usage/models has a polite load status and settled busy state',
      await page.getAttribute('#mli-load-status', 'role') === 'status'
        && await page.getAttribute('#mli-load-status', 'aria-live') === 'polite'
        && await page.getAttribute('#v-models', 'aria-busy') === 'false',
      'Models loading state was not exposed to assistive technology');
    const proof = page.locator('#mli-models details.mli-proof').first();
    await proof.locator('summary').click();
    check('usage/models state disclosure names source, class, capture, freshness, and completeness',
      /codex-cache/.test(await visibleText(page, '#mli-models'))
        && /catalog/.test(await visibleText(page, '#mli-models'))
        && /2026-08-25/.test(await visibleText(page, '#mli-models'))
        && /fresh/.test(await visibleText(page, '#mli-models'))
        && /complete/.test(await visibleText(page, '#mli-models'))
        && !/scope-[a-f0-9]{12}/.test(await visibleText(page, '#mli-models')),
      'Expanded state did not disclose its complete evidence chain');
    check('usage/models table is an explicitly labelled keyboard region',
      await page.getAttribute('.mli-table-wrap', 'role') === 'region'
        && !!await page.getAttribute('.mli-table-wrap', 'aria-label')
        && await page.getAttribute('.mli-table-wrap', 'tabindex') === '0',
      'responsive table region lacked keyboard semantics');
    const inventoryControls = await page.evaluate(() => ({
      form: !!document.getElementById('mli-filters'),
      search: document.getElementById('mli-search')?.getAttribute('type'),
      labels: [...document.querySelectorAll('#mli-filters label')].map((node) => node.innerText.trim()),
      reset: document.getElementById('mli-reset')?.textContent?.trim(),
      countRole: document.getElementById('mli-result-count')?.getAttribute('role'),
      countLive: document.getElementById('mli-result-count')?.getAttribute('aria-live'),
      loadMore: document.getElementById('mli-load-more')?.textContent?.trim(),
      evidenceValueDisabled: document.getElementById('mli-evidence-value')?.disabled,
      headerButtons: document.querySelectorAll('.mli-ledger .mli-table thead [data-mli-sort]').length,
      ariaSort: [...document.querySelectorAll('.mli-ledger .mli-table thead th')].map((node) => node.getAttribute('aria-sort')),
    }));
    check('Models exposes labelled search, host, provider, relevance, lifecycle and evidence filters',
      inventoryControls.form && inventoryControls.search === 'search'
        && ['Search', 'Access host', 'Model provider', 'View', 'Lifecycle', 'Evidence state', 'Evidence value']
          .every((label) => inventoryControls.labels.some((actual) => actual.toLowerCase().startsWith(label.toLowerCase()))),
      `inventory controls were ${JSON.stringify(inventoryControls)}`);
    check('Models has Reset, result-status and explicit Load 50 more controls',
      inventoryControls.reset === 'Reset'
        && inventoryControls.countRole === 'status' && inventoryControls.countLive === 'polite'
        && inventoryControls.loadMore === 'Load 50 more' && inventoryControls.evidenceValueDisabled,
      `inventory controls were ${JSON.stringify(inventoryControls)}`);
    check('every Models column header is a sortable button with one semantic sort owner',
      inventoryControls.headerButtons === 5
        && inventoryControls.ariaSort.filter((value) => value && value !== 'none').length === 1,
      `header controls were ${JSON.stringify(inventoryControls)}`);
    const routeSortControls = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('.mli-routes-table [data-mli-route-sort]')]
        .map((button) => button.getAttribute('data-mli-route-sort')),
      active: document.querySelector('.mli-routes-table th[aria-sort="ascending"] [data-mli-route-sort]')?.getAttribute('data-mli-route-sort'),
    }));
    check('every route column is an accessible sortable button with Model ascending by default',
      JSON.stringify(routeSortControls.buttons) === JSON.stringify(['model', 'provider', 'used', 'lastUsed', 'rate'])
        && routeSortControls.active === 'model',
      `route sort controls were ${JSON.stringify(routeSortControls)}`);
    const sortableRouteModel = page.locator('[data-mli-route-sort="model"]');
    await sortableRouteModel.click();
    await page.waitForFunction(() => document.querySelector('[data-mli-route-sort="model"]')?.closest('th')?.getAttribute('aria-sort') === 'descending');
    check('route Model descending reorders rows in the rendered dashboard',
      await page.locator('#mli-routes tr').first().locator('th b').innerText() === 'UI Private Deployment',
      `route rows were ${JSON.stringify(await page.locator('#mli-routes tr th b').allInnerTexts())}`);
    await sortableRouteModel.click();
    await page.waitForFunction(() => document.querySelector('[data-mli-route-sort="model"]')?.closest('th')?.getAttribute('aria-sort') === 'ascending');
    for (const field of ['provider', 'used', 'lastUsed', 'rate']) {
      const control = page.locator(`[data-mli-route-sort="${field}"]`);
      await control.click();
      await page.waitForFunction((name) => document.querySelector(`[data-mli-route-sort="${name}"]`)?.closest('th')?.getAttribute('aria-sort') === 'ascending', field);
      if (field === 'rate') {
        check('route rate ascending uses published input rate and keeps unknown rate last',
          JSON.stringify(await page.locator('#mli-routes tr th b').allInnerTexts())
            === JSON.stringify(['Catalog Model 3', 'Catalog Model 4', 'Catalog Model 2', 'UI Private Deployment']),
          `ascending rate rows were ${JSON.stringify(await page.locator('#mli-routes tr th b').allInnerTexts())}`);
      }
      await control.click();
      await page.waitForFunction((name) => document.querySelector(`[data-mli-route-sort="${name}"]`)?.closest('th')?.getAttribute('aria-sort') === 'descending', field);
    }
    check('route column buttons toggle ascending then descending without reloading the inventory',
      await page.evaluate(() => document.querySelector('.mli-routes-table th[aria-sort="descending"] [data-mli-route-sort]')?.getAttribute('data-mli-route-sort')) === 'rate',
      'route headers did not retain their descending sort state');
    const initialInventory = await page.evaluate(() => ({
      rows: document.querySelectorAll('#mli-models tr').length,
      count: document.getElementById('mli-result-count')?.textContent?.trim(),
      overflowY: getComputedStyle(document.querySelector('.mli-table-wrap')).overflowY,
      maxHeight: getComputedStyle(document.querySelector('.mli-table-wrap')).maxHeight,
      headPosition: getComputedStyle(document.querySelector('.mli-table thead')).position,
    }));
    check('Models renders only its first 50 relevant rows and states the total',
      initialInventory.rows === 50 && /50/.test(initialInventory.count) && /62/.test(initialInventory.count),
      `initial inventory was ${JSON.stringify(initialInventory)}`);
    check('each model identity is the semantic row header for its evidence cells',
      await page.locator('#mli-models tr > th[scope="row"]').count() === 50,
      'model identity cells were not row headers');
    check('host inventory is height-bounded, vertically scrollable and keeps its header sticky',
      initialInventory.overflowY === 'auto' && initialInventory.maxHeight !== 'none'
        && initialInventory.headPosition === 'sticky',
      `inventory geometry styles were ${JSON.stringify(initialInventory)}`);
    await page.fill('#mli-search', 'UI Private Deployment');
    await page.waitForFunction(() => document.querySelectorAll('#mli-models tr').length === 1
      && document.getElementById('mli-result-count')?.textContent !== 'Loading models…');
    await page.click('#mli-models .mli-detail-open');
    const evidenceRows = await page.locator('#mli-detail .mli-proof-row').allInnerTexts();
    check('model details de-duplicate identical evidence summaries without changing field evidence',
      evidenceRows.filter((row) => row.startsWith('usage-index · observed')).length === 1,
      `model detail evidence rows were ${JSON.stringify(evidenceRows)}`);
    await page.click('#mli-detail-close');
    await page.fill('#mli-search', 'Claude Fable 5');
    await page.waitForFunction(() => document.querySelectorAll('#mli-models tr').length === 1
      && /Claude Fable 5/.test(document.querySelector('#mli-models tr')?.textContent || '')
      && document.getElementById('mli-result-count')?.textContent !== 'Loading models…');
    await page.click('#mli-models .mli-detail-open');
    const claudeDetail = await visibleText(page, '#mli-detail');
    check('Claude details separate public facts from account access and give the operator a proof step',
      /Lifecycle scope\s+Anthropic-operated platforms/i.test(claudeDetail)
        && /Published availability\s+general/i.test(claudeDetail)
        && /Published \/ discovered\s+Published by an accepted source/i.test(claudeDetail)
        && /Account access\s+Not established; public metadata is not account access/i.test(claudeDetail)
        && /Local routability\s+Not established on this host\/provider\/account path/i.test(claudeDetail)
        && /What you need to do\s+Complete one successful invocation on this exact path, then run ak models refresh/i.test(claudeDetail)
        && /Context\s+1,000,000/i.test(claudeDetail) && /Output\s+128,000/i.test(claudeDetail),
      `Claude detail was ${JSON.stringify(claudeDetail)}`);
    await page.click('#mli-detail-close');
    await page.click('#mli-reset');
    await page.waitForFunction(() => document.activeElement?.id === 'mli-search'
      && document.querySelectorAll('#mli-models tr').length === 50);
    await page.selectOption('#mli-evidence-field', 'observed');
    await page.waitForFunction(() => !document.getElementById('mli-evidence-value')?.disabled);
    check('evidence filtering enables its dependent value without sending a half-formed query',
      !modelRequests.some((url) => new URL(url).searchParams.has('evidenceField')
        !== new URL(url).searchParams.has('evidenceValue')),
      `Models requests were ${JSON.stringify(modelRequests)}`);
    await page.selectOption('#mli-evidence-value', 'unknown');
    await page.waitForFunction(() => document.getElementById('mli-result-count')?.textContent !== 'Loading models…');
    check('evidence field and value travel together as one filter',
      modelRequests.some((url) => new URL(url).searchParams.get('evidenceField') === 'observed'
        && new URL(url).searchParams.get('evidenceValue') === 'unknown'),
      `Models requests were ${JSON.stringify(modelRequests)}`);
    await page.click('#mli-reset');
    await page.waitForFunction(() => document.activeElement?.id === 'mli-search'
      && document.getElementById('mli-evidence-value')?.disabled);
    const sortableHost = page.locator('[data-mli-sort="host"]');
    await sortableHost.click();
    await page.waitForFunction(() => document.querySelector('[data-mli-sort="host"]')?.closest('th')?.getAttribute('aria-sort') === 'ascending');
    await sortableHost.click();
    await page.waitForFunction(() => document.querySelector('[data-mli-sort="host"]')?.closest('th')?.getAttribute('aria-sort') === 'descending');
    check('column buttons toggle ascending then descending and request server ordering',
      modelRequests.some((url) => new URL(url).searchParams.get('sort') === 'host'
        && new URL(url).searchParams.get('direction') === 'desc'),
      `Models requests were ${JSON.stringify(modelRequests)}`);
    await page.fill('#mli-search', 'deployment');
    await page.waitForTimeout(350);
    check('search resets inventory pagination and travels as a filter parameter',
      modelRequests.some((url) => new URL(url).searchParams.get('search') === 'deployment'
        && new URL(url).searchParams.get('offset') === '0'),
      `Models requests were ${JSON.stringify(modelRequests)}`);
    await page.click('#mli-reset');
    await page.waitForFunction(() => document.activeElement?.id === 'mli-search'
      && document.getElementById('mli-relevance')?.value === 'relevant');
    check('Reset restores the relevance-first filter set and keyboard focus',
      await page.inputValue('#mli-search') === ''
        && await page.inputValue('#mli-relevance') === 'relevant'
        && await page.evaluate(() => document.activeElement?.id) === 'mli-search',
      'Reset did not restore the default filter state or return focus to Search');
    await page.selectOption('#mli-relevance', 'catalog');
    await page.waitForFunction(() => document.getElementById('mli-result-count')?.textContent !== 'Loading models…');
    await page.fill('#mli-search', 'qwen3-coder:30b');
    await page.waitForFunction(() => document.querySelectorAll('#mli-models tr').length === 1
      && document.getElementById('mli-result-count')?.textContent !== 'Loading models…');
    await page.click('#mli-models .mli-detail-open');
    const localDetail = await visibleText(page, '#mli-detail');
    check('Ollama details show human build and runtime metadata rather than opaque hashes',
      /30\.5B · Q4_K_M · gguf/.test(localDetail)
        && /Loaded now\s+Yes/i.test(localDetail)
        && /Context limit\s+32768/i.test(localDetail)
        && !/variant-[a-f0-9]{12}/.test(localDetail),
      `Ollama detail was ${JSON.stringify(localDetail)}`);
    await page.click('#mli-detail-close');
    await page.click('#mli-reset');
    await page.waitForFunction(() => document.querySelectorAll('#mli-models tr').length === 50);
    const replacementSnapshotId = `${modelSnapshotId}-replacement`;
    const replacementSummary = structuredClone(modelSummaryFixture);
    replacementSummary.snapshot.snapshotId = replacementSnapshotId;
    replacementSummary.snapshot.capturedAt = '2026-08-25T14:00:00.000Z';
    replacementSummary.snapshot.sources[0].id = 'replacement-source';
    replacementSummary.history = [{ snapshotId: replacementSnapshotId,
      capturedAt: replacementSummary.snapshot.capturedAt }];
    const replacementInventory = structuredClone(modelInventoryFixture);
    replacementInventory.snapshot.snapshotId = replacementSnapshotId;
    replacementInventory.snapshot.capturedAt = replacementSummary.snapshot.capturedAt;
    replacementInventory.inventory.items = replacementInventory.inventory.items.slice(0, 12);
    replacementInventory.inventory.total = 12;
    replacementInventory.inventory.filteredTotal = 12;
    replacementInventory.inventory.relevantTotal = 12;
    replacementInventory.inventory.offset = 0;
    replacementInventory.inventory.nextOffset = null;
    replacementInventory.inventory.hasMore = false;
    let stalePhase = 'append';
    const stalePageHandler = async (route) => {
      const requestUrl = new URL(route.request().url());
      const view = requestUrl.searchParams.get('view');
      if (stalePhase === 'append' && requestUrl.searchParams.get('offset') === '50') {
        stalePhase = 'summary';
        await route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ error: 'model inventory changed; retry' }) });
      } else if (stalePhase === 'summary' && view === 'summary') {
        stalePhase = 'inventory';
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(replacementSummary) });
      } else if (stalePhase === 'inventory' && view === 'inventory'
        && requestUrl.searchParams.get('offset') === '0') {
        stalePhase = 'done';
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(replacementInventory) });
      } else await route.continue();
    };
    await page.route(/\/api\/models\?/, stalePageHandler);
    const requestsBeforeStalePage = modelRequests.length;
    await page.click('#mli-load-more');
    await page.waitForFunction(() => document.getElementById('mli-load-status')?.textContent?.includes('loaded'));
    const staleRequests = modelRequests.slice(requestsBeforeStalePage);
    const replacementFocus = await page.evaluate(() => ({
      rowHeader: document.activeElement?.matches('#mli-models tr > th[scope="row"]'),
      visible: document.activeElement?.offsetParent !== null,
      text: document.activeElement?.textContent?.trim(),
    }));
    check('a changed snapshot resets pagination instead of mixing inventory pages',
      staleRequests.some((url) => new URL(url).searchParams.get('offset') === '50'
        && new URL(url).searchParams.has('snapshotId'))
        && staleRequests.some((url) => new URL(url).searchParams.get('view') === 'summary')
        && staleRequests.some((url) => new URL(url).searchParams.get('offset') === '0'
          && new URL(url).searchParams.get('snapshotId') === replacementSnapshotId)
        && await page.locator('#mli-models tr').count() === 12,
      `Models requests were ${JSON.stringify(staleRequests)}`);
    check('snapshot recovery focuses a visible replacement row when no next page exists',
      replacementFocus.rowHeader && replacementFocus.visible,
      `replacement focus was ${JSON.stringify(replacementFocus)}`);
    const expectedConflict = consoleErrors.findIndex((message) => /status of 409/.test(message)
      && /\/api\/models\?/.test(message));
    if (expectedConflict >= 0) consoleErrors.splice(expectedConflict, 1);
    await page.unroute(/\/api\/models\?/, stalePageHandler);

    let failPage = true;
    const failPageHandler = async (route) => {
      const requestUrl = new URL(route.request().url());
      if (failPage && requestUrl.searchParams.get('offset') === '50') {
        failPage = false;
        await route.fulfill({ status: 500, contentType: 'application/json',
          body: JSON.stringify({ error: 'temporarily unavailable' }) });
      } else await route.continue();
    };
    await page.route(/\/api\/models\?/, failPageHandler);
    await page.click('#mli-load-more');
    await page.waitForFunction(() => document.getElementById('mli-load-status')?.textContent?.includes('unavailable'));
    check('a failed later page preserves prior rows and leaves an explicit retry',
      await page.locator('#mli-models tr').count() === 50
        && await page.isVisible('#mli-load-more')
        && /Retry/.test(await page.textContent('#mli-load-more')),
      'a failed append discarded rows or hid its retry');
    const expectedFailure = consoleErrors.findIndex((message) => /status of 500/.test(message)
      && /\/api\/models\?/.test(message));
    if (expectedFailure >= 0) consoleErrors.splice(expectedFailure, 1);
    await page.unroute(/\/api\/models\?/, failPageHandler);
    await page.click('#mli-load-more');
    await page.waitForFunction(() => document.querySelectorAll('#mli-models tr').length === 61);
    check('Load 50 more appends the remaining page without replacing the first page',
      await page.locator('#mli-models tr').count() === 61
        && await page.isHidden('#mli-load-more')
        && await page.evaluate(() => document.activeElement === document.querySelectorAll('#mli-models tr > th[scope="row"]')[50]),
      'the second page did not append to the first or the exhausted control stayed visible');
    await page.setViewportSize({ width: 640, height: 900 });
    await page.focus('.mli-table-wrap');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const horizontal = await page.$eval('.mli-table-wrap', (node) => ({
      left: node.scrollLeft, client: node.clientWidth, scroll: node.scrollWidth,
    }));
    check('usage/models narrow table scrolls from keyboard focus',
      horizontal.scroll > horizontal.client && horizontal.left > 0,
      `table scroll state was ${JSON.stringify(horizontal)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Arrow-key navigation walks the rail in rendered order. Every newly
    // inserted neighbour is asserted before Models remains reachable.
    await page.click('#usage-tab-findings');
    await page.focus('#usage-tab-findings');
    await page.keyboard.press('ArrowRight');
    check('usage/prompts follows Findings in arrow-key tab navigation',
      await page.getAttribute('#usage-tab-prompts', 'aria-selected') === 'true'
        && await page.evaluate(() => document.activeElement?.id) === 'usage-tab-prompts',
      'Prompts tab did not receive selection and focus after ArrowRight');
    await page.keyboard.press('ArrowRight');
    check('usage/context follows Prompts in arrow-key tab navigation',
      await page.getAttribute('#usage-tab-context', 'aria-selected') === 'true'
        && await page.evaluate(() => document.activeElement?.id) === 'usage-tab-context',
      'Context tab did not receive selection and focus');
    await page.keyboard.press('ArrowRight');
    check('usage/hooks follows Context in arrow-key tab navigation',
      await page.getAttribute('#usage-tab-hooks', 'aria-selected') === 'true'
        && await page.evaluate(() => document.activeElement?.id) === 'usage-tab-hooks',
      'Hooks tab did not receive selection and focus');
    await page.keyboard.press('ArrowRight');
    check('usage/models follows Hooks in arrow-key tab navigation',
      await page.getAttribute('#usage-tab-models', 'aria-selected') === 'true'
        && await page.evaluate(() => document.activeElement?.id) === 'usage-tab-models',
      'Models tab did not receive selection and focus');

    // ── the whole-history chip, which only one view offers ──
    //
    // Patterns are lifetime phenomena, so Prompts alone gets a 365-day option.
    // The chip has to appear there, disappear elsewhere, and — the part worth a
    // live browser — reset the WINDOW on the way out, so no other view inherits
    // a span its chip row cannot show.
    await page.click('#usage-tab-findings');
    await page.waitForTimeout(200);
    check('the whole-history chip is hidden on views that do not offer it',
      await page.isHidden('#usage-days-all'),
      'the All chip was visible outside Prompts');

    await page.click('#usage-tab-prompts');
    await page.waitForTimeout(200);
    check('the whole-history chip appears on Prompts',
      await page.isVisible('#usage-days-all'),
      'the All chip did not appear on the one view that offers it');

    await page.click('#usage-days-all');
    await page.waitForTimeout(2500);
    check('selecting All switches the window to 365 and marks the chip',
      await page.evaluate(() => document.getElementById('usage-days-all')?.classList.contains('on'))
        && (await visibleText(page, '#u-pr-hosts-note')).includes('all history'),
      `All did not take effect; caption read ${JSON.stringify(await visibleText(page, '#u-pr-hosts-note'))}`);
    check('the archived Coaching surface is absent from Prompts',
      (await page.$('#u-pr-coaching')) === null && (await page.$('#u-pr-posture')) === null,
      'the Coaching or prompt-text posture controls still rendered');
    check('deterministic recurring patterns remain represented in Prompts',
      (await visibleText(page, '#u-pr-patterns')).trim().length > 0,
      'the recurring-pattern panel rendered no deterministic state');

    // NOT covered here: renderPrompts' no-fingerprint-layer branch. The bundle
    // is wrapped in an IIFE, so the renderer is not addressable from
    // page.evaluate, and the only ways to reach it are to export a global from
    // production code purely for this check or to serve a second fixture corpus
    // parsed before fingerprints shipped. The branch is three lines and its
    // sibling absent states are unit-pinned; a production hook for test
    // convenience is the worse trade.

    // The ordering pin. syncAllHistoryChip runs BEFORE the per-view loaders, so
    // leaving Prompts@All for Limits fetches once, at the reset window — not
    // once at 365 and again at 30 with no ordering guarantee between them.
    limitsRequests.length = 0;
    await page.click('#usage-tab-limits');
    await page.waitForTimeout(2500);
    const limitWindows = limitsRequests.map((u) => new URL(u).searchParams.get('days'));
    check('leaving Prompts@All requests Limits once, at the reset window',
      limitWindows.length > 0 && !limitWindows.includes('365'),
      `Limits was fetched at ${JSON.stringify(limitWindows)} — a 365 request means the loader ran before the window reset`);
    check('leaving Prompts drops the window back to 30d, chip and all',
      await page.isHidden('#usage-days-all')
        && await page.evaluate(() => document.querySelector('#usage-days [data-days="30"]')?.classList.contains('on')),
      'the 365-day window survived into a view whose chip row cannot show it');

    // ── the specific zeros that were silently wrong ──
    await page.click('[data-view="sessions"]');
    await page.waitForTimeout(600);
    const treeText = await visibleText(page, '#u-tree');
    check('project rows show a real duration, not "0m" for every project',
      !/^\s*0m\s*$/m.test(treeText) || !/\d+\s*sess/.test(treeText),
      'every project row read 0m — byProject[].minutes is not reaching the renderer');

    // groups must start COLLAPSED
    const openGroups = await page.$$eval('.pgroup[data-open]', (n) => n.length).catch(() => 0);
    check('project groups start collapsed', openGroups === 0,
      `${openGroups} group(s) auto-expanded`);

    // expand one and confirm sessions appear
    const firstHead = await page.$('.phead');
    if (firstHead) {
      await firstHead.click();
      await page.waitForTimeout(400);
      const rows = await page.$$eval('.pgroup[data-open] .srow', (n) => n.length).catch(() => 0);
      check('expanding a project reveals its sessions', rows > 0, 'no .srow appeared after expand');
      await shoot(page, 'usage-sessions-expanded');
    }

    // ── scroll containment: each list scrolls in place, footer stays reachable ──
    for (const [label, sel] of [['findings', '#u-insights'], ['transcript', '#u-turns']]) {
      // The callback below is serialised and executed in the BROWSER, not here,
      // so `getComputedStyle` is legitimately in scope there. Declared for
      // eslint, which lints this file as Node and cannot see the boundary.
      /* global getComputedStyle */
      const box = await page.$eval(sel, (el) => ({
        max: getComputedStyle(el).maxHeight,
        overflow: getComputedStyle(el).overflowY,
        contain: getComputedStyle(el).overscrollBehaviorY,
      })).catch(() => null);
      check(`${label} scrolls in place, not the window`,
        !!box && box.overflow === 'auto' && box.max !== 'none',
        `computed style was ${JSON.stringify(box)}`);
      check(`${label} contains its overscroll`, !!box && box.contain === 'contain',
        `overscroll-behavior-y was ${box?.contain}`);
    }

    // ── the poll control actually governs polling ──
    const pollDefault = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ak-dash-poll') || '{}'); } catch { return {}; }
    });
    check('poll control persists a 30s default', (pollDefault.intervalMs ?? 30000) === 30000,
      `persisted intervalMs was ${pollDefault.intervalMs}`);

    // ── theme toggle survives a round trip ──
    const before = await page.getAttribute('html', 'data-theme');
    await page.click('#theme-toggle').catch(() => {});
    await page.waitForTimeout(250);
    const after = await page.getAttribute('html', 'data-theme');
    check('theme toggle flips the theme', before !== after, `stayed on ${before}`);
    await shoot(page, 'theme-light');
    await page.click('#theme-toggle').catch(() => {});

    // ── the page is self-contained ──────────────────────────────────────────
    // Run HERE, not earlier: every area — About's directory cards, System's
    // charts and project rows, Usage, Observability — has now rendered into the
    // same document, so one scan covers all five. A remote font, CDN script, or
    // hotlinked logo would be an egress this design forbids outright.
    //
    // OUTBOUND ANCHORS ARE NOT A VIOLATION and are deliberately exempt: About's
    // documentation pills and a project's remote link are things the reader
    // CLICKS. Nothing on the page ever fetches them — which is why they are
    // checked for https and rel-hardening instead, and why the request-level
    // assertion at the end of the run is what proves nothing was fetched.
    const selfContained = await page.evaluate(() => {
      const loaders = [['script', 'src'], ['link', 'href'], ['img', 'src'], ['img', 'srcset'],
        ['iframe', 'src'], ['object', 'data'], ['embed', 'src'], ['source', 'src'],
        ['source', 'srcset'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'],
        ['track', 'src'], ['use', 'href'], ['image', 'href']];
      const external = [];
      for (const [tag, attr] of loaders) {
        for (const el of document.querySelectorAll(`${tag}[${attr}]`)) {
          const value = el.getAttribute(attr) || '';
          if (/^(https?:)?\/\//i.test(value)) external.push(`${tag}[${attr}]=${value}`);
        }
      }
      const remoteUrl = /url\(\s*['"]?(?:https?:)?\/\//i;
      for (const el of document.querySelectorAll('[style]')) {
        if (remoteUrl.test(el.getAttribute('style') || '')) external.push(`style="${el.getAttribute('style')}"`);
      }
      for (const el of document.querySelectorAll('style')) {
        if (remoteUrl.test(el.textContent || '')) external.push('<style> block with a remote url()');
      }
      const anchors = [...document.querySelectorAll('a[href]')]
        .map((a) => ({ href: a.getAttribute('href') || '', rel: a.getAttribute('rel') || '' }))
        .filter((a) => /^[a-z]+:/i.test(a.href) || a.href.startsWith('//'));
      return { external, scriptSrc: document.querySelectorAll('script[src]').length, anchors };
    });
    check('the page loads nothing from an external host',
      selfContained.external.length === 0 && selfContained.scriptSrc === 0,
      `${selfContained.scriptSrc} external <script src>; offending references: `
      + JSON.stringify(selfContained.external.slice(0, 5)));
    check('outbound links are https-only and cannot leak the page to what they open',
      selfContained.anchors.length > 0
        && selfContained.anchors.every((a) => /^https:\/\//.test(a.href)
          && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)),
      `absolute anchors were ${JSON.stringify(selfContained.anchors.slice(0, 5))} — `
      + 'zero of them would also mean About and Projects rendered no links at all');

    // ═════════════════════════════════════════════════════════════════════════
    // ADR-0009 follow-ups — spec archived at
    //   docs/archive/2026-07-25-superpowers-spec-usage-scorecard-followups.md
    //   (decisions 1, 2, 3+5)
    //
    // Every check below is expected to FAIL until the renderer ships. They are
    // written against the SPEC, not against the current markup.
    // ═════════════════════════════════════════════════════════════════════════
    // These callbacks are serialised and run in the BROWSER, not here; declared
    // for eslint, which lints this file as Node and cannot see the boundary.
    /* global document, location */

    // A hash-only page.goto() does NOT reload — the app parses location.hash
    // once, at init, so navigating `#usage` → `#usage/sessions` that way leaves
    // the previous view mounted and every row measuring 0×0 inside a
    // display:none subtree. Reload explicitly.
    const BASE = srv.url.replace(/\/+$/, '');
    const openHash = async (hash) => {
      await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(1300);
    };

    // ── ITEM 1 · the engaged-time KPI carries the three-tier ladder ──────────
    // ADR-0009 §4: `engagedSeconds ≤ spanUnionSeconds ≤ spanMinutes×60` is the
    // argument for why 7.2 h/day is trustworthy. The middle term must be
    // inspectable from the running panel (tooltip) WITHOUT being promoted into
    // the visible sub-line — so both halves are asserted.
    await openHash('#usage');
    const totals = await fetch(`${BASE}/api/usage?days=14`, {
      headers: { 'x-dash-token': srv.token },
    })
      .then((r) => r.json()).then((d) => d.totals || {}).catch(() => ({}));
    check('the usage aggregate is reachable for computing expectations',
      Number.isFinite(Number(totals.engagedSeconds)),
      `GET ${BASE}/api/usage?days=14 did not yield totals — every tier assertion below is blind without it`);

    const tierEngaged = fmtHours(totals.engagedSeconds);
    const tierOpen = fmtHours(totals.spanUnionSeconds);
    const tierSummed = fmtHours((Number(totals.spanMinutes) || 0) * 60);
    if (!REAL) {
      // Guards the two checks below against going blind: on a corpus where all
      // three tiers format identically, a tooltip that prints one figure three
      // times would pass and the sub-line check could not detect promotion.
      check('fixture corpus keeps the three time tiers distinct',
        new Set([tierEngaged, tierOpen, tierSummed]).size === 3,
        `tiers formatted as ${tierEngaged} / ${tierOpen} / ${tierSummed} — extendedCorpus() must separate them`);
    }

    const engagedKpi = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#u-hero .kpi')];
      const el = cards.find((c) => (c.querySelector('.k')?.textContent || '').trim() === 'engaged time');
      if (!el) return null;
      const d = el.querySelector('.d');
      return {
        title: el.getAttribute('title'),
        v: (el.querySelector('.v')?.textContent || '').trim(),
        dLead: (d?.firstChild?.nodeValue || '').trim(),
        dNote: (d?.querySelector('.d-note')?.textContent || '').trim(),
        dElems: d ? d.children.length : -1,
      };
    });
    await shoot(page, 'followup-kpi-engaged');

    check('the engaged-time KPI card is still present', !!engagedKpi,
      'no #u-hero .kpi whose .k reads "engaged time"');
    if (engagedKpi) {
      // The VISIBLE card must be byte-identical to what shipped. A regression
      // that moves the open tier into the sub-line fails right here.
      check('engaged KPI headline is the engaged tier, unchanged',
        engagedKpi.v === tierEngaged, `read "${engagedKpi.v}", shipped renderer emits "${tierEngaged}"`);
      check('engaged KPI sub-line is unchanged ("<summed> summed" + note)',
        engagedKpi.dLead === `${fmtMins(totals.spanMinutes)} summed`
          && engagedKpi.dNote === 'sessions overlap' && engagedKpi.dElems === 1,
        `sub-line read ${JSON.stringify(engagedKpi.dLead)} / ${JSON.stringify(engagedKpi.dNote)} `
        + `with ${engagedKpi.dElems} element child(ren); expected "${fmtMins(totals.spanMinutes)} summed" / "sessions overlap" / 1`);
      check('engaged KPI sub-line does not promote the open tier',
        !/\bopen\b/i.test(`${engagedKpi.dLead} ${engagedKpi.dNote}`) && !engagedKpi.dLead.includes(tierOpen),
        'the span-union tier leaked into the visible sub-line — ADR-0009 §4 says the engaged tier leads alone');

      const tip = engagedKpi.title || '';
      check('engaged KPI carries a title= on the whole card', !!engagedKpi.title,
        'the .kpi div has no title attribute — spanUnionSeconds is surfaced nowhere, which is the bug');
      check('KPI tooltip names all three tiers with their figures',
        tip.includes(`engaged ${tierEngaged}`) && tip.includes(`open ${tierOpen}`) && tip.includes(`summed ${tierSummed}`),
        `title=${JSON.stringify(tip)} — expected it to contain "engaged ${tierEngaged}", "open ${tierOpen}", "summed ${tierSummed}"`);
      check('KPI tooltip states the ORDERING, not just three numbers',
        (tip.match(/≤/g) || []).length >= 2,
        `title carried ${(tip.match(/≤/g) || []).length} "≤" — the invariant is the argument (ADR-0009 §4)`);
    }

    // ── the models caption's exclusion qualifier owns its own line ───────────
    // Geometry, not markup: the defect was that "· 4" wrapped to the end of the
    // caption line with "dropped/errored turns excluded" orphaned below, so the
    // count read as part of the caption. A display:block sub-line is the fix,
    // and only a rect comparison can prove the reader sees two distinct lines.
    const modelsNote = await page.evaluate(() => {
      const sub = document.getElementById('u-models-note');
      if (!sub) return null;
      const caption = sub.parentElement;
      const s = sub.getBoundingClientRect();
      const c = caption.getBoundingClientRect();
      // The caption's own first line: measure a range over the text node that
      // precedes the sub-element, so this is the rendered lead, not a guess.
      const r = document.createRange();
      r.setStart(caption, 0);
      r.setEndBefore(sub);
      const lead = r.getBoundingClientRect();
      return {
        text: sub.textContent.trim(),
        leadText: r.toString().trim(),
        display: getComputedStyle(sub).display,
        startsBelowLead: s.top >= lead.bottom - 1,
        sharesLeftEdge: Math.abs(s.left - c.left) <= 1,
      };
    });
    await shoot(page, 'followup-models-caption');

    check('the exclusion qualifier actually renders (fixture has an errored turn)',
      !!modelsNote && modelsNote.text.length > 0,
      'the corpus produced no exception, so this layout is untested — the fixture must carry one');
    if (modelsNote && modelsNote.text) {
      check('the qualifier is a block, not an inline tail',
        modelsNote.display === 'block', `computed display was "${modelsNote.display}"`);
      check('the qualifier begins on its own line, below the caption',
        modelsNote.startsBelowLead,
        `qualifier top is not below the caption's last line — it is sharing a line with `
        + `${JSON.stringify(modelsNote.leadText)}, which is the wrap defect`);
      check('the qualifier is a whole phrase, not a fragment split across lines',
        /^\d[\d,]* dropped\/errored turns? excluded$/.test(modelsNote.text),
        `read ${JSON.stringify(modelsNote.text)} — expected the count and its noun together`);
      check('the qualifier carries no leading separator now that it owns a line',
        !/^[·.\-–—]/.test(modelsNote.text),
        `read ${JSON.stringify(modelsNote.text)} — a leading "·" reads as a continuation of the caption`);
      check('the qualifier aligns with the caption it sits under',
        modelsNote.sharesLeftEdge, 'the sub-line is indented away from its caption');
    }

    // ── ITEM 2 · a truncated turn announces itself, with BOTH figures ────────
    // ADR-0009 §8: an abridged turn must not be indistinguishable from a
    // complete one, and a bare "truncated" tells the reader nothing about
    // whether the loss matters (§6's un-graded claim, in the transcript).
    if (!REAL) {
      await openHash(`#usage/${TRUNC_ID}`);
      await page.waitForSelector('#u-turns .turn', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const turnCount = await page.$$eval('#u-turns .turn', (n) => n.length).catch(() => 0);
      const badges = await page.$$eval('#u-turns .t-trunc', (ns) => ns.map((n) => ({
        text: (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim(),
        title: n.getAttribute('title') || '',
        inWho: !!n.closest('.t-who'),
      }))).catch(() => []);
      await shoot(page, 'followup-truncation');

      check('the oversized fixture turn reached the reader', turnCount === 4,
        `#u-turns rendered ${turnCount} turns, expected the 4 of ${TRUNC_ID}`);
      check('exactly one turn is badged as truncated', badges.length === 1,
        `found ${badges.length} .t-trunc badges — one turn exceeds MAX_TURN_CHARS, the other three do not`);
      if (badges.length === 1) {
        const [b] = badges;
        check('the truncation badge lives in the .t-who turn header', b.inWho,
          'badge was rendered outside .t-who; the spec places it before the output-token count');
        check('the badge states BOTH figures, not a bare "truncated"',
          b.text.includes(fmtTok(TRUNC_SHOWN)) && b.text.includes(fmtTok(TRUNC_ORIGINAL)),
          `badge read ${JSON.stringify(b.text)} — expected both "${fmtTok(TRUNC_SHOWN)}" and "${fmtTok(TRUNC_ORIGINAL)}"`);
        check('the badge reads "truncated · <shown> of <original>"',
          new RegExp(`^truncated\\s*·\\s*${fmtTok(TRUNC_SHOWN).replace('.', '\\.')}\\s+of\\s+${fmtTok(TRUNC_ORIGINAL).replace('.', '\\.')}$`)
            .test(b.text),
          `badge read ${JSON.stringify(b.text)}`);
        check('the badge title= carries the exact counts',
          b.title.includes(fmtNum(TRUNC_SHOWN)) && b.title.includes(fmtNum(TRUNC_ORIGINAL)),
          `title=${JSON.stringify(b.title)} — expected "${fmtNum(TRUNC_SHOWN)}" and "${fmtNum(TRUNC_ORIGINAL)}"`);

        // The "shown" figure must be DERIVED from the text the reader actually
        // received, not a hardcoded 40 000: MAX_TURN_CHARS lives in
        // usage-index.mjs and the browser never sees it, so a literal in the
        // renderer would silently desync the day the constant moves. Comparing
        // the claim against the rendered body is the check that catches that —
        // change MAX_TURN_CHARS and the body length moves with it.
        const bodyLen = await page.$eval('#u-turns .t-trunc', (n) => {
          const body = n.closest('.turn')?.querySelector('.t-body');
          return body ? (body.innerText || '').length : -1;
        }).catch(() => -1);
        const shown = Number((b.title.match(/([\d,]+)\s+of\s+[\d,]+/) || [])[1]?.replace(/,/g, ''));
        check('the badge\'s "shown" figure matches the body the reader received',
          Number.isFinite(shown) && bodyLen > 0 && shown === bodyLen - TRUNC_MARKER.length,
          `badge claims ${shown} shown; .t-body holds ${bodyLen} chars `
          + `(${bodyLen - TRUNC_MARKER.length} once the ${JSON.stringify(TRUNC_MARKER)} marker is discounted) — `
          + 'a hardcoded MAX_TURN_CHARS in the renderer desyncs exactly here');
      }
      const truncText = await visibleText(page, '#v-transcript');
      const truncArts = artifactsIn(truncText);
      check('the truncated transcript is free of rendering artifacts', truncArts.length === 0,
        `found ${truncArts.join(', ')}`);
    }

    // ── ITEM 2b · the backward-compatibility branch of truncBadge() ──────────
    // Decision 2 keeps `truncated` on the wire while emitting `originalChars`
    // ONLY on truncated turns, so the renderer must survive the pre-upgrade
    // shape: `truncated:true` with no denominator.
    //
    // SEVERITY IS LOW, and the comment should not imply otherwise. The current
    // producer emits `originalChars` on every truncated turn and readSession
    // rebuilds turns from the file on each call, so the server CANNOT emit this
    // shape today. It is reachable only by a browser holding a response from
    // before the upgrade. This is a compatibility contract, not live breakage.
    //
    // The fixture corpus genuinely cannot produce it — which is why this was
    // twice called unreachable. That reasoning stopped one step short: the
    // corpus is not the only input the page has. Intercepting the route serves
    // the legacy shape directly and drives the branch with no server involved.
    const LEGACY_ID = 'legacy-cached-01';
    await page.route(/\/api\/session\//, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meta: { title: 'a turn from a pre-upgrade cached payload', project: 'proj', minutes: 1, prompts: 1, responses: 0, tokens: 0, cost: 0 },
        turns: [{ role: 'user', at: '2026-07-24T11:00:00.000Z', text: `abridged body${TRUNC_MARKER}`, truncated: true }],
      }),
    }));
    await openHash(`#usage/${LEGACY_ID}`);
    await page.waitForSelector('#u-turns .turn', { timeout: 8000 }).catch(() => {});
    const legacy = await page.$$eval('#u-turns .t-trunc', (ns) => ns.map((n) => ({
      text: (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim(),
      title: n.getAttribute('title') || '',
    }))).catch(() => []);
    await shoot(page, 'followup-truncation-legacy');

    // 1 — it still announces itself. If the badge vanishes on the legacy shape,
    // an abridged turn reads as complete: the ADR-0009 §8 failure this item exists to prevent.
    check('a truncated turn with no originalChars still renders a badge', legacy.length === 1,
      `found ${legacy.length} .t-trunc badges for a turn carrying truncated:true and no denominator`);
    if (legacy.length === 1) {
      const [l] = legacy;
      // 2 — no artifact. fmtNum(undefined) and friends surface exactly here.
      const arts = artifactsIn(`${l.text} ${l.title}`);
      check('the no-denominator badge is free of rendering artifacts', arts.length === 0,
        `found ${arts.join(', ')} in ${JSON.stringify(`${l.text} | ${l.title}`)}`);
      // 3 — no invented denominator. §6: claim a figure only when you can compute one.
      check('the no-denominator badge claims no figure it does not have',
        !/\bof\b/i.test(l.text) && !/\d/.test(l.text) && !/[\d,]+\s+of\s+[\d,]+/.test(l.title),
        `badge read ${JSON.stringify(l.text)} with title ${JSON.stringify(l.title)} — `
        + 'an "X of Y" here would be a fabricated denominator');
      check('the no-denominator badge says the original length was not recorded',
        /not\s+recorded/i.test(l.title),
        `title was ${JSON.stringify(l.title)} — silence about WHY there is no figure is the un-graded claim §6 refuses`);
    }
    await page.unroute(/\/api\/session\//);

    // ── ITEMS 3+5 · the session row expander and the worktree chip ───────────
    await openHash('#usage/sessions');
    await page.waitForSelector('#u-tree .pgroup', { timeout: 8000 }).catch(() => {});

    // Every check below measures LAYOUT, and .pbody is display:none while its
    // group is collapsed — a row inside one measures 0×0 and reports specified
    // rather than used grid tracks, which would fail everything for the wrong
    // reason. Re-asserted before each block because the 30s poll re-renders
    // #u-tree and resets every group to collapsed.
    const ensureExpanded = async () => {
      const opened = await page.$$eval('#u-tree .pgroup:not([data-open]) .phead', (heads) => {
        heads.forEach((h) => h.click());
        return heads.length;
      }).catch(() => 0);
      if (opened) await page.waitForTimeout(400);
      return page.$$eval('#u-tree .pgroup[data-open] .srow', (n) => n.length).catch(() => 0);
    };
    // A missing selector must fail FAST. Playwright's 30s default would idle
    // straight through a poll cycle and collapse the tree mid-run.
    const clickCaret = () => page.click('#u-tree .pgroup[data-open] .srow .s-exp', { timeout: 2500 }).catch(() => {});

    check('the sessions view is open with its project groups expanded',
      (await ensureExpanded()) > 0, 'no visible .srow after expanding every project group');

    const caret = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#u-tree .srow')];
      const btns = rows.map((r) => r.querySelector('.s-exp'));
      const present = btns.filter(Boolean);
      return {
        rows: rows.length,
        carets: present.length,
        tags: [...new Set(present.map((b) => b.tagName))],
        types: [...new Set(present.map((b) => b.getAttribute('type')))],
        aria: [...new Set(present.map((b) => b.getAttribute('aria-expanded')))],
        controlsResolve: present.length > 0 && present.every((b) => {
          const t = document.getElementById(b.getAttribute('aria-controls') || '');
          return !!t && t.classList.contains('sdetail');
        }),
        leadsRow: rows.length > 0 && rows.every((r) => r.firstElementChild?.classList.contains('s-exp')),
        details: document.querySelectorAll('#u-tree .sdetail').length,
        allHidden: [...document.querySelectorAll('#u-tree .sdetail')].every((d) => d.hidden),
      };
    });

    check('every session row carries a .s-exp caret', caret.rows > 0 && caret.carets === caret.rows,
      `${caret.carets} carets across ${caret.rows} rows`);
    check('the caret is a real <button type="button">',
      caret.tags.length === 1 && caret.tags[0] === 'BUTTON' && caret.types.length === 1 && caret.types[0] === 'button',
      `tags=${JSON.stringify(caret.tags)} types=${JSON.stringify(caret.types)} — a div is not keyboard-reachable`);
    check('every caret starts aria-expanded="false"',
      caret.aria.length === 1 && caret.aria[0] === 'false', `aria-expanded values were ${JSON.stringify(caret.aria)}`);
    check('every caret aria-controls resolves to a .sdetail strip', caret.controlsResolve,
      'aria-controls pointed at no element, or at something that is not .sdetail');
    check('the caret occupies the new LEADING column of .srow', caret.leadsRow,
      'the caret is not the first child of every row — the 18px column is meant to lead');
    check('every row has a detail strip, all collapsed at first paint',
      caret.details === caret.rows && caret.allHidden,
      `${caret.details} .sdetail for ${caret.rows} rows; allHidden=${caret.allHidden}`);

    // keyboard reachability, and the gesture that the whole design hinges on:
    // toggling must NOT navigate to the transcript.
    const focused = await page.evaluate(() => {
      const b = document.querySelector('#u-tree .pgroup[data-open] .srow .s-exp');
      if (!b) return null;
      b.focus();
      return { isActive: document.activeElement === b, tabIndex: b.tabIndex };
    });
    check('the caret is keyboard-focusable', !!focused && focused.isActive && focused.tabIndex >= 0,
      `focus() result was ${JSON.stringify(focused)}`);

    const readToggle = () => page.evaluate(() => {
      const b = document.querySelector('#u-tree .pgroup[data-open] .srow .s-exp');
      const d = b && document.getElementById(b.getAttribute('aria-controls') || '');
      return {
        aria: b ? b.getAttribute('aria-expanded') : null,
        open: !!d && !d.hidden && d.offsetHeight > 0,
        onSessions: !document.getElementById('v-sessions')?.hidden
          && !!document.getElementById('v-transcript')?.hidden,
        hash: location.hash,
      };
    });

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const afterEnter = await readToggle();
    check('Enter on the focused caret expands the row',
      afterEnter.aria === 'true' && afterEnter.open,
      `aria-expanded=${afterEnter.aria}, strip visible=${afterEnter.open}`);
    // Gated on the caret existing: with no caret at all nothing was clicked and
    // "did not navigate" would be a vacuous pass reading as reassurance.
    check('expanding via keyboard does NOT navigate to the transcript',
      caret.carets > 0 && afterEnter.onSessions,
      caret.carets === 0 ? 'no caret exists to press — nothing was exercised'
        : `the transcript view took over (hash=${afterEnter.hash}) — the caret handler must stopPropagation()`);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const afterEnter2 = await readToggle();
    check('Enter again collapses the row', afterEnter2.aria === 'false' && !afterEnter2.open,
      `aria-expanded=${afterEnter2.aria}, strip visible=${afterEnter2.open}`);

    await clickCaret();
    await page.waitForTimeout(300);
    const afterClick = await readToggle();
    check('clicking the caret expands the row', afterClick.aria === 'true' && afterClick.open,
      `aria-expanded=${afterClick.aria}, strip visible=${afterClick.open}`);
    check('clicking the caret does NOT navigate to the transcript',
      caret.carets > 0 && afterClick.onSessions,
      caret.carets === 0 ? 'no caret exists to click — nothing was exercised'
        : `the transcript view took over (hash=${afterClick.hash}) — the caret handler must stopPropagation()`);

    await clickCaret();
    await page.waitForTimeout(300);
    const afterClick2 = await readToggle();
    check('clicking the caret again collapses the row', afterClick2.aria === 'false' && !afterClick2.open,
      `aria-expanded=${afterClick2.aria}, strip visible=${afterClick2.open}`);

    // the strip contents — identity plus five usage/classification lines, all rendered from data already
    // on the wire (ADR-0009 §5). `basis` is a STRING contract; an object there
    // renders "[object Object]", which the artifact net below is aimed at.
    const openStrip = (id) => page.evaluate((sid) => {
      const row = document.querySelector(`#u-tree .pgroup[data-open] .srow[data-id="${sid}"]`);
      if (!row) return { missing: 'row' };
      const b = row.querySelector('.s-exp');
      if (!b) return { missing: 'caret' };
      if (b.getAttribute('aria-expanded') !== 'true') b.click();
      const d = document.getElementById(b.getAttribute('aria-controls') || '');
      if (!d) return { missing: 'sdetail' };
      const text = d.innerText || d.textContent || '';
      return { text, lines: text.split('\n').map((s) => s.trim()).filter(Boolean) };
    }, id);

    if (!REAL) {
      await ensureExpanded();
      const wtStrip = await openStrip(WT_ID);
      check(`the ${WT_ID} detail strip renders`, !wtStrip.missing && (wtStrip.lines || []).length > 0,
        `missing: ${wtStrip.missing || 'strip was empty'}`);
      if (!wtStrip.missing) {
        for (const label of ['execution host', 'inference provider', 'models', 'basis', 'tokens', 'tools', 'flags']) {
          check(`detail strip shows the "${label}" line`, new RegExp(`\\b${label}\\b`, 'i').test(wtStrip.text),
            `strip text was ${JSON.stringify(wtStrip.text.slice(0, 240))}`);
        }
        check('detail strip has all seven identity and usage lines', wtStrip.lines.length >= 7,
          `strip rendered ${wtStrip.lines.length} non-empty line(s): ${JSON.stringify(wtStrip.lines)}`);
        check('the basis line carries the confidence alongside it', /conf\s*0?\.\d+/i.test(wtStrip.text),
          `no "(conf 0.xx)" in ${JSON.stringify(wtStrip.text.slice(0, 240))}`);
        check('the flags line names the worktree rather than eliding it',
          new RegExp(`worktree\\s+${WT_NAME}`, 'i').test(wtStrip.text),
          `expected "worktree ${WT_NAME}" in the flags line; strip was ${JSON.stringify(wtStrip.text.slice(0, 240))}`);
        const stripArts = artifactsIn(wtStrip.text);
        check('the expanded detail strip is free of rendering artifacts', stripArts.length === 0,
          `found ${stripArts.join(', ')} — a non-string basis renders exactly this`);
      }

      // An Unclassified session is a first-class outcome (ADR-0009 §5) and must
      // still show WHY — "no signal" is an explanation, a blank is not.
      const unclStrip = await openStrip('dddd4444');
      check('the Unclassified session still renders a detail strip', !unclStrip.missing,
        `missing: ${unclStrip.missing}`);
      if (!unclStrip.missing) {
        // The label is uppercased by CSS and may share a line with its value or
        // sit on the line above it, depending on how the strip lays out. Read
        // the VALUE either way — the assertion is about content, not layout.
        const lines = unclStrip.lines || [];
        const at = lines.findIndex((l) => /^basis\b/i.test(l));
        const sameLine = at >= 0 ? lines[at].replace(/^basis\b[:\s]*/i, '').trim() : '';
        const basisValue = sameLine || (at >= 0 ? (lines[at + 1] || '').trim() : '');
        check('the Unclassified session shows a basis, not a blank',
          basisValue.trim().length > 0 && /no signal/i.test(basisValue),
          `basis value was ${JSON.stringify(basisValue)}; strip was ${JSON.stringify(unclStrip.text.slice(0, 240))}`);
      }

      // Worktree chip (decision 5) — rendered only where sx.worktree is non-null.
      const chips = await page.evaluate((ids) => ids.map((id) => {
        const row = document.querySelector(`#u-tree .pgroup[data-open] .srow[data-id="${id}"]`);
        const chip = row && row.querySelector('.s-wt');
        return {
          id, row: !!row, chip: !!chip,
          text: chip ? (chip.textContent || '').trim() : null,
          inTitleCell: !!(chip && chip.closest('.s-title')),
        };
      }), [WT_ID, 'aaaa1111']);
      const [wtRow, plainRow] = chips;
      check('a worktree session renders a .s-wt chip in its title cell',
        wtRow.chip && wtRow.inTitleCell && String(wtRow.text).includes(WT_NAME),
        `row=${wtRow.row} chip=${wtRow.chip} inTitleCell=${wtRow.inTitleCell} text=${JSON.stringify(wtRow.text)}`);
      check('a session with no worktree renders no chip', plainRow.row && !plainRow.chip,
        `aaaa1111 rendered a .s-wt reading ${JSON.stringify(plainRow.text)} — the chip must be conditional`);
    }

    // Screenshot evidence for BOTH modes. This shot used to sit outside the
    // fixture-only block above while every expansion happened inside it, so a
    // --real run fired it with nothing expanded and overwrote the fixture
    // artifact with a picture of no expander — an image that reads as "the
    // feature is broken". Expand a row here (in --real the session ids are
    // unknown, so take whichever row is first) and assert the strip really is
    // open at shot time, so the artifact cannot go quietly empty again.
    await ensureExpanded();
    const shotReady = await page.evaluate(() => {
      const b = document.querySelector('#u-tree .pgroup[data-open] .srow .s-exp');
      if (!b) return false;
      if (b.getAttribute('aria-expanded') !== 'true') b.click();
      const d = document.getElementById(b.getAttribute('aria-controls') || '');
      return !!d && !d.hidden && d.offsetHeight > 0;
    }).catch(() => false);
    await page.waitForTimeout(300);
    const shotFile = await shoot(page, 'followup-expander');
    check('the expander screenshot captures an actually-expanded row', shotReady,
      `${path.basename(shotFile)} was written with no visible .sdetail — the artifact would show `
      + 'a collapsed list and read as a broken feature');

    // ── GRID REGRESSION · the new leading column at BOTH widths ──────────────
    // `.srow` gains an 18px caret column. The narrow breakpoint currently drops
    // to four columns; if only the desktop grid is updated every mobile cell
    // shifts by one and nothing else in this suite would notice.
    const rowGrid = () => page.evaluate(() => {
      const row = document.querySelector('#u-tree .pgroup[data-open] .srow');
      if (!row) return null;
      const cs = getComputedStyle(row);
      const tracks = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
      const rb = row.getBoundingClientRect();
      const kids = [...row.children]
        .filter((k) => getComputedStyle(k).display !== 'none')
        .map((k) => {
          const b = k.getBoundingClientRect();
          // Centre, not top: the row is align-items:center, so cells of
          // different heights legitimately have different tops on the SAME
          // grid row. A wrap to a second row moves the centre, not the top.
          return {
            cls: String(k.className), x: Math.round(b.left - rb.left), w: Math.round(b.width),
            cy: Math.round(b.top + b.height / 2 - rb.top),
          };
        });
      return { tracks, kids, width: Math.round(rb.width) };
    });

    // 560 and 700 both fall under the SAME `max-width:720px` rule (the design
    // doc calls it "the ≤560px breakpoint"; no such media query exists, and none
    // should be invented — hence assertions on computed tracks, never on the
    // presence of a media query). Both are exercised so a future narrow rule
    // cannot diverge from the one that actually ships today.
    for (const [label, width] of [['desktop', 1440], ['tablet', 700], ['narrow', 560]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(350);
      await ensureExpanded();
      const g = await rowGrid();
      await shoot(page, `followup-grid-${width}`);

      // A row inside a collapsed .pbody measures 0×0 and reports SPECIFIED
      // rather than used tracks, which would fail everything below for the
      // wrong reason. Refuse to draw conclusions from an unlaid-out row.
      check(`[${label} ${width}px] a session row is laid out`, !!g && g.kids.length > 0 && g.width > 0,
        g ? `row measured ${g.width}px wide with ${g.kids.length} visible cells` : 'no expanded #u-tree .srow at this width');
      if (!g || !g.width) continue;

      const lead = Math.round(parseFloat(g.tracks[0] || 'NaN'));
      check(`[${label} ${width}px] the grid declares the 18px caret column`, lead === 18,
        `leading track was ${JSON.stringify(g.tracks[0])} (full track list ${JSON.stringify(g.tracks)}) — `
        + 'the narrow rule (inside @media max-width:720px) must gain the column too, or every cell shifts by one');
      check(`[${label} ${width}px] the caret sits in that leading column`,
        /\bs-exp\b/.test(g.kids[0]?.cls || ''),
        `leftmost visible cell was "${g.kids[0]?.cls}"`);

      const title = g.kids.find((k) => /\bs-title\b/.test(k.cls));
      const widest = g.kids.reduce((a, b) => (b.w > a.w ? b : a), g.kids[0]);
      check(`[${label} ${width}px] the title keeps the flexible track`,
        !!title && widest && /\bs-title\b/.test(widest.cls),
        `widest cell was "${widest?.cls}" at ${widest?.w}px; .s-title was ${title ? `${title.w}px` : 'absent'} — `
        + 'a one-column shift hands the 1fr track to the wrong cell');

      const lane = ['s-exp', 's-host', 's-title'].map((c) => g.kids.find((k) => new RegExp(`\\b${c}\\b`).test(k.cls)));
      check(`[${label} ${width}px] caret, host and title share the first visual row, left to right`,
        lane.every(Boolean)
          && Math.abs(lane[0].cy - lane[1].cy) <= 2 && Math.abs(lane[1].cy - lane[2].cy) <= 2
          && lane[0].x < lane[1].x && lane[1].x < lane[2].x,
        `positions were ${JSON.stringify(lane)} — a wrapped cell lands on a second grid row`);

      // Asserted at EVERY width, not just desktop. The shipped ≤720px rule
      // declared four tracks for five visible cells (`.cat` was never in the
      // hide list), so `.s-tx` wrapped to a second visual row and `$0.01` was
      // clipped into the 20px glyph track. Adding the caret column made it
      // 5-for-6 — the same defect, shifted. Pinning cells === tracks here is
      // what stops either version of it coming back.
      check(`[${label} ${width}px] the row does not wrap — one track per visible cell`,
        g.tracks.length === g.kids.length,
        `${g.kids.length} visible cells into ${g.tracks.length} tracks: `
        + `${JSON.stringify(g.kids.map((k) => k.cls))} vs ${JSON.stringify(g.tracks)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    // ── the row BODY must still open the transcript ─────────────────────────
    // The expander adds a gesture; it must not take the shipped one away.
    await ensureExpanded();
    await page.click('#u-tree .pgroup[data-open] .srow .s-title', { timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(600);
    const navigated = await page.evaluate(() => ({
      onTranscript: !document.getElementById('v-transcript')?.hidden,
      hash: location.hash,
    }));
    check('clicking the row BODY still opens the transcript',
      navigated.onTranscript && /^#usage\/.+/.test(navigated.hash),
      `transcript visible=${navigated.onTranscript}, hash=${navigated.hash} — `
      + 'the expander must not swallow the row click-through');

    // ── ADR-0026 · losing the status join costs the chips, never the page ────
    // About is editorial content PLUS a runtime join, and the two fail
    // independently. Serving a well-formed status payload that simply reports
    // nothing drives the join to empty without breaking any other panel — so
    // what is measured here is precisely the degradation, not a broken page.
    // Every card must still render its icon, tagline, and paragraph while every
    // chip reads unknown; a card that vanished, or one that stayed green off a
    // stale render, is the defect.
    await page.route(/\/api\/status(\?|$)/, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ overall: 'ok', rows: [], drift: [] }),
    }));
    await openHash('#about');
    const degraded = await readAbout();
    await shoot(page, 'about-join-lost');
    check('About renders every card even when the status join reports nothing',
      degraded.count === DIRECTORY.length
        && degraded.entries.every((entry) => entry.tile && entry.tagline.length > 12
          && entry.body.length > 60),
      `${degraded.count} of ${DIRECTORY.length} cards survived the lost join`);
    check('with no join, every chip reads unknown rather than assuming installed',
      degraded.entries.length > 0
        && degraded.entries.every((entry) => entry.state === 'unknown'
          && /unknown/i.test(entry.chip) && entry.reason.length > 0),
      `states were ${JSON.stringify([...new Set(degraded.entries.map((e) => e.state))])}`);
    // The hero states only what ak MANAGES — a release fact, true on any machine
    // and unaffected by a failed join. It deliberately makes no detection claim
    // in either direction: no "N of N installed" tally, and no aggregate
    // "states are unknown" either, because the chip on every card already says
    // so per-component (asserted directly above) and an aggregate could only
    // restate that less precisely.
    check('the hero makes no detection claim, so a lost join cannot make it lie',
      !/report as installed/i.test(degraded.lede)
        && !/\bof \d+\b/.test(degraded.lede)
        && /manages/i.test(degraded.lede),
      `the lede read ${JSON.stringify(degraded.lede.slice(0, 200))}`);
    const degradedArts = artifactsIn(await visibleText(page, '#panel-about'));
    check('the degraded About area is free of rendering artifacts', degradedArts.length === 0,
      `found ${degradedArts.join(', ')}`);
    await page.unroute(/\/api\/status(\?|$)/);

    // ── panel collapse (.strip-toggle) ──
    // The provider-analytics panel is the deterministic one to drive: it exists
    // on every machine, unlike the routing panels, which render from the
    // developer's own kit.json. Its markup ships COLLAPSED, which is itself part
    // of the contract — the panel is empty for anyone without an OpenRouter
    // cache, so opening by default spent vertical space on a blank box.
    await page.evaluate(() => localStorage.removeItem('ak-dash-collapse'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#tab-usage');
    await page.waitForSelector('.strip-toggle[aria-controls="u-openrouter-body"]');
    const collapseSel = '.strip-toggle[aria-controls="u-openrouter-body"]';
    const readCollapse = () => page.$eval(collapseSel, (b) => ({
      expanded: b.getAttribute('aria-expanded'),
      hidden: document.getElementById('u-openrouter-body').hidden,
      labelled: !!b.querySelector('h2'),
    }));

    const c0 = await readCollapse();
    check('provider account analytics ships collapsed',
      c0.expanded === 'false' && c0.hidden === true, JSON.stringify(c0));
    check('the collapse control is a labelled button, not a bare chevron',
      c0.labelled, 'the heading must live inside the button so the whole title is the target');

    await page.click(collapseSel);
    const c1 = await readCollapse();
    check('clicking expands it and updates aria-expanded',
      c1.expanded === 'true' && c1.hidden === false, JSON.stringify(c1));

    // The panels re-render on every poll, so an unpersisted collapse would snap
    // back within one tick. Only DEPARTURES from the markup default are stored.
    const saved = await page.evaluate(() => localStorage.getItem('ak-dash-collapse'));
    check('the departure from the markup default is persisted',
      !!saved && JSON.parse(saved)['u-openrouter-body'] === false, `stored ${saved}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#tab-usage');
    await page.waitForSelector(collapseSel);
    const c2 = await readCollapse();
    check('and survives a reload rather than snapping back to the default',
      c2.expanded === 'true' && c2.hidden === false, JSON.stringify(c2));

    // ── nothing errored anywhere along the way ──
    // A 404 from /api/session/<id> is CORRECT behaviour for a session that does
    // not exist — the route was changed to stop answering 200-with-a-null-body.
    // A 503 from /api/live/intelligence is CORRECT on a machine with no
    // ruflo-initialized project (CI runners): the endpoint refuses the stream,
    // the pane stays in its empty state, and the browser's resource log line is
    // the only trace. Everything else is a defect.
    const realErrors = consoleErrors.filter((e) => !/\/api\/session\//.test(e)
      && !(/status of 503/.test(e) && /\/api\/live\/intelligence/.test(e)));
    check('no console errors across the whole run', realErrors.length === 0,
      realErrors.slice(0, 3).join(' | '));
    if (realErrors.length !== consoleErrors.length) {
      console.log(`      (ignored ${consoleErrors.length - realErrors.length} expected lines: /api/session 404s, intelligence 503s)`);
    }
    check('no failed network requests', failedRequests.length === 0,
      failedRequests.slice(0, 3).join(' | '));
    // The runtime half of the self-containment contract: not one byte was
    // requested from anywhere but the loopback server that served the page.
    check('the whole run requested nothing off the loopback origin',
      offOriginRequests.length === 0,
      `${offOriginRequests.length} off-origin request(s): ${offOriginRequests.slice(0, 3).join(' | ')}`);
  } finally {
    await browser.close();
    await srv.close();
  }

  console.log(`\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failures.length} failed\x1b[0m`);
  console.log(`screenshots: ${path.relative(ROOT, SHOTS)}/\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
