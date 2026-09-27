// `ak sync`'s exit code reflects only what sync can repair (maintainer
// decision 10, 2026-09-26; ADR-0033 §9). A fail- or warn-level status row whose
// fix is manual never flips sync's exit code or its converged verdict, whether
// or not the plan is empty. Every such row is listed after the verdict under
// "needs your action" (text) and in `needsYourAction` (--json). Before this,
// the same manual fail row exited 0 on its own and 1 next to any unrelated
// planned fix, so a CI gate on `ak sync` depended on unrelated drift.
//
// The runs stay hermetic the way tests/kit/sync-command.test.mjs does: the
// only planned subsystem is `aqe`, whose step (healRvf) scans the sandbox
// project's missing .agentic-qe directory. --json runs spawn a child so its
// real stdout and stderr can be read apart (sync swaps process.stdout.write
// under --json, which must not happen inside the test runner's own process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot, spawnEnv,
} from './helpers/home-sandbox.mjs';
import { isolateProject } from './helpers/project-isolation.mjs';

const HOME = sandboxHome('ak-sync-needs-action');
const paths = await import('../../src/lib/paths.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { row } = await import('../../src/commands/status/row.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);
isolateProject('ak-sync-needs-action');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-sync-needs-action');
const FLAGS = (over = {}) => ({ 'dry-run': false, 'no-upgrade': true, yes: false, json: false, ...over });
const HEADING = /needs your action/g;

const RVF_FIX = 'sync quarantines them (aqe rebuilds the store)';
// A hand fix (the repair contract's 'manual'): sync never plans or performs it.
const MANUAL_FAIL = row('memory-pin', 'fail', 'CLAUDE_FLOW_DB_PATH pins a missing store',
  'repoint it in .claude/settings.local.json env, or remove the pin', { repair: 'manual' });
const MANUAL_WARN = row('codex-context', 'warn', 'Codex context file is not ak-owned',
  'review ~/.codex/AGENTS.md yourself', { repair: 'manual' });
const MANUAL_INFO = row('aqe', 'info', 'readiness unverified', 'run: ak x verify aqe', { repair: 'manual' });
// A sync repair: the aqe-rvf step performs it.
const RVF_WARN = row('aqe', 'warn', 'store oversized', RVF_FIX);
const RVF_FAIL = row('aqe', 'fail', 'store still oversized', RVF_FIX);

/** What --json reports for a needs-your-action row: exactly these four fields. */
const listed = (r) => ({ subsystem: r.subsystem, level: r.level, message: r.message, fix: r.fix });

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, {}));
}

/** A collectFn that returns `first` for the plan and `after` for the proof. */
function twoPhase(first, after = first) {
  let calls = 0;
  return async () => (calls++ === 0 ? first : after);
}

/** Text-mode `ak sync` from the sandbox project. */
async function syncText(collectFn, over = {}) {
  const prior = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => sync.run({ flags: FLAGS(over), pkgRoot: PKG_ROOT, collectFn }));
  } finally { process.chdir(prior); }
}

const moduleUrl = (rel) => pathToFileURL(path.join(PKG_ROOT, rel)).href;

/** `ak sync --json` in a child whose collector returns `first`, then `after`
 *  (or throws). Returns the child plus its parsed stdout, which must be one
 *  JSON object. */
