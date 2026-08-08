// The Windows half of the runtime census, which cannot be verified on the
// machines this repo is developed on. Everything below runs the REAL win32 code
// path with CAPTURED PowerShell output fed through an injected runner, so the
// parsers, the host classification, the root-controller de-nesting and the
// degradation contract are all exercised without a Windows host.
//
// The contract these tests exist to pin down: the census is the GUARANTEED
// floor. `Get-CimInstance Win32_Process` gives pid/ppid/start/image/CPU/RSS and
// always answers; the true per-process cwd comes from a P/Invoke walk of the
// PEB that can be refused by AV, execution policy, permissions or a WOW64
// mismatch. When that probe fails — for ANY reason — every other field must
// still be reported and only the project attribution may be lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseWin32Census, parseWin32Commands, parseWin32Cwds,
  parseProcessList, parseProcessMetrics, hostFromCommand, surveyHostProcesses,
} from '../../src/lib/live/process-sessions.mjs';
import { collectRuntimeCensus } from '../../src/lib/footprint/runtime.mjs';

const SCRIPT = 'C:\\opt\\agentic-kit\\scripts\\win-process-survey.ps1';
const WIN_ENV = { SystemRoot: 'C:\\WINDOWS' };
const POWERSHELL = path.join(
  'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const WIN_NOW = Date.parse('2026-08-06T12:10:00Z');
const POSIX_START = 'Thu Aug  6 12:00:00 2026';
const POSIX_NOW = Date.parse(POSIX_START) + 600_000;

// Captured `-Mode census` output, CRLF exactly as PowerShell emits it, with the
// noise a real machine carries: the idle process, a kernel row, a shell, and a
// line truncated by a transport that a parser must skip rather than half-read.
const CENSUS = [
  '0\t0\t2026-08-06T11:00:00Z\tSystem_Idle_Process\t0\t8192',
  '4\t0\t2026-08-06T11:00:00Z\tSystem\t312500\t147456',
  '5000\t4\t2026-08-06T11:30:00Z\texplorer.exe\t93750000\t41943040',
  '6100\t5000\t2026-08-06T12:00:00Z\tclaude.exe\t30000000\t536870912',
  '6110\t6100\t2026-08-06T12:01:00Z\tpowershell.exe\t5000000\t20971520',
  '6111\t6110\t2026-08-06T12:02:00Z\tcodex.exe\t1000000\t104857600',
  '6200\t5000\t2026-08-06T12:00:00Z\tnode.exe\t12000000\t268435456',
  '6201\t6200\t2026-08-06T12:03:00Z\tcodex.exe\t500000\t83886080',
  '6300\t5000\t2026-08-06T11:55:00Z\topencode.exe\t36000000\t157286400',
  '6400\t5000\t2026-08-06T11:58:00Z\tcodex.exe\t250000\t62914560',
  '6500\t5000\t2026-08-06T11:20:00Z\tclaude.exe\t9000000\t402653184',
  '7000\t5000\t2026-08-06T11:59:00Z\ttruncated-row',
  '',
].join('\r\n');

// Captured `-Mode commands`. 6500 belongs to another user; 6400 is codex's MCP
// server, which is a tool of some other session and never a controller.
const COMMANDS = [
  '6100\town\t"C:\\Users\\dev\\AppData\\Local\\Programs\\claude\\claude.exe" --continue',
  '6111\town\t"C:\\Users\\dev\\.codex\\bin\\codex.exe" exec review',
  '6200\town\tC:\\nodejs\\node.exe C:\\opt\\bin\\codex',
  '6201\town\t"C:\\Users\\dev\\.codex\\bin\\codex.exe"',
  '6300\town\tC:\\opencode\\opencode.exe',
  '6400\town\t"C:\\Users\\dev\\.codex\\bin\\codex.exe" mcp-server',
  '6500\tother\t',
  '',
].join('\r\n');

const CWDS = [
  '6100\tok\tC:\\repos\\keel',
  '6200\tok\tC:\\repos\\agentic-kit',
  '6300\terr\topen-denied',
  '',
].join('\r\n');

/**
 * Stands in for `powershell.exe -File win-process-survey.ps1`. `cwd` is a
 * function so each test can decide how that one fragile mode behaves — return
 * captured output, return nothing, or throw — without touching the other modes.
 */
function winRunner({ census = CENSUS, commands = COMMANDS, cwd = () => CWDS } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    const mode = args[args.indexOf('-Mode') + 1];
    if (mode === 'census') return { stdout: census };
    if (mode === 'commands') return { stdout: commands };
    return { stdout: await cwd(args) };
  };
  runner.calls = calls;
  runner.pidsFor = (mode) => {
    const call = calls.find((entry) => entry.args[entry.args.indexOf('-Mode') + 1] === mode);
    const ids = call?.args[call.args.indexOf('-ProcessIds') + 1];
    return ids ? ids.split(',').map(Number) : [];
  };
  return runner;
}

