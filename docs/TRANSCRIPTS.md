# Transcripts & Session Detail — Maintainer Reference

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
*per-session* pipeline. The design rationale for both is ADR-0009
([`docs/adr/0009-usage-scorecard-local-transcript-analytics.md`](adr/0009-usage-scorecard-local-transcript-analytics.md)),
§8 in particular.

**Pinned to.** branch `fix/codex-usage-scorecard-metrics`, 2026-07-26 (the
commit introducing turn `kind` attribution). Line numbers drift as code
changes; every citation below was content-verified against the source at
writing time.

---

## 1. The two transcript stores

Both providers write complete session logs to disk as JSONL — one JSON object
per line — and the kit reads them **read-only** (transcripts are never
rewritten; rule 3 of the module header, `usage-index.mjs:22-29`):

| Provider | Store | Discovered by |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl` | `listClaude` (`usage-index.mjs:579`) — exactly one level of project directories |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` | `listCodex` (`usage-index.mjs:594`) — the `yyyy/mm/dd` tree walk |

Roots come from `defaultRoots()` (`usage-index.mjs:571`) and are injectable
for tests. A malformed line is skipped, never fatal (`jsonLines`,
`usage-index.mjs:270` — one corrupt line must not cost a whole file).

### 1.1 Claude entry vocabulary

Each line has a top-level `type`. The parser (`parseClaude`,
`usage-index.mjs:389-472`) reads:

| `type` | What the parser takes from it |
|---|---|
| `ai-title` | The model-written session title (`usage-index.mjs:397`) — preferred over the first-prompt fallback |
| `user` | A user-**role** turn — which is *not* the same as "the human"; see §3 |
| `assistant` | A model turn: `model` id, per-turn `usage` token counts, `tool_use` blocks (`usage-index.mjs:417-460`) |
| any | Side-band fields read regardless of type: `attributionSkill`/`attributionPlugin` (`usage-index.mjs:398-399`), `isSidechain` (`usage-index.mjs:400`), `cwd` for project derivation |

