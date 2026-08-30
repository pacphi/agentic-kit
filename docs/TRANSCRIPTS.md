# Transcripts & Session Detail — Reference

**Audience.** agentic-kit maintainers and contributors touching the transcript
pipeline — `src/lib/usage-index.mjs` (parsing, `readSession`),
`src/lib/dashboard-server.mjs` (HTTP composition),
`src/lib/dashboard/session-security.mjs` (request/masking guards), or
`src/lib/dashboard/client.mjs` (Sessions and Transcript views) — and anyone auditing why a turn is labelled,
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

Both supported transcript **hosts** write complete session logs to disk as JSONL — one JSON object
per line — and the kit reads them **read-only** (transcripts are never
rewritten; rule 3 of the module header, `usage-index.mjs:22`):

| Host | Store | Discovered by |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl` | `listClaude` (`usage-index.mjs:337-351`) — exactly one level of project directories |
| Claude Code (subagent) | `~/.claude/projects/<encoded-project-dir>/<sessionId>/subagents/agent-<hash>.jsonl` | `listClaudeSubagents` (`usage-index.mjs:312-317`) — the one nested shape `listClaude` descends into |
| Codex CLI | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` | `listCodex` (`usage-index.mjs:354-374`) — the `yyyy/mm/dd` tree walk |

Roots come from `defaultRoots()` (`usage-index.mjs:287-292`) and are injectable
for tests. A malformed line is skipped, never fatal (`jsonLines`,
`usage-parsers.mjs:169-175` — one corrupt line must not cost a whole file).

A session's **delegated** work is a real transcript of its own, written beside
the parent under `<sessionId>/subagents/`. Discovery is that one nested shape
and no more — not a recursive walk — so a directory that is not a session-id
directory with a `subagents` child contributes nothing rather than being
crawled. Each such record takes a **namespaced** id, `<sessionId>/<stem>`
(`usage-index.mjs:317`), because Claude Code names every subagent file
`agent-<hash>.jsonl` and that stem is not unique across two parent sessions; an
unnamespaced id would silently collide two unrelated records into one. §4.1
covers how a namespaced id is validated and resolved back to its file.

Host evidence is not inference-provider proof. A Claude transcript may describe Anthropic-,
OpenRouter-, or Ollama-served inference. ADR-0016 defines separate
[bindings and field provenance](adr/0016-capability-driven-integration-adapters.md). Until that
Proposed migration is implemented, the legacy session field named `provider` should be read as the
transcript host/parser identity unless other evidence grounds the inference provider.

### 1.1 Claude entry vocabulary

Each line has a top-level `type`. The parser (`parseClaude`,
`usage-parsers.mjs:602-631`) reads:

| `type` | What the parser takes from it |
|---|---|
| "ai-title" | The model-written session title (`usage-parsers.mjs:612`) — preferred over the first-prompt fallback |
| `user` | A user-**role** turn — which is *not* the same as "the human"; see §3. On a turn that passes isHumanPrompt, also its `permissionMode` — the session's permission posture, read on the person's own turn only (`usage-parsers.mjs:506-507`) — and the opening of the response-latency window |
| `assistant` | A model turn: `model` id, per-turn `usage` token counts, `tool_use` blocks (`usage-parsers.mjs:542-595`) |
| any | Side-band fields read regardless of type: `attributionSkill`/`attributionPlugin` (`usage-parsers.mjs:613-614`), `isSidechain` (`usage-parsers.mjs:616`), `cwd` for project derivation |

A real assistant completion also closes two pieces of per-entry evidence the
transcript does not state outright. It **closes the latency window** the
preceding human prompt opened, into one `noteLatencySample` call over the gap
between them (`usage-parsers.mjs:572-576`); and it **conditionally sets `ctxLastTokens`** to the
tokens actually in the model's window for that turn — fresh input plus what was
served from cache — so the field always describes the last completion rather
than a running total (`usage-parsers.mjs:590-591`). That write is
evidence-gated: an entry whose `message.usage` is absent decodes to all-zeros,
and a zero is not a measurement of an empty context, so it must not overwrite a
real prior value. Neither is a field Claude Code writes; both are derived, per
entry, at parse time.