const win32Survey = (options = {}) => surveyHostProcesses({
  platform: 'win32', scriptPath: SCRIPT, env: WIN_ENV, now: WIN_NOW, ...options,
});

// ── the pure census parser ────────────────────────────────────────────────────

test('the census parser extracts pid, ppid, start, image, CPU and RSS', () => {
  const rows = parseWin32Census(CENSUS);
  assert.equal(rows.length, 11, 'the truncated row is skipped, not half-read');

  const claude = rows.find((row) => row.pid === 6100);
  assert.deepEqual(claude, {
    pid: 6100, ppid: 5000, startedAt: '2026-08-06T12:00:00Z', executable: 'claude.exe',
    command: '', cpuMs: 3000, rssBytes: 536870912,
  });
  // Win32_Process reports CPU in 100ns units; the parser normalizes once.
  assert.equal(rows.find((row) => row.pid === 6200).cpuMs, 1200);
  assert.equal(rows.find((row) => row.pid === 4).cpuMs, 31.25);
  assert.equal(rows.every((row) => row.command === ''),
    true, 'the census projection never asks for a command line');
});

test('the census parser reports an unusable CPU or RSS field as null, never as 0', () => {
  const rows = parseWin32Census([
    '6100\t5000\t2026-08-06T12:00:00Z\tclaude.exe\tnot-a-number\talso-not',
    '6200\t5000\t2026-08-06T12:00:00Z\tcodex.exe\t0\t0',
  ].join('\n'));
  assert.equal(rows[0].cpuMs, null);
  assert.equal(rows[0].rssBytes, null);
  // A real zero survives as a zero: the distinction is the whole point.
  assert.equal(rows[1].cpuMs, 0);
  assert.equal(rows[1].rssBytes, 0);
});

test('the census parser rejects malformed and non-numeric rows', () => {
  assert.deepEqual(parseWin32Census(''), []);
  assert.deepEqual(parseWin32Census(null), []);
  assert.deepEqual(parseWin32Census([
    'Get-CimInstance : Access is denied.',
    'pid\tppid\tstart\tname\tcpu\trss',
    '6100\t5000\t2026-08-06T12:00:00Z\tclaude.exe',
  ].join('\r\n')), []);
});

test('the command parser separates owned, foreign and unattributable processes', () => {
  const { owned, foreign, failed } = parseWin32Commands([
    '6100\town\tclaude.exe --continue',
    '6500\tother\t',
    '6600\terr\towner-probe-failed',
    '6700\terr\t',
    'garbage',
  ].join('\r\n'));
  assert.equal(owned.get(6100), 'claude.exe --continue');
  assert.equal(foreign.has(6500), true);
  // "someone else's process" and "we could not ask" are different facts, and
  // only the first is safe to treat as deliberately excluded.
  assert.equal(failed.get(6600), 'owner-probe-failed');
  assert.equal(failed.get(6700), 'owner-probe-failed');
  assert.equal(foreign.has(6600), false);
});

test('the cwd parser keeps per-pid successes and per-pid failure reasons apart', () => {
  const { found, failures } = parseWin32Cwds([
    '6100\tok\tC:\\repos\\keel',
    '6200\terr\twow64-mismatch',
    '6300\tok\t',
    '6400\terr\t',
  ].join('\r\n'));
  assert.deepEqual([...found], [[6100, 'C:\\repos\\keel']]);
  assert.equal(failures.get(6200), 'wow64-mismatch');
  assert.equal(failures.get(6300), 'cwd-probe-failed',
    'an empty ok path is not a working directory');
  assert.equal(failures.get(6400), 'cwd-probe-failed');
});

// ── classification and de-nesting ─────────────────────────────────────────────

