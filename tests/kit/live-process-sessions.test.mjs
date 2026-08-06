import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hostFromCommand, listActiveHostSessions, parseLsofCwds, parseProcessHeaders, parseProcessList,
} from '../../src/lib/live/index.mjs';

test('host process detection recognizes controllers and rejects helpers', () => {
  assert.equal(hostFromCommand('claude'), 'claude');
  assert.equal(hostFromCommand('node /opt/bin/codex'), 'codex');
  assert.equal(hostFromCommand('/usr/local/bin/opencode --continue'), 'opencode');
  assert.equal(hostFromCommand('codex mcp-server'), null);
  assert.equal(hostFromCommand('/opt/bin/codex-code-mode-host'), null);
  assert.equal(hostFromCommand('node app.mjs codex'), null);
  assert.equal(hostFromCommand('python worker.py claude'), null);
  assert.equal(hostFromCommand('echo opencode'), null);
});

test('process and cwd parsers accept stable machine-readable shapes', () => {
  assert.deepEqual(parseProcessList([
    '  10  1 Mon Aug  3 12:00:00 2026 claude claude',
    '20 10 Mon Aug  3 12:01:00 2026 codex codex exec task',
  ].join('\n')), [
    { pid: 10, ppid: 1, startedAt: 'Mon Aug  3 12:00:00 2026', executable: 'claude', command: 'claude' },
    { pid: 20, ppid: 10, startedAt: 'Mon Aug  3 12:01:00 2026', executable: 'codex', command: 'codex exec task' },
  ]);
  assert.deepEqual([...parseLsofCwds('p10\nn/work/one\np20\nn/work/two\n')], [
    [10, '/work/one'], [20, '/work/two'],
  ]);
});

test('runtime survey keeps top-level sessions and folds nested host workers into their parent', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const processRows = parseProcessList([
    `100 1 ${startedAt} claude claude`,
    `110 100 ${startedAt} zsh /bin/zsh -c work`,
    `111 110 ${startedAt} codex codex exec review`,
    `200 1 ${startedAt} node node /opt/bin/codex`,
    `201 200 ${startedAt} codex /opt/vendor/codex`,
    `300 1 ${startedAt} opencode opencode`,
    `400 1 ${startedAt} codex codex mcp-server`,
  ].join('\n'));
  const cwdByPid = new Map([
    [100, '/repos/keel'], [111, '/repos/keel'],
    [200, '/repos/agentic-kit'], [201, '/repos/agentic-kit'],
    [300, '/repos/emailibrium'], [400, '/repos/noise'],
  ]);
  assert.deepEqual(await listActiveHostSessions({
    platform: 'darwin', processRows, cwdByPid,
  }), [
    { pid: 100, startedAt, host: 'claude', cwd: '/repos/keel' },
    { pid: 200, startedAt, host: 'codex', cwd: '/repos/agentic-kit' },
    { pid: 300, startedAt, host: 'opencode', cwd: '/repos/emailibrium' },
  ]);
});

test('workspace inspection is shared consistently across Claude, Codex, and OpenCode', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const processRows = parseProcessList([
    `100 1 ${startedAt} claude claude`,
    `200 1 ${startedAt} codex codex`,
    `300 1 ${startedAt} opencode opencode`,
  ].join('\n'));
  const cwdByPid = new Map([[100, '/repos/shared'], [200, '/repos/shared'], [300, '/repos/shared']]);
  const workspace = {
    key: 'workspace:0123456789abcdef', repositoryLabel: 'shared',
    directoryLabel: 'repo root', branchLabel: 'main', branchState: 'attached',
    changes: { additions: 4, deletions: 1, files: 1, binaryFiles: 0,
      basis: 'tracked-vs-head' }, capturedAt: '2026-08-03T12:00:00Z',
    source: 'git', confidence: 'observed',
  };
  let inspections = 0;
  const sessions = await listActiveHostSessions({
    platform: 'darwin', processRows, cwdByPid,
    inspectWorkspace: async () => { inspections++; return workspace; },
  });
  assert.equal(inspections, 1);
  assert.deepEqual(sessions.map((session) => session.host), ['claude', 'codex', 'opencode']);
  assert.ok(sessions.every((session) => session.workspace === workspace));
});

test('nonempty unparseable process output degrades instead of becoming a healthy empty survey', async () => {
  await assert.rejects(listActiveHostSessions({
    platform: 'darwin',
    execFileImpl: async () => ({ stdout: 'localized or malformed process output' }),
  }), (error) => error.code === 'ERR_RUNTIME_PROCESS_SURVEY');
});

