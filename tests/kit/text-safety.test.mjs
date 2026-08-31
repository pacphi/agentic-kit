// text-safety.mjs owns ONE definition of the characters that must never reach
// a terminal, a store, or the DOM — and then five hand-written copies of that
// list exist anyway, because every function in the dashboard's client modules
// is re-serialized into the browser bundle by its own source text and so
// cannot import anything.
//
// Security review SEC-16: nothing compared any copy against the canonical
// list. They agreed at the time (a full-BMP sweep found no mismatch), and
// `client.mjs`'s `inject()` pins two of them byte-wise against each other —
// but widening `text-safety.mjs` would have silently left every dashboard copy
// behind with no test failing. That is precisely the drift the module's own
// header says it exists to prevent, so this file is the thing that prevents
// it: one test, every copy, against the canonical array.
//
// The sixth consumer, `adapters/manifest.mjs`, is deliberately NOT a copy —
// see its own comment — so it is asserted as a SUPERSET instead of an equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UNSAFE_RANGES, hasUnsafeChars, stripUnsafeChars } from '../../src/lib/text-safety.mjs';
import { esc as groupsEsc } from '../../src/lib/dashboard/groups.mjs';
import { hasUnsafeControl } from '../../src/lib/adapters/manifest.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** Every file carrying a hand-written copy of the range list, and where it
 *  came from. If a new copy is added without being listed here, the bundle
 *  test's `function esc(` count and `client.mjs`'s `inject()` are the backstop
 *  — but adding it here is what keeps it honest. */
const COPIES = [
  ['src/lib/dashboard/groups.mjs', 'the real escaper, injected into the bundle'],
  ['src/lib/dashboard/client.mjs', "RHYTHM_ESC — the strip-target for the two on-disk copies"],
  ['src/lib/dashboard/client/usage-rhythm.mjs', 'on-disk copy, for the direct-import tests'],
  ['src/lib/dashboard/client/usage-prompts.mjs', 'on-disk copy, for the direct-import tests'],
  ['src/lib/dashboard/live/client.mjs', 'the live view escaper (SEC-15)'],
];

/** The canonical list, flattened the way every copy writes it. */
const CANONICAL_FLAT = UNSAFE_RANGES.flat();

/** Pull the numeric range array out of a copy's source. Every copy writes it
 *  as a flat `[0x00, 0x08, …]` literal, which is why they can be compared
 *  without parsing JavaScript. */
function rangeArrayIn(source) {
  const match = source.match(/\[\s*0x00\s*,\s*0x08\s*(?:,\s*0x[0-9a-f]+\s*)+\]/i);
  return match ? match[0].replace(/[[\]\s]/g, '').split(',').map(Number) : null;
}

test('SEC-16: every hand-written copy of the unsafe ranges matches the canonical list', () => {
  for (const [rel, why] of COPIES) {
    const found = rangeArrayIn(read(rel));
    assert.ok(found, `${rel} (${why}): no numeric range array found — did the copy change shape?`);
    assert.deepEqual(found, CANONICAL_FLAT,
      `${rel} (${why}) has drifted from text-safety.mjs's UNSAFE_RANGES`);
  }
});

test('SEC-16: the canonical list and every copy agree across the whole BMP, not just on paper', () => {
  // Behavioural, not textual: compiles each copy's ranges and compares the
  // classification of every BMP codepoint against `hasUnsafeChars`. A copy
  // written in a different but equivalent form still passes; one that is
  // equivalent-looking but wrong does not.
  for (const [rel, why] of COPIES) {
    const flat = rangeArrayIn(read(rel));
    let cls = '';
    for (let i = 0; i < flat.length; i += 2) {
      cls += `${String.fromCharCode(flat[i])}-${String.fromCharCode(flat[i + 1])}`;
    }
    const copyRe = new RegExp(`[${cls}]`);
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      assert.equal(copyRe.test(ch), hasUnsafeChars(ch),
        `${rel} (${why}) disagrees about U+${code.toString(16).padStart(4, '0')}`);
    }
  }
});

test('SEC-16: the manifest validator rejects everything text-safety does, and more', () => {
  // NOT an equality assertion, on purpose. A manifest field is an identifier,
  // so its own rule also refuses TAB and LF, which are legitimate in the prose
  // text-safety guards. Folding the two together would LOOSEN a security
  // validator, so the relationship is what gets pinned.
  const extras = [];
  for (let code = 0; code <= 0xffff; code++) {
    const ch = String.fromCharCode(code);
    if (hasUnsafeChars(ch)) {
      assert.equal(hasUnsafeControl(ch), true,
        `manifest.mjs accepts U+${code.toString(16).padStart(4, '0')}, which text-safety.mjs rejects`);
    } else if (hasUnsafeControl(ch)) {
      extras.push(code);
    }
  }
  assert.deepEqual(extras, [0x09, 0x0a],
    'the manifest rule may be stricter, but only in the documented way: TAB and LF');
});

test('the widened ranges cover the Unicode line separators', () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  assert.equal(hasUnsafeChars(`a${LS}b`), true, 'U+2028 LINE SEPARATOR');
  assert.equal(hasUnsafeChars(`a${PS}b`), true, 'U+2029 PARAGRAPH SEPARATOR');
  assert.equal(stripUnsafeChars(`a${LS}b${PS}c`), 'abc');
  // The reason they were added: every single-line check in this codebase tests
  // for CR/LF, which these two pass.
  assert.equal(/[\r\n]/.test(LS), false, 'which is exactly why the newline check alone was not enough');
});

test('tab and newline remain legal, because prose needs them', () => {
  assert.equal(hasUnsafeChars('a\tb\nc'), false);
  assert.equal(stripUnsafeChars('a\tb\nc'), 'a\tb\nc');
  assert.equal(groupsEsc('a\tb\nc'), 'a\tb\nc');
});

test('SEC-15: the live view escaper strips control and bidi codepoints from transcript text', () => {
  // The live bundle renders raw transcript turn content, and
  // dashboard-server.mjs's own CSP comment calls transcript text "the one data
  // source here that is genuinely attacker-influenced". Nothing upstream
  // strips it: session-security.mjs's maskTurns applies maskSecrets only. The
  // seat measured 5 unsafe codepoints surviving this exact payload.
  const line = read('src/lib/dashboard/live/client.mjs')
    .split('\n').find((l) => l.trim().startsWith('function esc(s){'));
  assert.ok(line, 'guard: the live escaper must still be a single-line function declaration');
  const liveEsc = new Function(`return (${line.trim().replace(/^function esc/, 'function')});`)();

  const CH = (code) => String.fromCharCode(code);
  const hostile = `a${CH(0x1b)}]0;pwned${CH(0x07)}${CH(0x9b)}${CH(0x00)}${CH(0x202e)}<b>&"x"</b>`;
  const out = liveEsc(hostile);
  for (let code = 0; code <= 0xffff; code++) {
    if (!hasUnsafeChars(CH(code))) continue;
    assert.ok(!out.includes(CH(code)),
      `U+${code.toString(16).padStart(4, '0')} survived into the live transcript DOM`);
  }
  assert.ok(out.includes('&lt;b&gt;') && out.includes('&amp;') && out.includes('&quot;'),
    'and the five HTML metacharacters are still escaped, as before');
});
