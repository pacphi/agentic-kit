// The one place that knows how an imported Codex rollout is marked.
//
// Codex (the ChatGPT desktop app's "Import from another agent") can copy a
// Claude Code transcript in as a thread. The host stamps such a rollout's turns
// `external-import-turn-N` (measured 2026-09-19: 796 imports, every one carrying
// it from its first task_started, none of a native thread; 2026-09-27: 924 of
// 924 on the rollout's second line). The in-rollout marker is the signal: the
// host's imports file is deliberately not read, so detection works without it.
// Usage parsing, usage origin and project discovery all use these predicates
// (ADR-0052 §3, ADR-0060 §3). Leaf module: imports nothing, so any of them can
// use it without an import cycle.

export const CODEX_IMPORT_TURN_PREFIX = 'external-import-turn';

/** One decoded rollout record: does it explicitly belong to an imported turn? Only a
 *  string `payload.turn_id` counts; the marker text inside a message does not. */
export function isCodexImportedLine(e) {
  const turnId = e?.payload?.turn_id;
  return typeof turnId === 'string' && turnId.startsWith(CODEX_IMPORT_TURN_PREFIX);
}

/** Does a bounded head contain an imported turn? This does not prove the
 * whole rollout is imported-only; later native turns require a separate scan.
 *  A line without the marker text is not parsed, which keeps this cheap on the
 *  large native heads; unparseable and non-string lines are skipped. */
export function isImportedCodexRollout(headLines) {
  for (const line of headLines ?? []) {
    if (typeof line !== 'string' || !line.includes(CODEX_IMPORT_TURN_PREFIX)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (isCodexImportedLine(record)) return true;
  }
  return false;
}

/** Stateful per-turn ownership. Explicit turn metadata outranks adjacency;
 * a foreign completion never closes the active turn. Missing IDs in a mixed
 * file cannot open a native turn. No IDs or payloads escape the state. */
export function newCodexTurnOwnership({ hasImports = true } = {}) {
  return { hasImports, ownershipComplete: true, activeId: null, activeOwner: hasImports ? 'ambiguous' : 'native',
    importedIds: new Set(), importedTurnCountComplete: true, importedRecords: 0, ambiguousRecords: 0, nativeRecords: 0 };
}

const validTurnId = (id) => typeof id === 'string' && id.length > 0
  && id.length <= 256 && !/\s/u.test(id);

function noteBoundary(state, p, imported) {
  // Absence can mean an enriching context. An explicitly invalid declaration
  // cannot preserve adjacency to the prior native turn in a mixed source.
  if (state.hasImports && Object.hasOwn(p, 'turn_id') && !validTurnId(p.turn_id)) {
    state.activeId = null;
    state.activeOwner = 'ambiguous';
    state.ownershipComplete = false;
    return;
  }
  if (!validTurnId(p.turn_id) && p.type !== 'task_started') return;
  state.activeId = validTurnId(p.turn_id) ? p.turn_id : null;
  state.activeOwner = imported ? 'imported' : state.activeId ? 'native'
    : state.hasImports ? 'ambiguous' : 'native';
}

function endsActiveTurn(record, p, activeId) {
  return record?.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)
    && validTurnId(p.turn_id) && p.turn_id === activeId;
}

function noteImportedId(state, id) {
  if (state.importedIds.has(id)) return;
  if (validTurnId(id) && state.importedIds.size < 4096) state.importedIds.add(id);
  else state.importedTurnCountComplete = false;
}

export function codexTurnOwner(state, record) {
  const p = record?.payload ?? {};
  const id = p.turn_id;
  const imported = isCodexImportedLine(record);
  const boundary = record?.type === 'turn_context'
    || (record?.type === 'event_msg' && p.type === 'task_started');
  // An ID-less context enriches an identified turn but cannot open one.
  if (boundary) noteBoundary(state, p, imported);
  let owner = imported ? 'imported' : state.activeOwner;
  if (state.hasImports && id !== undefined && (!validTurnId(id) || id !== state.activeId) && !imported) owner = 'ambiguous';
  if (imported) { noteImportedId(state, id); state.importedRecords++; }
  else if (owner === 'imported') state.importedRecords++;
  else if (owner === 'ambiguous' && record?.type !== 'session_meta') state.ambiguousRecords++;
  if (owner === 'native' && record?.type === 'event_msg'
    && ['user_message', 'agent_message', 'item_completed', 'token_count'].includes(p.type)) state.nativeRecords++;
  if (endsActiveTurn(record, p, state.activeId)) {
    state.activeId = null;
    state.activeOwner = state.hasImports ? 'ambiguous' : 'native';
  }
  return owner;
}

/** Only enumerated counts are persisted; turn IDs remain local to the walk. */
export function codexImportEvidence(state) {
  return { importedTurns: state.importedIds.size, importedTurnCountComplete: state.importedTurnCountComplete,
    importedRecords: state.importedRecords,
    ambiguousRecords: state.ambiguousRecords, nativeRecords: state.nativeRecords };
}
