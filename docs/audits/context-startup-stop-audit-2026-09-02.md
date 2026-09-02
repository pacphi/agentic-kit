# Context startup and Stop-hook audit — 2026-09-02

## Outcome

The startup penalty was real and material, but it was not one monolithic prompt. On the reference
Codex session, 25,985 tokens were already present in a runtime-effective 258,400-token window before
useful work: **10.06%**. Later in the conversation the host showed 83% remaining; that 17% consumed
figure also included the intervening conversation and hook-injected prompt context, so it is not a
second startup-only measurement.

The shipped action is deliberately split by ownership:

- agentic-kit reduced its own always-on managed guidance by 63–66% on the three implemented host
  projections and added deterministic byte budgets;
- Usage now retains bounded, paired runtime context evidence and renders **Usage → Context**;
- the hook audit diagnoses exact Stop configuration risks, supervised adapter runs emit bounded
  receipts, and **Usage → Hooks** keeps configuration and runtime evidence separate;
- project setup preserves foreign guidance and converges only sentinel-owned blocks;
- generated Agentic-QE files, plugin caches, native skill enumeration and host system prompts were
  not patched. Their owners were notified where the evidence was complete.

This receipt is a measured implementation audit, not a claim that every byte in a host's system
prompt is observable or that the upstream AQE runtime defect has been released as fixed.

## Scope and method

The audit traced the startup envelope through these independently owned layers:

1. host/system instructions and the runtime-effective context window;
2. user- and project-scoped `CLAUDE.md` / `AGENTS.md` guidance;
3. model-visible skill descriptions and omitted-skill warnings;
4. MCP tool schemas and registrations;
5. SessionStart, UserPromptSubmit and Stop configuration/injection;
6. conversation and tool-result growth after startup.

Repository-owned templates were assembled with every applicable integration enabled, measured as
UTF-8 bytes before and after the bounded-guidance change, and converted only with the policy's
conservative `ceil(bytes / 3)` estimate. That estimate is intentionally not called a tokenizer
measurement. Hook sources were audited read-only across Claude, Codex, OpenCode and external adapter
providers. Historical runtime evidence came from the local AQE health log; static configuration was
not treated as an execution outcome.

## Reference environment

| Component | Observed version |
| --- | --- |
| Codex CLI | 0.152.1 |
| Claude Code | 2.1.258 |
| OpenCode | 1.18.26 |
| Agentic-QE | 3.14.0 |
| Ruflo | 3.38.20 |

The Codex startup warning stated that visible skill descriptions had been removed and 80 additional
skills were not included. That proves a host-side skill catalogue budget was exceeded. It does not
expose the host's complete system-prompt bytes, the omitted definitions' bytes, or a per-skill token
total.

## Managed-guidance measurement

These are **agentic-kit-selected managed template bytes**, not the whole prompt and not the full
guidance file after user prose is added.

| Target | Before bytes | Before estimate | After bytes | After estimate | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude machine guidance | 29,633 | 9,878 tokens | 10,175 | 3,392 tokens | 19,458 bytes / 65.66% |
| Codex machine guidance | 4,537 | 1,513 tokens | 1,684 | 562 tokens | 2,853 bytes / 62.88% |
| OpenCode guidance | 13,794 | 4,598 tokens | 4,656 | 1,552 tokens | 9,138 bytes / 66.25% |
| Project `AGENTS.md` | 0 | 0 | 0 | 0 | unchanged; no built-in machine truth is projected here |
| Hermes / external v1 | 0 | 0 | 0 | 0 | unsupported descriptor; no guidance invented |

The regression budgets are 12,000 bytes for Claude, 2,200 for Codex, 6,000 for OpenCode, zero
agentic-kit-managed project `AGENTS.md` bytes, and a 2,048-byte conservative fallback for a future
unknown external target. Current checked-in file sizes are different evidence: the repository
`AGENTS.md` was 14,710 bytes and its lean `CLAUDE.md` was 416 bytes at capture time. User prose,
upstream-owned blocks and host instructions remain outside the managed-template figures.

The integrated `ak audit context --host all` command reproduces a privacy-safe current-state report
without reading prompt bodies or executing hosts. After machine guidance was synced, Claude, Codex
and OpenCode targets were all `canonical-managed`; project `AGENTS.md` was not changed. The same live
report measured only serialized MCP registration tables—not each host's whole config—as follows:

