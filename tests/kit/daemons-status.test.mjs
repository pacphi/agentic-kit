// The daemons status row: "none running" is not "ok" for a project whose Ruflo
// memory backup and distillation run only inside its daemon (audit H D9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import section from '../../src/commands/status/sections/daemons.mjs';

function project(t, { memory = true, autoStart } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-daemons-status-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (memory) {
    fs.mkdirSync(path.join(cwd, '.swarm'));
    fs.writeFileSync(path.join(cwd, '.swarm', 'memory.db'), '');
  }
  if (autoStart !== undefined) {
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ claudeFlow: { daemon: { autoStart } } }));
  }
  return cwd;
}

const none = async () => [];
const collect = (cwd, extra = {}) => section.collect({ cwd, listDaemons: none, env: {}, ...extra });

test('no project memory: none running stays ok', async (t) => {
  assert.deepEqual(await collect(project(t, { memory: false })),
    [{ subsystem: 'daemons', level: 'ok', message: 'none running', fix: null, repair: null }]);
});

test('project memory with no daemon for it is information naming the backup dependency and the start command', async (t) => {
  const [row] = await collect(project(t));
  assert.equal(row.level, 'info');
  assert.equal(row.fix, null, 'starting a daemon is a human decision, not a sync repair');
  assert.match(row.message, /none running for this project/);
  assert.match(row.message, /backup/);
  assert.match(row.message, /distillation/);
  assert.match(row.message, /`ruflo daemon start`/);
  assert.doesNotMatch(row.message, /start-on-use/, 'no autostart setting found, so none is named');
});

test("other projects' daemons do not cover this one", async (t) => {
  const other = { pid: 424242, workspace: '/elsewhere', ageSecs: 60, workspaceExists: true };
  const [row] = await collect(project(t), { listDaemons: async () => [other] });
  assert.equal(row.level, 'info');
  assert.match(row.message, /^1 running, none for this project/);
});

test("this project's own live daemon keeps the row ok", async (t) => {
  const cwd = project(t);
  fs.mkdirSync(path.join(cwd, '.claude-flow'));
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'daemon.pid'), String(process.pid));
  const own = { pid: process.pid, workspace: cwd, ageSecs: 60, workspaceExists: true };
  assert.deepEqual(await collect(cwd, { listDaemons: async () => [own] }),
    [{ subsystem: 'daemons', level: 'ok', message: '1 running (one per active project is expected)', fix: null, repair: null }]);
});

test('the row names the setting that keeps Ruflo from starting the daemon on use', async (t) => {
  const [row] = await collect(project(t, { autoStart: false }));
  assert.match(row.message, /start-on-use is off: \.claude\/settings\.json claudeFlow\.daemon\.autoStart: false/);
  assert.match(row.message, /ruflo init writes it and ak setup keeps it/);
  const [envRow] = await collect(project(t), { env: { RUFLO_DAEMON_AUTOSTART: '0' } });
  assert.match(envRow.message, /start-on-use is off: RUFLO_DAEMON_AUTOSTART/);
  assert.doesNotMatch(envRow.message, /ak setup keeps it/, 'the env opt-out is not something setup wrote');
});

test('stale daemons keep their warning and sync repair', async (t) => {
  const stale = { pid: 424242, workspace: '/gone', ageSecs: 60, workspaceExists: false };
  const [row] = await collect(project(t), { listDaemons: async () => [stale] });
  assert.equal(row.level, 'warn');
  assert.equal(row.fix, 'sync reaps stale daemons');
});
