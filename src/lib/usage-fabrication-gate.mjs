// usage-fabrication-gate.mjs — does a number a synthesized card STATES actually
// measure the thing the sentence attaches it to?
//
// WHY THIS MODULE EXISTS (QE review F-3, HIGH). The gate this replaces asked a
// weaker question than its name promised. `numbersInSummary` flattened the
// findingsSummary into one `Set` of every finite number at any depth, and a
// card passed if each cited numeral appeared SOMEWHERE in it. That is
// provenance-of-value, not grounding: the number did not have to measure the
// claim, and the DIMENSION the sentence named did not have to exist in the
// data at all. Measured on a corpus sized to this machine's own (458
// clusters), 41 of the 100 integers 1..100 were admissible — and the denser
// the corpus, the weaker the gate, so it degraded exactly as the tool became
// more useful. The review's demonstration:
//
//   finding: You spent 3 sessions waiting on releases that took 2 days to
//            land, across 13 projects.
//
// accepted, though findingsSummary carries NO project data of any kind. "13
// projects" was pure invention that passed because 13 happened to be some
// unrelated cluster's day count.
//
// WHAT THIS ASKS INSTEAD. Every number in the summary is indexed by the PATH
// WORDS that reach it — `hosts.codex.personaOpeners` indexes 43 under
// {hosts, codex, personaOpeners}. A cited number is then bound to the word the
// prose attaches it to, and that word must name a path this number is actually
// reachable from. "13 projects" now fails on the word `projects`, which names
// no path in the summary at all.
//
// WHAT IT STILL DOES NOT DO, stated plainly so the name does not overclaim
// again: it checks that a number measures the DIMENSION it is attached to, not
// that the SENTENCE is true. "3 sessions waiting on releases" binds fine if 3
// is a real session count somewhere — the gate has no idea what "waiting on
// releases" means, and cannot. This is why F-9 renders `source: enriched` on
// both surfaces unconditionally: the operator is told a model wrote the card.
//
// CALIBRATION. The forgiving/strict balance was set against the three cards a
// real `--enrich` run actually produced on this machine, because a gate that
// drops legitimate cards is its own kind of failure — the operator never
// learns it happened. Those cards phrase numbers as "36 times", "34 sessions",
// "16 days", "6-count/6-session/1-day", "a single 1260-token prompt", "43
// persona-scaffolding openers compared to 10 on Claude", "typed totals of 1460
// (codex) vs 662 (claude)", and "count 9, sessions 9, all within days: 1".
// Every one of those must pass, and the rules below are shaped by them: the
// noun can follow the number, be welded to it with a hyphen, or precede it.

/** The words a model plausibly uses for each numeric leaf in the summary,
 *  including each leaf's own key name. One word may name several dimensions
 *  ("prompts" could be a cluster count or a host's typed total); a claim binds
 *  if the number is reachable under ANY of them, which is the forgiving
 *  direction on purpose. */
const DIMENSION_ALIASES = {
  count: ['count', 'counts', 'times', 'time', 'recurrences', 'recurrence',
    'occurrences', 'occurrence', 'repeats', 'repeat', 'instances', 'instance',
    'prompts', 'prompt'],
  sessions: ['sessions', 'session'],
  days: ['days', 'day'],
  typed: ['typed', 'prompts', 'prompt'],
  taps: ['taps', 'tap'],
  tapShare: ['tapshare', 'share', 'shares', 'percent', '%'],
  questionShare: ['questionshare', 'questions', 'question', 'share', 'shares', 'percent', '%'],
  p90TypedTokens: ['p90typedtokens', 'p90', 'tokens', 'token'],
  personaOpeners: ['personaopeners', 'personas', 'persona', 'openers', 'opener', 'scaffolding'],
  pairCount: ['paircount', 'pairs', 'pair', 're-ask', 're-asks', 'reask', 'reasks'],
  sessionCount: ['sessioncount', 'sessions', 'session'],
  tokens: ['tokens', 'token'],
};

