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
import { managedAgentBrowserEnv } from './agent-browser.mjs';

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

const CLAUDE_SCOPE_PRECEDENCE = Object.freeze(['local', 'project', 'user']);

function claudeMcpRegistrations(servers, { scope, file }) {
  return Object.entries(servers ?? {}).map(([name, definition]) => ({
    name,
    scope,
    file,
    command: typeof definition?.command === 'string' ? definition.command : null,
    args: Array.isArray(definition?.args) ? definition.args : null,
    env: definition?.env && typeof definition.env === 'object' ? definition.env : {},
  }));
}

/** Spawn-free Claude MCP topology across the three documented scopes.
 *
 * `local` is Claude's machine-local entry for this project under
 * ~/.claude.json.projects[root].mcpServers; `project` is the repository's
 * .mcp.json; `user` is ~/.claude.json.mcpServers. The precedence is whole-entry
 * local > project > user. Files remain host/user-owned: observation here never
 * implies permission to rewrite a project or local registration. */
export function claudeMcpTopology({
  cwd = process.cwd(), home = os.homedir(), userConfigFile = null, projectConfigFile = null,
} = {}) {
  const root = path.resolve(repoRoot(cwd) ?? cwd);
  const userFile = userConfigFile ?? path.join(home, '.claude.json');
  const projectFile = projectConfigFile ?? path.join(root, '.mcp.json');
  const userConfig = readJson(userFile, {}) ?? {};
  const localProject = Object.entries(userConfig.projects ?? {}).find(([projectRoot]) =>
    path.resolve(projectRoot) === root)?.[1] ?? {};
  const projectConfig = readJson(projectFile, {}) ?? {};
  const registrations = [
    ...claudeMcpRegistrations(localProject.mcpServers, { scope: 'local', file: userFile }),
    ...claudeMcpRegistrations(projectConfig.mcpServers, { scope: 'project', file: projectFile }),
    ...claudeMcpRegistrations(userConfig.mcpServers, { scope: 'user', file: userFile }),
  ];
  const scopesFor = (name) => CLAUDE_SCOPE_PRECEDENCE
    .filter((scope) => registrations.some((entry) => entry.name === name && entry.scope === scope));
  const effectiveFor = (name) => registrations.find((entry) => entry.name === name) ?? null;
  const claudeFlowScopes = scopesFor('claude-flow');
  const legacyRufloScopes = scopesFor('ruflo');
  return {
    root,
    files: { user: userFile, project: projectFile },
    registrations,
    claudeFlowScopes,
    legacyRufloScopes,
    effective: {
      claudeFlow: effectiveFor('claude-flow'),
      legacyRuflo: effectiveFor('ruflo'),
    },
  };
}

/** Registration state across Claude's local/project/user scopes. Only a legacy
 * USER registration is automatically migrated by register(); local and project
 * files may be user/team-owned and are disclosed but preserved. */
export function registrationStatus({
  cwd = process.cwd(), home = os.homedir(), settingsFile = claudeSettingsPath(),
  userConfigFile = null, projectConfigFile = null,
} = {}) {
  const topology = claudeMcpTopology({ cwd, home, userConfigFile, projectConfigFile });
  const autoMigratableLegacyScopes = topology.legacyRufloScopes.filter((scope) => scope === 'user');
  const preservedLegacyScopes = topology.legacyRufloScopes.filter((scope) => scope !== 'user');
  return {
    claudeFlow: topology.claudeFlowScopes.length > 0,
    legacyRuflo: topology.legacyRufloScopes.length > 0,
    claudeFlowScopes: topology.claudeFlowScopes,
    legacyRufloScopes: topology.legacyRufloScopes,
    effective: topology.effective,
    autoMigratableLegacyScopes,
    preservedLegacyScopes,
    denyCount: (readJson(settingsFile, {})?.permissions?.deny ?? [])
      .filter((r) => r.startsWith('mcp__claude-flow__')).length,
  };
}

export function agentBrowserMcpConfigured(registration, enabled = true) {
  if (!enabled) return true;
  const expected = managedAgentBrowserEnv();
  return Object.entries(expected).every(([key, value]) => registration?.env?.[key] === value);
}

const canonicalRufloRegistration = (entry) => entry?.command === 'ruflo'
  && JSON.stringify(entry.args) === JSON.stringify(['mcp', 'start']);

function replaceableRufloRegistration(entry) {
  if (!canonicalRufloRegistration(entry) || entry.scope !== 'user') return false;
  return Object.keys(entry.env ?? {}).every((key) => key === 'AGENT_BROWSER_CONFIG');
}

function mcpAddArgs(name, entry) {
  const envArgs = Object.entries(entry.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['mcp', 'add', name, '-s', 'user', ...envArgs, '--', entry.command, ...entry.args];
}

async function removeUserRegistration(entry, runner) {
  const result = await runner('claude', ['mcp', 'remove', entry.name, '-s', 'user']);
  return result.code === 0;
}

async function restoreRegistrations(entries, runner) {
  for (const entry of entries) await runner('claude', mcpAddArgs(entry.name, entry));
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

export async function register(cfg = { agentBrowser: true }, {
  runner = run, inspect = claudeMcpTopology,
} = {}) {
  const desired = {
    command: 'ruflo', args: ['mcp', 'start'],
    env: managedAgentBrowserEnv({ enabled: cfg?.agentBrowser !== false }),
  };
  const userEntries = inspect().registrations.filter((entry) => entry.scope === 'user');
  const current = userEntries.find((entry) => entry.name === 'claude-flow');
  if (current && !replaceableRufloRegistration(current)) return false;
  const legacy = userEntries.find((entry) => entry.name === 'ruflo');
  const removableLegacy = legacy && replaceableRufloRegistration(legacy) ? legacy : null;
  const alreadyDesired = current && canonicalRufloRegistration(current)
    && JSON.stringify(current.env ?? {}) === JSON.stringify(desired.env);
  const removed = [];
  for (const entry of [removableLegacy, alreadyDesired ? null : current].filter(Boolean)) {
    if (!await removeUserRegistration(entry, runner)) {
      await restoreRegistrations(removed, runner);
      return false;
    }
    removed.push(entry);
  }
  if (alreadyDesired) return true;
  const added = await runner('claude', mcpAddArgs('claude-flow', desired));
  if (added.code === 0) return true;
  await restoreRegistrations(removed, runner);
  return false;
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
