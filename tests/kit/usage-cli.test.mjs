import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function ak(args, sb, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: sb.home,
      USERPROFILE: sb.home,
      XDG_CONFIG_HOME: sb.cfg,
      APPDATA: sb.cfg,
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

test('ak usage score --json emits the aggregate projection verbatim', () => {
  const sb = sandbox();
  writeScoreSession(sb, 'score-fixture-2');
  const result = ak(['usage', 'score', '--json'], sb);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ['window', 'totals', 'rhythm', 'byMode', 'bySource', 'previous']);
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
