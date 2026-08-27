// The user-facing halves of #54 and #55, exercised through a real CLI spawn.
//
// `ak x host status` is read-only, and `refresh` only ever writes kit.json +
// the sandbox project's llm-config.json, so both are safe to run for real here
// (unlike `pick`, which can trigger installs). Everything is redirected at a
// throwaway HOME — see provider-cli.test.mjs for why all four env vars matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AQE_PROVIDER_CREDENTIALS } from '../../src/lib/providers.mjs';
import { DEFAULT_ROUTES } from '../../src/lib/routing.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

// Cleared in every spawn so a key exported on the developer's machine can never
// decide the outcome of a credential assertion; individual tests add back
// exactly the one they are testing.
const ALL_CREDENTIAL_ENV = [...new Set(
  Object.values(AQE_PROVIDER_CREDENTIALS).flatMap((d) => [...(d.keyEnv ?? []), ...(d.also ?? [])]),
)];

function sandbox({ hosts = { claude: true, codex: false, opencode: false }, routes = {}, ...providers }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-refresh-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  // These tests exercise provider output and persistence, not version egress.
  // A fresh sandbox otherwise makes every real CLI spawn run two sequential
  // `npm view` probes; an unreachable Windows runner pays both 20s timeouts
  // for every test in this file. Seed the same honest "checked, no answer"
  // cache shape a completed drift probe would persist.
  const last = Date.now();
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({
    integrations: { version: 2, hosts, bindings: [] },
    routing: { version: 1, primaryHost: 'claude', routes },
    providers,
    versionCheck: { last, seen: {}, self: { last, best: null } },
  }));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-refresh-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  return { home, project };
}

const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const readKit = (home) =>
  JSON.parse(fs.readFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), 'utf8'));

function ak(args, { cwd, home, env = {} }) {
  const cfgDir = path.join(home, '.config');
  const clean = { ...process.env };
  for (const k of ALL_CREDENTIAL_ENV) delete clean[k];
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...clean, NO_COLOR: '1', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: cfgDir, APPDATA: cfgDir, ...env },
  });
  return { ...r, all: `${r.stdout}${r.stderr}` };
}

const DUAL = { claude: true, codex: true };
const FORBIDDEN_FRAMING = /\b(stale|outdated|superseded)\b/i;

/** architecture + design pinned to the prior Opus generation (seeded), plus a
 *  deliberate user pin that must survive everything. */
const divergedProviders = () => ({
  hosts: { ...DUAL },
  routes: {
    architecture: { host: 'claude', model: 'claude-opus-4-8', provenance: 'seeded' },
    design: { host: 'claude', model: 'claude-opus-4-8', provenance: 'seeded' },
    debugging: { host: 'claude', model: 'claude-opus-4-8', provenance: 'user' },
  },
});

// ── #54: `ak x host status` credential visibility ──────────────────────────

test('x host status shows openrouter as credentialed when OPENROUTER_API_KEY is set', () => {
  // The reported machine's one live key was invisible to every ak surface,
  // while keyless openai displayed as a configured fallback.
  const { home, project } = sandbox({ hosts: { claude: true } });
  const r = ak(['x', 'host', 'status'], { cwd: project, home, env: { OPENROUTER_API_KEY: 'sk-test' } });
  const line = r.all.split('\n').find((l) => /^\s*openrouter\b/.test(l));
  assert.ok(line, `openrouter must appear in the provider table:\n${r.all}`);
  assert.match(line, /key present/, `openrouter is credentialed here, got: ${line}`);
  rm(home, project);
});

test('x host status shows a keyless provider as having no key, naming the var', () => {
  const { home, project } = sandbox({ hosts: { claude: true } });
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  const line = r.all.split('\n').find((l) => /^\s*openai\b/.test(l));
  assert.ok(line, `openai must appear in the provider table:\n${r.all}`);
  assert.match(line, /no key/);
  assert.match(line, /OPENAI_API_KEY/);
  rm(home, project);
});

test('x host status warns that a keyless chain rung fails over into nothing', () => {
  // The exact reproduction: claude-code + openai, no OPENAI_API_KEY.
  const { home, project } = sandbox({
    hosts: { ...DUAL },
    aqeFallback: [
      { provider: 'claude-code', models: ['claude-opus-5'] },
      { provider: 'openai', models: ['gpt-5.6'] },
    ],
  });
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  assert.match(r.all, /openai.*no credential|no credential.*openai/is);
  assert.match(r.all, /fail over into nothing/i, 'the consequence must be stated, not just the gap');
  rm(home, project);
});

test('x host status emits no credential warning when every rung is viable', () => {
  const { home, project } = sandbox({
    hosts: { ...DUAL },
    aqeFallback: [{ provider: 'openrouter', models: ['z-ai/glm-5.2'] }],
  });
  const r = ak(['x', 'host', 'status'], { cwd: project, home, env: { OPENROUTER_API_KEY: 'sk-test' } });
  assert.ok(!/fail over into nothing/i.test(r.all), `unexpected warning:\n${r.all}`);
  rm(home, project);
});

// ── #55: divergence shown neutrally in the routing table ──────────────────

