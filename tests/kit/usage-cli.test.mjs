import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODES } from '../../src/lib/usage-modes.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-cli-'));
  const cfg = path.join(home, '.config');
  const bin = path.join(home, 'bin');
  const sentinel = path.join(home, 'npm-was-called');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf called > "${sentinel}"\nexit 99\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm.cmd'), `@echo called>"${sentinel}"\r\nexit /b 99\r\n`);
  return { home, cfg, bin, sentinel };
}

/** One real, tiny-priced Claude session written straight to the sandbox HOME's
 *  transcript root (`~/.claude/projects/**\/*.jsonl`, same shape `writeSession`
 *  in usage-truncation.test.mjs already proves parseClaude accepts) — `ak usage
 *  score` is a subprocess, so there is no `roots` override seam to inject a
 *  fixture through; disk under the sandboxed HOME is the only lever available.
 *  Recent timestamps (computed at call time, not hardcoded) keep the session
 *  inside every supported --window without the test rotting as the calendar
 *  moves on. `claude-opus-5` at 1 input + 1 output token prices to a REAL
 *  positive figure that rounds away at two decimals ($0.00003) — this is how
 *  the sub-cent cost/session case is exercised, with no injected pricing dep. */
function writeScoreSession(sb, id) {
  const projectDir = path.join(sb.home, '.claude', 'projects', '-tmp-score-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const userAt = new Date(Date.now() - 60_000).toISOString();
  const asstAt = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), [
    JSON.stringify({
      type: 'user', sessionId: id, cwd: '/tmp/score-fixture',
      timestamp: userAt,
      message: { role: 'user', content: [{ type: 'text', text: 'hello scorecard' }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: id, cwd: '/tmp/score-fixture',
      timestamp: asstAt,
      message: {
        role: 'assistant', model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'hi there' }],
      },
    }),
  ].join('\n') + '\n');
}

/** One tiny billed Claude session per day over a contiguous stretch of history,
 *  each carrying one typed (non-tap) prompt — the raw material a personal
 *  baseline is a percentile OVER. `daysAgo` runs inclusive from `from` to `to`.
 *
 *  Every file is stamped with its OWN historical mtime, which is the whole
 *  point: the index discovers candidates by `mtimeMs >= cutoff`, so a fixture
 *  written "now" is found no matter how narrow the lookback and could not tell
 *  a widened lookback from a narrow one. Backdating the files is what makes the
 *  discovery cutoff the thing under test. */
function writeHistorySessions(sb, { from, to }) {
  const projectDir = path.join(sb.home, '.claude', 'projects', '-tmp-history-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  for (let daysAgo = from; daysAgo <= to; daysAgo++) {
    const at = Date.now() - daysAgo * 86_400_000;
    const id = `history-${daysAgo}`;
    const file = path.join(projectDir, `${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user', sessionId: id, cwd: '/tmp/history-fixture',
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'please refactor the parser and add a regression test' }] },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: id, cwd: '/tmp/history-fixture',
        timestamp: new Date(at + 30_000).toISOString(),
        message: {
          role: 'assistant', model: 'claude-opus-5',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ].join('\n') + '\n');
    const stamp = new Date(at);
    fs.utimesSync(file, stamp, stamp);
  }
}

/** The prompt corpus the pattern sections are built to find: a request retyped
 *  in six wordings across six sessions and three days (a recurring cluster),
 *  one session that asks the same thing twice one turn apart (a re-ask pair),
 *  and a handful of one-token approvals (supervision taps). Every prompt here
 *  is written by hand into the user turn, so all of it reads as `human`
 *  provenance; the tool-authored template is the one deliberate exception.
 *
 *  Sessions are minutes old, so they sit inside every supported window. The
 *  DAY spread the cluster needs comes from the assistant turn's timestamp,
 *  which is what the index attributes a session to (first billed day). */
const RELEASE_PHRASINGS = [
  'Help me release and deploy the next semantic version of agentic-kit',
  'Help me release and deploy the next semantic version of agentic-kit please',
  'Help me release and deploy the next semantic release of agentic-kit',
  'Help me release and deploy the next semantic version of the agentic-kit',
  'Please help me release and deploy the next semantic version of agentic-kit',
  'Help me release and deploy the next semantic version of agentic-kit now',
];

function promptTurn(id, at, text) {
  return JSON.stringify({
    type: 'user', sessionId: id, cwd: '/tmp/prompts-fixture',
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function replyTurn(id, at) {
  return JSON.stringify({
    type: 'assistant', sessionId: id, cwd: '/tmp/prompts-fixture',
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 120, output_tokens: 40 },
      content: [{ type: 'text', text: 'on it' }],
    },
  });
}

function writePromptsCorpus(sb) {
  const projectDir = path.join(sb.home, '.claude', 'projects', '-tmp-prompts-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (id, lines) => fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.join('\n') + '\n');
  RELEASE_PHRASINGS.forEach((text, i) => {
    // Three distinct billed days across the six sessions, all recent.
    const at = Date.now() - (i % 3) * 86_400_000 - 3_600_000;
    const id = `prompts-release-${i}`;
    write(id, [promptTurn(id, at, text), replyTurn(id, at + 30_000), promptTurn(id, at + 60_000, 'yes'), replyTurn(id, at + 90_000)]);
  });
  // One session that asks the same substantive thing twice, one turn apart.
  const reAskAt = Date.now() - 2 * 3_600_000;
  const reAsk = 'Please run the whole verification suite and report which checks failed';
  write('prompts-reask', [
    promptTurn('prompts-reask', reAskAt, reAsk),
    replyTurn('prompts-reask', reAskAt + 10_000),
    promptTurn('prompts-reask', reAskAt + 20_000, `${reAsk} again`),
    replyTurn('prompts-reask', reAskAt + 30_000),
  ]);
  // One hand-typed role assignment — the shape the persona flag exists for.
  const personaAt = Date.now() - 3_600_000;
  const persona = 'You are a senior release engineer reviewing a changelog for accuracy';
  write('prompts-persona', [
    promptTurn('prompts-persona', personaAt, persona),
    replyTurn('prompts-persona', personaAt + 10_000),
  ]);
  return { projectDir, reAsk, persona };
}

/** Every file under `dir`, with a hash of its bytes — the shape a "this
 *  changed nothing" assertion needs. */
function treeDigest(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(full, createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function ak(args, sb, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    // Coaching adoption-detection (usage-outcome-ledger.mjs's
    // gatherAdoptionInputs) reads CLAUDE.md/.claude/skills off process.cwd() —
    // sandboxing HOME/XDG_CONFIG_HOME alone still leaves the subprocess's cwd
    // at wherever the test runner started, i.e. this repo's own CLAUDE.md.
    // `sb.home` is a fresh, empty tmpdir per test, so defaulting cwd there
    // makes every test hermetic against this repo's real adoption state; a
    // test that wants to plant a fixture CLAUDE.md sets `sb.cwd` explicitly.
    cwd: sb.cwd ?? sb.home,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: sb.home,
      USERPROFILE: sb.home,
      XDG_CONFIG_HOME: sb.cfg,
      APPDATA: sb.cfg,
      // The opencode transcript store is found at `$XDG_DATA_HOME/opencode/`
      // and only falls back to `$HOME/.local/share` when that variable is
      // UNSET (usage-opencode.defaultOpencodeDbPath). Sandboxing HOME alone
      // therefore leaks the real store into every assertion on a machine that
      // exports XDG_DATA_HOME — the fixture's counts would silently absorb
      // whatever the developer had actually typed into opencode.
      XDG_DATA_HOME: path.join(sb.home, '.local', 'share'),
      PATH: `${sb.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      OPENROUTER_MANAGEMENT_KEY: '',
      ...extra,
    },
  });
}