| Host | MCP registration config bytes | Tool schema bytes |
| --- | ---: | --- |
| Claude | 251 | unknown / not recorded |
| Codex | 1,734 | unknown / not recorded |
| OpenCode | 1,409 | unknown / not recorded |

Registration-table bytes are not the schemas a host may inject after connecting. The audit keeps
that missing schema evidence explicit instead of treating config size as total MCP context cost.

## Context evidence shipped

Usage cache schema v17 introduced bounded first/last/peak/count input evidence, bounded window
evidence and a fixed pressure histogram. Codex pairs `last_token_usage.input_tokens` with
`model_context_window` from the same token-count observation; cached input is a subset of gross
input and is not added twice. Claude and OpenCode can currently provide input evidence but usually
not a runtime window, so their state is partial rather than a fabricated percentage.

Current cache schema v18 reparses the same Context evidence while adding controlled Prompt
intent/topic facets.

**Usage → Context** renders the canonical policy, counted coverage, three host cards and at most 20
attention rows. An unknown meter has no `aria-valuenow`; missing evidence is not announced as zero.
The view receives the privacy-preserving sibling projection already carried by `/api/usage` and
does not receive prompt text, tool payloads, commands or raw paths.

## Hook and Stop evidence

The read-only host-neutral audit observed 36 sources, 84 hook occurrences and 80 unique normalized
behaviors. It found no invalid source and no generic configuration issue. Its proposed-action
distribution was:

| Authority class | Occurrences |
| --- | ---: |
| Safe automatic | 0 |
| Approval required | 17 |
| Never automatic | 7 |
| Upstream required | 24 |

The 24 upstream actions are occurrence-level AQE lifecycle findings, not 24 independent defects.
They resolve to Agentic-QE's generated-runner hot-path fallback and Claude timeout-unit mismatch.
The exact Claude Stop-family observations were:

| Hook | Declared timeout | Static diagnostics |
| --- | ---: | --- |
| AQE `session-end` | 5,000 | trust-independent, AQE npx hot-path fallback, AQE/Claude timeout-unit mismatch |
| AQE `post-route` | 5,000 | same three codes |
| RuvNet Brain checkpoint | 60,000 | generic probable timeout-unit mismatch; no owner inference |
| AutoMemory sync | 10,000 | generic probable timeout-unit mismatch; no owner inference |

Claude Code 2.1.258 interprets those native hook timeout fields as seconds. The AQE generated shim
tries two local bundle candidates and then falls back to
`npx -y --prefer-offline agentic-qe hooks`; the audited project did not have a local Agentic-QE
package candidate, so the Stop hot path could reach npx.

Historical `.agentic-qe/hooks-health.log` entries recorded `ETIMEDOUT` for `post-route` and
`session-end` at lines 13, 24, 26 and 42. That is genuine historical runtime evidence and supports
attribution. It is not evidence that the current upstream generator is fixed, nor does an absent
new entry prove a successful Stop run.

Supervised external-adapter hook executions now return typed outcomes (`success`, nonzero exit,
signal exit, spawn failure, timeout, integrity rejection), monotonic duration capped at 24 hours,
timeout state, stdout/stderr byte counts saturated at 262,145 bytes, and truncation state. Native
Claude, Codex and OpenCode processes do not yet feed that receipt stream.

**Usage → Hooks** calls authenticated, no-store `/api/hooks?host=all` only when opened. Collection is
single-flight and cached in memory for 30 seconds. The summary removes commands, physical paths,
output and provider diagnostic prose while retaining definition groups, plain-language findings,
ownership evidence and opaque source references. Explicit source inspection rereads and digest-
checks one audited source, returning its location and masked selected JSON definition; no client
path or editor launch exists. The default collector exposes the static audit only; runtime outcomes
say unknown until the process is explicitly supplied bounded receipts. A Stop configuration finding
therefore never renders as a Stop execution failure or success. Provider classifications do not
become dashboard actions without an exact executable plan/action join.

## Setup precedence and idempotency

`ak setup --project` now captures existing project guidance before upstream initialization and
reconciles agentic-kit-owned guidance before and after AQE. The acceptance matrix covers:

- no prior file: create only the bounded guidance the enabled integrations require;
- user-authored `CLAUDE.md`: preserve foreign prose and reconcile complete owned sentinels;
- user-authored `AGENTS.md` only: preserve it and create the one-line `@AGENTS.md` Claude reference;
- prior managed content: replace in place, collapse duplicate complete blocks, and make a second run
  byte-idempotent;
- the exact historical unsentineled lean stub: migrate it once; preserve an edited near-match;
- disablement: remove only complete agentic-kit sentinel spans.

Agentic-QE's `BEGIN AGENTIC-QE CODEX` marker remains upstream-owned. An incomplete sentinel is not
deletion authority. Ruflo receives its supported `--no-global`, `--no-codex-detect`, and
`--no-skills-sh` suppression flags; that avoids known redundant projections without claiming
control over future upstream output.

## Ownership and upstream actions

| Surface | Owner / action |
| --- | --- |
| Agentic-kit managed blocks, parser/projection, context policy, hook audit, external runner and sanitized read models | Patch and regression-test in agentic-kit. |
| Host system prompt, Codex skill catalogue budget and native omission telemetry | Host-owned. Agentic-kit measures what it can and keeps unknown explicit. |
| Ruflo, AQE and Brain generated project assets | Producing upstream owns the generator. Detect and report exact shapes; do not rewrite installed copies. |
| Versioned Codex plugin caches | Codex/plugin owner. Never automatic. |
| Hermes/external adapter v1 context declaration | Unsupported by the current hash-bound contract; do not trust worker output as authority. |

Four evidence-bound notifications are published:

- [Agentic-QE #654](https://github.com/proffesor-for-testing/agentic-qe/issues/654) tracks the 3.14.0
  Stop generator's npx fallback and timeout-unit mismatch. The historical ETIMEDOUT is detected and
  attributed; generated caches were not locally patched. No released upstream fix has been proven.
- [Codex #19679 comment](https://github.com/openai/codex/issues/19679#issuecomment-5511921501)
  records the 0.152.1 skill-context budget evidence, effective 258,400-token window and bounded owned
  workaround. Agentic-kit did not patch native skill enumeration or plugin caches.
- [Ruflo #3153 comment](https://github.com/ruvnet/ruflo/issues/3153#issuecomment-5512219386)
  records the upstream coordination needed for compact, suppressible generated guidance; local
  setup uses only supported flags and does not patch Ruflo's installed generator.
- [Agentic-QE #655](https://github.com/proffesor-for-testing/agentic-qe/issues/655) requests a compact
  upstream-owned guidance projection. Agentic-QE's sentinel remains foreign to agentic-kit's block
  writer while that issue is open.

No Ruflo/Brain issue was opened from the generic timeout-shape diagnostic alone. A notification
requires a current reproducible failure, exact producing source/version and bounded removal proof.

## Limitations and follow-up

- The full host system prompt and per-MCP-server schema bytes are not exposed, so this audit cannot
  partition all 25,985 startup tokens by contributor.
- Template token figures use the conservative three-bytes-per-token policy, not the active model's
  tokenizer. Exact runtime pressure remains the stronger evidence.
- The Codex warning proves omission but not the complete native skill catalogue, effective
  enablement filter, or bytes removed.
- Native Claude/Codex/OpenCode Stop executions have no durable receipt source yet. Dashboard runtime
  state is consequently unknown by default.
- External/Hermes adapter contract v1 has no trusted context-capability descriptor or durable native
  outcome feed. Extending it changes the consent hash and requires a versioned contract decision.
- Exact per-route prompt materialization and pre-launch enforcement remain future integration work;
  the current policy and historical view do not block a host launch.

## Implementation evidence

| Commit | Evidence |
| --- | --- |
| `818efd1` / `a6d188f` | bounded session evidence and Context projection |
| `fd158f7` | shared canonical context policy |
| `c78e943` / `a526ce3` / `af203be` | bounded receipts, AQE diagnostics, sanitized Hook read model |
| `6b746e8` | managed-guidance reduction and byte-budget gates |
| `b0874e8` | accessible Context/Hooks dashboard delivery |
| `7f8e5e0` | published upstream constraints and notification receipts |
| `00e7317` / `f1a8d47` | privacy-safe context audit and registration-only MCP byte accounting |
| `3382308` | target-aware, idempotent `ak x reference` reconciliation |
