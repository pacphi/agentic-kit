import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'agentic-kit.mjs');

test('clean-machine setup preview is hermetic and discloses every auto-approve rule', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-clean-machine-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const prefix = path.join(root, 'npm-prefix');
  const noBin = path.join(root, 'no-such-bin');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const beforeHome = snapshot(home);
  const beforeProject = snapshot(project);
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    npm_config_prefix: prefix,
    npm_config_cache: path.join(root, 'npm-cache'),
    RUVNET_BRAIN_KB: path.join(root, 'brain-kb'),
    PATH: noBin,
    NO_COLOR: '1',
  };
  const run = spawnSync(process.execPath, [BIN, 'setup', '--project', '--dry-run', '--yes'], {
    cwd: project, env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = `${run.stdout}\n${run.stderr}`;
  for (const rule of [
    'Bash(npx @claude-flow*)', 'Bash(npx claude-flow*)', 'Bash(node .claude/*)',
    'mcp__claude-flow__*', 'Bash(npx agentic-qe:*)',
    'Bash(npx @anthropics/agentic-qe:*)', 'mcp__agentic-qe__*',
  ]) assert.ok(output.includes(rule), `missing disclosed rule: ${rule}`);
  assert.deepEqual(snapshot(home), beforeHome, 'preview must not mutate its disposable HOME');
  assert.deepEqual(snapshot(project), beforeProject, 'preview must not mutate its disposable project');
  fs.rmSync(root, { recursive: true, force: true });
});

test('clean-machine noninteractive trust requires --yes and declines without mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-clean-trust-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const beforeHome = snapshot(home);
  const beforeProject = snapshot(project);
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    npm_config_prefix: path.join(root, 'npm-prefix'),
    npm_config_cache: path.join(root, 'npm-cache'),
    RUVNET_BRAIN_KB: path.join(root, 'brain-kb'),
    PATH: path.join(root, 'no-such-bin'),
    NO_COLOR: '1',
  };
  const run = spawnSync(process.execPath, [BIN, 'setup', '--project'], {
    cwd: project, env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(output, /setup trust manifest/);
  assert.match(output, /setup cancelled before machine, user, or project changes/);
  assert.deepEqual(snapshot(home), beforeHome, 'declined setup trust must not mutate HOME');
  assert.deepEqual(snapshot(project), beforeProject, 'declined setup trust must not mutate project');
  fs.rmSync(root, { recursive: true, force: true });
});
