# Transcripts & Session Detail — Reference

**Audience.** agentic-kit maintainers and contributors touching the transcript
pipeline — `src/lib/usage-index.mjs` (parsing, `readSession`) or
`src/lib/dashboard-server.mjs` (the `/api/session` route, the Sessions and
Transcript views) — and anyone auditing why a transcript turn is labelled,
masked, truncated, or attributed the way it is.

**Purpose.** The Transcript view renders raw session content, which makes it
the panel's highest-stakes surface: a wrong label misattributes work, an
unmarked redaction misrepresents content, and a leaked secret amplifies into a
screenshare. This document explains, with source citations, how a session on
disk becomes the metadata and turns the browser renders — the full path:
transcript stores → parsers → turn model → `readSession` → masking/truncation
→ HTTP → UI. Its companion,
[`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md), covers the
*aggregate* pipeline (cost/token/time arithmetic); this document covers the
*per-session* pipeline. The design rationale for both is mapped in
[Appendix C](#appendix-c--design-rationale-adr-map).

**Citations are machine-checked.** Every `file:line` citation below is
verified against the current source by the test suite
(`tests/kit/doc-citations.test.mjs`; see
[Appendix B](#appendix-b--verification-record)).

![Figure: the per-session pipeline — a session file passes from the transcript stores through readSession's numbered gates (id grammar, locate, realpath containment, size cap, parse, secret masking, truncation), then the guarded HTTP route, into the Transcript view](assets/transcript-pipeline.svg)

---

## 1. The two transcript stores

Both providers write complete session logs to disk as JSONL — one JSON object
per line — and the kit reads them **read-only** (transcripts are never
rewritten; rule 3 of the module header, `usage-index.mjs:22-29`):

| Provider | Store | Discovered by |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl` | `listClaude` (`usage-index.mjs:607`) — exactly one level of project directories |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` | `listCodex` (`usage-index.mjs:622`) — the `yyyy/mm/dd` tree walk |

Roots come from `defaultRoots()` (`usage-index.mjs:599`) and are injectable
for tests. A malformed line is skipped, never fatal (`jsonLines`,
`usage-index.mjs:274` — one corrupt line must not cost a whole file).

### 1.1 Claude entry vocabulary

Each line has a top-level `type`. The parser (`parseClaude`,
`usage-index.mjs:417-500`) reads:

| `type` | What the parser takes from it |
|---|---|
| `ai-title` | The model-written session title (`usage-index.mjs:425`) — preferred over the first-prompt fallback |
| `user` | A user-**role** turn — which is *not* the same as "the human"; see §3 |
| `assistant` | A model turn: `model` id, per-turn `usage` token counts, `tool_use` blocks (`usage-index.mjs:445-488`) |
| any | Side-band fields read regardless of type: `attributionSkill`/`attributionPlugin` (`usage-index.mjs:426-427`), `isSidechain` (`usage-index.mjs:428`), `cwd` for project derivation |

An assistant entry with `isApiErrorMessage: true` is a **local placeholder**
Claude Code writes when a request dies before a real completion (connection
drop, rate limit, auth failure — `model: "<synthetic>"`, all-zero usage). It
is real engaged time but not a model attempt: counted as an *exception*, never
pushed into `models` or priced (`usage-index.mjs:459-468`; the full story is
[`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) §10).

### 1.2 Codex entry vocabulary

Codex rollout lines carry `type` + `payload`. The parser (`parseCodex`,
`usage-index.mjs:517-587`) reads:

| `type` / `payload.type` | What the parser takes from it |
|---|---|
| `session_meta` | Authoritative session id, `cwd`, and `thread_source` (`usage-index.mjs:529-534`) — `"subagent"` marks a thread_spawn replay whose tokens are excluded from aggregation (`usage-index.mjs:572`; `USAGE-SCORECARD-METRICS.md` Appendix A, Bug B) |
| `turn_context` | The model id in effect from this point on (`usage-index.mjs:535`) |
| `event_msg` → `token_count` | A **cumulative** usage snapshot; only the last one is kept (`usage-index.mjs:542`) |
| `event_msg` → `user_message` | A real human prompt — Codex does not route tool output through this event (`usage-index.mjs:547-555`) |
| `event_msg` → `agent_message` | A model response (`usage-index.mjs:557-568`) |

