# Spec — Usage scorecard (dashboard tab)

- **Date:** 2026-07-25
- **ADR:** [0009](../adr/0009-usage-scorecard-local-transcript-analytics.md)
- **Status:** Ready for implementation

Read ADR-0009 first — it carries the *why*. This document is the **interface contract**: module
boundaries, exact shapes, and behaviour each unit must exhibit. Modules are specified so they can be
built and tested independently and in parallel.

## 0. Scope

**In:** a sixth dashboard tab (`#usage`) with four views (Scorecard, Findings, Sessions, Transcript);
an incremental index over Claude + Codex transcripts; pricing; classification; findings detectors; a
panel-wide poll control.

**Out:** plan-utilisation modelling; any network call; mutation of any transcript; export/download of
transcript content; replacing `ruflo-token-audit`.

## 1. Module map

| Module | Purpose | Purity |
|---|---|---|
| `src/lib/pricing.mjs` | Model → rate tables; cost arithmetic | Pure |
| `src/lib/usage-classify.mjs` | Session → category + confidence | Pure |
| `src/lib/usage-insights.mjs` | Aggregates → ranked findings | Pure |
| `src/lib/usage-index.mjs` | Scan + incremental cache over both stores | I/O |
| `src/lib/dashboard-server.mjs` | Routes + Usage UI + poll control | I/O (edit) |

Pure modules take plain data and return plain data — **no `fs`, no `Date.now()` in a return value,
no network**. This is what makes them unit-testable without fixtures on disk.

## 2. `pricing.mjs`

```js
export const PRICES;                 // { [modelPrefix]: { in, out, provider, asOf } }
export const PRICES_AS_OF;           // 'YYYY-MM-DD' — surfaced in the UI
export function priceFor(model, provider);        // -> { in, out, matched: boolean }
export function costOf({ model, provider, input, output, cacheRead, cacheWrite });  // -> number (USD)
```

Rates are **$ per 1M tokens**, all verified 2026-07-25.

*Anthropic list:* Fable/Mythos 5 `10/50`; Opus 5, 4.8, 4.7, 4.6, 4.5 `5/25`; Sonnet 4.6/4.5 `3/15`;
Haiku 4.5 `1/5`. **Sonnet 5 is on introductory pricing `2/10` through 2026-08-31** (standard `3/15`) —
the table carries the rate actually billed today and flags the revert date, because using the
standard rate would overstate a Sonnet-heavy window by 50%.

*OpenAI* (verified against `developers.openai.com/api/docs/pricing`; there is **no** machine-readable
pricing in `~/.codex/models_cache.json` — checked, zero price keys):
`gpt-5.6-sol` `5/30`, `gpt-5.6-terra` `2.5/15`, `gpt-5.6-luna` `1/6`, `gpt-5.5` `5/30`,
`gpt-5.5-pro` `30/180`, `gpt-5.4` `2.5/15`, `gpt-5.4-mini` `0.75/4.5`, `gpt-5.4-nano` `0.2/1.25`,
`gpt-5.4-pro` `30/180`, `gpt-5.3-codex` `1.75/14`, `chat-latest` `5/30`,
`gpt-realtime-2.1` `4/24`, `gpt-realtime-2.1-mini` `0.6/2.4`.

**OpenAI publishes no introductory or promotional rates** — the asymmetry with Anthropic is
deliberate to record. OpenAI's cached input is likewise a 90% discount and cache writes 1.25×, i.e.
**the same multipliers as Anthropic**, so `costOf` needs no per-provider branch.

Deliberately unmodelled (documented in `UNMODELLED_PRICING_FACTORS`, since transcripts do not record
them): the +10% regional-processing uplift for models released on/after 2026-03-05; the reported
large-prompt surcharge above ~272K input tokens; Batch/Flex/Priority service tiers.

Formula — **cache multipliers are the whole point of this module**:

```text
cost = (input·in + cacheWrite·in·1.25 + cacheRead·in·0.1 + output·out) / 1e6
```

**Must:**

- Longest-prefix match, so `claude-haiku-4-5-20251001` resolves to the Haiku entry.
- Unknown model → a documented fallback rate with `matched:false` (never throw, never silently zero).
- `costOf` with all-zero usage returns exactly `0`.

**Tests:** a known-model exact-value case; the 0.1× cache-read multiplier verified independently
(a cache-read-only call must cost 1/10 of the same volume as fresh input); longest-prefix beating
short-prefix; unknown-model fallback sets `matched:false`; zero-usage → 0.

## 3. `usage-classify.mjs`

```js
export const CATEGORIES;    // string[] — closed vocabulary, includes 'Unclassified'
export const SKILL_CAT;     // { [skillOrPluginPrefix]: category }
export function classify({ title, skill, plugin, tools, prompts, responses });
// -> { category, confidence /* 0..1 */, basis /* 'skill:x' | 'plugin:x' | 'title+tools' | 'weak signal' | 'no signal' */ }
```

Three layers, in order (ADR-0009 §5): provenance → rules+tool-prior → floor.