/** word -> Set<dimension>, inverted from the table above. */
const DIMENSIONS_FOR_WORD = new Map();
for (const [dimension, words] of Object.entries(DIMENSION_ALIASES)) {
  for (const word of words) {
    if (!DIMENSIONS_FOR_WORD.has(word)) DIMENSIONS_FOR_WORD.set(word, new Set());
    DIMENSIONS_FOR_WORD.get(word).add(dimension);
  }
}

/** Words that carry no dimension of their own and must be stepped over rather
 *  than treated as the noun a number is attached to. Kept small: an
 *  over-eager list would step over a genuinely unknown noun like "projects",
 *  which is the exact word this gate exists to catch. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'at', 'by',
  'with', 'from', 'across', 'over', 'per', 'that', 'those', 'these', 'this',
  'your', 'you', 'their', 'its', 'it', 'is', 'are', 'was', 'were', 'be', 'been',
  'more', 'less', 'than', 'about', 'roughly', 'nearly', 'just', 'only', 'all',
  'within', 'into', 'out', 'up', 'down', 'separate', 'different', 'distinct',
  'additional', 'total', 'totals', 'single', 'same', 'each', 'every', 'other',
  'vs', 'versus', 'compared', 'against', 'plus', 'shows', 'show', 'showing',
]);

/** How far a claim looks for its noun. Three ahead covers "9 different
 *  sessions"; two behind covers "count 9" and "days: 1". Both windows stop at
 *  the next numeral, which begins its own claim, and at a clause boundary. */
const LOOKAHEAD = 3;
const LOOKBEHIND = 2;

const NUMBER_RE = /^(\d+(?:\.\d+)?)(%?)$/;
/** "1260-token", "6-count", "1-day" — the noun is welded to the number, and
 *  when it is, it is authoritative: no window scan can be better evidence of
 *  what a number measures than the word hyphenated onto it. */
const HYPHENATED_RE = /^(\d+(?:\.\d+)?)-([a-z][a-z-]*)$/;

/** Punctuation that ends the phrase a number belongs to. A colon is
 *  deliberately NOT here: it INTRODUCES a value ("days: 1"), so treating it as
 *  a break would cut a number off from the very word that names it. Calibrated
 *  against real cards — without these breaks, "sessions 9, all within days: 1"
 *  bound the 9 to `days` from the NEXT clause, and "vs 10 (claude)" reached
 *  back past a closing paren to bind `codex` from the previous one. */
const BOUNDARY_CHARS = /[,;.()[\]—–]/;

/**
 * Every number in `summary`, indexed by the set of PATH WORDS that reach it.
 * `hosts.codex.personaOpeners = 43` indexes 43 under {hosts, codex,
 * personaOpeners} — the host name is included deliberately, because a card
 * writing "10 on Claude" is naming a real path component and should bind.
 *
 * @param {object} summary a `buildFindingsSummary` result
 * @returns {Map<number, Set<string>>}
 */
export function pathWordsByNumber(summary) {
  const out = new Map();
  const walk = (node, trail) => {
    if (typeof node === 'number' && Number.isFinite(node)) {
      if (!out.has(node)) out.set(node, new Set());
      const words = out.get(node);
      for (const word of trail) words.add(word);
      return;
    }
    // An array's elements share their container's trail: `clusters[7].count`
    // is a `count` under `clusters`, and the index measures nothing.
    if (Array.isArray(node)) { for (const item of node) walk(item, trail); return; }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...trail, key.toLowerCase()]);
    }
  };
  walk(summary, []);
  return out;
}

/**
 * Split prose into comparable tokens: thousands separators removed, `/` and
 * whitespace both treated as breaks (a real card wrote
 * "6-count/6-session/1-day"), surrounding punctuation stripped while `%` and
 * `-` are kept because both carry meaning here — and each token flagged when a
 * clause boundary follows it. A token that is ONLY punctuation (a lone em
 * dash) contributes its boundary and no word.
 *
 * @returns {Array<{ word: string, boundaryAfter: boolean }>}
 */
