import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectGitWorkspace } from './git-workspace.mjs';

const execFileAsync = promisify(execFile);

// The Windows stand-in for `ps` + `lsof`. A text script invoked with -File, the
// same way the POSIX path invokes a binary with argv — no compiled artifact and
// no dependency. It lives BESIDE this module, not under the repo's scripts/,
// because it is a runtime asset rather than a dev tool: package.json's `files`
// ships `src/` wholesale, so colocation is what guarantees an npm-installed
// Windows user actually receives it. A checkout and an installed package
// therefore resolve the same sibling path.
const WIN32_SURVEY_SCRIPT = fileURLToPath(
  new URL('./win-process-survey.ps1', import.meta.url));

// Off by default (ADR-0023 §5/§4 precedent: AK_STATUSLINE_DEBUG). Set
// AK_RUNTIME_DEBUG=1 to trace why a controller process was or wasn't
// surfaced — which rows the ps survey saw, which were classified as a
// host, which got dropped as a nested child of another candidate, and
// whether cwd resolution found each controller. Unlike the statusline
// diagnostic (which runs on every keystroke for users who may not even
// know the flag exists), this is opt-in and single-purpose, so the cwd
// path IS logged — it's the exact fact being debugged and it's not a
// secret. Raw argv/command strings are still never logged: a pasted
// prompt or token could be sitting in there.
function runtimeDebug(stage, fields = {}) {
  if (!process?.env || process.env.AK_RUNTIME_DEBUG !== '1') return;
  try {
    const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    const file = process.env.AK_RUNTIME_DEBUG_FILE || path.join(root, 'agentic-kit', 'runtime-debug.log');
    const safeStage = String(stage || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 64);
    const kv = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v).replace(/[\s\n]+/g, '_').slice(0, 200)}`)
      .join(' ');
    const line = `${new Date().toISOString()} stage=${safeStage} ${kv}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first write */ }
    if (size >= 65536) fs.writeFileSync(file, line, { mode: 0o600 });
    else fs.appendFileSync(file, line, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
  } catch { /* diagnostics must never break discovery */ }
}
const HOST_NAMES = new Map([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
]);

const tokens = (command) => String(command ?? '').trim().split(/\s+/)
  .map((token) => token.replace(/^['"]|['"]$/g, ''));
// win32.basename deliberately, on every platform: it splits on BOTH separators,
// so `C:\opt\bin\codex` and `/usr/local/bin/codex` both reduce to `codex`. The
// POSIX result is unchanged (a POSIX path has no backslash to split on), and
// the classification of a Windows command line stops depending on which OS
// happens to be running the classifier — which is what makes it unit-testable.
const executableName = (value) => path.win32.basename(String(value ?? '')).toLowerCase()
  .replace(/\.exe$/, '');

/** Identify only a controller executable or its supported Node launcher. */
export function hostFromCommand(command, executable = null) {
  const argv = tokens(command);
  const program = executableName(executable ?? argv[0]);
  let host = HOST_NAMES.get(program) ?? null;
  let argumentOffset = executable == null || executableName(argv[0]) === program ? 1 : 0;
  if (!host && ['node', 'nodejs'].includes(program)) {
    const wrapperIndex = executable == null || executableName(argv[0]) === program ? 1 : 0;
    host = HOST_NAMES.get(executableName(argv[wrapperIndex])) ?? null;
    argumentOffset = wrapperIndex + 1;
  }
  if (host === 'codex' && argv[argumentOffset] === 'mcp-server') return null;
  return host;
}

/** Parse `ps -axo pid=,ppid=,lstart=,comm=,args=` without command guessing. */
export function parseProcessList(output) {
  const rows = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/;
  for (const line of String(output ?? '').split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3],
      executable: match[4], command: match[5],
    });
  }
  return rows;
}

/** Parse the privacy-minimized first survey, which deliberately omits argv. */
export function parseProcessHeaders(output) {
  const rows = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/;
  for (const line of String(output ?? '').split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3],
      executable: match[4], command: '',
    });
  }
  return rows;
}

