// RVF pattern-store health: the two corruption modes the shell kit repairs.
//   1. FLVR-magic .rvf.lock — store bytes written into the lock by an
//      interrupted write (aqe does NOT self-heal this; FsyncFailed on init).
//   2. Oversized .rvf (runaway append after a hard exit; seen at ~277GB).
// Stores are derived caches (rebuilt from memory.db) — quarantine = delete.
import fs from 'node:fs';
import path from 'node:path';

const CAP_BYTES = Number(process.env.RUFLO_AQE_RVF_MAX_BYTES ?? 2 * 1024 ** 3);

export function scanRvf(dir) {
  const findings = [];
  if (!fs.existsSync(dir)) return findings;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.endsWith('.rvf.lock')) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(4);
      try { fs.readSync(fd, buf, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (buf.toString('latin1') === 'FLVR') {
        findings.push({ kind: 'corrupt-lock', file, sibling: file.replace(/\.lock$/, '') });
      }
    } else if (name.endsWith('.rvf') && CAP_BYTES > 0) {
      const size = fs.statSync(file).size;
      if (size > CAP_BYTES) findings.push({ kind: 'oversized', file, size });
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
