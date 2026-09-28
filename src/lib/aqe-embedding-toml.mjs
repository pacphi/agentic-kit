// Deliberately narrow TOML editor: unsupported encodings remain user-owned.
import { inspectCodexTomlStructure, isTomlTableLine, tomlStringArrayAt } from './codex-toml-safety.mjs';
import { recognizedAqeTransport, parseEmbeddingJson } from './aqe-embedding-transport.mjs';
const BASE = 'mcp_servers.agentic-qe';
const ENV = `${BASE}.env`;
const KEY = 'AQE_EMBEDDER_ENDPOINT';

// TOML 1.0 basic-string escapes. Decoding every one (including 8-digit \U, which
// JSON.parse rejects) means an escaped alias of `mcp_servers` or `agentic-qe` is
// compared by its real name; a code point that is not a Unicode scalar is refused.
const BASIC_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
function basicKey(raw) {
  return raw.slice(1, -1).replace(/\\(U[0-9A-Fa-f]{8}|u[0-9A-Fa-f]{4}|.)/g, (_, escape) => {
    if (escape.length === 1) {
      if (!Object.hasOwn(BASIC_ESCAPES, escape)) throw new Error('unsupported TOML key encoding');
      return BASIC_ESCAPES[escape];
    }
    const code = Number.parseInt(escape.slice(1), 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('unsupported TOML key encoding');
    return String.fromCodePoint(code);
  });
}

/** One decoder for table headers and assignments: split a dotted key at the start
 * of `text` into decoded segments, keeping dots inside quoted segments.
 * @returns {{segments:string[], rest:string, complete:boolean}} `complete` is false
 * after a dangling dot. */
function tomlKeySegments(text) {
  const token = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.)?/y;
  const segments = [];
  let match;
  let end = 0;
  let complete = true;
  while ((match = token.exec(text))) {
    const raw = match[1];
    segments.push(raw.startsWith('"') ? basicKey(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw);
    end = token.lastIndex;
    complete = !match[2];
    if (complete) break;
  }
  return { segments, rest: text.slice(end), complete };
}

// Parse table key segments, preserving dots inside quoted project/server names.
function tableKind(text) {
  const header = /^\s*\[(\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(text);
  if (!header) throw new Error('unsupported TOML header');
  const { segments, rest, complete } = tomlKeySegments(header[2]);
  if (segments[0] !== 'mcp_servers') return 'unrelated';
  if (header[1] || !complete || rest !== '') throw new Error('unsupported AQE table encoding');
  if (segments.length === 1) return 'mcp_servers';
  if (segments[1] !== 'agentic-qe') return 'unrelated';
  if (segments.length === 2) return BASE;
  if (segments.length === 3 && segments[2] === 'env') return ENV;
  return 'unrelated';
}

/** At the document root or under [mcp_servers], an assignment is user-owned unless
 * it can define the AQE registration: `mcp_servers = {...}`, an inline or dotted
 * `agentic-qe` entry, in any quoting or escaping. Those are refused, never guessed.
 * @returns {boolean} true when the line is outside the AQE tables and can be skipped. */
function unrelatedAssignment(table, text) {
  if (table === BASE || table === ENV) return false;
  const { segments, rest, complete } = tomlKeySegments(text);
  if (!segments.length || !complete || !rest.startsWith('=')) throw new Error('unsupported TOML assignment preserved');
  const keyPath = table === '' ? segments : ['mcp_servers', ...segments];
  if (keyPath[0] === 'mcp_servers' && (keyPath.length === 1 || keyPath[1] === 'agentic-qe')) {
    throw new Error('inline, dotted or quoted AQE registrations require manual embedding configuration');
  }
  return true;
}

function scalar(text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`).exec(text);
  if (!match) throw new Error(`unsupported AQE ${key} encoding`);
  return parseEmbeddingJson(match[1]);
}

function transportAssignment(text, transport, rest) {
  if (/^env\s*=/.test(text)) throw new Error('inline AQE environment requires manual embedding configuration');
  if (/^command\s*=/.test(text)) {
    if (transport.command !== null) throw new Error('duplicate AQE command');
    transport.command = scalar(text, 'command');
  }
  if (/^args\s*=/.test(text)) {
    if (transport.args !== null) throw new Error('duplicate AQE arguments');
    // `rest` starts at this line so a multi-line array is read whole.
    const args = tomlStringArrayAt(rest, 'args');
    if (!args?.value) throw new Error('unsupported AQE arguments encoding');
    transport.args = args.value;
  }
}

/** The AQE registration's env table in a Codex TOML file. `keys` are the env keys the
 *  caller manages (the embedding projection: AQE_EMBEDDER_ENDPOINT; the project pin:
 *  AQE_PROJECT_ROOT, AQE_MEMORY_PATH, AQE_STORAGE_PATH). `current`/`replace` serve the
 *  first key; `get`/`render` serve every key.
 *  @param {string|null} source @param {string[]} [keys] */
export function aqeTomlEnvironment(source, keys = [KEY]) {
  if (source === null) return { missing: true };
  const structure = inspectCodexTomlStructure(source);
  if (!structure.valid) throw new Error('unsupported Codex TOML preserved');
  let table = '';
  let base = null;
  let env = null;
  /** @type {Record<string, {start: number, end: number, value: string}>} */
  const found = {};
  const transport = { command: null, args: null };
  const seenTables = new Set();
  for (const line of structure.lines) {
    if (!line.live) continue;
    if (isTomlTableLine(line.text)) {
      table = tableKind(line.text);
      if (table === 'unrelated') continue;
      if (seenTables.has(table)) throw new Error('duplicate TOML table preserved');
      seenTables.add(table);
      if (table === BASE) base = line;
      if (table === ENV) env = line;
      continue;
    }
    const text = line.text.trim();
    if (!text || text.startsWith('#')) continue;
    if (table === 'unrelated') continue;
    if (unrelatedAssignment(table, text)) continue;
    // Inside the AQE tables, dotted/quoted keys can alias a managed field: refuse.
    if (!/^[A-Za-z0-9_-]+\s*=/.test(text)) throw new Error('dotted or quoted TOML assignments require manual embedding configuration');
    if (table === BASE) transportAssignment(text, transport, source.slice(line.start));
    if (table !== ENV) continue;
    const key = keys.find((k) => new RegExp(`^${k}\\s*=`).test(text));
    if (!key) continue;
    if (found[key]) throw new Error(key === KEY ? 'duplicate AQE endpoint' : `duplicate AQE ${key}`);
    found[key] = { start: line.start, end: line.end, value: scalar(text, key) };
  }
  if (!base) return { missing: true };
  if (!recognizedAqeTransport(transport.command, transport.args ?? [])) throw new Error('unrecognized AQE MCP transport preserved');
  const get = (key) => (found[key] ? { present: true, value: found[key].value } : { present: false });
  const render = (nextStates, options) => renderEnv(source, env, found, nextStates, ENV, options);
  return { current: get(keys[0]), get, render, replace: (next) => render({ [keys[0]]: next }), containerPresent: !!env };
}

/** Remove the `[header]` table when nothing but blank lines is left in it (a table ak
 *  added, released again). Reaching the end of the file, the blank line ak put before it
 *  goes too, so the file ends as it did before ak added the table. */
function dropEmptyTable(text, header) {
  const lines = text.split(/(?<=\n)/);
  const at = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (at < 0) return text;
  let end = at + 1;
  while (end < lines.length && lines[end].trim() === '') end += 1;
  if (end < lines.length && !lines[end].trimStart().startsWith('[')) return text;
  let start = at;
  if (end === lines.length && start > 0 && lines[start - 1].trim() === '') start -= 1;
  return lines.slice(0, start).join('') + lines.slice(end).join('');
}

/** Replace, remove or append each key's line; new keys go after the env table header,
 *  or into a new `[header]` table at the end. Edits apply from the last offset back.
 *  `dropEmptyContainer`: remove the table when the edits leave it empty. */
function renderEnv(source, env, found, nextStates, header, { dropEmptyContainer = false } = {}) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const line = (key, next) => (next.present ? `${key} = ${JSON.stringify(next.value)}${nl}` : '');
  const edits = [];
  let added = '';
  for (const [key, next] of Object.entries(nextStates)) {
    if (found[key]) edits.push({ start: found[key].start, end: found[key].end, text: line(key, next) });
    else added += line(key, next);
  }
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (!added) return dropEmptyContainer ? dropEmptyTable(out, header) : out;
  if (env) {
    const bare = !(env.text.endsWith('\n') || source[env.end - 1] === '\n');
    return out.slice(0, env.end) + (bare ? nl : '') + added + out.slice(env.end);
  }
  return out + (out.endsWith('\n') ? nl : nl + nl) + `[${header}]${nl}${added}`;
}

const SHELL = 'shell_environment_policy';
const SHELL_SET = `${SHELL}.set`;

/** Classify a table header for the shell editor: the `[shell_environment_policy.set]`
 *  table, its `[shell_environment_policy]` parent, AQE's Codex registration, or unrelated.
 *  Other shapes of the shell policy tables are refused, never guessed. */
function shellTableKind(text) {
  const header = /^\s*\[(\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(text);
  if (!header) throw new Error('unsupported TOML header');
  const { segments, rest, complete } = tomlKeySegments(header[2]);
  if (segments[0] === 'mcp_servers' && segments[1] === 'agentic-qe' && segments.length === 2 && !header[1]) return 'registration';
  if (segments[0] !== SHELL) return 'unrelated';
  if (header[1] || !complete || rest !== '' || segments.length > 2 || (segments.length === 2 && segments[1] !== 'set')) {
    throw new Error('unsupported shell environment table encoding preserved');
  }
  return segments.length === 1 ? SHELL : SHELL_SET;
}

/** Outside the set table, an assignment that could define it (`shell_environment_policy.set...`
 *  at the root, `set = {...}` or `set.X` under the parent) is refused. */
function refuseShellAlias(table, text) {
  if (table !== '' && table !== SHELL) return;
  const { segments } = tomlKeySegments(text);
  const keyPath = table === '' ? segments : [SHELL, ...segments];
  if (keyPath[0] === SHELL && (keyPath.length === 1 || keyPath[1] === 'set')) {
    throw new Error('inline or dotted shell environment requires manual configuration');
  }
}

/** B5-D1b: the project Codex config's `[shell_environment_policy.set]` table, which Codex
 *  applies to the commands it runs (hooks included). Present only when that table exists or
 *  AQE's Codex registration (`[mcp_servers.agentic-qe]`) is in the file; a registration
 *  without the table gets a new table at the end. The MCP transport is not consulted: the
 *  shell table does not depend on how the server starts.
 *  @param {string|null} source @param {string[]} keys */
export function shellEnvironmentSet(source, keys) {
  if (source === null) return { missing: true };
  const structure = inspectCodexTomlStructure(source);
  if (!structure.valid) throw new Error('unsupported Codex TOML preserved');
  let table = '';
  let set = null;
  let registration = false;
  /** @type {Record<string, {start: number, end: number, value: string}>} */
  const found = {};
  const seen = new Set();
  for (const line of structure.lines) {
    if (!line.live) continue;
    if (isTomlTableLine(line.text)) {
      table = shellTableKind(line.text);
      if (table === 'registration') registration = true;
      if (table === SHELL || table === SHELL_SET) {
        if (seen.has(table)) throw new Error('duplicate TOML table preserved');
        seen.add(table);
      }
      if (table === SHELL_SET) set = line;
      continue;
    }
    const text = line.text.trim();
    if (!text || text.startsWith('#')) continue;
    if (table !== SHELL_SET) { refuseShellAlias(table, text); continue; }
    // Inside the set table, a dotted or quoted key can alias a managed one: refuse.
    if (!/^[A-Za-z0-9_-]+\s*=/.test(text)) throw new Error('dotted or quoted shell environment keys require manual configuration');
    const key = keys.find((k) => new RegExp(`^${k}\\s*=`).test(text));
    if (!key) continue;
    if (found[key]) throw new Error(`duplicate shell environment ${key}`);
    found[key] = { start: line.start, end: line.end, value: scalar(text, key) };
  }
  if (!set && !registration) return { missing: true };
  const get = (key) => (found[key] ? { present: true, value: found[key].value } : { present: false });
  return { get, render: (nextStates, options) => renderEnv(source, set, found, nextStates, SHELL_SET, options), containerPresent: !!set };
}
