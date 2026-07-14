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
  customBlocks: [],     // [{slug, templatePath, detector:{type:'command'|'dir'|'file', target}}]
  versionCheck: { ttlHours: 24, last: null, seen: {} },
};

export function loadKitConfig(file = kitConfigPath()) {
  // Migration: fall back to the ruflo-era location; the next save lands at the
  // new path (saves always write `file`, i.e. ~/.config/agentic-kit/kit.json).
  for (const cand of file === kitConfigPath() ? [file, legacyKitConfigPath()] : [file]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cand, 'utf8'));
      return { ...structuredClone(DEFAULTS), ...parsed, mcp: { ...DEFAULTS.mcp, ...parsed.mcp } };
    } catch { /* try next */ }
  }
  return structuredClone(DEFAULTS);
}

export function saveKitConfig(cfg, file = kitConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}
