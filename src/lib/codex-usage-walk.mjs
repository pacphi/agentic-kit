// codex-usage-walk.mjs — attributing a Codex rollout's cumulative token_count
// snapshots to the day and model that actually spent them (ADR-0052).
//
// `total_token_usage` is CUMULATIVE. The parser used to keep only the LAST one
// and book the whole session on the last event's day under the last model.
// Two measured defects made that wrong:
//   - the cumulative counter restarts from zero mid-file (48 restarts across 33
//     files on the audited machine; after each one the snapshot equals its own
//     `last_token_usage`, i.e. the counter began again), so last-wins silently
//     dropped every segment before the restart (~350M tokens);
//   - a multi-day / multi-model session put all its tokens on one day and one
//     model (42 sessions holding 37.8% of Codex tokens spanned several days; 23
//     used more than one model), skewing the by-day and by-model views and the
//     price applied.
//
// So the walk turns each snapshot into a DELTA against the previous one and
// books the delta where the event happened: on the event's local day, under the
// model of the turn_context in effect. A snapshot that is lower than its
// predecessor in any monotonic field starts a new SEGMENT (its delta is the
// whole snapshot), which is exactly "sum the final total of each segment". For a
// single-day, single-model, reset-free session the deltas sum to the last total
// — identical to the old figure.
//
// Replayed snapshots (a forked subagent's copy of its parent's history) advance
// the running total but book nothing: only what the thread itself spent counts.
//
// Pure: no I/O, no clock beyond what the caller passes in.

const FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const ZERO = Object.freeze({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
/** Fields whose decrease means the counter restarted. Reasoning is a subset of
 *  output and is excluded so it cannot start a segment by itself. */
const MONOTONIC = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'];

const snapshotOf = (t) => Object.fromEntries(FIELDS.map((f) => [f, Number(t?.[f]) || 0]));

/**
 * @typedef {object} CodexUsageWalk
 * @property {boolean} unattributable
 * @property {Record<string, number>|null} prev
 * @property {string|null} model
 * @property {number|null} lastMs
 * @property {Map<string, any>} buckets
 * @property {Map<string, any>} responses
 * @property {number} segments
 */

/** Fresh walk state. `unattributable` (a subagent whose replay cannot be
 *  separated) makes the walk book nothing.
 *  @returns {CodexUsageWalk} */
export function newCodexUsageWalk({ unattributable = false } = {}) {
  return {
    unattributable,
    prev: null,        // the previous cumulative snapshot, replayed ones included
    model: null,       // the model of the turn_context in effect
    lastMs: null,      // the last finite event time seen on a token_count
    buckets: new Map(), // `${day}\0${model}` → { day, model, gross, cached, output, reasoning }
    responses: new Map(), // same key → assistant messages booked there
    segments: 0,        // counter restarts seen (diagnostic only)
  };
}

/** The model of the turn_context now in effect. */
export function noteCodexWalkModel(walk, model) {
  if (typeof model === 'string' && model) walk.model = model;
}

const keyOf = (day, model) => `${day ?? ''}\0${model ?? ''}`;

/** The (day, model) an event at `ms` books under. `null` parts are resolved at
 *  finalize, once the session's first model and end time are known. */
function bookingKey(walk, ms, dayOf) {
  const at = Number.isFinite(ms) ? ms : walk.lastMs;
  return { day: at === null ? null : dayOf(at), model: walk.model };
}

function bucketFor(map, day, model, make) {
  const k = keyOf(day, model);
  let b = map.get(k);
  if (!b) { b = make(day, model); map.set(k, b); }
  return b;
}

/** Book one assistant message on the day/model it happened in, so per-model
 *  response counts follow the same attribution as tokens. */
export function noteCodexWalkResponse(walk, ms, dayOf) {
  const { day, model } = bookingKey(walk, ms, dayOf);
  const b = bucketFor(walk.responses, day, model, (d, m) => ({ day: d, model: m, n: 0 }));
  b.n++;
}

/**
 * Fold one cumulative snapshot into the walk. A REPLAYED snapshot only advances
 * the running total; an own one books its delta on `ms`'s day under the current
 * model.
 */
export function walkCodexTokenCount(walk, total, ms, replay, dayOf) {
  if (!total) return;
  const cur = snapshotOf(total);
  const prev = walk.prev;
  walk.prev = cur;
  if (Number.isFinite(ms)) walk.lastMs = ms;
  const restarted = prev !== null && MONOTONIC.some((f) => cur[f] < prev[f]);
  if (restarted) walk.segments++;
  if (replay || walk.unattributable) return;
  const base = prev === null || restarted ? ZERO : prev;
  const d = Object.fromEntries(FIELDS.map((f) => [f, Math.max(0, cur[f] - base[f])]));
  if (!d.input_tokens && !d.output_tokens && !d.cached_input_tokens) return;
  const { day, model } = bookingKey(walk, ms, dayOf);
  const b = bucketFor(walk.buckets, day, model, (dd, m) => ({ day: dd, model: m, gross: 0, cached: 0, output: 0, reasoning: 0 }));
  b.gross += d.input_tokens; b.cached += d.cached_input_tokens;
  b.output += d.output_tokens; b.reasoning += d.reasoning_output_tokens;
}

/**
 * The usage rows a finished walk yields, plus the reasoning detail.
 *
 * Unresolved parts fall back the way the single-bucket parser did: a booking
 * with no model yet takes the session's FIRST model (a token_count that
 * precedes the first turn_context), else 'unknown'; one with no usable time
 * takes the session's end/start. Responses join the row of their own
 * (day, model); any that match no token row go to the last row so a session's
 * rows always sum to its `responses` (byModel response counts rely on it).
 *
 * @param {CodexUsageWalk} walk
 * @param {{ models: string[], fallbackMs: number, dayOf: (ms:number)=>string }} ctx
 * @returns {{ rows: Array<{day:string,model:string,input:number,output:number,cacheRead:number,cacheWrite:number,responses:number}>, reasoningOutput: number }}
 */
export function codexWalkRows(walk, { models, fallbackMs, dayOf }) {
  const firstModel = models[0] ?? 'unknown';
  const resolve = (b) => ({ day: b.day ?? dayOf(fallbackMs), model: b.model ?? firstModel });
  const rows = new Map();
  let reasoningOutput = 0;
  for (const b of walk.buckets.values()) {
    const { day, model } = resolve(b);
    const k = keyOf(day, model);
    const row = rows.get(k) ?? { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 };
    row.input += Math.max(0, b.gross - b.cached);
    row.output += b.output;
    row.cacheRead += b.cached;
    reasoningOutput += b.reasoning;
    rows.set(k, row);
  }
  const list = [...rows.values()];
  if (!list.length) return { rows: list, reasoningOutput };
  for (const r of walk.responses.values()) {
    const { day, model } = resolve(r);
    const home = rows.get(keyOf(day, model)) ?? list[list.length - 1];
    home.responses += r.n;
  }
  return { rows: list, reasoningOutput };
}
