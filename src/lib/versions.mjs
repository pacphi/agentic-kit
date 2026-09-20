// Installed-vs-latest version detection with a TTL'd cache in kit.json —
// powers the drift nudge and `sync`'s upgrade decision.
import fs from 'node:fs';
import path from 'node:path';
import { globalRoot } from './paths.mjs';
import { run } from './exec.mjs';
import { loadKitConfig, saveKitConfig } from './config.mjs';

export function installedVersion(pkg) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(globalRoot(), pkg, 'package.json'), 'utf8'),
    ).version;
  } catch {
    return null;
  }
}

// Strict SemVer 2.0.0 validation for values that cross a command boundary.
// cmpVersions intentionally remains permissive for old cached/config values;
// registry output must be safe before it becomes part of an npm coordinate.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

export async function latestVersion(pkg, tag = 'latest', { runner = run, timeout = 20_000 } = {}) {
  const r = await runner('npm', ['view', `${pkg}@${tag}`, 'version'], { timeout });
  const value = r.code === 0 ? r.stdout.trim() : null;
  return isValidSemver(value) ? value : null;
}

/** Semver compare, prerelease-aware (4.0.0 > 4.0.0-alpha.1 > 4.0.0-alpha.0).
 *  Exported for tests. */
export function cmpVersions(a, b) {
  const parse = (v) => {
    const [core, ...rest] = String(v).split('-');
    return {
      core: core.split('.').map(Number),
      pre: rest.length ? rest.join('-').split('.') : null,
    };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.core[i] || 0) - (B.core[i] || 0);
    if (d) return d;
  }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;  // a release outranks any prerelease of the same core
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]; const y = B.pre[i];
    if (x === undefined) return -1; // shorter prerelease list is lower
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else if (nx !== ny) return nx ? -1 : 1; // numeric identifiers < alphanumeric
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const newer = (a, b) => cmpVersions(a, b) > 0;

/** Drift report for the managed packages. Network hit at most once per TTL
 *  window (cached in kit.json); force=true bypasses the cache. A failed probe
 *  falls back to the cached value per package, and a run where EVERY probe
 *  failed neither overwrites `seen` nor stamps `last` — clobbering good data
 *  with nulls would suppress upgrade detection for a whole TTL window (#134). */
export async function driftReport({ force = false, fetchLatest = latestVersion } = {}) {
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const fresh = !force && cfg.versionCheck?.last && Date.now() - cfg.versionCheck.last < ttlMs;
  // Frontier host CLIs are kept current only when npm-managed (a global
  // package.json exists). External installs (mise/native/brew) have no global
  // package.json → installedVersion is null → filtered out here, so ak never
  // claims to manage an update it doesn't own. Pkg names mirror HOSTS in
  // providers.mjs (kept local to avoid an import cycle).
  const HOST_PKGS = ['@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai'];
  const pkgs = ['ruflo', 'agentic-qe', ...HOST_PKGS.filter((p) => installedVersion(p))];
  const report = [];
  const cached = cfg.versionCheck?.seen ?? {};
  const observedAt = { ...cfg.versionCheck?.observedAt };
  const live = new Set();
  let latest = cached;
  if (!fresh) {
    latest = {};
    let succeeded = 0;
    for (const p of pkgs) {
      const v = await fetchLatest(p);
      if (v) { succeeded += 1; live.add(p); observedAt[p] = Date.now(); }
      latest[p] = v ?? cached[p] ?? null;
    }
    if (succeeded > 0) {
      cfg.versionCheck = { ...cfg.versionCheck, last: Date.now(), seen: latest, observedAt };
      try { saveKitConfig(cfg); } catch { /* read-only envs: nudge just re-fetches */ }
    }
  }
  for (const p of pkgs) {
    const installed = installedVersion(p);
    report.push({
      pkg: p,
      installed,
      latest: latest[p] ?? null,
      latestSource: live.has(p) ? 'live' : fresh ? 'cache' : 'cache-fallback',
      latestObservedAt: observedAt[p] ?? null,
      outdated: !!(installed && latest[p] && newer(latest[p], installed)),
    });
  }
  return report;
}

/** Do not turn cached registry data into an unqualified "latest" claim. */
export function releaseObservationLabel({ latestSource, latestObservedAt }) {
  const when = Number.isFinite(latestObservedAt) && latestObservedAt > 0
    && latestObservedAt <= 8.64e15 ? new Date(latestObservedAt).toISOString() : 'time unknown';
  return `${latestSource ?? 'unverified'}; observed ${when}`;
}

export const KIT_PKG = '@pacphi/agentic-kit';

/** Retain cached evidence only for a channel whose lookup failed. Do not
 * renew the TTL unless the winning candidate was actually observed: a fresh
 * latest response cannot make an older next observation fresh. */
async function fetchSelfCandidate(tags, cachedBest, fetchLatest) {
  let best = null;
  let observed = false;
  for (const tag of tags) {
    const version = await fetchLatest(KIT_PKG, tag);
    const live = isValidSemver(version);
    const candidate = live ? { version, tag } : cachedBest?.tag === tag ? cachedBest : null;
    if (candidate && (!best || newer(candidate.version, best.version))) {
      best = candidate;
      observed = live;
    }
  }
  return { best, observed };
}

/** Drift for the kit itself. Installed = the running copy's package.json
 *  (pkgRoot). Prerelease installs also consult the `next` dist-tag —
 *  prereleases publish there, so `latest` alone would never see them; the
 *  higher of latest/next wins. Cached in kit.json alongside versionCheck.
 *  Failed lookups preserve eligible cached evidence without renewing its TTL.
 *  @param {{ pkgRoot?: string, force?: boolean, fetchLatest?: typeof latestVersion }} [opts] */
export async function selfDrift({ pkgRoot, force = false, fetchLatest = latestVersion } = {}) {
  let installed = null;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch { /* unreadable pkgRoot: report as not installed */ }
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.self;
  const tags = installed?.includes('-') ? ['latest', 'next'] : ['latest'];
  const cachedBest = cached?.best && tags.includes(cached.best.tag) && isValidSemver(cached.best.version)
    ? cached.best : null;
  const fresh = !force && cached?.last && Date.now() - cached.last < ttlMs
    && (!cached.best || cachedBest);
  let best = fresh ? cachedBest : null;
  if (!fresh) {
    const candidate = await fetchSelfCandidate(tags, cachedBest, fetchLatest);
    best = candidate.best;
    if (candidate.observed) {
      cfg.versionCheck = { ...cfg.versionCheck, self: { last: Date.now(), best } };
      try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
    }
  }
  return {
    pkg: KIT_PKG,
    installed,
    latest: best?.version ?? null,
    tag: best?.tag ?? null,
    outdated: !!(installed && best && newer(best.version, installed)),
  };
}
