// doc-citations.test.mjs — the usage docs cite source as `file.mjs:NNN` (or
// `:NNN-MMM`) next to the identifier they're citing. Line numbers rot as code
// moves; this gate replaces the old "pinned to commit X, re-derive with git
// log -L" disclaimer by checking every citation against the CURRENT source.
//
// TWO anchor kinds, checked differently, because they carry different
// evidentiary weight:
//   - a NAMED SYMBOL: a backtick span whose WHOLE trimmed content is one
//     identifier-shaped token, ≥4 characters (`printCoaching`,
//     `TAP_MAX_TOKENS`) — checked with a WORD-BOUNDARY match against the
//     cited range (±TOLERANCE lines), so a short identifier cannot pass by
//     sitting inside an unrelated longer word.
//   - a quoted STRING: an 8-90 char `"..."` phrase near the citation —
//     checked by substring, since a phrase that long matching by accident is
//     not a realistic risk.
// A citation whose surrounding prose names a symbol MUST find that symbol
// (or a quoted string) within range; a WORD-FRAGMENT pulled out of a longer
// quoted PHRASE no longer counts as naming anything — `` `did not land` ``
// used to hand out "did"/"not"/"land" as three independent anchors, any one
// of which could satisfy the citation by matching unrelated prose elsewhere
// in the file. Only a citation with NO named symbol and NO quoted string
// nearby falls back to a plain range check (the file has enough lines) —
// there is nothing sharper to hold it to.
//
// Fix round 1, C-1 — the DEFINITION-SITE rule. A named symbol's word-boundary
// match above only proves the TEXT appears somewhere in the widened window —
// a call site (`printScoreReliability(agg);`) contains the identifier just as
// much as its definition does, so a citation moved off a function's real
// definition range onto an unrelated call-site line used to still pass. When
// a named symbol resolves to EXACTLY ONE `function|const|let|var|class
// <name>` declaration anywhere in the cited file, that declaration's line
// must itself fall within the widened range — a call site or passing mention
// elsewhere in the window no longer substitutes for it. A symbol with zero or
// multiple such declarations is too ambiguous to gate on and relies on the
// plain word-boundary check above instead.
//
// Fix round 1, I-2 — SAME-ROW fallback for table citations. Cell-scoping
// (below) stops a neighbouring column's identifier from anchoring a
// DIFFERENT fact's citation, but a `| `symbol` | prose (`file.mjs:N`) |` row
// legitimately names its subject in one cell and cites it in another. When a
// table citation's OWN cell yields no anchor at all, it falls back to the
// REST OF ITS ROW (every other cell on the same line) — never another row.
//
// Fix round 2 — the CALL-SITE marker (an affordance, not an escape hatch).
// Round 1 fixed genuine call-site citations by DE-ANCHORING them — stripping
// or requoting the identifier so the definition-site rule had nothing to gate
// on. That made the citation's own NUMBER invisible to the gate again, and
// five shipped wrong that way. Instead: a citation whose own sentence/cell
// (the SAME context window used for quoted-string anchors below — own table
// cell, or the ±3/+1 doc-line window in prose) contains the literal word
// "call" — bare, or as "call site" — declares itself a call-site citation.
// The named symbol still has to hit within ±TOLERANCE (unchanged); the
// definition-site rule is the ONLY thing skipped, because a call site
// legitimately isn't where the symbol is declared. No new syntax: "call" is
// the word this doc already reaches for to describe an invocation, now read
// deliberately instead of incidentally. A citation must still resolve some
// anchor to pass at all — marking a citation "call" does not exempt it from
// having a real symbol or quoted phrase nearby, only from the definition
// check on that symbol.
//
// A failure names the citation and where its anchor actually lives now (if
// found anywhere in the file), so re-anchoring is a one-line edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = ['docs/USAGE-SCORECARD-METRICS.md', 'docs/TRANSCRIPTS.md'];
// A citation is "fresh" if an anchor lands within the range widened by this
// many lines each way — small drift stays readable; structural moves fail.
const TOLERANCE = 10;

