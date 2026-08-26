// kit.json — persisted preferences + user-extensible conditional-block registry.
// Prompts-once-config-forever: choices made during `setup` land here and
// `sync`/`status` reapply them without re-asking.
import fs from 'node:fs';
import path from 'node:path';
import { kitConfigPath, legacyKitConfigPath } from './paths.mjs';
import {
  CURRENT_INTEGRATIONS_VERSION,
  DEFAULT_DEJA_VU_INTENT,
  migrateIntegrationConfig,
  validateDejaVuIntent,
} from './adapters/config.mjs';
import { defaultHostMap } from './adapters/registries.mjs';
import {
  DEFAULT_PRIMARY_HOST,
  ROUTING_SCHEMA_VERSION,
  migrateRoutingConfig,
} from './routing-config.mjs';

const DEFAULTS = {
  aqe: true,            // manage agentic-qe alongside ruflo
  agentdb: true,        // manage the standalone agentdb CLI (harvest's write path), pinned to ruflo's bundled version
  ruvnetBrain: true,    // install/manage the RuvNet Brain (offline KB + search_ruvnet MCP)
  ruvector: true,       // report drift for a globally-installed ruvector CLI (never installs it)
  security: true,       // run the security verification surface by default
  harvest: false,       // opt-in learning-write (`ak x harvest`); off = never runs writes
  health: { ring: [] }, // persisted stack-health snapshot ring (see health-history.mjs)
  mcp: { register: true, excludeFamilies: [] },
  integrations: {
    version: CURRENT_INTEGRATIONS_VERSION,
    hosts: defaultHostMap(),
    bindings: [],
    tools: {
      dejaVu: structuredClone(DEFAULT_DEJA_VU_INTENT),
    },
  },
  routing: {
    version: ROUTING_SCHEMA_VERSION,
    primaryHost: DEFAULT_PRIMARY_HOST,
    routes: {},
  },
  // Frontier hosts + LLM providers (prompts-once via `ak host pick`).
  // Default = claude-only, codex opt-in — preserves today's behavior exactly:
  // when this stays at defaults, the provider heal is a deliberate no-op.
  providers: {
    aqeProvider: null,                      // AQE_LLM_PROVIDER (claude-code|openai|gemini|…); null = aqe default
    aqeFallback: [],                        // [{ provider, models:[...] }] — ordered aqe fallback chain (.agentic-qe/llm-config.json)
    models: [],                             // [{ id:'ollama', model:'qwen3.6:27b', endpoint?:'http://127.0.0.1:11434' }] — ruflo providers
    maxBudgetUsd: null,                     // → AQE_MAX_BUDGET_USD when set
  },
  statusline: { codex: null }, // {preset,lastProjection}: explicit ownership of Codex [tui] keys
  customBlocks: [],     // [{slug, templatePath, detector:{type:'command'|'dir'|'file', target}}]
  versionCheck: { ttlHours: 24, last: null, seen: {} },
  // Experimental adapter door (staged behind AK_EXPERIMENTAL_HOST_ADAPTERS=1):
  // [{name, source, contract}] entries admitted by admission.mjs's
  // admitAdapters/bootstrapHostAdapters. Empty by default = zero effect.
  hostAdapters: [],
};

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// F-14: kit.json top-level keys this ak version understands, derived from
// DEFAULTS (the envelope already lists every recognized key, versioned
// sub-objects included) rather than a second literal that could drift.
const KNOWN_TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS));

// Warn once per process per distinct unknown-key set, not once per load —
// loadKitConfig runs on nearly every command invocation.
const warnedUnknownKeySignatures = new Set();

function warnUnknownTopLevelKeys(parsed) {
  if (!plain(parsed)) return;
  const unknown = Object.keys(parsed).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
  if (unknown.length === 0) return;
  const signature = [...unknown].sort().join(',');
  if (warnedUnknownKeySignatures.has(signature)) return;
  warnedUnknownKeySignatures.add(signature);
  // Deliberately console.error, not lib/output.mjs's warn() — that helper
  // writes to stdout (console.log), which would corrupt `--json` consumers
  // of loadKitConfig. console.error here mirrors the existing stderr-only
  // warning convention in commands/run.mjs.
  console.error(
    `kit.json keys not recognized by this ak version: ${unknown.join(', ')} — preserved, ignored`,
  );
}