function parseArgsByPid(output) {
  const commands = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

const isHostCandidate = (row) => {
  const name = executableName(row.executable);
  return HOST_NAMES.has(name) || name === 'node' || name === 'nodejs';
};

/**
 * Parse `win-process-survey.ps1 -Mode census`: the guaranteed Windows floor of
 * pid, ppid, ISO-8601 UTC start, image name, CPU time and working set. Command
 * is always '' — the census projection never asks for one.
 *
 * `startedAt` is an ISO instant here where the POSIX parsers keep `ps`'s raw
 * `lstart` string. Both are opaque identity for the runtime key and both parse
 * as a date; they are not interchangeable across platforms, and nothing
 * compares them across one.
 */
export function parseWin32Census(output) {
  const rows = [];
  for (const line of String(output ?? '').split('\n')) {
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length < 6) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const cpuTicks = Number(fields[4]);
    const rssBytes = Number(fields[5]);
    rows.push({
      pid, ppid, startedAt: fields[2], executable: fields[3], command: '',
      // Win32_Process reports CPU in 100ns units; normalize once, here.
      cpuMs: Number.isFinite(cpuTicks) ? cpuTicks / 10_000 : null,
      rssBytes: Number.isFinite(rssBytes) ? rssBytes : null,
    });
  }
  return rows;
}

/**
 * Parse `-Mode commands`: `pid \t own|other|err \t value`. Three-valued on
 * purpose — "someone else's process" and "we could not establish an owner" are
 * different facts, and only the first is safe to treat as deliberately excluded.
 */
export function parseWin32Commands(output) {
  const owned = new Map();
  const foreign = new Set();
  const failed = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length < 3) continue;
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid)) continue;
    if (fields[1] === 'own') owned.set(pid, fields.slice(2).join(' ').trim());
    else if (fields[1] === 'other') foreign.add(pid);
    else failed.set(pid, fields[2] || 'owner-probe-failed');
  }
  return { owned, foreign, failed };
}

/** Parse `-Mode cwd`: `pid \t ok|err \t path-or-reason`. Never throws. */
export function parseWin32Cwds(output) {
  const found = new Map();
  const failures = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length < 3) continue;
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid)) continue;
    if (fields[1] === 'ok' && fields[2]) found.set(pid, fields[2]);
    else failures.set(pid, fields[2] || 'cwd-probe-failed');
  }
  return { found, failures };
}

/** Parse `ps -o pid=,pcpu=,rss=`. RSS is kibibytes on both Linux and macOS. */
export function parseProcessMetrics(output) {
  const metrics = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    metrics.set(Number(match[1]), {
      cpuPercent: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
    });
  }
  return metrics;
}

