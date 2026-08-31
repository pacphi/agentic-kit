# Prompts → Coaching panel redesign — design spec

**Status:** approved (design locked from mockup `4c22f66f`, 2026-08-31). Build on
`feat/usage-intelligence`. Archives to `docs/archive` on completion per convention.

**Predecessor:** the shipped Prompts view (ADR-0039). This redesign reworks its
**Repeated patterns** + **Coaching** panels into a single **Coaching** panel, and
fixes the **Host interplay** caveat. Everything else in the Prompts view is unchanged.

## 1. Purpose

Turn the recurring-patterns table into the coaching surface: one sortable, filterable
table where each pattern expands to *what you typed*, *where*, *what to change*, and a
copyable *draft* — so the operator learns their own habits and can act, on their own
local machine, without leaving the dashboard.

## 2. The locked interaction

A single **Coaching** panel (renames the old "Recurring clusters" panel; the standalone
Coaching card-wall is retired — its content moves into the rows):

- **Kind filter pills** above the table: `All` + one pill per derived kind present
  (§3), each with a colored swatch and a count. Clicking filters the table; stacks with
  column sort. `All` resets. Empty result shows a named empty state, not a blank grid.
- **Sortable table**, columns exactly: **Pattern · Times typed · Sessions · Days seen ·
  Hosts**. Every header sorts asc/desc (click toggles; numeric default desc, name asc),
  with an arrow indicator and a `title` tooltip giving the precise definition. No Type,
  Suggested-move, or Open columns. No `enriched`/`seed` source sublabel. No colored kind
  dot on the row (the color lives in the filter pills).
- **≤5 patterns visible, then scroll**; the header stays pinned. Opening a row scrolls
  its panel to the top of the capped window so it is never stranded below the fold.
- **Pattern name expands an inline coaching panel** (accordion; one open at a time) with,
  in order:
  1. **Seen in** — up to 3 session occurrences (`session · date`), each a real link to
     that session's masked transcript (`#usage/<sessionId>` → the existing
     `/api/session/:id` reader), plus `+N more`. Replaces the old dead `#1 #2 #3` Open
     column (whose links were malformed against the router).
  2. **What you typed** — the masked prompt text, shown **inline** (not behind a reveal
     button), the same way the draft is shown. Fetched on demand from the masked
     verbatim endpoint (§4.2). A global **prompt text · shown / hidden** toggle (top bar,
     per-viewer, `localStorage`, default **shown**) suppresses it for screen-sharing;
     `hidden` shows a terminal pointer instead and makes NO fetch.
  3. **Recommendation** — a bold title (no "Try:" prefix) + one-line rationale.
  4. **Draft instructions** — a `<pre>` with a **copy icon** top-right (tooltip on hover,
     click copies to clipboard and flips to a checkmark; select-fallback when the
     clipboard API is unavailable). No standing "select & copy" hint text.
  5. **Dismiss** — a button whose explanation is a **hover tooltip** (not standing text);
     clicking persists the dismissal (§4.3) and shows an inline "Dismissed … Undo".
