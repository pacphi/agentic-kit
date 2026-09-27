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
  assert.match(row.message, /none running for this project yet; Ruflo starts it on the next `ruflo` command here/);
  assert.match(row.message, /backup/);
  assert.match(row.message, /distillation/);
  assert.doesNotMatch(row.message, /start-on-use is off/, 'no autostart setting found, so none is named');
});

test("other projects' daemons do not cover this one", async (t) => {
  const other = { pid: 424242, workspace: '/elsewhere', ageSecs: 60, workspaceExists: true };
  const [row] = await collect(project(t), { listDaemons: async () => [other] });
  assert.equal(row.level, 'info');
  assert.match(row.message, /^1 running, none for this project yet/);
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
  assert.match(row.message, /start one with `ruflo daemon start`/, 'with start-on-use off, the start command is named');
  assert.match(row.message, /ruflo init writes it/);
  assert.doesNotMatch(row.message, /ak setup keeps it/, 'ak no longer turns it off');
  const [envRow] = await collect(project(t), { env: { RUFLO_DAEMON_AUTOSTART: '0' } });
  assert.match(envRow.message, /start-on-use is off: RUFLO_DAEMON_AUTOSTART/);
  assert.doesNotMatch(envRow.message, /ruflo init writes it/, 'the env opt-out is not something init wrote');
});

test('stale daemons keep their warning and sync repair', async (t) => {
  const stale = { pid: 424242, workspace: '/gone', ageSecs: 60, workspaceExists: false };
  const [row] = await collect(project(t), { listDaemons: async () => [stale] });
  assert.equal(row.level, 'warn');
  assert.equal(row.fix, 'sync reaps stale daemons');
});

// ── a live daemon that defers backup or distillation (3.46.1) ──────────────
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function liveDaemonDeferring(t, lines, { git = true } = {}) {
  const cwd = project(t);
  if (git) fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, '.claude-flow', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'daemon.pid'), String(process.pid));
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'logs', 'daemon.log'), `${lines.join('\n')}\n`);
  return cwd;
}
const own = (cwd) => async () => [{ pid: process.pid, workspace: cwd, ageSecs: 60, workspaceExists: true }];
const deferral = (rows) => rows.find((r) => /deferred/.test(r.message));
const MEMORY_LOW = [
  `[${new Date(NOW - 3 * HOUR).toISOString()}] [INFO] Daemon started (PID: 42, CPUs: 16, workers: 7, maxCpuLoad: 28, minFreeMemoryPercent: 5%)`,
  `[${new Date(NOW - 2 * HOUR).toISOString()}] [INFO] Worker consolidate deferred: Memory too low: 3.9% free`,
];

test('on macOS a live daemon deferring distillation for low memory warns, and sync sets the threshold', async (t) => {
  const cwd = liveDaemonDeferring(t, MEMORY_LOW);
  const rows = await collect(cwd, { listDaemons: own(cwd), now: NOW, platform: 'darwin', loadConfig: kit(), rufloVersion: '3.46.1' });
  assert.equal(rows[0].level, 'ok', 'the running count stays');
  const row = deferral(rows);
  assert.deepEqual(row, {
    subsystem: 'daemons', level: 'warn',
    message: "Ruflo's daemon is running but deferred distillation 2h ago: Memory too low: 3.9% free (macOS free-memory gate, ruvnet/ruflo#2935)",
    fix: "sync sets Ruflo's macOS memory threshold", repair: 'sync',
  });
});

test('elsewhere the same deferral is a manual step naming the flat key', async (t) => {
  const cwd = liveDaemonDeferring(t, MEMORY_LOW);
  const row = deferral(await collect(cwd, { listDaemons: own(cwd), now: NOW, platform: 'linux' }));
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual');
  assert.doesNotMatch(row.message, /macOS/);
  assert.match(row.fix, /daemon\.resourceThresholds\.minFreeMemoryPercent/);
  assert.match(row.fix, /\.claude-flow\/config\.json/);
});

test('a deferral the worker has since recovered from is not reported', async (t) => {
  const cwd = liveDaemonDeferring(t, MEMORY_LOW);
  fs.mkdirSync(path.join(cwd, '.claude-flow', 'metrics'));
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'metrics', 'consolidation.json'),
    JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), distillationEnabled: true }));
  assert.equal(deferral(await collect(cwd, { listDaemons: own(cwd), now: NOW, platform: 'darwin' })), undefined);
});

test('no deferral row without a live daemon for this project', async (t) => {
  const cwd = liveDaemonDeferring(t, MEMORY_LOW);
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'daemon.pid'), '0');
  assert.equal(deferral(await collect(cwd, { now: NOW, platform: 'darwin' })), undefined);
});

// ── ak-managed daemon settings drift (Task 2.2) ────────────────────────────
function rufloRepo(t, { autoStart } = {}) {
  const cwd = project(t, { autoStart });
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, '.claude-flow'), { recursive: true });
  return cwd;
}
const drift = (rows) => rows.find((r) => /ak-managed daemon settings/.test(r.message));
const kit = (rufloDaemon = {}) => () => ({ rufloDaemon: { receipts: {}, ...rufloDaemon } });