function syncJson({ first = [], after = first, flags = {}, throws = false }) {
  const root = fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });
  const script = `
    const paths = await import(${JSON.stringify(moduleUrl('src/lib/paths.mjs'))});
    paths._setGlobalRootForTest(${JSON.stringify(root)});
    const sync = await import(${JSON.stringify(moduleUrl('src/commands/sync.mjs'))});
    const { exitWhenFlushed } = await import(${JSON.stringify(moduleUrl('src/lib/output.mjs'))});
    const first = ${JSON.stringify(first)};
    const after = ${JSON.stringify(after)};
    let calls = 0;
    const collectFn = async () => {
      ${throws ? "throw new Error('collector exploded');" : ''}
      return calls++ === 0 ? first : after;
    };
    exitWhenFlushed(await sync.run({ flags: ${JSON.stringify(FLAGS({ json: true, ...flags }))},
      pkgRoot: ${JSON.stringify(PKG_ROOT)}, collectFn }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT, env: spawnEnv(HOME), encoding: 'utf8', timeout: 120_000,
  });
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  return { child, out: JSON.parse(child.stdout) };
}

const SHAPE = ['plan', 'steps', 'unresolved', 'skipped', 'needsYourAction', 'converged', 'exitCode'];

// ── scenario A: a manual fail row alone ──────────────────────────────────────

test('A: a manual fail row alone leaves sync converged with exit 0 and lists it as needing your action', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_FAIL]));
  assert.equal(text.result, 0, text.out);
  assert.equal(text.out.match(HEADING)?.length, 1, `the heading prints once:\n${text.out}`);
  assert.match(text.out, /\[memory-pin\] CLAUDE_FLOW_DB_PATH pins a missing store/);
  assert.ok(text.out.search(/nothing sync can do/) < text.out.search(HEADING), 'listed after the verdict');

  const { child, out } = syncJson({ first: [MANUAL_FAIL] });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(out.exitCode, 0);
  assert.equal(out.converged, true);
  assert.deepEqual(out.unresolved, []);
  assert.deepEqual(out.needsYourAction, [listed(MANUAL_FAIL)]);
  assert.equal(child.stderr.match(HEADING)?.length, 1, 'under --json the heading goes to stderr, once');
});

// ── scenario B: the same row next to an unrelated sync fix that converges ────

test('B: an unrelated planned fix that converges does not turn the manual fail row into a failure', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_FAIL, RVF_WARN], [MANUAL_FAIL]));
  assert.equal(text.result, 0, text.out);
  assert.doesNotMatch(text.out, /still failing:|unresolved:/);
  assert.match(text.out, /converged/);
  assert.doesNotMatch(text.out, /no failing subsystems/, 'a failing manual row is still failing; the verdict must not deny it');
  assert.equal(text.out.match(HEADING)?.length, 1, `the heading prints once:\n${text.out}`);
  assert.ok(text.out.search(/converged/) < text.out.search(HEADING), 'listed after the verdict');

  const { child, out } = syncJson({ first: [MANUAL_FAIL, RVF_WARN], after: [MANUAL_FAIL] });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(out.exitCode, 0);
  assert.equal(out.converged, true);
  assert.deepEqual(out.plan.map((p) => p.subsystem), ['aqe']);
  assert.deepEqual(out.unresolved, []);
  assert.deepEqual(out.needsYourAction, [listed(MANUAL_FAIL)]);
});

test('a manual warn row is listed too, and the healthy verdict wording stays when no manual row fails', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_WARN, RVF_WARN], [MANUAL_WARN]));
  assert.equal(text.result, 0, text.out);
  assert.match(text.out, /converged — no failing subsystems/);
  assert.equal(text.out.match(HEADING)?.length, 1, text.out);
  assert.match(text.out, /\[codex-context\] Codex context file is not ak-owned/);
});

test('an info-level manual row alone is invisible to the manual-step note: sync reports the machine healthy', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_INFO]));
  assert.equal(text.result, 0, text.out);
  assert.match(text.out, /nothing to do — all subsystems healthy/, text.out);
  assert.doesNotMatch(text.out, /item\(s\) need a manual step/, 'an info row is not a "needs your action" item, so it never seeds the count');
  assert.doesNotMatch(text.out, HEADING);
});

// ── minor 4: the manual-step count and the needs-your-action list must agree ─

test('the manual-step note counts only the failing/warning rows the heading lists, never an info row next to them', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_FAIL, MANUAL_INFO]));
  assert.equal(text.result, 0, text.out);
  assert.match(text.out, /nothing sync can do — 1 item\(s\) need a manual step/, text.out);
  const heading = text.out.slice(text.out.search(HEADING));
  assert.equal((heading.match(/\[memory-pin\]|\[aqe\]/g) ?? []).length, 1, `exactly one row must follow the heading:\n${text.out}`);
  assert.match(heading, /\[memory-pin\]/);
});

test('the dim manual-step note next to a real plan also excludes the info row from its count', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_FAIL, MANUAL_INFO, RVF_WARN], [MANUAL_FAIL, MANUAL_INFO]));
  assert.equal(text.result, 0, text.out);
  assert.match(text.out, /1 item\(s\) need a manual step/, text.out);
  assert.doesNotMatch(text.out, /2 item\(s\) need a manual step/, text.out);

  const { child, out } = syncJson({ first: [MANUAL_FAIL, MANUAL_INFO, RVF_WARN], after: [MANUAL_FAIL, MANUAL_INFO] });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(out.needsYourAction, [listed(MANUAL_FAIL)], 'the info row never joins the list the count must match');
});

// ── scenario C: a sync-repairable fail row that does not converge ────────────

test('C: a sync repair that did not take still fails sync, and the manual row is still listed', async () => {
  seedHome();
  const text = await syncText(twoPhase([MANUAL_FAIL, RVF_FAIL]));
  assert.equal(text.result, 1, text.out);
  assert.match(text.out, /unresolved: \[aqe\] sync quarantines them/);
  assert.doesNotMatch(text.out, /still failing: \[memory-pin\]/, 'the manual row is never counted');
  assert.equal(text.out.match(HEADING)?.length, 1, text.out);

  const { child, out } = syncJson({ first: [MANUAL_FAIL, RVF_FAIL] });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(out.exitCode, 1);
  assert.equal(out.converged, false);
  assert.deepEqual(out.unresolved, [{ subsystem: 'aqe', fix: RVF_FIX, message: 'store still oversized', reason: 'not-converged' }]);
  assert.deepEqual(out.needsYourAction, [listed(MANUAL_FAIL)]);
});

// ── scenario D: --json carries needsYourAction on every path ─────────────────

test('D: --json always carries needsYourAction, in the documented key order', () => {
  seedHome();
  const cases = {
    'empty plan': syncJson({ first: [MANUAL_FAIL, MANUAL_WARN] }),
    'converged apply': syncJson({ first: [RVF_WARN, MANUAL_WARN], after: [MANUAL_WARN] }),
    unresolved: syncJson({ first: [RVF_FAIL] }),
    'dry run with a plan': syncJson({ first: [RVF_WARN, MANUAL_FAIL], flags: { 'dry-run': true } }),
    'rejected --skip': syncJson({ first: [MANUAL_FAIL], flags: { skip: ['natvies'] } }),
  };
  for (const [name, { out }] of Object.entries(cases)) {
    // A rejected flag also adds the documented `error` key after the shape.
    assert.deepEqual(Object.keys(out).filter((k) => k !== 'error'), SHAPE, `${name}: ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.needsYourAction), name);
  }
  assert.deepEqual(cases['empty plan'].out.needsYourAction, [listed(MANUAL_FAIL), listed(MANUAL_WARN)]);
  assert.deepEqual(cases['converged apply'].out.needsYourAction, [listed(MANUAL_WARN)]);
  assert.deepEqual(cases.unresolved.out.needsYourAction, []);
  assert.equal(cases['dry run with a plan'].out.converged, null);
  assert.deepEqual(cases['dry run with a plan'].out.needsYourAction, [listed(MANUAL_FAIL)]);
  assert.deepEqual(cases['rejected --skip'].out.needsYourAction, [], 'a rejected flag collects nothing');

  const thrown = syncJson({ throws: true });
  assert.equal(thrown.out.error, 'collector exploded');
  assert.ok(Object.hasOwn(thrown.out, 'needsYourAction'), JSON.stringify(thrown.out));
  assert.deepEqual(thrown.out.needsYourAction, []);
});

