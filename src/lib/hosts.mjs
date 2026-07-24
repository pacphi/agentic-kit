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
//     request (openai/codex #16921/#17827/#20140/#20244) → statuslineSupported:false.
//   - codex auth: OPENAI_API_KEY set ⇒ codex ignores the ChatGPT login stored in
//     ~/.codex/auth.json (key overrides login). claude auth on macOS lives in the
//     Keychain (no readable file); ANTHROPIC_API_KEY, when used, is not a simple
//     override of a subscription login, so we label it conservatively.

/** Per-host adapter descriptors. Logical names (`guidanceFile`, `loginFile`
 *  segments) are resolved to real paths by callers so this stays pure. */
export const HOST_ADAPTERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    guidanceFile: 'claude', // logical → CLAUDE.md (machine-wide) / project CLAUDE.md
    configFormat: 'json', // settings.json
    statuslineSupported: true, // command-backed statusLine hook
    aqeProvider: 'claude-code',
    // env vars Claude Code sets in a running session — used to detect the driver.
    envMarkers: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'],
    auth: {
      apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      loginFile: ['.claude', '.credentials.json'], // present on Linux; macOS uses Keychain
      keyOverridesLogin: false, // claude precedence is not a plain key-over-login
    },
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    guidanceFile: 'agents', // logical → AGENTS.md (+ .codex/AGENTS.override.md)
    configFormat: 'toml', // ~/.codex/config.toml, [mcp_servers.*]
    statuslineSupported: false, // enum-only; show+explain, delivered via AGENTS.md
    aqeProvider: 'codex',
    envMarkers: ['CODEX_SANDBOX', 'CODEX_HOME', 'CODEX_SESSION_ID'],
    auth: {
      apiKeyEnv: ['OPENAI_API_KEY'],
      loginFile: ['.codex', 'auth.json'], // ChatGPT login
      keyOverridesLogin: true, // grounded: OPENAI_API_KEY ⇒ codex ignores login
    },
  },
};

/** Ordered host ids (claude first = display order, matches routing.HOSTS). */
export const HOST_IDS = Object.keys(HOST_ADAPTERS);

/** The adapter for a host id, or null. */
export function adapterFor(id) {
  return HOST_ADAPTERS[id] ?? null;
}

/** Whether a host supports a command-backed statusline (claude yes, codex no).
 *  Callers use this for the "show + explain" UX around claude-only features. */
export function statuslineSupported(id) {
  return !!HOST_ADAPTERS[id]?.statuslineSupported;
}

/**
 * Which host is driving the current session, as a first-class detected axis.
 * Precedence: explicit override → confirmed claude markers → any CODEX_* marker
 * (heuristic) → configured primary (kit.json providers.primaryHost) → 'claude'.
 * Pure: reads only env + the passed cfg; never spawns.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {any} [cfg] kit.json config (for providers.primaryHost)
 * @returns {'claude'|'codex'}
 */
export function drivingHost(env = process.env, cfg = null) {
  const override = env.AK_DRIVING_HOST;
  if (override && HOST_ADAPTERS[override]) return /** @type {'claude'|'codex'} */ (override);
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  // codex sets no single documented session marker; a CODEX_* prefix is a safe
  // heuristic because the fallback below covers the miss.
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  const primary = cfg?.providers?.primaryHost;
  if (primary && HOST_ADAPTERS[primary]) return /** @type {'claude'|'codex'} */ (primary);
  return 'claude';
}
