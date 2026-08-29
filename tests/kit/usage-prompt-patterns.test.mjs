// usage-prompt-patterns — the clustering library the Prompts view computes on
// (spec §3.2 panel 3, research findings §4). Everything here operates on
// FINGERPRINTS: no prompt text exists to test with, which is the point. The
// two load-bearing pins are (a) the bottom-k Jaccard estimator, checked against
// exact Jaccard on synthetic full sets, and (b) determinism — the same corpus
// must produce identical cluster keys and identical ordering on every scan,
// because the coaching cards hash these outputs (spec §6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKETCH_K,
  exactRepeatGroups,
  sketchJaccard,
  candidatePairs,
  nearDupClusters,
  classifyCluster,
  crossSessionClusters,
  reAskPairs,
  tapStats,
} from '../../src/lib/usage-prompt-patterns.mjs';
import {
  TOKEN_BANDS,
  LABEL_SOURCES,
  SEED_PATTERNS,
  tokenBand,
  characterize,
  labelFor,
} from '../../src/lib/usage-prompt-vocabulary.mjs';
import { MAX_TOKEN_HASHES } from '../../src/lib/usage-parsers.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

/** One decorated fingerprint. Defaults are deliberately boring; every test
 *  overrides only the fields it is about. */
const fp = (over = {}) => ({
  h: 'aaaa', t: 1, th: ['00000001'], p: 'human',
  sessionId: 's1', day: '2026-08-01', host: 'claude',
  ...over,
});

/** Deterministic PRNG (mulberry32) — the estimator pins must not flake. */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An 8-hex-char token hash, the same width `promptFingerprint` emits. */
const hex8 = (rnd) => Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0');

/** What the scan path stores: the sorted, deduplicated, bounded token set. */
const sketchOf = (set, k = SKETCH_K) => [...set].sort().slice(0, k);

function exactJaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The WRONG estimator this module exists to avoid: |A∩B|/|A∪B| computed over
 *  the two sketches as if they were the full token sets. */
function naiveSketchJaccard(A, B) {
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Structural comparison that survives Sets (assert.deepEqual handles Sets, but
 *  a stable string is what the determinism pins actually want to compare). */
function stable(value) {
  return JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v].sort() : v));
}

// ── the sketch capacity is not a second opinion ─────────────────────────────

test('SKETCH_K mirrors the scan path\'s MAX_TOKEN_HASHES', () => {
  // This module takes no runtime dependency on the parsers (it is pure), so the
  // capacity is restated here. That restatement is only safe if it is pinned:
  // a sketch read at the wrong k silently stops distinguishing "complete token
  // set" from "truncated sample", which is the whole basis of the estimator.
  assert.equal(SKETCH_K, MAX_TOKEN_HASHES);
});

// ── exactRepeatGroups ───────────────────────────────────────────────────────

test('exactRepeatGroups groups by h with session/day/host spans', () => {
  const groups = exactRepeatGroups([
    fp({ h: 'yes', t: 1, sessionId: 's1', day: '2026-08-01', host: 'claude' }),
    fp({ h: 'yes', t: 1, sessionId: 's2', day: '2026-08-02', host: 'codex' }),
    fp({ h: 'yes', t: 1, sessionId: 's2', day: '2026-08-02', host: 'codex' }),
    fp({ h: 'once', t: 9 }),
  ]);
  assert.equal(groups.length, 1);
  const [g] = groups;
  assert.equal(g.h, 'yes');
  assert.equal(g.count, 3);
  assert.equal(g.t, 1);
  assert.deepEqual([...g.sessions].sort(), ['s1', 's2']);
  assert.deepEqual([...g.days].sort(), ['2026-08-01', '2026-08-02']);
  assert.deepEqual([...g.hosts].sort(), ['claude', 'codex']);
});

test('exactRepeatGroups honours `min` and drops everything under it', () => {
  const fps = [fp({ h: 'a' }), fp({ h: 'a' }), fp({ h: 'b' })];
  assert.deepEqual(exactRepeatGroups(fps).map((g) => g.h), []);
  assert.deepEqual(exactRepeatGroups(fps, { min: 2 }).map((g) => g.h), ['a']);
  assert.deepEqual(exactRepeatGroups(fps, { min: 1 }).map((g) => g.h), ['a', 'b']);
});

test('exactRepeatGroups sorts count desc then h asc', () => {
  const fps = [
    ...Array.from({ length: 3 }, () => fp({ h: 'zeta' })),
    ...Array.from({ length: 5 }, () => fp({ h: 'beta' })),
    ...Array.from({ length: 3 }, () => fp({ h: 'alpha' })),
  ];
  assert.deepEqual(exactRepeatGroups(fps).map((g) => [g.h, g.count]), [
    ['beta', 5], ['alpha', 3], ['zeta', 3],
  ]);
});

test('exactRepeatGroups ignores malformed entries rather than throwing', () => {
  const fps = [fp({ h: 'a' }), fp({ h: 'a' }), fp({ h: 'a' }), null, {}, { h: 42 }];
  assert.deepEqual(exactRepeatGroups(fps).map((g) => g.count), [3]);
  assert.deepEqual(exactRepeatGroups(undefined), []);
});

// ── sketchJaccard ───────────────────────────────────────────────────────────

