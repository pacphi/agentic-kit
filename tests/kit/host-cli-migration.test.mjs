import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-cli-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-project-'));
  fs.mkdirSync(path.join(project, '.git'));
  const config = path.join(home, '.config');
  return {
    home,
    project,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      APPDATA: config,
      PATH: path.join(home, 'no-such-bin'),
    },
  };
}

function ak(sb, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: sb.project,
    env: sb.env,
    encoding: 'utf8',
  });
}

const output = (result) => `${result.stdout}\n${result.stderr}`;

test('top-level ak host is the canonical management command', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^ak host — /);
  assert.match(result.stdout, /status\s+\(default\)/);
  assert.match(result.stdout, /pick\s+/);
  assert.match(result.stdout, /refresh\s+/);
  assert.match(result.stdout, /off\s+/);
  assert.doesNotMatch(output(result), /deprecated/i);
});

test('ak host status dispatches the existing read-only status semantics', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', 'status', '--json');
  assert.equal(result.status, 0, output(result));
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.hosts, 'object');
  assert.equal(typeof payload.providers, 'object',
    'host management retains the existing host/provider fact payload during migration');
});

// D-2/F-25/F-26: the tier text and asymmetry sub-notes are capability-derived
// (src/lib/hosts.mjs's hostTierLabel/hostAsymmetryNote), not an
// `h.id === 'opencode'` special case in x/host.mjs — this pins the actual
// rendered CLI text so a regression back to a hardcoded id check would fail
// here even though nothing depends on the exact strings elsewhere.
test('ak host status renders capability-derived tier text and asymmetry notes for every built-in host', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', 'status');
  assert.equal(result.status, 0, output(result));
  const text = result.stdout;
  assert.match(text, /^ {2}claude {4}.*· drives sessions · can lead$/m);
  assert.match(text, /^ {2}codex {5}.*· drives sessions · can lead$/m);
  assert.doesNotMatch(text, /mcp__codex__codex|codex mcp-server/);
  assert.match(text, /^ {2}opencode {2}.*· routing only · supervised · not AQE$/m);
  assert.match(text, /^ {4}consent boundary — a run can block on a permission event \(never auto-approved\); no ruflo backend env flag$/m);
  assert.doesNotMatch(text, /routing host/, 'old hardcoded tier text must be fully replaced');
});

test('ak host preserves pick option parsing without performing an interactive run', () => {
  const sb = sandbox();
  const result = ak(sb, 'host', 'pick', '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /--host claude,codex/);
  assert.match(result.stdout, /--primary-host claude\|codex/);
  assert.match(result.stdout, /--aqe-provider/);
  assert.match(result.stdout, /--provider <csv>/);
});

test('non-interactive host enablement requires --yes after printing trust and mutates nothing', () => {
  const sb = sandbox();
  const configFile = path.join(sb.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json');
  const result = ak(sb, 'host', 'pick', '--host', 'claude,opencode');
  const text = output(result);
  assert.equal(result.status, 2, text);
  assert.match(text, /host trust manifest/);
  assert.match(text, /OpenCode — approval policy receives the listed grants/);
  assert.match(text, /\[user\] auto-approve: claude-flow_\*/);
  assert.match(text, /re-run with --yes after reviewing the manifest/);
  assert.equal(fs.existsSync(configFile), false,
    'declined non-interactive trust must not create kit.json');
  assert.equal(fs.existsSync(path.join(sb.env.XDG_CONFIG_HOME, 'opencode')), false,
    'declined non-interactive trust must not create OpenCode config');
});

for (const [name, body, detail] of [
  ['malformed JSON', '{ invalid json', /Unexpected token|Expected property name/],
  ['non-object integrations envelope', JSON.stringify({ integrations: [] }),
    /integrations must be an object/],
  ['future integrations envelope', JSON.stringify({ integrations: { version: 99 } }),
    /unsupported integrations\.version 99/],
  ['future routing envelope', JSON.stringify({ routing: { version: 99, future: true } }),
    /unsupported routing\.version 99/],
  ['conflicting routing state', JSON.stringify({
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: { primaryHost: 'codex' },
  }), /providers\.primaryHost differs from routing\.primaryHost/],
]) {
  test(`a ${name} config reports a path, cause, and non-destructive recovery without a stack`, () => {
    const sb = sandbox();
    const file = path.join(sb.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const result = ak(sb, 'status');
    const text = output(result);
    assert.equal(result.status, 1, text);
    assert.match(text, /invalid kit config/);
    assert.ok(text.includes(file), `must name the exact file\n${text}`);
    assert.match(text, detail);
    assert.match(text, /Recovery \(the original is preserved\)/);
    assert.match(text, /\.invalid/);
    assert.match(text, /ak status/);
    assert.doesNotMatch(text, /\n\s+at\s/, `must not leak a stack trace\n${text}`);
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'diagnosis must not alter the invalid file');
  });
}

test('removed top-level provider alias exits as an unknown command', () => {
  const sb = sandbox();
  const result = ak(sb, 'provider', '--help');
  assert.equal(result.status, 2, output(result));
  assert.match(result.stdout, /unknown command: provider/);
});

test('removed plumbing provider alias exits as an unknown plumbing command', () => {
  const sb = sandbox();
  const result = ak(sb, 'x', 'provider', '--help');
  assert.equal(result.status, 2, output(result));
  assert.match(result.stdout, /unknown plumbing command: provider/);
});

test('top-level help advertises only the canonical host command', () => {
  const sb = sandbox();
  const result = ak(sb, '--help');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^\s+ak host\s+/m);
  assert.doesNotMatch(result.stdout, /^\s+ak provider\s+/m);
});

test('plumbing index advertises only x host', () => {
  const sb = sandbox();
  const result = ak(sb, '--help', '--all');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^\s+ak x host\s+/m);
  assert.doesNotMatch(result.stdout, /^\s+ak x provider\s+/m);
});

test('ak host off retains the OpenCode teardown receipt when config parsing fails', () => {
  const sb = sandbox();
  const kitFile = path.join(sb.env.XDG_CONFIG_HOME, 'agentic-kit', 'kit.json');
  const opencodeFile = path.join(sb.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(kitFile), { recursive: true });
  fs.mkdirSync(path.dirname(opencodeFile), { recursive: true });
  fs.writeFileSync(opencodeFile, '{ /* JSONC prevents safe teardown */ "mcp": {} }\n');
  fs.writeFileSync(kitFile, `${JSON.stringify({
    integrations: {
      version: 2,
      hosts: { claude: true, codex: false, opencode: true },
      bindings: [],
      ownership: {
        opencode: {
          mcp: 'ak',
          managed: { mcp: {}, paths: [], permissions: {}, artifacts: {} },
          catalogDir: '/retained/catalog',
        },
      },
    },
    routing: { version: 1, primaryHost: 'claude', routes: {} },
    providers: {
      aqeProvider: null, aqeFallback: [], models: [], maxBudgetUsd: null,
    },
  }, null, 2)}\n`);

  const result = ak(sb, 'host', 'off');
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /opencode teardown incomplete/);
  const saved = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
  assert.equal(saved.integrations.hosts.opencode, false);
  assert.equal(saved.integrations.ownership.opencode.mcp, 'ak');
  assert.equal(saved.integrations.ownership.opencode.catalogDir, '/retained/catalog');
  assert.ok(saved.integrations.ownership.opencode.managed,
    'the retry proof must survive a failed direct off');
});
