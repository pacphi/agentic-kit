// Builtin-only attribution and conservative run-root handling. Native probes
// deliberately cannot authorize sibling deletion on any supported platform.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RUN_ROOT_NAME = /^ak-suite-[A-Za-z0-9]{6}$/;
export const OWNER_FILE = '.ak-suite-owner.json';
export const HOLD_DIR = '.ak-suite-holds';
export const IGNORED_IN_ROOT = new Set(['node-compile-cache', OWNER_FILE, HOLD_DIR]);
const MAX_OWNER_BYTES = 8192;
const currentUid = () => process.getuid?.() ?? null;

/** Attribution timestamp only: startedAt is NOT an observed OS process start.
 * @param {{pid?:number, now?:number, hostname?:string, uid?:number|null, platform?:string}} [options]
 */
export function ownerRecord({ pid = process.pid, now = Date.now(), hostname = os.hostname(),
  uid = currentUid(), platform = process.platform } = {}) {
  return { schema: 1, runId: randomUUID(), pid, startedAt: now, hostname, uid, platform, proofMode: 'list-only' };
}

/** Private, exclusive staging file followed by atomic publication. */
export function writeOwner(root, record) {
  const canonical = fs.realpathSync(root);
  if (canonical !== root || !fs.lstatSync(root).isDirectory()) throw Error('noncanonical run root');
  const bound = { ...record, root, tmpdir: path.dirname(root) };
  if (!validRecord(bound, root)) throw Error('invalid owner record');
  const staging = path.join(root, `${OWNER_FILE}.tmp`);
  fs.writeFileSync(staging, JSON.stringify(bound), { flag: 'wx', mode: 0o600 });
  fs.renameSync(staging, path.join(root, OWNER_FILE));
}

function validRecord(r, root) {
  return r !== null && typeof r === 'object' && !Array.isArray(r)
    && r.schema === 1 && typeof r.runId === 'string' && /^[a-f0-9-]{36}$/.test(r.runId)
    && Number.isSafeInteger(r.pid) && r.pid > 0
    && Number.isSafeInteger(r.startedAt) && r.startedAt > 0
    && r.hostname === os.hostname() && r.uid === currentUid() && r.platform === process.platform
    && r.proofMode === 'list-only' && r.root === root && r.tmpdir === path.dirname(root);
}

/** Bounded, no-follow metadata read; missing, changed or invalid means unknown. */
export function readOwner(root) {
  let fd;
  let record = null;
  try {
    const file = path.join(root, OWNER_FILE);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > MAX_OWNER_BYTES || (currentUid() !== null && before.uid !== currentUid())) {
      throw Error('unsafe owner file');
    }
    // Bitwise flags treat an unavailable platform constant as zero.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > MAX_OWNER_BYTES) {
      throw Error('owner file changed at open');
    }
    const bytes = Buffer.alloc(MAX_OWNER_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_OWNER_BYTES || !sameIdentity(opened, fs.lstatSync(file))) throw Error('owner file changed at read');
    const parsed = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (validRecord(parsed, root)) record = parsed;
  } catch { /* Unknown metadata never grants ownership. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return record;
}

/** Create the private hold directory before launching any suite command. */
export function prepareRunRootHolds(root, runId) {
  if (readOwner(root)?.runId !== runId || fs.realpathSync(root) !== root) throw Error('run root owner mismatch');
  fs.mkdirSync(path.join(root, HOLD_DIR), { mode: 0o700 });
}

/** A command acquires this hold before launching children that use its run root.
 * Outside a guarded run it returns null; local sandbox retention still applies.
 * @param {{env?:NodeJS.ProcessEnv}} [options]
 */
export function acquireRunRootHold({ env = process.env } = {}) {
  const root = env.AK_SUITE_ROOT;
  const runId = env.AK_SUITE_RUN_ID;
  if (root === undefined && runId === undefined) return null;
  if (!root || !runId || readOwner(root)?.runId !== runId || fs.realpathSync(root) !== root) {
    throw Error('cannot establish run-root hold: owner mismatch');
  }
  const dir = path.join(root, HOLD_DIR);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw Error('cannot establish run-root hold: unsafe hold directory');
  }
  const id = randomUUID();
  const token = randomUUID();
  const file = path.join(dir, id);
  fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
  return { root, runId, file, token, pid: process.pid };
}

/** Remove only the marker returned to this process by acquireRunRootHold. */
export function releaseRunRootHold(hold) {
  if (hold === null) return;
  if (!hold || hold.pid !== process.pid || readOwner(hold.root)?.runId !== hold.runId
    || fs.realpathSync(hold.root) !== hold.root
    || path.dirname(hold.file) !== path.join(hold.root, HOLD_DIR)) throw Error('run-root hold owner mismatch');
  const dir = path.join(hold.root, HOLD_DIR);
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw Error('run-root hold directory changed');
  }
  const stat = fs.lstatSync(hold.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || fs.readFileSync(hold.file, 'utf8') !== hold.token) throw Error('run-root hold changed');
  fs.unlinkSync(hold.file);
}

/** Missing or unreadable hold state is uncertainty, never permission to remove. */
export function inspectRunRootHolds(root, runId) {
  try {
    if (readOwner(root)?.runId !== runId) throw Error('owner changed');
    const dir = path.join(root, HOLD_DIR);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw Error('unsafe hold directory');
    return { unresolved: fs.readdirSync(dir).length > 0, reason: 'unresolved child hold' };
  } catch { return { unresolved: true, reason: 'hold inspection uncertain' }; }
}

