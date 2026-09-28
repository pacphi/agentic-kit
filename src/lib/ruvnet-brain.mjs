// RuvNet Brain — detection / install-locate / version primitives.
//
// Unlike ruflo/agentic-qe/the host CLIs, the brain is NOT a global npm package:
// `npx github:stuinfla/ruvnet-brain` is an installer that (a) downloads a ~2 GB
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
// The published installer resolves this exact Release asset name. A newer tag
// without this asset is an announcement, not an installable Brain update: the
// installer's conventional fallback URL points at the same absent asset and
// returns 404. Keep the release probe aligned with that executable contract.
export const RELEASE_ASSET = 'ruvnet-brain.zip';
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
/** Refresh of an existing install. `--update` runs the bundle's own updater
 *  (kb/forge-update.mjs: backup, verified apply, private stores preserved) and
 *  dispatches before the installer reads `--version`, so it cannot be pinned.
 *  The env disables the installer's fallback, a fresh `--force` install that
 *  carries none of ak's opt-out flags (installer bin/install.mjs runUpdate). */
export const UPDATE_ARGS = ['--update', '--no-nightly-prompt', '--no-telemetry'];
export const UPDATE_ENV = Object.freeze({ RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' });

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

const LEGACY_SNAPSHOT = /^kb\.(?:bak-|install-preserved-)/;
// Bounded so a pathological tree (a real one runs to thousands of files across
// several GB) can't turn an already-degraded status/sync into a slow one; a
// count-without-a-full-byte-total is still useful and this only ever runs
// inside the reclaim-stuck branch (ADR-0061), not on every ordinary check.
const LEGACY_SNAPSHOT_FILE_CAP = 20_000;

function dirBytes(dir, budget) {
  let bytes = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { bytes: null, exhausted: false }; }
  for (const entry of entries) {
    if (budget.files-- <= 0) return { bytes, exhausted: true };
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const sub = dirBytes(full, budget);
        if (sub.bytes != null) bytes += sub.bytes;
        if (sub.exhausted) return { bytes, exhausted: true };
      } else {
        bytes += fs.statSync(full).size;
      }
    } catch { /* removed mid-walk, permission denied — best-effort */ }
  }
  return { bytes, exhausted: false };
}

/** Best-effort size of the legacy `kb.bak-` / `kb.install-preserved-` snapshot
 *  directories forge-update's reclaim check can leave behind (ADR-0061) — the
 *  disk cost of a reclaim-stuck hold, for the status row's remediation text.
 *  `root` defaults to the Brain's cache dir (kbDir()'s parent); never throws.
 *  `fileCap` is test-only (the real default protects an ordinary status/sync
 *  call, not this function's contract). `exhausted: true` means the cap was
 *  hit — bytes is a lower bound. */
export function legacySnapshotBytes(root = path.dirname(kbDir()), { fileCap = LEGACY_SNAPSHOT_FILE_CAP } = {}) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return { count: 0, bytes: null, exhausted: false }; }
  const dirs = names.filter((e) => e.isDirectory() && LEGACY_SNAPSHOT.test(e.name));
  const budget = { files: fileCap };
  let bytes = 0;
  let summed = false; // at least one dir actually contributed a real number
  let exhausted = false;
  for (const d of dirs) {
    const r = dirBytes(path.join(root, d.name), budget);
    if (r.bytes != null) { bytes += r.bytes; summed = true; }
    if (r.exhausted) { exhausted = true; break; }
  }
  // dirs.length > 0 with every one unreadable must stay null, not a false "0
  // bytes" — this row exists specifically to report disk cost honestly.
  return { count: dirs.length, bytes: summed ? bytes : null, exhausted };
}

const pluginMarketplace = () =>
  path.join(claudeDir(), 'plugins', 'marketplaces', 'ruvnet-brain');
const pluginCache = () => path.join(claudeDir(), 'plugins', 'cache', 'ruvnet-brain');

/** Does the installed bundle ship its self-updater? The installer's `--update`
 *  requires kb/forge-update.mjs and fails loudly without it, so this — not
 *  present(), which the plugin cache alone satisfies — selects the update path. */
export function updaterPresent() {
  return fs.existsSync(path.join(kbDir(), 'forge-update.mjs'));
}

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
    // Semver order, not lexical — .sort() alone ranks 0.9.0 above 0.10.0.
    return vers.length ? vers.sort(cmpVersions).at(-1).replace(/^v/, '') : null;
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

/** Reduce GitHub's latest-release payload to the two facts ak needs. Pure so
 *  missing-asset behavior is testable without a network dependency. */
export function releaseMetadata(payload) {
  const tag = payload?.tag_name;
  if (!tag) return null;
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find((candidate) => candidate?.name === RELEASE_ASSET
      && candidate?.browser_download_url)
    : null;
  return {
    version: String(tag).replace(/^v/, ''),
    releaseAssetAvailable: !!asset,
  };
}

/** Latest release metadata from GitHub, best-effort (null on any failure or
 *  rate limit — callers must treat null as "unknown", never as "up to date"). */