test('D: a declined Codex repair still lists the manual rows it collected', () => {
  seedHome(offlineKitConfig({
    integrations: { version: 2, hosts: { claude: true, codex: true, opencode: false }, bindings: [], ownership: {} },
  }));
  fs.mkdirSync(paths.codexDir(), { recursive: true });
  fs.writeFileSync(paths.codexConfigPath(), ['[mcp_servers.codex]', 'command = "codex"', 'args = ["mcp-server"]'].join('\n'));
  const recursive = row('codex-mcp', 'fail', 'recursive Codex registration', 'remove the recursive Codex MCP registration');
  const { child, out } = syncJson({ first: [recursive, MANUAL_FAIL] });
  assert.equal(child.status, 1, child.stderr);
  assert.deepEqual(out.unresolved.map((u) => u.reason), ['declined']);
  assert.deepEqual(out.needsYourAction, [listed(MANUAL_FAIL)]);
  assert.equal(child.stderr.match(HEADING)?.length, 1, child.stderr);
});

// ── the verdict itself ────────────────────────────────────────────────────────

test('convergenceVerdict never counts a manual row, with or without a plan', () => {
  const cfg = loadKitConfig();
  const flags = FLAGS();
  const state = { applyFailures: [] };
  for (const plan of [[], [RVF_WARN]]) {
    const verdict = sync.convergenceVerdict({ plan, after: [MANUAL_FAIL, MANUAL_WARN], state, flags, cfg });
    assert.deepEqual(verdict.unresolved, [], `plan of ${plan.length}`);
    assert.deepEqual(verdict.remaining, [], `plan of ${plan.length}`);
  }
  const dejaVu = row('deja-vu', 'warn', 'index stale', 'run: deja-vu index yourself', { repair: 'manual' });
  assert.deepEqual(sync.convergenceVerdict({ plan: [RVF_WARN], after: [dejaVu], state, flags, cfg }).remaining, [],
    'a manual deja-vu row is no exception');
  const control = row('memory-pin', 'fail', 'no fix known');
  assert.deepEqual(sync.convergenceVerdict({ plan: [RVF_WARN], after: [control], state, flags, cfg }).remaining.map((r) => r.subsystem),
    ['memory-pin'], 'control: a fail row without a manual fix still counts');
});

