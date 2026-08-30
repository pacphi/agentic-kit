// usage-prompt-patterns.mjs — repetition analysis over prompt FINGERPRINTS
// (Prompts view spec §3.2 panel 3; research findings §4–§5).
//
// Every function here is PURE: it takes a collection of fingerprints and
// returns counts, ids and sets. There is no I/O, no clock, no import beyond
// what the language gives — which is what makes the whole view "recalculable"
// in the spec's sense (§6.1): the same corpus yields the same numbers on every
// scan, and nothing is stored between them.
//
// THE INPUT SHAPE. Each entry is one prompt-kind turn's fingerprint, decorated
// by the caller with where it happened:
//
//     { h, t, th, p, q?, o?, sessionId, day, host }
//
//   h          sha256(normalizedText)[0..16) — EXACT, never sketched
//   t          normalized token count, repeats included
//   th         sorted, deduplicated token hashes, BOUNDED at SKETCH_K
//   p          provenance tag (usage-provenance) — the caller filters on it
//   q          true = question, false = instruction; ABSENT = not classified
//   o          true = the prompt opens by assigning the model a persona
//   sessionId / day / host   where the turn happened
//
// `q` and `o` are optional throughout and absent is never guessed into a value:
// a corpus decorated by an older scan simply reports `unknown`, which is the
// honest answer and the one the coaching layer can act on safely.
//
// NO PROMPT TEXT EXISTS HERE TO LEAK. The fingerprint layer is the privacy
// contract (spec §2.2); this module consumes it and emits only hashes, ids,
// counts and sets, pinned structurally by the tests.

/**
 * The sketch capacity — how many token hashes one fingerprint can carry. It
 * MIRRORS `usage-parsers.MAX_TOKEN_HASHES` and is restated rather than imported
 * so this module stays dependency-free; the test pins the two equal, because
 * reading a sketch at the wrong capacity silently destroys the one distinction
 * `sketchJaccard` is built on (complete token set vs truncated sample).
 */
export const SKETCH_K = 64;

/** Document frequency above which a token hash is too common to bucket on:
 *  5% of the corpus, the research's `df ≤ 76` on 1,524 prompts (findings §4.2). */
const RARE_SHARE = 0.05;

/**
 * One prompt-kind turn as this module reads it: the stored fingerprint plus the
 * caller's decoration. Everything after `p` is optional, and absent decoration
 * is simply not counted — never defaulted into a value.
 *
 * @typedef {object} PromptFingerprint
 * @property {string} h Hash of the normalized text. Exact, never sketched.
 * @property {number} t Normalized token count, repeats included.
 * @property {string[]} th Sorted, deduplicated token hashes, bounded at SKETCH_K.
 * @property {string} [p] Provenance tag (usage-provenance).
 * @property {boolean} [q] true = question, false = instruction; absent = unclassified.
 * @property {boolean} [o] true = the prompt opens by assigning the model a persona.
 * @property {string} [sessionId]
 * @property {string} [day]
 * @property {string} [host]
 */

/**
 * A group of prompts with identical normalized text.
 *
 * @typedef {object} RepeatGroup
 * @property {string} h
 * @property {number} t
 * @property {number} count
 * @property {Set<string>} sessions
 * @property {Set<string>} days
 * @property {Set<string>} hosts
 */

/**
 * A near-duplicate cluster, as panel 3 and the vocabulary layer read it.
 *
 * @typedef {object} PromptCluster
 * @property {string} key Lexicographic minimum `h` in the cluster.
 * @property {number} size
 * @property {string[]} hashes
 * @property {Set<string>} sessions
 * @property {Set<string>} days
 * @property {Set<string>} hosts
 * @property {{ min: number, median: number, max: number }} tokens
 * @property {number} questions Members flagged `q === true`.
 * @property {number} instructions Members flagged `q === false`.
 * @property {number} qKnown Members carrying a `q` flag at all.
 * @property {number} personas Members flagged `o === true`.
 * @property {'question'|'other'|'mixed'|'unknown'} class
 */

/** A sketch prepared for repeated comparison: the sorted array and its Set. */
/** @typedef {{ arr: string[], set?: Set<string> }} Sketch */

// ── fingerprint plumbing ────────────────────────────────────────────────────

const isFingerprint = (f) => !!f && typeof f === 'object' && typeof f.h === 'string';

