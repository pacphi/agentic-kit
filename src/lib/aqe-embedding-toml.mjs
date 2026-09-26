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

export function aqeTomlEnvironment(source) {
  if (source === null) return { missing: true };
  const structure = inspectCodexTomlStructure(source);
  if (!structure.valid) throw new Error('unsupported Codex TOML preserved');
  let table = '';
  let base = null;
  let env = null;
  let endpoint = null;
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
    if (table === ENV && new RegExp(`^${KEY}\\s*=`).test(text)) {
      if (endpoint) throw new Error('duplicate AQE endpoint');
      endpoint = { ...line, value: scalar(text, KEY) };
    }
  }
  if (!base) return { missing: true };
  if (!recognizedAqeTransport(transport.command, transport.args ?? [])) throw new Error('unrecognized AQE MCP transport preserved');
  return { current: endpoint ? { present: true, value: endpoint.value } : { present: false }, replace(next) {
    const nl = source.includes('\r\n') ? '\r\n' : '\n';
    const replacement = next.present ? `${KEY} = ${JSON.stringify(next.value)}${nl}` : '';
    if (endpoint) return source.slice(0, endpoint.start) + replacement + source.slice(endpoint.end);
    if (!next.present) return source;
    if (env) return source.slice(0, env.end) + (env.text.endsWith('\n') || source[env.end - 1] === '\n' ? '' : nl) + replacement + source.slice(env.end);
    return source + (source.endsWith('\n') ? nl : nl + nl) + `[${ENV}]${nl}${replacement}`;
  } };
}
