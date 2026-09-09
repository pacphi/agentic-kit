// ADR-0048 dependency-probe evidence (closes gap 4 of the projection slice):
// verified command-availability facts for MCP registrations, matching the
// `discovery.dependencyProbes` shape projection.mjs already accepts. Catalog
// v4 deliberately never exposes an MCP registration's literal command
// ("bodies never leave the collector" — footprint/catalog.mjs), so this is a
// separate, narrowly-scoped reader: it opens exactly the three well-known
// host config files, extracts only the `command` field's basename per
// registration, and never returns args, env, URLs, or the full command
// string. `probeDependencies` never executes anything — it only lstats
// candidate paths on an injected PATH list.
import fs from 'node:fs';
import path from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024; // 1 MiB — generous for a registration table
const DEFAULT_PATHEXT = Object.freeze(['.COM', '.EXE', '.BAT', '.CMD']);

// Collected facts are deliberately path-free. Keep the actual absolute
// command private until the immediate collect -> probe call completes;
// serializing a fact must never disclose it. These transient facts must be
// passed directly to probeDependencies, not cloned or persisted for probing.
const absoluteCommands = new WeakMap();

function stdioFact(host, name, command) {
  const fact = {
    host, subjectKind: 'mcp-registration', subjectSelector: name,
    requirement: basenameOf(command), requirementKind: 'executable', transport: 'stdio',
  };
  if (isAbsoluteLike(command)) absoluteCommands.set(fact, command);
  return fact;
}

