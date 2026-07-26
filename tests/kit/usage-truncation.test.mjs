import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession, maskSecrets, MAX_TURN_CHARS, _resetForTest } from '../../src/lib/usage-index.mjs';

// ADR-0009 §8 / design decision 2 — "turn truncation is announced, with both
// figures". A truncated turn must say HOW MUCH was withheld, not merely that
// something was. A reader who cannot tell 1% loss from 90% loss has been told
// nothing actionable, which is the shape of an evidence claim §6 would refuse.
//
// `MAX_TURN_CHARS` is IMPORTED, not mirrored, which matches the sibling
// judgement-call constant: `IDLE_GAP_MS` is exported one line above it
// (usage-index.mjs:45) for the reason ADR-0009 §4 gives — "a judgement call the
// numbers depend on, not a magic constant." MAX_TURN_CHARS is that too: the
// truncation badge states user-visible figures derived from it.
//
// The import buys the boundary tests below their real property — they test that
// the limit is INCLUSIVE, against whatever the limit currently is. What it costs
// is the ability to notice the limit MOVING, and that loss is total: with the
// constant imported, `prose(MAX)` and `prose(MAX + 1)` are defined in terms of
// the same value the implementation uses, so every test here passes for any
// value whatsoever. Verified, not assumed — setting the constant to 60_000 in a
// scratch copy leaves all six green.
//
// So the value is pinned separately, once, immediately below. Semantics are
// tested against the constant; the constant is tested against the spec. Neither
// job is left to the other.

test('MAX_TURN_CHARS is the 40,000 the spec states', () => {
  // The ONLY assertion in this file that would notice the limit moving. Design
  // decision 2 and ADR-0009 §8 state 40,000 explicitly, and the truncation badge
  // renders figures derived from it ("40.0K of 128.4K shown"), so the value is
  // part of the user-visible contract rather than a tuning knob. Changing it is
  // allowed — the ADR says re-litigating the number is out of scope for THIS
  // work, not forever — but it must be a deliberate edit here, not a silent one.
  assert.equal(MAX_TURN_CHARS, 40_000);
});

/** A sandbox with no fixture corpus: one hand-written session is the whole answer. */
function soloSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-trunc-'));
  const claude = path.join(dir, 'claude', '-Users-me-proj');
  fs.mkdirSync(claude, { recursive: true });
  return {
    dir,
    claude,
    roots: { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex') },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

const opts = (sb) => ({ roots: sb.roots, cachePath: sb.cachePath });

/** Write a Claude session whose FIRST turn carries exactly `text`. */
function writeSession(sb, id, text) {
  fs.writeFileSync(path.join(sb.claude, `${id}.jsonl`), [
    JSON.stringify({
      type: 'user', sessionId: id, cwd: '/Users/me/proj',
      timestamp: '2026-07-24T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: id, cwd: '/Users/me/proj',
      timestamp: '2026-07-24T10:01:00.000Z',
      message: {
        role: 'assistant', model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'short reply' }],
      },
    }),
  ].join('\n') + '\n');
}

/** Ordinary prose of exactly `n` characters. Word-shaped on purpose: a long run
 *  of base64-ish characters would trip a secret pattern, and this helper's whole
 *  job is to produce text whose masked length equals its raw length. */
function prose(n) {
  return 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil(n / 44)).slice(0, n);
}

/** Read one session and return its first turn. */
async function firstTurn(sb, id) {
  _resetForTest();
  const out = await readSession(id, opts(sb));
  assert.ok(out, `session ${id} was not readable`);
  return out.turns[0];
}

// ── the signal ──────────────────────────────────────────────────────────────

test('a truncated turn reports originalChars alongside truncated', async () => {
  const sb = soloSandbox();
  const text = prose(MAX_TURN_CHARS + 5_000);
  // Guard: masking must be a no-op here, or this test would be measuring the
  // masker rather than the truncator.
  assert.equal(maskSecrets(text).length, text.length, 'fixture prose must survive masking unchanged');
  writeSession(sb, 'trunc-over', text);

  const turn = await firstTurn(sb, 'trunc-over');
  assert.equal(turn.truncated, true, 'a turn over the limit is truncated');
  assert.equal(turn.originalChars, MAX_TURN_CHARS + 5_000,
    'originalChars states how much text existed before the slice');
  assert.ok(turn.text.length < turn.originalChars,
    'the rendered text is shorter than the figure it reports — otherwise nothing was withheld');
});