// Map cited basenames to real paths by walking the source trees once.
function fileIndex() {
  const map = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) { if (name !== 'node_modules') walk(rel); }
      else if (/\.(mjs|cjs|js)$/.test(name) && !map.has(name)) map.set(name, rel);
    }
  };
  for (const dir of ['src', 'tests', 'scripts']) walk(dir);
  return map;
}

// A whole backtick span counts as naming a symbol only if it IS one
// identifier-shaped token end to end (≥4 chars) — `did not land` names
// nothing, `printCoaching` names itself — OR is a declaration/assignment
// shape (`CONST_NAME = 4`, `key: value`, `fnName(...)`) whose LEADING token
// is one, which this doc uses constantly to show a constant beside its
// value; the leading identifier is unambiguously what such a span names,
// whatever follows the `=`/`:`/`(`.
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]{3,}$/;
const IDENTIFIER_PREFIX_RE = /^([A-Za-z_$][\w$]{3,})\s*(?:=|:(?!:)|\()/;

// Fix round 2 — the literal word "call" (never "calls"/"called"/"calling",
// which \b already excludes), read from the citation's own sentence/cell as
// a deliberate self-declaration that this citation is about a call site.
const CALL_SITE_MARKER_RE = /\bcall\b/i;

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The symbol a span names, or null if it names nothing.
function identifierIn(tok) {
  if (IDENTIFIER_RE.test(tok)) return tok;
  const m = IDENTIFIER_PREFIX_RE.exec(tok);
  return m ? m[1] : null;
}

// Fix round 1, C-1 — the definition-site rule. `name` is always a validated
// identifier token (from identifierIn), never doc free text, so it is safe
// to interpolate into a RegExp without escaping.
function definitionRe(name) {
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?`
    + `(?:function\\*?\\s+${name}\\b|(?:const|let|var|class)\\s+${name}\\b)`,
  );
}

// The 1-indexed line where `name` is declared in `src` (identified by `rel`,
// for caching), or null when there isn't EXACTLY one such declaration — 0 is
// nothing to gate on, 2+ is too ambiguous to pick one, and both fall back to
// the plain word-boundary check instead.
const defLineCache = new Map();
function soleDefinitionLine(name, rel, src) {
  const key = `${rel} ${name}`;
  if (defLineCache.has(key)) return defLineCache.get(key);
  const re = definitionRe(name);
  let hit = null, count = 0;
  for (let i = 0; i < src.length; i++) {
    if (re.test(src[i])) { count++; hit = i + 1; }
  }
  const result = count === 1 ? hit : null;
  defLineCache.set(key, result);
  return result;
}

// A markdown table row — citations and spans on one both restrict each
// other to the SAME CELL (see below): a row's other columns routinely name
// an identifier for a DIFFERENT cell's citation in the same row, which is
// exactly the cross-contamination this whole file exists to stop.
const TABLE_ROW_RE = /^\s*\|/;

// Which pipe-delimited cell (0-based) a column offset falls in, on a table
// row — counts unescaped `|` before it. Not a full markdown-table parser
// (doesn't special-case `\|`), which this doc's own tables never use.
function cellIndexAt(line, col) {
  let n = 0;
  for (let i = 0; i < col && i < line.length; i++) if (line[i] === '|') n++;
  return n;
}

// Pull `file:start[-end]` citations out of one doc, attaching bare `:NNN`
// follow-ups (the "`usage-classify.mjs:234`, `:252`" style) to the last file
// seen in the same paragraph. Context = nearby doc lines, for anchor mining.
function extractCitations(docText) {
  const lines = docText.split('\n');
  const cites = [];
  let lastFile = null, lastFileLine = -10;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`(?:[\w./-]*\/)?([\w.-]+\.(?:mjs|cjs|js)):(\d+)(?:-(\d+))?`/g)) {
      lastFile = m[1]; lastFileLine = i;
      cites.push({
        file: m[1], start: +m[2], end: +(m[3] ?? m[2]), docLine: i + 1,
        col: m.index, table: TABLE_ROW_RE.test(line) ? cellIndexAt(line, m.index) : null,
      });
    }
    for (const m of line.matchAll(/`:(\d+)(?:-(\d+))?`/g)) {
      if (lastFile && i - lastFileLine <= 2) {
        cites.push({
          file: lastFile, start: +m[1], end: +(m[2] ?? m[1]), docLine: i + 1,
          col: m.index, table: TABLE_ROW_RE.test(line) ? cellIndexAt(line, m.index) : null,
        });
      }
    }
  });
  // Pair code spans over the WHOLE document (CommonMark sequential pairing) so
  // a context window can never start mid-span and invert what reads as code.
  // Fenced blocks are blanked first — their ``` markers would garble pairing.
  let fenced = false;
  const masked = lines
    .map((l) => { if (/^\s*```/.test(l)) { fenced = !fenced; return ''; } return fenced ? '' : l; })
    .join('\n');
  const maskedLines = masked.split('\n');
  const lineStartOffset = [];
  { let off = 0; for (const l of maskedLines) { lineStartOffset.push(off); off += l.length + 1; } }
  const spans = [];
  for (const m of masked.matchAll(/`([^`]+)`/g)) {
    const startLine = masked.slice(0, m.index).split('\n').length;
    spans.push({ tok: m[1].replace(/\s+/g, ' '), line: startLine, col: m.index - lineStartOffset[startLine - 1] });
  }
  for (const c of cites) {
    // Fix round 1, I-2: mine the citation's OWN cell first; a table citation
    // whose own cell names nothing falls back to the REST OF ITS ROW (never
    // another row) — see the file header. Non-table citations are unaffected
    // (ownCellOnly never restricts anything for them).
    const mineIds = (ownCellOnly) => {
      const found = new Set();
      for (const s of spans) {
        if (s.line < c.docLine - 3 || s.line > c.docLine + 1) continue;
        // Inside a table row, a candidate must be ON THAT ROW — and, on the
        // own-cell pass, in the SAME CELL as the citation — a neighbouring
        // column is not "nearby prose", it is a different fact with its own
        // citation.
        if (c.table !== null) {
          if (s.line !== c.docLine) continue;
          if (ownCellOnly && cellIndexAt(maskedLines[s.line - 1], s.col) !== c.table) continue;
        }
        if (/^[\w./-]+\.(mjs|cjs|js):\d/.test(s.tok) || /^:\d/.test(s.tok)) continue; // a citation, not an anchor
        // A NAMED SYMBOL is the span's WHOLE content (or its unambiguous
        // leading token) — `did not land` names nothing; `printCoaching` and
        // `TAP_MAX_TOKENS = 4` both name themselves.
        const id = identifierIn(s.tok);
        if (id) found.add(id);
      }
      return found;
    };
    let idAnchors = mineIds(true);
    if (c.table !== null && idAnchors.size === 0) idAnchors = mineIds(false);

    const ownCellCtx = c.table !== null
      ? (maskedLines[c.docLine - 1].split('|')[c.table] ?? '')
      : maskedLines.slice(Math.max(0, c.docLine - 4), c.docLine + 2).join(' ');
    const strAnchors = new Set();
    for (const m of ownCellCtx.matchAll(/"([^"]{8,90})"/g)) strAnchors.add(m[1]);
    // Same same-row fallback for quoted-string anchors: an empty own cell
    // widens to the whole row, still never leaving it.
    if (c.table !== null && strAnchors.size === 0) {
      for (const m of maskedLines[c.docLine - 1].matchAll(/"([^"]{8,90})"/g)) strAnchors.add(m[1]);
    }
    c.idAnchors = [...idAnchors];
    c.strAnchors = [...strAnchors];
    // Fix round 2 — the call-site marker, read from the SAME own-cell/prose
    // context as the quoted-string anchors above (not the row-fallback: a
    // marker is a deliberate per-citation declaration, never inherited from
    // a sibling cell).
    c.isCallSite = CALL_SITE_MARKER_RE.test(ownCellCtx);
  }
  return cites;
}

function checkDoc(docRel, index) {
  const cites = extractCitations(readFileSync(join(ROOT, docRel), 'utf8'));
  const failures = [], unanchored = [];
  const sources = new Map();
  for (const c of cites) {
    const rel = index.get(c.file);
    if (!rel) { failures.push(`${docRel}:${c.docLine} cites unknown file ${c.file}`); continue; }
    if (!sources.has(rel)) sources.set(rel, readFileSync(join(ROOT, rel), 'utf8').split('\n'));
    const src = sources.get(rel);
    if (c.start > src.length) {
      failures.push(`${docRel}:${c.docLine} cites ${c.file}:${c.start} but the file has ${src.length} lines`);
      continue;
    }
    // The plain-range fallback: nothing nearby names a symbol or quotes a
    // long phrase, so there is nothing sharper to check than "the line
    // range exists" (already established above).
    if (c.idAnchors.length === 0 && c.strAnchors.length === 0) { unanchored.push(c); continue; }
    const lo = Math.max(0, c.start - 1 - TOLERANCE);
    const hi = Math.min(src.length, c.end + TOLERANCE);
    // Whitespace-normalized on both sides: doc wrapping and source wrapping
    // must not defeat a match on the same words.
    const window = src.slice(lo, hi).join(' ').replace(/\s+/g, ' ');
    const idHitAnchors = c.idAnchors.filter((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`).test(window));
    const idHit = idHitAnchors.length > 0;
    const strHit = c.strAnchors.some((a) => window.includes(a.replace(/\s+/g, ' ')));
    if (!idHit && !strHit) {
      const findElsewhere = (a, wordBoundary) => {
        const re = wordBoundary ? new RegExp(`\\b${escapeRegExp(a)}\\b`) : null;
        const at = src.findIndex((l) => (re ? re.test(l) : l.includes(a)));
        return at >= 0 ? `${a}@${at + 1}` : null;
      };
      const seen = [
        ...c.idAnchors.map((a) => findElsewhere(a, true)),
        ...c.strAnchors.map((a) => findElsewhere(a, false)),
      ].filter(Boolean).slice(0, 3).join(', ');
      failures.push(
        `${docRel}:${c.docLine} cites ${c.file}:${c.start}${c.end !== c.start ? '-' + c.end : ''} ` +
        `but none of its anchors (named symbol: ${c.idAnchors.join(', ') || '(none)'}` +
        `${c.strAnchors.length ? `; quoted: ${c.strAnchors.join(', ')}` : ''}) appear within ±${TOLERANCE} lines` +
        (seen ? ` (found elsewhere: ${seen})` : ' (anchors not found in file at all)'),
      );
      continue;
    }
    // Fix round 1, C-1 — the definition-site rule: a word-boundary hit above
    // only proves the identifier's TEXT is somewhere in the window, which a
    // call site satisfies just as well as a definition. Scoped to the
    // anchors that ACTUALLY hit (idHitAnchors) — an identifier merely mined
    // nearby (e.g. the subject of an adjacent sentence's own citation, within
    // the ±3/+1 doc-line window but never matching this citation's window)
    // never claimed anything about this citation and must not be gated on;
    // only a symbol whose text-match is doing the work here has to prove
    // that text-match is a definition, not a call site.
    //
    // Fix round 2 — a citation self-declared as a call site (see the
    // CALL_SITE_MARKER_RE header note) skips ONLY this rule; idHit/strHit
    // above still had to pass, so the citation is not exempt from having a
    // real anchor, only from that anchor having to be a declaration.
    if (c.isCallSite) continue;
    const defMiss = idHitAnchors
      .map((a) => ({ a, at: soleDefinitionLine(a, rel, src) }))
      .find(({ at }) => at !== null && (at < lo + 1 || at > hi));
    if (defMiss) {
      failures.push(
        `${docRel}:${c.docLine} cites ${c.file}:${c.start}${c.end !== c.start ? '-' + c.end : ''} ` +
        `for \`${defMiss.a}\`, but its sole definition is at ${c.file}:${defMiss.at} — outside ` +
        `±${TOLERANCE} lines of this range (definition-site rule)`,
      );
    }
  }
  return { total: cites.length, unanchored: unanchored.length, failures };
}

const index = fileIndex();
for (const doc of DOCS) {
  test(`every file:line citation in ${doc} still points at its subject`, () => {
    const { total, unanchored, failures } = checkDoc(doc, index);
    assert.ok(total > 20, `expected a citation-dense doc, extracted only ${total}`);
    assert.deepEqual(failures, [], `${failures.length}/${total} citations drifted (${unanchored} unanchored, checked at ±${TOLERANCE}):\n` + failures.join('\n'));
  });
}
