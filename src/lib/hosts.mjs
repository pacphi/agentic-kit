// Host-adapter core — the host-neutral spine of ak's ambidextrous experience.
//
// why: ak models two frontier hosts (claude, codex) but the *experience* used to
// be claude-shaped (guidance → CLAUDE.md, statusline = claude's, MCP bridge one
// way). This module makes "which host is driving" a first-class, detected axis and
// puts every host-specific artifact behind a per-host descriptor, so the commands
// become host-loops instead of claude-hardcoded paths.
//
// Kept deliberately PURE — env-only detection + static descriptor data, no fs /
// child_process / kit.json import — so it's importable everywhere (providers.mjs,
// status, dashboard) without an import cycle. The I/O half (probing auth files,
// versions) lives in providers.mjs, which imports THIS (one direction only).
//
// Grounded:
//   - codex is exposed as an MCP server via `codex mcp-server` (stdio JSON-RPC,
//     tools codex/codex-reply) and consumes servers via `[mcp_servers.*]` in
//     ~/.codex/config.toml (TOML). Claude Code uses settings.json (JSON) +
//     `claude mcp add`.
//   - codex statusline is a fixed built-in enum (`tui.status_line`); a
//     command-backed footer like Claude Code's is an unimplemented upstream
//     request (openai/codex #16921/#17827/#20140/#20244).
//   - codex auth: OPENAI_API_KEY set ⇒ codex ignores the ChatGPT login stored in
//     ~/.codex/auth.json (key overrides login). claude auth on macOS lives in the
//     Keychain (no readable file); ANTHROPIC_API_KEY, when used, is not a simple
//     override of a subscription login, so we label it conservatively.
import { HOST_REGISTRY } from './adapters/index.mjs';

/** Per-host adapter descriptors. Logical names (`guidanceFile`, `loginFile`
 *  segments) are resolved to real paths by callers so this stays pure. */
export const HOST_ADAPTERS = Object.fromEntries(HOST_REGISTRY
  .filter((host) => host.capabilities.canDriveSession)
  .map((host) => [host.id, {
    id: host.id, label: host.label,
    guidanceFile: host.legacy.guidanceFile,
    configFormat: host.legacy.configFormat,
    statusline: host.legacy.statusline,
    aqeProvider: host.legacy.aqeProvider,
    envMarkers: host.legacy.envMarkers,
    auth: host.auth,
  }]));

/** Ordered managed host ids (claude first = display order). */
export const HOST_IDS = Object.keys(HOST_ADAPTERS);

/** The adapter for a host id, or null. */
export function adapterFor(id) {
  return HOST_ADAPTERS[id] ?? null;
}

/**
 * Which host is driving the current session, as a first-class detected axis.
 * Precedence: explicit override → confirmed claude markers → any CODEX_* marker
 * (heuristic) → configured primary (kit.json routing.primaryHost) → 'claude'.
 * Pure: reads only env + the passed cfg; never spawns.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {any} [cfg] kit.json config (for routing.primaryHost)
 * @returns {'claude'|'codex'|'opencode'}
 */
export function drivingHost(env = process.env, cfg = null) {
  const override = env.AK_DRIVING_HOST;
  if (override && HOST_ADAPTERS[override]) return /** @type {'claude'|'codex'|'opencode'} */ (override);
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  // codex sets no single documented session marker; a CODEX_* prefix is a safe
  // heuristic because the fallback below covers the miss.
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  const primary = cfg?.routing?.primaryHost;
  const primaryCapable = HOST_REGISTRY.some((host) => host.id === primary && host.capabilities.canBePrimary);
  if (primary && primaryCapable) return /** @type {'claude'|'codex'} */ (primary);
  return 'claude';
}