test('sketchJaccard is EXACT when neither sketch hit the capacity', () => {
  // Under the cap the stored `th` IS the token set, so there is nothing to
  // estimate — and estimating anyway would be badly wrong on short prompts,
  // which is most of this corpus.
  assert.equal(sketchJaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  assert.equal(sketchJaccard(['a'], ['a']), 1);
  assert.equal(sketchJaccard(['a'], ['b']), 0);
  // The degenerate case the KMV path would get wrong: a 1-token prompt inside a
  // 3-token one is J = 1/3, not 1.
  assert.equal(sketchJaccard(['a'], ['a', 'b', 'c']), 1 / 3);
});

test('sketchJaccard treats an empty or absent sketch as no similarity', () => {
  assert.equal(sketchJaccard([], ['a']), 0);
  assert.equal(sketchJaccard(['a'], []), 0);
  assert.equal(sketchJaccard([], []), 0);
  assert.equal(sketchJaccard(undefined, ['a']), 0);
  assert.equal(sketchJaccard(null, null), 0);
});

test('sketchJaccard is symmetric and tolerates unsorted / duplicated input', () => {
  assert.equal(sketchJaccard(['c', 'a', 'a', 'b'], ['b', 'c', 'd']), 0.5);
  assert.equal(sketchJaccard(['b', 'c', 'd'], ['c', 'a', 'a', 'b']), 0.5);
});

test('sketchJaccard estimates within 0.2 of exact Jaccard on truncated sketches', () => {
  // 50 random pairs of full token sets larger than the capacity, so both
  // sketches are genuine bottom-k samples. The spec's s.e. table puts the
  // standard error near 0.06 at k=64/J≈0.6; 0.2 is a deliberately generous
  // bound that still fails a wrong estimator.
  const rnd = mulberry32(20260829);
  let kmvTotal = 0, naiveTotal = 0, kmvWorst = 0;
  const PAIRS = 50;
  for (let i = 0; i < PAIRS; i++) {
    // UNEQUAL sizes on purpose: prompts differ in length, and that is exactly
    // where the naive reading of the sketches falls apart. The multiplier starts
    // at 2 — at `1 + rnd()*6` roughly a seventh of the pairs came out equal, and
    // equal-sized pairs are the case where the naive reading happens to agree,
    // so they dilute the very contrast this test exists to measure.
    const sizeA = 80 + Math.floor(rnd() * 200);
    const sizeB = sizeA * (2 + Math.floor(rnd() * 5));
    assert.ok(sizeB >= sizeA * 2, 'the fixture must actually build unequal-sized sets');
    const target = 0.2 + rnd() * 0.7;
    const shared = Math.min(sizeA, Math.round((target * (sizeA + sizeB)) / (1 + target)));
    const both = new Set();
    while (both.size < shared) both.add(hex8(rnd));
    const a = new Set(both), b = new Set(both);
    while (a.size < sizeA) a.add(hex8(rnd));
    while (b.size < sizeB) b.add(hex8(rnd));

    const exact = exactJaccard(a, b);
    const A = sketchOf(a), B = sketchOf(b);
    assert.equal(A.length, SKETCH_K, 'set A must exceed the capacity for this to test the estimator');
    assert.equal(B.length, SKETCH_K, 'set B must exceed the capacity for this to test the estimator');

    const kmvErr = Math.abs(sketchJaccard(A, B) - exact);
    kmvWorst = Math.max(kmvWorst, kmvErr);
    kmvTotal += kmvErr;
    naiveTotal += Math.abs(naiveSketchJaccard(A, B) - exact);
  }
  const kmvMAE = kmvTotal / PAIRS, naiveMAE = naiveTotal / PAIRS;
  assert.ok(kmvWorst <= 0.2, `worst KMV error ${kmvWorst.toFixed(3)} exceeded 0.2`);
  // The claim in the module doc, measured rather than asserted: the naive
  // estimator is not merely different, it is materially worse here.
  assert.ok(
    naiveMAE > kmvMAE * 1.5,
    `naive MAE ${naiveMAE.toFixed(4)} should be far worse than KMV ${kmvMAE.toFixed(4)}`,
  );
});

test('sketchJaccard handles one complete sketch against one truncated sketch', () => {
  // A 60-token prompt fully contained in a 1,000-token one: true J = 0.06. The
  // naive reading collapses this toward 0.03 because the long prompt's sketch
  // only covers the bottom ~6% of the hash range; KMV re-samples the union and
  // recovers it.
  const rnd = mulberry32(7);
  const big = new Set();
  while (big.size < 1000) big.add(hex8(rnd));
  const small = new Set([...big].sort().filter((_x, i) => i % 16 === 0).slice(0, 60));
  const A = sketchOf(small), B = sketchOf(big);
  assert.ok(A.length < SKETCH_K && B.length === SKETCH_K);
  const exact = exactJaccard(small, big);
  assert.ok(Math.abs(sketchJaccard(A, B) - exact) <= 0.2);
});

// ── candidatePairs (the comparison bound) ───────────────────────────────────

test('candidatePairs bounds the comparison set well under all-pairs', () => {
  // 300 prompts in 30 families of 10. Each family shares a distinctive token;
  // nothing else is shared, so a correct bucketing compares within families and
  // little else. All-pairs would be 44,850.
  const rnd = mulberry32(11);
  const fps = [];
  for (let f = 0; f < 30; f++) {
    const rare = `rare${String(f).padStart(4, '0')}`;
    for (let i = 0; i < 10; i++) {
      fps.push(fp({
        h: `h${f}-${i}`, t: 8,
        th: sketchOf(new Set([rare, ...Array.from({ length: 7 }, () => hex8(rnd))])),
      }));
    }
  }
  const pairs = candidatePairs(fps);
  assert.ok(pairs.length < 44850 * 0.1, `expected a bounded candidate set, got ${pairs.length}`);
  assert.ok(pairs.length >= 30 * 45, 'every family must still be compared internally');
  // Pairs are index pairs, i < j, unique.
  const seen = new Set();
  for (const [i, j] of pairs) {
    assert.ok(i < j, 'pairs are ordered');
    assert.ok(!seen.has(`${i}:${j}`), 'pairs are deduplicated');
    seen.add(`${i}:${j}`);
  }
});

test('candidatePairs drops prompts that share no token with anything', () => {
  // 200 same-length prompts with nothing in common. The length band would pair
  // every one of them (19,900 comparisons) for a guaranteed Jaccard of 0.
  const rnd = mulberry32(5);
  const fps = Array.from({ length: 200 }, (_v, i) => fp({
    h: `iso${i}`, t: 6, th: sketchOf(new Set(Array.from({ length: 6 }, () => hex8(rnd)))),
  }));
  assert.equal(candidatePairs(fps).length, 0);
  // The filter is exact, not a size heuristic: give two of them one token in
  // common and that pair comes straight back.
  const joined = [...fps];
  joined[0] = fp({ h: 'iso0', t: 6, th: sketchOf(new Set(['shared00', ...joined[0].th.slice(1)])) });
  joined[7] = fp({ h: 'iso7', t: 6, th: sketchOf(new Set(['shared00', ...joined[7].th.slice(1)])) });
  assert.deepEqual(candidatePairs(joined), [[0, 7]]);
});

test('candidatePairs falls back to a length band for prompts with no rare token', () => {
  // Three copies of a one-token prompt: the token is in 100% of the corpus, so
  // it is not rare and cannot bucket anything. Without the fallback these would
  // never be compared and the biggest cluster in the corpus (`yes`) would
  // vanish.
  const fps = [fp({ h: 'a', t: 1, th: ['ffff0001'] }), fp({ h: 'b', t: 1, th: ['ffff0001'] }), fp({ h: 'c', t: 1, th: ['ffff0001'] })];
  assert.equal(candidatePairs(fps).length, 3);
  // …and the band is ±1 token, so a far-longer prompt sharing nothing rare is
  // still not compared.
  const wide = [...fps, fp({ h: 'd', t: 40, th: ['ffff0001'] })];
  for (const [i, j] of candidatePairs(wide)) assert.ok(i < 3 && j < 3, 'the length band must exclude the outlier');
});

// ── nearDupClusters ─────────────────────────────────────────────────────────

/** Build a fingerprint whose token set is the given tokens. */
const withTokens = (h, tokens, over = {}) =>
  fp({ h, t: tokens.length, th: sketchOf(new Set(tokens)), ...over });

test('nearDupClusters joins fingerprints at or above the threshold only', () => {
  const near = withTokens('bbbb', ['t1', 't2', 't3', 't4', 't5']);
  const same = withTokens('aaaa', ['t1', 't2', 't3', 't4', 'zz']);   // J = 4/6 ≈ 0.67
  const twin = withTokens('cccc', ['t1', 't2', 't3', 't4', 't5']);   // J = 1
  const clusters = nearDupClusters([near, same, twin]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].hashes, ['bbbb', 'cccc']);
  // Loosen the threshold and the 0.67 neighbour joins.
  const loose = nearDupClusters([near, same, twin], { jaccard: 0.6 });
  assert.deepEqual(loose[0].hashes, ['aaaa', 'bbbb', 'cccc']);
});

