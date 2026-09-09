// Narrow top-level scalar projection; never parse instruction strings as config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectCodexTomlStructure, isTomlTableLine } from './codex-toml-safety.mjs';

export const WINDOW_KEY = 'model_context_window';
export const positiveTokens = value => Number.isSafeInteger(value) && value > 0;

export function contextHome(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(home)) throw new Error('CODEX_HOME must be absolute');
  return path.resolve(home);
}

export function readContextConfig(source) {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error('Codex config exceeds inspection bound');
  const structure = inspectCodexTomlStructure(source);
  if (!structure.valid) throw new Error(structure.error);
  const result = { window: null, autoCompact: null, model: null, provider: null, catalog: null, reasoningEffort: null, span: null, source };
  const seen = new Set();
  const keys = { model_context_window: 'window', model_auto_compact_token_limit: 'autoCompact',
    model_reasoning_effort: 'reasoningEffort', model: 'model', model_provider: 'provider', model_catalog_json: 'catalog' };
  for (const line of structure.lines) {
    if (!line.live) continue;
    if (isTomlTableLine(line.text)) break;
    const match = /^\s*([^=]+?)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line.text);
    if (!match) continue;
    const key = match[1].trim();
    if (/^["'](?:model_context_window|model_auto_compact_token_limit|model|model_provider|model_catalog_json)["']$/.test(key)) {
      throw new Error('quoted context configuration keys are not safely patchable');
    }
    if (!Object.hasOwn(keys, key)) continue;
    if (seen.has(key)) throw new Error(`duplicate ${key}`);
    seen.add(key);
    const field = keys[key];
    if (field === 'window' || field === 'autoCompact') {
      if (!/^[+]?[1-9](?:_?\d)*$/.test(match[2])) throw new Error(`invalid ${key}`);
      const value = Number(match[2].replaceAll('_', ''));
      if (!positiveTokens(value)) throw new Error(`invalid ${key}`);
      result[field] = value;
      if (field === 'window') result.span = line;
    } else {
      const string = /^(?:"([^"\\]*)"|'([^']*)')$/.exec(match[2]);
      if (!string) throw new Error(`unsupported ${key} value`);
      result[field] = string[1] ?? string[2];
    }
  }
  return result;
}

export function replaceContextWindow(parsed, value, originalLine) {
  const nl = parsed.source.includes('\r\n') ? '\r\n' : '\n';
  let line = originalLine !== undefined ? originalLine ?? '' : `${WINDOW_KEY} = ${value}${nl}`;
  const span = parsed.span;
  if (line && !line.endsWith('\n') && (span ? span.end < parsed.source.length : parsed.source.length > 0)) line += nl;
  return span ? parsed.source.slice(0, span.start) + line + parsed.source.slice(span.end)
    : line + parsed.source;
}

export function writeContextConfig(file, before, after) {
  if (before === after) return { changed: false };
  if (fs.readFileSync(file, 'utf8') !== before) throw new Error('Codex config changed during planning; retry');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('symlinked Codex config is not safely patchable');
  const stat = fs.statSync(file);
  const backup = `${file}.ak-context-backup.${randomUUID()}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const tmp = `${file}.ak-context-tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, after, { flag: 'wx', mode: stat.mode & 0o777 });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('Codex config changed before write; retry');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return { changed: true, backup };
}

export function validateCodexContextIntent(intent) {
  if (intent == null) return;
  if (intent.mode !== 'max' || !path.isAbsolute(intent.file ?? '')
    || path.basename(intent.file) !== 'config.toml'
    || !(positiveTokens(intent.lastProjection) || (intent.lastProjection === null && positiveTokens(intent.pendingProjection)))
    || !(intent.pendingProjection == null || positiveTokens(intent.pendingProjection))
    || !(intent.originalLine === null || typeof intent.originalLine === 'string')
    || typeof intent.clientVersion !== 'string' || typeof intent.cacheSha256 !== 'string') {
    throw new TypeError('invalid codexContext ownership receipt');
  }
  if (intent.originalLine !== null) {
    const parsed = readContextConfig(intent.originalLine);
    if (!parsed.span || parsed.span.start !== 0 || parsed.span.end !== intent.originalLine.length) {
      throw new TypeError('invalid codexContext original scalar');
    }
  }
}
