import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostFromCommand, listActiveHostSessions, parseLsofCwds, parseProcessList,
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
