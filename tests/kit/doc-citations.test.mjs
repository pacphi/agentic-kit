// doc-citations.test.mjs — the usage docs cite source as `file.mjs:NNN` (or
// `:NNN-MMM`) next to the identifier they're citing. Line numbers rot as code
// moves; this gate replaces the old "pinned to commit X, re-derive with git
// log -L" disclaimer by checking every citation against the CURRENT source:
// some identifier or quoted string named near the citation must occur inside
// the cited range (±TOLERANCE lines). A failure names the citation and where
// its anchor actually lives now, so re-anchoring is a one-line edit.
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
      cites.push({ file: m[1], start: +m[2], end: +(m[3] ?? m[2]), docLine: i + 1 });
    }
    for (const m of line.matchAll(/`:(\d+)(?:-(\d+))?`/g)) {
      if (lastFile && i - lastFileLine <= 2) {
        cites.push({ file: lastFile, start: +m[1], end: +(m[2] ?? m[1]), docLine: i + 1 });
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
  const spans = [];
  for (const m of masked.matchAll(/`([^`]+)`/g)) {
    const startLine = masked.slice(0, m.index).split('\n').length;
    spans.push({ tok: m[1].replace(/\s+/g, ' '), line: startLine });
  }
  for (const c of cites) {
    const anchors = new Set();
    for (const s of spans) {
      if (s.line < c.docLine - 3 || s.line > c.docLine + 1) continue;
      if (/^[\w./-]+\.(mjs|cjs|js):\d/.test(s.tok) || /^:\d/.test(s.tok)) continue; // a citation, not an anchor
      if (/^[\d.,%×x-]+$/.test(s.tok)) continue;                                    // bare numbers
      for (const id of s.tok.matchAll(/[A-Za-z_$][\w$]{2,}/g)) anchors.add(id[0]);
    }
    const ctx = masked.split('\n').slice(Math.max(0, c.docLine - 4), c.docLine + 2).join(' ');
    for (const m of ctx.matchAll(/"([^"]{8,90})"/g)) anchors.add(m[1]);
    anchors.delete('the'); anchors.delete('and');
    c.anchors = [...anchors];
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
    if (c.anchors.length === 0) { unanchored.push(c); continue; }
    const lo = Math.max(0, c.start - 1 - TOLERANCE);
    const hi = Math.min(src.length, c.end + TOLERANCE);
    // Whitespace-normalized on both sides: doc wrapping and source wrapping
    // must not defeat a match on the same words.
    const window = src.slice(lo, hi).join(' ').replace(/\s+/g, ' ');
    const hit = c.anchors.some((a) => window.includes(a.replace(/\s+/g, ' ')));
    if (!hit) {
      const seen = c.anchors
        .map((a) => { const at = src.findIndex((l) => l.includes(a)); return at >= 0 ? `${a}@${at + 1}` : null; })
        .filter(Boolean).slice(0, 3).join(', ');
      failures.push(
        `${docRel}:${c.docLine} cites ${c.file}:${c.start}${c.end !== c.start ? '-' + c.end : ''} ` +
        `but none of its anchors appear within ±${TOLERANCE} lines` +
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