function tokensOf(text) {
  const raw = String(text ?? '').replace(/(\d),(\d)/g, '$1$2').toLowerCase().split(/[\s/]+/);
  const tokens = [];
  let pendingBoundary = false;
  for (const chunk of raw) {
    if (!chunk) continue;
    const lead = chunk.match(/^[^a-z0-9%-]+/)?.[0] ?? '';
    const word = chunk.replace(/^[^a-z0-9%-]+/, '').replace(/[^a-z0-9%-]+$/, '');
    const tail = word ? chunk.slice(lead.length + word.length) : chunk.slice(lead.length);
    if (BOUNDARY_CHARS.test(lead)) pendingBoundary = true;
    if (!word) { pendingBoundary = pendingBoundary || BOUNDARY_CHARS.test(chunk); continue; }
    if (pendingBoundary && tokens.length) tokens[tokens.length - 1].boundaryAfter = true;
    pendingBoundary = false;
    tokens.push({ word, boundaryAfter: BOUNDARY_CHARS.test(tail) });
  }
  return tokens;
}

/** The path words a prose word names, or null when it names none.
 *
 *  Two sources, and the second is why this takes a vocabulary: the STATIC
 *  alias table above covers the summary's fixed leaf names, but a summary also
 *  has DYNAMIC path components — the host names under `hosts` — and a card
 *  writing "10 on Claude" is naming a real path. Without that, every
 *  host-comparison card the live run produced would be dropped. */
function pathWordsFor(word, vocabulary) {
  if (!word) return null;
  const out = new Set();
  const add = (token) => {
    for (const dimension of DIMENSIONS_FOR_WORD.get(token) ?? []) out.add(dimension.toLowerCase());
    if (vocabulary.has(token)) out.add(token);
  };
  add(word);
  // "persona-scaffolding" names `persona`; try the parts of a compound before
  // giving up, so a hyphenated adjective does not read as an unknown noun.
  if (!out.size && word.includes('-')) for (const part of word.split('-')) add(part);
  return out.size ? out : null;
}

/** Walk `tokens` from `from` in `step` direction, up to `limit` tokens,
 *  stopping at a clause boundary or the next numeral. Yields each word. */
function* windowWords(tokens, from, step, limit) {
  for (let i = 1; i <= limit; i++) {
    const index = from + i * step;
    // Going backwards, the boundary that matters sits after the token we are
    // about to read; going forwards, after the one we just left.
    const guard = step > 0 ? tokens[index - 1] : tokens[index];
    if (guard?.boundaryAfter) return;
    const token = tokens[index];
    if (!token) return;
    if (NUMBER_RE.test(token.word) || HYPHENATED_RE.test(token.word)) return;
    yield token.word;
  }
}

/** The UNION of every path word named anywhere in one window, not the first
 *  hit. "in typed tokens (1460 …)" reads `tokens` first and `typed` second,
 *  and only the union binds 1460 correctly — stopping at the first match
 *  dropped a real card. */
function scanForPathWords(tokens, from, step, limit, vocabulary) {
  const found = new Set();
  for (const word of windowWords(tokens, from, step, limit)) {
    for (const path of pathWordsFor(word, vocabulary) ?? []) found.add(path);
  }
  return found.size ? found : null;
}

/** The first word ahead that is neither a stopword nor a numeral — the noun
 *  this number is attached to when the window named no path at all. Its
 *  presence is what separates "13 projects" (a dimension the summary does not
 *  have) from "…, up from 12." (no dimension claimed at all). */
function unknownNounAhead(tokens, from) {
  for (const word of windowWords(tokens, from, 1, LOOKAHEAD)) {
    if (!STOPWORDS.has(word)) return word;
  }
  return null;
}