Codex tool calls and tool outputs travel in event types the parser does not
surface as turns at all — so a Codex transcript renders as a prompt/response
conversation without the tool-result interleaving a Claude transcript shows.
That is a fidelity gap (less detail), not an attribution bug (nothing is
mislabelled).

---

## 2. Two read paths: scan vs reader

The same parsers serve two very different callers, switched by `withTurns`:

| Path | Entry point | `withTurns` | Message bodies | Cached? |
|---|---|---|---|---|
| **Scan** — the aggregate index behind the Scorecard/Findings/Sessions views | `buildIndex` → `parseFile` (`usage-index.mjs:652`) | `false` | never held — holding them would balloon memory across 3,000+ files (`usage-index.mjs:413-416`) | yes: per-file derived records in `~/.config/agentic-kit/usage-index.json`, keyed `(path, mtime, size)`, invalidated wholesale by `SCHEMA_VERSION` (`usage-index.mjs:50`) |
| **Reader** — one transcript for the Transcript view | `readSession` (`usage-index.mjs:1078`) | `true` | full turn list built | **never** — every call re-reads and re-parses the one file |

![Figure: one parser, two read paths — the scan path (withTurns false) caches per-file records keyed by path, mtime and size; the reader path (withTurns true) builds full turns and is never cached](assets/transcript-read-paths.svg)

The reader path being cache-free is load-bearing for maintainers: **turn-shape
changes (like the `kind` field, §3) need no `SCHEMA_VERSION` bump**, because
no turn is ever served from cache — whereas *session-record* fields (like
`exceptions`) do, since stale cached records would otherwise sum `undefined`
into totals (`usage-index.mjs:39-49`; the incidents behind that rule are
recorded in `USAGE-SCORECARD-METRICS.md` Appendix A).

---

## 3. The turn model — and why `role: "user"` does not mean "the human"

`readSession` returns `{ meta, turns }`. Each turn carries:

| Field | On | Meaning |
|---|---|---|
| `role` | all | `"user"` or `"assistant"` — the **Messages-API role**, not the author (see below) |
| `at` | all | ISO timestamp |
| `text` | all | Flattened display text (`claudeText`, `usage-index.mjs:338` — binary payloads dropped: a pasted screenshot renders as `[image]`, a tool result is prefixed `[tool result]`) |
| `model` | assistant | The model id; the literal string `exception` for an API-error placeholder turn (`usage-index.mjs:463`) |
| `tools` | assistant | Tool names invoked in the turn |
| `prompt` | user | `isHumanPrompt`'s verdict (`usage-index.mjs:378-387`) — drives the **prompt counts** |
| `kind` | user | `'prompt'` \| `'tool-result'` \| `'context'` — drives the **attribution label** (`userTurnKind`, `usage-index.mjs:405-416`) |
| `exception` | assistant | `true` on API-error placeholder turns |
| `truncated`, `originalChars` | any | Present **only** when the turn was abridged (§4.3) |

### 3.1 The role≠author problem

