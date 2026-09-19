// codex-replay.mjs — where a forked Codex subagent's OWN history begins (ADR-0052).
//
// A subagent forked from its parent (`thread_spawn` with context) opens its
// rollout by REPLAYING the parent's prior history: the parent's messages, tool
// runs, `session_meta` line and cumulative `token_count` snapshots, then the
// child's own turns. Counting the replay as the child's activity double-counts
// the parent (ccusage#950); dropping the whole child, as the parser once did,
// hides the child's own spend (~40% of all Codex tokens on the audited machine).
//
// Every envelope carries an `ordinal`, and the child's `session_meta` carries
// `subagent_history_start_ordinal`. Measured on a real corpus of 409 subagent
// rollouts (each boundary cross-checked against the parent rollout's own
// cumulative snapshots):
//   - 176 files: the ordinal is the true boundary — events below it are replay.
//   - 132 files: the host wrote the FILE LENGTH there (no event has an ordinal
//     at or above it), so read literally it would call the whole file replay
//     and zero the child's ~440M own tokens. For 122 of those the child's own
//     first turn is triggered by the parent's message addressed to it: a
//     `response_item` `agent_message` whose `recipient` is the child's
//     `agent_path`. The ordinal of that message bounds the replay instead. The
//     other 10 are guardian reviews with no such message and no replay.
//   - ~100 files with no `subagent_history_start_ordinal` (unforked): the file
//     replays nothing and every event is the child's own.
// The two rules agreed on every file where both applied.
//
// Pure: takes a re-iterable of parsed rollout objects, reads only what it needs
// (one line for a non-subagent, and it stops as soon as the ordinal is proven
// in range), never throws.

/** Is this envelope the parent's message addressed to `path`? */
function isMessageToThread(e, path) {
  const p = e?.payload;
  return e?.type === 'response_item' && p?.type === 'agent_message' && p.recipient === path;
}

/**
 * Where a subagent rollout's replayed parent history ends.
 *
 *   `boundary`   the ordinal below which events are replayed parent history, or
 *                `null` when the file replays nothing (not a subagent, or an
 *                unforked/guardian one with no history-start ordinal).
 *   `unprovable` a subagent rollout whose envelopes carry NO ordinal at all (a
 *                pre-ordinal host): its replay cannot be told from its own
 *                turns, so its cumulative usage cannot be attributed and the
 *                caller must not count it — the conservative behaviour this
 *                parser always had for a subagent (double-counting the parent
 *                by up to 91x is the failure being avoided). Never true for a
 *                file that has ordinals.
 *
 * @param {Iterable<object>} lines parsed rollout envelopes, first line first
 * @returns {{ boundary: number|null, unprovable: boolean }}
 */
export function codexReplayPlan(lines) {
  const none = { boundary: null, unprovable: false };
  let start = null;
  let path = null;
  let first = true;
  let messageOrdinal = null;
  for (const e of lines) {
    if (first) {
      first = false;
      const meta = e?.type === 'session_meta' ? (e.payload ?? {}) : null;
      if (meta?.thread_source !== 'subagent') return none;
      if (!Number.isFinite(e.ordinal)) return { boundary: null, unprovable: true };
      const s = meta.subagent_history_start_ordinal;
      if (!Number.isInteger(s) || s < 0) return none;
      start = s;
      path = typeof meta.agent_path === 'string' && meta.agent_path ? meta.agent_path : null;
      continue;
    }
    // An event at or beyond the declared start proves the ordinal is a real
    // boundary rather than the file length.
    if (Number.isFinite(e?.ordinal) && e.ordinal >= start) return { boundary: start, unprovable: false };
    if (messageOrdinal === null && path && Number.isFinite(e?.ordinal) && isMessageToThread(e, path)) {
      messageOrdinal = e.ordinal;
    }
  }
  return { boundary: messageOrdinal, unprovable: false };
}

/** Is `e` part of the replayed history? An envelope without a finite ordinal
 *  is never called replay: an unprovable event is counted, not hidden. */
export function isCodexReplayLine(boundary, e) {
  return boundary !== null && Number.isFinite(e?.ordinal) && e.ordinal < boundary;
}
