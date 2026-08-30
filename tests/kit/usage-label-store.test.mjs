// usage-label-store.mjs — persistence for layer-3 enrichment artifacts (spec
// §6.3): cluster LABELS (usage-prompt-vocabulary.mjs's `{name, source,
// firstSeen}` contract) and synthesized coaching CARD content, in one
// versioned file beside the outcome ledger. Discipline mirrored from
// usage-outcome-ledger.mjs's own tests (Fix round 1, I-2): corrupt/missing →
// blank and safe to overwrite; a well-formed but NEWER version → reported
// distinctly (`future: true`) and never destroyed; atomic tmp+rename write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadLabelStore, saveLabelStore, defaultLabelStorePath, isValidLabelName,
  LABEL_STORE_SCHEMA_VERSION,
} from '../../src/lib/usage-label-store.mjs';

function tmpFile(name = 'labels.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-label-store-'));
  return path.join(dir, name);
}

// ── defaultLabelStorePath ───────────────────────────────────────────────────

test('defaultLabelStorePath sits beside the usage-index cache path convention (same config dir, its own file name)', () => {
  const file = defaultLabelStorePath();
  assert.match(file, /usage-prompt-labels\.json$/);
  assert.match(file, /agentic-kit/, 'lives under the kit\'s own config dir, same as the outcome ledger');
});

// ── load: fresh / corrupt / current / future ────────────────────────────────

test('a fresh/missing store loads at the current schema version with empty labels and cards', () => {
  const file = tmpFile();
  const store = loadLabelStore(file);
  assert.deepEqual(store, {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: null,
  });
});

test('a corrupt/unparseable file loads as blank — safe to overwrite, nothing recoverable', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not valid json at all');
  const store = loadLabelStore(file);
  assert.deepEqual(store, {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: null,
  });
  assert.equal(store.future, undefined);
});

test('a recognizable but malformed file (no labels/cards objects) also reads as corrupt, not future', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: LABEL_STORE_SCHEMA_VERSION, labels: 'nope' }));
  const store = loadLabelStore(file);
  assert.deepEqual(store, {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: null,
  });
  assert.equal(store.future, undefined);
});

test('loadLabelStore reads the CURRENT version normally, with no future flag', () => {
  const file = tmpFile();
  const seeded = {
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { abc123: { name: 'Release ritual (renamed)', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' } },
    cards: {
      'enriched-foo': {
        title: 'Foo', finding: 'Bar happened 3 times.', try: 'Do X.', basis: '3 occurrences.',
        basisNumbers: [3], evidenceHash: 'a'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
    },
    lastSynthesis: { findingsHash: 'd'.repeat(16), at: '2026-08-01T00:00:00.000Z' },
  };
  fs.writeFileSync(file, JSON.stringify(seeded));
  const store = loadLabelStore(file);
  assert.deepEqual(store, seeded);
  assert.equal(store.future, undefined);
});

test('loadLabelStore reads a store written before lastSynthesis existed as lastSynthesis: null, not a crash', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { abc123: { name: 'Pre-upgrade label', source: 'enriched', firstSeen: '2026-01-01T00:00:00.000Z' } },
    cards: {},
  }));
  const store = loadLabelStore(file);
  assert.equal(store.lastSynthesis, null);
  assert.deepEqual(Object.keys(store.labels), ['abc123'], 'pre-existing labels survive the upgrade untouched');
});

test('loadLabelStore reports a well-formed FUTURE version distinctly from a corrupt one, and never destroys it', () => {
  const file = tmpFile();
  const futureStore = {
    version: LABEL_STORE_SCHEMA_VERSION + 1,
    labels: { zzz: { name: 'Something a newer ak wrote', source: 'enriched', firstSeen: '2027-01-01T00:00:00.000Z' } },
    cards: {},
  };
  fs.writeFileSync(file, JSON.stringify(futureStore));
  const loaded = loadLabelStore(file);
  assert.equal(loaded.future, true);
  assert.equal(loaded.version, LABEL_STORE_SCHEMA_VERSION + 1);
  assert.deepEqual(loaded.labels, futureStore.labels, 'the future labels must be reported, not discarded');
  // The file on disk must be untouched by the read.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), futureStore);
});