test('nearDupClusters is transitive (union-find, not pairwise)', () => {
  // a~b and b~c at 0.8, but a~c is only 0.6 — union-find still yields ONE
  // cluster, which is what "loose clustering with the type filter supplying
  // precision" means in the spec.
  const base = Array.from({ length: 10 }, (_v, i) => `t${i}`);
  const a = withTokens('a', base);
  const b = withTokens('b', [...base.slice(1), 'x1']);
  const c = withTokens('c', [...base.slice(2), 'x1', 'x2']);
  assert.ok(sketchJaccard(a.th, c.th) < 0.8);
  const clusters = nearDupClusters([a, b, c], { jaccard: 0.8 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].hashes, ['a', 'b', 'c']);
});

test('nearDupClusters keys on the lexicographic minimum h and drops singletons', () => {
  const tokens = ['q1', 'q2', 'q3', 'q4'];
  const clusters = nearDupClusters([
    withTokens('zzz', tokens), withTokens('mmm', tokens), withTokens('lonely', ['u1', 'u2', 'u3', 'u4']),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].key, 'mmm');
  assert.equal(clusters[0].size, 2);
});

test('nearDupClusters carries spans, token stats and flag counts', () => {
  const tokens = ['r1', 'r2', 'r3', 'r4'];
  const clusters = nearDupClusters([
    withTokens('a', tokens, { sessionId: 's1', day: '2026-08-01', host: 'claude', q: true, o: false }),
    withTokens('b', tokens, { sessionId: 's2', day: '2026-08-02', host: 'codex', q: true }),
    withTokens('c', tokens, { sessionId: 's2', day: '2026-08-02', host: 'codex', q: false, o: true }),
  ]);
  const [cl] = clusters;
  assert.equal(cl.size, 3);
  assert.deepEqual([...cl.sessions].sort(), ['s1', 's2']);
  assert.deepEqual([...cl.days].sort(), ['2026-08-01', '2026-08-02']);
  assert.deepEqual([...cl.hosts].sort(), ['claude', 'codex']);
  assert.deepEqual(cl.tokens, { min: 4, median: 4, max: 4 });
  assert.equal(cl.questions, 2);
  assert.equal(cl.instructions, 1);
  assert.equal(cl.qKnown, 3);
  assert.equal(cl.personas, 1);
  assert.equal(cl.class, 'question');
});

test('nearDupClusters tolerates fingerprints with no q/o flags at all', () => {
  // The sibling lane that decorates q/o may not have run; absent is absent, and
  // must never be guessed into a class.
  const tokens = ['n1', 'n2', 'n3', 'n4'];
  const [cl] = nearDupClusters([withTokens('a', tokens), withTokens('b', tokens)]);
  assert.equal(cl.qKnown, 0);
  assert.equal(cl.questions, 0);
  assert.equal(cl.instructions, 0);
  assert.equal(cl.personas, 0);
  assert.equal(cl.class, 'unknown');
});

test('addSpan: an empty-string session, day or host does not inflate a span', () => {
  // Same fabrication class as the pseudo-session grouping in reAskPairs: `''` is
  // what a parser writes when it could NOT attribute a turn, and counting it
  // invents one more session (or day, or host) than exist. The spans feed the
  // recurring-cluster filter and every "21 sessions" a coaching card prints.
  const tokens = ['e1', 'e2', 'e3', 'e4'];
  const [cl] = nearDupClusters([
    withTokens('a', tokens, { sessionId: 's1', day: '2026-08-01', host: 'claude' }),
    withTokens('b', tokens, { sessionId: '', day: '', host: '' }),
  ]);
  assert.deepEqual([...cl.sessions], ['s1']);
  assert.deepEqual([...cl.days], ['2026-08-01']);
  assert.deepEqual([...cl.hosts], ['claude']);
  // The prompt itself still counts — it happened, we just cannot say where.
  assert.equal(cl.size, 2);
  // Exact-repeat groups share the same span accounting.
  const [group] = exactRepeatGroups([
    fp({ h: 'r', sessionId: 's1' }), fp({ h: 'r', sessionId: '' }), fp({ h: 'r', sessionId: '' }),
  ], { min: 3 });
  assert.equal(group.count, 3);
  assert.deepEqual([...group.sessions], ['s1']);
});

test('nearDupClusters orders by size desc then key asc', () => {
  const mk = (h, seed) => withTokens(h, Array.from({ length: 6 }, (_v, i) => `${seed}${i}`));
  const fps = [
    mk('b1', 'B'), mk('b2', 'B'), mk('b3', 'B'),
    mk('a1', 'A'), mk('a2', 'A'),
    mk('c1', 'C'), mk('c2', 'C'),
  ];
  assert.deepEqual(nearDupClusters(fps).map((c) => [c.key, c.size]), [
    ['b1', 3], ['a1', 2], ['c1', 2],
  ]);
});

// ── determinism ─────────────────────────────────────────────────────────────

/** A corpus with enough shape to make ordering, keys and spans all observable. */
function corpus(rnd) {
  const out = [];
  for (let f = 0; f < 12; f++) {
    const fam = Array.from({ length: 6 }, (_v, i) => `f${f}tok${i}`);
    for (let i = 0; i < 2 + (f % 4); i++) {
      out.push(withTokens(`h${String(f).padStart(2, '0')}-${i}`, fam, {
        sessionId: `s${f % 5}`, day: `2026-08-${String(1 + (f % 7)).padStart(2, '0')}`,
        host: f % 2 ? 'codex' : 'claude', q: i % 2 === 0, o: f === 3,
      }));
    }
  }
  for (let i = 0; i < 20; i++) {
    out.push(withTokens(`solo${i}`, Array.from({ length: 5 }, () => hex8(rnd))));
  }
  return out;
}

test('determinism: identical input reproduces identical keys and ordering', () => {
  const fps = corpus(mulberry32(3));
  assert.equal(stable(nearDupClusters(fps)), stable(nearDupClusters(fps)));
  assert.equal(stable(exactRepeatGroups(fps, { min: 1 })), stable(exactRepeatGroups(fps, { min: 1 })));
  assert.equal(stable(tapStats(fps)), stable(tapStats(fps)));
});

test('determinism: input order does not move a cluster key or the ordering', () => {
  // Scan order is an accident of the filesystem walk. If it changed cluster
  // identity, every coaching card's evidence hash would drift on rescan for no
  // reason (spec §6.2, §10).
  const fps = corpus(mulberry32(3));
  const rnd = mulberry32(99);
  const shuffled = [...fps];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  assert.notEqual(stable(fps), stable(shuffled), 'the shuffle must actually reorder');
  assert.equal(stable(nearDupClusters(fps)), stable(nearDupClusters(shuffled)));
  assert.equal(stable(exactRepeatGroups(fps, { min: 1 })), stable(exactRepeatGroups(shuffled, { min: 1 })));
  assert.equal(stable(tapStats(fps)), stable(tapStats(shuffled)));
});

// ── privacy (structural) ────────────────────────────────────────────────────

