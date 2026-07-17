// RuvNet Brain — detection / install-locate / version primitives.
//
// Unlike ruflo/agentic-qe/the host CLIs, the brain is NOT a global npm package:
// `npx github:stuinfla/ruvnet-brain` is an installer that (a) downloads a ~512 MB
// offline knowledge base to ~/.cache/ruvnet-brain/kb and (b) wires a user-scope
// Claude Code plugin (the `search_ruvnet` MCP server + hooks + a skill). So the
// npm primitives in versions.mjs (`installedVersion` → npm global root,
// `latestVersion` → npm view) don't apply; these are the parallel filesystem +
// GitHub-releases helpers. Kept small and purpose-specific, mirroring the host
// helpers in providers.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { home, claudeDir } from './paths.mjs';
import { cmpVersions } from './versions.mjs';
import { loadKitConfig, saveKitConfig } from './config.mjs';

export const REPO = 'stuinfla/ruvnet-brain';
/** npx spec + flags. The PUBLISHED npm installer, not `github:` — a github: spec
 *  runs the default-branch HEAD (an unreleased -dev installer, audited live
 *  2026-07-17: HEAD was 3.4.5-dev while releases/latest was v3.3.1), which is
 *  inconsistent with every other tool ak manages by released artifact.
 *  --no-stack (ak manages ruflo/RuVector) and --no-enhance (ak owns the
 *  CLAUDE.md grounding block) prevent double-management. --no-nightly-prompt and
 *  --no-telemetry exist because the installer's `--yes` accepts EVERY optional
 *  offer — without them it silently enables the 03:47 nightly self-update
 *  LaunchAgent (macOS) and writes telemetry consent, both audited on the v3.3.1
 *  installer. ak owns brain updates (`ak sync`), so the self-updater must stay off. */
export const INSTALL_SPEC = 'ruvnet-brain@latest';
export const INSTALL_ARGS = ['--yes', '--no-stack', '--no-enhance', '--no-nightly-prompt', '--no-telemetry'];

/** The installer's nightly self-update LaunchAgent (macOS). Its label/path are the
 *  installer's own (`--enable-nightly` writes it; `--disable-nightly` removes it).
 *  ak detects it as drift because that 03:47 forge-update job rewrites the KB
 *  outside ak's release stamp — status/statusline would go stale against disk. */
export const NIGHTLY_LABEL = 'com.ruvnet.brain-update';
export function nightlyAgentPlist() {
  return path.join(home, 'Library', 'LaunchAgents', `${NIGHTLY_LABEL}.plist`);
}
export function nightlyAgentPresent() {
  return process.platform === 'darwin' && fs.existsSync(nightlyAgentPlist());
}

/** KB cache dir — the installer honors RUVNET_BRAIN_KB, so we do too. */
export function kbDir() {
  return process.env.RUVNET_BRAIN_KB || path.join(home, '.cache', 'ruvnet-brain', 'kb');
}

const pluginMarketplace = () =>
  path.join(claudeDir(), 'plugins', 'marketplaces', 'ruvnet-brain');
const pluginCache = () => path.join(claudeDir(), 'plugins', 'cache', 'ruvnet-brain');

/** Installed? Mirrors the installer's own "alreadyInstalled" probe: the KB's
 *  forge-mcp-all.mjs entrypoint, or the user-scope plugin cache dir. */
export function present() {
  return fs.existsSync(path.join(kbDir(), 'forge-mcp-all.mjs'))
    || fs.existsSync(pluginCache());
}

/** Installed plugin version, or null. Reads the plugin manifest; falls back to
 *  the version-named subdir under the plugin cache. */
