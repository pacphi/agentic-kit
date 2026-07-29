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
import { chromium } from 'playwright';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { readIndex, readSession, maskSecrets } from '../../src/lib/usage-index.mjs';

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

  return { claude, codex };
}

// ── views under test ─────────────────────────────────────────────────────────
const TABS = [
  ['overview', '#panel-overview'],
  ['hosts', '#panel-hosts'],
  ['providers', '#panel-providers'],
  ['runtime', '#panel-runtime'],
  ['intel', '#panel-intel'],
  ['usage', '#panel-usage'],
  ['live', '#panel-live'],
];
const USAGE_VIEWS = [
  ['score', '#v-score'],
  ['limits', '#v-limits'],
  ['findings', '#v-findings'],
  ['sessions', '#v-sessions'],
  ['transcript', '#v-transcript'],
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
    lanes: [
      { id: 'codex', name: 'codex', planType: 'prolite', windows: [{ label: 'weekly', usedPercent: 3, windowMinutes: 10080, resetsAt: Math.round(Date.now() / 1000) + 500000 }] },
      { id: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', planType: 'prolite', windows: [] },
    ],
    resetCredits: { availableCount: 2, credits: [{ status: 'available', title: 'Full reset', expiresAt: null }] },
  },
});

const LIVE_SNAPSHOT = {
  schemaVersion: 1,
  cursor: 'live:3',
  projects: [{
    id: 'project:agentic-kit', label: 'agentic-kit',
    sessions: ['codex:ui-live-session', 'claude:ui-review-session'],
    sessionCount: 2, childSessionCount: 1, liveCount: 1, completedCount: 1,
    hosts: { codex: 1, claude: 1 },
    providers: { openai: 1, anthropic: 1 }, updatedAt: new Date().toISOString(),
  }],
  health: {
    claude: { status: 'ok', files: 2, events: 8, errors: 0, lastError: null },
    codex: { status: 'error', files: 1, events: 3, errors: 1, lastError: '/Users/private/.codex/secret.jsonl invalid-json' },
  },
  sessions: [{
    id: 'ui-live-session', key: 'codex:ui-live-session', project: 'agentic-kit',
    projectKey: 'project:agentic-kit', host: 'codex', status: 'running', lifecycle: 'active',
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'ui-live-session', kind: 'session', role: 'primary', host: 'codex',
        provider: 'openai', providerProvenance: 'observed',
        surface: 'native', status: 'running', confidence: 'observed' },
      { id: 'ui-live-agent', kind: 'subagent', label: 'Bohr', role: 'tester', host: 'codex', surface: 'ruflo', status: 'running', confidence: 'observed', lastAction: 'agent.output', observedAt: new Date().toISOString(), sourceAdapter: 'codex-state' },
      { id: 'ui-live-tool', kind: 'tool', label: 'Read', host: 'codex', surface: 'native', status: 'running', confidence: 'observed', lastAction: 'tool.started', observedAt: new Date().toISOString(), sourceAdapter: 'codex-rollout' },
      { id: 'ui-live-gate', kind: 'gate', role: 'qe-court', host: 'internal', surface: 'aqe', status: 'queued', confidence: 'planned' },
    ],
    edges: [
      { id: 'spawn', source: 'ui-live-session', target: 'ui-live-agent', action: 'agent.spawned', confidence: 'observed' },
      { id: 'read', source: 'ui-live-agent', target: 'ui-live-tool', action: 'tool.started', confidence: 'observed' },
      { id: 'gate', source: 'ui-live-agent', target: 'ui-live-gate', action: 'evaluation.requested', confidence: 'planned' },
    ],
  }, {
    id: 'ui-live-agent', key: 'codex:ui-live-agent', parentSessionId: 'ui-live-session',
    parentSessionKey: 'codex:ui-live-session', rootSessionKey: 'codex:ui-live-session',
    hierarchyState: 'child', navigationRoot: false,
    project: 'agentic-kit', projectKey: 'project:agentic-kit', host: 'codex',
    status: 'running', lifecycle: 'active', updatedAt: new Date().toISOString(),
    nodes: [{ id: 'ui-live-agent', kind: 'session', role: 'tester', host: 'codex',
      provider: 'openai', providerProvenance: 'observed', status: 'running' }],
    edges: [],
  }, {
    id: 'ui-review-session', key: 'claude:ui-review-session', project: 'agentic-kit',
    projectKey: 'project:agentic-kit', host: 'claude', status: 'completed',
    startedAt: new Date(Date.now() - 180_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    nodes: [{ id: 'ui-review-session', kind: 'session', host: 'claude',
      provider: 'anthropic', providerProvenance: 'observed', status: 'completed' }],
    edges: [],
  }],
};