- `skill` match is **prefix-based** (`autopilot:run-phase` matches the `autopilot` entry) and returns
  `confidence: 1.0`.
- Tool prior nudges scores, never decides alone: Edit+Write > 30% of calls favours build/refactor/fix;
  Read+Grep+Glob > 45% with Edit < 10% favours review/research; Agent+Task > 12% favours Orchestration.
- Confidence combines absolute score with **margin over the runner-up** — a tie must not score high.
- `confidence < 0.28` → `{ category: 'Unclassified' }`. This floor is a requirement, not a tuning knob.

**Tests:** provenance beats title (a `superpowers:brainstorming` session titled "fix bug" classifies
as Design & planning with confidence 1.0); empty title + no tools → `Unclassified` / basis `no signal`;
two equally-matching categories yield low confidence, not a confident arbitrary pick; a strong
security title classifies as Security review; tool prior alone (no title signal) does not exceed the
floor.

## 4. `usage-insights.mjs`

```js
export function detectInsights(agg);   // -> Insight[]  (ranked, most impactful first)
```

`Insight`:

```js
{ id, kind: 'coach'|'trend', severity: 'warn'|'info'|'ok',
  title, finding, evidence, action,
  command: string|null,
  impact: number|null,          // USD/window — null when not computable
  sources?: [{ label, url }] }
```

Detectors (each independently testable against a synthetic `agg`):

| id | Fires when | Impact |
|---|---|---|
| `context-tax` | median session `cacheWrite` × sessions is material | computed |
| `premium-on-routine` | premium-model spend on ≤6-response, ≤8-min sessions **and** projected saving ≥ 1% of window | computed |
| `churn` | ≤1-prompt, <2-min sessions exceed a cost floor | computed |
| `overnight` | >8% of responses in 01:00–05:59 local | `null` |
| `spend-trend` | recent half vs prior half differs ≥25% | `null` |
| `project-concentration` | top project >22% of spend | `null` |
| `classify-coverage` | Unclassified >25% of sessions | `null` |
| `model-routing` | prev-gen Opus ≥15% of spend | `null`, **carries `sources`** |
| `cost-per-session-spread` | costliest/cheapest category ratio ≥10× | `null` |
| `high-volume-automation` | a category has ≥100 sessions averaging **< 50% of the window's mean session cost** | `null` |

**Invariants (these are the ADR §6 rules, enforced in code):**

- An `impact` is a number **only** if derived from `agg`. Never a constant, never a guess.
- Absolute-dollar thresholds are forbidden for firing decisions — thresholds are **relative to window
  spend**, so a detector cannot dominate a small window with a large-window rule of thumb.
- `model-routing` **must** emit `sources` and **must not** recommend a blanket upgrade.

> An earlier draft of the table above wrote `high-volume-automation` as "averaging `<$5`", which
> contradicted invariant 2 — `$5` is an absolute-dollar firing threshold. The `$5` was really the
> reference corpus's *value* of the relative rule, not the rule. **Known limitation of the relative
> form:** it cannot flag *"everything is automation"* — if every session is cheap, the mean falls with
> them and nothing fires. Accepted, because the detector also requires ≥100 sessions and claims no
> dollar impact.

**Tests:** every threshold verified at boundary (just-below does not fire, just-above does);
`premium-on-routine` does **not** fire when the saving is under 1% of window even if absolute dollars
look large; ranking puts computed-impact findings above `null`-impact ones; `model-routing` output
contains ≥1 source and its `action` does not contain the word "upgrade" as a recommendation;
an empty `agg` yields `[]` and does not throw.

## 5. `usage-index.mjs`

```js
export async function buildIndex({ days, force, onProgress });  // -> Aggregate
export async function readIndex({ days });                      // cached, refresh-if-stale
export async function readSession(id);                          // -> { meta, turns[] }
export function mergeIntervals(intervals);                      // -> seconds (pure, exported for test)
export function projectLabel(cwd, dirName);                     // -> { project, worktree } (pure)
export function maskSecrets(text);                              // -> string (pure, exported for test)
export const SCHEMA_VERSION;    // bump invalidates every cached entry wholesale
export const IDLE_GAP_MS;       // 15min — silence longer than this ends a stretch of engagement
```

**Sources:** `~/.claude/projects/*/*.jsonl`, `~/.codex/sessions/*/*/*/rollout-*.jsonl`
(both overridable for test).

**Cache:** `~/.config/agentic-kit/usage-index.json`, entry key `(path, mtime, size)`. Unchanged
entries are reused verbatim; changed/new are re-parsed. Cache carries a `schemaVersion` — a bump
invalidates wholesale.

**Aggregate shape** (the contract `usage-insights` and the UI consume):

```js
{ generatedAt, windowDays, pricesAsOf,
  totals: { sessions, responses, input, output, cacheRead, cacheWrite, tokens, cost,
            spanMinutes,          // summed first-to-last spans — the honest-but-misleading tier
            spanUnionSeconds,     // union of whole spans
            engagedSeconds },     // union of ACTIVE sub-intervals — the tier the UI leads with
  byDay: { 'YYYY-MM-DD': { tokens, cost, sessions } },
  byModel, byProvider, byProject, byCategory,          // keyed maps
  punchcard: { 'dow-hour': responses },                 // dow 0=Mon
  projectTree: [{ project, sessions, cost, tokens, minutes, categories, rows: Session[] }],
  sessions: Session[],
  insights: Insight[] }
```

