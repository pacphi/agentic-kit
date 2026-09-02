import { readBoundedFile } from './common.mjs';

function unquote(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function scalar(value) {
  const trimmed = value.trim();
  const string = unquote(trimmed);
  if (string !== null) return { ok: true, value: string };
  if (/^(?:true|false)$/.test(trimmed)) return { ok: true, value: trimmed === 'true' };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { ok: true, value: JSON.parse(trimmed) }; } catch { /* TOML inline tables are deliberately unsupported */ }
  }
  return { ok: false, value: null };
}

function applyHookHeader(raw, state) {
  const match = /^\[\[hooks\.([A-Za-z][A-Za-z0-9]*)(\.hooks)?\]\]$/.exec(raw);
  if (!match) return false;
  const [, event, handlerTable] = match;
  state.sawHookTable = true;
  state.document.hooks[event] ??= [];
  if (!handlerTable) {
    state.currentGroup = { hooks: [] };
    state.document.hooks[event].push(state.currentGroup);
    state.currentHook = null;
    state.currentEvent = event;
    state.table = 'group';
    return true;
  }
  if (!state.currentGroup || state.currentEvent !== event) {
    state.currentGroup = { hooks: [] };
    state.document.hooks[event].push(state.currentGroup);
  }
  state.currentHook = {};
  state.currentGroup.hooks.push(state.currentHook);
  state.currentEvent = event;
  state.table = 'hook';
  return true;
}

function applyOrdinaryHeader(raw, state) {
  const match = /^\[([^\]]+)\]$/.exec(raw);
  if (!match) return false;
  state.table = match[1] === 'features' ? 'features' : match[1] === 'hooks' ? 'hooks-meta' : null;
  state.currentGroup = null;
  state.currentHook = null;
  state.currentEvent = null;
  return true;
}

function applyAssignment(raw, lineIndex, state) {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(raw);
  if (!assignment) {
    if (state.table === 'group' || state.table === 'hook') {
      state.errors.push(`line ${lineIndex + 1}: unsupported inline hook syntax`);
    }
    return;
  }
  const parsed = scalar(assignment[2]);
  if (!parsed.ok) {
    if (state.table === 'group' || state.table === 'hook') {
      state.errors.push(`line ${lineIndex + 1}: unsupported inline hook value`);
    }
    return;
  }
  const key = assignment[1] === 'command_windows' ? 'commandWindows' : assignment[1];
  if (state.table === 'group') state.currentGroup[key] = parsed.value;
  else if (state.table === 'hook') state.currentHook[key] = parsed.value;
  else if (state.table === 'features' && (key === 'hooks' || key === 'codex_hooks')) state.features.hooks = parsed.value;
  else if (state.table === null && key === 'allow_managed_hooks_only') state.features.allowManagedHooksOnly = parsed.value;
}

/** Parse only Codex's documented inline hook tables; never pretend to parse arbitrary TOML. */
/** @returns {any} */
export function readCodexInlineHooks(file, containmentRoot, metadata = {}) {
  const read = readBoundedFile(file, containmentRoot);
  if (read.status === 'absent') return null;
  if (read.status !== 'valid') return { ...metadata, file, ...read };
  const state = {
    document: { hooks: {} }, features: {}, table: null,
    currentGroup: null, currentHook: null, currentEvent: null,
    sawHookTable: false, errors: [],
  };
  const lines = read.text.replaceAll('\r\n', '\n').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (applyHookHeader(raw, state) || applyOrdinaryHeader(raw, state)) continue;
    applyAssignment(raw, lineIndex, state);
  }
  if (!state.sawHookTable && Object.keys(state.features).length === 0) return null;
  if (state.errors.length) return { ...metadata, file, status: 'invalid', digest: read.digest, error: state.errors.join('; ') };
  return { ...metadata, file, status: 'valid', digest: read.digest, document: state.document, features: state.features };
}