- **Host interplay caveat** — the opaque "windows are unequal" sentence is replaced by a
  plain-language **read** of the data (e.g. "you tap codex ~2× as often but write claude
  ~2× as long"); the unequal-histories nuance moves into the panel's `?` tooltip only.
- **Remove** the "Prompt-type taxonomy" placeholder box entirely, and fix the stale
  hardcoded **"not built yet"** subtitle on the Coaching section header
  (`src/lib/dashboard/page.mjs`).

## 3. Derived `kind` (the filter dimension)

The shipped classifier only emits `question / other / mixed / unknown`. The five filter
kinds are a **derived** single label per cluster, computed at projection-build time from
signals the cluster already carries, with this **precedence** (first match wins):

1. **re-ask** — the cluster's member hashes intersect the "asked-again" side of
   `reAskPairs` (both are in scope in `buildPromptPatterns`). A repeated ask that keeps
   coming back is the most actionable, so it wins.
2. **role-preamble** (persona) — `cluster.personas / cluster.size ≥ PERSONA_KIND_SHARE`
   (majority are typed persona openers, `o === true`).
3. **tap** — `cluster.tokens.median ≤ TAP_MAX_TOKENS` (short approvals/nudges).
4. **question** — `cluster.class === 'question'`.
5. **instruction** — everything else (`other`/`mixed`/`unknown`, non-short, non-persona).

The precedence and the one new constant (`PERSONA_KIND_SHARE`) are recorded in the
ADR-0039 amendment (§6). `kind` is added to each cluster row in the projection; the pill
labels (`Taps`, `Questions`, `Instructions`, `Role preambles`, `Re-asks`) are a client
display map. Pure function of the corpus; recomputed every scan; no new fingerprint data.

## 4. Backend contracts

### 4.1 Projection — `kind` per cluster

`promptClusterRow` (`usage-aggregate.mjs`) gains `kind` (§3). `buildPromptPatterns` passes
the re-ask "asked-again" hash set into the row builder. Tested: precedence order,
boundary at each threshold, a cluster matching two signals takes the higher-precedence
kind.

### 4.2 Masked verbatim — `GET /api/prompts/samples?key=<clusterKey>&window=<days>`

Token-gated (existing global `/api/` gate), loopback-only. Resolves the cluster (by
`key`, validated against the projection's own key set — never a raw filesystem path) to
its member hashes, re-reads their transcripts through the **same deep-pass machinery the
CLI `--deep` uses** (`readPromptEntries` → `reReadTurns` → `humanPromptTurns`), applies
**`maskSecrets`** to every returned string, and returns up to `SAMPLES_PER_CLUSTER`
distinct masked samples plus the occurrence list (`sessionId`, `day`) — the same shape
the "Seen in" strip renders. **No unmasked text ever leaves the process; nothing is
persisted.** Security contract (mirrors the deep-pass review): masking applied before
every egress including error paths; cluster key charset-validated; `resolvesInsideRoot`
guards every transcript path; `MAX_DEEP_FILE_BYTES` enforced before read; a resolution
failure returns an honest empty result, never a stack trace or a path.

### 4.3 Dismiss write — `POST /api/prompts/dismiss` body `{ id }`

Token-gated, loopback-only. Validates `id` against `CARD_ID_SLUG_RE` **before** any write,
then `dismissCard(ledger, id, now)` + atomic `saveLedger`. Relaxes ADR-0039's read-only
dashboard-ledger rule for this **one non-inference, non-sensitive local write** (§6).
Idempotent; unknown id → 404 JSON, no write. A companion `POST /api/prompts/undismiss`
(or `{ id, undo:true }`) reverses it. No prompt text touches this path.

### 4.4 Seen-in navigation

The occurrence links target `#usage/<sessionId>` and must actually open that session's
transcript. Fix the client link format against the router's real contract
(`bootstrap.mjs`) — the earlier bug shipped links the router could not resolve.

### 4.5 Cluster → coaching-card association (the pattern-centric join)

The expanded panel's **Recommendation / Draft / Dismiss** come from a coaching **card**, but
cards are a separate unit (6 rules, keyed by id — and dismiss operates on a card id). A
pattern row therefore needs to know which card, if any, addresses it. The signal already
exists: cluster-targeting rules carry `evidence.clusterKey` (via `findSeedCluster`, matched
on the published seed label). The backend publishes two fields on each coaching card:

- `clusterKey` (string | null) — the specific cluster this card is about (from evidence).
- `targetKind` (string | null) — the derived `kind` a card addresses when it is
  kind-level rather than cluster-specific (static per rule: `reask-delta → reask`,
  `progress-report-taps → tap`, `codex-role-library → persona`).

**Client association, per cluster row (first match):** (1) a card with
`card.clusterKey === cluster.key`; else (2) a card with `card.targetKind === cluster.kind`;
else (3) none. When associated, the panel renders that card's recommendation, draft, source,
and a **Dismiss** bound to the card id (§4.3). When not, the panel shows **Seen in** +
**What you typed** only, with a neutral "No specific coaching for this pattern yet." — never
a force-fit recommendation (evidence-honesty).

**Host-level cards** that map to neither a cluster nor a kind (`codex-completion-criteria` —
host asymmetry) do **not** appear in the pattern table in v1; they are host-level and are
deferred from this pattern-centric surface (recorded in the ADR §6). No prompt text is added
to any card by this association; `clusterKey`/`targetKind` are ids and enum values only.

## 5. Privacy & security posture (what changed, and why it's safe)

- **Prompt text now appears in the browser by default** (masked), where before the view
  showed none. Justification: the dashboard is loopback-bound and per-session-token
  gated; the operator is viewing **their own** transcripts on **their own** machine; and
  the browser already serves masked transcript text through `/api/session/:id`. The new
  endpoint is a cluster-scoped instance of that same masked reader. The masking guarantee
  (secrets redacted server-side) is unchanged; the `hidden` toggle preserves a text-free
  posture for screen-sharing.
- **The dashboard now writes the ledger** (dismiss only). It is a local, loopback,
  token-gated write of a single enum-shaped flag — not inference, not prompt text. The
  read-only-for-inference rule stands; only dismissal is exempted.
- Both new endpoints get the security seat in the final review.

## 6. ADR-0039 amendments (recorded before archiving this spec)

1. **Derived kind** — the five-kind precedence (§3) and `PERSONA_KIND_SHARE`; the shipped
   classifier's `question/other` is unchanged and still underlies the `question` kind.
2. **Prompt text shown by default** — the reveal-on-request model is superseded by
   inline masked text + a per-viewer hide toggle; the masked verbatim endpoint (§4.2) and
   its security contract.
3. **Dismiss as a dashboard write** — the scoped relaxation of the read-only ledger rule
   (§4.3).

## 7. Non-goals / unchanged

- The fingerprint/provenance/baseline layers, the canonical-30d outcome ledger, the
  enrichment path, the aggregate projection's other fields — all unchanged.
- No new inference. No prompt text persisted anywhere. No change to `ak usage prompts`
  CLI behavior (it keeps its own `--deep`, `--dismiss`, `--enrich`).
- The kind is derived, not a new fingerprint field; the CLI need not render it in v1.

## 8. Acceptance criteria

- Coaching panel renders kind pills (only kinds present), sortable human-labeled headers
  with tooltips, ≤5-row scroll with pinned header, and the accordion coaching panel with
  all five sections. Taxonomy box, kind dots, Type/Suggested/Open columns, source
  sublabels, and the "not built yet" label are gone.
- `kind` precedence is unit-pinned at every boundary; filters slice correctly and stack
  with sort; empty filter states are named.
- `GET /api/prompts/samples` returns only masked text (a planted secret is redacted;
  proven by test), validates the cluster key, guards paths, and degrades honestly.
- `POST /api/prompts/dismiss` validates the id before writing, persists, is idempotent,
  and reverses; the dashboard reflects the dismissed state.
- Seen-in links open the correct session transcript.
- Host-interplay caveat reads as an insight; the `?` tooltip carries the nuance.
- `pnpm run check` green; UI harness covers filter/sort/expand/copy/dismiss; doc-citations
  green; the three-seat final review (whole-branch + brutal-honesty QE + security) clears,
  security explicitly signing off on the two new endpoints.

## 9. Build order

1. **Backend** — `kind` in the projection (§4.1); the masked verbatim endpoint (§4.2);
   the dismiss/undismiss endpoints (§4.3). TDD, security tests first for the endpoints.
2. **Frontend** — the Coaching panel rework (filters, sortable table, ≤5 scroll, host
   caveat, taxonomy/label removals, "not built yet" fix) and the expand panel (Seen-in
   links, inline masked text via §4.2, recommendation, draft+copy, dismiss+tooltip via
   §4.3), plus the prompt-text posture toggle.
3. **Docs** — ADR-0039 amendments (§6); METRICS/DASHBOARD updates; re-anchor doc-citations.
4. **Final** — three-seat review, one fix wave, `pnpm run check`, push; then archive this
   spec + the plan to `docs/archive`.
