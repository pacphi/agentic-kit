// Which processes hold an AQE store's files open (decision B5-D3). AQE's
// own writers take no cross-process lock a merge could wait on
// (agentic-qe#753), so `ak x aqe-store merge` refuses while any process holds
// the root or a stray store and lists each one. Detection is by open file, not
// by process name: `aqe-mcp`, `npm exec agentic-qe mcp` and the hook shim's
// `aqe` child all count the same way.
//
//   macOS    lsof -Fpcn on the files
//   Linux    /proc/<pid>/fd of this user's processes; lsof when a folder the
//            user owns cannot be read
//   Windows  no open-file view without extra tools: the host-session census
//            (Claude Code, Codex, OpenCode) for the project stands in, and the
//            result is never `complete` (the merge also treats a failed folder
//            rename as a holder)
//
// Processes of other users are not examined, the same limit lsof has without
// root. The caller's own PID is excluded.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';

/** Parse `lsof -Fpcn` output into `[{ pid, command, files }]`. */
export function parseLsofHolders(output) {
  const byPid = new Map();
  let current = null;
  for (const line of String(output ?? '').split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p' && /^\d+$/.test(value)) {
      const pid = Number(value);
      current = byPid.get(pid) ?? { pid, command: '', files: [] };
      byPid.set(pid, current);
    } else if (current && tag === 'c') {
      current.command = value;
    } else if (current && tag === 'n' && value && !current.files.includes(value)) {
      current.files.push(value);
    }
  }
  return [...byPid.values()];
}

/** @typedef {{ pid: number, command: string, files: string[] }} StoreHolder */
/** @typedef {{ holders: StoreHolder[], method: 'lsof'|'proc'|'census', complete: boolean, error?: string }} HolderResult */

const exists = (file) => { try { fs.statSync(file); return true; } catch { return false; } };
const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };

/** @returns {Promise<HolderResult>} */
async function viaLsof(files, runner, self) {
  const result = await runner('lsof', ['-n', '-w', '-Fpcn', '--', ...files], { timeout: 30_000 });
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = String(result?.stderr ?? '').trim();
  // lsof exits 1 with no output at all when none of the files is open. Exit 1
  // with a message (e.g. `spawn lsof ENOENT`) is a failed look, not an answer.
  const answered = result?.code === 0 || stdout.trim() || (result?.code === 1 && !stderr);
  if (!answered) return { holders: [], method: 'lsof', complete: false, error: stderr || 'lsof failed' };
  return { holders: parseLsofHolders(stdout).filter((holder) => holder.pid !== self), method: 'lsof', complete: true };
}

/** Linux: walk `<procRoot>/<pid>/fd`. Returns null when /proc cannot answer.
 *  @returns {HolderResult|null} */
function viaProc(files, procRoot, self, uid) {
  let entries;
  try { entries = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)); } catch { return null; }
  const wanted = new Map(files.map((file) => [real(file), file]));
  const holders = [];
  for (const name of entries) {
    const pid = Number(name);
    if (pid === self) continue;
    const base = path.join(procRoot, name);
    try { if (uid !== undefined && fs.statSync(base).uid !== uid) continue; } catch { continue; }
    let fds;
    try { fds = fs.readdirSync(path.join(base, 'fd')); } catch (error) {
      if (error?.code === 'ENOENT') continue; // exited while we looked
      return null; // one of this user's processes we cannot see into
    }
    const held = [];
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync(path.join(base, 'fd', fd)); } catch { continue; }
      const file = wanted.get(target);
      if (file && !held.includes(file)) held.push(file);
    }
    if (!held.length) continue;
    let command = '';
    try { command = fs.readFileSync(path.join(base, 'comm'), 'utf8').trim(); } catch { /* exited */ }
    holders.push({ pid, command, files: held });
  }
  return { holders: holders.sort((a, b) => a.pid - b.pid), method: 'proc', complete: true };
}

/** @returns {Promise<HolderResult>} */
async function viaCensus(root, listSessions, self) {
  const inside = (cwd) => {
    const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(cwd));
    return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
  };
  try {
    const sessions = await listSessions({ platform: 'win32' });
    const holders = sessions
      .filter((session) => session.pid !== self && typeof session.cwd === 'string' && inside(session.cwd))
      .map((session) => ({ pid: session.pid, command: session.host, files: [] }));
    return { holders, method: 'census', complete: false };
  } catch (error) {
    return { holders: [], method: 'census', complete: false, error: String(error?.message ?? error) };
  }
}

const defaultSessions = async (options) => {
  const { listActiveHostSessions } = await import('./live/process-sessions.mjs');
  return listActiveHostSessions(options);
};

/**
 * Processes holding any of `files` open.
 * @param {string[]} files
 * @param {{ platform?: NodeJS.Platform, runner?: typeof run, procRoot?: string, root?: string,
 *   listSessions?: (options: { platform: NodeJS.Platform }) => Promise<Array<{ pid: number, host: string, cwd?: string }>>,
 *   self?: number, uid?: number }} [options]
 * @returns {Promise<HolderResult>}
 */
export async function storeHolders(files, {
  platform = process.platform, runner = run, procRoot = '/proc', root, listSessions = defaultSessions,
  self = process.pid, uid = process.getuid?.(),
} = {}) {
  if (platform === 'win32') return viaCensus(root ?? path.win32.dirname(files[0] ?? '.'), listSessions, self);
  const present = files.filter(exists);
  if (!present.length) return { holders: [], method: 'lsof', complete: true };
  if (platform === 'linux') {
    const found = viaProc(present, procRoot, self, uid);
    if (found) return found;
  }
  return viaLsof(present, runner, self);
}
