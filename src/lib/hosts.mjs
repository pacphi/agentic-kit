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
import { HOST_REGISTRY, effectiveHostRegistry } from './adapters/index.mjs';

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

/**
 * Human phrase for a host's tier, derived purely from its capabilities — never
 * from `host.id` (the anti-pattern this replaces: x/host.mjs's status() used
 * to special-case `h.id === 'opencode'` for its tier text; D-2/F-25/F-26).
 * Accepts a host id (resolved against `registry`, default
 * effectiveHostRegistry() so an admitted external host resolves too) or a raw
 * host-entry object directly (for a synthetic host not registered anywhere).
 * TRUE by construction for any capability combination validateHostAdapter
 * accepts, including a future built-in or admitted external adapter — the
 * label follows the flags, not a name.
 *
 * @param {string|object} hostIdOrEntry
 * @param {{ registry?: ReadonlyArray<any>, builtins?: ReadonlyArray<any> }} [opts]
 * @returns {string} '' when the host isn't found or can't drive a session.
 */
export function hostTierLabel(hostIdOrEntry, { registry = effectiveHostRegistry(), builtins = HOST_REGISTRY } = {}) {
  const host = typeof hostIdOrEntry === 'string'
    ? registry.find((entry) => entry.id === hostIdOrEntry)
    : hostIdOrEntry;
  if (!host?.capabilities?.canDriveSession) return '';
  const { canBePrimary, canRouteActivities } = host.capabilities;

  if (canBePrimary) return 'drives sessions · can lead';
  if (!canRouteActivities) return 'drives sessions';

  const isBuiltin = builtins.some((entry) => entry.id === host.id);
  const base = isBuiltin ? 'routing only · supervised' : 'routing only · external adapter';
  return host.legacy?.aqeProvider ? base : `${base} · not AQE`;
}

/**
 * A one-line, capability/trust-derived note about a host's asymmetric
 * behavior versus the other managed hosts — cross-host MCP delegation (F-25)
 * and the ruflo backend env flag / permission consent boundary (F-26) —
 * assembled only from facts that are true FOR THIS HOST's own registry
 * entry, never from an id check. '' when nothing asymmetric applies.
 *
 * @param {string|object} hostIdOrEntry
 * @param {{ registry?: ReadonlyArray<any> }} [opts]
 * @returns {string}
 */
export function hostAsymmetryNote(hostIdOrEntry, { registry = effectiveHostRegistry() } = {}) {
  const host = typeof hostIdOrEntry === 'string'
    ? registry.find((entry) => entry.id === hostIdOrEntry)
    : hostIdOrEntry;
  if (!host?.capabilities?.canDriveSession) return '';
  const notes = [];

  // F-25: this host is registered as callable FROM another host via MCP — a
  // real bridge capability, read off the trust manifest rather than an id
  // check ('expose <label> to <other> as mcp__x__x' is the manifest's own
  // wording for that grant, e.g. codex's claude-to-codex-mcp change).
  const bridge = host.trust?.changes?.find((change) =>
    change.kind === 'mcp-registration' && /^expose /i.test(change.effect));
  if (bridge) notes.push(bridge.effect);

  // ADR-0019's "supervised-host contract": a host that drives sessions and
  // routes activities but can never be primary is exactly the shape that
  // implements a permission consent boundary today (OpenCode's
  // permission_required abort) — never auto-approved.
  if (!host.capabilities.canBePrimary && host.capabilities.canRouteActivities) {
    notes.push('consent boundary — a run can block on a permission event (never auto-approved)');
  }

  // F-26: ak's ruflo backend env flag (ENABLE_CLAUDE_CODE/ENABLE_CODEX) is
  // only wired for hosts whose registry entry declares one; silence used to
  // read as "nothing to say" rather than "no flag exists for this host".
  if (!host.legacy?.enableEnv) notes.push('no ruflo backend env flag');

  return notes.join('; ');
}
