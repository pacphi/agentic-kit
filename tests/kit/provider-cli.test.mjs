// `ak x provider status` is read-only (detect + report), so — unlike `pick`,
// which can trigger real installs/network calls — it's safe to exercise via a
// real CLI spawn. HOME/XDG_CONFIG_HOME (POSIX) and USERPROFILE/APPDATA
// (Windows) are all pointed at a throwaway sandbox so this never touches the
// real machine's kit.json or ~/.claude — src/lib/paths.mjs's configBase()
// reads APPDATA (not XDG_CONFIG_HOME) on win32, so both must be set or the
// sandbox is silently bypassed there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DUAL_ROLE_TIP, JUDGE_BIAS_TIP } from '../../src/lib/providers.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox({ hosts }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-cli-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({ providers: { hosts } }));
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

test('ak x provider status prints the dual-host guidance tips once both hosts are enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: true } });
  const r = ak(['x', 'provider', 'status'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(DUAL_ROLE_TIP), 'dual-role tip printed');
  assert.ok(r.stdout.includes(JUDGE_BIAS_TIP), 'judge-bias tip printed');
  rm(home, project);
});

test('ak x provider status omits the dual-host guidance tips with only one host enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: false } });
  const r = ak(['x', 'provider', 'status'], { cwd: project, home });
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
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nif not "%AK_TEST_ARGV_LOG%"=="" echo ${name} %*>> "%AK_TEST_ARGV_LOG%"\r\nexit /b 0\r\n`);
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
function pickSandbox({ hosts, providers = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-pick-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({
    providers: { hosts, ...providers },
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

function akPick(args, { cwd, home, binDir, catalog }, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
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

    const r = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(r.status, 0, `pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /restart opencode to load the hooks/, 'restart guidance printed after wiring');

    const doc = ocJson(sb.home);
    assert.ok(doc.mcp['claude-flow'], 'claude-flow MCP wired into opencode.json');
    assert.deepEqual(doc.mcp['my-server'], { type: 'local', command: ['x'] }, 'user MCP server preserved');
    assert.equal(doc.model, 'opencode/kimi-k3', 'user model key preserved');
    assert.equal(doc.permission['claude-flow_*'], 'allow', 'permission patterns pre-approved');
    assert.ok(doc.skills.paths.some((p) => p.endsWith(path.join('.claude', 'skills'))), 'catalog skills path added');

    const plugin = path.join(sb.home, '.config', 'opencode', 'plugins', 'ruflo-hooks.js');
    assert.ok(fs.existsSync(plugin), 'lifecycle plugin deployed');
    const agent = path.join(sb.home, '.config', 'opencode', 'agents', 'coder.md');
    assert.ok(fs.existsSync(agent), 'ruflo agent converted into opencode subagents');
    assert.match(fs.readFileSync(agent, 'utf8'), /claude-flow_swarm_init/, 'MCP tool refs rewritten for opencode');
    const agentsMd = path.join(sb.home, '.config', 'opencode', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('BEGIN ruflo-opencode-reference'),
      'enablement-gated guidance converges on enable — "wired + guided" is one contract');

    const cfg = kitJson(sb.home);
    assert.deepEqual(cfg.providers.hosts, { claude: true, codex: false, opencode: true });
    assert.equal(cfg.providers.opencodeMcp, 'ak', 'ownership marker persisted');
    assert.ok(cfg.providers.opencodeManaged?.mcp?.['claude-flow']?.written, 'value-precise ownership recorded');
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

    const on = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    assert.ok(fs.existsSync(path.join(agentsDir, 'coder.md')), 'ak agents deployed in the enable run');

    const off = akPick(['x', 'provider', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 0, `disable failed\nstdout: ${off.stdout}\nstderr: ${off.stderr}`);
    assert.match(off.stdout, /opencode disabled/, 'disable is reported, never silent');

    const doc = ocJson(sb.home);
    assert.ok(!doc.mcp?.['claude-flow'], 'ak-managed MCP entry stripped');
    assert.equal(doc.model, 'opencode/kimi-k3', 'user model key survives the strip');
    assert.ok(!doc.permission?.['claude-flow_*'], 'ak permission patterns stripped');
    assert.ok(!fs.existsSync(path.join(agentsDir, 'coder.md')), 'ak-generated agents removed');
    assert.ok(!fs.existsSync(path.join(agentsDir, '.ak-agents-stamp.json')), 'agent stamp removed');
    assert.ok(fs.existsSync(path.join(agentsDir, 'my-agent.md')), 'user-owned agent survives');
    assert.ok(!fs.existsSync(path.join(sb.home, '.config', 'opencode', 'plugins', 'ruflo-hooks.js')),
      'ak plugin removed');

    const cfg = kitJson(sb.home);
    assert.deepEqual(cfg.providers.hosts, { claude: true, codex: false, opencode: false });
    assert.equal(cfg.providers.opencodeMcp, null, 'ownership markers nulled on disable');
    assert.equal(cfg.providers.opencodeManaged, null);
  } finally {
    rm(sb.home, sb.project);
  }
});

