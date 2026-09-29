import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hostFromCommand, listActiveHostSessions, parseLsofCwds, parseProcessHeaders, parseProcessList,
} from '../../src/lib/live/index.mjs';
import { surveyHostProcesses } from '../../src/lib/live/process-sessions.mjs';

test('host process detection recognizes controllers and rejects helpers', () => {
  assert.equal(hostFromCommand('claude'), 'claude');
  assert.equal(hostFromCommand('node /opt/bin/codex'), 'codex');
  assert.equal(hostFromCommand('/usr/local/bin/opencode --continue'), 'opencode');
  assert.equal(hostFromCommand('codex mcp-server'), null);
  assert.equal(hostFromCommand('codex -s read-only mcp-server'), null);
  assert.equal(hostFromCommand('node /opt/bin/codex -c model="test" mcp-server'), null);
  assert.equal(hostFromCommand('codex -c developer_instructions="say mcp-server hello"'), 'codex');
  assert.equal(hostFromCommand('codex --config=developer_instructions="say mcp-server hello"'), 'codex');
  assert.equal(hostFromCommand('codex --config developer_instructions=say mcp-server hello'), 'codex',
    'a flattened unquoted config value cannot prove an MCP subcommand');
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

test('runtime survey classifies host services and desktop apps without retaining argv', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const processRows = parseProcessList([
    `100 1 ${startedAt} /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server`,
    `200 1 ${startedAt} /Users/me/.codex/plugins/.plugin-appserver/codex /Users/me/.codex/plugins/.plugin-appserver/codex app-server`,
    `300 1 ${startedAt} /Applications/Claude.app/Contents/MacOS/Claude /Applications/Claude.app/Contents/MacOS/Claude`,
    `400 1 ${startedAt} /usr/local/bin/claude claude`,
  ].join('\n'));
  const survey = await surveyHostProcesses({
    platform: 'darwin', processRows, now: Date.parse(startedAt) + 60_000,
    cwdByPid: new Map([[100, '/'], [200, '/Users/me/.codex'], [300, '/'], [400, '/repos/keel']]),
    metricsByPid: new Map(),
  });

  assert.deepEqual(survey.processes.map((entry) => ({ pid: entry.pid, kind: entry.controllerKind })), [
    { pid: 100, kind: 'host-service' },
    { pid: 200, kind: 'host-service' },
    { pid: 300, kind: 'desktop-app' },
    { pid: 400, kind: 'project-session' },
  ]);
  assert.equal(survey.processes.some((entry) => Object.hasOwn(entry, 'command')), false,
    'classification emits an enum, never the potentially sensitive argv');
});

test('Codex global options before app-server identify a service, never a session', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const processRows = [
    { pid: 10, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex -s read-only -a never app-server' },
    { pid: 20, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config model="test" app-server' },
    { pid: 30, ppid: 1, startedAt, executable: app, command: `${app} app-server` },
    { pid: 31, ppid: 30, startedAt, executable: bundled,
      command: `${bundled} --config=model="test" --strict-config app-server` },
    { pid: 40, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config app-server' },
    { pid: 50, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --unknown value app-server' },
    { pid: 60, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex -- app-server' },
    { pid: 70, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --model app-server' },
    { pid: 80, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config malformed app-server' },
    { pid: 90, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex -c developer_instructions="say app-server hello"' },
    { pid: 91, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config=developer_instructions="say app-server hello"' },
    { pid: 92, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config developer_instructions=say app-server hello' },
    { pid: 93, ppid: 1, startedAt, executable: '/usr/local/bin/codex',
      command: 'codex --config developer_instructions="say app-server hello" app-server' },
  ];
  const cwdByPid = new Map(processRows.map((row) => [row.pid, `/repos/${row.pid}`]));
  const survey = await surveyHostProcesses({ platform: 'darwin', processRows, cwdByPid,
    metricsByPid: new Map() });
  assert.deepEqual(survey.processes.map(({ pid, controllerKind }) => ({ pid, controllerKind })), [
    { pid: 10, controllerKind: 'host-service' },
    { pid: 20, controllerKind: 'host-service' },
    { pid: 30, controllerKind: 'desktop-app' },
    { pid: 40, controllerKind: 'project-session' },
    { pid: 50, controllerKind: 'project-session' },
    { pid: 60, controllerKind: 'project-session' },
    { pid: 70, controllerKind: 'project-session' },
    { pid: 80, controllerKind: 'project-session' },
    { pid: 90, controllerKind: 'project-session' },
    { pid: 91, controllerKind: 'project-session' },
    { pid: 92, controllerKind: 'project-session' },
    { pid: 93, controllerKind: 'host-service' },
  ]);
  assert.deepEqual((await listActiveHostSessions({ platform: 'darwin', processRows, cwdByPid,
    inspectWorkspace: async () => null })).map(({ pid }) => pid), [40, 50, 60, 70, 80, 90, 91, 92]);
});

// macOS `ps -o comm=` prints the executable's full path, and many real paths
// contain spaces (`Application Support`, `Visual Studio Code.app`). The Claude
// desktop app hosts its own Claude Code CLI under such a path (#238 item 3).
const DESKTOP_APP = '/Applications/Claude.app/Contents/MacOS/Claude';
const DESKTOP_CLI = '/Users/me/Library/Application Support/Claude/claude-code/2.1.281/claude.app/Contents/MacOS/claude';

test('the header survey keeps comm paths that contain spaces', () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const rows = parseProcessHeaders([
    `  100     1 ${startedAt}     /usr/local/bin/claude`,
    `  200   300 ${startedAt}     ${DESKTOP_CLI}`,
    `  300     1 ${startedAt}     ${DESKTOP_APP}`,
    `  400     1 ${startedAt}     /Applications/Visual Studio Code.app/Contents/MacOS/Electron`,
  ].join('\n'));
  assert.deepEqual(rows.map((row) => row.pid), [100, 200, 300, 400]);
  assert.equal(rows[1].executable, DESKTOP_CLI);
  assert.equal(rows[3].executable, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  assert.ok(rows.every((row) => row.command === ''), 'the header pass still retains no argv');
});

test('a Claude Code CLI hosted by the Claude desktop app is its own project session', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const processRows = [
    { pid: 300, ppid: 1, startedAt, executable: DESKTOP_APP, command: DESKTOP_APP },
    { pid: 200, ppid: 300, startedAt, executable: DESKTOP_CLI, command: `${DESKTOP_CLI} --output-format stream-json` },
    // The desktop app's own bundled service stays part of the app.
    { pid: 310, ppid: 300, startedAt, executable: '/Applications/Claude.app/Contents/Resources/claude',
      command: '/Applications/Claude.app/Contents/Resources/claude app-server' },
  ];
  const cwdByPid = new Map([[300, '/'], [200, '/repos/keel'], [310, '/']]);
  const survey = await surveyHostProcesses({
    platform: 'darwin', processRows, cwdByPid, metricsByPid: new Map(),
    now: Date.parse(startedAt) + 60_000,
  });
  assert.deepEqual(survey.processes.map((entry) => ({ pid: entry.pid, kind: entry.controllerKind })), [
    { pid: 200, kind: 'project-session' },
    { pid: 300, kind: 'desktop-app' },
  ], 'the desktop-hosted CLI is a root session; the app-service child still folds into the app');

  const sessions = await listActiveHostSessions({
    platform: 'darwin', processRows, cwdByPid, inspectWorkspace: async () => null,
  });
  assert.deepEqual(sessions.filter((session) => session.cwd === '/repos/keel')
    .map((session) => ({ pid: session.pid, host: session.host })), [{ pid: 200, host: 'claude' }]);
});

test('both desktop applications remain applications while their bundled CLIs are sessions', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const claudeApp = '/Applications/Claude.app/Contents/MacOS/Claude';
  const chatgptApp = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const codexCli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const rows = [
    { pid: 100, ppid: 1, startedAt, executable: claudeApp, command: claudeApp },
    { pid: 110, ppid: 100, startedAt, executable: DESKTOP_CLI, command: DESKTOP_CLI },
    { pid: 120, ppid: 110, startedAt, executable: '/usr/local/bin/codex', command: 'codex exec review' },
    { pid: 200, ppid: 1, startedAt, executable: chatgptApp, command: chatgptApp },
    { pid: 210, ppid: 200, startedAt, executable: codexCli, command: `${codexCli} --model test` },
    { pid: 220, ppid: 200, startedAt, executable: codexCli, command: `${codexCli} app-server` },
    { pid: 300, ppid: 1, startedAt, executable: '/usr/local/bin/codex', command: 'codex' },
    { pid: 400, ppid: 1, startedAt, executable: '/Applications/Other.app/Contents/MacOS/codex', command: 'codex' },
    { pid: 500, ppid: 1, startedAt, executable: '/usr/local/bin/claude', command: 'claude --prompt app-server /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' },
  ];
  const cwdByPid = new Map([...rows.map((row) => [row.pid, `/repos/${row.pid}`])]);
  const survey = await surveyHostProcesses({ platform: 'darwin', processRows: rows,
    cwdByPid, metricsByPid: new Map() });
  assert.deepEqual(survey.processes.map(({ pid, host, application, controllerKind }) =>
    ({ pid, host, application, controllerKind })), [
    { pid: 100, host: null, application: 'Claude Desktop', controllerKind: 'desktop-app' },
    { pid: 110, host: 'claude', application: null, controllerKind: 'project-session' },
    { pid: 200, host: null, application: 'ChatGPT desktop app', controllerKind: 'desktop-app' },
    { pid: 210, host: 'codex', application: null, controllerKind: 'project-session' },
    { pid: 300, host: 'codex', application: null, controllerKind: 'project-session' },
    { pid: 500, host: 'claude', application: null, controllerKind: 'project-session' },
  ]);
  const sessions = await listActiveHostSessions({ platform: 'darwin', processRows: rows,
    cwdByPid, inspectWorkspace: async () => null });
  assert.deepEqual(sessions.map(({ pid }) => pid), [110, 210, 300, 500]);
});

test('a host CLI nested under an ordinary controller still folds into it', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const processRows = [
    { pid: 100, ppid: 1, startedAt, executable: '/usr/local/bin/claude', command: 'claude' },
    { pid: 110, ppid: 100, startedAt, executable: DESKTOP_CLI, command: DESKTOP_CLI },
  ];
  const sessions = await listActiveHostSessions({
    platform: 'darwin', processRows, inspectWorkspace: async () => null,
    cwdByPid: new Map([[100, '/repos/keel'], [110, '/repos/keel']]),
  });
  assert.deepEqual(sessions.map((session) => session.pid), [100]);
});

test('a spaced executable path is argv[0], so helper arguments are read from the right slot', () => {
  const spaced = '/Users/me/Library/Application Support/tools/codex';
  assert.equal(hostFromCommand(`${spaced} mcp-server`, spaced), null,
    'a Codex MCP server under a spaced path must not become a controller');
  assert.equal(hostFromCommand(`${spaced} exec review`, spaced), 'codex');
  const node = '/Users/me/Library/Application Support/runtime/bin/node';
  assert.equal(hostFromCommand(`${node} /opt/bin/codex`, node), 'codex',
    'a Node launcher under a spaced path still names its host script');
  assert.equal(hostFromCommand(`${node} /opt/bin/codex mcp-server`, node), null);
  assert.equal(hostFromCommand(`${spaced}-helper mcp-server`, spaced), 'codex',
    'the argv[0] prefix must end at a word boundary, never mid-token');
});

test('the POSIX survey finds a desktop-hosted CLI end to end through ps output with spaces', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('pid=,ppid=,lstart=,comm=')) {
      return { stdout: [
        `  300     1 ${startedAt}     ${DESKTOP_APP}`,
        `  200   300 ${startedAt}     ${DESKTOP_CLI}`,
        `  400     1 ${startedAt}     /Applications/Visual Studio Code.app/Contents/MacOS/Electron`,
      ].join('\n') };
    }
    if (args.includes('pid=,args=')) {
      return { stdout: `  300 ${DESKTOP_APP}\n  200 ${DESKTOP_CLI} --output-format stream-json\n` };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const sessions = await listActiveHostSessions({
    platform: 'darwin', uid: 501, execFileImpl,
    cwdByPid: new Map([[300, '/'], [200, '/repos/keel']]),
    inspectWorkspace: async () => null,
  });
  assert.deepEqual(sessions.map((session) => ({ pid: session.pid, host: session.host })), [
    { pid: 200, host: 'claude' },
  ]);
  assert.equal(calls[1].args[1], '300,200', 'argv is still fetched only for host candidates');
});

test('the POSIX header and targeted argv passes discover the ChatGPT bundled Codex CLI', async () => {
  const startedAt = 'Mon Aug  3 12:00:00 2026';
  const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args.includes('pid=,ppid=,lstart=,comm=')) return { stdout: [
      `100 1 ${startedAt} ${app}`,
      `110 100 ${startedAt} ${cli}`,
      `200 1 ${startedAt} /Applications/Other.app/Contents/MacOS/Other`,
    ].join('\n') };
    if (args.includes('pid=,args=')) return { stdout: `100 ${app}\n110 ${cli} exec review\n` };
    throw new Error('unexpected process probe');
  };
  const survey = await surveyHostProcesses({ platform: 'darwin', uid: 501, execFileImpl,
    cwdByPid: new Map([[100, '/'], [110, '/repos/work']]), metricsByPid: new Map() });
  assert.deepEqual(survey.processes.map(({ pid, host, application }) => ({ pid, host, application })), [
    { pid: 100, host: null, application: 'ChatGPT desktop app' },
    { pid: 110, host: 'codex', application: null },
  ]);
  assert.equal(calls[1][1], '100,110', 'unknown applications never reach the argv pass');
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
