// kit.json — persisted preferences + user-extensible conditional-block registry.
// Prompts-once-config-forever: choices made during `setup` land here and
// `sync`/`status` reapply them without re-asking.
import fs from 'node:fs';
import path from 'node:path';
import { kitConfigPath, legacyKitConfigPath } from './paths.mjs';

const DEFAULTS = {
  aqe: true,            // manage agentic-qe alongside ruflo
  security: true,       // run the security verification surface by default
  mcp: { register: true, excludeFamilies: [] },
  // Frontier hosts + LLM providers (prompts-once via `ak x provider pick`).
  // Default = claude-only, codex opt-in — preserves today's behavior exactly:
  // when this stays at defaults, the provider heal is a deliberate no-op.
  providers: {
    hosts: { claude: true, codex: false }, // which agent CLIs ruflo may run (ADR-034 ENABLE_*)
    aqeProvider: null,                      // AQE_LLM_PROVIDER (claude-code|openai|gemini|…); null = aqe default
    aqeFallback: [],                        // [{ provider, models:[...] }] — ordered aqe fallback chain (.agentic-qe/llm-config.json)
    models: [],                             // [{ id:'openai', model:'gpt-5.6' }] — ruflo API-key providers
    maxBudgetUsd: null,                     // → AQE_MAX_BUDGET_USD when set
  },
  customBlocks: [],     // [{slug, templatePath, detector:{type:'command'|'dir'|'file', target}}]
  versionCheck: { ttlHours: 24, last: null, seen: {} },
};

export function loadKitConfig(file = kitConfigPath()) {
  // Migration: fall back to the ruflo-era location; the next save lands at the
  // new path (saves always write `file`, i.e. ~/.config/agentic-kit/kit.json).
  for (const cand of file === kitConfigPath() ? [file, legacyKitConfigPath()] : [file]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cand, 'utf8'));
      return {
        ...structuredClone(DEFAULTS),
        ...parsed,
        mcp: { ...DEFAULTS.mcp, ...parsed.mcp },
        providers: {
          ...DEFAULTS.providers,
          ...parsed.providers,
          hosts: { ...DEFAULTS.providers.hosts, ...parsed.providers?.hosts },
        },
      };
    } catch { /* try next */ }
  }
  return structuredClone(DEFAULTS);
}

export function saveKitConfig(cfg, file = kitConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}
