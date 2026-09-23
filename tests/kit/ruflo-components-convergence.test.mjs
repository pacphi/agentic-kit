// ADR-0058 §1-§4: status judges a component by what ak actually wrote before it
// consults ruflo's evidence. One test per user scenario from the final review (A-F),
// driven through the same read-only path `ak status` and the dashboard use:
// rufloComponentRows(rufloComponentsPayload(...)). Every path is injected into a
// throwaway directory; the home sandbox guards anything that falls back to paths.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-rc-convergence');
const paths = await import('../../src/lib/paths.mjs');
const { rufloComponentsPayload } = await import('../../src/lib/ruflo-components/snapshot.mjs');
const { rufloComponentRows } = await import('../../src/commands/status/sections/ruflo-components.mjs');
const { reconcileClaudeComponentEnv } = await import('../../src/lib/claude-env-projection.mjs');
const { reconcileRufloComponents } = await import('../../src/lib/ruflo-components/apply.mjs');
assertSandboxed(paths, HOME);

const now = Date.parse('2026-09-23T12:00:00Z');
const DEFAULTS = {
  typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
};
const cfgWith = (over = {}, ownership = {}) => ({
  integrations: { hosts: { claude: true }, ownership: { rufloComponents: ownership } },
  rufloComponents: { ...DEFAULTS, ...over },
});
// Evidence that confirms every component — the "ruflo would do it" view the probes give.
const confirming = (over = {}) => ({
  capturedAt: new Date(now - 60_000).toISOString(), rufloVersion: '3.44.0',
  typesafe: { resolves: true, doctor: { status: 'pass', name: 'typesafe router', detail: 'installed; enabled' } },
  minilm: { embedder: 'minilm' },
  learning: { mode: 'balanced', engineLoaded: true, lastTrainingSeconds: 10, trajectories: 5 },
  turnCredit: { present: true }, memoryFix: { version: '3.0.0-alpha.25' },
  funnel: { enabled: false, decidedBy: 'user-config' }, governance: { audit: { audited: 3, refused: 0, reasons: [] } },
  errors: {}, ...over,
});