// ── Fix round 2, I-8/M-8: load-side sanitization ────────────────────────────
// loadLabelStore used to return raw.labels/raw.cards VERBATIM — the same
// entry validation saveLabelStore has always applied on write never ran on
// read. This build never WRITES a malformed entry, so reaching one required
// an out-of-band edit, a hand-recovered file, another build, or corruption
// that still parses as JSON — but when it happened, a card missing
// basisNumbers reached isCardStale (which deliberately THROWS for that
// shape) and crashed the whole command, `--enrich` or not (I-8); and a label
// entry with a blank name still read back as a real store entry, so
// labelCandidates' bare-key-presence check permanently excluded its cluster
// from ever being offered to enrichLabels again (M-8).

test('loadLabelStore drops a card entry missing basisNumbers rather than returning it verbatim (I-8), and counts the drop', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: {},
    cards: {
      'enriched-broken': {
        title: 'Broken card', finding: 'Something happened.', try: 'Do X.', basis: 'Some basis.',
        // basisNumbers deliberately absent — the exact shape isCardStale throws on.
        evidenceHash: 'a'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
      'enriched-fine': {
        title: 'Fine card', finding: 'This happened 3 times.', try: 'Do Y.', basis: '3 occurrences.',
        basisNumbers: [3], evidenceHash: 'b'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
    },
  }));
  const loaded = loadLabelStore(file);
  assert.deepEqual(Object.keys(loaded.cards), ['enriched-fine'], 'the malformed card is dropped; the well-formed sibling survives');
  assert.equal(loaded.dropped?.cards, 1);
  assert.equal(loaded.dropped?.labels, 0);
});

test('loadLabelStore drops a label entry with a blank name rather than returning it verbatim (M-8), and counts the drop', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: {
      blankname: { name: '', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' },
      k1: { name: 'A real label', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' },
    },
    cards: {},
  }));
  const loaded = loadLabelStore(file);
  assert.deepEqual(Object.keys(loaded.labels), ['k1'], 'the blank-name entry is dropped; the well-formed sibling survives');
  assert.equal(loaded.dropped?.labels, 1);
  assert.equal(loaded.dropped?.cards, 0);
  // M-8's actual failure mode: the orphaned key must read back as absent —
  // labelCandidates' `!store?.[c.key]` clause needs `undefined` here, not a
  // truthy-but-useless entry, or the cluster stays permanently excluded.
  assert.equal(loaded.labels.blankname, undefined);
});

test('loadLabelStore reports no `dropped` key at all when nothing was invalid — matching the optional `future` convention', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { k1: { name: 'Fine', source: 'curated', firstSeen: null } },
    cards: {},
  }));
  const loaded = loadLabelStore(file);
  assert.equal('dropped' in loaded, false, 'a happy-path load must not grow a new key every caller has to account for');
});

test('a dropped entry is never resurrected: the on-disk file after a save reflects only what loadLabelStore actually returned', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { blankname: { name: '', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' } },
    cards: {
      'enriched-broken': {
        title: 'Broken', finding: 'X happened.', try: 'Do X.', basis: 'X basis.',
        evidenceHash: 'a'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
    },
  }));
  const loaded = loadLabelStore(file);
  // The exact merge shape runEnrichPass uses: spread the loaded store,
  // possibly add new entries (none here — simulating a pass that found
  // nothing new to label/synthesize), then save.
  saveLabelStore(file, { version: loaded.version, labels: { ...loaded.labels }, cards: { ...loaded.cards } });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.labels, {}, 'the blank-name label must not reappear after a save that only ever saw the sanitized load');
  assert.deepEqual(onDisk.cards, {}, 'the malformed card must not reappear either');
});

