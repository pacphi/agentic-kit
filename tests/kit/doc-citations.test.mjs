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

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The symbol a span names, or null if it names nothing.
function identifierIn(tok) {
  if (IDENTIFIER_RE.test(tok)) return tok;
  const m = IDENTIFIER_PREFIX_RE.exec(tok);
  return m ? m[1] : null;
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
    const idAnchors = new Set();
    for (const s of spans) {
      if (s.line < c.docLine - 3 || s.line > c.docLine + 1) continue;
      // Inside a table row, a candidate must be ON THAT ROW and in the SAME
      // CELL as the citation — a neighbouring column is not "nearby prose",
      // it is a different fact with its own citation.
      if (c.table !== null) {
        if (s.line !== c.docLine) continue;
        if (cellIndexAt(maskedLines[s.line - 1], s.col) !== c.table) continue;
      }
      if (/^[\w./-]+\.(mjs|cjs|js):\d/.test(s.tok) || /^:\d/.test(s.tok)) continue; // a citation, not an anchor
      // A NAMED SYMBOL is the span's WHOLE content (or its unambiguous
      // leading token) — `did not land` names nothing; `printCoaching` and
      // `TAP_MAX_TOKENS = 4` both name themselves.
      const id = identifierIn(s.tok);
      if (id) idAnchors.add(id);
    }
    const ctxLo = c.table !== null ? c.docLine - 1 : Math.max(0, c.docLine - 4);
    const ctxHi = c.table !== null ? c.docLine : c.docLine + 2;
    const ctx = c.table !== null
      ? (() => {
        const cells = maskedLines[c.docLine - 1].split('|');
        return cells[c.table] ?? '';
      })()
      : maskedLines.slice(ctxLo, ctxHi).join(' ');
    const strAnchors = new Set();
    for (const m of ctx.matchAll(/"([^"]{8,90})"/g)) strAnchors.add(m[1]);
    c.idAnchors = [...idAnchors];
    c.strAnchors = [...strAnchors];
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
    const idHit = c.idAnchors.some((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`).test(window));
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
