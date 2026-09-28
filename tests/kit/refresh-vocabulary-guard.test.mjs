// refresh-vocabulary-guard.test.mjs — ADR-0063 (the refresh vocabulary): no
// retired CLI spelling from before the one-refresh-flag vocabulary may
// reappear in help text, README, docs, or the installed `claude/` guidance.
//
// Scope: src/** (comments included — they must describe current CLI
// behaviour), bin/**, claude/**, README.md, and docs/**/*.md except
// docs/adr/, docs/audits/, docs/superpowers/, and docs/research/ (history
// lives there and may still name retired spellings). In
// src/lib/hook-audit/agentic-dependency-constraints.json only the dated
// watch[].history[].note strings are skipped — every other string, including
// `adjustment`, is scanned like any other source text.
//
// CLI patterns only: the dashboard's own retired spellings ("Full
// scan", "Refresh evidence", "Re-measure machine", "Check again", "refresh
// now") are out of this guard's scope until the dashboard half of this work
// lands in a later branch (see docs/superpowers/plans/2026-09-28-branch-6b-
// one-refresh-flag.md, "Closing this branch"). This guard never asserts an
// UPGRADING section or an old -> new table exists (no legacy, no hints).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'src', 'lib', 'hook-audit', 'agentic-dependency-constraints.json');