test('originalChars is the length of the MASKED text, not of the raw file text', async () => {
  // ADR-0009 §8: masking runs BEFORE the length is taken (usage-index.mjs:1052),
  // so originalChars measures what truncation withheld, never what masking did.
  // Reading it as a raw-file length would overstate or understate the loss by
  // whatever the redaction happened to change.
  const sb = soloSandbox();
  const secret = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
  const raw = `${prose(MAX_TURN_CHARS + 1)} ${secret}`;
  const masked = maskSecrets(raw);
  // Guard: the two lengths must actually differ, or the assertion below proves
  // nothing about which one was measured.
  assert.notEqual(masked.length, raw.length, 'fixture must make masking change the length');
  assert.ok(masked.length > MAX_TURN_CHARS, 'the masked text must still exceed the limit');
  writeSession(sb, 'trunc-masked', raw);

  const turn = await firstTurn(sb, 'trunc-masked');
  assert.equal(turn.truncated, true);
  assert.equal(turn.originalChars, masked.length, 'the post-masking length is the reported figure');
  assert.notEqual(turn.originalChars, raw.length, 'the raw-file length must not be what is reported');
});

// ── the marker is a cross-module contract ───────────────────────────────────

test('a truncated turn ends with the exact marker the renderer subtracts', async () => {
  // This string is a REAL contract between this producer and the transcript
  // renderer, and until now nothing tested it.
  //
  // The dashboard's client JS is a string literal embedded in the served HTML,
  // so the browser never imports usage-index.mjs and `MAX_TURN_CHARS` genuinely
  // cannot reach it — exporting the constant did not change that. Rather than
  // hardcode 40000 on the far side (which would desync the day the constant
  // moves), the truncation badge derives the shown figure by subtracting this
  // marker from the received text length. So a change to the marker does not
  // break the renderer loudly; it makes the badge overstate by the length
  // delta, which is a false user-visible figure of exactly the kind ADR-0009 §6
  // refuses. Pinned here because this side owns the string.
  const MARKER = '\n…[truncated]';
  const sb = soloSandbox();
  writeSession(sb, 'trunc-marker', prose(MAX_TURN_CHARS + 2_000));

  const turn = await firstTurn(sb, 'trunc-marker');
  assert.ok(turn.text.endsWith(MARKER), `truncated text must end with ${JSON.stringify(MARKER)}`);
  assert.equal(
    turn.text.length - MARKER.length, MAX_TURN_CHARS,
    'the renderer computes shown-characters exactly this way — a marker of a different '
    + 'length silently shifts every truncation badge',
  );
  // Once only: a duplicated marker would double the renderer's subtraction.
  assert.equal(turn.text.split(MARKER).length - 1, 1, 'the marker appears exactly once');
});

// ── absence is the signal ───────────────────────────────────────────────────

test('an untruncated turn carries no originalChars key at all', async () => {
  // Presence of the field IS the signal, so a consumer cannot misread a
  // full-length turn as a truncated one. `undefined` would not do: `'x' in obj`
  // is the only check that distinguishes "not truncated" from "truncated by an
  // amount we failed to record".
  const sb = soloSandbox();
  writeSession(sb, 'trunc-under', prose(1_000));

  const turn = await firstTurn(sb, 'trunc-under');
  assert.equal('originalChars' in turn, false, 'no originalChars on a whole turn');
});

test('an untruncated turn carries no truncated key either', async () => {
  // Design decision 2: "Neither key present on turns that were not truncated."
  // A `truncated: false` on every turn makes the flag ambient rather than
  // meaningful, and pays for it in every transcript payload.
  const sb = soloSandbox();
  writeSession(sb, 'trunc-under2', prose(1_000));

  const turn = await firstTurn(sb, 'trunc-under2');
  assert.equal('truncated' in turn, false, 'no truncated flag on a whole turn');
});

// ── the boundary ────────────────────────────────────────────────────────────

test('a turn of exactly MAX_TURN_CHARS is not truncated', async () => {
  const sb = soloSandbox();
  const text = prose(MAX_TURN_CHARS);
  assert.equal(maskSecrets(text).length, MAX_TURN_CHARS, 'fixture is exactly at the limit after masking');
  writeSession(sb, 'trunc-exact', text);

  const turn = await firstTurn(sb, 'trunc-exact');
  assert.equal(turn.text.length, MAX_TURN_CHARS, 'the boundary is inclusive: the whole turn is rendered');
  assert.notEqual(turn.truncated, true, 'nothing was cut, so nothing is announced');
  assert.equal('truncated' in turn, false);
  assert.equal('originalChars' in turn, false);
});

test('a turn one character over MAX_TURN_CHARS is truncated and reports it', async () => {
  const sb = soloSandbox();
  const text = prose(MAX_TURN_CHARS + 1);
  assert.equal(maskSecrets(text).length, MAX_TURN_CHARS + 1);
  writeSession(sb, 'trunc-plus1', text);

  const turn = await firstTurn(sb, 'trunc-plus1');
  assert.equal(turn.truncated, true, 'one character over is over');
  assert.equal(turn.originalChars, MAX_TURN_CHARS + 1);
});
