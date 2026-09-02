// MCP registration + tool-family gating. Upstream has no server-side filter
// (3.28: ~276 tools statically aggregated), so exclusions are exact-name
// permissions.deny rules in ~/.claude/settings.json — see ruvnet/ruflo#952.
// Registration key is `claude-flow` (#2206), user scope.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rufloNodeModules, claudeUserMcpPath, claudeSettingsPath, repoRoot } from './paths.mjs';
import { run } from './exec.mjs';
import { readJson, addDenyRules, removeDenyRules } from './settings.mjs';
import { writeFileWithBackup } from './file-write.mjs';

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

/** Is the standalone ruvector MCP server registered at user scope? Spawn-free
 *  read of ~/.claude.json (same seam as registrationStatus) — `claude mcp list`
 *  runs a live health check per server and has no stable output schema. ak NEVER
 *  registers this: user registration IS the opt-in signal that ak may keep the
 *  global CLI current. */
export function ruvectorRegistered() {
  return 'ruvector' in (readJson(claudeUserMcpPath(), {})?.mcpServers ?? {});
}

/**
 * Retired project-scoped `codex mcp-server` registration state. Older agentic-kit
 * versions persisted it to `.mcp.json`; reading that file is the spawn-free
 * equivalent of `claude mcp get codex`. `owned` reflects the legacy kit.json
 * receipt (`integrations.ownership.codex.mcp === 'ak'`), which gates retirement.
 * @returns {{ registered: boolean, owned: boolean }}
 */
export function codexMcpStatus(cfg, cwd = process.cwd()) {
  const root = repoRoot(cwd) ?? cwd;
  const servers = readJson(path.join(root, '.mcp.json'), {})?.mcpServers ?? {};
  return { registered: 'codex' in servers, owned: cfg?.integrations?.ownership?.codex?.mcp === 'ak' };
}

function tomlString(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function tomlStringArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch { return null; }
}

/** Read only Codex MCP table identity/command/argv facts. This deliberately is
 * not a general TOML parser: status needs a spawn-free, fail-closed topology
 * check and never rewrites these host-owned files. */
function codexMcpRegistrations(file, scope) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const headers = [...source.matchAll(/^\s*\[mcp_servers\.(?:"([^"\n]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)];
  return headers.map((header, index) => {
    const bodyStart = header.index + header[0].length;
    const bodyEnd = headers[index + 1]?.index ?? source.length;
    const body = source.slice(bodyStart, bodyEnd);
    const command = tomlString(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(body)?.[1]);
    const args = tomlStringArray(/^\s*args\s*=\s*(\[[^\n]*\])\s*$/m.exec(body)?.[1]);
    return { name: header[1] ?? header[2], scope, file, command, args };
  });
}

/** Effective Codex MCP topology across project and user configuration.
 * Reports stall-prone recursive Codex registration, concrete AQE registration,
 * and redundant Ruflo transports without mutating any user-owned config. */