export async function latestRelease({ timeout = 8000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { 'User-Agent': 'agentic-kit', Accept: 'application/vnd.github+json' },
        signal: ctl.signal });
    if (!res.ok) return null;
    return releaseMetadata(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Compatibility helper for callers that only need the release tag. */
export async function latestVersion(options) {
  return (await latestRelease(options))?.version ?? null;
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
  // A release that landed ends any held refresh (see recordHeldRefresh).
  const { heldRefresh: _cleared, ...cur } = cfg.versionCheck?.ruvnetBrain ?? {};
  cfg.versionCheck = { ...cfg.versionCheck, ruvnetBrain: { ...cur, installedRelease: String(tag).replace(/^v/, '') } };
  try { saveKitConfig(cfg); } catch { /* read-only envs: best-effort */ }
}

/** Hold a refused refresh. The installer or the bundle's updater refused (a
 *  private-overlay preflight, a stale updater) or ran without landing anything;
 *  re-running it on every sync cannot succeed and re-downloads the bundle. The
 *  record keeps the causal text and the release pair it was refused for, in the
 *  same resolution drift() uses (disk first, then ak's stamp); status stops
 *  offering the refresh while that exact pair stands. */
export function recordHeldRefresh({ detail, latest }, cfg = loadKitConfig()) {
  if (!latest) return;
  const cur = cfg.versionCheck?.ruvnetBrain ?? {};
  const installed = installedReleaseOnDisk() ?? cur.installedRelease ?? null;
  cfg.versionCheck = {
    ...cfg.versionCheck,
    ruvnetBrain: {
      ...cur,
      heldRefresh: { detail: String(detail ?? '').slice(0, 320), installed, latest: String(latest).replace(/^v/, ''), at: Date.now() },
    },
  };
  try { saveKitConfig(cfg); } catch { /* read-only envs: best-effort */ }
}

/** The held refresh that still applies to this drift result, or null: only an
 *  exact (installed, latest) match holds — either release changing is a new attempt. */
export function activeHeldRefresh(b) {
  const held = b?.heldRefresh;
  if (!held || !b.latest) return null;
  return held.latest === b.latest && (held.installed ?? null) === (b.installedRelease ?? null) ? held : null;
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

/** The release kit.json recorded, whatever its age, labelled with its source.
 *  `observedAt` is when that release was actually seen; records written
 *  before it existed fall back to `last`. */
const recordedRelease = (cached, latestSource) => ({
  latest: cached.latest ?? null,
  latestObservedAt: cached.observedAt ?? cached.last ?? null,
  releaseAssetAvailable: cached.releaseAssetAvailable ?? null,
  latestSource,
});

/** Look the latest release up on GitHub; with `record`, save the answer in
 *  kit.json. A failed lookup never erases a good one: it keeps the recorded
 *  release (and when it was observed) and reports it as a cache fallback. It
 *  still restamps `last`, so the next lookup waits one TTL window (`force`
 *  retries sooner) instead of every status read waiting on it again. */
async function lookUpRelease(cfg, cached, { record, fetchImpl }) {
  const release = await latestRelease(fetchImpl ? { fetchImpl } : {});
  const now = Date.now();
  const save = (entry) => {
    // The spread keeps installedRelease and heldRefresh across the cache write.
    cfg.versionCheck = { ...cfg.versionCheck, ruvnetBrain: { ...cached, last: now, ...entry } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  };
  if (!release) {
    if (record) save({ observedAt: cached.observedAt ?? cached.last });
    return recordedRelease(cached, 'cache-fallback');
  }
  const { version: latest, releaseAssetAvailable } = release;
  if (record) save({ observedAt: now, latest, releaseAssetAvailable });
  return { latest, latestObservedAt: now, releaseAssetAvailable, latestSource: 'live' };
}

/** Presence + release drift, TTL-cached in kit.json (mirrors selfDrift in
 *  versions.mjs) so status/nudge hit GitHub at most once per window. force=true
 *  bypasses the cache. Installed side resolves disk-first: the bundle's own
 *  SOURCE.json releaseTag when stamped, else ak's kit.json record — the same
 *  order the statusline uses, so `ak status` and the footer can never disagree.
 *  cacheOnly=true reports the recorded release whatever its age, with no
 *  network and no write (`ak sync --skip ruvnet-brain`, ADR-0063).
 *  record=false looks the release up without saving it (`ak sync --dry-run`).
 *  @param {{ force?: boolean, cacheOnly?: boolean, record?: boolean, fetchImpl?: typeof fetch }} [opts] */
export async function drift({ force = false, cacheOnly = false, record = true, fetchImpl } = {}) {
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.ruvnetBrain ?? {};
  // Do not invalidate a pre-asset-probe cache here: a real sync force-refreshes
  // this metadata before collection; ordinary status waits for the normal TTL.
  const fresh = !force && cached.last && Date.now() - cached.last < ttlMs;
  const observed = fresh ? recordedRelease(cached, 'cache')
    : cacheOnly ? recordedRelease(cached, 'cache-fallback')
      : await lookUpRelease(cfg, cached, { record, fetchImpl });
  const installedRelease = installedReleaseOnDisk() ?? cached.installedRelease ?? null;
  return {
    ...classifyDrift({ present: present(), installedRelease, latest: observed.latest }),
    releaseAssetAvailable: observed.releaseAssetAvailable,
    latestSource: observed.latestSource,
    latestObservedAt: observed.latestObservedAt,
    pluginVersion: installedVersion(),
    heldRefresh: cached.heldRefresh ?? null,
  };
}
