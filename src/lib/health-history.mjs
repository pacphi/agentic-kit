// health-history.mjs — a persisted ring of stack-health snapshots + regression
// detection. One entry is appended per `sync` convergence; `status` compares the
// last two and alarms on any backslide (learning shrank, native agentdb slots
// dropped, drift regressed current→outdated, security present→absent).
//
// The ring is MACHINE-global (kit.json) but learningRows is PROJECT-local (read
// from the sync cwd's .claude-flow/neural/stats.json), so entries carry the
// project they were recorded from and the learning comparison only ever pairs
// entries from the SAME project. An absent learning store records null (unknown),
// never a fabricated 0 — the same honesty rule the admin page lives by — so a
// sync run from a store-less project can never fake a "learning shrank" alarm.
//
// The core (append / summarize / detectRegression) is PURE — no file I/O. The
// loadRing / appendToConfig shims only read/mutate a plain cfg object so the
// caller can persist via saveKitConfig; they have no side effects beyond the cfg.
//
// An entry looks like:
//   { ts, project, learningRows: number|null, nativeSlots, driftOutdated: bool, securityPresent: bool }

const DEFAULT_CAP = 30;

/** Coerce a possibly-missing numeric field to a finite number (default 0). */
const num = (v) => (Number.isFinite(v) ? v : 0);

/** A finite count, or null for unknown — never a fabricated 0. */
const numOrNull = (v) => (Number.isFinite(v) ? v : null);

/** Last path segment for display (handles / and \ so messages read the same on Windows). */
const projLabel = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);

/**
 * Append `entry` to `ring`, returning a NEW array capped at `cap` entries.
 * Oldest entries past the cap are dropped (FIFO). Never mutates the input.
 */
export function append(ring, entry, cap = DEFAULT_CAP) {
  const next = [...(Array.isArray(ring) ? ring : []), entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Project an entry down to just the tracked scalar fields. learningRows and
 *  project keep null for "unknown" — an absent learning store is not a zero. */
export function summarize(entry = {}) {
  return {
    project: typeof entry.project === 'string' && entry.project ? entry.project : null,
    learningRows: numOrNull(entry.learningRows),
    nativeSlots: num(entry.nativeSlots),
    driftOutdated: Boolean(entry.driftOutdated),
    securityPresent: Boolean(entry.securityPresent),
  };
}

/**
 * Compare the newest entry of `ring` against its baselines and return an array
 * of regressions: { metric, from, to, message }.
 *
 * Machine-global metrics (nativeSlots, drift, security) compare the last two
 * entries. learningRows is project-local, so its baseline is the most recent
 * PRIOR entry from the SAME project with a KNOWN count — entries from other
 * projects, legacy entries with no project stamp, and unknown (null) readings
 * are never compared. Recoveries are never flagged. Fewer than two entries → [].
 */
export function detectRegression(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return [];
  const prev = summarize(ring[ring.length - 2]);
  const curr = summarize(ring[ring.length - 1]);
  const out = [];

  if (curr.learningRows != null && curr.project != null) {
    let base = null;
    for (let i = ring.length - 2; i >= 0; i--) {
      const s = summarize(ring[i]);
      if (s.project === curr.project && s.learningRows != null) { base = s; break; }
    }
    if (base && curr.learningRows < base.learningRows) {
      out.push({
        metric: 'learningRows',
        from: base.learningRows,
        to: curr.learningRows,
        message: `learning rows shrank ${base.learningRows} → ${curr.learningRows} (${projLabel(curr.project)})`,
      });
    }
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
