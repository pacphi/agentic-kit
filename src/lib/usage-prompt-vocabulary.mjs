// usage-prompt-vocabulary.mjs — what a prompt cluster is CALLED.
//
// The Prompts view renders pattern names, never prompt text (spec §2.3): the
// dashboard's whole privacy split rests on names being drawn from a curated
// vocabulary rather than lifted from what the operator typed. This module is
// that vocabulary, and the resolution order behind it.
//
// ── v1 DESIGN ───────────────────────────────────────────────────────────────
//
// A name comes from one of three places, in strictly decreasing order of
// authority:
//
//   1. THE LABEL STORE — a caller-supplied map the kit owns beside the index:
//
//        { [clusterKey]: { name, source: 'curated'|'enriched', firstSeen } }
//
//      `curated` is a name a person wrote; `enriched` is one layer-3 inference
//      produced (spec §6.3) and then settled — settled labels are never
//      re-judged. This module never reads or writes the store; it is handed in,
//      which keeps this file pure and keeps the storage decision with the
//      caller.
//
//   2. A SEED PATTERN — the small registry below, for the handful of clusters
//      the 2026-08-29 research measured by name before any store exists.
//
//   3. `characterize` — a generic descriptor assembled from the cluster's own
//      metadata, which asserts nothing the numbers do not already say.
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
// A shape predicate is a heuristic. "Instruction, 5-15 tokens, 8+ sessions" is
// what the release ritual looked like in one corpus; it is not what a release
// ritual IS. Each seed records the measured cluster it was cut from in its
// `basis`, and every seed match reports `source: 'seed'` so the view can render
// it as the provisional reading it is. Layer-3 enrichment overwrites any of
// them with a real label the moment it produces one — that is the point of the
// store outranking this list.

/**
 * Token-count bands. `tap` is the spec's own supervision-tap threshold (§3.1,
 * ≤4 normalized tokens) so the two never disagree; `medium` ends at 60, the
 * corpus's p50 unique-token count; `xlong` is where the retyped Codex personas
 * live (median ≈530 tokens).
 */
export const TOKEN_BANDS = ['tap', 'short', 'medium', 'long', 'xlong'];

/** Every provenance `labelFor` can report. The first two come from the store,
 *  the third from this file's registry, the fourth from `characterize`. */
export const LABEL_SOURCES = ['curated', 'enriched', 'seed', 'characterized'];

/** Store sources a caller's entry may declare; anything else reads as curated. */
const STORE_SOURCES = new Set(['curated', 'enriched']);

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
  {
    id: 'release-ritual',
    name: 'Release ritual',
    basis:
      'Findings §5.2: `Help me release and deploy the next semantic version of agentic-kit?` — 13 '
      + 'prompts, 13 sessions, 9 days, median 9 tokens; the wider family reaches 23 prompts across 22 '
      + 'sessions and 14 days in ELEVEN distinct phrasings. Eleven phrasings for one procedure is the '
      + 'tell that there is no skill holding it. Cut to that cluster: an instruction, short enough to '
      + 'be a request rather than a spec, recurring across most of a month.',
    match: (s) => s.cls === 'instruction' && s.band === 'short' && s.sessions >= 8,
  },
  {
    id: 'commit-and-push',
    name: 'Commit-and-push instruction',
    basis:
      'Findings §5.2: `Commit and push.` — 13 prompts, 11 sessions, 9 days, median 3 tokens, plus '
      + '`Push to remote` at 4/4/4; the commit-or-push family is 24 prompts over 21 sessions, 15 days '
      + 'and 6 projects in 6 phrasings. Distinguished from the release ritual by band alone (tap vs '
      + 'short), and from a one-afternoon habit by the day span.',
    match: (s) => s.cls === 'instruction' && s.band === 'tap' && s.sessions >= 4 && s.days >= 3,
  },
  {
    id: 'progress-check-in',
    name: 'Progress check-in',
    basis:
      'Findings §5.2: `How are we doing? Progress?` — 9 prompts, 9 sessions, 8 days, median 4 tokens; '
      + '17 in the wider family across 14 sessions and 11 days. The question-side twin of the '
      + 'commit-and-push shape, and a reporting gap rather than a knowledge gap: the agent has the '
      + 'answer and is not offering it.',
    match: (s) => s.cls === 'question' && s.band === 'tap' && s.sessions >= 4 && s.days >= 3,
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

/** What each class is called in prose. `unknown` is deliberately just "prompt":
 *  a cluster nobody classified must not be described as though it were. */
const CLASS_NOUNS = { question: 'question', instruction: 'instruction', mixed: 'mixed prompt' };

/**
 * A descriptor for a cluster with no name — assembled from its metadata and
 * asserting nothing beyond it: "Recurring 3-token instruction · 21 sessions ·
 * both hosts".
 *
 * IT EMITS COUNTS AND BANDS ONLY. No host name, no session id, no hash reaches
 * the string, so nothing here can carry an identifier out of the index and into
 * a rendered page — the caller renders host chips from `cluster.hosts` if it
 * wants them named. A segment with nothing to count is omitted rather than
 * rendered as a zero.
 *
 * @param {Partial<PromptCluster>} [cluster]
 * @returns {string}
 */
export function characterize(cluster) {
  const s = shapeOf(cluster);
  const parts = [`Recurring ${s.tokens}-token ${CLASS_NOUNS[s.cls] ?? 'prompt'}`];
  if (s.sessions > 0) parts.push(`${s.sessions} session${s.sessions === 1 ? '' : 's'}`);
  if (s.hosts === 2) parts.push('both hosts');
  else if (s.hosts > 0) parts.push(`${s.hosts} host${s.hosts === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * What to call this cluster: the label store first, then a seed pattern, then a
 * characterization.
 *
 * The store wins unconditionally, including over a seed that also matches. That
 * is the mechanism by which the provisional shape heuristics above get
 * replaced: a person renaming a cluster, or a layer-3 pass settling a label on
 * it, permanently outranks the guess without anyone having to edit this file.
 *
 * @param {Partial<PromptCluster>} [cluster] A cluster from `nearDupClusters`.
 * @param {Record<string, { name?: string, source?: string, firstSeen?: string }>} [store]
 * @returns {{ name: string, source: 'curated'|'enriched'|'seed'|'characterized',
 *   firstSeen: string|null, seed: string|null }}
 */
export function labelFor(cluster, store) {
  const entry = typeof cluster?.key === 'string' ? store?.[cluster.key] : null;
  const stored = typeof entry?.name === 'string' ? entry.name.trim() : '';
  if (stored) {
    return {
      name: stored,
      source: STORE_SOURCES.has(entry.source) ? /** @type {'curated'|'enriched'} */ (entry.source) : 'curated',
      firstSeen: typeof entry.firstSeen === 'string' ? entry.firstSeen : null,
      seed: null,
    };
  }
  const seed = matchSeed(cluster);
  if (seed) return { name: seed.name, source: 'seed', firstSeen: null, seed: seed.id };
  return { name: characterize(cluster), source: 'characterized', firstSeen: null, seed: null };
}
