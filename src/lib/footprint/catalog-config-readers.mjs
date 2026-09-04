import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { measured, statNode } from './walk.mjs';

const emptyReading = (status, reason) => ({
  status, reason, names: [], entries: [], partial: false, truncated: false,
});

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

const configDigest = (value) => measured(createHash('sha256')
  .update(JSON.stringify(canonical(value)) ?? 'null').digest('hex'));

/** Keys of one object inside a JSON manifest, with value-only fingerprints. */
export function readManifestKeys(file, pick, { fsImpl = fs } = {}) {
  const head = statNode(file, { fsImpl });
  if (head.status === 'unknown') {
    return emptyReading(head.reason === 'ENOENT' ? 'absent' : 'degraded', head.reason);
  }
  let doc;
  try { doc = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch { return emptyReading('degraded', 'EPARSE'); }
  const bag = pick(doc);
  if (!bag || typeof bag !== 'object') return { ...emptyReading('ok', null), names: [] };
  const names = Object.keys(bag);
  return {
    status: 'ok', reason: null, names,
    entries: names.map((name) => ({
      name, itemPath: file, sourceFile: file, digest: configDigest(bag[name]),
      definition: configDigest(bag[name]), artifactFiles: [file],
    })),
    partial: false, truncated: false,
  };
}

/** TOML table names under `section`, exported for tests. */
export function tomlTableNames(source, section) {
  const names = [];
  const re = new RegExp(
    `^\\[\\s*${section}\\s*\\.\\s*(?:"((?:[^"\\\\]|\\\\.)+)"|'([^']+)'|([A-Za-z0-9_.\\-]+))\\s*\\]\\s*$`,
    'gm',
  );
  let match;
  while ((match = re.exec(source)) !== null) {
    const quoted = match[1];
    names.push(quoted ? quoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : (match[2] ?? match[3]));
  }
  return names;
}

/** Fingerprint one bounded Codex MCP base table plus its child tables. */
export function readTomlTables(file, section, { fsImpl = fs } = {}) {
  let source;
  try { source = fsImpl.readFileSync(file, 'utf8'); } catch (error) {
    return emptyReading(error.code === 'ENOENT' ? 'absent' : 'degraded', error.code ?? 'io');
  }
  const names = tomlTableNames(source, section);
  const headers = [...source.matchAll(/^[ \t]*\[(?!\[)([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
  const digestFor = (name) => {
    const quoted = `${section}."${name.replace(/"/g, '\\"')}"`;
    const bare = `${section}.${name}`;
    const blocks = headers.flatMap((header, index) => {
      const table = header[1].trim();
      const isBase = table === bare || table === quoted;
      const isChild = table.startsWith(`${bare}.`) || table.startsWith(`${quoted}.`);
      if (!isBase && !isChild) return [];
      const body = source.slice(header.index + header[0].length, headers[index + 1]?.index ?? source.length);
      const suffix = isBase ? '' : table.slice((table.startsWith(quoted) ? quoted : bare).length);
      const lines = body.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')).sort();
      return [{ suffix, lines }];
    }).sort((a, b) => a.suffix.localeCompare(b.suffix));
    return configDigest(blocks);
  };
  return {
    status: 'ok', reason: null, names,
    entries: names.map((name) => ({
      name, itemPath: file, sourceFile: file, digest: digestFor(name),
      definition: digestFor(name), artifactFiles: [file],
    })),
    partial: false, truncated: false,
  };
}
