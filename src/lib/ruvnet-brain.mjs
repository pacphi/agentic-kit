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
/** npx spec + flags: --no-stack (ak manages ruflo/RuVector) and --no-enhance
 *  (ak owns the CLAUDE.md grounding block) prevent double-management. */
export const INSTALL_SPEC = `github:${REPO}`;
export const INSTALL_ARGS = ['--yes', '--no-stack', '--no-enhance'];

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

/** Presence + drift, TTL-cached in kit.json (mirrors selfDrift in versions.mjs)
 *  so status/nudge hit GitHub at most once per window. force=true bypasses the
 *  cache. `latest` is null when the release check is unavailable — treat that as
 *  "unknown", never "outdated". */
export async function drift({ force = false } = {}) {
  const installed = installedVersion();
  const cfg = loadKitConfig();
  const ttlMs = (cfg.versionCheck?.ttlHours ?? 24) * 3600_000;
  const cached = cfg.versionCheck?.ruvnetBrain;
  const fresh = !force && cached?.last && Date.now() - cached.last < ttlMs;
  let latest = fresh ? cached.latest ?? null : null;
  if (!fresh) {
    latest = await latestVersion();
    cfg.versionCheck = { ...cfg.versionCheck, ruvnetBrain: { last: Date.now(), latest } };
    try { saveKitConfig(cfg); } catch { /* read-only envs: next call re-fetches */ }
  }
  return {
    present: present(),
    installed,
    latest,
    outdated: !!(installed && latest && cmpVersions(latest, installed) > 0),
  };
}