test('host classification reads a Windows image name the same way it reads a POSIX one', () => {
  assert.equal(hostFromCommand('"C:\\Users\\dev\\claude.exe" --continue', 'claude.exe'), 'claude');
  assert.equal(hostFromCommand('C:\\opencode\\opencode.exe', 'opencode.exe'), 'opencode');
  assert.equal(hostFromCommand('C:\\nodejs\\node.exe C:\\opt\\bin\\codex', 'node.exe'), 'codex');
  // The MCP server is a tool of some other session, never a controller.
  assert.equal(
    hostFromCommand('"C:\\Users\\dev\\.codex\\bin\\codex.exe" mcp-server', 'codex.exe'), null);
  assert.equal(hostFromCommand('C:\\tools\\watcher.exe codex', 'watcher.exe'), null);
  assert.equal(hostFromCommand('C:\\nodejs\\node.exe C:\\tools\\watch.js', 'node.exe'), null);
  // Same commands, POSIX spelling: identical verdicts, which is what makes the
  // win32 path testable off Windows at all.
  assert.equal(hostFromCommand('/usr/local/bin/claude --continue', 'claude'), 'claude');
  assert.equal(hostFromCommand('node /opt/bin/codex', 'node'), 'codex');
  assert.equal(hostFromCommand('codex mcp-server', 'codex'), null);
});

test('the win32 census de-nests to root controllers exactly as the POSIX survey does', async () => {
  const runner = winRunner();
  const census = await win32Survey({ execFileImpl: runner });

  assert.deepEqual(census.processes.map((entry) => ({ host: entry.host, pid: entry.pid })), [
    { host: 'claude', pid: 6100 },
    { host: 'codex', pid: 6200 },
    { host: 'opencode', pid: 6300 },
  ]);
  // 6111 (codex under a shell under claude) and 6201 (codex under its own node
  // launcher) stay part of their parent's execution graph; 6400 is an MCP
  // server; 6500 belongs to another user and had its image name cleared, so
  // classification could never promote it.
  assert.equal(census.childProcessCount, 3);
  assert.equal(census.surveyedProcessCount, 11);
  assert.equal(census.platform, 'win32');
  assert.equal(census.observedAt, new Date(WIN_NOW).toISOString());
});

test('the win32 and POSIX surveys agree on the same process topology', async () => {
  const win = await win32Survey({ execFileImpl: winRunner() });

  // The same machine as seen through `ps` + `lsof`. 6500 is absent because the
  // POSIX survey scopes to the current uid at the source, where the Windows one
  // must filter after the fact with GetOwner.
  const processRows = parseProcessList([
    `6100 5000 ${POSIX_START} /usr/local/bin/claude claude --continue`,
    `6110 6100 ${POSIX_START} /bin/zsh /bin/zsh -c work`,
    `6111 6110 ${POSIX_START} /usr/local/bin/codex codex exec review`,
    `6200 5000 ${POSIX_START} node node /opt/bin/codex`,
    `6201 6200 ${POSIX_START} /opt/vendor/codex /opt/vendor/codex`,
    `6300 5000 ${POSIX_START} /usr/local/bin/opencode opencode`,
    `6400 5000 ${POSIX_START} /usr/local/bin/codex codex mcp-server`,
  ].join('\n'));
  const posix = await surveyHostProcesses({
    platform: 'darwin', processRows, now: POSIX_NOW,
    cwdByPid: new Map([[6100, '/repos/keel'], [6200, '/repos/agentic-kit']]),
    metricsByPid: parseProcessMetrics([
      '6100 0.5 524288', '6200 0.2 262144', '6300 0.4 153600',
    ].join('\n')),
  });

  const shape = (survey) => survey.processes.map((entry) => ({
    host: entry.host, pid: entry.pid, cpuPercent: entry.cpuPercent, rssBytes: entry.rssBytes,
  }));
  // Different platforms, different sources, one meaning per column: CPU time
  // over process lifetime as a percentage of one core, and resident bytes.
  assert.deepEqual(shape(win), shape(posix));
  assert.deepEqual(shape(win), [
    { host: 'claude', pid: 6100, cpuPercent: 0.5, rssBytes: 536870912 },
    { host: 'codex', pid: 6200, cpuPercent: 0.2, rssBytes: 268435456 },
    { host: 'opencode', pid: 6300, cpuPercent: 0.4, rssBytes: 157286400 },
  ]);
  assert.equal(win.childProcessCount, posix.childProcessCount);
  assert.deepEqual(win.processes.map((entry) => entry.uptimeMs), [600_000, 600_000, 900_000]);
  assert.deepEqual(posix.processes.map((entry) => entry.uptimeMs), [600_000, 600_000, 600_000]);
});

// ── the census survives every cwd failure ─────────────────────────────────────

test('a per-pid cwd refusal costs that row its project and nothing else', async () => {
  const census = await win32Survey({ execFileImpl: winRunner() });
  const [claude, , opencode] = census.processes;

  assert.equal(claude.cwd, 'C:\\repos\\keel');
  assert.equal(claude.cwdReason, null);
  // OpenProcess was denied for this one. Every measured field survives.
  assert.equal(opencode.cwd, null);
  assert.equal(opencode.cwdReason, 'open-denied');
  assert.equal(opencode.pid, 6300);
  assert.equal(opencode.ppid, 5000);
  assert.equal(opencode.startedAt, '2026-08-06T11:55:00Z');
  assert.equal(opencode.uptimeMs, 900_000);
  assert.equal(opencode.cpuPercent, 0.4);
  assert.equal(opencode.rssBytes, 157286400);
});

