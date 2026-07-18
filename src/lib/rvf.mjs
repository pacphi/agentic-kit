// RVF pattern-store health — the oversized backstop (#495 runaway append after
// a hard exit; seen at ~277 GB). This is the ONLY filesystem-observable
// corruption mode left for the kit: every other RVF failure is agentic-qe's own
// job since 3.12.3 (issue #563 → aqe PR #564 — atomic tmp+rename exports plus
// non-destructive, pid-guarded self-healing). The legacy corrupt-lock branch
// was NOT dead code when removed — it stayed reachable on `ak status` (never
// upgrades), `ak sync --no-upgrade`, and offline syncs against a pre-3.12.3
// aqe — it was removed because on exactly those paths its false-positive
// data-loss risk (deleting a healthy store beside a stale lock) outweighed the
// marginal protection it offered.
//
// HISTORY, kept because the mistake carried real data-loss risk: the kit once
// flagged any `.rvf.lock` whose first four bytes are `FLVR` as corruption and
// deleted the store beside it. Measured against @ruvector/rvf-node 0.1.8:
// `FLVR` is the NORMAL lock-record magic (the store's own magic is `SFVR`) and
// a 162-byte store is a valid EMPTY store — so the detector really fired on "a
// lock exists" and could delete a healthy `brain.rvf` (a dual-write target
// holding writes never flushed to memory.db, not a pure cache). The only sound
// corruption signal ("open fails AND create fails") needs the native binding,
// which is exactly why aqe owns it now. A version-gated, pid-guarded remnant of
// that detector lived here briefly (PR #31) and was stripped once the gate was
// permanently satisfied. Do NOT reintroduce a bytes-on-disk corruption
// heuristic here without proving it against rvf-node's actual format.
import fs from 'node:fs';
import path from 'node:path';

const defaultCapBytes = () => Number(process.env.RUFLO_AQE_RVF_MAX_BYTES ?? 2 * 1024 ** 3);

/** Scan a project's `.agentic-qe/` for runaway-append RVF stores (> capBytes).
 *  `capBytes` is injectable for hermetic tests; <= 0 disables the backstop.
 *  Lock files (`.rvf.lock`) are never candidates — `.endsWith('.rvf')` excludes
 *  them by construction. */
export function scanRvf(dir, { capBytes = defaultCapBytes() } = {}) {
  const findings = [];
  if (!fs.existsSync(dir) || capBytes <= 0) return findings;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.rvf')) continue;
    const file = path.join(dir, name);
    // Per-entry guard: aqe daemon workers rename/quarantine stores in this dir
    // while we scan (observed live: 35 renames in 7 minutes), so a file listed
    // by readdir can be gone by stat time. A vanished entry is not a finding —
    // and it must never crash `ak status`/`ak sync` (collect() calls us bare).
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size > capBytes) findings.push({ kind: 'oversized', file, size });
  }
  return findings;
}

/** Delete an oversized store + its sidecars. Returns the paths removed. */
export function quarantine(finding) {
  const base = finding.file;
  const targets = [base, `${base}.lock`, `${base}.idmap.json`, `${base}.manifest.json`];
  const removed = [];
  for (const t of targets) {
    try { if (fs.existsSync(t)) { fs.rmSync(t); removed.push(t); } } catch { /* best-effort */ }
  }
  return removed;
}
