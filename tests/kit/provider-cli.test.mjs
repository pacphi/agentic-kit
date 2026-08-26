// `ak x host status` is read-only (detect + report), so — unlike `pick`,
// which can trigger real installs/network calls — it's safe to exercise via a
// real CLI spawn. HOME/XDG_CONFIG_HOME (POSIX) and USERPROFILE/APPDATA
// (Windows) are all pointed at a throwaway sandbox so this never touches the
// real machine's kit.json or ~/.claude — src/lib/paths.mjs's configBase()
// reads APPDATA (not XDG_CONFIG_HOME) on win32, so both must be set or the
// sandbox is silently bypassed there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DUAL_ROLE_TIP, JUDGE_BIAS_TIP } from '../../src/lib/providers.mjs';
import { parseFallback, parseModels } from '../../src/commands/x/host.mjs';
import { defaultHostMap } from '../../src/lib/adapters/index.mjs';

// Tripwire (#137): a spawned `ak x host pick` whose cwd falls back to the test
// process's cwd writes PROJECT-scoped config (.claude/settings.local.json,
// .agentic-qe/llm-config.json) into the REAL repository the suite runs from —
// HOME sandboxing cannot catch that class of leak. Record the real cwd's state
// at module load and prove it byte-identical when the suite ends.
const REAL_PROJECT_FILES = ['.claude/settings.local.json', '.agentic-qe/llm-config.json']
  .map((rel) => path.resolve(process.cwd(), rel));
const readOrNull = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const realProjectBefore = REAL_PROJECT_FILES.map(readOrNull);
after(() => {
  REAL_PROJECT_FILES.forEach((f, i) => {
    assert.equal(readOrNull(f), realProjectBefore[i],
      `${f} was modified by this suite — a spawned ak command leaked out of the sandbox (cwd not anchored to the sandbox project?)`);
  });
});

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

test('provider CLI parsing splits only the provider delimiter', () => {
  assert.deepEqual(parseModels('ollama:qwen3.6:27b, openrouter:z-ai/glm-5.2'), [
    { id: 'ollama', model: 'qwen3.6:27b' },
    { id: 'openrouter', model: 'z-ai/glm-5.2' },
  ]);
});

test('AQE fallback parsing also preserves provider-native model delimiters', () => {
  assert.deepEqual(parseFallback('ollama:qwen3.6:27b; openrouter:z-ai/glm-5.2'), [
    { provider: 'ollama', models: ['qwen3.6:27b'] },
    { provider: 'openrouter', models: ['z-ai/glm-5.2'] },
  ]);
});

function sandbox({ hosts }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-cli-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  const last = Date.now();
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({
    integrations: { version: 2, hosts: { opencode: false, ...hosts }, bindings: [] },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {},
    // Real CLI spawns must not turn an isolated unit test into an npm network probe.
    versionCheck: { last, seen: {}, self: { last, best: null } },
  }));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-cli-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  return { home, project };
}

function rm(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

function ak(args, { cwd, home, env = {} }) {
  const cfgDir = path.join(home, '.config');
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home, // Windows os.homedir() reads USERPROFILE, not HOME
      XDG_CONFIG_HOME: cfgDir,
      APPDATA: cfgDir, // Windows configBase() reads APPDATA, not XDG_CONFIG_HOME
      ...env,
    },
  });
}

test('ak host status preserves key presence without exposing the key value', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: false } });
  const secret = 'openai-secret-must-never-serialize';
  const human = ak(['host', 'status'], {
    cwd: project, home, env: { OPENAI_API_KEY: secret },
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /openai\s+key present/);
  assert.equal(human.stdout.includes(secret), false);

  const json = ak(['host', 'status', '--json'], {
    cwd: project, home, env: { OPENAI_API_KEY: secret },
  });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.providers.openai.keyPresent, true);
  assert.equal(payload.providers.openai.credentialPresent, true);
  assert.equal(json.stdout.includes(secret), false);
  rm(home, project);
});

test('ak x host status prints the dual-host guidance tips once both hosts are enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: true } });
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(DUAL_ROLE_TIP), 'dual-role tip printed');
  assert.ok(r.stdout.includes(JUDGE_BIAS_TIP), 'judge-bias tip printed');
  rm(home, project);
});

