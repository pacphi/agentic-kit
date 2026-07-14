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

async function latestVersion(pkg) {
  const r = await run('npm', ['view', pkg, 'version'], { timeout: 20_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

const newer = (a, b) => {
  // semver-lite compare, prerelease-insensitive (enough for drift detection)
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

/** Drift report for the managed packages. Network hit at most once per TTL
 *  window (cached in kit.json); force=true bypasses the cache. */
export async function driftReport({ force = false } = {}) {
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const fresh = !force && cfg.versionCheck?.last && Date.now() - cfg.versionCheck.last < ttlMs;
  const pkgs = ['ruflo', 'agentic-qe'];
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
