// ADR-0048 scan history — bounded, retained scan summaries
// (docs/design/maintenance-overhaul/discovery-and-scan-policy.md "Retention").
// This store holds ONLY terminal scan summaries. It structurally cannot reach
// receipts, dispositions, or recipe acceptance records — those live in other
// agents' stores — so `clearHistory` cannot violate MNT-PRV-008 by scope
// alone; the `isProtected` guard below is defense in depth for a summary that
// still names an open continuation.
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../../file-write.mjs';
import { SCAN_HISTORY_FLOORS, SCAN_HISTORY_RETENTION } from '../management/model.mjs';
import { sha256 } from '../evidence.mjs';

const HISTORY_SCHEMA = 'maintenance-scan-history/v1';

function ensurePrivateDir(dir, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function clampRetention(retention) {
  return {
    maxSummaries: Math.max(SCAN_HISTORY_FLOORS.minSummaries, Math.min(retention?.maxSummaries ?? SCAN_HISTORY_RETENTION.maxSummaries, SCAN_HISTORY_RETENTION.maxSummaries)),
    maxAgeDays: Math.max(SCAN_HISTORY_FLOORS.minAgeDays, Math.min(retention?.maxAgeDays ?? SCAN_HISTORY_RETENTION.maxAgeDays, SCAN_HISTORY_RETENTION.maxAgeDays)),
  };
}

function pruneSummaries(summaries, retention, now) {
  const cutoff = now - retention.maxAgeDays * 86_400_000;
  const byEnvironment = new Map();
  for (const summary of summaries
    .filter((entry) => Date.parse(entry.completedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))) {
    const list = byEnvironment.get(summary.environmentId) ?? [];
    list.push(summary);
    byEnvironment.set(summary.environmentId, list.slice(-retention.maxSummaries));
  }
  return [...byEnvironment.values()].flat().sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}

/**
 * @param {string} dir a dedicated `<controlRoot>/management` directory
 * @param {{ fsImpl?: typeof fs, now?: () => number, retention?: {maxSummaries:number, maxAgeDays:number},
 *   hasOpenContinuation?: (scanId: string) => boolean }} [options]
 */
export function createScanHistoryStore(dir, {
  fsImpl = fs, now = Date.now, retention = SCAN_HISTORY_RETENTION,
  hasOpenContinuation = (/** @type {string} */ _scanId) => false,
} = {}) {
  const file = path.join(dir, 'scan-history.json');
  let effectiveRetention = clampRetention(retention);

  function read() {
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); } catch { return { schemaVersion: HISTORY_SCHEMA, summaries: [] }; }
    try {
      const parsed = JSON.parse(raw);
      const { integrity, ...base } = parsed ?? {};
      if (parsed?.schemaVersion !== HISTORY_SCHEMA || integrity?.digest !== sha256(base) || !Array.isArray(base.summaries)) {
        return { schemaVersion: HISTORY_SCHEMA, summaries: [] };
      }
      return base;
    } catch {
      return { schemaVersion: HISTORY_SCHEMA, summaries: [] };
    }
  }

  function persist(store) {
    ensurePrivateDir(dir, fsImpl);
    const envelope = { ...store, integrity: { algorithm: 'sha256', digest: sha256(store) } };
    writePrivateFileAtomic(file, `${JSON.stringify(envelope)}\n`, { fsImpl });
  }

  function recordSummary(summary) {
    const store = read();
    store.summaries = pruneSummaries([...store.summaries, summary], effectiveRetention, now());
    persist(store);
    return store.summaries;
  }

  /** @param {{environmentId?: string}} [options] */
  function list({ environmentId } = {}) {
    const summaries = read().summaries;
    return environmentId ? summaries.filter((entry) => entry.environmentId === environmentId) : summaries;
  }

  /** Remove only terminal, non-protected summaries; refuses (never throws) to
   *  touch a summary whose scanId still names an open continuation.
   *  @param {{environmentId?: string}} [options] */
  function clearHistory({ environmentId } = {}) {
    const store = read();
    const kept = store.summaries.filter((entry) => (environmentId ? entry.environmentId !== environmentId : false)
      || hasOpenContinuation(entry.scanId));
    const removed = store.summaries.length - kept.length;
    persist({ ...store, summaries: kept });
    return { removed, kept: kept.length };
  }

  function setRetention(next) {
    effectiveRetention = clampRetention({ ...effectiveRetention, ...next });
    return effectiveRetention;
  }

  return {
    recordSummary, list, clearHistory, setRetention, retention: () => effectiveRetention,
  };
}
