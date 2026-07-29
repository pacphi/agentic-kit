// Managed projection of Codex's built-in, user-scoped status line (ADR-0015).
// This deliberately is not a TOML serializer: only the two owned [tui] keys
// are patched, preserving comments, ordering, unknown fields, and newlines.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

export const PRESETS = Object.freeze({
  native: Object.freeze([
    'model-with-reasoning', 'project-name', 'git-branch', 'run-state',
    'context-remaining', 'five-hour-limit', 'weekly-limit', 'task-progress',
  ]),
  extended: Object.freeze([
    'model-with-reasoning', 'project-name', 'git-branch', 'run-state',
    'context-remaining', 'five-hour-limit', 'weekly-limit', 'task-progress',
    'permissions', 'approval-mode', 'used-tokens', 'fast-mode', 'thread-id', 'codex-version',
  ]),
});

export const projectionFor = (preset) => ({
  status_line_use_colors: true,
  status_line: [...(PRESETS[preset] ?? [])],
});

const arrayText = (items, nl) =>
  `[${nl}${items.map((v) => `  ${JSON.stringify(v)},`).join(nl)}${nl}]`;

function findTable(src) {
  const headers = [...src.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?(?=\r?$)/gm)];
  // TOML quoted table names are semantically equivalent to [tui], but this
  // narrow patcher intentionally does not normalize TOML. Fail closed rather
  // than append a second, equivalent table.
  if (headers.some((m) => /^["']tui["']$/.test(m[1].trim()))) {
    throw new Error('quoted [tui] table is not safely patchable');
  }
  const tui = headers.filter((m) => m[1].trim() === 'tui');
  if (tui.length > 1) throw new Error('duplicate [tui] tables');
  if (!tui.length) return null;
  const start = tui[0].index;
  const bodyStart = start + tui[0][0].length;
  const next = headers.find((m) => m.index > start);
  return { start, bodyStart, end: next?.index ?? src.length };
}

function valueEnd(src, start, limit) {
  let square = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const c = src[i];
    if (quote) {
      if (escape) escape = false;
      else if (c === '\\' && quote === '"') escape = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') {
      while (i < limit && src[i] !== '\n') i++;
      if (square === 0) return i;
      continue;
    }
    if (c === '[') square++;
    else if (c === ']') square--;
    if (square < 0) throw new Error('invalid status_line array');
    if ((c === '\n' || c === '\r') && square === 0) return i;
  }
  if (square !== 0 || quote) throw new Error('unterminated value in [tui]');
  return limit;
}

function keySpans(src, table) {
  if (!table) return new Map();
  const body = src.slice(table.bodyStart, table.end);
  if (/^[ \t]*["'](?:status_line_use_colors|status_line)["'][ \t]*=/m.test(body)) {
    throw new Error('quoted managed keys in [tui] are not safely patchable');
  }
  const found = new Map();
  const re = /^[ \t]*(status_line_use_colors|status_line)[ \t]*=/gm;
  for (const m of body.matchAll(re)) {
    const key = m[1];
    if (found.has(key)) throw new Error(`duplicate ${key} in [tui]`);
    const start = table.bodyStart + m.index;
    const eq = start + m[0].lastIndexOf('=');
    let end = valueEnd(src, eq + 1, table.end);
    if (src[end] === '\r' && src[end + 1] === '\n') end += 2;
    else if (src[end] === '\r' || src[end] === '\n') end++;
    found.set(key, { start, end, raw: src.slice(eq + 1, end).trim() });
  }
  return found;
}

function parseValues(spans) {
  const colorsRaw = spans.get('status_line_use_colors')?.raw?.replace(/#.*$/s, '').trim();
  let colors = null;
  if (colorsRaw != null) {
    if (!/^(true|false)$/.test(colorsRaw)) throw new Error('status_line_use_colors must be boolean');
    colors = colorsRaw === 'true';
  }
  let items = null;
  const raw = spans.get('status_line')?.raw;
  if (raw != null) {
    let withoutComments = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        withoutComments += c;
        if (escape) escape = false;
        else if (c === '\\' && quote === '"') escape = true;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
        withoutComments += c;
      } else if (c === '#') {
        while (i + 1 < raw.length && raw[i + 1] !== '\n' && raw[i + 1] !== '\r') i++;
      } else {
        withoutComments += c;
      }
    }
    try { items = JSON.parse(withoutComments.replace(/,\s*\]$/, ']')); }
    catch { throw new Error('status_line must be an array of strings'); }
    if (!Array.isArray(items) || items.some((v) => typeof v !== 'string')) {
      throw new Error('status_line must be an array of strings');
    }
  }
  return { status_line_use_colors: colors, status_line: items };
}