The Messages API records two things under `role: "user"` that the person never
typed: **tool results** (after the model calls a tool, the harness feeds the
output back as a user-role message — that is the wire format, not a kit
choice) and **harness context injections** (`isMeta` entries: command outputs,
system reminders). In a heavily agentic session these dominate: a measured
real session on the reference machine had **20 human prompts and 276 tool
results** — so a renderer that labels by role would attribute ~93% of "you"
turns to a person who never typed them. (Such a renderer shipped once; the
story is [Appendix A](#appendix-a--fix-history).)

![Figure: the kind decision cascade for user-role turns — tool_result block, then isMeta or harness envelope, else prompt — and the measured 884-turn session where 276 of 302 user-role turns are tool results](assets/transcript-turn-attribution.svg)

### 3.2 `kind` — the attribution field

`userTurnKind` (`usage-index.mjs:405-416`) classifies every user-role turn:

| `kind` | Test | Meaning |
|---|---|---|
| `tool-result` | content carries a `tool_result` block | Output the **harness** fed back to the model after a tool call |
| `context` | `isMeta`, **or** the text opens with a harness-output envelope (`HARNESS_OUTPUT_RE`: `task-notification`, `bash-stdout`/`-stderr`, `local-command-stdout`/`-stderr`, `local-command-caveat`) | Harness-injected content — neither the person **nor the model**. These envelopes carry neither `isMeta` nor a `tool_result`, so text shape is the only signal (the envelope census is in §6.2) |
| `prompt` | everything else | The person — including `bash-input` (a `! command` the person typed) and slash-command records (the person invoked them) |

Two deliberate subtleties:

- **`kind` is broader than `prompt` on the image-only edge.** An image-only
  paste has no text block, so `isHumanPrompt` returns `false` (it is not
  *counted* as a text prompt) — but it **is** the person acting, and
  `userTurnKind` returns `'prompt'` for it. "Not countable as a text prompt"
  and "not the human" are different claims.
- **Harness-output envelopes are excluded from the prompt *count* too.**
  `isHumanPrompt` shares `HARNESS_OUTPUT_RE`, so a session's `prompts` figure
  never counts stdout dumps or task notifications as things the person said
  (`SCHEMA_VERSION` 5, `usage-index.mjs:46-50`; the correction this shipped
  with is in [Appendix A](#appendix-a--fix-history)).
- **`tool-result` outranks `context`**: a `tool_result` block on an `isMeta`
  entry is still tool feedback.

Codex user turns are `kind: 'prompt'` by construction (`usage-index.mjs:547-555`)
— rollouts only record real prompts as `user_message` events (§1.2).

Coverage: `tests/kit/usage-index.test.mjs` — "user-role turns carry a kind"
(both providers, the fixture's real `tool_result` entry) and "isMeta context
and image-only pastes get the right kind" (the two edges).

---

## 4. The `readSession` pipeline — how one session becomes a payload

`readSession(id, opts)` (`usage-index.mjs:1078-1161`) is the only way
transcript content leaves the module, and every step is a gate:

### 4.1 Locate, contain, bound

1. **Id grammar before any filesystem access** — `VALID_ID`
   (`/^[A-Za-z0-9._-]{1,128}$/`, `usage-index.mjs:65`) rejects traversal
   shapes with `ERR_INVALID_SESSION_ID` (`usage-index.mjs:1079`).
2. **Locate by id** across both roots (`locate`, `usage-index.mjs:1037`),
   consulting the scan cache when present but never requiring it —
   `readSession` works with no prior `buildIndex`.
3. **Realpath containment** (`usage-index.mjs:1085-1099`) — the resolved file
   must live under a transcript root *after* `realpathSync` collapses
   symlinks; a symlink planted inside a root pointing at `/etc/anything`
   passes a lexical `startsWith` but fails this. Roots are realpath'd too so
   a symlinked dotfiles setup still works.
4. **Size cap** — `MAX_SESSION_BYTES` (64 MB, `usage-index.mjs:64`): a
   transcript is read whole and JSON-expands ~5×, so an unbounded read is a
   memory-amplification primitive. Oversized reads as unavailable, not risky.

### 4.2 Parse and price

The file is parsed with `withTurns: true` by the provider's parser
(`usage-index.mjs:1110-1116`), and `meta` is assembled
(`usage-index.mjs:1124-1143`) with the same fields the Sessions view rows
carry — `prompts`, `responses`, `exceptions`, `sidechain`, `threadSource`,
`models`, `tools`, `skill`/`plugin`, worktree — plus a `cost` priced from the
same per-model usage rows `aggregate()` uses (the header used to render a
hardcoded `$0.00`; the comment at the site records why).

### 4.3 Mask, then truncate — both marked, differently

Every turn body is passed through `maskSecrets` (`usage-index.mjs:166` — the
21 secret shapes) **server-side, before
serialization**, then length-capped at `MAX_TURN_CHARS` (40,000,
`usage-index.mjs:59`) with the marker appended
(`usage-index.mjs:1144-1160`). Two invariants:

- **Presence is the signal.** `truncated`/`originalChars` are emitted only
  when the slice fired, so a complete turn cannot be misread as abridged.
- **`originalChars` is measured after masking** — it describes loss due to
  truncation alone, never a raw-file length.

The two kinds of withholding keep distinct vocabulary end-to-end: masking
renders as `…redacted` marks (`markRedactions`,
`dashboard-server.mjs:2184`), truncation as a `truncated · N of M` badge
(`truncBadge`, `dashboard-server.mjs:2228`, deriving N from the received
text so a changed constant can't desync the display).

![Figure: a turn body passes through maskSecrets (leaving redaction marks) and then the 40,000-character cap (leaving a truncated · N of M badge); originalChars is measured after masking](assets/transcript-mask-truncate.svg)

---

## 5. The HTTP surface

All routes inherit the dashboard's loopback bind, DNS-rebinding `Host` guard,
and cross-site fetch-metadata guard (`dashboard-server.mjs` request handler
preamble). Transcript-relevant routes:

| Route | Serves | Notes |
|---|---|---|
| `GET /api/usage?days=N` | the aggregate minus `sessions[]` (`dashboard-server.mjs:337`) | Scorecard + Findings + the project tree |
| `GET /api/sessions` | session rows, filtered/paginated (`dashboard-server.mjs:355`) | the Sessions view's "load all" |
| `GET /api/session/:id` | one transcript (`dashboard-server.mjs:372-403`) | the Transcript view |

`/api/session/:id` order of operations, each step deliberate:

1. `parseSessionId` (`dashboard-server.mjs:174`) + `resolvesInsideRoot`
   (`dashboard-server.mjs:188`) — **validation before the index is touched**;
   a rejected id 400s without any filesystem call.
2. `readSession` — a well-formed id matching no file is **404, not
   200-with-null** (200 made every nonexistent session look empty and the
   route a mild existence oracle).
3. **The masking gate covers the whole payload**: `maskMeta`
   (`dashboard-server.mjs:218`) *and* `maskTurns`
   (`dashboard-server.mjs:199-208`), both fail-closed — no masker, no
   transcript, ever. `maskTurns` rewrites **string fields only**, which is
   what lets the non-string attribution fields (`kind`, `prompt`,
   `truncated`, `originalChars`) survive to the browser; asserted by test
   ("maskTurns preserves the non-string attribution fields",
   `tests/dashboard.test.cjs`).

There is deliberately **no download or copy-all control, and no
click-to-reveal**: the original never reaches the browser, so there is
nothing on the page to reveal.

---

## 6. UI surfacing

### 6.1 Sessions view — the row and its expander

`renderSessions` (`dashboard-server.mjs:2133`) renders the project tree
(collapsed by default; every project starts closed so the cross-project
comparison stays above the fold). Each session is a `sessionRow`
(`dashboard-server.mjs:2107-2131`): host chip (claude/codex), title,
worktree glyph, category chip (dimmed when confidence < 0.6 or
Unclassified), start, duration, `prompts/responses`, tokens, cost — and an
expander (`sdetail`, `dashboard-server.mjs:2074-2104`) carrying the
per-session detail fields: classification `basis` + confidence, per-session
`models`, the token split, top tools, and the
`skill`/`plugin`/`sidechain`/`worktree` flags. A measured-but-absent value renders as `—`, never disappears — a
field that vanishes when null teaches the reader it doesn't exist.

### 6.2 Transcript view — attribution, redaction, truncation

`renderTranscript` (`dashboard-server.mjs:2244`) renders the crumb (title,
project, duration, `prompts/responses`, tokens, cost — all from masked
`meta`) and the turn list. **The label comes from `kind`, never from role**
(`dashboard-server.mjs:2260-2277`):

| Turn | Label | Styling |
|---|---|---|
| user, `kind: 'prompt'` | `you` | accent — reserved for the person (`.t-user .t-who`, `dashboard-server.mjs:1270`) |
| user, `kind: 'tool-result'` | `tool result` | purple, rhyming with the tool chips (`.t-tool .t-who`, `dashboard-server.mjs:1274`); hover title states the harness — not the person — sent it |
| user, `kind: 'context'` | `context` | same purple + hover title |
| assistant | the model id | dim mono (`exception` placeholder turns label as `exception`) |

A turn without `kind` (defensive only — the reader path never serves cached
turns) falls back to the `prompt` flag, `false` ⇒ `tool result`.

**Harness sentinel markup is restyled, never rewritten.** Claude Code writes
XML wrappers into transcript *text*: a slash command records as a
`<command-name>/<command-message>/<command-args>` triple, a `! command` the
person ran records as `<bash-input>`, and harness-fed content as
`<bash-stdout>`/`<bash-stderr>`, `<local-command-stdout>`/`-stderr`,
`<local-command-caveat>`, `<system-reminder>`, and `<task-notification>`
blocks (envelope census on the real corpus: task-notification 550,
local-command-caveat 183, command-name 180, bash-input 85, bash-stdout 85,
local-command-stdout 60; the stderr variants are the symmetric error-path
siblings). Rendered literally they read as angle-bracket soup, so
`fmtHarness` (`dashboard-server.mjs:2197-2216`; CSS
`dashboard-server.mjs:1275-1287`) reformats them client-side: the command
triple and `bash-input`
become chips (`/clear`-style; the bash chip prefixed `!` so it reads as the
shell invocation it was), and the block wrappers become quiet labelled
panels (`system reminder` / `caveat` / `command output` / `bash output` /
`task notification`). This is presentation only, per the same
no-silent-alteration rule that governs masking: **wrapped content stays
verbatim; only the wrapper tags become styling.** It runs on escaped text
(after `markRedactions`), and an unmatched tag — e.g. one cut mid-block by
turn truncation — is left raw rather than half-formatted.

Deep links: `#usage/<sessionId>` opens the Transcript view directly
(`syncHash`, `dashboard-server.mjs:1403-1404`); the view lazy-fetches via
`loadTranscript` (`dashboard-server.mjs:1877`).

---

## 7. Provider differences at a glance

| | Claude Code | Codex CLI |
|---|---|---|
| Human prompts | `user` entries passing `isHumanPrompt` | `user_message` events |
| Tool results as turns | yes — `kind: 'tool-result'` | not surfaced (different event types; fidelity gap, §1.2) |
| Harness context as turns | yes — `kind: 'context'` (`isMeta`) | not surfaced |
| Model per assistant turn | per-turn `message.model` | last `turn_context` model in effect |
| Token usage | per-assistant-turn `usage` object | cumulative `token_count`; last snapshot wins |
| API-error placeholders | `<synthetic>` / `isApiErrorMessage` → exceptions | none observed |
| Delegation markers | `isSidechain` → `sidechain` flag | `thread_source: "subagent"` → excluded from aggregation, session kept visible |
| Session title | model-written `ai-title`, first-prompt fallback | first prompt clipped |

**Planned third provider:** OpenRouter-served sessions are invisible to the
scorecard today; ingesting them (discovery → parser → `kind` attribution →
pricing → by-host UI) is tracked as
[#59](https://github.com/pacphi/agentic-kit/issues/59).

---

## Appendix A — Fix history

The main body describes only current behavior; this appendix records what
was wrong before, for the curious.

- **User-role turns rendered as "you" (fixed 2026-07-26).** Before `kind`
  existed, the Transcript view labelled every user-role turn as the person.
  On the reference session that misattributed 276 tool results and 6 harness
  context injections — ~93% of its "you" turns (§3.1's measured split). The
  turn-`kind` machinery in §3 is the fix.
- **Prompt counts included harness output (SCHEMA_VERSION 5).**
  `isHumanPrompt` once counted harness-output envelopes as human prompts —
  32 claimed vs 20 real on the reference session. Cached session records
  carried the inflated counts, hence the wholesale `SCHEMA_VERSION` 5 cache
  invalidation (`usage-index.mjs:46-50`).
- **Session expander fields shipped but unrendered.** The per-session fields
  §6.1's expander now renders (classification `basis` + confidence, the
  token split, flags) once travelled on the wire and rendered nowhere.
- **Aggregate-side incidents** (the v4/v5 cache bumps, the Codex parsing
  defects) are recorded in `USAGE-SCORECARD-METRICS.md` Appendix A.

---

## Appendix B — Verification record

**Methodology.** Every `file:line` citation above is checked against the
current source on every test run by `tests/kit/doc-citations.test.mjs`
(mechanism and upkeep: `USAGE-SCORECARD-METRICS.md` Appendix B). The
kind-attribution behavior is pinned by unit tests at both layers — parser
(`tests/kit/usage-index.test.mjs`) and served page + masking gate
(`tests/dashboard.test.cjs`).

**Against real data** (this machine's real stores, 2026-07-26):

- A real Claude session (this feature's own working session, 884 turns):
  `{ prompt: 20, context: 6, 'tool-result': 276, assistant: 588 }`, zero
  user turns missing `kind`.
- A real Codex rollout (8 user turns): every one `kind: 'prompt'`, as §1.2
  predicts.

---

## Appendix C — Design rationale (ADR map)

Design decisions are deliberately kept out of the main body; they live in
the ADRs:

| Main-body topic | Design record |
|---|---|
| Masking, truncation, no-reveal transcript rules (§4–§6) | [ADR-0009](adr/0009-usage-scorecard-local-transcript-analytics.md) §8 |
| Turn-`kind` attribution (§3) | ADR-0009 §8 (amendment 2026-07-26) |
| Session-expander classification fields (§6.1) | ADR-0009 §5 |
| Dashboard HTTP guards — loopback bind, `Host` guard, fetch metadata (§5) | ADR-0005, ADR-0007 |
