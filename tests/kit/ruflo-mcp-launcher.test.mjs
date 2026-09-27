// `ak x ruflo-mcp` as a process (B3-D1). Claude Code's user-scope stdio
// registration starts the launcher in the session folder; the launcher must
// start Ruflo at the repository root, so `<repo>/.harness/mcp-policy.json`
// (read from Ruflo's cwd, policy-enforcer.js:66 in 3.46.1) and `<repo>/.swarm`
// are the files Ruflo uses from any subfolder. A fake `ruflo` on PATH records
// its working directory and memory variables; HOME and every XDG base point
// into the sandbox, so nothing real is read for configuration or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');
const posixOnly = process.platform === 'win32' ? 'the fake ruflo is a POSIX shell script' : false;

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-mcp-cli-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const out = path.join(base, 'ruflo-saw.txt');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ruflo'),
    `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n%s\\n' "$(pwd -P)" "$*" "$CLAUDE_FLOW_DB_PATH" "\${CLAUDE_FLOW_MEMORY_PATH:-unset}" > '${out}'\n`,
    { mode: 0o755 });
  const env = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), NO_COLOR: '1',
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
  };
  return { base, home, out, env };
}

const launch = (cwd, env, args) => spawnSync(process.execPath, [BIN, 'x', 'ruflo-mcp', ...args], {
  cwd, env, encoding: 'utf8', timeout: 60_000,
});

test('ak x ruflo-mcp --host claude from a subfolder starts Ruflo at the repository root', { skip: posixOnly }, (t) => {
  const { base, out, env } = sandbox(t);
  const repo = path.join(base, 'repo');
  const sub = path.join(repo, 'sub', 'dir');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  const r = launch(sub, env, ['--host', 'claude']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const [cwd, args, db, memoryPath] = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(cwd, repo, 'Ruflo reads <repo>/.harness/mcp-policy.json, not <repo>/sub/dir/.harness');
  assert.equal(args, 'mcp start');
  assert.equal(db, path.join(repo, '.swarm', 'memory.db'));
  assert.equal(memoryPath, 'unset', 'a project keeps Ruflo\'s own <cwd>/.swarm derivation');
  assert.equal(fs.existsSync(path.join(sub, '.swarm')), false);
});

test('ak x ruflo-mcp --host claude from the home folder uses the user-level store', { skip: posixOnly }, (t) => {
  const { home, out, env } = sandbox(t);
  const r = launch(home, env, ['--host', 'claude']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const store = path.join(home, '.claude-flow', 'memory');
  const [cwd, , db, memoryPath] = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(cwd, store);
  assert.equal(db, path.join(store, 'memory.db'));
  assert.equal(memoryPath, store);
});

test('ak x ruflo-mcp refuses an unknown --host with exit 2 and starts nothing', { skip: posixOnly }, (t) => {
  const { base, out, env } = sandbox(t);
  const r = launch(base, env, ['--host', 'cursor']);
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /--host must be claude or codex/);
  assert.equal(fs.existsSync(out), false);
});
