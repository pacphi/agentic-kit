// Bounded metadata inspection for import-marked heads. No content is retained.
import { newCodexTurnOwnership, codexTurnOwner } from '../codex-import-marker.mjs';
import { codexReplayPlan, isCodexReplayLine } from '../codex-replay.mjs';

export const IMPORT_TAIL_BYTES = 2 * 1024 * 1024;
export const IMPORT_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_RECORDS = 20_000;

function recordsIn(buffer, { dropFirst, dropLast }) {
  const lines = buffer.toString('utf8').split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const records = [];
  let complete = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (records.length >= MAX_RECORDS) { complete = false; break; }
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid envelope');
      records.push(record);
    } catch { complete = false; records.push(null); }
  }
  return { records, complete };
}

/** Read at most headBytes + 2 MiB per candidate, within a shared scan budget.
 * Missing middle bytes reset ownership; adjacency never spans an unread gap.
 * A mixed result proves some native activity, not that every turn was seen. */
export function inspectCodexImport(file, { fsImpl, headBytes, budget }) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(fd).size;
    const total = Math.min(size, headBytes + IMPORT_TAIL_BYTES);
    if (budget.remaining < total) return { kind: 'unresolved' };
    budget.remaining -= total;
    const contiguous = size <= total;
    const windows = contiguous ? [[0, size]] : [[0, headBytes], [size - IMPORT_TAIL_BYTES, IMPORT_TAIL_BYTES]];
    const groups = [];
    let complete = contiguous;
    for (const [offset, length] of windows) {
      const b = Buffer.alloc(length);
      const n = fsImpl.readSync(fd, b, 0, length, offset);
      const group = recordsIn(b.subarray(0, n), { dropFirst: offset > 0, dropLast: offset + n < size });
      complete = complete && n === length && group.complete;
      groups.push(group.records);
    }
    return classifyWindows(groups, complete);
  } catch { return { kind: 'unresolved' }; }
  finally { if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* failed observation */ } } }
}

function classifyWindows(groups, complete) {
  const first = groups[0].find((r) => r?.type === 'session_meta');
  // A sampled subagent replay boundary cannot safely use the fallback that
  // depends on absence of an addressed parent message in the entire file.
  if (!complete && first?.payload?.thread_source === 'subagent') return { kind: 'unresolved' };
  const replay = codexReplayPlan(groups.flat());
  if (replay.unprovable) return { kind: 'unresolved' };
  let state = newCodexTurnOwnership();
  let genuine = false;
  let ambiguous = false;
  let cwd = null;
  for (const [index, records] of groups.entries()) {
    if (index) state = newCodexTurnOwnership();
    for (const record of records) {
      if (record === null) return { kind: 'unresolved', complete: false };
      const before = state.nativeRecords;
      const owner = codexTurnOwner(state, record);
      if (!state.ownershipComplete) return { kind: 'unresolved', complete: false };
      if (owner !== 'native' || isCodexReplayLine(replay.boundary, record)) continue;
      if (record?.type === 'turn_context' && !cwd && typeof record.payload?.cwd === 'string') cwd = record.payload.cwd;
      if (state.nativeRecords > before) genuine = true;
    }
    ambiguous ||= state.ambiguousRecords > 0;
  }
  return genuine ? { kind: 'mixed', cwd, complete }
    : { kind: complete && !ambiguous ? 'imported' : 'unresolved', complete };
}