test('privacy: outputs carry only known keys and only input-supplied strings', () => {
  // The whole contract of the fingerprint layer is that no prompt text exists
  // to leak. This pins the structural half: nothing this module emits is a
  // string it did not receive as an id, plus a closed vocabulary of class
  // names. A field that could carry text would fail here without anyone having
  // to remember to look for it.
  const KEYS = new Set([
    'h', 't', 'count', 'sessions', 'days', 'hosts',
    'key', 'size', 'hashes', 'tokens', 'min', 'median', 'max',
    'questions', 'instructions', 'qKnown', 'personas', 'class',
    'pairs', 'gaps', 'sessionId', 'gap', 'a', 'b', 'jaccard', 'host', 'day',
    'prompts', 'taps', 'share', 'maxTokens', 'byHost',
  ]);
  const fps = corpus(mulberry32(3));
  const allowed = new Set(['question', 'instruction', 'mixed', 'unknown']);
  for (const f of fps) {
    allowed.add(f.h); allowed.add(f.sessionId); allowed.add(f.day); allowed.add(f.host);
    for (const th of f.th) allowed.add(th);
  }

  const walk = (node, path) => {
    if (node instanceof Set) { for (const v of node) walk(v, `${path}[set]`); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // `byHost` and `gaps` are keyed BY an input id / a count, not by a name
        // this module invented.
        const keyed = path.endsWith('.byHost') || path.endsWith('.gaps');
        if (!keyed) assert.ok(KEYS.has(k), `unexpected output key ${path}.${k}`);
        else assert.ok(allowed.has(k) || /^\d+$/.test(k), `unexpected map key ${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof node === 'string') assert.ok(allowed.has(node), `unexpected string "${node}" at ${path}`);
  };

  const clusters = nearDupClusters(fps);
  walk(clusters, 'nearDupClusters');
  walk(crossSessionClusters(clusters), 'crossSessionClusters');
  walk(exactRepeatGroups(fps, { min: 1 }), 'exactRepeatGroups');
  walk(reAskPairs(fps), 'reAskPairs');
  walk(tapStats(fps), 'tapStats');
});

// ── classifyCluster / crossSessionClusters ──────────────────────────────────

test('classifyCluster takes the majority and never guesses an absent one', () => {
  assert.equal(classifyCluster({ questions: 3, instructions: 1 }), 'question');
  assert.equal(classifyCluster({ questions: 1, instructions: 3 }), 'instruction');
  assert.equal(classifyCluster({ questions: 2, instructions: 2 }), 'mixed');
  assert.equal(classifyCluster({ questions: 0, instructions: 0 }), 'unknown');
  assert.equal(classifyCluster({}), 'unknown');
});

test('crossSessionClusters keeps a cluster spanning enough sessions OR days', () => {
  const cl = (over) => ({ key: 'k', size: 4, sessions: new Set(), days: new Set(), ...over });
  const threeSessions = cl({ key: 'sess', sessions: new Set(['a', 'b', 'c']), days: new Set(['d1']) });
  const twoDays = cl({ key: 'days', sessions: new Set(['a']), days: new Set(['d1', 'd2']) });
  const neither = cl({ key: 'no', sessions: new Set(['a', 'b']), days: new Set(['d1']) });
  const kept = crossSessionClusters([threeSessions, twoDays, neither]).map((c) => c.key);
  assert.deepEqual(kept.sort(), ['days', 'sess']);
});

test('crossSessionClusters honours its thresholds and preserves input order', () => {
  const cl = (key, s, d) => ({ key, size: 2, sessions: new Set(s), days: new Set(d), questions: 0, instructions: 0 });
  const all = [cl('x', ['a', 'b', 'c', 'd'], ['d1']), cl('y', ['a'], ['d1', 'd2', 'd3'])];
  assert.deepEqual(crossSessionClusters(all, { minSessions: 4, minDays: 4 }).map((c) => c.key), ['x']);
  assert.deepEqual(crossSessionClusters(all, { minSessions: 9, minDays: 3 }).map((c) => c.key), ['y']);
  assert.deepEqual(crossSessionClusters(all, { minSessions: 9, minDays: 9 }), []);
});

test('crossSessionClusters attaches a class when the cluster lacks one', () => {
  const [out] = crossSessionClusters([
    { key: 'k', size: 3, sessions: new Set(['a', 'b', 'c']), days: new Set(['d']), questions: 0, instructions: 3 },
  ]);
  assert.equal(out.class, 'instruction');
});

// ── reAskPairs ──────────────────────────────────────────────────────────────

test('reAskPairs finds within-session near-duplicates inside the window', () => {
  const tokens = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const ask = (h, sessionId) => withTokens(h, tokens, { sessionId });
  const unrelated = (sessionId) => withTokens('gap', ['z1', 'z2', 'z3', 'z4', 'z5'], { sessionId });

  // An unrelated turn in the SAME session sits between the two asks, so the gap
  // is two turns.
  const near = reAskPairs([ask('a1', 's1'), unrelated('s1'), ask('a2', 's1')]);
  assert.equal(near.pairs.length, 1);
  assert.equal(near.pairs[0].sessionId, 's1');
  assert.equal(near.pairs[0].gap, 2);
  assert.deepEqual(near.gaps, { 2: 1 });
  assert.equal(near.sessions, 1);

  // A turn belonging to ANOTHER session is not part of this conversation and
  // must not widen the gap — the corpus interleaves sessions freely.
  const interleaved = reAskPairs([ask('a1', 's1'), unrelated('s2'), ask('a2', 's1')]);
  assert.equal(interleaved.pairs[0].gap, 1);
});

test('reAskPairs never pairs across sessions and respects the window', () => {
  const tokens = ['x1', 'x2', 'x3', 'x4', 'x5'];
  const ask = (h, sessionId) => withTokens(h, tokens, { sessionId });
  assert.equal(reAskPairs([ask('a', 's1'), ask('b', 's2')]).pairs.length, 0);

  const filler = (i) => withTokens(`f${i}`, [`q${i}`, `r${i}`, `s${i}`, `t${i}`, `u${i}`], { sessionId: 's1' });
  const run = [ask('a', 's1'), ...Array.from({ length: 8 }, (_v, i) => filler(i)), ask('b', 's1')];
  assert.equal(reAskPairs(run).pairs.length, 0, 'gap 9 is outside the default window of 6');
  assert.equal(reAskPairs(run, { window: 9 }).pairs.length, 1);
  assert.equal(reAskPairs(run, { window: 9 }).pairs[0].gap, 9);
});

test('reAskPairs counts every pair in a repeat run and histograms the gaps', () => {
  // The corpus's worst episode is the same paragraph pasted five times in four
  // minutes; every adjacent and near-adjacent pair is real evidence of it.
  const tokens = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const run = Array.from({ length: 4 }, (_v, i) => withTokens(`r${i}`, tokens, { sessionId: 's1' }));
  const { pairs, gaps } = reAskPairs(run);
  assert.equal(pairs.length, 6);                    // C(4,2), all inside the window
  assert.deepEqual(gaps, { 1: 3, 2: 2, 3: 1 });
  assert.equal(pairs[0].a, 'r0');
  assert.equal(pairs[0].b, 'r1');
  assert.equal(pairs[0].jaccard, 1);
});

test('reAskPairs attributes host and day to the RE-ask, not the first ask', () => {
  const tokens = ['d1', 'd2', 'd3', 'd4', 'd5'];
  const { pairs } = reAskPairs([
    withTokens('first', tokens, { sessionId: 's1', host: 'claude', day: '2026-08-01' }),
    withTokens('again', tokens, { sessionId: 's1', host: 'codex', day: '2026-08-02' }),
  ]);
  assert.equal(pairs[0].host, 'codex');
  assert.equal(pairs[0].day, '2026-08-02');
});

test('reAskPairs on an empty corpus returns empty, not NaN', () => {
  assert.deepEqual(reAskPairs([]), { pairs: [], gaps: {}, sessions: 0 });
  assert.deepEqual(reAskPairs(undefined), { pairs: [], gaps: {}, sessions: 0 });
});

test('reAskPairs gates on sketch size before scoring, so a tap cannot re-ask a paragraph', () => {
  // The pathology the both-complete branch cannot cover: ONE sketch complete,
  // one truncated. A 1-token tap against a 400-token prompt gives kEff = 1 — a
  // single Bernoulli draw — which returns 1.0 whenever the tap's token is the
  // long prompt's minimum hash. Here it is, by construction.
  const rnd = mulberry32(31);
  const shared = '00000000';
  const long = new Set([shared]);
  while (long.size < 400) long.add(hex8(rnd).replace(/^0/, '8'));   // every other token sorts above
  const tap = fp({ h: 'tap', t: 1, th: [shared], sessionId: 's1' });
  const para = fp({ h: 'para', t: 400, th: sketchOf(long), sessionId: 's1' });
  assert.equal(para.th.length, SKETCH_K, 'the long prompt must be truncated for this to bite');
  assert.equal(para.th[0], shared, 'the shared token must be the long prompt\'s minimum hash');

  // The estimator itself is unchanged and still reports 1 — it is answering a
  // question it has one sample for. The GATE is what keeps that out of a finding.
  assert.equal(sketchJaccard(tap.th, para.th), 1);
  assert.deepEqual(reAskPairs([tap, para]), { pairs: [], gaps: {}, sessions: 0 });
  // The clustering path was never exposed; it is gated the same way.
  assert.deepEqual(nearDupClusters([tap, para]), []);
});

test('reAskPairs skips turns with no session rather than inventing one', () => {
  // Grouping undecorated turns under a shared `undefined` key would report
  // re-asks inside a session that does not exist — the one way this function
  // can fabricate a finding.
  const th = ['t1', 't2', 't3', 't4', 't5'];
  assert.deepEqual(
    reAskPairs([{ h: 'a', t: 5, th }, { h: 'b', t: 5, th }]),
    { pairs: [], gaps: {}, sessions: 0 },
  );
  // Decorated neighbours in the same corpus are still found.
  const mixed = reAskPairs([
    { h: 'a', t: 5, th },
    { h: 'x', t: 5, th, sessionId: 's1' },
    { h: 'y', t: 5, th, sessionId: 's1' },
  ]);
  assert.equal(mixed.pairs.length, 1);
  assert.equal(mixed.pairs[0].gap, 1);
});

test('reAskPairs treats an empty-string session id as undecorated, not as a session', () => {
  // A parser that could not attribute a turn has told us it does not know. `''`
  // is not an answer, and grouping on it reinstates the pseudo-session bug in
  // miniature — turns from unrelated conversations re-asking each other.
  const th = ['t1', 't2', 't3', 't4', 't5'];
  assert.deepEqual(
    reAskPairs([{ h: 'a', t: 5, th, sessionId: '' }, { h: 'b', t: 5, th, sessionId: '' }]),
    { pairs: [], gaps: {}, sessions: 0 },
  );
});

test('a k above the sketch capacity throws rather than silently disabling the estimator', () => {
  // At k=128 against sketches stored at 64 every sketch looks "under capacity",
  // so every comparison takes the exact branch and reads a truncated sample as a
  // complete token set. Nothing would error and every figure would be wrong.
  const th = ['a', 'b', 'c'];
  const fps = [fp({ h: 'a', th }), fp({ h: 'b', th })];
  for (const bad of [SKETCH_K + 1, 128, 0, -1, NaN, null]) {
    assert.throws(() => sketchJaccard(th, th, { k: bad }), RangeError, `k=${bad}`);
    assert.throws(() => nearDupClusters(fps, { k: bad }), RangeError, `k=${bad}`);
    assert.throws(() => reAskPairs(fps, { k: bad }), RangeError, `k=${bad}`);
  }
  // The capacity itself, and anything under it, is fine.
  assert.equal(sketchJaccard(th, th, { k: SKETCH_K }), 1);
  assert.equal(sketchJaccard(th, th, { k: 1 }), 1);
  // An explicit `undefined` is "not supplied", not a bad value — the parameter
  // default takes it, which is the language's rule and not worth fighting.
  assert.equal(sketchJaccard(th, th, { k: undefined }), 1);
});

// ── tapStats ────────────────────────────────────────────────────────────────

test('tapStats reports share overall and per host', () => {
  const stats = tapStats([
    fp({ t: 1, host: 'claude' }), fp({ t: 4, host: 'claude' }), fp({ t: 5, host: 'claude' }),
    fp({ t: 2, host: 'codex' }), fp({ t: 40, host: 'codex' }),
  ]);
  assert.equal(stats.prompts, 5);
  assert.equal(stats.taps, 3);
  assert.equal(stats.share, 0.6);
  assert.equal(stats.maxTokens, 4);
  assert.deepEqual(Object.keys(stats.byHost), ['claude', 'codex']);
  assert.deepEqual(stats.byHost.claude, { prompts: 3, taps: 2, share: 2 / 3 });
  assert.deepEqual(stats.byHost.codex, { prompts: 2, taps: 1, share: 0.5 });
});

test('tapStats honours a different tap threshold', () => {
  const fps = [fp({ t: 1 }), fp({ t: 6 }), fp({ t: 20 })];
  assert.equal(tapStats(fps, { maxTokens: 6 }).taps, 2);
});

test('tapStats on an empty corpus reports zero share, not NaN', () => {
  const stats = tapStats([]);
  assert.equal(stats.prompts, 0);
  assert.equal(stats.taps, 0);
  assert.equal(stats.share, 0);
  assert.deepEqual(stats.byHost, {});
});

test('tapStats keeps host keys sorted regardless of encounter order', () => {
  const stats = tapStats([fp({ host: 'opencode' }), fp({ host: 'codex' }), fp({ host: 'claude' })]);
  assert.deepEqual(Object.keys(stats.byHost), ['claude', 'codex', 'opencode']);
});

// ── usage-prompt-vocabulary ─────────────────────────────────────────────────
//
// The naming layer. Its whole risk is dishonesty: a curated name asserts the
// analyst knows what a cluster IS, on evidence that is only a token band and a
// span. These pins hold it to that — every seed fires only on the shape it was
// cut from, and the fallback says nothing it cannot count.

/** A cluster as `nearDupClusters` emits one; tests override what they mean. */
const cluster = (over = {}) => ({
  key: 'k0', size: 4, hashes: ['k0', 'k1'],
  sessions: new Set(['s1', 's2', 's3', 's4']),
  days: new Set(['2026-08-01', '2026-08-02']),
  hosts: new Set(['claude', 'codex']),
  tokens: { min: 3, median: 3, max: 4 },
  questions: 0, instructions: 4, qKnown: 4, personas: 0,
  class: 'instruction',
  ...over,
});

const spanning = (n, prefix) => new Set(Array.from({ length: n }, (_v, i) => `${prefix}${i}`));

test('TOKEN_BANDS and tokenBand cut at the documented boundaries', () => {
  assert.deepEqual(TOKEN_BANDS, ['tap', 'short', 'medium', 'long', 'xlong']);
  assert.equal(tokenBand(1), 'tap');
  assert.equal(tokenBand(4), 'tap');       // the spec's own tap threshold
  assert.equal(tokenBand(5), 'short');
  assert.equal(tokenBand(15), 'short');
  assert.equal(tokenBand(16), 'medium');
  assert.equal(tokenBand(60), 'medium');   // the corpus's p50 unique-token count
  assert.equal(tokenBand(61), 'long');
  assert.equal(tokenBand(250), 'long');
  assert.equal(tokenBand(251), 'xlong');
  assert.equal(tokenBand(0), 'tap');
  assert.equal(tokenBand(undefined), 'tap');
});

test('SEED_PATTERNS is a small, well-formed, documented registry', () => {
  assert.ok(SEED_PATTERNS.length >= 4 && SEED_PATTERNS.length <= 12, 'the seed list is curated, not a lexicon');
  const ids = SEED_PATTERNS.map((s) => s.id);
  const names = SEED_PATTERNS.map((s) => s.name);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(new Set(names).size, names.length, 'display names are unique');
  for (const seed of SEED_PATTERNS) {
    assert.equal(typeof seed.match, 'function');
    assert.ok(seed.basis.length > 20, `${seed.id} must record the evidence it was cut from`);
  }
  // The mockup's four names must all still exist — the view renders them.
  for (const name of ['Release ritual', 'Commit-and-push instruction', 'Progress check-in', 'Persona scaffolding']) {
    assert.ok(names.includes(name), `missing seed ${name}`);
  }
});

test('seed: Persona scaffolding fires on a majority of persona-opening members', () => {
  const hit = cluster({ size: 5, personas: 3, tokens: { min: 400, median: 530, max: 900 } });
  assert.equal(labelFor(hit).name, 'Persona scaffolding');
  // A minority does not: one persona prompt swept into a cluster is not a
  // persona cluster.
  assert.notEqual(labelFor(cluster({ size: 5, personas: 2 })).name, 'Persona scaffolding');
});

test('seed: Persona scaffolding needs no class, because the flag IS the evidence', () => {
  // The measured family is 41 edited variants that no repetition threshold can
  // see; only the `o` flag identifies them.
  const hit = cluster({ size: 3, personas: 3, class: 'unknown', questions: 0, instructions: 0, qKnown: 0 });
  assert.equal(labelFor(hit).name, 'Persona scaffolding');
});

test('seed: Release ritual needs a classified cluster, a short band and a wide span', () => {
  const hit = cluster({
    class: 'question', tokens: { min: 8, median: 9, max: 13 },
    sessions: spanning(13, 's'), days: spanning(9, 'd'), size: 13, questions: 13, instructions: 0, qKnown: 13,
  });
  // The class is `question` on purpose: the research rule reads the measured
  // exemplar ("…of agentic-kit?") as a question because it ends in a question
  // mark, and the family is spelled both ways. A predicate that demanded
  // `instruction` could never match its own evidence.
  assert.equal(labelFor(hit).name, 'Release ritual');
  assert.equal(labelFor({ ...hit, class: 'instruction' }).name, 'Release ritual');
  assert.equal(labelFor({ ...hit, class: 'mixed' }).name, 'Release ritual');
  // Same shape, one session: a procedure typed once is not a ritual.
  assert.notEqual(labelFor({ ...hit, sessions: spanning(1, 's') }).name, 'Release ritual');
  // Unclassified is still out — that is the floor the widening kept.
  assert.notEqual(labelFor({ ...hit, class: 'unknown' }).name, 'Release ritual');
  // A tap-band recurring request is not a release ritual.
  assert.notEqual(labelFor({ ...hit, tokens: { min: 1, median: 2, max: 4 } }).name, 'Release ritual');
});

test('seed: Commit-and-push refuses bare acknowledgements and at-threshold spans', () => {
  const hit = cluster({
    class: 'instruction', tokens: { min: 3, median: 3, max: 4 },
    sessions: spanning(11, 's'), days: spanning(9, 'd'), size: 13, instructions: 13, qKnown: 13,
  });
  assert.equal(labelFor(hit).name, 'Commit-and-push instruction');
  // `Continue.` — an imperative verb, so the research rule calls it an
  // instruction, and it spans MORE sessions than the real cluster. Only the
  // median-token floor keeps a commit label off the corpus's second-largest row.
  const acknowledgement = { ...hit, tokens: { min: 1, median: 1, max: 1 }, sessions: spanning(16, 's'), days: spanning(10, 'd') };
  assert.notEqual(labelFor(acknowledgement).name, 'Commit-and-push instruction');
  // `Let's go` — "let's" also reads as an instruction, and it sat exactly at
  // both of the old thresholds.
  const atThreshold = { ...hit, sessions: spanning(4, 's'), days: spanning(3, 'd') };
  assert.notEqual(labelFor(atThreshold).name, 'Commit-and-push instruction');
  // A question of the same shape is the progress twin's business, not this one's.
  assert.notEqual(labelFor({ ...hit, class: 'question' }).name, 'Commit-and-push instruction');
});

test('seed: Progress check-in is the question-side twin of the same shape', () => {
  const hit = cluster({
    class: 'question', tokens: { min: 2, median: 4, max: 6 },
    sessions: spanning(9, 's'), days: spanning(8, 'd'), size: 9, questions: 9, instructions: 0, qKnown: 9,
  });
  assert.equal(labelFor(hit).name, 'Progress check-in');
  // The band is what separates it from a long question.
  assert.notEqual(labelFor({ ...hit, tokens: { min: 40, median: 64, max: 90 } }).name, 'Progress check-in');
  // `Try again?` and `Did we push?` are two-session questions of exactly this
  // shape; the span floor is the only thing between them and this name.
  assert.notEqual(labelFor({ ...hit, sessions: spanning(2, 's'), days: spanning(2, 'd') }).name, 'Progress check-in');
});

test('seeds never fire on an unclassified cluster (absent q is not a class)', () => {
  const undecorated = cluster({
    class: 'unknown', questions: 0, instructions: 0, qKnown: 0, personas: 0,
    tokens: { min: 3, median: 3, max: 4 }, sessions: spanning(20, 's'), days: spanning(15, 'd'),
  });
  const label = labelFor(undecorated);
  assert.equal(label.source, 'characterized');
  assert.match(label.name, /^Recurring 3-token prompt/);
});

test('characterize speaks only in counts — no host name, id or hash', () => {
  const c = cluster({
    size: 21, tokens: { min: 2, median: 3, max: 5 },
    sessions: spanning(21, 'session-'), hosts: new Set(['claude', 'codex']), class: 'instruction',
  });
  assert.equal(characterize(c), 'Recurring 3-token instruction · 21 sessions · both hosts');
  for (const forbidden of ['claude', 'codex', 'session-0', 'k0', 'k1', '2026-08-01']) {
    assert.ok(!characterize(c).includes(forbidden), `characterize leaked ${forbidden}`);
  }
});

test('characterize pluralizes, names each class honestly, and counts hosts', () => {
  const base = { key: 'k', size: 1, hashes: ['k'], tokens: { min: 7, median: 7, max: 7 }, days: new Set() };
  const of = (over) => characterize({ ...base, sessions: new Set(['s1']), hosts: new Set(['claude']), ...over });
  assert.equal(of({ class: 'question' }), 'Recurring 7-token question · 1 session · 1 host');
  assert.equal(of({ class: 'mixed' }), 'Recurring 7-token mixed prompt · 1 session · 1 host');
  assert.equal(of({ class: 'unknown' }), 'Recurring 7-token prompt · 1 session · 1 host');
  assert.equal(of({ class: 'instruction', hosts: new Set(['a', 'b', 'c']) }), 'Recurring 7-token instruction · 1 session · 3 hosts');
  // Nothing to count is nothing to say — no "0 sessions" segment.
  assert.equal(of({ class: 'instruction', sessions: new Set(), hosts: new Set() }), 'Recurring 7-token instruction');
});

test('characterize survives a cluster with no token stats at all', () => {
  assert.equal(characterize({ key: 'k' }), 'Recurring 0-token prompt');
  assert.equal(characterize(undefined), 'Recurring 0-token prompt');
});

test('labelFor resolves store → seed → characterize, in that order', () => {
  const hit = cluster({
    class: 'instruction', tokens: { min: 3, median: 3, max: 4 },
    sessions: spanning(11, 's'), days: spanning(9, 'd'), size: 13, instructions: 13, qKnown: 13,
  });
  // 3. no store, no seed → characterized
  const plain = cluster({ class: 'unknown', questions: 0, instructions: 0, qKnown: 0, sessions: spanning(2, 's') });
  assert.equal(labelFor(plain).source, 'characterized');
  // 2. no store entry, seed matches → seed
  const seeded = labelFor(hit);
  assert.equal(seeded.source, 'seed');
  assert.equal(seeded.name, 'Commit-and-push instruction');
  assert.equal(seeded.seed, 'commit-and-push');
  // 1. a store entry outranks the seed, and carries its own provenance
  const store = { [hit.key]: { name: 'Push ritual (renamed)', source: 'enriched', firstSeen: '2026-08-01' } };
  assert.deepEqual(labelFor(hit, store), {
    name: 'Push ritual (renamed)', source: 'enriched', firstSeen: '2026-08-01', seed: null,
  });
});

test('labelFor tolerates a missing, empty or malformed store entry', () => {
  const c = cluster({ class: 'unknown', questions: 0, instructions: 0, qKnown: 0, sessions: spanning(2, 's') });
  assert.equal(labelFor(c, undefined).source, 'characterized');
  assert.equal(labelFor(c, {}).source, 'characterized');
  assert.equal(labelFor(c, { k0: {} }).source, 'characterized');
  assert.equal(labelFor(c, { k0: { name: '   ' } }).source, 'characterized');
  // An unrecognized source reads as `curated`: a name in the store was put
  // there by someone, and the conservative reading is that it was a person.
  assert.equal(labelFor(c, { k0: { name: 'Hand-named', source: 'whatever' } }).source, 'curated');
  assert.equal(labelFor(c, { k0: { name: 'Hand-named' } }).firstSeen, null);
  assert.equal(labelFor(undefined).source, 'characterized');
});

test('LABEL_SOURCES is the closed vocabulary labelFor can return', () => {
  assert.deepEqual(LABEL_SOURCES, ['curated', 'enriched', 'seed', 'characterized']);
  const seen = new Set();
  const c = cluster({ class: 'unknown', questions: 0, instructions: 0, qKnown: 0 });
  seen.add(labelFor(c).source);
  seen.add(labelFor(cluster({ personas: 4 })).source);
  seen.add(labelFor(c, { k0: { name: 'x', source: 'curated' } }).source);
  seen.add(labelFor(c, { k0: { name: 'x', source: 'enriched' } }).source);
  for (const s of seen) assert.ok(LABEL_SOURCES.includes(s), `${s} is outside the vocabulary`);
  assert.equal(seen.size, 4);
});

// ── the precision-first audit ───────────────────────────────────────────────
//
// The seed registry's governing rule is "precise or silent": a wrong curated
// name on a top row is worse than a generic descriptor, because it is the
// analysis asserting something false on the row most likely to be read. This
// table is the mechanized form of that promise — every cluster the 2026-08-29
// research actually measured, with the label it must resolve to.
//
// Rows are transcribed from findings §4.2 (near-duplicate clusters, top 25 —
// the shape the seeds actually consume), §4.1 (exact-repeat groups, whose spans
// are narrower than the clusters that absorb them) and §2.2 (short prompts,
// scored as if each stood alone, which is the worst case for a tap-band seed).
//
// `cls` is derived from the research's OWN published rule (§2): ends with `?` →
// question; opens with a wh-word → question; opens with an auxiliary AND
// contains `?` → question; opens with an auxiliary, an imperative verb, "let's"
// or "please" → instruction; otherwise a statement — which carries no `q` flag,
// so a cluster of statements is `unknown`, never a class.
//
// `expect: null` means the honest generic descriptor. That is a PASS, not a
// gap: most of this corpus has no curated name and should not be given one.

/** [source, exemplar, { n, sessions, days, hosts, median, cls, personas }, expected] */
const MEASURED_CLUSTERS = [
  // findings §4.2 — near-duplicate clusters, top 25
  ['§4.2', 'Yes.', { n: 31, sessions: 13, days: 11, hosts: 2, median: 1, cls: 'unknown' }, null],
  ['§4.2', 'Continue.', { n: 24, sessions: 16, days: 10, hosts: 2, median: 1, cls: 'instruction' }, null],
  ['§4.2', 'Commit and push.', { n: 13, sessions: 11, days: 9, hosts: 2, median: 3, cls: 'instruction' }, 'Commit-and-push instruction'],
  ['§4.2', 'Help me release and deploy the next semantic version of agentic-kit?', { n: 13, sessions: 13, days: 9, hosts: 2, median: 9, cls: 'question' }, 'Release ritual'],
  ['§4.2', 'How are we doing? Progress?', { n: 9, sessions: 9, days: 8, hosts: 2, median: 4, cls: 'question' }, 'Progress check-in'],
  ['§4.2', 'y', { n: 9, sessions: 3, days: 2, hosts: 2, median: 1, cls: 'unknown' }, null],
  ['§4.2', '1', { n: 6, sessions: 3, days: 3, hosts: 2, median: 1, cls: 'unknown' }, null],
  ['§4.2', "One thing I feel that's missing is the design…", { n: 6, sessions: 2, days: 1, hosts: 2, median: 45, cls: 'unknown' }, null],
  ['§4.2', 'Commit our new updates/additions/removals. Push to remote.', { n: 5, sessions: 1, days: 1, hosts: 1, median: 7, cls: 'instruction' }, null],
  ['§4.2', '/compact', { n: 5, sessions: 5, days: 3, hosts: 1, median: 1, cls: 'unknown' }, null],
  ['§4.2', "Help me release the next semantic version. See MAINTAINER.md's…", { n: 5, sessions: 4, days: 3, hosts: 2, median: 13, cls: 'instruction' }, null],
  ['§4.2', 'C', { n: 5, sessions: 3, days: 2, hosts: 1, median: 1, cls: 'unknown' }, null],
  ['§4.2', 'B', { n: 5, sessions: 1, days: 1, hosts: 1, median: 1, cls: 'unknown' }, null],
  ['§4.2', 'Push to remote', { n: 4, sessions: 4, days: 4, hosts: 1, median: 3, cls: 'instruction' }, null],
  ['§4.2', "Let's go", { n: 4, sessions: 4, days: 3, hosts: 1, median: 3, cls: 'instruction' }, null],
  ['§4.2', 'I would like you to scan the ~/Downloads directory…', { n: 3, sessions: 3, days: 2, hosts: 2, median: 64, cls: 'unknown' }, null],
  ['§4.2', 'Read no files and run no commands. Reply with exactly: SERVER_OFF_OK', { n: 3, sessions: 3, days: 1, hosts: 1, median: 11, cls: 'instruction' }, null],
  ['§4.2', 'If you are able use the github api to update the description…', { n: 2, sessions: 2, days: 1, hosts: 1, median: 24, cls: 'unknown' }, null],
  ['§4.2', 'Try again?', { n: 2, sessions: 2, days: 2, hosts: 2, median: 2, cls: 'question' }, null],
  ['§4.2', "Let's do that now.", { n: 2, sessions: 2, days: 2, hosts: 2, median: 5, cls: 'instruction' }, null],
  ['§4.2', '[Image #1] I want to build a homework tracker…', { n: 2, sessions: 2, days: 2, hosts: 2, median: 49, cls: 'unknown' }, null],
  ['§4.2', "I love how this is coming along. We're nearly there. But…", { n: 2, sessions: 2, days: 2, hosts: 2, median: 120, cls: 'unknown' }, null],
  ['§4.2', "keep monitoring, let me know when it's done", { n: 2, sessions: 1, days: 1, hosts: 1, median: 9, cls: 'instruction' }, null],
  ['§4.2', 'Fix the CI? <actions run URL>', { n: 2, sessions: 2, days: 2, hosts: 2, median: 5, cls: 'instruction' }, null],
  ['§4.2', 'Did we push? Still failing.', { n: 2, sessions: 2, days: 2, hosts: 2, median: 4, cls: 'question' }, null],

  // findings §5.3 — the persona family; only 5 of the 46 cluster at J≥0.6
  ['§5.3', 'You are a PROSECUTOR in an adversarial code review court…', { n: 5, sessions: 5, days: 4, hosts: 1, median: 530, cls: 'unknown', personas: 5 }, 'Persona scaffolding'],

  // findings §4.1 — exact-repeat groups, whose spans are NARROWER than the
  // clusters absorbing them; a seed must not fire on the narrower shape either.
  ['§4.1', 'help me release and deploy the next semantic version', { n: 5, sessions: 5, days: 5, hosts: 2, median: 9, cls: 'instruction' }, null],
  ['§4.1', 'help me release and deploy the next semantic release', { n: 4, sessions: 4, days: 2, hosts: 2, median: 9, cls: 'instruction' }, null],
  ['§4.1', 'commit our new updates/additions/removals. push to remote', { n: 5, sessions: 1, days: 1, hosts: 1, median: 7, cls: 'instruction' }, null],

  // findings §2.2 — short prompts, scored standalone (worst case for tap seeds)
  ['§2.2', 'how are we doing', { n: 8, sessions: 8, days: 7, hosts: 2, median: 4, cls: 'question' }, 'Progress check-in'],
  ['§2.2', 'commit this and push', { n: 2, sessions: 2, days: 2, hosts: 2, median: 4, cls: 'instruction' }, null],
  ['§2.2', 'push it', { n: 2, sessions: 2, days: 2, hosts: 1, median: 2, cls: 'instruction' }, null],
  ['§2.2', 'try to push', { n: 2, sessions: 2, days: 1, hosts: 1, median: 3, cls: 'instruction' }, null],
  ['§2.2', 'reply ok', { n: 2, sessions: 2, days: 2, hosts: 2, median: 2, cls: 'instruction' }, null],
  ['§2.2', 'revert', { n: 2, sessions: 2, days: 2, hosts: 2, median: 1, cls: 'instruction' }, null],
  ['§2.2', 'reply with only: ok', { n: 2, sessions: 2, days: 1, hosts: 2, median: 4, cls: 'instruction' }, null],
  ['§2.2', 'yes, go ahead', { n: 2, sessions: 2, days: 2, hosts: 1, median: 3, cls: 'unknown' }, null],
  ['§2.2', 'approved', { n: 2, sessions: 2, days: 1, hosts: 1, median: 1, cls: 'unknown' }, null],
  ['§2.2', 'subagent-driven', { n: 2, sessions: 2, days: 2, hosts: 2, median: 1, cls: 'unknown' }, null],
];

/** Build the cluster a measured row describes. `cls` drives the q counts so the
 *  shape is internally consistent with what `nearDupClusters` would emit. */
function measured({ n, sessions, days, hosts, median, cls, personas = 0 }) {
  const q = cls === 'question' ? n : 0;
  const i = cls === 'instruction' ? n : 0;
  return {
    key: 'measured', size: n, hashes: ['measured'],
    sessions: spanning(sessions, 's'), days: spanning(days, 'd'), hosts: spanning(hosts, 'host'),
    tokens: { min: median, median, max: median },
    questions: q, instructions: i, qKnown: q + i, personas,
    class: cls,
  };
}

test('precision-first: no seed mislabels any cluster the research measured', () => {
  const misses = [];
  for (const [source, exemplar, shape, expected] of MEASURED_CLUSTERS) {
    const label = labelFor(measured(shape));
    const got = label.source === 'seed' ? label.name : null;
    if (got !== expected) misses.push(`${source} "${exemplar}" → ${got ?? 'generic'} (expected ${expected ?? 'generic'})`);
  }
  assert.deepEqual(misses, [], `seed audit failures:\n  ${misses.join('\n  ')}`);
});

test('precision-first: the audit is not vacuous — every seed is exercised by it', () => {
  // A table where nothing matches would pass the audit trivially. Each seed must
  // claim at least one measured cluster, and every named row must come from a
  // seed rather than from the store or the fallback.
  const claimed = new Set();
  for (const [, , shape, expected] of MEASURED_CLUSTERS) {
    const label = labelFor(measured(shape));
    if (expected === null) continue;
    assert.equal(label.source, 'seed');
    claimed.add(label.seed);
  }
  assert.deepEqual([...claimed].sort(), ['commit-and-push', 'persona-scaffolding', 'progress-check-in', 'release-ritual']);
  assert.equal(claimed.size, SEED_PATTERNS.length, 'every seed must be exercised by the audit table');
});

test('precision-first: unnamed measured clusters get a descriptor, not silence', () => {
  // "Silent" means no curated NAME, not no output — the panel still has a row to
  // render, and it says only what the counts support.
  const [, , shape] = MEASURED_CLUSTERS.find(([, ex]) => ex === 'Continue.');
  const label = labelFor(measured(shape));
  assert.equal(label.source, 'characterized');
  assert.equal(label.name, 'Recurring 1-token instruction · 16 sessions · both hosts');
});
