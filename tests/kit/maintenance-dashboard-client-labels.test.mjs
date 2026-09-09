// ADR-0048 dashboard client label-policy contract (MNT-EVD-006/007,
// non-negotiable #2). The Maintenance workspace's browser bundle cannot
// import a node module, so maintenance-workspace.mjs carries LITERAL copies
// of the label maps from src/lib/maintenance/management/model.mjs. This test
// reads the client source as TEXT (it is never node-imported — see each
// file's own `// @ts-nocheck` header) and asserts, without executing it:
//
//   (a) every string literal in a `label:` object-property position or a
//       static `>text<` HTML text-node position, across every file this
//       agent owns under src/lib/dashboard/client/maintenance-*.mjs and
//       system-maintenance{,-actions}.mjs, is not a prohibited user-facing
//       label (isProhibitedLabel === false, imported for real from model.mjs
//       — this is the one place in the test that trusts the contract rather
//       than reimplementing it);
//   (b) maintenance-workspace.mjs's copied label maps are byte-identical to
//       model.mjs's real exports, so the two vocabularies cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_ACTION_LABEL, AUDIT_RESULT_LABELS, CONFLICT_EXPLANATIONS, CREDENTIAL_READINESS_LABELS,
  CURATED_VIEW_LABELS, GUIDANCE_LANE_LABELS, INVENTORY_GROUP_LABELS, NO_ACTION_REQUESTED_DETAIL,
  NO_CORRECTIVE_ACTION, RECONCILE_OUTCOME_LABELS, RESOURCE_KIND_LABELS, SCOPE_LABELS,
  SOURCE_COVERAGE_LABELS, SOURCE_SCAN_INCOMPLETE, isProhibitedLabel,
} from '../../src/lib/maintenance/management/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, '..', '..', 'src', 'lib', 'dashboard', 'client');

const CLIENT_FILES = [
  'maintenance-workspace.mjs',
  'maintenance-inventory.mjs',
  'maintenance-cards.mjs',
  'maintenance-filters.mjs',
  'maintenance-operation.mjs',
  'maintenance-inspector.mjs',
  'maintenance-guidance.mjs',
  'maintenance-discovery.mjs',
  'maintenance-activity.mjs',
  'system-maintenance.mjs',
  'system-maintenance-actions.mjs',
];

function readClient(name) {
  return fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');
}

// (a) Two literal-position extractors, exactly as the task names them:
//   - `label:"..."` / `label:'...'` object-literal properties;
//   - a static HTML text node, `>text<`, inside a source string literal.
// Both operate on the raw file TEXT (these files are never parsed as real
// ESM by this test — see the files' own `// @ts-nocheck` + client.mjs's
// comment on why). Interpolated/dynamic fragments (containing `+`, `${`, or
// no letters at all — icons, counts, punctuation-only glyphs) are excluded:
// they are not literal, static label text, and isProhibitedLabel would only
// ever see the STATIC half of a concatenation at runtime regardless.
const LABEL_PROPERTY_PATTERN = /\blabel\s*:\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
const HTML_TEXT_NODE_PATTERN = />([^<>{}\n]+)</g;

function isLiteralCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false; // icon glyphs, mono counts, bullets
  if (/[+`]/.test(trimmed)) return false; // a leftover concatenation operator
  if (/\{|\}/.test(trimmed)) return false; // a leftover template/placeholder brace
  return true;
}

function extractLiterals(source) {
  const found = new Set();
  for (const match of source.matchAll(LABEL_PROPERTY_PATTERN)) {
    const text = match[2];
    if (isLiteralCandidate(text)) found.add(text);
  }
  for (const match of source.matchAll(HTML_TEXT_NODE_PATTERN)) {
    const text = match[1];
    if (isLiteralCandidate(text)) found.add(text.trim());
  }
  return [...found];
}

test('MNT-EVD-006/007: no client label/button/heading literal is prohibited', () => {
  const violations = [];
  for (const file of CLIENT_FILES) {
    const source = readClient(file);
    for (const literal of extractLiterals(source)) {
      if (isProhibitedLabel(literal)) violations.push(`${file}: ${JSON.stringify(literal)}`);
    }
  }
  assert.deepEqual(violations, [], `prohibited label literal(s) found:\n${violations.join('\n')}`);
});

test('MNT-EVD-006: extractor is not vacuous (finds real, allowed literals)', () => {
  const source = readClient('maintenance-filters.mjs');
  const literals = extractLiterals(source);
  assert.ok(literals.includes('Refine'), `expected to find "Refine" among ${JSON.stringify(literals)}`);
  assert.ok(literals.includes('Clear all'));
});

// The Refresh-evidence rename introduced two labels the extractor structurally
// cannot see: "Refresh evidence"/"Refreshing evidence…" are assigned via a
// plain JS ternary (`button.textContent=busy?...:...`), not a `label:`
// property or a static HTML text node, and "Re-measure machine" lives only in
// page.mjs's server-rendered markup, which this file does not scan at all.
// Assert them directly so a future rename cannot silently reintroduce a
// prohibited word here without any test noticing.
test('MNT-EVD-006: the Refresh evidence / Re-measure machine controls carry no prohibited label', () => {
  for (const label of ['Refresh evidence', 'Refreshing evidence…', 'Re-measure machine']) {
    assert.equal(isProhibitedLabel(label), false, label);
  }
});

// (b) The copied label maps in maintenance-workspace.mjs must equal
// model.mjs's real exports byte-for-byte. Rather than re-parsing the client
// source into a JS value (its `var NAME={...};` object literals use
// unquoted keys, unlike model.mjs's `{ 'key': ... }` style, so a textual
// diff would be brittle), this evaluates the client file's own source AS
// CODE, in THIS realm (a `new Function` body, not `vm.createContext` — a
// separate vm context is a separate realm with its own Object.prototype,
// which makes assert.deepEqual see even byte-identical plain objects as
// "not reference-equal"), and reads the resulting bindings back out.
function loadClientBindings(names) {
  const source = readClient('maintenance-workspace.mjs')
    // Strip the two cross-file import lines this file carries — this test
    // only needs its OWN top-level `var`/label declarations, not `esc` or
    // `ago` from the sibling modules those imports would otherwise require.
    .replace(/^import \{[^}]*\} from '\.\/[^']+\.mjs';\r?\n/gm, '')
    .replace(/^(\s*)export (?=(function|var)\b)/gm, '$1');
  const body = `${source}\nreturn {${names.map((name) => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`).join(',')}};`;
  const run = new Function('authHeaders', 'esc', 'ago', body);
  return run(() => ({}), (s) => String(s), () => '');
}

test('MNT-EVD-006: maintenance-workspace.mjs label maps equal model.mjs verbatim', () => {
  const bindings = loadClientBindings([
    'MNT_SCOPE_LABELS', 'MNT_RESOURCE_KIND_LABELS', 'MNT_GUIDANCE_LANE_LABELS',
    'MNT_INVENTORY_GROUP_LABELS', 'MNT_CURATED_VIEW_LABELS', 'MNT_CONFLICT_EXPLANATIONS',
    'MNT_CREDENTIAL_READINESS_LABELS', 'MNT_SOURCE_COVERAGE_LABELS', 'MNT_AUDIT_RESULT_LABELS',
    'MNT_RECONCILE_OUTCOME_LABELS', 'MNT_AUDIT_ACTION_LABEL', 'MNT_NO_ACTION_REQUESTED_DETAIL',
    'MNT_NO_CORRECTIVE_ACTION', 'MNT_SOURCE_SCAN_INCOMPLETE',
  ]);
  assert.deepEqual(bindings.MNT_SCOPE_LABELS, SCOPE_LABELS);
  assert.deepEqual(bindings.MNT_RESOURCE_KIND_LABELS, RESOURCE_KIND_LABELS);
  assert.deepEqual(bindings.MNT_GUIDANCE_LANE_LABELS, GUIDANCE_LANE_LABELS);
  assert.deepEqual(bindings.MNT_INVENTORY_GROUP_LABELS, INVENTORY_GROUP_LABELS);
  assert.deepEqual(bindings.MNT_CURATED_VIEW_LABELS, CURATED_VIEW_LABELS);
  assert.deepEqual(bindings.MNT_CONFLICT_EXPLANATIONS, CONFLICT_EXPLANATIONS);
  assert.deepEqual(bindings.MNT_CREDENTIAL_READINESS_LABELS, CREDENTIAL_READINESS_LABELS);
  assert.deepEqual(bindings.MNT_SOURCE_COVERAGE_LABELS, SOURCE_COVERAGE_LABELS);
  assert.deepEqual(bindings.MNT_AUDIT_RESULT_LABELS, AUDIT_RESULT_LABELS);
  assert.deepEqual(bindings.MNT_RECONCILE_OUTCOME_LABELS, RECONCILE_OUTCOME_LABELS);
  assert.equal(bindings.MNT_AUDIT_ACTION_LABEL, AUDIT_ACTION_LABEL);
  assert.equal(bindings.MNT_NO_ACTION_REQUESTED_DETAIL, NO_ACTION_REQUESTED_DETAIL);
  assert.equal(bindings.MNT_NO_CORRECTIVE_ACTION, NO_CORRECTIVE_ACTION);
  assert.equal(bindings.MNT_SOURCE_SCAN_INCOMPLETE, SOURCE_SCAN_INCOMPLETE);
});