const LIVE_STUB = {
  start: async () => {},
  snapshot: async () => LIVE_SNAPSHOT,
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

async function main() {
  // The usage API is injected rather than reaching for the real stores, so the
  // default run is deterministic AND cannot touch the user's live index cache.
  const roots = REAL ? undefined : extendedCorpus();
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-')), 'usage-index.json');
  const usage = {
    readIndex: (o = {}) => readIndex({ ...o, ...(roots ? { roots } : {}), cachePath }),
    readSession: (id, o = {}) => readSession(id, { ...o, ...(roots ? { roots } : {}), cachePath }),
    maskSecrets,
  };
  console.log(`\ncorpus: ${REAL ? 'REAL (~/.claude, ~/.codex)' : 'fixtures (deterministic)'}`);
  console.log(`cache : ${cachePath} (temp — your real index is untouched)\n`);

  const srv = await startDashboard({
    port: 0,
    // Status is stubbed so the panel never shells out or hits the network; the
    // point of this harness is the RENDERING, not the status collector.
    fetchStatus: async () => ({
      overall: 'warn',
      rows: [
        { subsystem: 'versions', level: 'ok', message: 'ruflo 4.0.0 (latest)', fix: null },
        { subsystem: 'natives', level: 'fail', message: 'WASM fallback', fix: 'ak sync' },
        { subsystem: 'learning', level: 'warn', message: 'no patterns yet', fix: null },
      ],
      drift: [],
    }),
    usage,
    limits: LIMITS_STUB,
    live: LIVE_STUB,
    transcripts: TRANSCRIPT_STUB,
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Anything the page logs as an error, or any request it fails, is a defect —
  // collected globally so a failure in one view is not silently swallowed.
  const consoleErrors = [];
  const failedRequests = [];
  // Capture the LOCATION too. A bare "Failed to load resource" is
  // undiagnosable, and a console listener that records only the message makes
  // the harness's own failures impossible to act on.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    const where = loc?.url ? ` @ ${loc.url}` : '';
    consoleErrors.push(`${m.text()}${where}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
  page.on('requestfailed', (r) => {
    // Leaving Live deliberately closes EventSource. Chromium reports that
    // client-side teardown as ERR_ABORTED even though it is the expected,
    // leak-preventing lifecycle behavior.
    if (/\/api\/live\/(?:events|transcripts\/[^/]+\/[^/]+\/events)$/.test(r.url())
      && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
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
    await page.goto(srv.url, { waitUntil: 'networkidle' });

    // ── every top-level tab renders, is non-empty, and is artifact-free ──
    for (const [tab, sel] of TABS) {
      await page.click(`[data-tab="${tab}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      if (tab === 'usage') await page.waitForTimeout(1200); // lazy fetch
      if (tab === 'live') await page.waitForTimeout(350); // segmented-thumb transition
      const text = await visibleText(page, sel);
      await shoot(page, `tab-${tab}`);

      check(`tab "${tab}" renders non-empty`, text.trim().length > 20,
        `panel had ${text.trim().length} chars of visible text`);
      const arts = artifactsIn(text);
      check(`tab "${tab}" is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} in visible text`);
    }

    // ── Live Sessions: execution workspace + synchronized transcript ──
    await page.click('[data-tab="live"]');
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
    }));
    check('live workspace renders agent anchors and owned tool satellites',
      liveShape.sessions === 2 && liveShape.childSessions === 1
        && liveShape.nodes === 3 && liveShape.tools >= 1
        && liveShape.edges >= 2,
      `shape was ${JSON.stringify(liveShape)}`);
    check('execution graph and transcript expose accessible live-region semantics',
      liveShape.graphRole === 'img' && liveShape.transcriptRole === 'log',
      `roles were ${JSON.stringify(liveShape)}`);
    check('cinematic map uses agent anchors and observed-work bubbles instead of card nodes',
      liveShape.anchorCores === liveShape.nodes && liveShape.workBubbles === liveShape.nodes
        && liveShape.cardNodes === 0,
      `cinematic primitives were ${JSON.stringify(liveShape)}`);
    check('desktop Live view is a persistent three-column workspace',
      liveShape.columns.split(' ').length === 3,
      `columns were ${JSON.stringify(liveShape.columns)}`);
    check('session transport remains docked over the center stage',
      liveShape.transport === 'absolute',
      `transport positioning was ${JSON.stringify(liveShape.transport)}`);
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
      !/Status not reported/.test(await visibleText(page, '#panel-live')),
      'Live view exposed the missing telemetry field instead of a human session state');
    const workerFreshness = await visibleText(page, '.live-session-child');
    check('sessions without a start boundary show freshness instead of epoch-sized duration',
      /Working now · (just now|\d+s ago)/.test(workerFreshness)
        && !/\d{4,}h/.test(workerFreshness),
      `worker freshness was ${JSON.stringify(workerFreshness)}`);
    check('Live navigation is project-first and keeps sessions within the selected project',
      await page.locator('#live-project-list [data-project]').count() === 1
        && /2 sessions/.test(await visibleText(page, '#live-project-list')),
      'project catalog did not summarize its sessions');
    check('Live navigator enters at projects and drills into a project session history',
      await page.getAttribute('#live-browser', 'data-level') === 'projects',
      'navigator did not enter at the project level');
    await page.click('#live-project-list [data-project]');
    check('project drill-in uses the same navigator with an explicit Back affordance',
      await page.getAttribute('#live-browser', 'data-level') === 'sessions'
        && await page.locator('#live-browser-back').isVisible(),
      'project selection did not reveal the session level');
    check('running sessions sort before completed review sessions',
      await page.locator('#live-session-list [data-session]').first().getAttribute('data-session')
        === 'ui-live-session',
      'the live session was not first');
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
    await page.click('[data-session="ui-review-session"]');
    await page.waitForSelector('#live-mode[data-mode="review"]');
    await page.waitForFunction(() => !document.getElementById('live-playback-range').disabled);
    check('completed sessions enter a clearly distinguished review mode',
      /REVIEW/.test(await visibleText(page, '#live-mode'))
        && !(await page.locator('#live-playback-range').isDisabled())
        && !(await page.locator('#live-resume-live').isVisible()),
      'review badge or playback controls were unavailable');
    const reviewToolsAtEnd = await page.locator('#live-tools .live-tool').count();
    await page.fill('#live-playback-range', '0');
    const reviewToolsAtStart = await page.locator('#live-tools .live-tool').count();
    check('seeking deterministically rebuilds the cinematic canvas at the playhead',
      reviewToolsAtEnd === 1 && reviewToolsAtStart === 0,
      `review tools changed ${reviewToolsAtEnd} -> ${reviewToolsAtStart}`);
    await page.click('#live-playback-toggle');
    check('review controls expose play state, speed, seek, and resume-live',
      await page.getAttribute('#live-playback-toggle', 'aria-label') === 'Pause session review'
        && await page.locator('#live-playback-speed').isVisible(),
      'playback controls did not enter playing state');
    await page.click('#live-playback-toggle');
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

    await page.click('[data-tab="usage"]');
    check('leaving Live tears down graph and transcript EventSources',
      await page.evaluate(() => globalThis.AKLive.state.source === null
        && globalThis.AKLive.state.transcript.source === null
        && globalThis.AKLive.state.active === false),
      'a live source remained active');
    await page.click('[data-tab="live"]');
    await page.waitForTimeout(250);
    check('returning to Live creates exactly one active stream',
      await page.evaluate(() => !!globalThis.AKLive.state.source && globalThis.AKLive.state.active === true),
      'live source did not reconnect');
    // ── every Usage sub-view ──
    await page.click('[data-tab="usage"]');
    await page.waitForTimeout(800);
    for (const [view, sel] of USAGE_VIEWS) {
      await page.click(`[data-view="${view}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const text = await visibleText(page, sel);
      await shoot(page, `usage-${view}`);

      check(`usage/${view} renders`, text.trim().length > 10, 'view was effectively empty');
      const arts = artifactsIn(text);
      check(`usage/${view} is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} — this is the class of bug unit tests cannot see`);
    }

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
    const totals = await fetch(`${BASE}/api/usage?days=14`)
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

    // the strip contents — five labelled lines, all rendered from data already
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
        for (const label of ['basis', 'models', 'tokens', 'tools', 'flags']) {
          check(`detail strip shows the "${label}" line`, new RegExp(`\\b${label}\\b`, 'i').test(wtStrip.text),
            `strip text was ${JSON.stringify(wtStrip.text.slice(0, 240))}`);
        }
        check('detail strip has all five lines', wtStrip.lines.length >= 5,
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

    // ── nothing errored anywhere along the way ──
    // A 404 from /api/session/<id> is CORRECT behaviour for a session that does
    // not exist — the route was changed to stop answering 200-with-a-null-body.
    // Everything else is a defect.
    const realErrors = consoleErrors.filter((e) => !/\/api\/session\//.test(e));
    check('no console errors across the whole run', realErrors.length === 0,
      realErrors.slice(0, 3).join(' | '));
    if (realErrors.length !== consoleErrors.length) {
      console.log(`      (ignored ${consoleErrors.length - realErrors.length} expected /api/session 404s)`);
    }
    check('no failed network requests', failedRequests.length === 0,
      failedRequests.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await srv.close();
  }

  console.log(`\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failures.length} failed\x1b[0m`);
  console.log(`screenshots: ${path.relative(ROOT, SHOTS)}/\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