function basenameOf(value) {
  const segments = String(value ?? '').split(/[\\/]+/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : String(value ?? '');
}

function isAbsoluteLike(value) {
  return /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/** Stat-then-read, bounded by size, never following a final symlink further
 *  than this one lstat. Returns `null` on anything but a plain, small,
 *  readable regular file — absence and unreadability are indistinguishable
 *  here on purpose (both mean "nothing to extract"). */
function readBoundedText(fsImpl, file) {
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
  try { return fsImpl.readFileSync(file, 'utf8'); } catch { return null; }
}

function readBoundedJson(fsImpl, file) {
  const text = readBoundedText(fsImpl, file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** One MCP registration table entry -> a bounded fact, or `null` when the
 *  entry carries neither a `command` nor a `url` (nothing to report). Never
 *  reads `args` or `env`. */
function factFromRegistration(host, name, definition) {
  if (!definition || typeof definition !== 'object') return null;
  if (typeof definition.command === 'string' && definition.command.trim()) {
    return stdioFact(host, name, definition.command);
  }
  if (typeof definition.url === 'string' && definition.url.trim()) {
    return { host, subjectKind: 'mcp-registration', subjectSelector: name, transport: 'http' };
  }
  return null;
}

function claudeMcpFacts(fsImpl, file) {
  const doc = readBoundedJson(fsImpl, file);
  const servers = doc?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers)
    .map(([name, definition]) => factFromRegistration('claude', name, definition))
    .filter(Boolean);
}

/** The exact base table `[section.name]` (or its quoted-key form), never a
 *  child table under it (`[section.name.env]`) — `command` belongs to the
 *  base table only. Mirrors footprint/catalog-config-readers.mjs's own
 *  base-vs-child table boundary logic, without that module's digest-only
 *  contract (this reader needs one field's actual value). */
function tomlBaseTableBody(source, section, name) {
  const headers = [...source.matchAll(/^[ \t]*\[(?!\[)([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
  const quoted = `${section}."${name.replace(/"/g, '\\"')}"`;
  const bare = `${section}.${name}`;
  for (let index = 0; index < headers.length; index += 1) {
    const table = headers[index][1].trim();
    if (table !== bare && table !== quoted) continue;
    const start = headers[index].index + headers[index][0].length;
    const end = headers[index + 1]?.index ?? source.length;
    return source.slice(start, end);
  }
  return null;
}

function tomlTableNames(source, section) {
  const names = [];
  const re = new RegExp(
    `^\\[\\s*${section}\\s*\\.\\s*(?:"((?:[^"\\\\]|\\\\.)+)"|'([^']+)'|([A-Za-z0-9_.\\-]+))\\s*\\]\\s*$`, 'gm',
  );
  let match;
  while ((match = re.exec(source)) !== null) {
    const quoted = match[1];
    names.push(quoted ? quoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : (match[2] ?? match[3]));
  }
  return names;
}

/** One bounded string field's value out of a table body — never the body
 *  itself, never a sibling key. */
function tomlStringField(body, key) {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"((?:[^"\\\\]|\\\\.)*)"[ \\t]*(?:#.*)?$`, 'm');
  const match = re.exec(body);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
}

function codexMcpFacts(fsImpl, file) {
  const source = readBoundedText(fsImpl, file);
  if (source == null) return [];
  const facts = [];
  for (const name of tomlTableNames(source, 'mcp_servers')) {
    const body = tomlBaseTableBody(source, 'mcp_servers', name);
    if (body == null) continue;
    const command = tomlStringField(body, 'command');
    if (command) {
      facts.push(stdioFact('codex', name, command));
      continue;
    }
    const url = tomlStringField(body, 'url');
    if (url) facts.push({ host: 'codex', subjectKind: 'mcp-registration', subjectSelector: name, transport: 'http' });
  }
  return facts;
}

function opencodeMcpFacts(fsImpl, file) {
  const doc = readBoundedJson(fsImpl, file);
  const servers = doc?.mcp;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, definition]) => {
    const command = Array.isArray(definition?.command) ? definition.command[0] : definition?.command;
    return factFromRegistration('opencode', name, { ...definition, command });
  }).filter(Boolean);
}

/**
 * Read each host's MCP registration table with bounded, single-field reads.
 * Never returns args, env, URLs, or the full command string — only a
 * requirement basename (or, for a URL-transport registration, no requirement
 * at all).
 *
 * @param {{ fsImpl?: typeof fs,
 *           paths?: { claudeJson?: string, codexConfigToml?: string, opencodeConfig?: string },
 *           hosts?: string[] }} [options]
 * @returns {Array<{ host: string, subjectKind: 'mcp-registration', subjectSelector: string,
 *           requirement?: string, requirementKind?: 'executable', transport: 'stdio'|'http' }>}
 */
export function collectMcpRegistrationFacts({
  fsImpl = fs, paths = {}, hosts = ['claude', 'codex', 'opencode'],
} = {}) {
  const facts = [];
  if (hosts.includes('claude') && paths.claudeJson) facts.push(...claudeMcpFacts(fsImpl, paths.claudeJson));
  if (hosts.includes('codex') && paths.codexConfigToml) facts.push(...codexMcpFacts(fsImpl, paths.codexConfigToml));
  if (hosts.includes('opencode') && paths.opencodeConfig) facts.push(...opencodeMcpFacts(fsImpl, paths.opencodeConfig));
  return facts;
}

/** True only when `dir` itself is a usable, non-symlinked directory — a PATH
 *  entry that is a symlink or unreadable is skipped entirely (never resolved,
 *  never searched), which is what "degrades to omitted" means here: it
 *  contributes no candidate, not an `unknown` result. */
function isUsableDirectory(fsImpl, dir) {
  try { return fsImpl.lstatSync(dir).isDirectory(); } catch { return false; }
}

/** One lstat, no chase: a regular file OR a symlink counts as present
 *  without resolving where the symlink points. */
function isPresentFile(fsImpl, candidate) {
  try {
    const stat = fsImpl.lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch { return false; }
}

function isRequirementSatisfied(fsImpl, requirement, pathEntries, extensions, platform) {
  if (isAbsoluteLike(requirement)) return isPresentFile(fsImpl, requirement);
  // Joined with the TARGET platform's own separator convention — never the
  // host running this code — so a Windows PATH probed from a POSIX process
  // (or vice versa in a test) still produces the paths that platform uses.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of pathEntries) {
    if (!isUsableDirectory(fsImpl, dir)) continue;
    for (const ext of extensions) {
      if (isPresentFile(fsImpl, join(dir, requirement + ext))) return true;
    }
  }
  return false;
}

/**
 * Verify, by bounded lstat only, whether each fact's requirement is present
 * on the given PATH. Never executes anything and never follows a symlink
 * past its own single stat. A requirement that already looks like an
 * absolute path is checked directly with one lstat and still reported by
 * basename only — the exact path never appears in the returned rows.
 *
 * @param {{ facts?: Array<*>, pathEntries?: string[], fsImpl?: typeof fs,
 *           platform?: string, pathExt?: readonly string[] }} [options]
 *   `pathEntries` is `process.env.PATH` already split by the caller — this
 *   module never reads the environment itself. `pathExt` defaults to a fixed
 *   list rather than reading `process.env.PATHEXT`, for the same reason.
 * @returns {Array<{ subjectKind: string, subjectSelector: string, host: string|null,
 *           requirement: string, requirementKind: string, satisfied: boolean,
 *           authority: 'PATH probe' }>}
 */
export function probeDependencies({
  facts = [], pathEntries = [], fsImpl = fs, platform = process.platform, pathExt = DEFAULT_PATHEXT,
} = {}) {
  const extensions = platform === 'win32' ? pathExt : [''];
  const results = [];
  for (const fact of facts) {
    if (!fact?.requirement || fact.transport === 'http') continue;
    const command = absoluteCommands.get(fact) ?? fact.requirement;
    const satisfied = isRequirementSatisfied(fsImpl, command, pathEntries, extensions, platform);
    results.push({
      subjectKind: fact.subjectKind, subjectSelector: fact.subjectSelector, host: fact.host ?? null,
      requirement: basenameOf(fact.requirement), requirementKind: fact.requirementKind ?? 'executable',
      satisfied, authority: 'PATH probe',
    });
  }
  return results;
}