export function codexMcpTopology({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const root = repoRoot(cwd) ?? cwd;
  const files = [path.join(root, '.codex', 'config.toml'), path.join(home, '.codex', 'config.toml')];
  const registrations = [
    ...codexMcpRegistrations(files[0], 'project'),
    ...codexMcpRegistrations(files[1], 'user'),
  ];
  const selfRegistrations = registrations.filter((entry) =>
    entry.name === 'codex' && entry.command === 'codex' && entry.args?.includes('mcp-server'));
  const agenticQeRegistrations = registrations.filter((entry) => entry.name === 'agentic-qe');
  const rufloRegistrations = registrations.filter((entry) =>
    entry.name === 'ruflo' || entry.name === 'claude-flow'
    || entry.command === 'ruflo'
    || (entry.command === 'ak' && JSON.stringify(entry.args) === JSON.stringify(['x', 'ruflo-mcp'])));
  return {
    files,
    registrations,
    selfRegistrations,
    agenticQeRegistrations,
    rufloRegistrations,
    duplicateRuflo: rufloRegistrations.length > 1,
  };
}

/** Return the user-owned Codex MCP entries that ak can repair safely after an
 * explicit sync confirmation. The canonical workspace-aware `ruflo` entry is
 * deliberately never included. */
export function codexMcpRepairPlan(topology) {
  const targets = [];
  const seen = new Set();
  const add = (entry, reason) => {
    const key = `${entry.file}\0${entry.scope}\0${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ ...entry, reason });
  };
  for (const entry of topology.selfRegistrations) {
    add(entry, 'recursively launches Codex through the deprecated mcp-server transport');
  }
  for (const entry of topology.rufloRegistrations) {
    if (entry.name !== 'ruflo') {
      add(entry, 'duplicates the canonical workspace-aware [mcp_servers.ruflo] registration');
    }
  }
  return targets;
}

/** Apply a previously disclosed repair plan through Codex's supported command,
 * then verify every target disappeared from the effective topology. */
export async function repairCodexMcpTopology(targets, cwd = process.cwd(), {
  runner = run, inspect = codexMcpTopology,
} = {}) {
  const backedUp = new Set();
  for (const target of targets) {
    if (!backedUp.has(target.file)) {
      try {
        writeFileWithBackup(target.file, fs.readFileSync(target.file, 'utf8'));
        backedUp.add(target.file);
      } catch (error) {
        return { ok: false, changed: false, detail: `could not back up ${target.file}: ${error.message}` };
      }
    }
    const result = await runner('codex', ['mcp', 'remove', target.name], { cwd });
    if (result.code !== 0) {
      return {
        ok: false,
        changed: false,
        detail: `could not remove [mcp_servers.${target.name}] from ${target.file}: ${(result.stderr || result.stdout || `exit ${result.code}`).split('\n')[0].slice(0, 160)}`,
      };
    }
  }
  const remaining = inspect({ cwd }).registrations.filter((entry) =>
    targets.some((target) => target.file === entry.file && target.scope === entry.scope && target.name === entry.name));
  if (remaining.length) {
    return {
      ok: false,
      changed: targets.length > 0,
      detail: `Codex MCP repair could not be verified; remaining entries: ${remaining.map((entry) => `[mcp_servers.${entry.name}]`).join(', ')}`,
    };
  }
  return { ok: true, changed: targets.length > 0, detail: `removed ${targets.map((target) => `[mcp_servers.${target.name}]`).join(', ')}` };
}

/**
 * Integration state: is the Ruflo MCP registered INTO Codex? `ensureRufloMcpInCodex`
 * runs `codex mcp add ruflo …`, which writes a `[mcp_servers.ruflo]` table into
 * ~/.codex/config.toml — so a spawn-free presence check reads that file (mirrors
 * codexMcpStatus's spawn-free approach). The command and args facts let sync
 * migrate only an ak-owned legacy registration to the workspace-aware launcher.
 * `owned` reflects kit.json's ak-ownership marker
 * (`integrations.ownership.codex.reverseMcp === 'ak'`).
 * @returns {{ registered: boolean, owned: boolean, command: string|null, args: string[]|null }}
 */
export function rufloCodexMcpStatus(cfg, { home = os.homedir() } = {}) {
  let registered = false;
  let command = null;
  let args = null;
  try {
    const source = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    const header = /^\s*\[mcp_servers\.(?:ruflo|"ruflo")\]\s*$/m.exec(source);
    registered = !!header;
    if (header) {
      const rest = source.slice(header.index + header[0].length);
      const next = rest.search(/^\s*\[/m);
      const body = rest.slice(0, next < 0 ? rest.length : next);
      const commandMatch = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(body);
      const argsMatch = /^\s*args\s*=\s*(\[[^\n]*\])\s*$/m.exec(body);
      try { if (commandMatch) command = JSON.parse(commandMatch[1]); } catch { /* non-canonical TOML */ }
      try { if (argsMatch) args = JSON.parse(argsMatch[1]); } catch { /* non-canonical TOML */ }
    }
  } catch { /* config absent → not registered */ }
  return {
    registered,
    owned: cfg?.integrations?.ownership?.codex?.reverseMcp === 'ak',
    command,
    args,
  };
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
