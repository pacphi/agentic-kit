// usage-prompt-vocabulary.mjs — what a prompt cluster is CALLED.
//
// A cluster's name is drawn from a deterministic controlled vocabulary, never
// lifted from what the operator typed. Parser-produced enum facets can compose
// a semantic label; otherwise the result is directly evidenced persona
// scaffolding or an honest shape characterization.
import {
  intentLabel, semanticName, topicLabel,
} from './usage-prompt-semantics.mjs';

export { INTENT_LABELS, TOPIC_LABELS } from './usage-prompt-semantics.mjs';
//
// A name comes from one of two places, in decreasing order of authority:
//
//   1. A SEED PATTERN — the small registry below, for clusters measured by
//      name in the 2026-08-29 research.
//   2. `characterize` — a generic descriptor assembled from the cluster's
//      own metadata, asserting nothing the numbers do not already say.
//
// ── WHY SEEDS ARE NOT KEYED ON HASHES ───────────────────────────────────────
//
// The obvious seeding is a list of `h` values: the research knows exactly which
// hash `commit and push` produces. It is also useless, because those hashes are
// corpus-specific — a hash of THIS machine's normalized text, matching nothing
// on anyone else's machine and nothing after a phrasing drifts. Seeds are
// therefore keyed on shape that survives both: the token-count BAND, the
// question/instruction CLASS, and the SPAN (how many sessions and days the
// cluster reaches across).
//
// ── AND WHY THEY ARE PROVISIONAL ────────────────────────────────────────────
//
// A shape predicate is a heuristic. "A classified request, 5-15 tokens, 8+
// sessions" is what the release ritual looked like in one corpus; it is not
// what a release ritual IS. Each seed records the measured cluster it was cut
// from in its `basis`, and every seed match reports `source: 'seed'` so the
// view can render it as the provisional reading it is.
//
// ── THE PRECISION-FIRST RULE (governs every seed here) ──────────────────────
//
// A SEED MUST BE PRECISE OR SILENT. A wrong curated name on a top row of the
// panel is worse than no name at all: `characterize` states only what the
// numbers say and can embarrass nobody, whereas "Commit-and-push instruction"
// printed over a 24-prompt cluster of the word "Continue" is the analysis
// asserting something false, on the row the operator is most likely to read.
// A gap costs a generic descriptor; a mislabel costs trust in the panel.
//
// So a predicate is admitted only if it can be shown NOT to fire on any cluster
// it would misname. Concretely: every predicate below is probed against the
// measured cluster tables in the 2026-08-29 research (findings §4.1 exact
// repeats, §4.2 near-duplicate clusters, §2.2 short prompts), with each
// cluster's question/instruction class derived from the research's own
// published rule (§2: ends with `?` → question; opens with a wh-word →
// question; opens with an auxiliary AND contains `?` → question; opens with an
// auxiliary, an imperative verb, "let's" or "please" → instruction; otherwise a
// statement, which carries no `q` flag and so counts toward neither). The probe
// is pinned as a test — see MEASURED_CLUSTERS in the test file, which asserts
// the label every one of those clusters resolves to. When a predicate and the
// evidence disagree, the predicate loses.
//
// Two predicates were narrowed on exactly that evidence, and one widened; each
// says so in its `basis`.

/**
 * Token-count bands. `tap` is the spec's own supervision-tap threshold (§3.1,
 * ≤4 normalized tokens) so the two never disagree; `medium` ends at 60, the
 * corpus's p50 unique-token count; `xlong` is where the retyped Codex personas
 * live (median ≈530 tokens).
 */
export const TOKEN_BANDS = ['tap', 'short', 'medium', 'long', 'xlong'];

/** Every provenance `labelFor` can report. */
export const LABEL_SOURCES = ['seed', 'semantic', 'characterized'];

/** The cluster shape this module names. Imported as a TYPE only — nothing here
 *  takes a runtime dependency on the clustering library.
 *  @typedef {import('./usage-prompt-patterns.mjs').PromptCluster} PromptCluster */

/**
 * @param {number} tokens A cluster's median token count.
 * @returns {'tap'|'short'|'medium'|'long'|'xlong'}
 */
export function tokenBand(tokens) {
  const t = Number.isFinite(tokens) ? tokens : 0;
  if (t <= 4) return 'tap';
  if (t <= 15) return 'short';
  if (t <= 60) return 'medium';
  if (t <= 250) return 'long';
  return 'xlong';
}

// ── the cluster's shape, read defensively ───────────────────────────────────

/**
 * The five numbers every predicate below reads. A cluster missing any of them
 * yields the zero-shape, and a zero-shape matches no seed — which is the honest
 * outcome, not a bug: a cluster nobody classified is a cluster nobody can name.
 *
 * @param {Partial<PromptCluster>} [cluster] A cluster from `nearDupClusters`.
 */
function shapeOf(cluster) {
  const c = cluster ?? {};
  const median = c.tokens?.median;
  return {
    band: tokenBand(median),
    tokens: Number.isFinite(median) ? median : 0,
    cls: typeof c.class === 'string' ? c.class : 'unknown',
    size: Number.isFinite(c.size) ? c.size : 0,
    sessions: c.sessions?.size ?? 0,
    days: c.days?.size ?? 0,
    hosts: c.hosts?.size ?? 0,
    personas: Number.isFinite(c.personas) ? c.personas : 0,
  };
}

// ── the seed registry ───────────────────────────────────────────────────────

