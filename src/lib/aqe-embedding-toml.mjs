// Deliberately narrow TOML editor: unsupported encodings remain user-owned.
import { inspectCodexTomlStructure, isTomlTableLine } from './codex-toml-safety.mjs';
import { recognizedAqeTransport, parseEmbeddingJson } from './aqe-embedding-transport.mjs';
const BASE = 'mcp_servers.agentic-qe';
const ENV = `${BASE}.env`;
const KEY = 'AQE_EMBEDDER_ENDPOINT';

// Parse table key segments, preserving dots inside quoted project/server names.
function tableKind(text) {
  const header = /^\s*\[(\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(text);
  if (!header) throw new Error('unsupported TOML header');
  const tokens = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/gy;
  const segments = [];
  let token;
  while ((token = tokens.exec(header[2]))) {
    const raw = token[1];
    segments.push(raw.startsWith('"') ? parseEmbeddingJson(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw);
    if (tokens.lastIndex === header[2].length) break;
  }
  if (segments[0] !== 'mcp_servers') return 'unrelated';
  if (header[1] || tokens.lastIndex !== header[2].length) throw new Error('unsupported AQE table encoding');
  if (segments.length === 1) return 'mcp_servers';
  if (segments[1] !== 'agentic-qe') return 'unrelated';
  if (segments.length === 2) return BASE;
  if (segments.length === 3 && segments[2] === 'env') return ENV;
  return 'unrelated';
}

function scalar(text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`).exec(text);
  if (!match) throw new Error(`unsupported AQE ${key} encoding`);
  return parseEmbeddingJson(match[1]);
}

function transportAssignment(text, transport) {
  if (/^env\s*=/.test(text)) throw new Error('inline AQE environment requires manual embedding configuration');
  if (/^command\s*=/.test(text)) {
    if (transport.command !== null) throw new Error('duplicate AQE command');
    transport.command = scalar(text, 'command');
  }
  if (/^args\s*=/.test(text)) {
    if (transport.args !== null) throw new Error('duplicate AQE arguments');
    const match = /^args\s*=\s*(\[[^\n]*\])\s*(?:#.*)?$/.exec(text);
    if (!match) throw new Error('unsupported AQE arguments encoding');
    transport.args = parseEmbeddingJson(match[1]);
    if (!Array.isArray(transport.args)) throw new Error('unsupported AQE arguments shape');
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
    // Dotted/quoted keys can alias a managed table: refuse rather than guessing.
    if (!/^[A-Za-z0-9_-]+\s*=/.test(text)) throw new Error('dotted or quoted TOML assignments require manual embedding configuration');
    if (table === BASE) transportAssignment(text, transport);
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
