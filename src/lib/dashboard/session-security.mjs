import os from 'node:os';
import path from 'node:path';

/** Transcript roots are used only for containment checks. */
export const TRANSCRIPT_ROOTS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.codex', 'sessions'),
];

/** The plain (top-level session) id charset — shared by parseSessionId and
 *  parseNamespacedSessionId's parent segment, so a namespaced id's parent
 *  half can never be more permissive than a plain id already is. */
const PLAIN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Decode and validate an opaque session identifier. */
export function parseSessionId(raw) {
  let id;
  try { id = decodeURIComponent(String(raw ?? '')); } catch { return null; }
  if (id !== String(raw ?? '') && /%[0-9a-f]{2}/i.test(id)) return null;
  if (!PLAIN_ID_RE.test(id)) return null;
  if (id === '.' || id === '..') return null;
  return id;
}

/** Require the identifier to resolve to a direct child of a transcript root. */
export function resolvesInsideRoot(root, id) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, id);
  return resolved !== base
    && resolved.startsWith(base + path.sep)
    && path.dirname(resolved) === base;
}

/** A nested Claude subagent transcript's own filename stem (no `.jsonl`):
 *  Claude Code writes every one as `agent-<hex>`, or `agent-<name>-<hex>`
 *  when the Task tool call carried a name (the Agent tool's own `name`
 *  parameter, charset [A-Za-z0-9_-]). A survey of this machine's real
 *  corpus (404 files, Task 5 round 2) found most stems carry a name — a
 *  hex-only pattern would leave most subagent sessions still unopenable.
 *  '/', '.', and '\' are simply not in this charset, so no separate
 *  traversal check is needed for this segment beyond the charset itself. */
const SUBAGENT_STEM_RE = /^agent-[A-Za-z0-9_-]{1,100}$/;

/** Decode and validate a namespaced Claude subagent session id: EXACTLY
 *  `<parentId>/<stem>`, one slash. Returns `{ parentId, stem }` on a match,
 *  `null` otherwise — the same fail-closed contract as parseSessionId.
 *
 *  Kept as its own function rather than folded into parseSessionId (which
 *  would risk loosening it) because parseSessionId/resolvesInsideRoot ALSO
 *  gate the live-playback/SSE routes (handlePlayback, handleTranscriptEvents
 *  in dashboard-server.mjs), which resolve ids through an entirely
 *  different, independently-guarded code path
 *  (live/transcript-streams.mjs's own VALID_ID + locate()) that this fix has
 *  no reason to touch or re-verify — the smallest correct surface is a new,
 *  additive function used only by the one route this round is about. */
export function parseNamespacedSessionId(raw) {
  let id;
  try { id = decodeURIComponent(String(raw ?? '')); } catch { return null; }
  if (id !== String(raw ?? '') && /%[0-9a-f]{2}/i.test(id)) return null;
  const parts = id.split('/');
  if (parts.length !== 2) return null; // exactly one slash, two segments
  const [parentId, stem] = parts;
  if (!PLAIN_ID_RE.test(parentId) || parentId === '.' || parentId === '..') return null;
  if (!SUBAGENT_STEM_RE.test(stem)) return null;
  return { parentId, stem };
}

/** Require a namespaced id's two segments to resolve to a subagent
 *  transcript exactly two levels below a direct child of a transcript root:
 *  `<root>/<parentId>/subagents/<stem>.jsonl`. The parent segment is pinned
 *  by reusing resolvesInsideRoot UNCHANGED — "resolves inside the project
 *  dir exactly as plain ids do" — the child segment then extends that by
 *  two fixed, already-validated components. Belt and braces alongside
 *  parseNamespacedSessionId's charset checks, not a substitute for them:
 *  this only ever receives segments that already passed that parse. */
export function resolvesNamespacedInsideRoot(root, parentId, stem) {
  if (!resolvesInsideRoot(root, parentId)) return false;
  const parentDir = path.join(path.resolve(root), parentId);
  const resolved = path.resolve(parentDir, 'subagents', `${stem}.jsonl`);
  return resolved.startsWith(parentDir + path.sep) && path.dirname(resolved) === path.join(parentDir, 'subagents');
}

/** Copy and mask every string field in each transcript turn. */
export function maskTurns(turns, maskFn) {
  if (typeof maskFn !== 'function') {
    throw new Error('no secret masker available — refusing to serve an unmasked transcript');
  }
  return (Array.isArray(turns) ? turns : []).map((turn) => maskObject(turn, maskFn));
}

/** Copy and mask every string field in transcript metadata. */
export function maskMeta(meta, maskFn) {
  if (typeof maskFn !== 'function') {
    throw new Error('no secret masker available — refusing to serve unmasked metadata');
  }
  return meta && typeof meta === 'object' ? maskObject(meta, maskFn) : null;
}

function maskObject(value, maskFn) {
  if (typeof value === 'string') return maskFn(value);
  if (Array.isArray(value)) return value.map((item) => maskObject(item, maskFn));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = maskObject(item, maskFn);
  return out;
}
