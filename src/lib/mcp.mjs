// MCP registration + tool-family gating. Upstream has no server-side filter
// (3.28: ~276 tools statically aggregated), so exclusions are exact-name
// permissions.deny rules in ~/.claude/settings.json — see ruvnet/ruflo#952.
// Registration key is `claude-flow` (#2206), user scope.
import fs from 'node:fs';
import path from 'node:path';
import { rufloNodeModules, claudeUserMcpPath, claudeSettingsPath, repoRoot } from './paths.mjs';
import { run } from './exec.mjs';
import { readJson, addDenyRules, removeDenyRules } from './settings.mjs';

/** Enumerate MCP tool names from the installed package's mcp-tools modules,
 *  grouped by name prefix (family). Returns Map<family, string[]>. */
export function toolFamilies() {
  const dir = path.join(rufloNodeModules(), '@claude-flow', 'cli', 'dist', 'src', 'mcp-tools');
  const families = new Map();
  if (!fs.existsSync(dir)) return families;
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/name:\s*["']([a-z][a-z0-9]*_[a-z0-9_]+)["']/g)) names.add(m[1]);
  }
  for (const n of names) {
    const fam = n.split('_')[0];
    if (!families.has(fam)) families.set(fam, []);
    families.get(fam).push(n);
  }
  for (const list of families.values()) list.sort();
  return families;
}

/** Registration state from ~/.claude.json (user scope). */
export function registrationStatus() {
  const cfg = readJson(claudeUserMcpPath(), {});
  const servers = cfg?.mcpServers ?? {};
  return {
    claudeFlow: 'claude-flow' in servers,
    legacyRuflo: 'ruflo' in servers,
    denyCount: (readJson(claudeSettingsPath(), {})?.permissions?.deny ?? [])
      .filter((r) => r.startsWith('mcp__claude-flow__')).length,
  };
}

/**
 * Project-scoped codex MCP (mcp__codex__codex) registration state. `ensureCodexMcp`
 * registers it via `claude mcp add codex -s project`, which persists to `.mcp.json`
 * at the repo root — so reading that file is the spawn-free equivalent of
 * `claude mcp get codex` (deterministic + testable, matching `registrationStatus`'s
 * file-read approach). `owned` reflects kit.json's ak-ownership marker
 * (`providers.codexMcp === 'ak'`), which gates teardown.
 * @returns {{ registered: boolean, owned: boolean }}
 */
export function codexMcpStatus(cfg, cwd = process.cwd()) {
  const root = repoRoot(cwd) ?? cwd;
  const servers = readJson(path.join(root, '.mcp.json'), {})?.mcpServers ?? {};
  return { registered: 'codex' in servers, owned: cfg?.providers?.codexMcp === 'ak' };
}

export async function register() {
  await run('claude', ['mcp', 'remove', 'ruflo', '-s', 'user']); // migrate legacy key
  const r = await run('claude', ['mcp', 'add', 'claude-flow', '-s', 'user', '--', 'ruflo', 'mcp', 'start']);
  return r.code === 0;
}

export async function unregister() {
  for (const key of ['claude-flow', 'ruflo']) {
    for (const scope of ['user', 'local', 'project']) {
      await run('claude', ['mcp', 'remove', key, '-s', scope]);
    }
  }
  return removeDenyRules(claudeSettingsPath(), (r) => r.startsWith('mcp__claude-flow__'));
}

/** Replace family exclusions: clears prior kit rules, denies every tool in the
 *  named families. Returns {denied, unknown: families that don't exist}. */
export function applyExclusions(excludeFamilies) {
  const families = toolFamilies();
  removeDenyRules(claudeSettingsPath(), (r) => r.startsWith('mcp__claude-flow__'));
  const rules = [];
  const unknown = [];
  for (const fam of excludeFamilies) {
    const tools = families.get(fam);
    if (!tools) { unknown.push(fam); continue; }
    for (const t of tools) rules.push(`mcp__claude-flow__${t}`);
  }
  const denied = rules.length ? addDenyRules(claudeSettingsPath(), rules) : 0;
  return { denied, unknown };
}