/**
 * Curated names for the patterns the research measured, in MATCH ORDER — first
 * hit wins. The ordering is load-bearing exactly once: `Persona scaffolding`
 * runs first because it is the only seed matching on direct evidence (the `o`
 * flag) rather than on an inferred shape, so it should never lose a cluster to
 * a band-and-span guess.
 *
 * @type {ReadonlyArray<{ id: string, name: string, basis: string,
 *   match: (shape: ReturnType<typeof shapeOf>) => boolean }>}
 */
export const SEED_PATTERNS = [
  {
    id: 'persona-scaffolding',
    name: 'Persona scaffolding',
    basis:
      'Findings §5.3: 46 hand-typed role-scaffolding prompts across 43 sessions and 6 projects, '
      + '≈76,165 input tokens, every one of them on Codex — the largest single measured win in the '
      + 'corpus. Only 5 of the 46 cluster at even Jaccard 0.6, so a repetition threshold cannot see '
      + 'this family at all; the `o` flag is the only thing that identifies it, which is why this '
      + 'predicate reads the flag and nothing else.',
    match: (s) => s.personas > 0 && s.personas * 2 > s.size,
  },
];

/**
 * The first seed whose predicate accepts this cluster, or null.
 *
 * @param {Partial<PromptCluster>} [cluster]
 * @returns {{ id: string, name: string, basis: string }|null}
 */
export function matchSeed(cluster) {
  const shape = shapeOf(cluster);
  return SEED_PATTERNS.find((seed) => seed.match(shape)) ?? null;
}

// ── the honest fallback ─────────────────────────────────────────────────────

/** What each class is called in prose. `unknown` and `other` both read as the
 *  bare "prompt" — `other` covers imperatives AND declaratives (RULING A,
 *  final-triage item 1: the shape rules only ever test for interrogative-ness,
 *  so naming the other side "instruction" would assert imperativeness nobody
 *  measured), and `unknown` is a cluster nobody classified at all. Two
 *  genuinely different questions, one honest noun for both — the `class` chip
 *  next to a characterized name is what still tells them apart. */
const CLASS_NOUNS = { question: 'question', other: 'prompt', mixed: 'mixed prompt' };

/**
 * The lead clause plus the full descriptor, built once so `characterize` and
 * `labelFor` (RULING B, final-triage item 2) never restate the same string
 * two different ways. The lead is the class-noun clause alone ("Recurring
 * 3-token prompt"); `full` appends the span/host tail
 * ("Recurring 3-token prompt · 21 sessions · both hosts").
 *
 * IT EMITS COUNTS AND BANDS ONLY. No host name, no session id, no hash reaches
 * either string, so nothing here can carry an identifier out of the index and
 * into a rendered page — the caller renders host chips from `cluster.hosts` if
 * it wants them named. A segment with nothing to count is omitted rather than
 * rendered as a zero.
 *
 * @param {Partial<PromptCluster>} [cluster]
 * @returns {{ lead: string, full: string }}
 */
function characterizeParts(cluster) {
  const s = shapeOf(cluster);
  const lead = `Recurring ${s.tokens}-token ${CLASS_NOUNS[s.cls] ?? 'prompt'}`;
  const parts = [lead];
  if (s.sessions > 0) parts.push(`${s.sessions} session${s.sessions === 1 ? '' : 's'}`);
  if (s.hosts === 2) parts.push('both hosts');
  else if (s.hosts > 0) parts.push(`${s.hosts} host${s.hosts === 1 ? '' : 's'}`);
  return { lead, full: parts.join(' · ') };
}

/**
 * A descriptor for a cluster with no name — assembled from its metadata and
 * asserting nothing beyond it: "Recurring 3-token prompt · 21 sessions ·
 * both hosts". The FULL string; `labelFor`'s characterized branch splits this
 * into a bare `name` plus a `descriptor` (RULING B) via the same
 * `characterizeParts` this calls, so the two can never drift apart.
 *
 * @param {Partial<PromptCluster>} [cluster]
 * @returns {string}
 */
export function characterize(cluster) {
  return characterizeParts(cluster).full;
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * What to call this cluster: direct persona evidence, then consensus semantic
 * facets, then a characterization.
 *
 * For a characterized result, `name` is the bare lead clause while
 * `descriptor` carries the full string (lead plus span/host tail) for a
 * surface with no columns to spare. A seeded name is already the whole phrase.
 *
 * @param {Partial<PromptCluster>} [cluster] A cluster from `nearDupClusters`.
 * @returns {{ name: string, source: 'seed'|'semantic'|'characterized',
 *   firstSeen: string|null, seed: string|null, descriptor?: string,
 *   intent?: string, topic?: string }}
 */
export function labelFor(cluster) {
  const seed = matchSeed(cluster);
  if (seed) return { name: seed.name, source: 'seed', firstSeen: null, seed: seed.id };
  const intent = cluster?.intent?.id;
  const topic = cluster?.topic?.id;
  const semantic = semanticName(intent, topic, cluster?.class);
  if (semantic) {
    return {
      name: semantic, source: 'semantic', firstSeen: null, seed: null,
      intent: intentLabel(intent) ?? (cluster?.class === 'question' ? 'Question' : 'Unclassified'),
      ...(topicLabel(topic) ? { topic: topicLabel(topic) } : {}),
    };
  }
  const { lead, full } = characterizeParts(cluster);
  return {
    name: lead, source: 'characterized', firstSeen: null, seed: null, descriptor: full,
  };
}
