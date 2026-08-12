# ADR-0030 — Hermes Agent as the first out-of-tree host adapter

- **Status:** Proposed
- **Date:** 2026-08-11
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0028](0028-local-openai-compatible-providers.md),
  [ADR-0029](0029-host-adapter-extension-point.md),
  [ADR-0017](0017-opencode-host.md), [ADR-0018](0018-generalized-host-worker-execution.md)
- **Product proposal:**
  [Host adapters as a published extension point](../HOST-ADAPTER-EXTENSION-PROPOSAL.md)

## Context

[ADR-0029](0029-host-adapter-extension-point.md) requires one real external adapter as conformance
evidence: a contract that has never been satisfied by code its authors did not write is a guess.

**Hermes Agent** ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) is the
candidate, and it is a deliberately awkward one — which is the point. Every assumption ak's three
built-in hosts share, hermes breaks at least one of:

| Assumption from claude / codex / opencode | Hermes |
|---|---|
| Config is JSON or TOML | **YAML**, relocatable via `HERMES_HOME` and profiles |
| Installed from npm | pip / uv / vendor installer — **no npm package** |
| A structured JSON or JSONL run mode | plain text on stdout |
| A permission event a runner can intercept | none — headless mode auto-approves by contract |
| A ruflo `ENABLE_*` backend flag exists | none; ruflo's backend list is fixed |

If the ADR-0029 contract can carry hermes without amendment, it can carry most things. Where it
cannot, this ADR records the amendment as evidence rather than hiding it.

Hermes also motivates [ADR-0028](0028-local-openai-compatible-providers.md): its provider layer
treats `ollama`, `vllm`, `llamacpp`, and `lmstudio` as aliases onto a generic OpenAI-compatible
`custom` provider (`hermes_cli/runtime_provider.py`), and arbitrary loopback endpoints are
declarable inline. It is the host a local-model operator is most likely to already be running.

## Decision

### 1. Hermes ships as an external adapter, maintained by its proposer

The adapter is a separate package registered through ADR-0029's `kit.json hostAdapters` array. It
is **not** vendored into this repository, and agentic-kit does not take on hermes's correctness,
its release cadence, or its vendor's changes. The host-specific decisions — how its config is
wired, how its CLI is invoked, what its guidance says — live in that package's own documentation.

What this ADR records is only what agentic-kit must know: the conformance result, and the in-tree
changes hermes proved were necessary.

### 2. Declared capabilities

`canDriveSession: true`, `canRouteActivities: true`, `canBePrimary: false`, `commandStatusline:
false`, `aqeProvider: null` — inside ADR-0029 §4's cap without needing an exemption. AQE has no
hermes provider type, and inventing one would manufacture provider identity that
[ADR-0021](0021-inference-provider-provenance.md) forbids.

### 3. The adapter drives hermes's own CLI and never writes its YAML

The lifecycle adapter locates the config with `hermes config path` (letting hermes resolve
`HERMES_HOME` and profiles rather than reimplementing that chain), wires MCP with
`hermes mcp add` / `hermes mcp remove`, and never touches `providers.*`, `model`, or
`default_provider` — those are the user's inference choices, which ADR-0021 has ak read, not author.

This is ak's standing "write the host's own config, never a parallel config layer" rule in its
strongest form, and it is why **no YAML dependency enters this repository or the adapter**.

Two findings from the source are recorded because they are non-obvious and would otherwise be
rediscovered as bugs:

- **Idempotence requires remove-then-add.** `hermes mcp add` prompts to overwrite an existing name
  with `default=False`; `hermes mcp remove` prompts with `default=True`; and `_confirm` returns its
  default on `EOFError` — which is what a non-TTY `ak sync` supplies. A bare re-`add` therefore
  prints "Cancelled." and **exits zero**, a silent no-op that would read as convergence.
- **Convergence must be read from the file, not the CLI.** `hermes mcp list` renders a human table
  with no `--json`. The adapter reads the file `hermes config path` names, under a restricted
  reader that **refuses rather than guesses** on YAML constructs outside its subset. It never
  writes, so a refusal costs status fidelity and never user data.

### 4. Execution: `hermes -z`, whose stdout is a framed final-assistant channel

ADR-0018 §7 admits a dependency handoff only from a host's structured final assistant surface,
never from raw stdout. Hermes has no JSON stream, but its oneshot mode satisfies that requirement in
substance: `run_oneshot` disables logging, redirects both stdout and stderr to `devnull` for the
entire agent call tree, and writes the final response to the real stdout in a single write after the
run completes (`hermes_cli/oneshot.py`). Tool output, banners, and progress never reach the channel.

The weaker guarantee is stated rather than hidden: with no framing, a truncated run is not
distinguishable from a short answer by inspection. Failed handoff extraction stays a bounded
`protocol_error`, and hermes's exit codes carry what ak relies on — `0` success, `1` agent failure
or no final response, `2` bad arguments or a failed/partial run with no text.

`--usage-file` writes a JSON report (estimated cost, tokens, model, api_calls) **even when the run
fails**, giving per-worker usage with no transcript scraping. Per ADR-0021 this is the host's own
accounting: `configured`-grade evidence of what hermes believes it spent. `worker.maxTurns` is not
forwarded — hermes's `max_turns` is config-level with no oneshot flag, so the bound rides on the
runner timeout, as it already does for Codex.

**This is the one place the ADR-0029 contract needed widening.** `createSubprocessExecutionAdapter`
supports only `createJsonlSummaryCapture`; a plain-text capture is required. It is a small addition
to a shared helper, and it is recorded here because it is exactly the kind of gap a first external
consumer exists to find.