test('ak x host status omits the dual-host guidance tips with only one host enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: false } });
  const r = ak(['x', 'host', 'status'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(DUAL_ROLE_TIP), 'dual-role tip withheld');
  assert.ok(!r.stdout.includes(JUDGE_BIAS_TIP), 'judge-bias tip withheld');
  rm(home, project);
});

// ── pick: the two-tier host model (ADR-0017) ─────────────────────────────────
// pick manages ALL THREE managed host integrations; claude/codex remain the
// routing pair. These spawn the real CLI end-to-end: kit.json persistence,
// opencode.json wiring, artifact deploy/remove, and ownership markers are all
// asserted on disk in the sandbox. Fake `claude`/`opencode` shims on PATH make
// the CLIs "installed" (installState never 'absent', so no npm install is ever
// attempted); a fresh versionCheck cache keeps the post-command drift nudge
// offline; RUFLO_REPO points at a fixture catalog for agent conversion.

/** Executable-noop shims for the CLIs pick probes (`which`, `--version`). */
function fakeBins(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nif [ -n "$AK_TEST_ARGV_LOG" ]; then printf "%s\\n" "$0 $*" >> "$AK_TEST_ARGV_LOG"; fi\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    fs.writeFileSync(path.join(bin, `${name}.ps1`), 'exit 0\r\n');
  }
  return bin;
}

/** Minimal ruflo catalog fixture: one convertible agent + a platform skill. */
function fakeCatalog(root) {
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\n---\n\nUse mcp__claude-flow__swarm_init.\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  return root;
}

/** A sandbox whose kit.json carries a FRESH versionCheck cache (the post-command
 *  drift nudge then never reaches the network), plus fake claude/opencode CLIs
 *  and a fixture catalog. */
function pickSandbox({
  hosts,
  providers = {},
  routing = {},
  ownership = {},
}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pick-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({
    integrations: {
      version: 2,
      hosts: { opencode: false, ...hosts },
      bindings: [],
      ownership,
    },
    routing: {
      version: 1,
      primaryHost: routing.primaryHost ?? 'claude',
      routes: routing.routes ?? {},
    },
    providers,
    versionCheck: {
      ttlHours: 24, last: Date.now(),
      seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
      self: { last: Date.now(), best: { version: '0.0.1', tag: 'latest' } },
    },
  }));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pick-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  const binDir = fakeBins(home);
  const catalog = fakeCatalog(path.join(home, 'catalog'));
  return { home, project, binDir, catalog };
}

function akPick(args, { cwd, project, home, binDir, catalog }, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    // Anchor at the sandbox project (#137): an undefined cwd inherits the test
    // process's cwd — the real repository — and pick's PROJECT-scoped writes
    // (settings.local.json, llm-config.json) would land there.
    cwd: cwd ?? project,
    input,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, '.config'),
      // FULLY controlled PATH: only the fixture shims + the system dirs the
      // `which` probe needs. Real CLIs/npm on the developer's machine can
      // never leak in and make detection non-deterministic.
      PATH: [binDir, '/usr/bin', '/bin'].join(path.delimiter),
      RUFLO_REPO: catalog,
      ...env,
    },
  });
}

const kitJson = (home) => JSON.parse(fs.readFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), 'utf8'));
const ocJsonPath = (home) => path.join(home, '.config', 'opencode', 'opencode.json');
const ocJson = (home) => JSON.parse(fs.readFileSync(ocJsonPath(home), 'utf8'));