export function inspectCodexStatusline(file = paths.codexConfigPath()) {
  if (!fs.existsSync(file)) return { file, exists: false, valid: true, values: { status_line_use_colors: null, status_line: null } };
  try {
    const source = fs.readFileSync(file, 'utf8');
    if (/^[ \t]*tui[ \t]*\.[ \t]*(?:status_line_use_colors|status_line)[ \t]*=/m.test(source)) {
      throw new Error('dotted tui status-line keys are not safely patchable');
    }
    const table = findTable(source);
    const spans = keySpans(source, table);
    return { file, exists: true, valid: true, values: parseValues(spans) };
  } catch (error) {
    return { file, exists: true, valid: false, error: error.message };
  }
}

export function statuslineDrift(cfg, file = paths.codexConfigPath()) {
  const owned = cfg.statusline?.codex?.preset;
  const current = inspectCodexStatusline(file);
  if (!owned) return { owned: false, current, drifted: false };
  const expected = projectionFor(owned);
  const drifted = !current.valid
    || current.values.status_line_use_colors !== expected.status_line_use_colors
    || JSON.stringify(current.values.status_line) !== JSON.stringify(expected.status_line);
  return { owned: true, preset: owned, expected, current, drifted };
}

function writeAtomic(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${Date.now()}`);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp); } catch {}
    throw error;
  }
}

export function applyCodexStatusline(preset, file = paths.codexConfigPath()) {
  if (!PRESETS[preset]) throw new Error(`unknown Codex status-line preset: ${preset}`);
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^[ \t]*tui[ \t]*\.[ \t]*(?:status_line_use_colors|status_line)[ \t]*=/m.test(source)) {
    throw new Error('dotted tui status-line keys are not safely patchable');
  }
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  let table = findTable(source);
  let next = source;
  if (!table) {
    const join = source && !source.endsWith('\n') && !source.endsWith('\r') ? nl : '';
    next += `${join}${source ? nl : ''}[tui]${nl}`;
    table = findTable(next);
  }
  const spans = keySpans(next, table);
  const projection = projectionFor(preset);
  const values = {
    status_line_use_colors: 'true',
    status_line: arrayText(projection.status_line, nl),
  };
  // Replace from bottom to top so offsets remain stable.
  for (const key of ['status_line', 'status_line_use_colors']) {
    const span = spans.get(key);
    if (span) next = next.slice(0, span.start) + `${key} = ${values[key]}${nl}` + next.slice(span.end);
  }
  const missing = ['status_line_use_colors', 'status_line'].filter((key) => !spans.has(key));
  if (missing.length) {
    table = findTable(next);
    const insertion = missing.map((key) => `${key} = ${values[key]}${nl}`).join('');
    next = next.slice(0, table.bodyStart) + nl + insertion + next.slice(table.bodyStart).replace(/^\r?\n/, '');
  }
  if (next === source) return { changed: false, file, projection };
  writeAtomic(file, next);
  return { changed: true, file, projection };
}

export function removeCodexStatusline(lastProjection, file = paths.codexConfigPath()) {
  if (!lastProjection || !fs.existsSync(file)) return { changed: false, file };
  const source = fs.readFileSync(file, 'utf8');
  const table = findTable(source);
  const spans = keySpans(source, table);
  const current = parseValues(spans);
  const removable = [];
  if (current.status_line_use_colors === lastProjection.status_line_use_colors) removable.push(spans.get('status_line_use_colors'));
  if (JSON.stringify(current.status_line) === JSON.stringify(lastProjection.status_line)) removable.push(spans.get('status_line'));
  let next = source;
  for (const span of removable.filter(Boolean).sort((a, b) => b.start - a.start)) {
    next = next.slice(0, span.start) + next.slice(span.end);
  }
  if (next === source) return { changed: false, file };
  writeAtomic(file, next);
  return { changed: true, file };
}
