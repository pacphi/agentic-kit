// The rolling Ruflo support window (ADR-0041 §7): the newest `newestMinors`
// minors, never fewer than the minors first published within `minDays`. The
// rule lives on the Ruflo dependency policy in the constraint registry
// (`supportWindow`); the evidence is each minor's first stable npm publish,
// remembered in kit.json as `versionCheck.rufloMinors` and written only by
// `ak sync` (recordRufloReleaseDates). A plain read (`ak status`) computes the
// window from that memory and never calls the network.
//
// Stale memory never over-reports "unsupported": minors published after the
// observation are newer than every remembered one, so a window computed from
// old dates can only sit at or below the true floor.
import { run } from './exec.mjs';
import { loadUpstreamConstraints } from './hook-audit/upstream.mjs';

const DEFAULT_POLICY = Object.freeze({ newestMinors: 6, minDays: 30 });
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

const minorKey = (major, minor) => `${Number(major)}.${Number(minor)}`;
const minorParts = (key) => key.split('.').map(Number);
const newerMinorFirst = (a, b) => {
  const [aMajor, aMinor] = minorParts(a);
  const [bMajor, bMinor] = minorParts(b);
  return bMajor - aMajor || bMinor - aMinor;
};

/**
 * Map each minor ("3.46") to the earliest publish time of any stable patch of
 * it. Prereleases and npm's `created`/`modified` keys are ignored.
 * @param {Record<string, string> | null | undefined} timeJson `npm view <pkg> time --json`
 * @returns {Record<string, string>}
 */
export function minorFirstPublished(timeJson) {
  const out = {};
  if (!timeJson || typeof timeJson !== 'object') return out;
  for (const [version, iso] of Object.entries(timeJson)) {
    const match = STABLE.exec(version);
    if (!match || typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) continue;
    const key = minorKey(match[1], match[2]);
    if (!out[key] || Date.parse(iso) < Date.parse(out[key])) out[key] = iso;
  }
  return out;
}

/**
 * The window's floor is the older of (a) the `newestMinors`-th newest minor
 * and (b) the oldest minor first published within `minDays` of `now`.
 * @param {{ firstPublished: Record<string, string> | null | undefined, now: number, newestMinors: number, minDays: number }} input
 * @returns {{ floor: string, minors: string[] } | null}
 */
export function computeSupportWindow({ firstPublished, now, newestMinors, minDays }) {
  const known = Object.keys(firstPublished ?? {})
    .filter((key) => /^\d+\.\d+$/.test(key) && Number.isFinite(Date.parse(firstPublished[key])))
    .sort(newerMinorFirst);
  if (!known.length) return null;
  let oldestIndex = Math.min(newestMinors, known.length) - 1;
  const since = now - minDays * 86_400_000;
  known.forEach((key, index) => {
    if (Date.parse(firstPublished[key]) >= since && index > oldestIndex) oldestIndex = index;
  });
  const minors = known.slice(0, oldestIndex + 1);
  return { floor: `${minors[minors.length - 1]}.0`, minors };
}

/**
 * The window from the release dates `ak sync` remembered. No I/O.
 * @param {any} cfg kit.json
 * @param {{ now: number, policy: { newestMinors: number, minDays: number } }} options
 * @returns {{ floor: string, minors: string[], observedAt: number } | null}
 */
export function rememberedSupportWindow(cfg, { now, policy }) {
  const remembered = cfg?.versionCheck?.rufloMinors;
  if (!remembered || !Number.isFinite(remembered.observedAt)) return null;
  const window = computeSupportWindow({ firstPublished: remembered.firstPublished, now, ...policy });
  return window && { ...window, observedAt: remembered.observedAt };
}

/**
 * Record each Ruflo minor's first publish in `cfg.versionCheck.rufloMinors`.
 * Only `ak sync` calls this (one `npm view`, 20 s). On any failure the old
 * value stays and the result is false; the caller saves kit.json.
 * @param {{ cfg: any, runner?: typeof run, now?: () => number }} options
 * @returns {Promise<boolean>}
 */
export async function recordRufloReleaseDates({ cfg, runner = run, now = Date.now }) {
  let firstPublished;
  try {
    const result = await runner('npm', ['view', 'ruflo', 'time', '--json'], { timeout: 20_000 });
    if (result.code !== 0) return false;
    firstPublished = minorFirstPublished(JSON.parse(result.stdout));
  } catch {
    return false;
  }
  if (!Object.keys(firstPublished).length) return false;
  cfg.versionCheck = { ...cfg.versionCheck, rufloMinors: { observedAt: now(), firstPublished } };
  return true;
}

/**
 * The window rule from the registry's Ruflo dependency policy; the documented
 * defaults when the registry cannot be read.
 * @returns {{ newestMinors: number, minDays: number }}
 */
export function supportWindowPolicy() {
  try {
    const window = loadUpstreamConstraints().dependencyPolicies
      .find((policy) => policy.dependency === 'ruflo')?.supportWindow;
    if (window) return { newestMinors: window.newestMinors, minDays: window.minDays };
  } catch { /* unreadable registry: fall through to the defaults */ }
  return { ...DEFAULT_POLICY };
}
