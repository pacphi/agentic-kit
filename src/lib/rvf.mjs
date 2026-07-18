// RVF pattern-store health — the corruption modes the kit repaired before
// agentic-qe learned to heal itself.
//
// HISTORY (issue #563 → aqe PR #564, shipped in 3.12.3). The kit used to flag a
// `.rvf.lock` whose first four bytes are `FLVR` as a "corrupt lock" and delete
// the store next to it. Measured against @ruvector/rvf-node 0.1.8 — and
// confirmed across every RVF lock on the dev machine — that signal is UNSOUND:
//   · `FLVR` is the NORMAL lock-record magic (the store's own magic is `SFVR`),
//     so every lock on disk matches, healthy or not;
//   · a 162-byte store is a VALID EMPTY store, not the "truncated header" the
//     issue reported.
// The only sound signal for this corruption is "open fails AND create fails",
// which needs the native binding — the kit cannot observe it from the
// filesystem. So the old detector was really firing on "a lock exists", then
// deleting a store that may have been perfectly healthy (and, for `brain.rvf`,
// a dual-write target holding writes never flushed to memory.db — real data).
//
// aqe >= 3.12.3 makes exports atomic (tmp+rename) and self-heals genuinely
// unusable stores on the next run, non-destructively (quarantine-aside, not
// delete), gated on the lock's owner pid. Once that version is installed the
// kit stops second-guessing it: the corrupt-lock scan RETIRES itself and only
// the oversized backstop (a different mode — #495 runaway append, seen ~277 GB)
// remains. Until then the legacy scan stays active but is now guarded by the
// same pid-liveness check aqe added, so it can never quarantine a store a LIVE
// process is holding. Tracking the upgrade: pacphi/agentic-kit follow-up issue.
import fs from 'node:fs';
import path from 'node:path';
import { installedVersion, cmpVersions } from './versions.mjs';

// First agentic-qe release with atomic RVF export + self-healing stores (#564).
const AQE_SELFHEAL_VERSION = '3.12.3';

const defaultCapBytes = () => Number(process.env.RUFLO_AQE_RVF_MAX_BYTES ?? 2 * 1024 ** 3);

/** True once the installed agentic-qe atomically exports and self-heals RVF
 *  stores (>= 3.12.3), making the kit's corrupt-lock quarantine both redundant
 *  and unsound to keep. A prerelease of the target (3.12.3-rc.1) sorts below
 *  the release and so keeps the legacy scan active — the safe direction. */
export function aqeSelfHealsRvf(installed = installedVersion('agentic-qe')) {
  return !!installed && cmpVersions(installed, AQE_SELFHEAL_VERSION) >= 0;
}

/** True when `pid` names a running process (signal 0 probes without delivering).
 *  EPERM = exists but owned by another user → still alive. */
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** The owner pid recorded in an rvf-node 0.1.8 lock record — `FLVR` magic then
 *  the pid as u32 LE at offset 4 — or null if the file is not a readable lock. */
function readLockPid(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    if (fs.readSync(fd, buf, 0, 8, 0) < 8) return null;
    if (buf.subarray(0, 4).toString('latin1') !== 'FLVR') return null;
    const pid = buf.readUInt32LE(4);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

/** Scan a project's `.agentic-qe/` for RVF artifacts the kit should quarantine.
 *  `selfHeals`/`capBytes`/`isAlive` are injectable for hermetic tests. */
export function scanRvf(dir, {
  selfHeals = aqeSelfHealsRvf(),
  capBytes = defaultCapBytes(),
  isAlive = isPidAlive,
} = {}) {
  const findings = [];
  if (!fs.existsSync(dir)) return findings;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!selfHeals && name.endsWith('.rvf.lock')) {
      // Legacy pre-3.12.3 path (see file header). Only a STALE lock — one whose
      // owner pid is gone — can trip this; a live owner means a store in use,
      // never ours to quarantine. On 3.12.3+ this branch is skipped entirely.
      const pid = readLockPid(file);
      if (pid !== null && !isAlive(pid)) {
        findings.push({ kind: 'corrupt-lock', file, sibling: file.replace(/\.lock$/, '') });
      }
    } else if (name.endsWith('.rvf') && capBytes > 0) {
      const size = fs.statSync(file).size;
      if (size > capBytes) findings.push({ kind: 'oversized', file, size });
    }
  }
  return findings;
}

/** Delete a finding's store + sidecars. Returns the paths removed. */
export function quarantine(finding) {
  const base = finding.kind === 'corrupt-lock' ? finding.sibling : finding.file;
  const targets = [base, `${base}.lock`, `${base}.idmap.json`, `${base}.manifest.json`];
  const removed = [];
  for (const t of targets) {
    try { if (fs.existsSync(t)) { fs.rmSync(t); removed.push(t); } } catch { /* best-effort */ }
  }
  return removed;
}
