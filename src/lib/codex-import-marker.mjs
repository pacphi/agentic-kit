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

/** One decoded rollout record: is it a turn of an imported thread? Only a
 *  string `payload.turn_id` counts; the marker text inside a message does not. */
export function isCodexImportedLine(e) {
  const turnId = e?.payload?.turn_id;
  return typeof turnId === 'string' && turnId.startsWith(CODEX_IMPORT_TURN_PREFIX);
}

/** A rollout's bounded head (raw JSON lines): is the rollout an imported copy?
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
