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

async function latestVersion(pkg, tag = 'latest') {
  const r = await run('npm', ['view', `${pkg}@${tag}`, 'version'], { timeout: 20_000 });
  return r.code === 0 ? r.stdout.trim() : null;
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
 *  window (cached in kit.json); force=true bypasses the cache. */
export async function driftReport({ force = false } = {}) {
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const fresh = !force && cfg.versionCheck?.last && Date.now() - cfg.versionCheck.last < ttlMs;
  // Frontier host CLIs are kept current only when npm-managed (a global
  // package.json exists). External installs (mise/native/brew) have no global
  // package.json → installedVersion is null → filtered out here, so ak never
  // claims to manage an update it doesn't own. Pkg names mirror HOSTS in
  // providers.mjs (kept local to avoid an import cycle).
  const HOST_PKGS = ['@anthropic-ai/claude-code', '@openai/codex'];
  const pkgs = ['ruflo', 'agentic-qe', ...HOST_PKGS.filter((p) => installedVersion(p))];
  const report = [];
  let latest = cfg.versionCheck?.seen ?? {};
  if (!fresh) {
    latest = {};
    for (const p of pkgs) latest[p] = await latestVersion(p);
    cfg.versionCheck = { ...cfg.versionCheck, last: Date.now(), seen: latest };
    try { saveKitConfig(cfg); } catch { /* read-only envs: nudge just re-fetches */ }
  }
  for (const p of pkgs) {
    const installed = installedVersion(p);
    report.push({
      pkg: p,
      installed,
      latest: latest[p] ?? null,
      outdated: !!(installed && latest[p] && newer(latest[p], installed)),
    });
  }
  return report;
}

export const KIT_PKG = '@pacphi/agentic-kit';

/** Drift for the kit itself. Installed = the running copy's package.json
 *  (pkgRoot). Prerelease installs also consult the `next` dist-tag —
 *  prereleases publish there, so `latest` alone would never see them; the
 *  higher of latest/next wins. Cached in kit.json alongside versionCheck.
 *  @param {{ pkgRoot?: string, force?: boolean }} [opts] */
export async function selfDrift({ pkgRoot, force = false } = {}) {
  let installed = null;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch { /* unreadable pkgRoot: report as not installed */ }
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.self;
  const fresh = !force && cached?.last && Date.now() - cached.last < ttlMs;
  let best = fresh ? cached.best ?? null : null;
  if (!fresh) {
    const tags = installed?.includes('-') ? ['latest', 'next'] : ['latest'];
    for (const tag of tags) {
      const v = await latestVersion(KIT_PKG, tag);
      if (v && (!best || newer(v, best.version))) best = { version: v, tag };
    }
    cfg.versionCheck = { ...cfg.versionCheck, self: { last: Date.now(), best } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  }
  return {
    pkg: KIT_PKG,
    installed,
    latest: best?.version ?? null,
    tag: best?.tag ?? null,
    outdated: !!(installed && best && newer(best.version, installed)),
  };
}