test('runtime discovery scopes ps to the current UID and reads argv only for host candidates', async () => {
  const calls = [];
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const execFileImpl = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('pid=,ppid=,lstart=,comm=')) {
      return { stdout: [
        `100 1 ${startedAt} node`,
        `101 1 ${startedAt} ssh`,
        `102 1 ${startedAt} claude`,
      ].join('\n') };
    }
    if (args.includes('pid=,args=')) {
      return { stdout: '100 node /opt/bin/codex\n102 claude\n' };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const rows = parseProcessHeaders(`100 1 ${startedAt} node\n`);
  assert.equal(rows[0].command, '', 'the first-stage parser retains no argv');

  const sessions = await listActiveHostSessions({
    platform: 'linux', uid: 501, execFileImpl,
    cwdByPid: new Map([[100, '/repos/a'], [102, '/repos/b']]),
    inspectWorkspace: async () => null,
  });
  assert.deepEqual(sessions.map((row) => row.host), ['codex', 'claude']);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-U', '501', '-x', '-o']);
  assert.equal(calls[0].args.includes('-a'), false, 'never surveys all users');
  assert.equal(calls[1].args[1], '100,102', 'ssh/non-host PID never reaches the argv survey');
});

test('AK_RUNTIME_DEBUG is opt-in, bounded to known stages, and never leaks raw argv', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-runtime-debug-'));
  const log = path.join(dir, 'runtime-debug.log');
  const execFileImpl = async (command, args) => {
    if (args.includes('pid=,ppid=,lstart=,comm=')) {
      return { stdout: [
        `100 1 ${startedAt} claude`,
        `101 100 ${startedAt} ssh`,
      ].join('\n') };
    }
    if (args.includes('pid=,args=')) return { stdout: '100 claude --dangerous-secret-token\n' };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const before = process.env.AK_RUNTIME_DEBUG;
  const beforeFile = process.env.AK_RUNTIME_DEBUG_FILE;
  try {
    delete process.env.AK_RUNTIME_DEBUG;
    process.env.AK_RUNTIME_DEBUG_FILE = log;
    await listActiveHostSessions({
      platform: 'linux', uid: 501, execFileImpl,
      cwdByPid: new Map([[100, '/repos/emailibrium']]),
      inspectWorkspace: async () => null,
    });
    assert(!fs.existsSync(log), 'debug-off must not write a diagnostic log');

    process.env.AK_RUNTIME_DEBUG = '1';
    await listActiveHostSessions({
      platform: 'linux', uid: 501, execFileImpl,
      cwdByPid: new Map([[100, '/repos/emailibrium']]),
      inspectWorkspace: async () => null,
    });
    const diagnostic = fs.readFileSync(log, 'utf8');
    assert.match(diagnostic, /stage=survey uid=501 rowCount=2/);
    assert.match(diagnostic, /stage=argv-candidates count=1 pids=100/);
    assert.match(diagnostic, /stage=root-controller pid=100 host=claude/);
    assert.match(diagnostic, /stage=cwd pid=100 found=true cwd=\/repos\/emailibrium/);
    assert.match(diagnostic, /stage=result sessionCount=1/);
    assert(!diagnostic.includes('--dangerous-secret-token'), 'raw argv must never reach the debug log');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(log).mode & 0o777, 0o600, 'debug log must be owner-only');
    }
  } finally {
    if (before === undefined) delete process.env.AK_RUNTIME_DEBUG; else process.env.AK_RUNTIME_DEBUG = before;
    if (beforeFile === undefined) delete process.env.AK_RUNTIME_DEBUG_FILE; else process.env.AK_RUNTIME_DEBUG_FILE = beforeFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable runtime-debug sink never breaks discovery', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-runtime-debug-unwritable-'));
  const before = process.env.AK_RUNTIME_DEBUG;
  const beforeFile = process.env.AK_RUNTIME_DEBUG_FILE;
  try {
    process.env.AK_RUNTIME_DEBUG = '1';
    process.env.AK_RUNTIME_DEBUG_FILE = dir; // appendFileSync on a directory fails
    const processRows = parseProcessList([`100 1 ${startedAt} claude claude`].join('\n'));
    const sessions = await listActiveHostSessions({
      platform: 'darwin', processRows, cwdByPid: new Map([[100, '/repos/keel']]),
      inspectWorkspace: async () => null,
    });
    assert.deepEqual(sessions.map((s) => s.host), ['claude']);
  } finally {
    if (before === undefined) delete process.env.AK_RUNTIME_DEBUG; else process.env.AK_RUNTIME_DEBUG = before;
    if (beforeFile === undefined) delete process.env.AK_RUNTIME_DEBUG_FILE; else process.env.AK_RUNTIME_DEBUG_FILE = beforeFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