test('loadLabelStore sanitizes a FUTURE-version store\'s labels/cards too, not only the current version', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: LABEL_STORE_SCHEMA_VERSION + 1,
    labels: {
      blankname: { name: '', source: 'enriched', firstSeen: '2027-01-01T00:00:00.000Z' },
      zzz: { name: 'Something a newer ak wrote', source: 'enriched', firstSeen: '2027-01-01T00:00:00.000Z' },
    },
    cards: {},
  }));
  const loaded = loadLabelStore(file);
  assert.equal(loaded.future, true);
  assert.deepEqual(Object.keys(loaded.labels), ['zzz'], 'a malformed entry is dropped even under a future schema — it is never re-saved either way');
  assert.equal(loaded.dropped?.labels, 1);
});

// ── save: atomic write ──────────────────────────────────────────────────────

test('saveLabelStore writes atomically: the final file is valid JSON at the right version, and no tmp file is left behind', () => {
  const file = tmpFile();
  saveLabelStore(file, { version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {} });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, LABEL_STORE_SCHEMA_VERSION);
  const siblings = fs.readdirSync(path.dirname(file));
  assert.ok(!siblings.some((n) => n.includes('.tmp')), `a tmp file was left behind: ${siblings}`);
});

test('saveLabelStore overwrites a prior version cleanly (round-trips through loadLabelStore)', () => {
  const file = tmpFile();
  saveLabelStore(file, { version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {} });
  const next = {
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { k1: { name: 'Named cluster', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' } },
    cards: {},
    lastSynthesis: null,
  };
  saveLabelStore(file, next);
  assert.deepEqual(loadLabelStore(file), next);
});

// Fix round 1, I-1(a): lastSynthesis round-trips, and a malformed one is
// dropped to null rather than persisted — the same drop-not-fabricate
// discipline every other entry in this store gets.
test('saveLabelStore round-trips a real lastSynthesis record', () => {
  const file = tmpFile();
  const record = { findingsHash: 'e'.repeat(16), at: '2026-08-30T00:00:00.000Z' };
  saveLabelStore(file, {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: record,
  });
  assert.deepEqual(loadLabelStore(file).lastSynthesis, record);
});

test('saveLabelStore drops a malformed lastSynthesis (missing findingsHash/at) to null rather than persisting garbage', () => {
  const file = tmpFile();
  saveLabelStore(file, {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: { findingsHash: 'only-one-field' },
  });
  assert.equal(loadLabelStore(file).lastSynthesis, null);
});

test('saveLabelStore creates its parent directory when it does not exist yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-label-store-'));
  const file = path.join(dir, 'nested', 'deeper', 'labels.json');
  saveLabelStore(file, { version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {} });
  assert.ok(fs.existsSync(file));
});

// ── isValidLabelName: the shared invariant (store AND usage-enrich.mjs) ────

test('isValidLabelName accepts 1..48 trimmed characters with no newline', () => {
  assert.equal(isValidLabelName('a'), true);
  assert.equal(isValidLabelName('x'.repeat(48)), true);
  assert.equal(isValidLabelName('  Release ritual  '), true, 'surrounding whitespace trims to something real');
});

test('isValidLabelName rejects empty, whitespace-only, oversize, or newline-bearing names', () => {
  assert.equal(isValidLabelName(''), false);
  assert.equal(isValidLabelName('   '), false, 'empty after trim');
  assert.equal(isValidLabelName('x'.repeat(49)), false, 'one over the 48-char ceiling');
  assert.equal(isValidLabelName('two\nlines'), false);
  assert.equal(isValidLabelName('carriage\rreturn'), false);
  assert.equal(isValidLabelName(null), false);
  assert.equal(isValidLabelName(undefined), false);
  assert.equal(isValidLabelName(42), false, 'not even a string');
});

