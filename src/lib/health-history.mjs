// health-history.mjs — a persisted ring of stack-health snapshots + regression
// detection. One entry is appended per `sync` convergence; `status` compares the
// last two and alarms on any backslide (learning shrank, native agentdb slots
// dropped, drift regressed current→outdated, security present→absent).
//
// The core (append / summarize / detectRegression) is PURE — no file I/O. The
// loadRing / appendToConfig shims only read/mutate a plain cfg object so the
// caller can persist via saveKitConfig; they have no side effects beyond the cfg.
//
// An entry looks like:
//   { ts, learningRows, nativeSlots, driftOutdated: bool, securityPresent: bool }

const DEFAULT_CAP = 30;

/** Coerce a possibly-missing numeric field to a finite number (default 0). */
const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Append `entry` to `ring`, returning a NEW array capped at `cap` entries.
 * Oldest entries past the cap are dropped (FIFO). Never mutates the input.
 */
export function append(ring, entry, cap = DEFAULT_CAP) {
  const next = [...(Array.isArray(ring) ? ring : []), entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Project an entry down to just the tracked scalar fields. */
export function summarize(entry = {}) {
  return {
    learningRows: num(entry.learningRows),
    nativeSlots: num(entry.nativeSlots),
    driftOutdated: Boolean(entry.driftOutdated),
    securityPresent: Boolean(entry.securityPresent),
  };
}

/**
 * Compare the last two entries of `ring` and return an array of regressions:
 *   { metric, from, to, message }
 * Regressions: learningRows shrank, nativeSlots dropped, drift current→outdated,
 * security present→absent. Recoveries (the reverse) are never flagged. Fewer than
 * two entries → []. Missing numeric fields count as 0; missing bools as falsy.
 */
export function detectRegression(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return [];
  const prev = summarize(ring[ring.length - 2]);
  const curr = summarize(ring[ring.length - 1]);
  const out = [];

  if (curr.learningRows < prev.learningRows) {
    out.push({
      metric: 'learningRows',
      from: prev.learningRows,
      to: curr.learningRows,
      message: `learning rows shrank ${prev.learningRows} → ${curr.learningRows}`,
    });
  }
  if (curr.nativeSlots < prev.nativeSlots) {
    out.push({
      metric: 'nativeSlots',
      from: prev.nativeSlots,
      to: curr.nativeSlots,
      message: `native agentdb slots dropped ${prev.nativeSlots} → ${curr.nativeSlots}`,
    });
  }
  if (!prev.driftOutdated && curr.driftOutdated) {
    out.push({
      metric: 'drift',
      from: false,
      to: true,
      message: 'drift regressed current → outdated',
    });
  }
  if (prev.securityPresent && !curr.securityPresent) {
    out.push({
      metric: 'security',
      from: true,
      to: false,
      message: 'security surface went present → absent',
    });
  }
  return out;
}

/** Read the ring out of a kit cfg (cfg.health.ring), defaulting to []. */
export function loadRing(cfg) {
  const ring = cfg?.health?.ring;
  return Array.isArray(ring) ? ring : [];
}

/**
 * Append `entry` to cfg.health.ring in place (seeding cfg.health / .ring if
 * absent), capped at `cap`. Returns the same cfg for chaining. The only mutation
 * is on the passed cfg — the caller persists it via saveKitConfig.
 */
export function appendToConfig(cfg, entry, cap = DEFAULT_CAP) {
  if (!cfg.health || typeof cfg.health !== 'object') cfg.health = { ring: [] };
  cfg.health.ring = append(loadRing(cfg), entry, cap);
  return cfg;
}