`Session`: `{ id, provider, title, project, worktree, start, minutes, prompts, responses, sidechain,
models, input, output, cacheRead, cacheWrite, tokens, cost, tools, category, confidence, basis,
skill, plugin }`. `readSession().meta` carries the same fields **plus `cost`** — priced from the
same per-model rows, because the transcript header otherwise rendered a hardcoded `$0.00`.

Every bucket map (`byModel` / `byProvider` / `byProject` / `byCategory`) carries `minutes` and a
session-weighted mean `confidence` in addition to the token/cost columns. Three consumers read
those and silently rendered zeros before they existed.

**Must:**

- **Single-flight** — a concurrent `buildIndex` joins the in-progress promise.
- **Never throw on a malformed line.** Skip and continue; one corrupt JSONL line must not lose a file.
- **Never mutate** a transcript; open read-only.
- `engagedSeconds` = union of each session's **active sub-intervals**, split at silences strictly
  longer than `IDLE_GAP_MS` — **not** the sum of spans, and not the union of whole spans either
  (an idle-but-open session would donate its whole idle stretch). The ordering
  `engagedSeconds <= spanUnionSeconds <= spanMinutes*60` must hold.
- `readSession` reads exactly one file by id — no directory scan.
- Codex: derive tokens from the **last** `token_count` event (`total_token_usage` is cumulative);
  `input` excludes `cached_input_tokens`, which map to `cacheRead`.

**Tests** (fixtures under `tests/fixtures/usage/`, tiny hand-written JSONL):
`mergeIntervals` — disjoint sums, overlapping merges, nested contained, touching endpoints, empty → 0;
`maskSecrets` — masks each pattern, leaves ordinary prose untouched, is idempotent;
a malformed line is skipped without losing the file's other turns;
an unchanged mtime/size reuses the cache entry (assert the parser is not re-entered);
Codex cumulative token handling picks the last event, not a sum;
a session with no assistant turns is excluded from `sessions`.

## 6. `dashboard-server.mjs` (edit)

**Routes** (all GET, all inheriting the existing loopback bind + `Host` guard):

| Route | Returns |
|---|---|
| `/api/usage?days=N` | rollups + `insights` + `projectTree`, with `sessions[]` dropped **and** each node's `rows` trimmed to `USAGE_TREE_PREVIEW` (25) alongside a `rowsTotal` |

Dropping the top-level `sessions[]` alone does **not** minimise anything — `projectTree[].rows`
holds the same object references, so every session still shipped. The tree preview is therefore
trimmed to what the client renders before "load all", which then fetches the remainder from
`/api/sessions`. `rowsTotal` preserves the true count so the control still knows what it is loading.
| `/api/sessions?days=N&project=&category=` | `{ sessions: Session[] }`, paginated |
| `/api/session/:id` | `{ meta, turns[] }` with secrets masked server-side |

`:id` **must** be validated against `^[A-Za-z0-9._-]{1,128}$` and resolved within the transcript
roots — a path-traversal attempt returns 400, never a file.

**UI:** sixth segment `Usage`; four sub-views; the Scorecard, Findings, tiered Sessions tree, and
Transcript reader as prototyped in `.superpowers/brainstorm/**/usage-v3.html` (reference rendering,
real data, validated structure).

**Poll control** (header band, governs all tabs): on/off; intervals
`15s 30s 1m 5m 15m 30m 1h 6h 12h 24h`; **default 30 s**; persisted as
`ak-dash-poll = {on, intervalMs}`; paused → pulse greys, manual refresh remains; **3 s cooldown +
single-flight** on every refresh path. Selecting an interval while paused resumes.

**Tests** (extend `tests/dashboard.test.cjs`): each route's shape and status; `:id` traversal
(`../../etc/passwd`, absolute path, over-long) → 400; `/api/session/:id` output contains no
unmasked secret pattern; the Usage tab is absent from the served HTML only if… (it is always present)
— assert the segment and the four view containers render; poll defaults to 30 s in the served script.

## 7. Non-functional

- **Zero new runtime dependencies.** `node:*` only, consistent with the whole kit.
- **No network call** from any path in this feature.
- Warm `/api/usage` responds in **< 500 ms** on the reference corpus; cold build shows progress.
- Existing `pnpm run check` (typecheck + eslint + markdownlint + build + test) stays green.
- New tests join the `pnpm test` chain in `package.json`.

## 8. Definition of done

1. `pnpm run check` green.
2. Every module in §2–§5 has unit tests covering its listed cases, written **before** its
   implementation.
3. `/api/session/:id` traversal tests pass.
4. Findings on the reference corpus claim a dollar figure only where computable, and `model-routing`
   carries its sources.
5. ADR-0009 index row added to `docs/adr/README.md`.