/**
 * Every numeric claim one free-text field makes: the value, and the dimensions
 * the prose attaches it to (`null` when the prose attaches it to nothing this
 * module can read, `UNKNOWN` when it attaches it to a word that names no path
 * in the summary at all).
 *
 * Resolution order, and why: a hyphenated noun wins outright, because nothing
 * is better evidence of what a number measures than the word welded to it.
 * Otherwise a FOLLOWING noun wins over a preceding one — English writes
 * "43 persona openers", and reading backwards there would find "sessions" in
 * "Codex sessions show 43 persona-scaffolding openers" and bind the wrong
 * dimension. Only when nothing follows does a preceding noun apply, which is
 * what makes "count 9" and "days: 1" work.
 *
 * @param {string} text
 * @param {Set<string>} vocabulary every path word present in the summary
 * @returns {Array<{ value: number, paths: Set<string>|null, unknownNoun: string|null }>}
 */
export function numericClaims(text, vocabulary = new Set()) {
  const tokens = tokensOf(text);
  const claims = [];
  for (let i = 0; i < tokens.length; i++) {
    const { word } = tokens[i];
    const hyphenated = HYPHENATED_RE.exec(word);
    const plain = NUMBER_RE.exec(word);
    if (!hyphenated && !plain) continue;
    const value = Number(hyphenated ? hyphenated[1] : plain[1]);
    if (!Number.isFinite(value)) continue;

    if (hyphenated) {
      const paths = pathWordsFor(hyphenated[2], vocabulary);
      claims.push({ value, paths, unknownNoun: paths ? null : hyphenated[2] });
      continue;
    }
    // A trailing '%' is itself the noun: it names the share dimensions.
    const percentPaths = plain[2] === '%' ? pathWordsFor('%', vocabulary) : null;
    // A FOLLOWING noun decides, and only when nothing follows does a preceding
    // one apply. English writes "43 persona openers"; reading backwards first
    // would find "sessions" in "Codex sessions show 43 persona-scaffolding
    // openers" and bind the wrong dimension entirely.
    const ahead = percentPaths ?? scanForPathWords(tokens, i, 1, LOOKAHEAD, vocabulary);
    const unknown = ahead ? null : unknownNounAhead(tokens, i);
    const paths = ahead ?? (unknown ? null : scanForPathWords(tokens, i, -1, LOOKBEHIND, vocabulary));
    claims.push({ value, paths, unknownNoun: paths ? null : unknown });
  }
  return claims;
}

/**
 * Is one claim grounded in the summary?
 *
 * Three outcomes, in the order they are decided:
 *  - the value is not in the summary at all -> NOT grounded (the original
 *    existence check, unchanged and still first);
 *  - the prose names a dimension -> grounded only if the value is reachable
 *    under it (the F-3 fix);
 *  - the prose names a noun that maps to NO path in the summary -> NOT
 *    grounded, which is the "13 projects" case;
 *  - the prose names nothing readable -> grounded on value presence alone,
 *    the deliberate fallback for phrasings like "…, up from 12."
 *
 * @param {{ value: number, paths: Set<string>|null, unknownNoun: string|null }} claim
 * @param {Map<number, Set<string>>} byNumber a `pathWordsByNumber` index
 * @returns {boolean}
 */
export function claimIsGrounded(claim, byNumber) {
  const reachable = byNumber.get(claim.value);
  if (!reachable || !reachable.size) return false;
  if (claim.paths) {
    for (const word of claim.paths) if (reachable.has(word)) return true;
    return false;
  }
  return claim.unknownNoun === null;
}

/**
 * Every path word the summary contains — the vocabulary `numericClaims` needs
 * in order to recognize a dynamic path component (a host name) as naming a
 * real path rather than as an unknown noun.
 *
 * @param {Map<number, Set<string>>} byNumber a `pathWordsByNumber` index
 * @returns {Set<string>}
 */
export function vocabularyOf(byNumber) {
  const out = new Set();
  for (const words of byNumber.values()) for (const word of words) out.add(word);
  return out;
}