test('a cwd probe that fails for EVERY reason still yields a complete census', async () => {
  // Each of these is a real way the P/Invoke path dies on a locked-down
  // machine: the runner blows up (AV killed powershell, execution policy),
  // Add-Type could not compile, the type compiled but the reads were refused,
  // and the probe produced nothing parseable at all.
  const cases = [
    { label: 'runner threw', cwd: () => { throw new Error('powershell was blocked'); },
      reasons: ['cwd-survey-failed', 'cwd-survey-failed', 'cwd-survey-failed'] },
    { label: 'Add-Type refused',
      cwd: () => ['6100\terr\tcompile-failed', '6200\terr\tcompile-failed',
        '6300\terr\tcompile-failed'].join('\r\n'),
      reasons: ['compile-failed', 'compile-failed', 'compile-failed'] },
    { label: 'mixed refusals',
      cwd: () => ['6100\terr\twow64-mismatch', '6200\terr\treader-not-64bit',
        '6300\terr\tpeb-read-failed'].join('\r\n'),
      reasons: ['wow64-mismatch', 'reader-not-64bit', 'peb-read-failed'] },
    { label: 'no output at all', cwd: () => '',
      reasons: ['cwd-unavailable', 'cwd-unavailable', 'cwd-unavailable'] },
  ];

  for (const { label, cwd, reasons } of cases) {
    const census = await win32Survey({ execFileImpl: winRunner({ cwd }) });
    assert.equal(census.processes.length, 3, label);
    assert.deepEqual(census.processes.map((entry) => entry.cwdReason), reasons, label);
    for (const entry of census.processes) {
      assert.equal(entry.cwd, null, label);
      // The guaranteed floor: everything Get-CimInstance already answered is
      // still here. A cwd failure must never fail the census.
      assert.equal(Number.isFinite(entry.pid), true, label);
      assert.equal(Number.isFinite(entry.ppid), true, label);
      assert.equal(Number.isFinite(entry.uptimeMs), true, label);
      assert.equal(Number.isFinite(entry.cpuPercent), true, label);
      assert.equal(Number.isFinite(entry.rssBytes), true, label);
      assert.ok(entry.host, label);
      assert.ok(entry.startedAt, label);
    }
    assert.equal(census.childProcessCount, 3, label);
  }
});

test('a partial cwd result keeps what it read instead of discarding the batch', async () => {
  const runner = winRunner({
    cwd: () => {
      throw Object.assign(new Error('timeout'), { stdout: '6200\tok\tC:\\repos\\agentic-kit' });
    },
  });
  const census = await win32Survey({ execFileImpl: runner });
  assert.deepEqual(census.processes.map((entry) => entry.cwd),
    [null, 'C:\\repos\\agentic-kit', null]);
  assert.equal(census.processes[0].cwdReason, 'cwd-unavailable');
});

test('a Windows cwd is judged absolute by Windows rules, wherever the test runs', async () => {
  const census = await win32Survey({
    execFileImpl: winRunner({ cwd: () => ['6100\tok\tC:\\repos\\keel', '6200\tok\trelative\\path',
      '6300\tok\t\\\\server\\share\\repo'].join('\r\n') }),
  });
  assert.deepEqual(census.processes.map((entry) => entry.cwd),
    ['C:\\repos\\keel', null, '\\\\server\\share\\repo']);
  assert.equal(census.processes[1].cwdReason, 'cwd-unavailable');
});

// ── invocation shape ──────────────────────────────────────────────────────────

test('the survey script is invoked like ps is: absolute path, numeric pids only', async () => {
  const runner = winRunner();
  await win32Survey({ execFileImpl: runner });

  assert.equal(runner.calls.length, 3);
  for (const call of runner.calls) {
    assert.equal(call.command, POWERSHELL, 'PATH shadowing must not redirect the survey');
    assert.deepEqual(call.args.slice(0, 7), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    ]);
  }
  assert.equal(runner.calls[0].args.includes('-ProcessIds'), false,
    'the census covers every process and takes no caller-supplied input');
  // argv is the sensitive field, so it is requested only for pids whose image
  // name could actually be a controller or its Node launcher.
  assert.deepEqual(runner.pidsFor('commands'), [6100, 6111, 6200, 6201, 6300, 6400, 6500]);
  assert.deepEqual(runner.pidsFor('cwd'), [6100, 6200, 6300]);
});