// Fix round 1, M-2: the length check already reads `trimmed`; the newline
// check must too, or a name whose ONLY newline is leading/trailing
// whitespace a trim would remove anyway (what every caller actually stores —
// enrichLabels' `item.name.trim()`) is rejected for whitespace that will
// never reach disk. A newline INSIDE the trimmed text must still fail.
test('isValidLabelName is consistent about trimming: a leading/trailing newline is fine, an interior one is not', () => {
  assert.equal(isValidLabelName('Release ritual\n'), true, 'a trailing newline a trim removes must not fail validation');
  assert.equal(isValidLabelName('\nRelease ritual'), true, 'same for a leading one');
  assert.equal(isValidLabelName('  Release ritual\n  '), true, 'surrounding whitespace plus a trailing newline');
  assert.equal(isValidLabelName('Release\nritual'), false, 'an interior newline survives trimming and must still fail');
});

// ── INVARIANT (test-pinned, brief W5 deliverable 3): no label value ever
// contains a newline or > 48 chars; no exemplar text persisted anywhere ────

test('INVARIANT: saveLabelStore drops any label whose name violates the length/newline rule rather than persisting it', () => {
  const file = tmpFile();
  saveLabelStore(file, {
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: {
      good: { name: 'A fine name', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' },
      bad1: { name: 'x'.repeat(60), source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' },
      bad2: { name: 'two\nlines', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' },
    },
    cards: {},
  });
  const back = loadLabelStore(file);
  assert.deepEqual(Object.keys(back.labels), ['good'], 'only the structurally valid label survives the write');
});

// Card prose (finding/try/basis) is deliberately NOT held to the label's
// 48-char ceiling — "13 recurrences across 11 sessions, 9 days." is a normal
// basis string and every existing rule card's finding/basis text runs well
// past 48 characters (usage-coaching-rules.mjs). The invariant that DOES
// apply to every free-text field, label or card, is no embedded newline: a
// newline is how a rendered card/table row could grow an extra, unbounded
// line the caller never asked for.
test('INVARIANT: saveLabelStore drops any card whose title/finding/try/basis contains a newline', () => {
  const file = tmpFile();
  saveLabelStore(file, {
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: {},
    cards: {
      'enriched-good': {
        title: 'A perfectly normal title, well past 48 characters long on purpose',
        finding: 'Something recurred 13 times across 11 sessions and 9 days.',
        try: 'Try doing the obvious thing instead.', basis: '13 recurrences across 11 sessions, 9 days.',
        basisNumbers: [13, 11, 9], evidenceHash: 'a'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
      'enriched-bad': {
        title: 'has\na newline', finding: 'x', try: 'y', basis: 'z',
        basisNumbers: [1], evidenceHash: 'b'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
      },
    },
  });
  const back = loadLabelStore(file);
  assert.deepEqual(Object.keys(back.cards), ['enriched-good']);
});

test('INVARIANT walk: no string anywhere in a saved+reloaded store exceeds 48 chars in a name field or carries a newline in any field', () => {
  const file = tmpFile();
  const store = {
    version: LABEL_STORE_SCHEMA_VERSION,
    labels: { a: { name: 'Short label', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' } },
    cards: {
      'enriched-x': {
        title: 'A title', finding: 'A finding with the number 3 in it.', try: 'Try this.',
        basis: '3 occurrences.', basisNumbers: [3], evidenceHash: 'c'.repeat(16),
        generatedAt: '2026-08-01T00:00:00.000Z',
      },
    },
  };
  saveLabelStore(file, store);
  const back = loadLabelStore(file);
  const walk = (node) => {
    if (typeof node === 'string') { assert.ok(!node.includes('\n') && !node.includes('\r'), `newline in ${JSON.stringify(node)}`); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { for (const v of Object.values(node)) walk(v); }
  };
  walk(back);
  for (const entry of Object.values(back.labels)) assert.ok(entry.name.length <= 48);
});