test('pick --host claude,opencode enables + wires opencode (config, plugin, agents, skill), preserving user config', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    // Pre-existing user-owned opencode config that must survive the merge.
    fs.mkdirSync(path.dirname(ocJsonPath(sb.home)), { recursive: true });
    fs.writeFileSync(ocJsonPath(sb.home), JSON.stringify({
      model: 'opencode/kimi-k3',
      mcp: { 'my-server': { type: 'local', command: ['x'] } },
    }, null, 2));

    const r = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(r.status, 0, `pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /restart opencode to load the Agentic Kit hooks, compact gateway, and MCP connections/,
      'restart guidance printed after wiring');

    const doc = ocJson(sb.home);
    assert.ok(doc.mcp['claude-flow'], 'claude-flow MCP wired into opencode.json');
    assert.deepEqual(doc.mcp['my-server'], { type: 'local', command: ['x'] }, 'user MCP server preserved');
    assert.equal(doc.model, 'opencode/kimi-k3', 'user model key preserved');
    assert.equal(doc.permission['claude-flow_*'], 'allow', 'permission patterns pre-approved');
    assert.ok(doc.skills.paths.some((p) => p.endsWith(path.join('.claude', 'skills'))), 'catalog skills path added');

    const plugin = path.join(sb.home, '.config', 'opencode', 'plugins', 'ruflo-hooks.js');
    assert.ok(fs.existsSync(plugin), 'lifecycle plugin deployed');
    const agent = path.join(sb.home, '.config', 'opencode', 'agents', 'ak-specialist.md');
    assert.ok(fs.existsSync(agent), 'compact Agentic Kit specialist dispatcher deployed');
    assert.match(
      fs.readFileSync(agent, 'utf8'),
      /Call `ak_agent_load`/,
      'dispatcher loads the selected receipt-owned profile lazily',
    );
    const agentsMd = path.join(sb.home, '.config', 'opencode', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('BEGIN ruflo-opencode-reference'),
      'enablement-gated guidance converges on enable — "wired + guided" is one contract');

    const cfg = kitJson(sb.home);
    assert.deepEqual(cfg.integrations.hosts, { ...defaultHostMap(), opencode: true });
    assert.equal(cfg.integrations.ownership.opencode.mcp, 'ak', 'ownership marker persisted');
    assert.ok(cfg.integrations.ownership.opencode.managed?.mcp?.['claude-flow']?.written, 'value-precise ownership recorded');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('pick --host claude on an opencode-enabled machine disables it: ak wiring stripped, user config kept', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    fs.mkdirSync(path.dirname(ocJsonPath(sb.home)), { recursive: true });
    fs.writeFileSync(ocJsonPath(sb.home), JSON.stringify({ model: 'opencode/kimi-k3' }, null, 2));
    // A user-owned (marker-less) agent file that must survive every teardown.
    const agentsDir = path.join(sb.home, '.config', 'opencode', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'my-agent.md'), '---\ndescription: mine\n---\n\nUser agent.\n');

    const on = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    assert.ok(
      fs.existsSync(path.join(agentsDir, 'ak-specialist.md')),
      'compact Agentic Kit specialist dispatcher deployed in the enable run',
    );

    const off = akPick(['x', 'host', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 0, `disable failed\nstdout: ${off.stdout}\nstderr: ${off.stderr}`);
    assert.match(off.stdout, /opencode disabled/, 'disable is reported, never silent');

    const doc = ocJson(sb.home);
    assert.ok(!doc.mcp?.['claude-flow'], 'ak-managed MCP entry stripped');
    assert.equal(doc.model, 'opencode/kimi-k3', 'user model key survives the strip');
    assert.ok(!doc.permission?.['claude-flow_*'], 'ak permission patterns stripped');
    assert.ok(!fs.existsSync(path.join(agentsDir, 'ak-specialist.md')), 'ak dispatcher removed');
    assert.ok(!fs.existsSync(path.join(agentsDir, '.ak-agents-stamp.json')), 'agent stamp removed');
    assert.ok(fs.existsSync(path.join(agentsDir, 'my-agent.md')), 'user-owned agent survives');
    assert.ok(!fs.existsSync(path.join(sb.home, '.config', 'opencode', 'plugins', 'ruflo-hooks.js')),
      'ak plugin removed');

    const cfg = kitJson(sb.home);
    assert.deepEqual(cfg.integrations.hosts, defaultHostMap());
    assert.equal(cfg.integrations.ownership.opencode.mcp, null, 'ownership markers nulled on disable');
    assert.equal(cfg.integrations.ownership.opencode.managed, null);
  } finally {
    rm(sb.home, sb.project);
  }
});

test('pick --primary-host opencode is rejected; the prior primary is left unchanged', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: false },
    routing: { primaryHost: 'claude' },
  });
  try {
    const r = akPick(['x', 'host', 'pick', '--host', 'claude', '--primary-host', 'opencode', '--yes'], sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unknown primary host 'opencode'/, 'rejection is explained');
    assert.notEqual(kitJson(sb.home).routing.primaryHost, 'opencode', 'opencode can never become primary');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('a provider retune retires stale legacy Codex MCP while preserving current ownership', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: false, opencode: false },
    ownership: {
      codex: { mcp: 'ak', reverseMcp: 'ak' },
      opencode: { catalogDir: '/custom/catalog' },
    },
  });
  try {
    const r = akPick(['x', 'host', 'pick', '--aqe-provider', 'openai', '--yes'], sb);
    assert.equal(r.status, 0, r.stderr);
    const cfg = kitJson(sb.home);
    assert.equal(cfg.integrations.ownership.codex.mcp, null, 'stale legacy codex MCP receipt is retired');
    assert.equal(cfg.integrations.ownership.codex.reverseMcp, 'ak', 'reverse MCP marker survives a rewrite');
    assert.equal(cfg.integrations.ownership.opencode.catalogDir, '/custom/catalog', 'catalog override survives a rewrite');
    assert.equal(cfg.providers.aqeProvider, 'openai', 'the actual retune landed');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('host off clears the OpenCode catalog override after a successful teardown', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: false, opencode: false },
    ownership: {
      opencode: { catalogDir: '/custom/catalog', mcp: null, managed: null },
    },
  });
  try {
    const result = akPick(['x', 'host', 'off'], sb);
    assert.equal(result.status, 0, `off failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const cfg = kitJson(sb.home);
    assert.equal(
      Object.hasOwn(cfg.integrations.ownership.opencode, 'catalogDir'),
      false,
      'off restores the pre-GA reset behavior after the teardown receipt is no longer needed',
    );
  } finally {
    rm(sb.home, sb.project);
  }
});