An assistant entry with `isApiErrorMessage: true` is a **local placeholder**
Claude Code writes when a request dies before a real completion (connection
drop, rate limit, auth failure — `model: "<synthetic>"`, all-zero usage). It
is real engaged time but not a model attempt: counted as an *exception*, never
pushed into `models` or priced (`usage-parsers.mjs:549-570`; the full story is
[`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) §10). It is not a
latency sample either — the pending window is deliberately left open, so the
first *real* completion that eventually follows is what gets timed.

### 1.2 Codex entry vocabulary

Codex rollout lines carry `type` + `payload`. The parser (`parseCodex`,
`usage-parsers.mjs:968-986`) reads:

| `type` / `payload.type` | What the parser takes from it |
|---|---|
| `session_meta` | Authoritative session id, `cwd`, and `thread_source` — the FIRST such line in the file wins for all three, AND for `inferenceProvider`/`providerProvenance` too (`usage-parsers.mjs:685-687`, gate; `:655-684`, why); a subagent rollout replays its PARENT thread's own session_meta line later in the same file, and a later-wins rule let that relabel the record `subagent`→`user` and re-key its id to the parent's — `"subagent"` marks a thread_spawn replay whose tokens are excluded from aggregation (`usage-parsers.mjs:951`; `USAGE-SCORECARD-METRICS.md` Appendix A, Bug B) |
| `turn_context` | The model id in effect from this point on, plus `approval_policy` (a string) and `sandbox_policy` (an **object** keyed `.type`, e.g. `{"type":"danger-full-access"}`) — the permission posture, last evidence winning, since a session may renegotiate mid-run (`usage-parsers.mjs:697-718`) |
| `event_msg` → `token_count` | A **cumulative** usage snapshot; only the last one is kept (`usage-parsers.mjs:752-760`) |
| `event_msg` → `task_started` | `model_context_window` — the context-window denominator, which no other host records — and the turn's start time (`usage-parsers.mjs:767-772`) |
| `event_msg` → `task_complete` | The host's own `duration_ms` for the turn, taken as a latency sample only when no prompt-to-response gap already covered it; a non-null `error` counts as an exception (`usage-parsers.mjs:784-792`) |
| `event_msg` → `turn_aborted` | An explicit interrupt: counted in `aborts`, and it clears both latency states so an unanswered prompt is never timed against a later, unrelated response (`usage-parsers.mjs:895-903`) |
| `event_msg` → `user_message` | A legacy-format prompt CANDIDATE — Codex does not route tool output through this event, but the text still needs the human-prompt gate below before it counts |
| `event_msg` → `agent_message` | A legacy-format model response |
| `event_msg` → `item_completed` → `UserMessage` | A current-format prompt candidate; text blocks use the observed lowercase `text` discriminator; also gated below |
| `event_msg` → `item_completed` → `AgentMessage` | A current-format model response; text blocks use the observed uppercase `Text` discriminator |
| Human-prompt gate (`isCodexHumanMessage`, `usage-parsers.mjs:810-812`) | Codex carries no discipline of its own for telling a typed prompt apart from harness output or a mirrored cross-host envelope replayed into the rollout rather than typed there. Reuses "HARNESS_OUTPUT_RE" verbatim (Claude's own envelope markers reproduce byte-for-byte inside a mirrored rollout) plus two Codex-specific machine markers (`CODEX_MACHINE_ENVELOPE_RE`, `usage-parsers.mjs:810`): a `<teammate-message` wrapper and the literal `"Another Claude session sent a message:"` prefix cross-session delivery uses. Only a message that passes the gate counts toward `rec.prompts`, sets the session title, or opens the prompt→agent-message latency window at this call (`usage-parsers.mjs:832`); every `user_message`/`UserMessage` still gets a turn row either way, kind: 'context' instead of `'prompt'` when gated out (`:842`) — mirroring how a Claude harness-origin `user` entry is kept, not dropped (§3.2). Deliberately narrow: exact-twin cross-host dedup by flush timestamp is a recorded follow-up, not attempted here |
| `event_msg` → `item_completed` → `CommandExecution`, `McpToolCall`, `FileChange`, `CollabAgentToolCall` | The four item kinds tallied as tool invocations, keyed by their own Codex names (`CODEX_TOOL_ITEM_TYPES`, `usage-parsers.mjs:887`, tallied at this call: "CODEX_TOOL_ITEM_TYPES.has(decoded.unknownItemType)" — `usage-parsers.mjs:916-917`) |

The parser normalizes both message generations into the same prompt/response
turn model. Unknown `item_completed` item types are ignored for those metrics
and counted in Codex source diagnostics; they are not silently reclassified as
human prompts, model responses, or existing tool metrics. The four typed kinds
above are **counted, not surfaced as turns**: they raise Codex's tool tallies
under their own vocabulary — never renamed to a Claude tool, which would assert
an equivalence neither host makes — while their bodies still travel in events
the parser does not render. Codex tool *output* therefore remains outside the
turn list: a fidelity gap, not an attribution bug.

### 1.3 What these readers normalize, and what the hosts publish

The public host APIs are richer than the readers in this module, and they are
not interchangeable transcript schemas. What each reader normalizes is
therefore narrower than what its host offers — a fidelity gap, stated here so a
missing category is never read as an observed zero. Verified against the public
surfaces available on **2026-08-24**:

| Host | Public evidence | What this repository's reader normalizes |
|---|---|---|
| Claude Code | Hooks expose `transcript_path`, `tool_name`, tool input/results, and `tool_use_id`; its monitoring surface also documents `claude_code.tool` spans and tool-result events ([hooks reference](https://code.claude.com/docs/en/hooks), [monitoring](https://code.claude.com/docs/en/monitoring-usage)) | Prompts, responses, and normalized tool calls. Command, file-change, MCP, and collaboration activity are not normalized until their cross-host semantics are specified |
| Codex | The public `codex app-server` protocol documents typed `userMessage`, `agentMessage`, `commandExecution`, `fileChange`, `mcpToolCall`, and `collabToolCall` items ([app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)) | Only prompt/response items become turns. The rollout parser records unknown item kinds diagnostically and tallies four of them onto the session's `tools` map under their own Codex names (§1.2) — a name-and-count tally, not the normalized tool-call record Claude and OpenCode produce, which is why the two are never added together |
| OpenCode | The public SDK returns session messages with `parts`, and its public message model includes tool invocation parts ([SDK](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx), [message model](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message.ts)) | Prompts, responses, and persisted tool calls. Command, file-change, MCP, and collaboration activity are not normalized |

Three per-session axes are read on all three hosts, but from **different
evidence of different strength**, which is why each is reported with its own
absence rather than folded into one number:

| Axis | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Response latency | derived — the gap from a human prompt to the next real completion ("noteLatencySample", `usage-parsers.mjs:572-576`) | host-measured `duration_ms` on `task_complete`, used only when no prompt gap covered the turn; the derived gap stays primary (`handleCodexTaskComplete`, `usage-parsers.mjs:784-792`) | derived, same prompt-gap rule as Claude ("noteLatencySample", `usage-opencode.mjs:235-239`) |
| Permission posture | `permissionMode`, off the person's own turn (`usage-parsers.mjs:506-507`) | `approval_policy` plus `sandbox_policy.type` off each `turn_context` — the sandbox field is an object, and its `.type` is extracted before the taxonomy is consulted (`usage-parsers.mjs:703-716`) | `mode` off each assistant message (`normalizeMode`, `usage-opencode.mjs:240-241`) |
| Context window | last-turn tokens only; **no window denominator is recorded** | both halves — `model_context_window` on `task_started` and last-turn tokens | last-turn tokens only; no window denominator |

An unmapped or unobserved value on any of these is `not-recorded`, never a
guess: the posture taxonomy is a closed vocabulary whose every mapping is a
recorded judgment ([ADR-0038](adr/0038-consistent-cross-host-session-metrics.md)),
and a context-fill percentage is simply omitted where the denominator was never
recorded rather than divided by an assumed window.

`sourceHealth.<host>.diagnostics.common` is the additive, host-neutral
coverage envelope, and every field in it is counted rather than declared.
`unitsSeen` counts discovered session candidates in the requested window;
`unitsParsed` counts candidates parsed successfully; `unitsWithUsage`,
`unitsWithPrompts`, and `unitsWithResponses` count parsed units carrying each
kind of evidence; `prompts` and `responses` are observed totals.

`unknownKinds` is capped at 32 distinct wire kinds; additional occurrences are
retained in `unknownKindOverflow` so future schema growth cannot expand the
diagnostics payload without limit.

A readable source with zero observations is therefore distinguishable from an
absent or degraded one — the counters read zero in the first case, and the
source's own `status`/`reason` says so in the second — and neither is silently
converted into a host-specific metric. Existing status/reason fields and Codex
diagnostic keys remain in place for compatibility; the common envelope is
additive.

---

## 2. Two read paths: scan vs reader

The same parsers serve two very different callers, switched by `withTurns`:

| Path | Entry point | `withTurns` | Message bodies | Cached? |
|---|---|---|---|---|
| **Scan** — the aggregate index behind the Scorecard/Findings/Sessions views | `buildIndex` (`usage-index.mjs:569`) → `parseFile` (`usage-index.mjs:388`) | `false` | no turn list is built, and no body is retained — holding them would balloon memory across 3,000+ files (`parseClaude`'s own doc comment, `usage-parsers.mjs:602-606`). Since v14 the scan path does *read* one narrow slice: opencode's USER text parts, so a prompt can be fingerprinted (`loadTextParts`, `usage-opencode.mjs:276`). Only the fingerprint is kept; the text is discarded with the row. Measured at 45 µs/session materializing 0.6 MB on a 300-session store, against 125 µs and 61 MB for the reader path's unfiltered join | yes: per-file derived records in `~/.config/agentic-kit/usage-index.json`, keyed `(path, mtime, size)`, invalidated wholesale by `SCHEMA_VERSION` (`usage-index.mjs:141`) |
| **Reader** — one transcript for the Transcript view | `readSession` (`usage-index.mjs:963`) | `true` | full turn list built | **never** — every call re-reads and re-parses the one file |

![Figure: one parser, two read paths — the scan path (withTurns false) caches per-file records keyed by path, mtime and size; the reader path (withTurns true) builds full turns and is never cached](assets/transcript-read-paths.svg)

The reader path being cache-free is load-bearing for maintainers: **turn-shape
changes (like the `kind` field, §3) need no `SCHEMA_VERSION` bump**, because
no turn is ever served from cache — whereas *session-record* fields (like
`exceptions`) do, since stale cached records would otherwise sum `undefined`
into totals (`usage-index.mjs:59-65`; the incidents behind that rule are
recorded in `USAGE-SCORECARD-METRICS.md` Appendix A). Schema v11 is that same
rule applied again: it added `mode`/`modeRaw`, `latHist`/`latCount`,
`lenSeconds`, `ctxWindow`/`ctxLastTokens` and `aborts` to the record, so every
session had to be re-derived rather than read back as `undefined`
(`usage-index.mjs:92-98`). v12 is the rule applied to a *wrong* value rather
than a missing one: v11 records persisted `modeRaw: "never/[object Object]"`
and a null `mode` for every Codex session, because `sandbox_policy` is an
object and was compared against string literals. Re-deriving is what clears
them (`usage-index.mjs:99-104`). v14 is the plain form of the rule once more —
`promptFPs`/`promptFPOverflow` (§3.3) are new *record* fields, so a v13 cache
would read them as `undefined` for exactly the sessions already on disk
(`usage-index.mjs:120-126`).

---

## 3. The turn model — and why `role: "user"` does not mean "the human"

`readSession` returns `{ meta, turns }`. Each turn carries:

| Field | On | Meaning |
|---|---|---|
| `role` | all | `"user"` or `"assistant"` — the **Messages-API role**, not the author (see below) |
| `at` | all | ISO timestamp |
| `text` | all | Flattened display text (`claudeText`, `telemetry-records.mjs:38-55` — binary payloads dropped: a pasted screenshot renders as `[image]`, a tool result is prefixed `[tool result]`) |
| `model` | assistant | The model id; the literal string `exception` for an API-error placeholder turn (`usage-parsers.mjs:565`) |
| `tools` | assistant | Tool names invoked in the turn |
| `prompt` | user | `isHumanPrompt`'s verdict (`usage-parsers.mjs:458-467`) — drives the **prompt counts** |
| `kind` | user | `'prompt'` \| `'tool-result'` \| `'context'` — drives the **attribution label** (`userTurnKind`, `usage-parsers.mjs:485-490`) |
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

`userTurnKind` (`usage-parsers.mjs:485-490`) classifies every user-role turn:

| `kind` | Test | Meaning |
|---|---|---|
| `tool-result` | content carries a `tool_result` block | Output the **harness** fed back to the model after a tool call |
| `context` | `isMeta`, **or** the text opens with a harness-output envelope (`HARNESS_OUTPUT_RE`: `task-notification`, `bash-stdout`/`-stderr`, `local-command-stdout`/`-stderr`, `local-command-caveat`, and since v15 the attribute-bearing `in-app-browser-context`) | Harness-injected content — neither the person **nor the model**. These envelopes carry neither `isMeta` nor a `tool_result`, so text shape is the only signal (the envelope census is in §6.2) |
| `prompt` | everything else | The person — including `bash-input` (a `! command` the person typed) and slash-command records (the person invoked them) |

Two deliberate subtleties:

* **`kind` is broader than `prompt` on the image-only edge.** An image-only
  paste has no text block, so `isHumanPrompt` returns `false` (it is not
  *counted* as a text prompt) — but it **is** the person acting, and
  `userTurnKind` returns `'prompt'` for it. "Not countable as a text prompt"
  and "not the human" are different claims.
* **Harness-output envelopes are excluded from the prompt *count* too.**
  `isHumanPrompt` shares `HARNESS_OUTPUT_RE`, so a session's `prompts` figure
  never counts stdout dumps or task notifications as things the person said
  (`SCHEMA_VERSION` 5, `usage-index.mjs:66-69`; the correction this shipped
  with is in [Appendix A](#appendix-a--fix-history)).
* **`tool-result` outranks `context`**: a `tool_result` block on an `isMeta`
  entry is still tool feedback.

Codex user turns are kind: 'prompt' when they pass the human-prompt gate,
`'context'` when a harness or mirrored envelope gates them out
(`handleCodexUserMessage`, `usage-parsers.mjs:823-844`, §1.2) — rollouts only
route real prompts AND harness/mirror text through `user_message` events,
never tool output, so `'tool-result'` never occurs on this host.

Coverage: `tests/kit/usage-index.test.mjs` — "user-role turns carry a kind"
(both providers, the fixture's real `tool_result` entry) and "isMeta context
and image-only pastes get the right kind" (the two edges).

### 3.3 Prompt fingerprints — `kind` on the scan path too (SCHEMA_VERSION 14, extended in 16)

`kind` used to be computed only when `withTurns`, because only a turn row
carried it. Since v14 it is derived on **both** paths (`recordClaudeUserTurn`,
`usage-parsers.mjs:519-520`): every turn it classifies as `'prompt'` also
contributes one entry to the session record's `promptFPs`.

An entry is `{ h, t, th, p }` — a hash of the normalized text, the token count,
a bounded sorted sample of its token hashes, and a **provenance** tag saying who
wrote it (`human` \| `control` \| `agent` \| `adapter`,
`usage-provenance.mjs:20`). Since v16 two optional **shape** flags may ride
alongside: `q` when the turn is question-shaped and `o` when it opens with a
persona/role assignment (`promptShape`, `usage-parsers.mjs:319`). Both are
decided at fingerprint time because that is the last moment the text exists,
and both are **omitted when false** — an absent key means "not that shape",
never a measurement that came out zero. **No prompt text is stored**; the
formula, the taxonomy, and what the tagging deliberately does not model are in
[`USAGE-SCORECARD-METRICS.md`](USAGE-SCORECARD-METRICS.md) §2a.

The layer sits *behind* the gates above, it does not re-litigate them: a
harness envelope or a mirrored cross-host delivery that `kind` already routes
to `'context'` contributes no fingerprint at all. What provenance adds is the
distinction `kind` cannot make — a `'prompt'` turn is the person *acting*, but
an agent delivery, a headless adapter template and a slash-command record are
all things that reach a user turn without anyone typing them.

This is also why the opencode source now loads user text parts on the scan path
(`loadTextParts`, `usage-opencode.mjs:276`): it previously read message bodies
only for the reader path, so a fingerprint there would have hashed an empty
string.

---

## 4. The `readSession` pipeline — how one session becomes a payload

`readSession(id, opts)` (`usage-index.mjs:963-990`) is the only way
transcript content leaves the module, and every step is a gate:

### 4.1 Locate, contain, bound

1. **Id grammar before any filesystem access** — an id must match one of
   exactly two shapes, or it is rejected with `ERR_INVALID_SESSION_ID` at
   this call: `invalidId(id)` (`usage-index.mjs:964`) before any read happens:
   * `VALID_ID` (`/^[A-Za-z0-9._-]{1,128}$/`, `usage-index.mjs:152`) — a plain
     session id;
   * `VALID_SUBAGENT_ID` (`usage-index.mjs:168`) — a namespaced nested
     subagent id, EXACTLY `<parentId>/<stem>` with one slash, where the parent
     half reuses `VALID_ID`'s own charset and the child half must match the
     real on-disk `agent-…` shape. The namespaced grammar is a **narrowing**
     of the plain one, never a loosening: both are the same path-traversal
     guard, and a traversal shape is rejected at either tier.
2. **Locate by id** across both roots (`locate`, `usage-index.mjs:897-916`),
   consulting the scan cache when present but never requiring it —
   `readSession` works with no prior buildIndex. A namespaced id resolves
   through this call: `locateSubagent(nested.parentId, nested.stem, r.claude, id)`
   (`usage-index.mjs:914`), which builds the
   nested path from the two **already-validated capture groups** rather than
   from raw request text.
3. **Realpath containment** (`usage-index.mjs:988-1001`) — the resolved file
   must live under a transcript root *after* `realpathSync` collapses
   symlinks; a symlink planted inside a root pointing at `/etc/anything`
   passes a lexical `startsWith` but fails this. Roots are realpath'd too so
   a symlinked dotfiles setup still works.
4. **Size cap** — `MAX_SESSION_BYTES` (64 MB, `usage-index.mjs:151`): a
   transcript is read whole and JSON-expands ~5×, so an unbounded read is a
   memory-amplification primitive. Oversized reads as unavailable, not risky.

### 4.2 Parse and price

The file is parsed with `withTurns: true` by the provider's parser
(`usage-index.mjs:932-937`), and `meta` is assembled by `sessionPayload`
(`usage-aggregate.mjs:1249-1276`) with the same fields the Sessions view rows
carry — `prompts`, `responses`, `exceptions`, `sidechain`, `threadSource`,
`models`, `tools`, `skill`/`plugin`, worktree — plus a `cost` priced from the
same per-model usage rows `aggregate()` uses.

Model lifecycle intelligence reuses only the aggregate session's execution host, independently
evidenced inference provider, and bounded model ids. It does not copy session ids, titles, prompts,
turns, tools, paths, or transcript text into the model snapshot. Observed use proves only that
the exact path was observed, entitled, policy-allowed, and routable at capture time; it does not
make the host catalogue complete, prove another path, or claim quality equivalence. When catalogue
discovery for that exact path is unknown, a mechanical plan may proceed only with an explicit
catalogue-unknown warning.
Public catalogue enrichment flows in the opposite direction only into the lifecycle read model: it
never renames a retained session model, changes historical token pricing, or rewrites a transcript.

### 4.3 Mask, then truncate — both marked, differently

Every turn body is passed through `maskSecrets` (`usage-aggregate.mjs:142-147` — the
23 secret shapes) **server-side, before
serialization**, then length-capped at `MAX_TURN_CHARS` (40,000,
`usage-aggregate.mjs:72`) with the marker appended at the truncation call
("originalChars is measured", `usage-aggregate.mjs:1300-1309`). Two invariants:

* **Presence is the signal.** `truncated`/`originalChars` are emitted only
  when the slice fired, so a complete turn cannot be misread as abridged.
* **`originalChars` is measured after masking** — it describes loss due to
  truncation alone, never a raw-file length.

The two kinds of withholding keep distinct vocabulary end-to-end: masking
renders as `…redacted` marks (`markRedactions`,
`dashboard/client.mjs`), truncation as a `truncated · N of M` badge
(`truncBadge`, `dashboard/client.mjs`, deriving N from the received
text so a changed constant can't desync the display).

![Figure: a turn body passes through maskSecrets (leaving redaction marks) and then the 40,000-character cap (leaving a truncated · N of M badge); originalChars is measured after masking](assets/transcript-mask-truncate.svg)

---

## 5. The HTTP surface

All routes inherit the dashboard's loopback bind, DNS-rebinding `Host` guard,
and cross-site fetch-metadata guard (`dashboard-server.mjs` request handler
preamble). Transcript-relevant routes:

| Route | Serves | Notes |
|---|---|---|
| `GET /api/usage?days=N` | aggregate minus `sessions[]` | Scorecard + Findings + project tree |
| `GET /api/sessions` | session rows, filtered and paginated | Sessions view's "load all" |
| `GET /api/session/:id` | one masked transcript | Transcript view |

`/api/session/:id` order of operations, each step deliberate:

1. `parseSessionId` + `resolvesInsideRoot`
   (`dashboard/session-security.mjs`) — **validation before the index is touched**;
   a rejected id 400s without any filesystem call.
2. `readSession` — a well-formed id matching no file is **404, not
   200-with-null** (200 made every nonexistent session look empty and the
   route a mild existence oracle).
3. **The masking gate covers the whole payload**: `maskMeta` and `maskTurns`
   (`dashboard/session-security.mjs`), both fail-closed — no masker, no
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

`renderSessions` (`dashboard/client.mjs`) renders the project tree
(collapsed by default; every project starts closed so the cross-project
comparison stays above the fold). Each session is a `sessionRow`
(`sessionRow` in `dashboard/client.mjs`): host chip (claude/codex), title,
worktree glyph, category chip (dimmed when confidence < 0.6 or
Unclassified), start, duration, `prompts/responses`, tokens, cost — and an
expander (`sdetail` in `dashboard/client.mjs`) carrying the
per-session detail fields: classification `basis` + confidence, per-session
`models`, the token split, top tools, and the
`skill`/`plugin`/`sidechain`/`worktree` flags. A measured-but-absent value renders as `—`, never disappears — a
field that vanishes when null teaches the reader it doesn't exist.

### 6.2 Transcript view — attribution, redaction, truncation

`renderTranscript` (`dashboard/client.mjs`) renders the crumb (title,
project, duration, `prompts/responses`, tokens, cost — all from masked
`meta`) and the turn list. **The label comes from `kind`, never from role**
(`dashboard/client.mjs`):

| Turn | Label | Styling |
|---|---|---|
| user, `kind: 'prompt'` | `you` | accent — reserved for the person |
| user, `kind: 'tool-result'` | `tool result` | purple; hover says the harness, not the person, sent it |
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
`fmtHarness` (`dashboard/client.mjs`; CSS in `dashboard/styles.mjs`) reformats
them client-side: the command
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
(`syncHash` in `dashboard/client.mjs`); the view lazy-fetches via
`loadTranscript` in the same module.

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
| Aborted turns | none recorded — and the surfaces render `—`, not `0`, for a window with no Codex session, since nothing in it could have recorded one | `turn_aborted` → `aborts` |
| Delegation markers | `isSidechain` → `sidechain` flag; the delegated work is its own nested transcript, discovered and priced like any other | `thread_source: "subagent"` → excluded from aggregation, session kept visible |
| Permission posture | `permissionMode`, on the person's own turn | `approval_policy` + `sandbox_policy.type` (an object field), per `turn_context` |
| Response latency | derived from the prompt-to-completion gap | same gap where available, else the host's own `duration_ms` — both capped at 3600 s, since `duration_ms` includes time blocked on an approval prompt |
| Context window | last-turn tokens only, no denominator | both halves — `model_context_window` and last-turn tokens |
| Session title | model-written `ai-title`, first-prompt fallback | first prompt clipped |

**OpenRouter boundary:** the supported activity API has account-level date/model/provider/token/
request/spend rows, but no transcript or local-session correlation key. `ak usage refresh openrouter`
caches that account view explicitly; the dashboard renders it under separate provider analytics and
never treats it as a third transcript host. OpenRouter-served inference can still be attributed on a
real OpenCode transcript when OpenCode itself records provider/model/cost evidence. See ADR-0009 §9
and [#59](https://github.com/pacphi/agentic-kit/issues/59).

---

## Appendix A — Fix history

The main body describes only current behavior; this appendix records what
was wrong before, for the curious.

* **User-role turns rendered as "you" (fixed 2026-07-26).** Before `kind`
  existed, the Transcript view labelled every user-role turn as the person.
  On the reference session that misattributed 276 tool results and 6 harness
  context injections — ~93% of its "you" turns (§3.1's measured split). The
  turn-`kind` machinery in §3 is the fix.
* **Prompt counts included harness output (SCHEMA_VERSION 5).**
  `isHumanPrompt` once counted `harness-output` envelopes as human prompts —
  32 claimed vs 20 real on the reference session. Cached session records
  carried the inflated counts, hence the wholesale `SCHEMA_VERSION` 5 cache
  invalidation ("no longer count as human prompts", `usage-index.mjs:66-69`).
* **Session expander fields shipped but unrendered.** The per-session fields
  §6.1's expander now renders (classification `basis` + confidence, the
  token split, flags) once travelled on the wire and rendered nowhere.
* **Transcript header once showed a hardcoded `$0.00`.** `readSession`'s
  assembled `meta` left cost undefined, and `fmtUsd(undefined)` renders the
  truthy string `"$0.00"` — a fixed-looking zero on a panel whose whole
  subject is cost. `meta.cost` is now priced via this call: `sessionCost(rec, deps)`
  (`usage-aggregate.mjs:1300`) — over the same per-model usage rows aggregate() reads.
* **Aggregate-side incidents** (the v4/v5 cache bumps, the Codex parsing
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

* A real Claude session (this feature's own working session, 884 turns):
  `{ prompt: 20, context: 6, 'tool-result': 276, assistant: 588 }`, zero
  user turns missing `kind`.
* A real Codex rollout (8 user turns): every one `kind: 'prompt'`, as §1.2
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
| Permission posture, response latency, context window (§1.1–§1.3, §7) | [ADR-0038](adr/0038-consistent-cross-host-session-metrics.md) |
| Nested subagent discovery and namespaced ids (§1, §4.1) | ADR-0038 |
| Dashboard HTTP guards — loopback bind, `Host` guard, fetch metadata (§5) | ADR-0005, ADR-0007 |