### 5. The approval posture is disclosed, because ak cannot constrain it

`hermes -z` sets `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1` before running, auto-approving
every shell and tool approval — with the stated rationale that a non-interactive prompt would hang
forever (`hermes_cli/oneshot.py`).

This differs materially from OpenCode, where ADR-0018 §5 routes a permission request into a
deterministic `permission_required` result and refuses to answer on the user's behalf. **Hermes
oneshot has no permission event to intercept.** ak does not weaken hermes's posture — auto-approval
is hermes's own headless contract — but a hermes worker must not be presented as carrying a
guarantee it does not have.

The adapter therefore declares auto-approval as an explicit `host-integration` trust change, printed
in the pre-mutation manifest, and ADR-0018's trust-boundary contract is restated at enable time
rather than assumed to carry over. This is also the first test of whether ADR-0029 §3's disclosure
surface is expressive enough for an adapter to describe a risk ak did not anticipate.

### 6. Guidance reuses the existing project `agents` target

Hermes reads `AGENTS.md` from the working directory — already
`{ name: 'agents', file: path.join(cwd, 'AGENTS.md') }` in `guidanceTargets`. No fourth target is
created. The adapter contributes an enablement-gated block row through the existing `customBlocks`
shape, so a template asserting live wiring never lands on an installed-but-disabled host.

### 7. Detected, never installed or updated

`install.bin: 'hermes'`, `externalInstallPolicy: 'detect-never-overwrite'`, and **no
`npmPackage`** — hermes is the first host to have none, which is what forces ADR-0029 §8's
`npmRoot(undefined)` guard. `ak setup` and `ak sync` never install or upgrade it.

PATH detection alone is insufficient in practice: on the reference machine hermes lives in
`~/hermes-venv/bin/hermes` and a repo `.venv`, and is absent from PATH. The adapter accepts an
explicit binary path in its own configuration; an enabled host that cannot be resolved is reported
as not-installed, never silently skipped.

### 8. Out of scope

AQE provider routing, statusline, primary eligibility, auto-seeding, and `drivingHost` session
detection — all excluded by ADR-0029 §4 or by absence of an upstream surface.

Also excluded: **a reverse MCP bridge.** `hermes mcp serve` exists, but publishes a messaging
bridge — `conversations_list`, `messages_read`, `messages_send`, `permissions_respond`
(`mcp_serve.py`) — not a task-delegation tool. There is no `mcp__hermes__hermes` analogue to Codex's
`codex mcp-server`. Registering it would grant Claude the ability to read and send messages on the
user's platforms under the guise of host integration: a far larger grant than the delegation it
superficially resembles. Delegation to hermes is a subprocess invocation, which is what `ak run`
performs anyway.

## Consequences

- ADR-0029's contract is validated against a host that breaks five of ak's implicit assumptions,
  and needed exactly one widening (§4's plain-text capture) plus one guard (§7's absent
  `npmPackage`) — both small, both useful independently.
- Local-model operators get a managed host that natively speaks to loopback OpenAI-compatible
  endpoints, combined with ADR-0028's provider vocabulary.
- agentic-kit carries no hermes-specific code, no YAML dependency, and no obligation to NousResearch's
  release cadence.
- A hermes worker's approval posture is weaker than an OpenCode worker's, permanently and by
  hermes's design. §5 makes that legible at enable time and in the terminal result's `host` field.
- `ak sync` writes only on divergence; a *changed* MCP entry is briefly absent mid-sync because of
  §3's remove-then-add. Acceptable for a file read at hermes start-up, and recorded so it is not
  rediscovered as a bug.

## Required evidence

Proposed; no implementation is authorized or claimed. Promotion requires, in the adapter package:

- Oneshot fixtures end-to-end: success, agent failure (exit 1), no-final-response (exit 1), bad
  arguments (exit 2), `--usage-file` written on the failure path, handoff extraction, and
  handoff-absent `protocol_error`.
- A recorded non-TTY reproduction of the `add`-overwrite cancellation, proving remove-then-add
  converges where a bare re-add does not.
- Restricted-reader fixtures: a normal config, and refusal — not misparse — on anchors, aliases,
  multi-document streams, and tags.
- Marker-precise teardown: user-authored `mcp_servers` entries survive `ak host off`; a collision is
  preserved and reported.
- Enabled-but-absent, explicit-path, and PATH-resolved detection.

And in this repository: the §4 plain-text capture, the §7 `npmPackage` guard, and hermes passing
ADR-0029's admission and cap checks unmodified.

## References

- Hermes surfaces: `hermes_cli/oneshot.py` (`run_oneshot` — yolo/accept-hooks env, devnull
  redirect, single final write, exit codes, `_write_usage_file`), `hermes_cli/mcp_config.py`
  (`cmd_mcp_add` / `cmd_mcp_remove` / `cmd_mcp_list`, `_confirm` EOF defaults),
  `hermes_cli/config.py` (`config_command`: `show|edit|set|path|env-path|migrate`),
  `hermes_cli/runtime_provider.py` (local-server aliases onto `custom`), `mcp_serve.py`,
  `pyproject.toml` (`[project.scripts] hermes`).
- ak surfaces this exercises: `src/lib/execution/subprocess.mjs` (plain-text capture),
  `src/lib/footprint/install.mjs` (`npmPackage` guard), `src/lib/blocks.mjs` (`customBlocks`),
  `src/lib/adapters/*` (admission, caps, ownership).
- ADR-0028 (local provider vocabulary), ADR-0029 (the contract this proves),
  ADR-0018 (execution, handoff, trust boundary), ADR-0021 (provenance).
