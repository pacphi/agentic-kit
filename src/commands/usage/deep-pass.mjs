// Exemplar-gathering machinery for `ak usage prompts --deep`.
//
// The CLI half of the privacy split (ADR-0039 "The privacy split"). The
// aggregate tier knows THAT a request was retyped in 22 sessions; it cannot say what
// the request was, because the text was never stored. This machinery
// re-reads the transcripts to answer that — through the same per-host
// parsers the scan path uses, so a turn re-fingerprints to the identical `h`
// and joins back to the findings exactly.
//
// THE BOUNDARY: the text goes to stdout for the explicit `--deep` request and
// nowhere else. Nothing here writes a file.
//
// WHY THIS READS THE INDEX CACHE AND `agg.promptPatterns` DOES NOT. The
// aggregate is deliberately aggregates only. This machinery needs two things
// no aggregate can carry: the HASHES a caller owes an exemplar for, and the
// transcript PATH of a session that holds one. The cache is keyed by
// transcript path and is the only place both exist together.
//
// The distinction that makes this admissible: the cache as a PATTERNS SOURCE
// was ruled out — two surfaces bound to an internal file format, and the
// dashboard would have inherited the binding — whereas the cache as
// DISCOVERY is a CLI-only call answering "which transcript holds this hash",
// a question about where files are, not about what the numbers say.
//
// That is a coupling to an internal file layout, confined to this one
// text-bearing, CLI-only module on purpose: a pass that is about to open a
// transcript and print/send what the operator typed already has strictly
// more access than a fingerprint, so withholding fingerprints from it would
// be an obstacle rather than a boundary. `readPromptEntries` is the single
// call site if a supported accessor ever lands.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../../lib/paths.mjs';
import { SCHEMA_VERSION } from '../../lib/usage-index.mjs';
import { parseClaude, parseCodex, promptFingerprint } from '../../lib/usage-parsers.mjs';
import { parseSession as parseOpencodeSession } from '../../lib/usage-opencode.mjs';
import { provenanceOf } from '../../lib/usage-provenance.mjs';

/** Same ceiling readSession applies, for the same reason: a transcript is read
 *  whole and JSON-expands at roughly 5x, so an unbounded read is a memory
 *  amplification. Above it the session contributes no exemplar — and the
 *  selection below falls through to the next session holding the same text,
 *  which is why the ceiling costs nothing in practice. Two Codex rollouts on
 *  the reference corpus (79 MB and 93 MB) sit above it today. */
export const MAX_DEEP_FILE_BYTES = 64 * 1024 * 1024;

/** Hard stop on how many transcripts one deep pass will open, so a corpus that
 *  somehow needs a new file per exemplar still finishes. Well clear of the ~50
 *  the reference corpus opens for a full table. */
const MAX_DEEP_TRANSCRIPTS = 400;

export function promptCacheFile() { return path.join(configDir(), 'usage-index.json'); }

/** Parsed session records from the index cache, each with the SOURCE it was
 *  parsed from — the cache is keyed by transcript path, which is what lets this
 *  pass re-read a specific session without re-implementing file discovery.
 *  `[]` for any reason at all (absent, corrupt, or written by a different
 *  schema): no exemplars is a reportable state, not an error.
 *
 *  @returns {Array<{ file: string, dbFile: string|null, rec: any }>} */
export function readPromptEntries(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw?.schemaVersion !== SCHEMA_VERSION || !raw.entries) return [];
    return Object.entries(raw.entries)
      .filter(([, e]) => e?.session)
      .map(([file, e]) => ({ file, dbFile: e.dbFile ?? null, rec: e.session }));
  } catch {
    return [];
  }
}

/** The record gate, matching the aggregate's own (`!rec.responses` is not a
 *  session; `rec.end < cutoff` is outside the window) so this pass and the
 *  projection above read one population. */
function inWindow(rec, cutoffMs) {
  return !!rec?.responses && Array.isArray(rec.promptFPs) && rec.end != null && rec.end >= cutoffMs;
}

/** The day a record's tokens FIRST billed on — `promptStatsByDay`'s own
 *  attribution, restated here because the aggregate keeps it private. */
function firstBilledDay(rec) {
  let first = null;
  for (const row of rec.usage ?? []) if (first === null || row.day < first) first = row.day;
  return first;
}

/**
 * The typed fingerprints this pass targets exemplars with, decorated with where
 * each happened. DELIBERATELY NOT the canonical decoration: the boolean `q`/`o`
 * mapping lives once, in usage-aggregate's `decoratePromptFP`, and is what the
 * CLASSIFICATION depends on — nothing here classifies anything. This pass reads
 * `h` to join, `t`/`th` to group and pair, and the raw stored `o` flag to find
 * personas, so restating the mapping would be a second copy of a contract it
 * does not use.
 */