function world(t) {
  const dir = fs.mkdtempSync(path.join(HOME, 'world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userSettingsFile = path.join(dir, 'claude', 'settings.json');
  const evidenceFile = path.join(dir, 'state', 'evidence.json');
  fs.mkdirSync(path.dirname(userSettingsFile), { recursive: true });
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  return {
    userSettingsFile,
    evidenceFile,
    settings: (doc) => fs.writeFileSync(userSettingsFile, typeof doc === 'string' ? doc : JSON.stringify(doc)),
    evidence: (e) => fs.writeFileSync(evidenceFile, JSON.stringify(e)),
    apply: (cfg) => reconcileClaudeComponentEnv(cfg, { userSettingsFile, rufloVersion: '3.44.0' }),
    rows: (cfg) => {
      const snap = rufloComponentsPayload({ cfg, rufloVersion: '3.44.0', projectRoot: null, evidenceFile, userSettingsFile, now });
      return { snap, rows: rufloComponentRows(snap) };
    },
  };
}
const rowFor = (rows, label) => rows.find((r) => r.message.startsWith(`${label} —`));
const stateOf = (snap, id) => snap.components.find((c) => c.id === id).state;

test('A: upgraded ak, nothing written, no evidence — the unwritten env components carry a sync fix', (t) => {
  const w = world(t);
  const { snap, rows } = w.rows(cfgWith());
  for (const [id, label] of [['typesafePicker', 'Typesafe agent picker'], ['minilmPicker', 'MiniLM agent picker'],
    ['learningProfile', 'Learning profile']]) {
    assert.equal(stateOf(snap, id).id, 'not-applied', id);
    assert.match(rowFor(rows, label).fix ?? '', /sync applies/, `${id} must reach the sync plan`);
  }
});

test('B: fresh confirming evidence but settings.json lacks the keys — never a false active', (t) => {
  const w = world(t);
  w.settings({});
  w.evidence(confirming());
  const { snap, rows } = w.rows(cfgWith());
  for (const id of ['typesafePicker', 'minilmPicker', 'learningProfile']) assert.equal(stateOf(snap, id).id, 'not-applied', id);
  assert.ok(rowFor(rows, 'MiniLM agent picker').fix);
});

test('C: a user-set typesafe value is preserved and the other keys are still applied', (t) => {
  const w = world(t);
  w.settings({ env: { CLAUDE_FLOW_ROUTER_TYPESAFE: '0' } });
  w.evidence(confirming());
  const before = w.rows(cfgWith());
  assert.equal(stateOf(before.snap, 'typesafePicker').id, 'user-managed');
  assert.equal(rowFor(before.rows, 'Typesafe agent picker').fix, null);
  assert.equal(stateOf(before.snap, 'minilmPicker').id, 'not-applied', 'not yet written is not active');
  assert.equal(w.apply(cfgWith()).ok, true);
  const env = JSON.parse(fs.readFileSync(w.userSettingsFile, 'utf8')).env;
  assert.deepEqual(env, { CLAUDE_FLOW_ROUTER_TYPESAFE: '0', CLAUDE_FLOW_ROUTER_EMBEDDER: 'minilm', RUFLO_INTELLIGENCE_MODE: 'balanced' });
  const after = w.rows(cfgWith());
  assert.equal(stateOf(after.snap, 'typesafePicker').id, 'user-managed');
  assert.equal(stateOf(after.snap, 'minilmPicker').id, 'active');
  assert.equal(stateOf(after.snap, 'learningProfile').id, 'active');
});

test('D: an invalid settings.json blocks every component projected into it', (t) => {
  const w = world(t);
  w.settings('{ not json');
  w.evidence(confirming());
  const { snap, rows } = w.rows(cfgWith());
  for (const id of ['typesafePicker', 'minilmPicker', 'learningProfile']) {
    assert.equal(stateOf(snap, id).id, 'blocked', id);
    assert.match(stateOf(snap, id).meaning, /invalid JSON/);
  }
  assert.equal(rowFor(rows, 'Learning profile').level, 'fail');
});

test('E: a dropped typesafe package reads not applied with a sync fix, not "restart"', (t) => {
  const w = world(t);
  w.apply(cfgWith());
  w.evidence(confirming({ typesafe: { resolves: false, doctor: { status: 'warn', name: 'typesafe router', detail: 'not installed' } } }));
  const { snap, rows } = w.rows(cfgWith());
  const state = stateOf(snap, 'typesafePicker');
  assert.equal(state.id, 'not-applied');
  assert.match(state.meaning, /reinstall/);
  assert.doesNotMatch(state.action, /Restart/);
  assert.ok(rowFor(rows, 'Typesafe agent picker').fix);
});

test('F: funnel handed back to ruflo while ak\'s disable is still in force carries a sync fix', (t) => {
  const w = world(t);
  w.apply(cfgWith());
  w.evidence(confirming());
  const { snap, rows } = w.rows(cfgWith({ funnel: true }, { funnelDisabled: true }));
  assert.equal(stateOf(snap, 'funnel').id, 'not-applied');
  assert.match(stateOf(snap, 'funnel').meaning, /ruflo funnel disable/);
  assert.ok(rowFor(rows, 'Ruflo funnel (promotions)').fix);
  // Without ak's receipt the funnel is simply the user's.
  assert.equal(stateOf(w.rows(cfgWith({ funnel: true })).snap, 'funnel').id, 'user-managed');
});

test('F: sync releases ak\'s funnel disable once the user sets funnel: true', async (t) => {
  const w = world(t);
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'funnel' && args[1] === 'status') {
      return { code: 0, stdout: JSON.stringify({ enabled: false, decidedBy: 'user-config' }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const cfg = cfgWith({ typesafePicker: false, minilmPicker: false, learningProfile: false, mcpGovernance: false, funnel: true },
    { funnelDisabled: true });
  await reconcileRufloComponents(cfg, {
    cwd: HOME, projectRoot: null, runner, rufloVersion: '3.44.0', refresh: false,
    userSettingsFile: w.userSettingsFile, evidenceFile: w.evidenceFile,
  });
  assert.ok(calls.includes('funnel enable'), calls.join('\n'));
  assert.equal(cfg.integrations.ownership.rufloComponents.funnelDisabled, undefined);
});

test('an opt-out whose value ak still holds is fixable, and sync removes it', (t) => {
  const w = world(t);
  w.apply(cfgWith());
  w.evidence(confirming());
  const optOut = cfgWith({ minilmPicker: false });
  const { snap, rows } = w.rows(optOut);
  assert.equal(stateOf(snap, 'minilmPicker').id, 'not-applied');
  assert.match(stateOf(snap, 'minilmPicker').meaning, /opted out/);
  assert.ok(rowFor(rows, 'MiniLM agent picker').fix);
  w.apply(optOut);
  assert.equal(JSON.parse(fs.readFileSync(w.userSettingsFile, 'utf8')).env.CLAUDE_FLOW_ROUTER_EMBEDDER, undefined);
  assert.equal(stateOf(w.rows(optOut).snap, 'minilmPicker').id, 'user-managed');
});

test('a managed value the user deleted is drifted, and sync restores it', (t) => {
  const w = world(t);
  w.apply(cfgWith());
  w.evidence(confirming());
  const doc = JSON.parse(fs.readFileSync(w.userSettingsFile, 'utf8'));
  delete doc.env.RUFLO_INTELLIGENCE_MODE;
  w.settings(doc);
  const { snap, rows } = w.rows(cfgWith());
  assert.equal(stateOf(snap, 'learningProfile').id, 'drifted');
  assert.ok(rowFor(rows, 'Learning profile').fix);
  w.apply(cfgWith());
  assert.equal(stateOf(w.rows(cfgWith()).snap, 'learningProfile').id, 'active');
});

test('a value the user changed after ak wrote it is theirs: user-managed, no fix', (t) => {
  const w = world(t);
  w.apply(cfgWith());
  w.evidence(confirming());
  const doc = JSON.parse(fs.readFileSync(w.userSettingsFile, 'utf8'));
  doc.env.RUFLO_INTELLIGENCE_MODE = 'research';
  w.settings(doc);
  const { snap, rows } = w.rows(cfgWith());
  assert.equal(stateOf(snap, 'learningProfile').id, 'user-managed');
  assert.equal(rowFor(rows, 'Learning profile').fix, null);
});

test('governance on a project whose policy file is absent is not applied (fixable)', (t) => {
  const w = world(t);
  const root = fs.mkdtempSync(path.join(HOME, 'proj-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  w.apply(cfgWith());
  w.evidence(confirming());
  const snap = rufloComponentsPayload({
    cfg: cfgWith(), rufloVersion: '3.44.0', projectRoot: root, evidenceFile: w.evidenceFile, userSettingsFile: w.userSettingsFile, now,
  });
  assert.equal(stateOf(snap, 'mcpGovernance').id, 'not-applied');
});

test('governance turned off releases the policy and project env in every receipted project', async (t) => {
  const w = world(t);
  const { reconcilePolicy } = await import('../../src/lib/ruflo-components/policy.mjs');
  const { recordProjectReceipts } = await import('../../src/lib/ruflo-components/apply.mjs');
  const on = cfgWith({}, { policies: {} });
  const roots = ['a', 'b'].map((name) => {
    const root = fs.mkdtempSync(path.join(HOME, `gov-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    reconcilePolicy(root, on.rufloComponents.mcpGovernance, on.integrations.ownership.rufloComponents.policies);
    reconcileClaudeComponentEnv(on, { projectRoot: root, rufloVersion: '3.44.0', userScope: false });
    recordProjectReceipts(on, root);
    return root;
  });
  const off = { ...on, rufloComponents: { ...on.rufloComponents, typesafePicker: false, funnel: true, mcpGovernance: false } };
  await reconcileRufloComponents(off, {
    cwd: HOME, projectRoot: null, runner: async () => ({ code: 0, stdout: '', stderr: '' }), rufloVersion: '3.44.0',
    refresh: false, userSettingsFile: w.userSettingsFile, evidenceFile: w.evidenceFile,
  });
  for (const root of roots) {
    assert.equal(fs.existsSync(path.join(root, '.harness', 'mcp-policy.json')), false, root);
    const local = paths.projectSettingsLocal(root);
    assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).env?.RUFLO_MCP_ENFORCE_POLICY, undefined, root);
  }
});