test('pick --primary-host opencode is rejected; the prior primary is left unchanged', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false }, providers: { primaryHost: 'claude' } });
  try {
    const r = akPick(['x', 'provider', 'pick', '--host', 'claude', '--primary-host', 'opencode', '--yes'], sb);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unknown primary host 'opencode'/, 'rejection is explained');
    assert.notEqual(kitJson(sb.home).providers.primaryHost, 'opencode', 'opencode can never become primary');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('a provider retune preserves every ownership marker (codex MCP bridges + opencode wiring)', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: false, opencode: false },
    providers: { codexMcp: 'ak', rufloCodexMcp: 'ak', opencodeCatalogDir: '/custom/catalog' },
  });
  try {
    const r = akPick(['x', 'provider', 'pick', '--aqe-provider', 'openai', '--yes'], sb);
    assert.equal(r.status, 0, r.stderr);
    const p = kitJson(sb.home).providers;
    assert.equal(p.codexMcp, 'ak', 'codexMcp marker survives a rewrite');
    assert.equal(p.rufloCodexMcp, 'ak', 'rufloCodexMcp marker survives a rewrite');
    assert.equal(p.opencodeCatalogDir, '/custom/catalog', 'catalog override survives a rewrite');
    assert.equal(p.aqeProvider, 'openai', 'the actual retune landed');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('excluding codex tears down only owned bridges and removes disabled routes', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: true, opencode: false },
    providers: {
      codexMcp: 'ak', rufloCodexMcp: 'ak',
      dualRouting: {
        implementation: { host: 'codex', model: 'gpt-5.4', source: 'seeded' },
        testing: { host: 'claude', model: 'claude-sonnet-5', source: 'user', escalate: [{ host: 'codex', model: 'gpt-5.4' }] },
      },
    },
  });
  const log = path.join(sb.home, 'argv.log');
  try {
    const r = akPick(['x', 'provider', 'pick', '--host', 'claude', '--yes'], sb, { env: { AK_TEST_ARGV_LOG: log } });
    assert.equal(r.status, 0, `disable failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /removed user escalation.*codex.*disabled/);
    const p = kitJson(sb.home).providers;
    assert.equal(p.codexMcp, null);
    assert.equal(p.rufloCodexMcp, null);
    assert.equal(p.dualRouting.implementation, undefined);
    assert.deepEqual(p.dualRouting.testing, { host: 'claude', model: 'claude-sonnet-5', source: 'user' });
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /claude mcp remove codex -s project/);
    assert.match(calls, /codex mcp remove ruflo/);
  } finally {
    rm(sb.home, sb.project);
  }
});

test('excluding claude keeps codex-owned bridges while pruning claude routes', () => {
  const sb = pickSandbox({
    hosts: { claude: true, codex: true, opencode: false },
    providers: {
      codexMcp: 'ak', rufloCodexMcp: 'ak',
      dualRouting: { review: { host: 'claude', model: 'claude-sonnet-5', source: 'seeded' } },
    },
  });
  const log = path.join(sb.home, 'argv.log');
  try {
    const r = akPick(['x', 'provider', 'pick', '--host', 'codex', '--yes'], sb, { env: { AK_TEST_ARGV_LOG: log } });
    assert.equal(r.status, 0, r.stderr);
    const p = kitJson(sb.home).providers;
    assert.equal(p.dualRouting.review, undefined);
    assert.equal(p.codexMcp, 'ak');
    assert.equal(p.rufloCodexMcp, 'ak');
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /mcp remove/);
  } finally {
    rm(sb.home, sb.project);
  }
});

test('interactive pick: installed opencode is displayed as an integration host but only ENTER-enabled when already on', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false, opencode: false } });
  try {
    // Blank answers to every prompt: accept the defaults.
    const r = akPick(['x', 'provider', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /integration host — wired \+ guided, never a routing target/,
      'opencode is displayed with its non-routing qualifier');
    assert.equal(kitJson(sb.home).providers.hosts.opencode, false,
      'a bare enter must not opt a third host in sight unseen');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('interactive pick: an already-enabled opencode stays enabled on a bare enter', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false, opencode: true } });
  try {
    const r = akPick(['x', 'provider', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(kitJson(sb.home).providers.hosts.opencode, true,
      'enabled opencode is part of the default set and survives a retune');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('an unknown --host token is a hard error BEFORE any mutation (a typo never tears a host down)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    const kitPath = path.join(sb.home, '.config', 'agentic-kit', 'kit.json');
    const wiredCfg = fs.readFileSync(kitPath, 'utf8');
    const wiredOc = fs.readFileSync(ocJsonPath(sb.home), 'utf8');

    const r = akPick(['x', 'provider', 'pick', '--host', 'claude,opencdoe', '--yes'], sb);
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
    const on = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    // Make the config unparseable (legal JSONC) after wiring.
    fs.writeFileSync(ocJsonPath(sb.home), '{\n  // user converted this file to JSONC\n  "mcp": {}\n}\n');

    const off = akPick(['x', 'provider', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 1, 'automation must be able to detect incomplete teardown');
    assert.match(off.stdout, /opencode disable incomplete/, 'the incomplete teardown is surfaced, never hidden');
    assert.ok(!/opencode disabled:/.test(off.stdout), '"disabled" is never claimed over active wiring');
    const p = kitJson(sb.home).providers;
    assert.equal(p.hosts.opencode, false, 'the enablement intent still flips (user asked)');
    assert.equal(p.opencodeMcp, 'ak', 'markers RETAINED for the retry — teardown proof is never nulled over live wiring');
    assert.ok(p.opencodeManaged?.mcp?.['claude-flow'], 'value-precise records survive');
    assert.match(fs.readFileSync(ocJsonPath(sb.home), 'utf8'), /JSONC/, 'the JSONC file itself is untouched');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('disable with the config file absent clears the stale markers (no phantom ownership)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    fs.rmSync(ocJsonPath(sb.home), { force: true }); // user deleted the config

    const off = akPick(['x', 'provider', 'pick', '--host', 'claude', '--yes'], sb);
    assert.equal(off.status, 0, off.stderr);
    const p = kitJson(sb.home).providers;
    assert.equal(p.opencodeMcp, null, 'markers cleared — nothing left to own');
    assert.equal(p.opencodeManaged, null);
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
    const r = akPick(['x', 'provider', 'pick'], sb, { input: '\n\n\n\n' });
    assert.equal(r.status, 0, `interactive pick failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /enabled but not detected right now: opencode \(kept enabled on Enter\)/);
    assert.equal(kitJson(sb.home).providers.hosts.opencode, true,
      'an absent host is never torn down by invisibility');
  } finally {
    rm(sb.home, sb.project);
  }
});

test('a converged re-pick re-persists stale/missing ownership markers (teardown keeps its proof)', () => {
  const sb = pickSandbox({ hosts: { claude: true, codex: false } });
  try {
    const on = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(on.status, 0, on.stderr);
    // Stale the markers out of kit.json while the file stays converged.
    const kitPath = path.join(sb.home, '.config', 'agentic-kit', 'kit.json');
    const cfg = kitJson(sb.home);
    cfg.providers.opencodeMcp = null;
    cfg.providers.opencodeManaged = null;
    fs.writeFileSync(kitPath, JSON.stringify(cfg, null, 2));

    const again = akPick(['x', 'provider', 'pick', '--host', 'claude,opencode', '--yes'], sb);
    assert.equal(again.status, 0, again.stderr);
    const after = kitJson(sb.home).providers;
    assert.equal(after.opencodeMcp, 'ak', 'the marker is re-persisted even though the file was converged');
    assert.ok(after.opencodeManaged?.mcp?.['claude-flow']?.written, 'value-precise ownership restored');
  } finally {
    rm(sb.home, sb.project);
  }
});