export function deepFingerprints(entries, cutoffMs) {
  const out = [];
  for (const { rec } of entries) {
    if (!inWindow(rec, cutoffMs)) continue;
    const day = firstBilledDay(rec);
    const host = rec.host ?? rec.provider ?? 'unknown';
    for (const fp of rec.promptFPs) {
      if (fp.p === 'human') out.push({ ...fp, sessionId: rec.id, day, host });
    }
  }
  return out;
}

/** Prompt-kind turns a PERSON typed, in transcript order, each re-fingerprinted
 *  so it can be joined to the aggregate tier's findings by hash. Both gates are
 *  the scan path's own: `kind === 'prompt'` is what decides a fingerprint is
 *  written at all, and `provenanceOf` on the same text is what decides its
 *  tag — so this list is exactly the session's `human` fingerprints, in the
 *  same order. */
function humanPromptTurns(turns) {
  const out = [];
  for (const t of turns ?? []) {
    if (t?.kind !== 'prompt' || typeof t.text !== 'string') continue;
    if (provenanceOf(t.text, { kind: 'prompt' }) !== 'human') continue;
    out.push({ h: promptFingerprint(t.text).h, text: t.text, at: Date.parse(t.at) });
  }
  return out;
}

/** Re-parse one cached session's transcript WITH turns, through the parser its
 *  own provider owns. `dirName` only feeds project labelling, which this pass
 *  never reads, so the parent directory is sufficient. Returns `null` for
 *  anything unreadable — a vanished or oversized transcript costs its own
 *  exemplar and nothing else. */
function reReadTurns({ file, dbFile, rec }) {
  if (file.startsWith('opencode://')) {
    if (!dbFile) return null;
    try { return parseOpencodeSession({ dbFile, id: rec.id, withTurns: true })?.turns ?? null; } catch { return null; }
  }
  let raw;
  try {
    if (fs.statSync(file).size > MAX_DEEP_FILE_BYTES) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  try {
    return rec.provider === 'codex'
      ? parseCodex(raw, { id: rec.id, withTurns: true }).turns
      : parseClaude(raw, { id: rec.id, dirName: path.basename(path.dirname(file)), withTurns: true }).turns;
  } catch { return null; }
}

/**
 * Sessions that could supply the wanted exemplars, most useful first: a
 * session holding four of them is opened before one holding a single hash, and
 * ties break on the id so the same corpus always opens the same files.
 *
 * A LIST rather than one pick per hash, which is what makes this robust. The
 * first version staked each hash on a single session and lost the exemplar
 * outright when that transcript could not be read — measured on this corpus,
 * two Codex rollouts of 79 MB and 93 MB sit above the read ceiling and between
 * them were the sole source for nine of the top thirty short prompts, every
 * one of which rendered "transcript unavailable" beside a perfectly good
 * count. The same text exists in a dozen smaller transcripts; the pass just
 * has to be willing to look in the next one.
 */
export function exemplarCandidates(typed, wanted) {
  const bySession = new Map();
  for (const fp of typed) {
    if (!wanted.has(fp.h) || !fp.sessionId) continue;
    let hashes = bySession.get(fp.sessionId);
    if (!hashes) bySession.set(fp.sessionId, (hashes = new Set()));
    hashes.add(fp.h);
  }
  return [...bySession.entries()]
    .map(([sessionId, hashes]) => ({ sessionId, hashes }))
    .sort((a, b) => b.hashes.size - a.hashes.size || (a.sessionId < b.sessionId ? -1 : 1));
}

/**
 * Opens transcripts until every wanted exemplar is resolved, and no more than
 * that. Re-ask sessions are opened unconditionally (the pair's timing can only
 * come from the session it happened in); the rest are opened only while they
 * still hold a hash nothing has answered yet, so a corpus where one big
 * session covers most of the table costs a handful of files.
 */
export function collectExemplars({ entries, cutoffMs, candidates, reAskSessions, wanted }) {
  const byId = new Map();
  for (const entry of entries) if (inWindow(entry.rec, cutoffMs)) byId.set(entry.rec.id, entry);
  const text = new Map();            // hash → first verbatim text seen for it
  const bySession = new Map();       // session id → its ordered human prompt turns
  const attempted = new Set();
  const cost = { transcripts: 0, unreadable: 0 };

  const open = (id) => {
    attempted.add(id);
    const entry = byId.get(id);
    if (!entry) return;
    cost.transcripts++;
    const reRead = reReadTurns(entry);
    if (!reRead) { cost.unreadable++; return; }
    const turns = humanPromptTurns(reRead);
    bySession.set(id, turns);
    for (const t of turns) if (wanted.has(t.h) && !text.has(t.h)) text.set(t.h, t.text);
  };

  for (const id of reAskSessions) open(id);
  for (const c of candidates) {
    if (cost.transcripts >= MAX_DEEP_TRANSCRIPTS) break;
    if (attempted.has(c.sessionId)) continue;
    if (![...c.hashes].some((h) => !text.has(h))) continue;
    open(c.sessionId);
  }
  return { text, bySession, cost };
}