function assertLoadableEnvelopes(config) {
  if (!plain(config.integrations)) {
    throw new TypeError(
      'integrations must be an object; repair kit.json or rerun `ak setup --reconfigure`',
    );
  }
  if (config.integrations.version !== CURRENT_INTEGRATIONS_VERSION) {
    throw new TypeError(
      `unsupported integrations.version ${String(config.integrations.version)}; update agentic-kit before using this config`,
    );
  }
  if (!plain(config.integrations.hosts)) {
    throw new TypeError('integrations.hosts must be an object');
  }
  if (!Array.isArray(config.integrations.bindings)) {
    throw new TypeError('integrations.bindings must be an array');
  }
  if (!plain(config.integrations.tools)) {
    throw new TypeError('integrations.tools must be an object');
  }
  validateDejaVuIntent(config.integrations.tools.dejaVu);
  if (config.integrations.ownership !== undefined && !plain(config.integrations.ownership)) {
    throw new TypeError('integrations.ownership must be an object');
  }
  if (!plain(config.routing)) {
    throw new TypeError(
      'routing must be an object; repair kit.json or rerun `ak setup --reconfigure`',
    );
  }
  if (config.routing.version !== ROUTING_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported routing.version ${String(config.routing.version)}; update agentic-kit before using this config`,
    );
  }
}

export class KitConfigError extends Error {
  constructor(configPath, reason, options = {}) {
    super(`invalid kit config ${configPath}: ${reason}`, options);
    this.name = 'KitConfigError';
    this.configPath = configPath;
    this.reason = reason;
  }
}

export function migrateKitConfig(config = {}) {
  // Integration migration must consume legacy hosts and ownership first; routing
  // then consumes primaryHost/dualRouting from the same still-raw providers map.
  return migrateRoutingConfig(migrateIntegrationConfig(config));
}

function withDefaults(config) {
  assertLoadableEnvelopes(config);
  const integrations = config.integrations?.version === CURRENT_INTEGRATIONS_VERSION
    ? {
      ...structuredClone(DEFAULTS.integrations),
      ...config.integrations,
      hosts: { ...DEFAULTS.integrations.hosts, ...config.integrations.hosts },
      tools: {
        ...structuredClone(DEFAULTS.integrations.tools),
        ...config.integrations.tools,
        dejaVu: {
          ...structuredClone(DEFAULTS.integrations.tools.dejaVu),
          ...config.integrations.tools.dejaVu,
        },
      },
    }
    : config.integrations;
  const routing = config.routing?.version === ROUTING_SCHEMA_VERSION
    ? {
      ...structuredClone(DEFAULTS.routing),
      ...config.routing,
      routes: { ...DEFAULTS.routing.routes, ...config.routing.routes },
    }
    : config.routing;
  const merged = {
    ...structuredClone(DEFAULTS),
    ...config,
    health: { ...DEFAULTS.health, ...config.health },
    mcp: { ...DEFAULTS.mcp, ...config.mcp },
    integrations,
    routing,
    providers: { ...DEFAULTS.providers, ...config.providers },
    statusline: { ...DEFAULTS.statusline, ...config.statusline },
  };
  // Defaults can enable a host omitted by a partial legacy file. Normalize once
  // more so inferred bindings and the saved representation already converge.
  return migrateKitConfig(merged);
}

export function loadKitConfig(file = kitConfigPath()) {
  // Migration: fall back to the ruflo-era location; the next save lands at the
  // new path (saves always write `file`, i.e. ~/.config/agentic-kit/kit.json).
  for (const cand of file === kitConfigPath() ? [file, legacyKitConfigPath()] : [file]) {
    let raw;
    try {
      raw = fs.readFileSync(cand, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new KitConfigError(cand, error.message, { cause: error });
    }
    warnUnknownTopLevelKeys(parsed);
    // Migrate raw presence before defaults can masquerade as legacy user intent.
    try {
      return structuredClone(withDefaults(migrateKitConfig(parsed)));
    } catch (error) {
      if (error instanceof KitConfigError) throw error;
      throw new KitConfigError(cand, error?.message ?? String(error), { cause: error });
    }
  }
  return structuredClone(withDefaults(migrateKitConfig({})));
}

export function saveKitConfig(cfg, file = kitConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(migrateKitConfig(cfg), null, 2) + '\n');
}