test('a manual fail row never hides a recorded apply failure for its own subsystem', () => {
  // Minor 3 (review-sync-exit.md): a manual row's subsystem is exactly the
  // subsystem a synthetic apply-failed entry names, so the `!remaining.some(...)`
  // guards in convergenceVerdict must add that entry even though `counts()`
  // already excludes the manual row itself from `remaining`.
  const cfg = loadKitConfig();
  const flags = FLAGS();
  const cases = [
    {
      manual: row('providers', 'fail', 'external intent unavailable', 'revoke the grant yourself', { repair: 'manual' }),
      state: { applyFailures: [], aqeRouterApplyFailure: 'boom' },
      expected: { subsystem: 'providers', message: 'AQE router apply failed: boom', reason: 'apply-failed' },
    },
    {
      manual: row('codex-mcp', 'fail', 'recursive Codex registration you own', 'remove it yourself', { repair: 'manual' }),
      state: { applyFailures: [], codexRepairFailure: 'Codex MCP repair was declined mid-run' },
      expected: { subsystem: 'codex-mcp', message: 'Codex MCP repair was declined mid-run', reason: 'apply-failed' },
    },
    {
      manual: row('deja-vu', 'fail', 'index owned outside the kit', 'rebuild it yourself', { repair: 'manual' }),
      state: { applyFailures: [], dejaVuApplyFailed: true },
      expected: { subsystem: 'deja-vu', message: 'companion lifecycle apply failed', reason: 'apply-failed' },
    },
  ];
  for (const { manual, state, expected } of cases) {
    const withFailure = sync.convergenceVerdict({ plan: [], after: [manual], state, flags, cfg });
    assert.deepEqual(withFailure.unresolved, [], expected.subsystem);
    assert.deepEqual(withFailure.remaining, [expected],
      `${expected.subsystem}: the manual row must not mask its subsystem's recorded apply failure`);

    const withoutFailure = sync.convergenceVerdict({
      plan: [], after: [manual], state: { applyFailures: [] }, flags, cfg,
    });
    assert.deepEqual(withoutFailure.remaining, [],
      `${expected.subsystem}: with no apply failure recorded, the manual row alone still stays out of remaining`);
  }
});

test('a skipped subsystem\'s manual row is not "skipped by request": sync never does it anyway', () => {
  const verdict = sync.convergenceVerdict({
    plan: [RVF_WARN], after: [MANUAL_FAIL], state: { applyFailures: [] }, flags: FLAGS(), cfg: loadKitConfig(),
    skip: new Set(['memory-pin']),
  });
  assert.deepEqual(verdict.skipped, []);
  assert.deepEqual(verdict.remaining, []);
});