test('excluding codex tears down only owned integrations and removes disabled routes', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: true, opencode: false },
    ownership: { codex: { mcp: 'ak', reverseMcp: 'ak' } },
    routing: {
      routes: {
        implementation: { host: 'codex', model: 'gpt-5.4', provenance: 'seeded' },
        testing: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user', escalation: [{ host: 'codex', model: 'gpt-5.4' }] },
      },
    },
  });
  try {
    const r = akPick(['x', 'host', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(r.status, 0, `disable failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /removed user escalation.*codex.*disabled/);
    const cfg = kitJson(sb.home);
    assert.equal(cfg.integrations.ownership.codex.mcp, null);
    assert.equal(cfg.integrations.ownership.codex.reverseMcp, null);
    assert.equal(cfg.routing.routes.implementation, undefined);
    assert.deepEqual(cfg.routing.routes.testing, {
      host: 'claude', model: 'claude-sonnet-5', provenance: 'user',
    });
  } finally {
    rm(sb.home, sb.project);
  }
});

test('excluding claude keeps Ruflo-in-Codex while retiring legacy MCP and pruning claude routes', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: true, opencode: false },
    ownership: { codex: { mcp: 'ak', reverseMcp: 'ak' } },
    routing: {
      routes: { review: { host: 'claude', model: 'claude-sonnet-5', provenance: 'seeded' } },
    },
  });
  try {
    const r = akPick(['x', 'host', 'pick', '--host', 'codex', '--yes'], sb);
    assert.equal(r.status, 0, r.stderr);
    const cfg = kitJson(sb.home);
    assert.equal(cfg.routing.routes.review, undefined);
    assert.equal(cfg.integrations.ownership.codex.mcp, null);
    assert.equal(cfg.integrations.ownership.codex.reverseMcp, 'ak');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('interactive pick keeps installed OpenCode opt-in until explicitly selected', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false, opencode: false } });
  try {
    // Blank answers to every prompt: accept the defaults.
    const r = akPick(['x', 'host', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /opencode is available; type it to opt in/,
      'OpenCode is displayed but not implicitly enabled');
    assert.equal(kitJson(sb.home).integrations.hosts.opencode, false,
      'a bare enter must not opt a third host in sight unseen');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('interactive pick: an already-enabled opencode stays enabled on a bare enter', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false, opencode: true } });
  try {
    const r = akPick(['x', 'host', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(kitJson(sb.home).integrations.hosts.opencode, true,
      'enabled opencode is part of the default set and survives a retune');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('an unknown --host token is a hard error BEFORE any mutation (a typo never tears a host down)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    const kitPath = path.join(sb.home, '.config', 'agentic-kit', 'kit.json');
    const wiredCfg = fs.readFileSync(kitPath, 'utf8');
    const wiredOc = fs.readFileSync(ocJsonPath(sb.home), 'utf8');

    const r = akPick(['x', 'host', 'pick', '--host', 'claude,opencdoe', '--yes'], sb);
    assert.equal(r.status, 2, `a typo'd host set must fail, got ${r.status}`);
    assert.match(r.stdout + r.stderr, /unknown host\(s\): opencdoe/);
    assert.equal(fs.readFileSync(kitPath, 'utf8'), wiredCfg, 'kit.json untouched');
    assert.equal(fs.readFileSync(ocJsonPath(sb.home), 'utf8'), wiredOc, 'opencode wiring untouched');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('disable against a JSONC config warns honestly and RETAINS the markers (never claims disabled over live wiring)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    // Make the config unparseable (legal JSONC) after wiring.
    fs.writeFileSync(ocJsonPath(sb.home), '{\n  // user converted this file to JSONC\n  "mcp": {}\n}\n');

    const off = akPick(['x', 'host', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 1, 'automation must be able to detect incomplete teardown');
    assert.match(off.stdout, /opencode disable incomplete/, 'the incomplete teardown is surfaced, never hidden');
    assert.ok(!/opencode disabled:/.test(off.stdout), '"disabled" is never claimed over active wiring');
    const cfg = kitJson(sb.home);
    assert.equal(cfg.integrations.hosts.opencode, false, 'the enablement intent still flips (user asked)');
    assert.equal(cfg.integrations.ownership.opencode.mcp, 'ak', 'markers RETAINED for the retry — teardown proof is never nulled over live wiring');
    assert.ok(cfg.integrations.ownership.opencode.managed?.mcp?.['claude-flow'], 'value-precise records survive');
    assert.match(fs.readFileSync(ocJsonPath(sb.home), 'utf8'), /JSONC/, 'the JSONC file itself is untouched');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('disable with the config file absent clears the stale markers (no phantom ownership)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    fs.rmSync(ocJsonPath(sb.home), { force: true }); // user deleted the config

    const off = akPick(['x', 'host', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 0, off.stderr);
    const ownership = kitJson(sb.home).integrations.ownership.opencode;
    assert.equal(ownership.mcp, null, 'markers cleared — nothing left to own');
    assert.equal(ownership.managed, null);
  } finally {
    rm(sb.home, sb.project);
  }
});

test('interactive pick: an enabled host absent from PATH right now is kept enabled on a bare enter', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false, opencode: true } });
  try {
    // Remove the opencode shim: the CLI is "temporarily absent" but enabled.
    fs.rmSync(path.join(sb.binDir, 'opencode'), { force: true });
    fs.rmSync(path.join(sb.binDir, 'opencode.cmd'), { force: true });
    fs.rmSync(path.join(sb.binDir, 'opencode.ps1'), { force: true });
    const r = akPick(['x', 'host', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /enabled but not detected right now: opencode \(kept enabled on Enter\)/);
    assert.equal(kitJson(sb.home).integrations.hosts.opencode, true,
      'an absent host is never torn down by invisibility');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('a converged re-pick re-persists stale/missing ownership markers (teardown keeps its proof)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    // Stale the markers out of kit.json while the file stays converged.
    const kitPath = path.join(sb.home, '.config', 'agentic-kit', 'kit.json');
    const cfg = kitJson(sb.home);
    cfg.integrations.ownership.opencode.mcp = null;
    cfg.integrations.ownership.opencode.managed = null;
    fs.writeFileSync(kitPath, JSON.stringify(cfg, null, 2));

    const again = akPick(['x', 'host', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(again.status, 0, again.stderr);
    const after = kitJson(sb.home).integrations.ownership.opencode;
    assert.equal(after.mcp, 'ak', 'the marker is re-persisted even though the file was converged');
    assert.ok(after.managed?.mcp?.['claude-flow']?.written, 'value-precise ownership restored');
  } finally {
    rm(sb.home, sb.project);
  }
});