const RETIRED_CLI_PATTERNS = [
  { label: 'ak x verify', pattern: /\bx\s+verify\b/g },
  { label: 'ak status --live', pattern: /\bstatus\s+--live\b/g },
  { label: 'ak status --deep', pattern: /\bstatus\s+--deep\b/g },
  { label: 'ak system --deep', pattern: /\bsystem\s+--deep\b/g },
  { label: 'ak maintain scan (verb)', pattern: /\bmaintain\s+scan\b/g },
  { label: '--refresh-inventory', pattern: /--refresh-inventory\b/g },
  { label: 'ak maintain scans start --deep', pattern: /\bmaintain\s+scans\s+start\b[^\n]*--deep/g },
  { label: 'ak maintain plan --deep', pattern: /\bmaintain\s+plan\b[^\n]*--deep/g },
  { label: 'ak host refresh', pattern: /\bhost\s+refresh\b/g },
  { label: 'ak usage prompts --deep', pattern: /\bprompts\s+--deep\b/g },
  { label: 'ak maintain recipes refresh', pattern: /\brecipes\s+refresh\b/g },
  // Enumerated `a|b|c` verb lists (e.g. `host status|pick|refresh|off`,
  // `verify learning|security|...`) defeat the command-then-flag adjacency
  // patterns above: the retired verb sits behind other verbs, not directly
  // after `host`/`x`. These require the specific retired verb to sit inside
  // a `|`-separated chain (tight or spaced, markdown-escaped `\|` or not) so
  // a plain English sentence never matches.
  { label: 'ak host …|refresh (enumerated verb list)', pattern: /\bhost\s+[a-z][\w-]*(?:\s*\\?\|\s*[a-z][\w-]*)*\s*\\?\|\s*refresh\b/g },
  { label: 'ak x verify …|… (enumerated suite list)', pattern: /\bverify\s+(?:learning|security|aqe|providers|harvest|deja-vu|memory)\s*\\?\|/g },
  // A bracketed usage line (`system [--deep] [--json]`, `status [--json]
  // [--live]`) puts other bracketed options between the command word and the
  // retired flag, defeating the tight adjacency patterns above — this is
  // exactly how four current-state docs kept `--deep`/`--live` past the
  // original guard. These tolerate any number of single-line bracketed groups
  // (and an optional leading `[`) between the command word and the retired
  // flag.
  { label: 'ak status/system […] --deep|--live (bracketed options before the flag)',
    pattern: /\b(?:status|system)\s+(?:\[[^\]\n]*\]\s*)*\[?--(?:deep|live)\b/g },
  // `ak usage prompts --deep` behind unrelated prose on the same line (the
  // USAGE-SCORECARD-METRICS.md line the original guard missed had no direct
  // `prompts --deep` adjacency at all).
  { label: 'ak usage prompts …--deep (flag anywhere on the same line)', pattern: /\bprompts\b[^\n]*\[?--deep\b/g },
];

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function violations(relPath, text) {
  const found = [];
  for (const { label, pattern } of RETIRED_CLI_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      found.push(`${relPath}:${lineOf(text, match.index)} ${label}: ${JSON.stringify(match[0])}`);
    }
  }
  return found;
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function markdownFiles(dir, { exclude = [] } = {}) {
  return listFiles(dir).filter((file) => (
    file.endsWith('.md') && !exclude.some((skip) => file.startsWith(skip))
  ));
}

// Walk the registry's parsed JSON tree to collect the exact source-text spans
// of every skipped string (watch[].history[].note only, R18) so the raw-text
// scan below can subtract them without needing a JSON-aware tokenizer.
function registrySkipSpans(rawText, registry) {
  const spans = [];
  const claimed = new Set();
  for (const entry of registry.watch ?? []) {
    for (const record of entry.history ?? []) {
      if (typeof record.note !== 'string') continue;
      const needle = JSON.stringify(record.note);
      let from = 0;
      // A note string can repeat verbatim across entries; walk past spans
      // already claimed so each occurrence is subtracted exactly once.
      for (;;) {
        const index = rawText.indexOf(needle, from);
        if (index === -1) break;
        if (!claimed.has(index)) {
          claimed.add(index);
          spans.push([index, index + needle.length]);
          break;
        }
        from = index + 1;
      }
    }
  }
  return spans;
}

function withoutSpans(text, spans) {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    out += text.slice(cursor, start);
    // Preserve line numbers: replace the skipped span with matching newlines.
    out += text.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

function registryViolations() {
  const rawText = fs.readFileSync(REGISTRY, 'utf8');
  const registry = JSON.parse(rawText);
  const spans = registrySkipSpans(rawText, registry);
  const scanned = withoutSpans(rawText, spans);
  return violations(path.relative(ROOT, REGISTRY), scanned);
}

function scopeFiles() {
  const docsRoot = path.join(ROOT, 'docs');
  const docsExclude = ['adr', 'audits', 'superpowers', 'research'].map((dir) => path.join(docsRoot, dir) + path.sep);
  const files = [
    path.join(ROOT, 'README.md'),
    ...listFiles(path.join(ROOT, 'src')),
    ...listFiles(path.join(ROOT, 'bin')),
    ...listFiles(path.join(ROOT, 'claude')),
    ...markdownFiles(docsRoot, { exclude: docsExclude }),
  ];
  // The registry is scanned separately (JSON-aware, skipping only dated
  // watch[].history[].note strings); drop its raw-text duplicate here.
  return files.filter((file) => file !== REGISTRY);
}

test('no retired CLI spelling remains in help, README, docs, or installed guidance', () => {
  const found = [];
  for (const file of scopeFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    found.push(...violations(path.relative(ROOT, file), text));
  }
  found.push(...registryViolations());
  assert.deepEqual(found, [], `retired CLI spellings remain:\n${found.join('\n')}`);
});

test('the registry skip is narrow: dated watch[].history[].note strings still contain the old spellings they document', () => {
  // Guards against the skip silently matching nothing (a rot signal — if this
  // ever fails, either the history moved or the CLI guard patterns changed).
  const rawText = fs.readFileSync(REGISTRY, 'utf8');
  const registry = JSON.parse(rawText);
  let historicalHits = 0;
  for (const entry of registry.watch ?? []) {
    for (const record of entry.history ?? []) {
      if (typeof record.note === 'string' && violations('note', record.note).length > 0) historicalHits += 1;
    }
  }
  assert.ok(historicalHits > 0, 'expected at least one dated history note to retain a retired spelling (as history)');
});