/**
 * Reject a `k` above the capacity the fingerprints were actually built at.
 *
 * This THROWS rather than clamping, because the failure it prevents is silent
 * and total: at `k = 128` against sketches stored at 64, every sketch looks
 * "under capacity", so every comparison takes the exact branch and treats a
 * truncated sample as a complete token set. Nothing errors, no number looks
 * wrong, and every similarity figure in the view is quietly computed from a
 * false premise. Clamping would paper over a caller that has misunderstood the
 * storage contract; the loud failure is the useful one.
 *
 * @param {number} k
 */
function assertCapacity(k) {
  if (!Number.isFinite(k) || k < 1 || k > SKETCH_K) {
    throw new RangeError(`k must be between 1 and the sketch capacity SKETCH_K (${SKETCH_K}); got ${k}`);
  }
}

/** Normalize a stored `th` into a sorted, deduplicated array. The scan path
 *  already writes it that way; re-normalizing costs one pass and makes the
 *  estimator correct for any caller that mapped or filtered the array first. */
function toSketch(th) {
  if (!Array.isArray(th)) return [];
  const seen = new Set();
  for (const x of th) if (typeof x === 'string' && x) seen.add(x);
  return [...seen].sort();
}

/** A fingerprint plus the two derived forms the comparison loop needs, built
 *  once per prompt instead of once per comparison. */
/** @param {PromptFingerprint} fp */
function prepare(fp) {
  const arr = toSketch(fp.th);
  return { fp, arr, set: new Set(arr), t: Number.isFinite(fp.t) ? fp.t : arr.length };
}

// ── the estimator ───────────────────────────────────────────────────────────

/**
 * Estimated Jaccard similarity between two token sets, given only their
 * bottom-k sketches.
 *
 * WHY NOT |A∩B| / |A∪B| OVER THE SKETCHES. That reading treats a sample as if
 * it were the population. Two prompts of different lengths have sketches
 * covering different slices of the hash range — a 100-token prompt's bottom-64
 * spans most of the range, a 1,000-token prompt's spans a tenth of it — so
 * their raw overlap systematically understates the true overlap. Measured over
 * 50 random pairs at k=64 with the larger set 2x–6x the smaller, the naive
 * reading's mean absolute error is 0.095 against this estimator's 0.045, and
 * its worst case reaches 0.22 where this one peaks at 0.13. (On EQUAL-sized
 * sets the two agree — which is exactly why the mistake survives casual
 * testing, and why the pinned fixture excludes that case rather than diluting
 * the contrast with it.)
 *
 * THE ESTIMATOR (k-minimum-values / bottom-k, the standard set-similarity
 * estimator for this sketch). Take `U`, the k smallest hashes of the two
 * sketches merged. Two facts make `U` usable:
 *
 *   1. `U` is the true bottom-k of the UNION of the token sets. Anything in the
 *      union small enough to be in its bottom-k was small enough to survive its
 *      own set's sketch, so it is present in one of the two sketches to be
 *      found.
 *   2. For any `x` in `U`, membership is EXACT: `x ∈ A` iff `x ∈ sketch(A)`.
 *      If `x` were in A but not its sketch, k smaller elements of A would sit
 *      below it — and they are all in the merged input, so `x` could not have
 *      been in the bottom-k of it.
 *
 * `U` is therefore a uniform sample of size k drawn from `A ∪ B` whose
 * membership in `A ∩ B` can be read off exactly, and the share of it landing in
 * both sketches estimates |A∩B| / |A∪B| directly.
 *
 * WHEN NOTHING IS ESTIMATED. A sketch under capacity is the complete token set
 * (nothing was dropped), so when BOTH are complete this returns exact Jaccard.
 * That branch is not an optimization — it is a correctness requirement. Half
 * this corpus is short prompts, and for `{a}` against `{a,b,c}` the sampling
 * estimator would answer 1.0 from its single sample where the truth is 1/3.
 *
 * @param {string[]} thA
 * @param {string[]} thB
 * @param {{ k?: number }} [opts] `k` is the sketch capacity the fingerprints
 *   were built at; it decides which sketches count as complete. It may not
 *   exceed SKETCH_K — see `assertCapacity` for why that throws.
 * @returns {number} 0..1; 0 when either side is empty.
 * @throws {RangeError} if `k` exceeds the sketch capacity.
 */