test('ak usage status is an offline cache read with no generic npm drift probe', () => {
  const sb = sandbox();
  const result = ak(['usage', 'status'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no local activity cache/i);
  assert.equal(fs.existsSync(sb.sentinel), false, 'offline status must never execute npm');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage refresh openrouter requires the dedicated management key', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'openrouter'], sb, {
    OPENROUTER_API_KEY: 'inference-only-key',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OPENROUTER_MANAGEMENT_KEY is required/);
  assert.equal(result.stdout.includes('inference-only-key'), false);
  assert.equal(fs.existsSync(sb.sentinel), false, 'failure must not fall through to npm drift');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage refresh openrouter --dry-run performs no network or writes', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'openrouter', '--dry-run', '--json'], sb, {
    OPENROUTER_MANAGEMENT_KEY: 'must-not-be-used',
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      dryRun: value.dryRun,
      action: value.action,
      provider: value.provider,
      network: value.network,
      writes: value.writes,
    },
    {
      dryRun: true,
      action: 'refresh',
      provider: 'openrouter',
      network: false,
      writes: false,
    },
  );
  assert.equal(fs.existsSync(path.join(sb.cfg, 'agentic-kit', 'openrouter-activity.json')), false);
  assert.equal(fs.existsSync(sb.sentinel), false);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage rejects unsupported providers and actions', () => {
  const sb = sandbox();
  const result = ak(['usage', 'refresh', 'unknown'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /usage: ak usage status/);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── score: offline text scorecard over the dashboard's own aggregate ────────

test('ak usage score prints the offline scorecard summary', () => {
  const sb = sandbox();
  writeScoreSession(sb, 'score-fixture-1');
  const result = ak(['usage', 'score'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AUTONOMY/, 'cadence must render an autonomy row');
  assert.match(result.stdout, /not-recorded/,
    'a session with no mode evidence must fold into an explicit not-recorded row');
  assert.doesNotMatch(result.stdout, /served by/i,
    'inference provider is per-session evidence, not one of the window tables');
  assert.match(result.stdout, /list price/i, 'the api-equivalent hero tile must carry the list-price disclaimer');
  assert.match(result.stdout, /not plan billing/, 'the disclaimer must say this is not plan billing');
  assert.match(result.stdout, /<\$0\.01/,
    'a real sub-cent priced session (1 input + 1 output token) must render as <$0.01, never $0.00');
  assert.equal(fs.existsSync(sb.sentinel), false, 'score must never execute npm — offline only');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// Section headings are Sentence case, the same tier and the same argument as
// the dashboard panel titles they mirror. The command banner is not a section
// heading and keeps the CLI's own spelling.
test('ak usage score section headings are sentence-cased; the command banner is not', () => {
  const sb = sandbox();
  writeScoreSession(sb, 'score-fixture-headings');
  const result = ak(['usage', 'score'], sb);
  assert.equal(result.status, 0, result.stderr);
  for (const heading of [
    'Cadence',
    'Your rhythm — session length',
    'Mode — permission posture',
    'Reliability — turns that never landed',
  ]) assert.ok(result.stdout.includes(heading), `missing heading ${JSON.stringify(heading)}`);
  assert.match(result.stdout, /ak usage — scorecard \(last \d+d\)/,
    'the command banner keeps its own spelling');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage score --json emits the aggregate projection verbatim', () => {
  const sb = sandbox();
  writeScoreSession(sb, 'score-fixture-2');
  const result = ak(['usage', 'score', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value),
    ['window', 'totals', 'rhythm', 'byMode', 'bySource', 'promptBaselines', 'previous']);
  assert.equal(value.window, 14, 'default window is 14 days');
  assert.equal(value.totals.sessions, 1);
  // Latency histogram is a FIXED 6-slot shape (5 edges + one overflow bucket) —
  // structurally always this length, whether or not any session observed a
  // latency sample, so this assertion needs no additional fixture tuning.
  assert.equal(value.rhythm.latHist.length, 6);
  const allowedModes = new Set([...MODES, 'not-recorded']);
  for (const key of Object.keys(value.byMode)) {
    assert.ok(allowedModes.has(key), `byMode key '${key}' must be in the closed mode taxonomy or 'not-recorded'`);
  }
  assert.ok(Object.hasOwn(value.byMode, 'not-recorded'), 'the fixture session carries no mode evidence');
  assert.ok(value.totals.costPerSessionMedian > 0 && value.totals.costPerSessionMedian < 0.01,
    'the fixture session is priced sub-cent');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// The personal baseline is a p75 over the BASELINE_TRAILING_DAYS (90) that
// precede the DISPLAYED window, so a 14-day report needs 104 days of records
// read off disk. `lookbackDays: windowDays * 2` read 28 — the previous window
// and nothing else — so `promptBaselines` was structurally null on every real
// corpus, and the tap-share detector silently fell back to an absolute
// threshold it is specified never to use when a personal one exists.
test('ak usage score reads back far enough to build the personal tap-share baseline', () => {
  const sb = sandbox();
  writeScoreSession(sb, 'score-baseline-current');
  // 32 distinct days, all older than the 14-day display window and inside the
  // trailing 90 — one more than BASELINE_MIN_ACTIVE_DAYS (30) asks for.
  writeHistorySessions(sb, { from: 20, to: 51 });
  const result = ak(['usage', 'score', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  const claude = value.promptBaselines?.claude;
  assert.ok(claude, 'the trailing history is all Claude, so it must have a baseline row');
  assert.notEqual(claude.tapShareP75_trailing90d, null,
    'a null baseline over 32 active days means the lookback never read them off disk');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage score --window 9 rejects an unsupported window cleanly', () => {
  const sb = sandbox();
  const result = ak(['usage', 'score', '--window', '9'], sb);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /--window/);
  assert.match(result.stdout, /7.*14.*30|30.*14.*7/, 'the error must name the supported windows');
  assert.equal(fs.existsSync(sb.sentinel), false);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// The <$0.01 rendering rule itself (a positive figure that rounds away at two
// decimals must not print as $0.00) is exercised end-to-end by the fixture
// test above via a REAL priced session; this test additionally pins the exact
// boundary (a true $0 stays "$0.00", never "<$0.01") that the fixture's single
// data point cannot demonstrate on its own — both a real sub-cent session AND
// a true-zero session are needed to prove the branch, and constructing a
// SECOND fixture transcript whose priced total is exactly zero is
// disproportionate (a session prices to exactly $0 only by carrying no usage
// rows at all, which the aggregate already excludes from the priced set —
// so this checks the pure formatter directly instead of a fixture.
test('formatCostMin ("<$0.01" boundary) — true zero is never rendered as sub-cent', async () => {
  const { __test } = await import('../../src/commands/usage.mjs');
  assert.equal(__test.fmtUsdMin(0), '$0.00', 'a true zero is not "less than a cent" — it is nothing');
  assert.equal(__test.fmtUsdMin(0.00003), '<$0.01', 'a real positive figure under a cent is not $0.00');
  assert.equal(__test.fmtUsdMin(0.02), '$0.02', 'a figure that does not round away renders normally');
});

// ── prompts: the fingerprint-derived pattern report ─────────────────────────

test('ak usage prompts reports every section from fingerprints alone', () => {
  const sb = sandbox();
  writePromptsCorpus(sb);
  const result = ak(['usage', 'prompts'], sb);
  assert.equal(result.status, 0, result.stderr);
  for (const heading of [
    'Typed prompts',
    'Supervision taps',
    'Host interplay',
    'Recurring clusters',
    'Re-asks',
    'Headless share',
  ]) assert.ok(result.stdout.includes(heading), `missing section ${JSON.stringify(heading)}`);
  assert.match(result.stdout, /ak usage — prompts \(all history\)/,
    'the default window is all history — patterns are lifetime phenomena');
  assert.equal(fs.existsSync(sb.sentinel), false, 'prompts must never execute npm — offline only');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --json is fingerprint-derived and carries no prompt text', () => {
  const sb = sandbox();
  writePromptsCorpus(sb);
  const result = ak(['usage', 'prompts', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value),
    ['window', 'windowDays', 'generatedAt', 'sessions', 'typed', 'hosts', 'patterns', 'headless', 'coaching']);
  assert.equal(value.window, 'all');
  // `patterns` is the aggregate's own promptPatterns projection, verbatim —
  // the same object the dashboard reads, not a CLI-side reshaping of it.
  assert.deepEqual(Object.keys(value.patterns).sort(),
    ['clusters', 'computedAt', 'corpus', 'exactRepeats', 'provenance', 'reAsks', 'tapLengths']);
  // The six release phrasings differ by one token each, so they cluster at the
  // panel's loose threshold and span six sessions — recurring on both arms of
  // the disjunction, not just one.
  const release = value.patterns.clusters.find((c) => c.count >= 6);
  assert.ok(release, `no recurring cluster found in ${JSON.stringify(value.patterns.clusters)}`);
  assert.equal(release.sessions, 6);
  assert.ok(release.days >= 3, 'the fixture spreads the cluster over three billed days');
  assert.equal(release.class, 'instruction', 'the release phrasings carry no question mark');
  assert.equal(value.patterns.reAsks.pairCount, 1, 'the fixture asks one thing twice, one turn apart');
  assert.equal(value.patterns.reAsks.gapHist['1'], 1, 'and the gap is one turn');
  // The privacy contract, asserted on the payload rather than argued for: this
  // projection is built from hashes, counts and token counts only.
  assert.equal(result.stdout.includes('semantic version'), false, 'cluster text must never reach --json');
  assert.equal(result.stdout.includes('verification suite'), false, 're-ask text must never reach --json');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --window accepts 7/14/30/all and rejects anything else', () => {
  const sb = sandbox();
  writePromptsCorpus(sb);
  for (const w of ['7', '14', '30', 'all']) {
    const okResult = ak(['usage', 'prompts', '--window', w, '--json'], sb);
    assert.equal(okResult.status, 0, `--window ${w} must be accepted: ${okResult.stderr}`);
    assert.equal(JSON.parse(okResult.stdout).window, w === 'all' ? 'all' : Number(w));
  }
  const bad = ak(['usage', 'prompts', '--window', '9'], sb);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /--window/);
  assert.match(bad.stdout, /all/, 'the error must name the all-history option');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// An empty corpus has measured nothing, which is a different claim from
// "measured zero" — the report says so rather than printing a table of 0s.
test('ak usage prompts says no samples rather than zero when nothing was fingerprinted', () => {
  const sb = sandbox();
  const result = ak(['usage', 'prompts'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no samples/,
    'an empty corpus must report no samples, never a measured zero');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── prompts: coaching cards + the outcome ledger (spec §5, §6.4) ───────────

/** A corpus shaped to fire two of the six v1 cards through the real pipeline:
 *  a "commit and push" family short/imperative/6-session/3-day enough to
 *  seed-match `commit-and-push` (so commit-push-claude-md's count>=5 bar
 *  clears), and ten same-session re-asks (so reask-delta's pairCount>=10 bar
 *  clears — and, being draftless, exercises the "known id, no draft" error
 *  path `--draft` has to cover). */
const COMMIT_PUSH_PHRASINGS = [
  'Commit and push', 'Commit push', 'Please commit and push',
  'Commit and push now', 'Commit and push it', 'Commit and push please',
];

function writeCoachingCorpus(sb) {
  const projectDir = path.join(sb.home, '.claude', 'projects', '-tmp-coaching-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (id, lines) => fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.join('\n') + '\n');
  COMMIT_PUSH_PHRASINGS.forEach((text, i) => {
    const at = Date.now() - (i % 3) * 86_400_000 - 3_600_000;
    const id = `coaching-commit-${i}`;
    write(id, [promptTurn(id, at, text), replyTurn(id, at + 10_000)]);
  });
  for (let i = 0; i < 10; i++) {
    const at = Date.now() - i * 3_600_000 - 7_200_000;
    const id = `coaching-reask-${i}`;
    const ask = `Please summarize the release notes for milestone ${i}`;
    write(id, [
      promptTurn(id, at, ask), replyTurn(id, at + 10_000),
      promptTurn(id, at + 20_000, `${ask} again`), replyTurn(id, at + 30_000),
    ]);
  }
}

test('ak usage prompts renders the Coaching section with a real proposed card', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Coaching'), 'missing the Coaching heading');
  assert.ok(result.stdout.includes('Commit-and-push is retyped, not remembered'),
    'the commit-push-claude-md card title did not render');
  assert.match(result.stdout, /Try:/);
  assert.match(result.stdout, /Basis:/);
  assert.match(result.stdout, /Status: proposed/);
  assert.match(result.stdout, /Draft → ak usage prompts --draft commit-push-claude-md/);
  assert.match(result.stdout, /Dismiss → ak usage prompts --dismiss commit-push-claude-md/);
  assert.equal(result.stdout.includes('Commit and push'), false, 'prompt text must never reach the coaching section');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --json coaching cards carry no prompt text and match the CLI summary shape', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(value.coaching, 'the --json payload must carry a coaching key');
  // Fix round 1, M-2: one name on both surfaces — `summary`, matching the
  // dashboard payload (this used to be `ledgerSummary` here).
  assert.deepEqual(Object.keys(value.coaching).sort(), ['cards', 'summary']);
  const card = value.coaching.cards.find((c) => c.id === 'commit-push-claude-md');
  assert.ok(card);
  assert.equal(card.status, 'proposed');
  // Fix round 1, M-3: generatedAt + evidenceHash ride in --json too (they
  // always did structurally; this pins that they still do post-refactor).
  assert.match(card.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(card.evidenceHash, /^[0-9a-f]{16}$/);
  assert.equal(value.coaching.summary.proposed >= 1, true);
  for (const p of COMMIT_PUSH_PHRASINGS) assert.equal(result.stdout.includes(p), false, `prompt text "${p}" leaked into --json`);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --draft <id> prints the draft verbatim and nothing else', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--draft', 'commit-push-claude-md'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0, 'the draft must print something');
  assert.doesNotMatch(result.stdout, /^ak usage/, 'the report banner must not print alongside a draft');
  assert.doesNotMatch(result.stdout, /Coaching\n/);
  assert.match(result.stdout, /commit and push it/i);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --draft <id> --json emits {id, kind, text}', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--draft', 'commit-push-claude-md', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['id', 'kind', 'text']);
  assert.equal(value.id, 'commit-push-claude-md');
  assert.equal(value.kind, 'claude-md-line');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --draft <unknown-id> errors and lists the known ids', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--draft', 'not-a-real-card'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown card id/);
  assert.match(result.stdout, /commit-push-claude-md/, 'the error must list at least one known id');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --draft <id-with-no-draft> errors and lists ONLY draft-bearing ids', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--draft', 'reask-delta'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /has no draft/);
  assert.match(result.stdout, /commit-push-claude-md/, 'the error must offer a card that DOES have a draft');
  assert.doesNotMatch(result.stdout, /reask-delta,|reask-delta$/m, 'the draftless card itself must not appear in its own "cards with a draft" list');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --dismiss <id> persists across invocations and survives a rescan', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const dismiss = ak(['usage', 'prompts', '--dismiss', 'commit-push-claude-md'], sb);
  assert.equal(dismiss.status, 0, dismiss.stderr);
  assert.match(dismiss.stdout, /Dismissed 'commit-push-claude-md'/);
  const ledgerFile = path.join(sb.cfg, 'agentic-kit', 'usage-outcome-ledger.json');
  assert.ok(fs.existsSync(ledgerFile), 'the ledger file must be written under the sandboxed config dir');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.version, 1);
  assert.equal(ledger.records.find((r) => r.id === 'commit-push-claude-md').status, 'dismissed');

  const rescan = ak(['usage', 'prompts'], sb);
  assert.equal(rescan.status, 0, rescan.stderr);
  assert.match(rescan.stdout, /Status: dismissed/, 'a fresh process must read back the persisted dismissal');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --dismiss <id> --json emits a confirmation, not the full report', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--dismiss', 'commit-push-claude-md', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value, { id: 'commit-push-claude-md', status: 'dismissed', dismissCount: 1 });
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// Fix round 1, M-7: the id is validated BEFORE any ledger write — an invalid
// --dismiss must not trigger even the routine reconcile-save, so a first-ever
// invocation with a bad id leaves no ledger file at all.
test('ak usage prompts --dismiss <unknown-id> errors and writes NOTHING — no ledger file at all on a first run', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--dismiss', 'not-a-real-card'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown card id/);
  const ledgerFile = path.join(sb.cfg, 'agentic-kit', 'usage-outcome-ledger.json');
  assert.equal(fs.existsSync(ledgerFile), false, 'an invalid --dismiss must not create the ledger file');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --dismiss <unknown-id> leaves an EXISTING ledger byte-for-byte unchanged', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  assert.equal(ak(['usage', 'prompts'], sb).status, 0); // establishes a real ledger file
  const ledgerFile = path.join(sb.cfg, 'agentic-kit', 'usage-outcome-ledger.json');
  const before = fs.readFileSync(ledgerFile, 'utf8');

  const result = ak(['usage', 'prompts', '--dismiss', 'not-a-real-card'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /unknown card id/);
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before, 'an invalid --dismiss must not touch an existing ledger, not even a routine reconcile-write');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// Fix round 1, M-7: rejected before any I/O, so neither write can silently win.
test('ak usage prompts --draft and --dismiss together are rejected before any I/O, exit 2, no write', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const result = ak(['usage', 'prompts', '--draft', 'commit-push-claude-md', '--dismiss', 'commit-push-claude-md'], sb);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--draft and --dismiss cannot be combined/);
  const ledgerFile = path.join(sb.cfg, 'agentic-kit', 'usage-outcome-ledger.json');
  assert.equal(fs.existsSync(ledgerFile), false, 'the combined-flags rejection must not touch the ledger at all');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// Fix round 1, I-2: an older `ak` must never destroy a well-formed ledger a
// newer schema wrote — that would silently resurrect every dismissed card.
test('ak usage prompts renders "coaching unavailable" and leaves a future-schema ledger untouched', () => {
  const sb = sandbox();
  writeCoachingCorpus(sb);
  const ledgerDir = path.join(sb.cfg, 'agentic-kit');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledgerFile = path.join(ledgerDir, 'usage-outcome-ledger.json');
  const futureLedger = {
    version: 2,
    records: [{ id: 'commit-push-claude-md', evidenceHash: 'f'.repeat(16), status: 'dismissed', dismissCount: 3 }],
  };
  fs.writeFileSync(ledgerFile, JSON.stringify(futureLedger));

  const result = ak(['usage', 'prompts'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /newer schema \(v2\)/);
  assert.match(result.stdout, /coaching is unavailable this run/);
  assert.equal(result.stdout.includes('Commit-and-push is retyped'), false, 'no card renders when coaching is unavailable');
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')), futureLedger,
    'a future-schema ledger must be left byte-for-byte untouched, never overwritten');

  const dismissAttempt = ak(['usage', 'prompts', '--dismiss', 'commit-push-claude-md'], sb);
  assert.equal(dismissAttempt.status, 2, '--dismiss against an unreadable-schema ledger must fail closed');
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')), futureLedger);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── C-1 repro at the CLI level (fabrication now impossible) ─────────────────
//
// The controller's own repro scenario: a corpus whose behaviour is
// CONSTANT — the operator changes nothing — observed under two different
// `--window` values. Before this fix, switching --window alone fabricated an
// adoption. After it, ledger-facing reads always come from the canonical
// 30-day aggregate, so a display-only window switch cannot move the ledger.
function writeSteadyCommitPushCorpus(sb, days) {
  const projectDir = path.join(sb.home, '.claude', 'projects', '-tmp-c1-repro-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (id, lines) => fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.join('\n') + '\n');
  for (let i = 0; i < days; i++) {
    const text = COMMIT_PUSH_PHRASINGS[i % COMMIT_PUSH_PHRASINGS.length];
    const at = Date.now() - i * 86_400_000 - 3_600_000;
    const id = `c1-repro-${i}`;
    write(id, [promptTurn(id, at, text), replyTurn(id, at + 10_000)]);
  }
}

test('C-1 repro at the CLI: switching --window alone cannot fabricate an adoption, an outcome, or a retirement', () => {
  const sb = sandbox();
  // One commit-and-push session per day for 40 days — a steady-rate corpus
  // the operator never changes, mirroring the controller's own repro.
  writeSteadyCommitPushCorpus(sb, 40);

  // Run 1: default (all-history) window — proposes.
  const run1 = ak(['usage', 'prompts', '--json'], sb);
  assert.equal(run1.status, 0, run1.stderr);
  const card1 = JSON.parse(run1.stdout).coaching.cards.find((c) => c.id === 'commit-push-claude-md');
  assert.ok(card1, 'the steady corpus must clear the seed\'s own shape bar at the default window');
  assert.equal(card1.status, 'proposed');

  // Run 2: the operator switches to --window 7. NOTHING about the corpus
  // changed. The DISPLAYED basis is allowed to differ (it honors the
  // window); the STATUS must not, because the ledger never compares against
  // the displayed count.
  const run2 = ak(['usage', 'prompts', '--window', '7', '--json'], sb);
  assert.equal(run2.status, 0, run2.stderr);
  const card2 = JSON.parse(run2.stdout).coaching.cards.find((c) => c.id === 'commit-push-claude-md');
  assert.ok(card2);
  assert.equal(card2.status, 'proposed', 'a --window switch alone must never fabricate an adoption');
  assert.equal(card2.outcome, null, 'no outcome may exist — nothing was ever adopted');

  // Run 3: back to the default window — still proposed, still no outcome.
  const run3 = ak(['usage', 'prompts', '--json'], sb);
  const card3 = JSON.parse(run3.stdout).coaching.cards.find((c) => c.id === 'commit-push-claude-md');
  assert.equal(card3.status, 'proposed');
  assert.equal(card3.outcome, null);

  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --help documents --draft and --dismiss', () => {
  const sb = sandbox();
  const result = ak(['usage', '--help'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--draft/);
  assert.match(result.stdout, /--dismiss/);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── prompts --deep: the exemplar tables ─────────────────────────────────────

test('ak usage prompts --deep joins verbatim text to the fingerprint findings', () => {
  const sb = sandbox();
  const { reAsk, persona } = writePromptsCorpus(sb);
  const result = ak(['usage', 'prompts', '--deep'], sb);
  assert.equal(result.status, 0, result.stderr);
  for (const heading of [
    'Top short prompts',
    'Re-ask pairs',
    'Cluster exemplars',
    'Persona scaffolding',
  ]) assert.ok(result.stdout.includes(heading), `missing deep section ${JSON.stringify(heading)}`);
  assert.match(result.stdout, /deep pass: \d+ transcripts?, \d+\.\d+s/,
    'the deep pass must state what it cost, measured rather than estimated');
  assert.ok(result.stdout.includes(reAsk.slice(0, 40)), 're-ask exemplars must be verbatim');
  assert.ok(result.stdout.includes(persona.slice(0, 40)), 'the persona opener must be verbatim');
  assert.ok(result.stdout.includes('yes'), 'the top short prompt must be verbatim');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// The deep pass reads transcripts and prints their text to the terminal. That
// is the whole privacy boundary: nothing it reads may be written anywhere.
test('ak usage prompts --deep writes nothing and mutates nothing', () => {
  const sb = sandbox();
  writePromptsCorpus(sb);
  // Warm the index first, so the cache the aggregate tier rewrites is already
  // present and the comparison below isolates what the DEEP pass does.
  assert.equal(ak(['usage', 'prompts'], sb).status, 0);
  const before = treeDigest(sb.home);
  const result = ak(['usage', 'prompts', '--deep'], sb);
  assert.equal(result.status, 0, result.stderr);
  const after = treeDigest(sb.home);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(),
    'the deep pass must create no file anywhere under HOME');
  const cache = path.join(sb.cfg, 'agentic-kit', 'usage-index.json');
  for (const [file, digest] of before) {
    if (file === cache) continue;   // readIndex rewrites its own cache; that is the aggregate tier's write, not the deep pass's
    assert.equal(after.get(file), digest, `the deep pass modified ${file}`);
  }
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage prompts --deep --json carries exemplars under an explicit key', () => {
  const sb = sandbox();
  const { reAsk } = writePromptsCorpus(sb);
  const shallow = ak(['usage', 'prompts', '--json'], sb);
  assert.equal(shallow.status, 0, shallow.stderr);
  assert.equal(Object.hasOwn(JSON.parse(shallow.stdout), 'exemplars'), false,
    'the aggregate tier must never carry text, so it must not carry an exemplars key either');
  const deep = ak(['usage', 'prompts', '--deep', '--json'], sb);
  assert.equal(deep.status, 0, deep.stderr);
  const value = JSON.parse(deep.stdout);
  assert.deepEqual(Object.keys(value.exemplars).sort(),
    ['clusters', 'cost', 'personas', 'reAsks', 'shortPrompts', 'totals']);
  assert.ok(value.exemplars.totals.shortPrompts >= value.exemplars.shortPrompts.length,
    'the denominator a truncated table prints must travel with the rows');
  assert.ok(value.exemplars.reAsks.some((p) => p.ask.includes(reAsk.slice(0, 40))),
    're-ask text must reach --json at this tier, which is why the help says so');
  assert.ok(value.exemplars.cost.transcripts >= 1, 'the measured cost travels with the payload');
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── the help surface ────────────────────────────────────────────────────────

test('ak usage --help documents prompts, its windows, and what --deep prints', () => {
  const sb = sandbox();
  const result = ak(['usage', '--help'], sb);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ak usage prompts \[--window 7\|14\|30\|all\] \[--deep\] \[--json\]/);
  assert.match(result.stdout, /default all/, 'the unusual default has to be stated where it is read');
  assert.match(result.stdout, /--deep/);
  // The one thing a reader must not have to discover by accident.
  assert.match(result.stdout, /CONTAIN PROMPT TEXT/,
    '--deep --json puts prompt text in the payload; the help must say so before someone redirects it');
  assert.equal(fs.existsSync(sb.sentinel), false);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak usage <unknown> lists every subcommand it does have', () => {
  const sb = sandbox();
  const result = ak(['usage', 'frobnicate'], sb);
  assert.equal(result.status, 2);
  for (const sub of ['ak usage status', 'ak usage refresh openrouter', 'ak usage score', 'ak usage prompts']) {
    assert.ok(result.stdout.includes(sub), `the fallback listing omits ${JSON.stringify(sub)}`);
  }
  fs.rmSync(sb.home, { recursive: true, force: true });
});

test('ak --help advertises the offline reports, not only the provider cache', () => {
  const sb = sandbox();
  const result = ak(['--help'], sb);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find((l) => l.trim().startsWith('ak usage'));
  assert.ok(line, 'the top-level help must carry a usage line');
  assert.match(line, /score/);
  assert.match(line, /prompts/);
  fs.rmSync(sb.home, { recursive: true, force: true });
});

// ── the mask boundary, pinned on every path text can reach a terminal ───────
// `--deep` is the only tier that prints prompt text, and `maskSecrets` is the
// only thing standing between a pasted credential and the operator's scrollback.
// There are FIVE distinct routes to a printed exemplar and every one masks
// today; none was pinned, so a mask dropped from any single route would have
// been invisible to this suite. The failure mode is a live key on screen.

/** A key-shaped string `maskSecrets` recognises (`\bsk-[A-Za-z0-9_-]{12,}`),
 *  with a tail no other fixture or source file contains — so asserting the
 *  tail absent from stdout proves the RAW value never reached it, and cannot
 *  be satisfied by the masked form, which keeps the `sk-` prefix. */
const FIXTURE_SECRET = 'sk-ant-api03-ZZTESTFIXTUREKEY0000000000';
const SECRET_TAIL = 'ZZTESTFIXTUREKEY';
const MASKED = 'sk-…redacted';

/** A corpus that routes one secret through all five exemplar paths.
 *
 *  The fifth — `deepReAskRow`'s fallback, taken when the pair's own session
 *  could not be re-read — needs a transcript that survives in the index but
 *  fails to open. The test turns `mask-fallback.jsonl` into a DIRECTORY after
 *  the cache is warm: discovery skips it (`listClaude` requires `isFile`),
 *  carry-forward keeps its cached record (`statSafe` succeeds on a directory),
 *  and `readFileSync` throws EISDIR — portable, and true for every user,
 *  unlike a chmod that root would ignore. Its two prompts are PERSONA-shaped
 *  so both their hashes are in the wanted set and resolve from the readable
 *  twins below, which is what makes the fallback print masked text rather
 *  than 'transcript unavailable'. */
function writeMaskCorpus(sb) {
  const dir = path.join(sb.home, '.claude', 'projects', '-tmp-mask-fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = (id) => path.join(dir, `${id}.jsonl`);
  const write = (id, prompts) => {
    const at = Date.now() - 3_600_000;
    const lines = [];
    prompts.forEach((text, i) => {
      lines.push(promptTurn(id, at + i * 20_000, text), replyTurn(id, at + i * 20_000 + 10_000));
    });
    fs.writeFileSync(file(id), lines.join('\n') + '\n');
  };
  const rotate = `Rotate ${FIXTURE_SECRET} in the deploy vault`;
  const persona = `You are a release bot. Publish with ${FIXTURE_SECRET} now`;
  // 1 — short prompts: the whole prompt is the key, one normalized token.
  write('mask-short-1', [FIXTURE_SECRET]);
  write('mask-short-2', [FIXTURE_SECRET]);
  // 2 — cluster exemplars: a recurring family, three sessions.
  write('mask-cluster-1', [rotate]);
  write('mask-cluster-2', [`${rotate} today`]);
  write('mask-cluster-3', [rotate]);
  // 3 — persona openers, and the readable twins the fallback resolves through.
  write('mask-persona-1', [persona]);
  write('mask-persona-2', [`${persona} please`]);
  // 4 — a re-ask whose own session IS readable, so both halves are located.
  write('mask-reask', [
    `Publish ${FIXTURE_SECRET} to the internal registry`,
    `Publish ${FIXTURE_SECRET} to the internal registry again`,
  ]);
  // 5 — the fallback: same two persona texts, one session, this file goes away.
  write('mask-fallback', [persona, `${persona} please`]);
  return { fallbackFile: file('mask-fallback') };
}

/** The lines of one `--deep` section, up to the next section heading. */
function section(stdout, title) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.trim() === title);
  assert.notEqual(start, -1, `no ${JSON.stringify(title)} section in output`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Z][a-z]/.test(l) && !l.startsWith('ℹ'));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

test('ak usage prompts --deep masks secrets on every path text can reach the terminal', () => {
  const sb = sandbox();
  const { fallbackFile } = writeMaskCorpus(sb);
  // Warm the index while the fallback transcript is still a readable file.
  assert.equal(ak(['usage', 'prompts'], sb).status, 0);
  fs.rmSync(fallbackFile);
  fs.mkdirSync(fallbackFile);

  const result = ak(['usage', 'prompts', '--deep'], sb);
  assert.equal(result.status, 0, result.stderr);

  // The whole-output claim first: the raw key never reaches a terminal at all.
  assert.equal(result.stdout.includes(SECRET_TAIL), false,
    'the raw key reached stdout — a mask was dropped somewhere on the deep path');

  // …then each path individually, so a mask dropped from ONE of them fails here
  // rather than hiding behind the others.
  for (const title of ['Top short prompts', 'Cluster exemplars', 'Persona scaffolding']) {
    assert.ok(section(result.stdout, title).includes(MASKED),
      `${title} did not render the masked key — the exemplarText path is unpinned there`);
  }

  const reAsks = section(result.stdout, 'Re-ask pairs');
  const located = reAsks.split('\n').filter((l) => l.includes('min apart'));
  assert.ok(located.length, `no located re-ask row in:\n${reAsks}`);
  const askLines = reAsks.split('\n').filter((l) => l.includes('ask   '));
  const againLines = reAsks.split('\n').filter((l) => l.includes('again '));
  assert.ok(askLines.some((l) => l.includes(MASKED)), 'the located ask is unmasked');
  assert.ok(againLines.some((l) => l.includes(MASKED)), 'the located re-ask is unmasked');

  // The fallback sub-path: the pair's own transcript could not be re-read, so
  // the text came from `exemplarText` against another session — still masked.
  const notLocated = reAsks.split('\n').findIndex((l) => l.includes('timing not located'));
  assert.notEqual(notLocated, -1,
    `the unreadable transcript must produce an unlocated pair:\n${reAsks}`);
  assert.ok(reAsks.split('\n')[notLocated + 1].includes(MASKED),
    'the fallback ask is unmasked — exemplarText was reached without maskSecrets');

  fs.rmSync(sb.home, { recursive: true, force: true });
});