test("init's autoStart:false in a Ruflo repository is drift that sync repairs", async (t) => {
  const cwd = rufloRepo(t, { autoStart: false });
  const rows = await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'linux' });
  const row = drift(rows);
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'sync');
  assert.equal(row.fix, "sync applies ak's Ruflo daemon settings");
  assert.match(row.message, /differ from what Ruflo 3\.46\.1 needs/);
  assert.match(row.message, /claudeFlow\.daemon\.autoStart/);
  assert.equal(fs.existsSync(path.join(cwd, '.claude-flow', 'config.json')), false, 'status writes nothing');
});

test('on macOS a missing memory floor is drift; converged settings and an opt-out are not', async (t) => {
  const cwd = rufloRepo(t);
  const mac = drift(await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'darwin' }));
  assert.match(mac.message, /daemon\.resourceThresholds\.minFreeMemoryPercent/);
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'), JSON.stringify({ 'daemon.resourceThresholds.minFreeMemoryPercent': 0 }));
  assert.equal(drift(await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'darwin' })), undefined);
  const optedOut = rufloRepo(t, { autoStart: false });
  assert.equal(drift(await collect(optedOut, { loadConfig: kit({ autoStart: false }), rufloVersion: '3.46.1', platform: 'linux' })), undefined);
});

test('no drift row outside a Ruflo repository', async (t) => {
  const cwd = project(t, { autoStart: false });
  const rows = await collect(cwd, { loadConfig: () => { throw new Error('kit.json must not be read here'); }, rufloVersion: '3.46.1', platform: 'darwin' });
  assert.equal(drift(rows), undefined);
});

test('outside a Ruflo repository the macOS deferral is a manual step: sync would not act there', async (t) => {
  const cwd = liveDaemonDeferring(t, MEMORY_LOW, { git: false });
  const row = deferral(await collect(cwd, { listDaemons: own(cwd), now: NOW, platform: 'darwin' }));
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual');
  assert.match(row.message, /ruvnet\/ruflo#2935/);
  assert.match(row.fix, /daemon\.resourceThresholds\.minFreeMemoryPercent/);
});

// A config.json ak cannot manage is left untouched, and status says so with
// the key(s) the user has to set: sync would change nothing there.
const held = (rows) => rows.find((r) => /\.claude-flow\/config\.json/.test(r.message) && /not ak-managed/.test(r.message));

test('a malformed config.json is reported as a manual step naming the key, never a sync repair', async (t) => {
  const cwd = rufloRepo(t);
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'), '{');
  const rows = await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'darwin' });
  const row = held(rows);
  assert.ok(row, JSON.stringify(rows));
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual');
  assert.match(row.message, /unreadable or not a JSON object/);
  assert.match(row.fix, /daemon\.resourceThresholds\.minFreeMemoryPercent/);
  assert.equal(rows.filter((r) => r.repair === 'sync').length, 0, JSON.stringify(rows));
  assert.equal(fs.readFileSync(path.join(cwd, '.claude-flow', 'config.json'), 'utf8'), '{', 'status writes nothing');
});

test("a user's own value for a desired key is reported as a manual step naming the key and value", async (t) => {
  const cwd = rufloRepo(t);
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'),
    JSON.stringify({ 'daemon.resourceThresholds.minFreeMemoryPercent': 2 }));
  const rows = await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'darwin' });
  const row = held(rows);
  assert.ok(row, JSON.stringify(rows));
  assert.equal(row.repair, 'manual');
  assert.match(row.message, /"daemon\.resourceThresholds\.minFreeMemoryPercent": 2/);
  assert.match(row.fix, /"daemon\.resourceThresholds\.minFreeMemoryPercent": 0/);
  assert.equal(drift(rows), undefined, 'nothing for sync to apply');
});

test('a config.json is not reported when ak wants no keys here', async (t) => {
  const cwd = rufloRepo(t);
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'), '{');
  assert.equal(held(await collect(cwd, { loadConfig: kit(), rufloVersion: '3.46.1', platform: 'linux' })), undefined);
});

test('on macOS a deferral under a user-managed config.json is a manual step: sync would only restart the daemon', async (t) => {
  for (const content of ['{', JSON.stringify({ 'daemon.resourceThresholds.minFreeMemoryPercent': 2 })]) {
    const cwd = liveDaemonDeferring(t, MEMORY_LOW);
    fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'), content);
    const rows = await collect(cwd, { listDaemons: own(cwd), now: NOW, platform: 'darwin', loadConfig: kit(), rufloVersion: '3.46.1' });
    const row = deferral(rows);
    assert.equal(row.repair, 'manual', content);
    assert.match(row.message, /ruvnet\/ruflo#2935/);
    assert.match(row.fix, /daemon\.resourceThresholds\.minFreeMemoryPercent/);
    assert.match(row.fix, /\.claude-flow\/config\.json/);
    assert.equal(fs.readFileSync(path.join(cwd, '.claude-flow', 'config.json'), 'utf8'), content, 'status writes nothing');
  }
});