test('an unbelievable empty census degrades instead of reporting an idle machine', async () => {
  await assert.rejects(win32Survey({ execFileImpl: winRunner({ census: '' }) }),
    (error) => error.code === 'ERR_RUNTIME_PROCESS_SURVEY');
  await assert.rejects(win32Survey({ execFileImpl: winRunner({ census: 'Access is denied.' }) }),
    (error) => error.code === 'ERR_RUNTIME_PROCESS_SURVEY');
});

test('no host-shaped process means no command-line probe and no cwd probe at all', async () => {
  const runner = winRunner({
    census: ['5000\t4\t2026-08-06T11:30:00Z\texplorer.exe\t0\t41943040',
      '5001\t5000\t2026-08-06T11:31:00Z\tnotepad.exe\t0\t8388608'].join('\r\n'),
  });
  const census = await win32Survey({ execFileImpl: runner });
  assert.deepEqual(census.processes, []);
  assert.equal(census.surveyedProcessCount, 2);
  assert.equal(runner.calls.length, 1, 'nothing sensitive is read when nothing could be a host');
});

// ── the Runtime section's rendering of all this ───────────────────────────────

test('a blocked Windows cwd probe renders as an honest not-attributable project', async () => {
  const runner = winRunner({
    cwd: () => ['6100\tok\tC:\\repos\\keel', '6200\terr\tcompile-failed',
      '6300\terr\twow64-mismatch'].join('\r\n'),
  });
  const census = await collectRuntimeCensus({
    platform: 'win32',
    surveyImpl: (options) => surveyHostProcesses({
      ...options, execFileImpl: runner, scriptPath: SCRIPT, env: WIN_ENV,
    }),
    listDaemonsImpl: async () => [],
    osImpl: { totalmem: () => 34359738368, freemem: () => 8589934592, cpus: () => new Array(10) },
    now: WIN_NOW,
  });

  const rows = census.processes.value;
  assert.equal(census.ephemeral, true);
  assert.equal(rows.length, 3);

  const [claude, codex, opencode] = rows;
  assert.equal(claude.project.status, 'measured');
  assert.equal(claude.project.value.path, 'C:\\repos\\keel');
  assert.equal(claude.cwdReason, null);

  // Both of these keep every measured figure and lose only the attribution,
  // each with the cause named rather than a blank cell or a guess.
  assert.equal(codex.project.status, 'unknown');
  assert.equal(codex.project.value, null);
  assert.equal(codex.cwdReason, 'compile-failed');
  assert.match(codex.project.reason, /not attributable on Windows/);
  assert.match(codex.project.reason, /could not be built/);
  assert.match(opencode.project.reason, /32-bit process, 64-bit probe/);

  for (const row of rows) {
    assert.equal(row.rssBytes.status, 'measured');
    assert.equal(row.cpuPercent.status, 'measured');
    assert.equal(row.uptimeMs.status, 'measured');
  }
  assert.equal(census.totals.rssBytes.value, 536870912 + 268435456 + 157286400);
  assert.equal(census.totals.rssBytes.partial, false);
  assert.equal(census.totals.processCount.value, 3);
  // The runtime census no longer republishes childProcessCount: as a rendered
  // figure it was a bare number with no denominator and no action attached. The
  // SURVEY still counts child and MCP-server processes — that count is what
  // makes these three host rows correct — and is asserted directly against
  // surveyHostProcesses above.
  assert.equal(Object.hasOwn(census, 'childProcessCount'), false);
  assert.equal(census.machine.physicalMemoryBytes.value, 34359738368);
});

test('a Windows survey that cannot run at all leaves the machine facts standing', async () => {
  const census = await collectRuntimeCensus({
    platform: 'win32',
    surveyImpl: () => {
      throw Object.assign(new Error('nope'), { code: 'ERR_RUNTIME_PROCESS_SURVEY' });
    },
    listDaemonsImpl: async () => [],
    osImpl: { totalmem: () => 34359738368, freemem: () => 8589934592, cpus: () => new Array(10) },
    now: WIN_NOW,
  });
  assert.equal(census.processes.status, 'unknown');
  assert.equal(census.processes.value, null);
  assert.equal(census.totals.rssBytes.status, 'unknown');
  assert.equal(census.totals.processCount.value, null, 'a failed survey is not zero processes');
  assert.match(census.processes.reason, /ERR_RUNTIME_PROCESS_SURVEY/);
  assert.equal(census.machine.cpuCount.value, 10);
  assert.equal(census.daemons.count.value, 0, 'no daemons running really is zero');
});