An assistant entry with `isApiErrorMessage: true` is a **local placeholder**
Claude Code writes when a request dies before a real completion (connection
drop, rate limit, auth failure — `model: "<synthetic>"`, all-zero usage). It
is real engaged time but not a model attempt: counted as an *exception*, never
pushed into `models` or priced (`usage-index.mjs:431-440`; the full story is
[`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) §10).

### 1.2 Codex entry vocabulary

Codex rollout lines carry `type` + `payload`. The parser (`parseCodex`,
`usage-index.mjs:489-559`) reads:

| `type` / `payload.type` | What the parser takes from it |
|---|---|
| `session_meta` | Authoritative session id, `cwd`, and `thread_source` (`usage-index.mjs:501-506`) — `"subagent"` marks a thread_spawn replay whose tokens are excluded from aggregation (`usage-index.mjs:544`; `USAGE-SCORECARD-METRICS.md` §15 Bug B) |
| `turn_context` | The model id in effect from this point on (`usage-index.mjs:507`) |
| `event_msg` → `token_count` | A **cumulative** usage snapshot; only the last one is kept (`usage-index.mjs:514`) |
| `event_msg` → `user_message` | A real human prompt — Codex does not route tool output through this event (`usage-index.mjs:519-527`) |
| `event_msg` → `agent_message` | A model response (`usage-index.mjs:529-540`) |

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
| **Scan** — the aggregate index behind the Scorecard/Findings/Sessions views | `buildIndex` → `parseFile` (`usage-index.mjs:624`) | `false` | never held — holding them would balloon memory across 3,000+ files (`usage-index.mjs:385-388`) | yes: per-file derived records in `~/.config/agentic-kit/usage-index.json`, keyed `(path, mtime, size)`, invalidated wholesale by `SCHEMA_VERSION` (`usage-index.mjs:46`) |
| **Reader** — one transcript for the Transcript view | `readSession` (`usage-index.mjs:1050`) | `true` | full turn list built | **never** — every call re-reads and re-parses the one file |

The reader path being cache-free is load-bearing for maintainers: **turn-shape
changes (like the `kind` field, §3) need no `SCHEMA_VERSION` bump**, because
no turn is ever served from cache — whereas *session-record* fields (like
`exceptions`) do, since stale cached records would otherwise sum `undefined`
into totals (the v4 bump note, `usage-index.mjs:39-45`, records exactly that
incident).

---

## 3. The turn model — and why `role: "user"` does not mean "the human"

`readSession` returns `{ meta, turns }`. Each turn carries:

| Field | On | Meaning |
|---|---|---|
| `role` | all | `"user"` or `"assistant"` — the **Messages-API role**, not the author (see below) |
| `at` | all | ISO timestamp |
| `text` | all | Flattened display text (`claudeText`, `usage-index.mjs:334` — binary payloads dropped: a pasted screenshot renders as `[image]`, a tool result is prefixed `[tool result]`) |
| `model` | assistant | The model id; the literal string `exception` for an API-error placeholder turn (`usage-index.mjs:435`) |
| `tools` | assistant | Tool names invoked in the turn |
| `prompt` | user | `isHumanPrompt`'s verdict (`usage-index.mjs:354-362`) — drives the **prompt counts** |
| `kind` | user | `'prompt'` \| `'tool-result'` \| `'context'` — drives the **attribution label** (`userTurnKind`, `usage-index.mjs:377-388`) |
| `exception` | assistant | `true` on API-error placeholder turns |
| `truncated`, `originalChars` | any | Present **only** when the turn was abridged (§4.3) |

### 3.1 The role≠author problem

The Messages API records two things under `role: "user"` that the person never
typed: **tool results** (after the model calls a tool, the harness feeds the
output back as a user-role message — that is the wire format, not a kit
choice) and **harness context injections** (`isMeta` entries: command outputs,
system reminders). In a heavily agentic session these dominate: a measured
real session on the reference machine had **20 human prompts and 276 tool
results** — so a renderer that labels by role attributes ~93% of "you" turns
to a person who never typed them. That was the shipped bug this section's
machinery fixes (ADR-0009 §8, Amendment 2026-07-26).

### 3.2 `kind` — the attribution field

`userTurnKind` (`usage-index.mjs:377-388`) classifies every user-role turn:

| `kind` | Test | Meaning |
|---|---|---|
| `tool-result` | content carries a `tool_result` block | Output the **harness** fed back to the model after a tool call |
| `context` | `isMeta` | Harness-injected context — command output, system reminders |
| `prompt` | everything else | The person |

Two deliberate subtleties:

- **`kind` is broader than `prompt` on the image-only edge.** An image-only
  paste has no text block, so `isHumanPrompt` returns `false` (it is not
  *counted* as a text prompt) — but it **is** the person acting, and
  `userTurnKind` returns `'prompt'` for it. "Not countable as a text prompt"
  and "not the human" are different claims; conflating them was how the
  original bug happened. The `prompt` boolean is left untouched so prompt
  counts don't shift.
- **`tool-result` outranks `context`**: a `tool_result` block on an `isMeta`
  entry is still tool feedback.

Codex user turns are `kind: 'prompt'` by construction (`usage-index.mjs:519-527`)
— rollouts only record real prompts as `user_message` events (§1.2).

Coverage: `tests/kit/usage-index.test.mjs` — "user-role turns carry a kind"
(both providers, the fixture's real `tool_result` entry) and "isMeta context
and image-only pastes get the right kind" (the two edges).

---

## 4. The `readSession` pipeline — how one session becomes a payload

`readSession(id, opts)` (`usage-index.mjs:1050-1139`) is the only way
transcript content leaves the module, and every step is a gate:

### 4.1 Locate, contain, bound

1. **Id grammar before any filesystem access** — `VALID_ID`
   (`/^[A-Za-z0-9._-]{1,128}$/`, `usage-index.mjs:61`) rejects traversal
   shapes with `ERR_INVALID_SESSION_ID` (`usage-index.mjs:1051`).
2. **Locate by id** across both roots (`locate`, `usage-index.mjs:1009`),
   consulting the scan cache when present but never requiring it —
   `readSession` works with no prior `buildIndex`.
3. **Realpath containment** (`usage-index.mjs:1057-1071`) — the resolved file
   must live under a transcript root *after* `realpathSync` collapses
   symlinks; a symlink planted inside a root pointing at `/etc/anything`
   passes a lexical `startsWith` but fails this. Roots are realpath'd too so
   a symlinked dotfiles setup still works.
4. **Size cap** — `MAX_SESSION_BYTES` (64 MB, `usage-index.mjs:60`): a
   transcript is read whole and JSON-expands ~5×, so an unbounded read is a
   memory-amplification primitive. Oversized reads as unavailable, not risky.

### 4.2 Parse and price

The file is parsed with `withTurns: true` by the provider's parser
(`usage-index.mjs:1082-1088`), and `meta` is assembled
(`usage-index.mjs:1096-1115`) with the same fields the Sessions view rows
carry — `prompts`, `responses`, `exceptions`, `sidechain`, `threadSource`,
`models`, `tools`, `skill`/`plugin`, worktree — plus a `cost` priced from the
same per-model usage rows `aggregate()` uses (the header used to render a
hardcoded `$0.00`; the comment at the site records why).

### 4.3 Mask, then truncate — both marked, differently

Every turn body is passed through `maskSecrets` (`usage-index.mjs:162` — the
21 secret shapes ADR-0009 §8 enumerates) **server-side, before
serialization**, then length-capped at `MAX_TURN_CHARS` (40,000,
`usage-index.mjs:55`) with the marker appended
(`usage-index.mjs:1116-1132`). Two invariants:

- **Presence is the signal.** `truncated`/`originalChars` are emitted only
  when the slice fired, so a complete turn cannot be misread as abridged.
- **`originalChars` is measured after masking** — it describes loss due to
  truncation alone, never a raw-file length.

The two kinds of withholding keep distinct vocabulary end-to-end: masking
renders as `…redacted` marks (`markRedactions`,
`dashboard-server.mjs:2171`), truncation as a `truncated · N of M` badge
(`truncBadge`, `dashboard-server.mjs:2187`, deriving N from the received
text so a changed constant can't desync the display).

---

## 5. The HTTP surface

All routes inherit the dashboard's loopback bind, DNS-rebinding `Host` guard,
and cross-site fetch-metadata guard (ADR-0005/0007; `dashboard-server.mjs`
request handler preamble). Transcript-relevant routes:

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
nothing on the page to reveal (ADR-0009 §8).

---

## 6. UI surfacing

### 6.1 Sessions view — the row and its expander

`renderSessions` (`dashboard-server.mjs:2120`) renders the project tree
(collapsed by default; every project starts closed so the cross-project
comparison stays above the fold). Each session is a `sessionRow`
(`dashboard-server.mjs:2094-2118`): host chip (claude/codex), title,
worktree glyph, category chip (dimmed when confidence < 0.6 or
Unclassified), start, duration, `prompts/responses`, tokens, cost — and an
expander (`sdetail`, `dashboard-server.mjs:2061-2091`) carrying the ten
fields that once shipped on the wire and rendered nowhere (ADR-0009 §5
Amendment): classification `basis` + confidence, per-session `models`, the
token split, top tools, and the `skill`/`plugin`/`sidechain`/`worktree`
flags. A measured-but-absent value renders as `—`, never disappears — a
field that vanishes when null teaches the reader it doesn't exist.

### 6.2 Transcript view — attribution, redaction, truncation

`renderTranscript` (`dashboard-server.mjs:2203`) renders the crumb (title,
project, duration, `prompts/responses`, tokens, cost — all from masked
`meta`) and the turn list. **The label comes from `kind`, never from role**
(`dashboard-server.mjs:2219-2236`):

| Turn | Label | Styling |
|---|---|---|
| user, `kind: 'prompt'` | `you` | accent — reserved for the person (`.t-user .t-who`, `dashboard-server.mjs:1270`) |
| user, `kind: 'tool-result'` | `tool result` | purple, rhyming with the tool chips (`.t-tool .t-who`, `dashboard-server.mjs:1274`); hover title states the harness — not the person — sent it |
| user, `kind: 'context'` | `context` | same purple + hover title |
| assistant | the model id | dim mono (`exception` placeholder turns label as `exception`) |

A turn without `kind` (defensive only — the reader path never serves cached
turns) falls back to the `prompt` flag, `false` ⇒ `tool result`.

Deep links: `#usage/<sessionId>` opens the Transcript view directly
(`syncHash`, `dashboard-server.mjs:1390-1391`); the view lazy-fetches via
`loadTranscript` (`dashboard-server.mjs:1864`).

### 6.3 Verified against real data

Run against this machine's real stores at implementation time (2026-07-26):

- A real Claude session (this feature's own working session, 884 turns):
  `{ prompt: 20, context: 6, 'tool-result': 276, assistant: 588 }`, zero
  user turns missing `kind`. All 276 tool results previously rendered as
  `YOU`.
- A real Codex rollout (8 user turns): every one `kind: 'prompt'`, as §1.2
  predicts.

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

## 8. Verification methodology

Every citation above was content-checked against the live source at writing
time (the same automated approach `USAGE-SCORECARD-METRICS.md` §16 records:
extract every `file:line` reference, assert an expected substring at that
line, zero tolerance). The kind-attribution behavior is pinned by unit tests
at both layers — parser (`tests/kit/usage-index.test.mjs`) and served page +
masking gate (`tests/dashboard.test.cjs`) — and was additionally verified
against real transcripts from both providers (§6.3), not only fixtures.