function rootControllers(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = new Map();
  for (const row of rows) {
    const host = hostFromCommand(row.command, row.executable);
    if (host) candidates.set(row.pid, { ...row, host });
    else if (row.command) runtimeDebug('classify', { pid: row.pid, exe: row.executable, host: 'none' });
  }
  const roots = [...candidates.values()].filter((candidate) => {
    const seen = new Set([candidate.pid]);
    let parent = byPid.get(candidate.ppid);
    while (parent && !seen.has(parent.pid)) {
      if (candidates.has(parent.pid)) {
        runtimeDebug('exclude-nested-child', { pid: candidate.pid, host: candidate.host, parentPid: parent.pid });
        return false;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
  for (const root of roots) runtimeDebug('root-controller', { pid: root.pid, host: root.host });
  return roots;
}

async function linuxCwds(pids) {
  const found = new Map();
  await Promise.all(pids.map(async (pid) => {
    try { found.set(pid, await fs.promises.readlink(`/proc/${pid}/cwd`)); }
    catch { /* process exited between ps and readlink */ }
  }));
  return found;
}

/** Parse lsof's field output: p<pid> followed by n<cwd>. */
export function parseLsofCwds(output) {
  const found = new Map();
  let pid = null;
  for (const line of String(output ?? '').split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid != null && line.startsWith('n/')) found.set(pid, line.slice(1));
  }
  return found;
}

async function darwinCwds(pids, run) {
  if (!pids.length) return new Map();
  const args = ['-n', '-a', '-d', 'cwd', '-Fpn'];
  for (const pid of pids) args.push('-p', String(pid));
  try {
    const result = await run('lsof', args, {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
    });
    return parseLsofCwds(typeof result === 'string' ? result : result.stdout);
  } catch (error) {
    const partial = parseLsofCwds(error?.stdout);
    if (partial.size) return partial;
    throw Object.assign(new Error('runtime cwd survey failed'), {
      code: 'ERR_RUNTIME_CWD_SURVEY',
    });
  }
}

function surveyFailure() {
  return Object.assign(new Error('runtime process survey failed'), {
    code: 'ERR_RUNTIME_PROCESS_SURVEY',
  });
}

/** The current-user, argv-minimized POSIX survey, unchanged: a header pass that
 *  never carries argv, then argv for the pids that could actually be a host. */
async function collectPosixRows({ execFileImpl, uid }) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw Object.assign(new Error('runtime process survey cannot determine the current user'), {
      code: 'ERR_RUNTIME_PROCESS_SURVEY',
    });
  }
  try {
    const result = await execFileImpl('ps', [
      '-U', String(uid), '-x', '-o', 'pid=,ppid=,lstart=,comm=',
    ], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' } });
    const output = typeof result === 'string' ? result : result.stdout;
    let rows = parseProcessHeaders(output);
    runtimeDebug('survey', { uid, rowCount: rows.length });
    if (String(output ?? '').trim() && !rows.length) {
      throw Object.assign(new Error('runtime process output was not understood'), {
        code: 'ERR_RUNTIME_PROCESS_FORMAT',
      });
    }
    // argv can contain sensitive prompts/tokens. Fetch it only for executables
    // that can actually be a supported controller or Node launcher.
    const possible = rows.filter(isHostCandidate);
    runtimeDebug('argv-candidates', { count: possible.length, pids: possible.map((r) => r.pid).join(',') });
    if (possible.length) {
      const argsResult = await execFileImpl('ps', [
        '-p', possible.map((row) => row.pid).join(','), '-o', 'pid=,args=',
      ], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' } });
      const commands = parseArgsByPid(typeof argsResult === 'string' ? argsResult : argsResult.stdout);
      rows = rows.map((row) => commands.has(row.pid)
        ? { ...row, command: commands.get(row.pid) } : row);
    }
    return rows;
  } catch (error) {
    runtimeDebug('survey-failed', { name: error?.name, code: error?.code });
    throw surveyFailure();
  }
}

/** Windows PowerShell's absolute path, so PATH shadowing cannot redirect the
 *  survey. `powershell.exe` is in-box on every supported Windows; `pwsh` is
 *  deliberately not attempted because it is optional and may be absent. */
function powershellCommand(env) {
  const root = env?.SystemRoot || env?.WINDIR;
  return root
    ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function powershellArgs(scriptPath, mode, pids = []) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-Mode', mode,
  ];
  // Numeric coercion is the injection guard (daemons.mjs precedent): nothing
  // user-shaped can reach the script's WQL filter or its P/Invoke calls.
  if (pids.length) args.push('-ProcessIds', pids.map((pid) => Number(pid)).join(','));
  return args;
}

/**
 * The Windows equivalent of collectPosixRows. Same two-phase privacy shape: a
 * census that never reads a command line, then command lines for host-shaped
 * pids the current user provably owns.
 *
 * Ownership has no cheap machine-wide query on Windows, so the census covers
 * every process — pid/ppid are what the de-nesting walk needs, and a bare
 * image name is not the sensitive field. The sensitive field, the command
 * line, is read only after GetOwner proves the process is ours. A candidate we
 * cannot attribute has its image name cleared, so classification cannot
 * promote it to a controller.
 */
async function collectWin32Rows({ execFileImpl, scriptPath, env }) {
  try {
    const result = await execFileImpl(powershellCommand(env), powershellArgs(scriptPath, 'census'), {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const output = typeof result === 'string' ? result : result.stdout;
    const rows = parseWin32Census(output);
    runtimeDebug('survey', { platform: 'win32', rowCount: rows.length });
    // Windows always has processes, so an empty census is a broken survey, not
    // an idle machine — the same reasoning as the POSIX unparseable-output
    // guard, except here even the empty-output case is unbelievable.
    if (!rows.length) {
      throw Object.assign(new Error('runtime process output was not understood'), {
        code: 'ERR_RUNTIME_PROCESS_FORMAT',
      });
    }
    const possible = rows.filter(isHostCandidate);
    runtimeDebug('argv-candidates', { count: possible.length, pids: possible.map((r) => r.pid).join(',') });
    if (!possible.length) return rows;
    const owners = await execFileImpl(
      powershellCommand(env),
      powershellArgs(scriptPath, 'commands', possible.map((row) => row.pid)),
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const { owned, failed } = parseWin32Commands(
      typeof owners === 'string' ? owners : owners.stdout);
    runtimeDebug('owner-probe', { owned: owned.size, unattributable: failed.size });
    return rows.map((row) => {
      if (!isHostCandidate(row)) return row;
      if (owned.has(row.pid)) return { ...row, command: owned.get(row.pid) };
      return { ...row, executable: '' };
    });
  } catch (error) {
    runtimeDebug('survey-failed', { name: error?.name, code: error?.code });
    throw surveyFailure();
  }
}

/**
 * Best-effort per-process working directory on Windows. Never throws: a cwd we
 * could not read costs the caller a project attribution, and must never cost it
 * the census. Partial results are kept — one denied pid does not discard the
 * rest.
 */
async function win32Cwds(pids, run, scriptPath, env) {
  if (!pids.length) return { found: new Map(), failures: new Map() };
  try {
    const result = await run(
      powershellCommand(env), powershellArgs(scriptPath, 'cwd', pids),
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return parseWin32Cwds(typeof result === 'string' ? result : result.stdout);
  } catch (error) {
    const partial = parseWin32Cwds(error?.stdout);
    if (partial.found.size) return partial;
    return {
      found: new Map(),
      failures: new Map(pids.map((pid) => [pid, 'cwd-survey-failed'])),
    };
  }
}

async function resolveCwds({ platform, pids, execFileImpl, scriptPath, env }) {
  if (platform === 'linux') return { found: await linuxCwds(pids), failures: new Map() };
  if (platform === 'win32') return win32Cwds(pids, execFileImpl, scriptPath, env);
  return { found: await darwinCwds(pids, execFileImpl), failures: new Map() };
}

async function collectRows({ platform, execFileImpl, uid, scriptPath, env }) {
  return platform === 'win32'
    ? collectWin32Rows({ execFileImpl, scriptPath, env })
    : collectPosixRows({ execFileImpl, uid });
}

/**
 * Observe top-level Claude Code, Codex and OpenCode controller processes.
 * Child host CLIs remain part of their parent controller's execution graph.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   execFileImpl?: typeof execFileAsync,
 *   processRows?: Array<{
 *     pid:number, ppid:number, startedAt:string, executable:string, command:string
 *   }>,
 *   cwdByPid?: Map<number, string>
 *   inspectWorkspace?: typeof inspectGitWorkspace
 *   uid?: number
 *   scriptPath?: string
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 */
export async function listActiveHostSessions({
  platform = process.platform,
  execFileImpl = execFileAsync,
  processRows,
  cwdByPid,
  inspectWorkspace = (cwd) => inspectGitWorkspace(cwd, { execFileImpl }),
  uid = process.getuid?.(),
  scriptPath = WIN32_SURVEY_SCRIPT,
  env = process.env,
} = {}) {
  const rows = processRows
    ?? await collectRows({ platform, execFileImpl, uid, scriptPath, env });
  const controllers = rootControllers(rows);
  const pids = controllers.map((row) => row.pid);
  let cwds = cwdByPid;
  if (!cwds) {
    const resolved = await resolveCwds({ platform, pids, execFileImpl, scriptPath, env });
    cwds = resolved.found;
    // A session without a workspace is not a session this consumer can use, so
    // an across-the-board cwd failure degrades the source rather than reporting
    // a healthy empty survey. The footprint census takes the opposite trade —
    // see surveyHostProcesses.
    if (pids.length && !cwds.size && resolved.failures.size) {
      throw Object.assign(new Error('runtime cwd survey failed'), {
        code: 'ERR_RUNTIME_CWD_SURVEY',
      });
    }
  }
  for (const pid of pids) runtimeDebug('cwd', { pid, found: cwds.has(pid), cwd: cwds.get(pid) ?? '' });
  const workspaceByCwd = new Map();
  await Promise.all([...new Set(cwds.values())].map(async (cwd) => {
    try { workspaceByCwd.set(cwd, await inspectWorkspace(cwd)); }
    catch { workspaceByCwd.set(cwd, null); }
  }));
  // Explicitly platform-flavored: `C:\repo` is absolute for a win32 survey even
  // when this process is running elsewhere (which is how win32 is unit-tested).
  const isAbsoluteFor = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const sessions = controllers.flatMap((row) => {
    const cwd = cwds.get(row.pid);
    if (typeof cwd !== 'string' || !isAbsoluteFor(cwd)) {
      runtimeDebug('drop-no-cwd', { pid: row.pid, host: row.host });
      return [];
    }
    const workspace = workspaceByCwd.get(cwd);
    return workspace
      ? [{ pid: row.pid, startedAt: row.startedAt, host: row.host, cwd, workspace }]
      : [{ pid: row.pid, startedAt: row.startedAt, host: row.host, cwd }];
  }).sort((left, right) => left.pid - right.pid);
  runtimeDebug('result', { sessionCount: sessions.length });
  return sessions;
}

/** Count every descendant of a controller: tool children, MCP servers, shells.
 *  Cycle-guarded the same way the ancestor walk is. */
function countDescendants(rows, rootPids) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seen = new Set(rootPids);
  const queue = [...rootPids];
  let count = 0;
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      count += 1;
      queue.push(child);
    }
  }
  return count;
}

/** Second, argv-free `ps` pass for the two figures the header survey omits.
 *  Never throws: a census without CPU/RSS is still a census. */
async function posixMetrics(pids, run) {
  if (!pids.length) return new Map();
  try {
    const result = await run('ps', ['-p', pids.join(','), '-o', 'pid=,pcpu=,rss='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' } });
    return parseProcessMetrics(typeof result === 'string' ? result : result.stdout);
  } catch (error) {
    return parseProcessMetrics(error?.stdout);
  }
}

/**
 * Point-in-time resource census of the same controller processes
 * `listActiveHostSessions` finds — host, pid, uptime, CPU%, RSS, and the bound
 * project when the platform can attribute one.
 *
 * The deliberate divergence from `listActiveHostSessions`: that function drops
 * a controller whose cwd it cannot read, because a session with no workspace is
 * not a usable session. A census must not, because a process we can measure but
 * cannot attribute is still consuming this machine's memory, and dropping it
 * would understate the totals the whole System area is denominated in. Such a
 * row keeps every measured field and carries `cwd: null` with a `cwdReason`.
 *
 * CPU% is the same quantity on both platforms — CPU time over process lifetime,
 * as a percentage of one core — so `ps`'s %CPU and Win32_Process's kernel+user
 * ticks over uptime are directly comparable.
 *
 * @param {{
 *   platform?: NodeJS.Platform, execFileImpl?: typeof execFileAsync,
 *   processRows?: Array<object>, cwdByPid?: Map<number, string>,
 *   metricsByPid?: Map<number, {cpuPercent:number, rssBytes:number}>,
 *   uid?: number, scriptPath?: string, env?: NodeJS.ProcessEnv, now?: number
 * }} [options]
 */
export async function surveyHostProcesses({
  platform = process.platform,
  execFileImpl = execFileAsync,
  processRows,
  cwdByPid,
  metricsByPid,
  uid = process.getuid?.(),
  scriptPath = WIN32_SURVEY_SCRIPT,
  env = process.env,
  now = Date.now(),
} = {}) {
  const rows = processRows
    ?? await collectRows({ platform, execFileImpl, uid, scriptPath, env });
  const controllers = rootControllers(rows);
  const pids = controllers.map((row) => row.pid);
  // Whatever the platform's cwd probe does — lsof failing outright, the PEB
  // read being blocked — the census survives it and reports the reason per row.
  let resolved = { found: cwdByPid ?? new Map(), failures: new Map() };
  if (!cwdByPid) {
    try { resolved = await resolveCwds({ platform, pids, execFileImpl, scriptPath, env }); }
    catch (error) {
      resolved = { found: new Map(), failures: new Map(pids.map((pid) => [pid,
        error?.code === 'ERR_RUNTIME_CWD_SURVEY' ? 'cwd-survey-failed' : 'cwd-unavailable'])) };
    }
  }
  const metrics = metricsByPid
    ?? (platform === 'win32' ? new Map() : await posixMetrics(pids, execFileImpl));
  const isAbsoluteFor = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;

  const processes = controllers.map((row) => {
    const startedMs = Date.parse(row.startedAt);
    const uptimeMs = Number.isFinite(startedMs) && startedMs <= now ? now - startedMs : null;
    const measured = metrics.get(row.pid);
    // Win32_Process reports CPU as consumed time; ps reports it as a lifetime
    // rate. Convert the former into the latter so one column means one thing.
    const cpuPercent = measured?.cpuPercent ?? (
      Number.isFinite(row.cpuMs) && uptimeMs > 0 ? (row.cpuMs / uptimeMs) * 100 : null);
    const rssBytes = measured?.rssBytes ?? (Number.isFinite(row.rssBytes) ? row.rssBytes : null);
    const cwd = resolved.found.get(row.pid);
    const attributable = typeof cwd === 'string' && isAbsoluteFor(cwd);
    return {
      host: row.host,
      pid: row.pid,
      ppid: row.ppid,
      startedAt: row.startedAt,
      uptimeMs,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
      rssBytes: Number.isFinite(rssBytes) ? rssBytes : null,
      cwd: attributable ? cwd : null,
      cwdReason: attributable ? null : (resolved.failures.get(row.pid) ?? 'cwd-unavailable'),
    };
  }).sort((left, right) => left.pid - right.pid);

  runtimeDebug('census', {
    platform, controllers: processes.length,
    attributed: processes.filter((entry) => entry.cwd).length,
  });
  return {
    platform,
    observedAt: new Date(now).toISOString(),
    processes,
    childProcessCount: countDescendants(rows, new Set(pids)),
    surveyedProcessCount: rows.length,
  };
}