/** Pure path check also accepts Windows paths in cross-platform unit fixtures. */
export function unsafeTempBase(tmpdir, homedir) {
  const windows = path.win32.isAbsolute(tmpdir) && !path.posix.isAbsolute(tmpdir);
  const flavor = windows ? path.win32 : path.posix;
  const normalize = (p) => windows ? flavor.resolve(p).toLowerCase() : flavor.resolve(p);
  const tmp = normalize(tmpdir);
  if (tmp === normalize(flavor.parse(tmp).root)) return 'filesystem root';
  if (tmp === normalize(homedir)) return 'home directory';
  return null;
}

/** @param {string} dir
 * @param {{tmpdir:string, homedir:string, uid?:number|null, requireOwner?:boolean}} options
 * @returns {{ok:boolean, reason?:string}}
 */
export function removableRunRoot(dir, { tmpdir, homedir, uid = currentUid(), requireOwner = true }) {
  try {
    if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || !path.isAbsolute(tmpdir)
      || fs.realpathSync(tmpdir) !== tmpdir) return { ok: false, reason: 'noncanonical absolute path required' };
    const unsafe = unsafeTempBase(tmpdir, fs.realpathSync(homedir));
    if (unsafe) return { ok: false, reason: `unsafe temp base: ${unsafe}` };
    if (!RUN_ROOT_NAME.test(path.basename(dir)) || path.dirname(dir) !== tmpdir) {
      return { ok: false, reason: 'not an exact direct run-root child' };
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
      return { ok: false, reason: 'not a canonical nonsymlink directory' };
    }
    if (uid !== currentUid() || (uid !== null && stat.uid !== uid)) return { ok: false, reason: 'foreign filesystem owner' };
    if (requireOwner && !readOwner(dir)) return { ok: false, reason: 'no valid owner record (missing, malformed or foreign)' };
    return { ok: true };
  } catch { return { ok: false, reason: 'path inspection failed' }; }
}

/** Probes are injected code, never derived from metadata or CLI input.
 * completeExit must prove ALL users/descendants gone, not a snapshot/handle scan.
 * @typedef {{alive:(pid:number)=>boolean|null, startedAfter:(pid:number,ms:number)=>boolean|null,
 * completeExit:(root:string,owner:object)=>boolean|null, listOnly?:boolean}} Probes
 * @param {string} root
 * @param {ReturnType<typeof ownerRecord>} owner
 * @param {Probes} probes
 */
export function proveAbandoned(root, owner, probes) {
  try {
    if (!validRecord(owner, root)) return { abandoned: false, reason: 'invalid owner metadata' };
    if (probes.listOnly) return { abandoned: false, reason: 'cannot prove complete descendant exit (list-only)' };
    const alive = probes.alive(owner.pid);
    if (alive !== false && (alive !== true || probes.startedAfter(owner.pid, owner.startedAt) !== true)) {
      return { abandoned: false, reason: 'owner alive or identity uncertain' };
    }
    if (probes.completeExit(root, owner) !== true) return { abandoned: false, reason: 'descendant exit uncertain or live user' };
    return { abandoned: true, reason: 'injected complete exit proof' };
  } catch { return { abandoned: false, reason: 'probe failed; exit uncertain' }; }
}

/** @returns {Probes} No process scans: none could authorize removal. */
export function defaultProbes(_platform = process.platform) {
  return { listOnly: true, alive: () => null, startedAfter: () => null, completeExit: () => null };
}

function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs; }

/** Revalidate after injected probes; recursive rm can still fail partway through.
 * The fixture seam is not an installed platform containment implementation.
 * @param {{tmpdir:string, selfRoot?:string, homedir:string, uid?:number|null, probes?:Probes,
 * log?:(s:string)=>void, remove?:(root:string)=>void}} options
 */
export function collectAbandonedRoots({ tmpdir, selfRoot, homedir, uid = currentUid(),
  probes = defaultProbes(), log = console.error, remove = (root) => fs.rmSync(root, { recursive: true }) }) {
  /** @type {{removed:string[], kept:Array<{path:string,reason:string}>}} */
  const result = { removed: [], kept: [] };
  const report = (message) => { try { log(message); } catch { /* Reporting cannot alter cleanup outcomes. */ } };
  const keep = (root, reason) => { result.kept.push({ path: root, reason }); report(`kept run root ${root}: ${reason}`); };
  let names;
  try { names = fs.readdirSync(tmpdir); }
  catch { keep(tmpdir, 'could not list run roots'); return result; }
  for (const name of names) {
    if (!RUN_ROOT_NAME.test(name)) continue;
    const root = path.join(tmpdir, name);
    if (root === selfRoot) continue;
    const options = { tmpdir, homedir, uid, requireOwner: true };
    const safe = removableRunRoot(root, options);
    if (!safe.ok) { keep(root, safe.reason); continue; }
    try {
      const identity = fs.lstatSync(root);
      const owner = readOwner(root);
      if (!owner) { keep(root, 'owner changed during inspection'); continue; }
      const proof = proveAbandoned(root, owner, probes);
      if (!proof.abandoned) { keep(root, proof.reason); continue; }
      const boundary = removableRunRoot(root, options);
      if (!boundary.ok || !sameIdentity(identity, fs.lstatSync(root))
        || JSON.stringify(owner) !== JSON.stringify(readOwner(root))) {
        keep(root, 'root or owner changed before removal'); continue;
      }
      try { remove(root); }
      catch (error) { keep(root, `removal failed; root may be partially removed: ${error.message}`); continue; }
      result.removed.push(root);
      report(`removed abandoned run root ${root}`);
    } catch { keep(root, 'inspection changed or failed; removal not attempted'); }
  }
  return result;
}