export function sketchJaccard(thA, thB, { k = SKETCH_K } = {}) {
  assertCapacity(k);
  return jaccardOf({ arr: toSketch(thA) }, { arr: toSketch(thB) }, k);
}

/** The estimator over PREPARED sketches — the form the clustering loop calls,
 *  so the sort and the Set are paid once per prompt, not once per comparison. */
/** @param {Sketch} a @param {Sketch} b @param {number} k */
function jaccardOf(a, b, k) {
  const A = a.arr, B = b.arr;
  if (!A.length || !B.length) return 0;
  const setA = a.set ?? (a.set = new Set(A));
  const setB = b.set ?? (b.set = new Set(B));
  if (A.length < k && B.length < k) return exactJaccard(setA, setB);
  const kEff = Math.min(A.length, B.length, k);
  const union = [...new Set([...A, ...B])].sort();
  let hits = 0;
  for (let i = 0; i < kEff; i++) {
    const x = union[i];
    if (setA.has(x) && setB.has(x)) hits++;
  }
  return hits / kEff;
}

function exactJaccard(setA, setB) {
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// ── exact repeats ───────────────────────────────────────────────────────────

/**
 * Prompts whose normalized text is literally identical, grouped by `h` — the
 * "17 groups, 141 prompts" table in findings §4.1. `h` is never sketched, so
 * this answer is exact no matter how long the prompts are.
 *
 * @param {Array<PromptFingerprint>} fps
 * @param {{ min?: number }} [opts] smallest group worth reporting.
 * @returns {RepeatGroup[]} count desc, then `h` asc.
 */
export function exactRepeatGroups(fps, { min = 3 } = {}) {
  const groups = new Map();
  for (const fp of Array.isArray(fps) ? fps : []) {
    if (!isFingerprint(fp)) continue;
    let g = groups.get(fp.h);
    if (!g) groups.set(fp.h, (g = { h: fp.h, t: Infinity, count: 0, sessions: new Set(), days: new Set(), hosts: new Set() }));
    g.count++;
    // Identical by construction — `h` hashes the normalized text, so every
    // member has the same token count. Taking the minimum keeps the field
    // order-invariant even if a hash collision ever put two texts in one group.
    if (Number.isFinite(fp.t)) g.t = Math.min(g.t, fp.t);
    addSpan(g, fp);
  }
  return [...groups.values()]
    .filter((g) => g.count >= min)
    .map((g) => ({ ...g, t: Number.isFinite(g.t) ? g.t : 0, sessions: sortedSet(g.sessions), days: sortedSet(g.days), hosts: sortedSet(g.hosts) }))
    .sort((a, b) => b.count - a.count || cmp(a.h, b.h));
}

/**
 * A decoration value that actually identifies something: a non-empty string.
 *
 * The empty string is the shape a parser writes when it could NOT attribute a
 * turn — it has told us it does not know, and `''` is not an answer. Counting
 * it fabricates a span: an unattributed turn becomes one more session, one more
 * day or one more host than really exist, and every figure keyed on those
 * counts (the recurring-cluster filter, the per-host split, the coaching card's
 * "21 sessions") inherits the invention. Same failure class as the pseudo-session
 * grouping in `reAskPairs`, which shares this predicate.
 *
 * @param {unknown} value
 */
const isId = (value) => typeof value === 'string' && value !== '';

/** Record where one fingerprint happened, ignoring absent decoration. */
/** @param {{ sessions: Set<string>, days: Set<string>, hosts: Set<string> }} target
 *  @param {PromptFingerprint} fp */
function addSpan(target, fp) {
  if (isId(fp.sessionId)) target.sessions.add(fp.sessionId);
  if (isId(fp.day)) target.days.add(fp.day);
  if (isId(fp.host)) target.hosts.add(fp.host);
}

/** A Set whose iteration order is sorted, so anything serialized from it (an
 *  evidence hash, a rendered chip list) is stable across scans. */
const sortedSet = (set) => new Set([...set].sort());

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── candidate generation (the comparison bound) ─────────────────────────────

/**
 * The bounded set of index pairs worth running the estimator on. All-pairs is
 * quadratic and unnecessary: two prompts can only be near-duplicates if they
 * share something, so candidates come from two buckets (research findings §4.2,
 * which needed 19,654 comparisons for 1,524 prompts rather than 1.16 million):
 *
 *   RARE TOKEN — a token hash held by at most `rareShare` of the corpus buckets
 *   the prompts that hold it. A token in half the corpus separates nothing, and
 *   bucketing on it would rebuild the quadratic loop.
 *
 *   LENGTH BAND — a prompt that ends up with NO candidate from the rare buckets
 *   falls back to prompts within ±1 token of its own length. This is what keeps
 *   the corpus's biggest clusters visible at all: `yes` and `continue` are one
 *   token, and that token is far too common to be rare. (The research applied
 *   the fallback to prompts with no rare token; keying it on "no candidate"
 *   instead is a strict superset — same prompts, plus the ones whose rare
 *   tokens turned out to be unique to them.)
 *
 * Before either bucket runs, a prompt sharing NO token with any other prompt is
 * dropped outright: its Jaccard with everything is 0, so there is nothing to
 * find. That is what stops a crowd of same-length prompts with nothing in
 * common from turning the length band back into the quadratic loop it exists to
 * avoid.
 *
 * THE PRECISE CLAIM: that filter is exact with respect to the function this
 * module computes — `sketchJaccard` scores a hit only when a hash is in BOTH
 * sketches, so a pair with disjoint sketches scores exactly 0 and can only be
 * dropped from a set it was never going to enter. Against TRUE Jaccard the loss
 * is not literally zero, but it is bounded by the sketch's own resolution: for a
 * pair with true J ≥ 0.8 and a union above the capacity, disjoint sketches
 * require that none of the union's 64 bottom-k draws lands in an intersection
 * covering ≥80% of that union — probability ≤ 0.2^64, or about 4e-45. "Exact
 * with respect to the estimator" is the claim that holds without qualification;
 * "exact" full stop overstates it by that margin.
 *
 * A cheap arithmetic gate then drops pairs that cannot reach the threshold:
 * Jaccard is bounded above by the ratio of the two set sizes. Sketch sizes are
 * admissible for this because a truncated sketch under-states a large set, so
 * the computed ratio is never smaller than the true one and the gate can only
 * drop pairs that were genuinely out of reach.
 *
 * THE RECALL BOUNDARY, stated rather than hidden: two prompts that share only
 * common tokens AND differ by more than one token in length are never compared.
 * For a near-duplicate of any length that is close to impossible — a long
 * prompt with no rare token at all does not occur in this corpus — but it is
 * the honest limit of the method.
 *
 * @param {Array<PromptFingerprint>} fps
 * @param {{ jaccard?: number, rareShare?: number }} [opts]
 * @returns {Array<[number, number]>} index pairs, i < j, deduplicated.
 */
export function candidatePairs(fps, { jaccard = 0.8, rareShare = RARE_SHARE } = {}) {
  const items = (Array.isArray(fps) ? fps : []).filter(isFingerprint).map(prepare);
  const n = items.length;
  if (n < 2) return [];

  const { byRare, byLen, shared } = buckets(items, rareShare);
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    // A prompt holding no token that any OTHER prompt holds has Jaccard 0 with
    // everything, so nothing about it is worth comparing. Skipping it is exact,
    // not a heuristic — and it is what keeps the length band from degenerating
    // into an all-pairs loop over a crowd of same-length, nothing-in-common
    // prompts, which is the one shape that makes the fallback expensive.
    if (!shared[i]) continue;
    const cand = new Set();
    for (const x of items[i].set) for (const j of byRare.get(x) ?? []) if (j !== i) cand.add(j);
    if (cand.size === 0) {
      for (let d = -1; d <= 1; d++) for (const j of byLen.get(items[i].t + d) ?? []) if (j !== i && shared[j]) cand.add(j);
    }
    for (const j of cand) {
      const [lo, hi] = i < j ? [i, j] : [j, i];
      const id = `${lo}:${hi}`;
      if (seen.has(id) || !sizeGate(items[lo], items[hi], jaccard)) continue;
      seen.add(id);
      pairs.push([lo, hi]);
    }
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Rare-token and length buckets over the prepared items, plus `shared[i]` —
 *  whether prompt `i` holds any token another prompt also holds.
 *
 *  The rare cutoff has a floor of 2 because on a small corpus `rareShare × n`
 *  rounds below the smallest document frequency that can bucket a pair at all,
 *  which would push every prompt into the length band.
 *
 * @param {Array<{ set: Set<string>, t: number }>} items
 * @param {number} rareShare
 */
function buckets(items, rareShare) {
  const df = new Map();
  for (const it of items) for (const x of it.set) df.set(x, (df.get(x) ?? 0) + 1);
  const rareMax = Math.max(2, Math.floor(rareShare * items.length));
  const byRare = new Map(), byLen = new Map(), shared = [];
  items.forEach((it, i) => {
    let any = false;
    for (const x of it.set) {
      const freq = df.get(x) ?? 0;
      if (freq > 1) any = true;
      if (freq <= rareMax) push(byRare, x, i);
    }
    shared[i] = any;
    push(byLen, it.t, i);
  });
  return { byRare, byLen, shared };
}

/** @param {Map<any, any[]>} map */
function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/** Jaccard cannot exceed min(|A|,|B|) / max(|A|,|B|). */
/** @param {Sketch} a @param {Sketch} b @param {number} threshold */
function sizeGate(a, b, threshold) {
  const lo = Math.min(a.arr.length, b.arr.length), hi = Math.max(a.arr.length, b.arr.length);
  return hi === 0 ? false : lo / hi >= threshold;
}

// ── near-duplicate clusters ─────────────────────────────────────────────────

/**
 * Connected components of "estimated Jaccard ≥ threshold" — the 108-cluster
 * table in findings §4.2, and panel 3 of the view.
 *
 * The threshold is deliberately LOOSE (the spec ships the panel at ≈0.6, this
 * defaults to the research's 0.8) because phrasing variance is the signal, not
 * noise: eleven wordings of one request outrank eleven identical ones, since
 * eleven wordings prove there is no canonical form to point at. Precision comes
 * from the prompt-type filter downstream, not from tightening this number.
 *
 * Clustering is transitive by construction (union-find), so a chain of
 * near-duplicates lands in one cluster even where its endpoints are not
 * themselves similar. That is the intended reading of a drifting phrasing.
 *
 * @param {Array<PromptFingerprint>} fps
 * @param {{ jaccard?: number, k?: number, rareShare?: number, minSize?: number }} [opts]
 * @returns {PromptCluster[]} clusters, size desc then key asc. `key` is the
 *   lexicographic minimum `h` in the cluster — stable under any input order, so
 *   an evidence hash built from it does not drift when the filesystem walk does.
 */
export function nearDupClusters(fps, { jaccard = 0.8, k = SKETCH_K, rareShare = RARE_SHARE, minSize = 2 } = {}) {
  assertCapacity(k);
  const items = (Array.isArray(fps) ? fps : []).filter(isFingerprint).map(prepare);
  if (items.length < minSize) return [];

  const parent = items.map((_it, i) => i);
  for (const [i, j] of candidatePairs(fps, { jaccard, rareShare })) {
    if (jaccardOf(items[i], items[j], k) >= jaccard) union(parent, i, j);
  }

  const byRoot = new Map();
  items.forEach((it, i) => push(byRoot, find(parent, i), it.fp));
  return [...byRoot.values()]
    .filter((members) => members.length >= minSize)
    .map(buildCluster)
    .sort((a, b) => b.size - a.size || cmp(a.key, b.key));
}

function find(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}

function union(parent, i, j) {
  const a = find(parent, i), b = find(parent, j);
  if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
}

/** Everything panel 3 and the vocabulary layer read off a cluster. Built from
 *  SORTED members so nothing in it depends on the order the corpus arrived in. */
/** @param {PromptFingerprint[]} members @returns {PromptCluster} */
function buildCluster(members) {
  const hashes = [...new Set(members.map((m) => m.h))].sort();
  const cluster = /** @type {PromptCluster} */ ({
    key: hashes[0],
    size: members.length,
    hashes,
    sessions: new Set(), days: new Set(), hosts: new Set(),
    tokens: tokenStats(members),
    questions: 0, instructions: 0, qKnown: 0, personas: 0,
    class: 'unknown',
  });
  for (const m of members) {
    addSpan(cluster, m);
    if (m.q === true) { cluster.questions++; cluster.qKnown++; }
    else if (m.q === false) { cluster.instructions++; cluster.qKnown++; }
    if (m.o === true) cluster.personas++;
  }
  cluster.sessions = sortedSet(cluster.sessions);
  cluster.days = sortedSet(cluster.days);
  cluster.hosts = sortedSet(cluster.hosts);
  cluster.class = classifyCluster(cluster);
  return cluster;
}

/** Token-count spread. The median is the LOWER of the two middles on an even
 *  count, so it is always a real token count a reader can act on rather than a
 *  half-token average. */
/** @param {PromptFingerprint[]} members */
function tokenStats(members) {
  const ts = members.map((m) => (Number.isFinite(m.t) ? m.t : 0)).sort((a, b) => a - b);
  return { min: ts[0], median: ts[Math.floor((ts.length - 1) / 2)], max: ts[ts.length - 1] };
}

/**
 * Whether a cluster reads as questions or as instructions, from the `q` flags
 * its members carry. The two halves mean different things in the spec: the
 * instruction side is standing procedure being re-typed instead of encoded, the
 * question side is state the system could have volunteered (findings §5.2).
 *
 * Absent flags are NOT a class. A cluster nobody classified reports `unknown`,
 * and `mixed` is reserved for a genuine tie — the honest answer when a majority
 * rule has nothing to pick.
 *
 * Ruling A (final-triage item 1, prompts-view spec §2.3/§6.3 build): the
 * non-question side is named `other` on THE WIRE, not `instruction` —
 * `promptShape` only ever tests for interrogative-ness, so calling the other
 * side "instruction" asserts imperativeness the shape rules never measured
 * (the corpus's declarative feedback and bare acknowledgements land there
 * too). Two render layers (the CLI's CLASS_LABELS, the dashboard's
 * CLASS_LABEL) used to rewrite `instruction` to `other` for exactly this
 * reason; the fix now lives at the SOURCE instead, so both surfaces render
 * their own value unchanged. The `questions`/`instructions` PARAMETER names
 * stay as they are — they are internal tally fields, not the class value.
 *
 * @param {{ questions?: number, instructions?: number }} cluster
 * @returns {'question'|'other'|'mixed'|'unknown'}
 */
export function classifyCluster({ questions = 0, instructions = 0 } = {}) {
  if (questions === 0 && instructions === 0) return 'unknown';
  if (questions > instructions) return 'question';
  if (instructions > questions) return 'other';
  return 'mixed';
}

/**
 * The recurring subset of a cluster list: everything spanning enough sessions
 * OR enough distinct days (spec §3.1 "Repeated share", findings §5.2). It is
 * deliberately a disjunction — a prompt re-typed in three sessions on one busy
 * afternoon and one re-typed on two separate days are both the same finding,
 * "this was not written down anywhere".
 *
 * Input order is preserved, so a list already sorted by size stays sorted.
 *
 * @param {Array<PromptCluster>} clusters
 * @param {{ minSessions?: number, minDays?: number }} [opts]
 * @returns {PromptCluster[]}
 */
export function crossSessionClusters(clusters, { minSessions = 3, minDays = 2 } = {}) {
  return (Array.isArray(clusters) ? clusters : [])
    .filter((c) => (c?.sessions?.size ?? 0) >= minSessions || (c?.days?.size ?? 0) >= minDays)
    .map((c) => (c.class ? c : { ...c, class: classifyCluster(c) }));
}

// ── intra-session re-asks ───────────────────────────────────────────────────

/**
 * Near-duplicate prompt pairs inside ONE session, close enough together to read
 * as "it didn't do what I said, so I said it again" (findings §5.1 — 49 pairs,
 * 45% of them one turn apart, which is the model's immediately preceding
 * response having failed).
 *
 * The input is the corpus in turn order; grouping by session happens here, so a
 * caller can hand over the whole scan without splitting it first. Only the
 * ORDER within each session is load-bearing — an interleaved turn from another
 * session does not widen a gap.
 *
 * `gap` counts turns between the two asks in the same session: 1 means the
 * re-ask was the very next thing typed. Host and day are attributed to the
 * RE-ask, since that is the turn the finding is about.
 *
 * A fingerprint carrying NO session id is skipped rather than grouped: this
 * finding is "the same thing asked twice in one conversation", and without a
 * session there is no conversation to have asked it in. Collecting the
 * undecorated turns under a shared `undefined` key would invent one — and
 * report re-asks in a session that does not exist. An EMPTY-STRING id is
 * treated the same way, for the same reason: a parser that could not attribute
 * a turn has told us it does not know, and `''` is not an answer.
 *
 * THE SIZE GATE IS NOT OPTIONAL HERE. Every pair is filtered by `sizeGate`
 * before it is scored, exactly as the clustering path does. Without it this
 * function is exposed to the small-`kEff` pathology in the one case the
 * both-complete branch cannot cover — one sketch complete, one truncated. A
 * 1-token tap against a 400-token prompt gives `kEff = 1`, a single Bernoulli
 * draw, which returns 1.0 whenever the tap's token happens to be the long
 * prompt's minimum hash: a fabricated re-ask pair, rendered as "identical".
 * The gate drops it because a ratio of 1/64 cannot reach any usable threshold.
 *
 * @param {Array<PromptFingerprint>} sessionOrderedFps
 * @param {{ window?: number, jaccard?: number, k?: number }} [opts]
 * @returns {{ pairs: Array<{ sessionId: string, gap: number, a: string, b: string,
 *   jaccard: number, host: string|undefined, day: string|undefined }>,
 *   gaps: Record<number, number>, sessions: number }}
 */
export function reAskPairs(sessionOrderedFps, { window = 6, jaccard = 0.8, k = SKETCH_K } = {}) {
  assertCapacity(k);
  const bySession = new Map();
  for (const fp of Array.isArray(sessionOrderedFps) ? sessionOrderedFps : []) {
    if (isFingerprint(fp) && isId(fp.sessionId)) push(bySession, fp.sessionId, prepare(fp));
  }
  const pairs = [];
  const gaps = {};
  const sessions = new Set();
  for (const [sessionId, turns] of bySession) {
    for (let i = 0; i < turns.length; i++) {
      for (let j = i + 1; j < turns.length && j - i <= window; j++) {
        if (!sizeGate(turns[i], turns[j], jaccard)) continue;
        const score = jaccardOf(turns[i], turns[j], k);
        if (score < jaccard) continue;
        const gap = j - i;
        pairs.push({ sessionId, gap, a: turns[i].fp.h, b: turns[j].fp.h, jaccard: score, host: turns[j].fp.host, day: turns[j].fp.day });
        gaps[gap] = (gaps[gap] ?? 0) + 1;
        sessions.add(sessionId);
      }
    }
  }
  return { pairs, gaps, sessions: sessions.size };
}

// ── supervision taps ────────────────────────────────────────────────────────

/**
 * Supervision taps — prompts of at most `maxTokens` normalized tokens (spec
 * §3.1). The count is what the KPI strip and the `supervision-tap-share`
 * detector compare against the operator's own trailing baseline.
 *
 * WHAT THIS DOES NOT MODEL: the tap's necessity. Some taps are legitimate
 * approvals, and the cost of one is not its own handful of tokens but the round
 * trip it buys over an already-large context — a figure that belongs to the
 * caller, with its basis labelled, not to this count.
 *
 * @param {Array<PromptFingerprint>} fps
 * @param {{ maxTokens?: number }} [opts]
 * @returns {{ prompts: number, taps: number, share: number, maxTokens: number,
 *   byHost: Record<string, { prompts: number, taps: number, share: number }> }}
 */
export function tapStats(fps, { maxTokens = 4 } = {}) {
  const total = { prompts: 0, taps: 0 };
  const hosts = new Map();
  for (const fp of Array.isArray(fps) ? fps : []) {
    if (!isFingerprint(fp)) continue;
    const isTap = Number.isFinite(fp.t) && fp.t <= maxTokens;
    total.prompts++;
    if (isTap) total.taps++;
    if (typeof fp.host !== 'string') continue;
    let h = hosts.get(fp.host);
    if (!h) hosts.set(fp.host, (h = { prompts: 0, taps: 0 }));
    h.prompts++;
    if (isTap) h.taps++;
  }
  const byHost = {};
  for (const host of [...hosts.keys()].sort()) {
    const h = hosts.get(host);
    byHost[host] = { prompts: h.prompts, taps: h.taps, share: shareOf(h.taps, h.prompts) };
  }
  return { prompts: total.prompts, taps: total.taps, share: shareOf(total.taps, total.prompts), maxTokens, byHost };
}

/** An empty window has a zero share, not a NaN one — the KPI strip renders it. */
const shareOf = (part, whole) => (whole > 0 ? part / whole : 0);