export function installedVersion() {
  const manifest = path.join(
    pluginMarketplace(), 'plugin', '.claude-plugin', 'plugin.json');
  try {
    const v = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (v) return String(v).replace(/^v/, '');
  } catch { /* fall through to cache-dir scan */ }
  // Fallback: ~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<version>/
  try {
    const inner = path.join(pluginCache(), 'ruvnet-brain');
    const vers = fs.readdirSync(inner, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /\d/.test(e.name))
      .map((e) => e.name);
    return vers.length ? vers.sort().at(-1).replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** Release tag stamped ON DISK by the bundle itself (SOURCE.json → releaseTag).
 *  Release bundles carry it since the evergreen mechanism (the brain's own
 *  installer/telemetry read the same field); older or locally-built bundles
 *  don't → null. This is ground truth in the RELEASE namespace: it stays
 *  correct even when the KB changes outside ak (e.g. a user runs the bundle's
 *  forge-update.mjs by hand), where ak's kit.json stamp would go stale. */
export function installedReleaseOnDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(kbDir(), 'SOURCE.json'), 'utf8'));
    const raw = String(j.releaseTag ?? '');
    if (/^[A-Za-z0-9._-]{1,32}$/.test(raw)) return raw.replace(/^v/, '');
  } catch { /* absent / unreadable / pre-stamping bundle — fall back to the kit.json stamp */ }
  return null;
}

/** Latest release tag from GitHub, best-effort (null on any failure or rate
 *  limit — callers must treat null as "unknown", never as "up to date"). */
export async function latestVersion({ timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { 'User-Agent': 'agentic-kit', Accept: 'application/vnd.github+json' },
        signal: ctl.signal });
    if (!res.ok) return null;
    const tag = (await res.json())?.tag_name;
    return tag ? String(tag).replace(/^v/, '') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Record the release tag ak just pulled, so future drift compares like-for-like.
 *  ruvnet-brain has THREE unrelated version tracks — the plugin semver
 *  (plugin.json, e.g. 0.5.0-dev), the KB bundle's brainVersion (e.g. v0.3.0-dev),
 *  and the GitHub *release* tags the installer downloads by (e.g. v3.3.1).
 *  Evergreen-era release bundles stamp the release tag on disk
 *  (SOURCE.json → releaseTag; see installedReleaseOnDisk), but older bundles
 *  don't — so ak still keeps its own record of "which release did I last
 *  install" in kit.json as the fallback for pre-stamping installs. */
export function recordInstalledRelease(tag, cfg = loadKitConfig()) {
  if (!tag) return;
  const cur = cfg.versionCheck?.ruvnetBrain ?? {};
  cfg.versionCheck = { ...cfg.versionCheck, ruvnetBrain: { ...cur, installedRelease: String(tag).replace(/^v/, '') } };
  try { saveKitConfig(cfg); } catch { /* read-only envs: best-effort */ }
}

/** Pure drift classifier — both sides in the RELEASE-TAG namespace.
 *  installedRelease = the release ak last pulled (null = ak never installed it,
 *  e.g. a manual/pre-existing install); latest = GitHub releases/latest.
 *  A present-but-unstamped install counts as outdated when a latest is known, so
 *  `ak sync` refreshes it onto ak's managed track once, then converges. `latest`
 *  null (offline / rate-limited) is always "unknown", never "outdated". */
export function classifyDrift({ present: isPresent, installedRelease, latest }) {
  if (!isPresent) return { present: false, outdated: false, unversioned: false, installedRelease: null, latest: latest ?? null };
  const unversioned = !installedRelease;
  const outdated = !!(latest && (unversioned || cmpVersions(latest, installedRelease) > 0));
  return { present: true, outdated, unversioned, installedRelease: installedRelease ?? null, latest: latest ?? null };
}

/** Presence + release drift, TTL-cached in kit.json (mirrors selfDrift in
 *  versions.mjs) so status/nudge hit GitHub at most once per window. force=true
 *  bypasses the cache. Installed side resolves disk-first: the bundle's own
 *  SOURCE.json releaseTag when stamped, else ak's kit.json record — the same
 *  order the statusline uses, so `ak status` and the footer can never disagree. */
export async function drift({ force = false } = {}) {
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.ruvnetBrain ?? {};
  const fresh = !force && cached.last && Date.now() - cached.last < ttlMs;
  let latest = fresh ? cached.latest ?? null : null;
  if (!fresh) {
    latest = await latestVersion();
    // Preserve installedRelease across the cache write.
    cfg.versionCheck = { ...cfg.versionCheck, ruvnetBrain: { ...cached, last: Date.now(), latest } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  }
  const installedRelease = installedReleaseOnDisk() ?? cached.installedRelease ?? null;
  return {
    ...classifyDrift({ present: present(), installedRelease, latest }),
    pluginVersion: installedVersion(),
  };
}
