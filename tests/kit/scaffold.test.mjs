import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REMOVED_AGENTS,
  removedAgentGaps,
  upstreamFixAvailable,
  runScaffoldAgentsFix,
} from '../../src/lib/scaffold.mjs';

// Detection mirrors upstream migrate-agent-detection.ts: basename anywhere
// under .claude/agents + owning-plugin coverage from the injected home's
// installed_plugins.json. Every test gets isolated tmp dirs — nothing here
// depends on what is actually installed on the machine running the suite.

function tmpProject({ agentsDir = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-scaffold-'));
  if (agentsDir) fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  return dir;
}

function tmpHome(plugins = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-scaffold-home-'));
  if (plugins) {
    const dir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins }));
  }
  return home;
}

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('not relevant when the project has no .claude/agents tree', () => {
  const cwd = tmpProject({ agentsDir: false });
  const homeDir = tmpHome();
  try {
    assert.deepEqual(removedAgentGaps(cwd, { homeDir }), { relevant: false, gaps: [] });
  } finally { rm(cwd); rm(homeDir); }
});

test('all 9 gaps when agents dir is empty and no plugins are installed', () => {
  const cwd = tmpProject();
  const homeDir = tmpHome();
  try {
    const { relevant, gaps } = removedAgentGaps(cwd, { homeDir });
    assert.equal(relevant, true);
    assert.equal(gaps.length, REMOVED_AGENTS.length);
  } finally { rm(cwd); rm(homeDir); }
});

test('a basename anywhere under .claude/agents clears its gap', () => {
  const cwd = tmpProject();
  const homeDir = tmpHome();
  try {
    const nested = path.join(cwd, '.claude', 'agents', 'some', 'deep', 'category');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'coder.md'), '# restored\n');
    const { gaps } = removedAgentGaps(cwd, { homeDir });
    assert.equal(gaps.length, REMOVED_AGENTS.length - 1);
    assert.ok(!gaps.some((g) => g.basename === 'coder.md'));
  } finally { rm(cwd); rm(homeDir); }
});

test('user-scoped plugin install covers its agents; project scope only matches its own path', () => {
  const cwd = tmpProject();
  const other = tmpProject();
  const homeDir = tmpHome({
    'ruflo-core@ruflo': [{ scope: 'user' }],
    'ruflo-testgen@ruflo': [{ scope: 'project', projectPath: other }],
  });
  try {
    const { gaps } = removedAgentGaps(cwd, { homeDir });
    // ruflo-core owns coder/researcher/reviewer — covered by the user-scope install.
    assert.ok(!gaps.some((g) => g.plugin === 'ruflo-core'));
    // ruflo-testgen is installed for a DIFFERENT project — tester.md still gaps here.
    assert.ok(gaps.some((g) => g.basename === 'tester.md'));
  } finally { rm(cwd); rm(other); rm(homeDir); }
});

test('upstreamFixAvailable probes the installed dist for the restore module', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-scaffold-dist-'));
  try {
    assert.equal(upstreamFixAvailable({ cliDist: dist }), false);
    fs.mkdirSync(path.join(dist, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'commands', 'migrate-agent-restore.js'), '// #2986\n');
    assert.equal(upstreamFixAvailable({ cliDist: dist }), true);
  } finally { rm(dist); }
});

test('runScaffoldAgentsFix delegates to ruflo and verifies convergence', async () => {
  const cwd = tmpProject();
  const homeDir = tmpHome();
  try {
    const calls = [];
    // Runner simulates upstream restoring every agent, then the post-check
    // re-probes the real tree — write the files so convergence holds.
    const runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      const dir = path.join(cwd, '.claude', 'agents', 'core');
      fs.mkdirSync(dir, { recursive: true });
      for (const { basename } of REMOVED_AGENTS) fs.writeFileSync(path.join(dir, basename), '# restored\n');
      return { code: 0, stdout: '9 agent(s) restored', stderr: '' };
    };
    const r = await runScaffoldAgentsFix(cwd, { runner, homeDir });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].args, ['migrate', 'fix', '--agents']);
    assert.equal(calls[0].cmd, 'ruflo');
    assert.equal(calls[0].cwd, cwd);
  } finally { rm(cwd); rm(homeDir); }
});

test('runScaffoldAgentsFix reports failure on nonzero exit without throwing', async () => {
  const cwd = tmpProject();
  const homeDir = tmpHome();
  try {
    const runner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const r = await runScaffoldAgentsFix(cwd, { runner, homeDir });
    assert.equal(r.ok, false);
    assert.match(r.detail, /boom/);
  } finally { rm(cwd); rm(homeDir); }
});

test('runScaffoldAgentsFix flags non-convergence when gaps remain after a zero exit', async () => {
  const cwd = tmpProject();
  const homeDir = tmpHome();
  try {
    const runner = async () => ({ code: 0, stdout: 'looked fine', stderr: '' });
    const r = await runScaffoldAgentsFix(cwd, { runner, homeDir });
    assert.equal(r.ok, false);
    assert.match(r.detail, /gap\(s\) remain/);
  } finally { rm(cwd); rm(homeDir); }
});
