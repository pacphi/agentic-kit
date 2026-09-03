// MCP registration + tool-family gating. Upstream has no server-side filter
// (3.28: ~276 tools statically aggregated), so exclusions are exact-name
// permissions.deny rules in ~/.claude/settings.json — see ruvnet/ruflo#952.
// Registration key is `claude-flow` (#2206), user scope.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

const sameArgs = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

function mcpTableName(table) {
  const match = /^mcp_servers\.(?:"([^"\n]+)"|([A-Za-z0-9_-]+))$/.exec(table.trim());
  return match ? (match[1] ?? match[2]) : null;
}

/** Read the bounded base-table sections behind Codex MCP registrations. This
 * is deliberately not a general TOML parser: only a base
 * `[mcp_servers.<name>]` table with single-line string command/args facts is
 * observed. Any extra field or child table makes the entry ineligible for
 * automatic repair, while status can still report a suspicious topology. */
function codexMcpSections(file, scope) {
  let source;
  let regularFile = false;
  try {
    const stat = fs.lstatSync(file);
    regularFile = stat.isFile() && !stat.isSymbolicLink();
    source = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const headers = [...source.matchAll(/^[ \t]*\[(?!\[)([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
  return headers.flatMap((header, index) => {
    const name = mcpTableName(header[1]);
    if (!name) return [];
    const bodyStart = header.index + header[0].length;
    const bodyEnd = headers[index + 1]?.index ?? source.length;
    const body = source.slice(bodyStart, bodyEnd);
    const command = tomlString(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(body)?.[1]);
    const args = tomlStringArray(/^\s*args\s*=\s*(\[[^\n]*\])\s*$/m.exec(body)?.[1]);
    const meaningful = body.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const exactFields = meaningful.length === 2
      && meaningful.some((line) => /^command\s*=/.test(line))
      && meaningful.some((line) => /^args\s*=/.test(line));
    const childPrefixes = [`mcp_servers.${name}.`, `mcp_servers."${name}".`];
    const hasChildren = headers.some((candidate) =>
      childPrefixes.some((prefix) => candidate[1].trim().startsWith(prefix)));
    let repairKind = null;
    if (exactFields && !hasChildren && name === 'codex' && command === 'codex'
      && sameArgs(args, ['mcp-server'])) repairKind = 'recursive-codex';
    if (exactFields && !hasChildren && name === 'claude-flow' && command === 'ruflo'
      && sameArgs(args, ['mcp', 'start'])) repairKind = 'legacy-ruflo';
    return [{
      name, scope, file, command, args, repairKind, regularFile,
      fingerprint: fingerprint(source.slice(header.index, bodyEnd)),
      start: header.index, end: bodyEnd, source,
    }];
  });
}

function codexMcpRegistrations(file, scope) {
  return codexMcpSections(file, scope).map(({ start: _start, end: _end, source: _source, ...entry }) => entry);
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
    (entry.name === 'ruflo' && (entry.command === 'ruflo'
      || (entry.command === 'ak' && sameArgs(entry.args, ['x', 'ruflo-mcp']))))
    || entry.repairKind === 'legacy-ruflo');
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
  for (const entry of topology.selfRegistrations.filter((candidate) =>
    candidate.regularFile && candidate.repairKind === 'recursive-codex')) {
    add(entry, 'recursively launches Codex through the deprecated mcp-server transport');
  }
  for (const entry of topology.rufloRegistrations.filter((candidate) =>
    candidate.regularFile && candidate.repairKind === 'legacy-ruflo')) {
    add(entry, 'replaces the deprecated legacy Ruflo transport with canonical workspace-aware [mcp_servers.ruflo]');
  }
  return targets;
}

function sameRepairIdentity(left, right) {
  return left?.file === right?.file && left?.scope === right?.scope
    && left?.name === right?.name && left?.command === right?.command
    && sameArgs(left?.args, right?.args) && left?.repairKind === right?.repairKind
    && left?.fingerprint === right?.fingerprint;
}

function validRepairTarget(target) {
  if (!path.isAbsolute(target?.file ?? '') || !/^[a-f0-9]{64}$/.test(target?.fingerprint ?? '')) return false;
  if (target.regularFile !== true) return false;
  if (target.scope !== 'project' && target.scope !== 'user') return false;
  if (target.repairKind === 'recursive-codex') {
    return target.name === 'codex' && target.command === 'codex'
      && sameArgs(target.args, ['mcp-server']);
  }
  if (target.repairKind === 'legacy-ruflo') {
    return target.name === 'claude-flow' && target.command === 'ruflo'
      && sameArgs(target.args, ['mcp', 'start']);
  }
  return false;
}

function removeProjectCodexMcpTarget(target) {
  const current = codexMcpSections(target.file, target.scope)
    .find((entry) => sameRepairIdentity(entry, target));
  if (!current) return false;
  writeFileWithBackup(target.file, current.source.slice(0, current.start) + current.source.slice(current.end));
  return true;
}

function createCurrentRepairBackup(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('refusing a non-regular or symlinked Codex config');
  }
  const source = fs.readFileSync(file);
  const backup = `${file}.ak-mcp-repair-${process.pid}-${Date.now()}.bak`;
  const handle = fs.openSync(backup, 'wx', stat.mode & 0o777);
  try {
    fs.writeFileSync(handle, source);
  } finally {
    fs.closeSync(handle);
  }
  return backup;
}

/** Apply a previously disclosed repair plan. Project-scoped tables are edited
 * through a bounded, backup-first exact-section removal because Codex's MCP
 * command writes only the user config. User-scoped tables go through Codex's
 * supported command. Every target is identity-checked immediately before its
 * mutation and re-probed immediately after it. */
export async function repairCodexMcpTopology(targets, cwd = process.cwd(), {
  runner = run, inspect = codexMcpTopology,
} = {}) {
  const backedUp = new Set();
  const removed = [];
  for (const target of targets) {
    if (!validRepairTarget(target)) {
      return { ok: false, changed: removed.length > 0, detail: 'Codex MCP repair target was not a recognized disclosed legacy shape' };
    }
    const live = inspect({ cwd }).registrations.find((entry) =>
      entry.file === target.file && entry.scope === target.scope && entry.name === target.name);
    if (!sameRepairIdentity(live, target)) {
      return {
        ok: false, changed: removed.length > 0,
        detail: `[mcp_servers.${target.name}] changed after confirmation; Codex MCP repair aborted`,
      };
    }
    if (!backedUp.has(target.file)) {
      try {
        createCurrentRepairBackup(target.file);
        backedUp.add(target.file);
      } catch (error) {
        return {
          ok: false, changed: removed.length > 0,
          detail: `could not create a current-state recovery copy for ${target.file}: ${error.message}`,
        };
      }
    }
    if (target.scope === 'project') {
      try {
        if (!removeProjectCodexMcpTarget(live)) throw new Error('exact confirmed table was not found');
      } catch (error) {
        return {
          ok: false, changed: removed.length > 0,
          detail: `could not remove [mcp_servers.${target.name}] from ${target.file}: ${error.message}`,
        };
      }
    } else {
      const result = await runner('codex', ['mcp', 'remove', target.name], { cwd });
      if (result.code !== 0) {
        return {
          ok: false, changed: removed.length > 0,
          detail: `could not remove [mcp_servers.${target.name}] from ${target.file}: ${(result.stderr || result.stdout || `exit ${result.code}`).split('\n')[0].slice(0, 160)}`,
        };
      }
    }
    const remaining = inspect({ cwd }).registrations.find((entry) =>
      entry.file === target.file && entry.scope === target.scope && entry.name === target.name);
    if (remaining) {
      return {
        ok: false, changed: true,
        detail: `Codex MCP repair could not be verified; [mcp_servers.${target.name}] remains`,
      };
    }
    removed.push(target);
  }
  return { ok: true, changed: removed.length > 0, detail: `removed ${removed.map((target) => `[mcp_servers.${target.name}]`).join(', ')}` };
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