test('x host status marks a diverged seeded route against its current default', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  const line = r.all.split('\n').find((l) => /^\s*architecture\b/.test(l));
  assert.ok(line, `routing table must list architecture:\n${r.all}`);
  assert.match(line, /diverges from default/i);
  assert.match(line, new RegExp(DEFAULT_ROUTES.architecture.model), 'the current default is shown inline');
  rm(home, project);
});

test('x host status never frames a diverged route as stale, outdated, or superseded', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  for (const line of r.all.split('\n').filter((l) => /diverge/i.test(l))) {
    assert.ok(!FORBIDDEN_FRAMING.test(line), `neutral framing violated: ${line}`);
  }
  rm(home, project);
});

test('x host status does not mark a user-pinned older model as diverged', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  const line = r.all.split('\n').find((l) => /^\s*debugging\b/.test(l));
  assert.ok(line, `routing table must list debugging:\n${r.all}`);
  assert.ok(!/diverges from default/i.test(line), `a deliberate pin is not drift: ${line}`);
  rm(home, project);
});

// ── #55: `ak x host refresh` ───────────────────────────────────────────────

test('x host refresh re-seeds only the activities named with --activity', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'refresh', '--activity', 'architecture'], { cwd: project, home });
  assert.equal(r.status, 0, r.all);
  const routing = readKit(home).routing.routes;
  assert.equal(routing.architecture.model, DEFAULT_ROUTES.architecture.model, 'named route refreshed');
  assert.equal(routing.design.model, 'claude-opus-4-8', 'unnamed route deliberately left as it was');
  rm(home, project);
});

test('x host refresh leaves a user-pinned route untouched even when named', () => {
  const { home, project } = sandbox(divergedProviders());
  ak(['x', 'host', 'refresh', '--activity', 'debugging'], { cwd: project, home });
  const routing = readKit(home).routing.routes;
  assert.equal(routing.debugging.model, 'claude-opus-4-8');
  assert.equal(routing.debugging.provenance, 'user');
  rm(home, project);
});

test('x host refresh --yes re-seeds every diverged route and converges', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'refresh', '--yes'], { cwd: project, home });
  assert.equal(r.status, 0, r.all);
  const routing = readKit(home).routing.routes;
  assert.equal(routing.architecture.model, DEFAULT_ROUTES.architecture.model);
  assert.equal(routing.design.model, DEFAULT_ROUTES.design.model);
  assert.equal(routing.debugging.model, 'claude-opus-4-8', 'user pins survive an all-refresh');

  const second = ak(['x', 'host', 'refresh'], { cwd: project, home });
  assert.match(second.all, /no seeded routes diverge/i, 'refreshing converges — the second run is a no-op');
  rm(home, project);
});

test('x host refresh propagates an AQE router failure to automation', () => {
  const { home, project } = sandbox({
    ...divergedProviders(),
    aqeFallback: [{ provider: 'not-a-provider', models: ['model'] }],
  });
  const r = ak(['x', 'host', 'refresh', '--activity', 'architecture'], { cwd: project, home });
  assert.equal(r.status, 1, `router failure must survive the command boundary\n${r.all}`);
  assert.match(r.all, /aqe router:.*no valid providers in fallback chain/);
  assert.equal(readKit(home).routing.routes.architecture.model, DEFAULT_ROUTES.architecture.model,
    'the requested route intent is saved for a corrected follow-up sync');
  rm(home, project);
});

test('x host refresh prints the cost-per-task trade for BOTH models, not just ids', () => {
  // The whole point of the neutral framing: the user is being handed a decision
  // that genuinely goes both ways, so both sides need their characteristic.
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'refresh', '--activity', 'architecture'], { cwd: project, home });
  assert.match(r.all, /turns/i, 'the work-per-task axis must appear, not only price');
  assert.match(r.all, /claude-opus-4-8/);
  assert.match(r.all, new RegExp(DEFAULT_ROUTES.architecture.model));
  rm(home, project);
});

test('x host refresh is a no-op on a policy seeded from current defaults', () => {
  const { home, project } = sandbox({
    hosts: { ...DUAL },
    routes: {
      architecture: { host: 'claude', model: DEFAULT_ROUTES.architecture.model, provenance: 'seeded' },
    },
  });
  const r = ak(['x', 'host', 'refresh', '--yes'], { cwd: project, home });
  assert.equal(r.status, 0);
  assert.match(r.all, /no seeded routes diverge/i);
  rm(home, project);
});

test('x host refresh ignores an unknown activity instead of failing', () => {
  const { home, project } = sandbox(divergedProviders());
  const r = ak(['x', 'host', 'refresh', '--activity', 'not-an-activity'], { cwd: project, home });
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /unknown activity/i);
  assert.equal(readKit(home).routing.routes.architecture.model, 'claude-opus-4-8', 'nothing refreshed');
  rm(home, project);
});

test('refresh is advertised as a subcommand and rejects an unknown one', () => {
  const { home, project } = sandbox({ hosts: { claude: true } });
  const help = ak(['x', 'host', '--help'], { cwd: project, home });
  assert.match(help.all, /refresh/, 'the opt-in path must be discoverable');
  const bad = ak(['x', 'host', 'bogus'], { cwd: project, home });
  assert.match(bad.all, /status\|pick\|refresh\|off/);
  rm(home, project);
});
