# ADR-0018 — Generalized host-worker execution; `ak run` canonical

- **Status:** Accepted; compatibility retention superseded by
  [ADR-0020](0020-ga-stable-surfaces.md)
- **Date:** 2026-07-29
- **Updated:** 2026-07-30
- **Update note:** Added private bounded dependency handoffs and one absolute lifecycle deadline
  per attempt; removed the temporary command, adapter, and persisted-schema compatibility clauses.
- **Deciders:** agentic-kit maintainers

> **GA amendment:** the host-neutral lifecycle, `ak run`, and OpenCode safety decisions remain.
> The temporary command, adapter, and persisted-schema compatibility clauses were removed for GA.

## Context

`ak` manages Claude, Codex, and OpenCode. The earlier `ak dual run` implementation
materialized a Claude/Codex-specific configuration and delegated execution to
`claude-flow-codex`; it could not safely execute an OpenCode worker. A host-neutral command and
adapter contract are required before OpenCode can become an activity-routing host.

OpenCode does provide a headless HTTP server intended for programmatic use, with an
OpenAPI endpoint, health/version endpoint, sessions, asynchronous prompts, SSE events,
session abort, and permission responses. It defaults to loopback and can be protected
with HTTP basic authentication. [OpenCode server documentation](https://opencode.ai/docs/server/)

`opencode run` supports non-interactive commands and a `provider/model` selector, but
its documented CLI surface does not establish the supervised session, cancellation, and
permission-response contract required for a routable worker. [OpenCode CLI documentation](https://opencode.ai/docs/cli/)

## Decision

1. Preserve OpenCode's managed-host parity throughout this work. An enabled but absent
   OpenCode CLI is installed as `opencode-ai`; its npm-managed version participates in
   the shared drift/update path; and external installs are detected but never shadowed
   or overwritten. `ak host pick`, setup, sync, status, and teardown remain the
   canonical management surfaces, exactly as for Claude and Codex. Routing capability
   is additive to this lifecycle, not a replacement for it.

2. Introduce an agentic-kit-owned, host-neutral execution contract:

   ```text
   readiness → prepare → launch → observe → interpret → summarize → cancel → cleanup
   ```

   Every terminal result contains host, activity, configured selector, correlation,
   timing, status, exit category, and only independently grounded provider/model/usage
   facts. A host or its `provider/model` selector never proves inference-provider,
   billing, cost, or QE vendor diversity.

3. Make `ak run` the explicit, host-neutral execution command. Preserve `ak dual` only as a
   deprecated Claude/Codex compatibility projection: it warns on stderr, retains its existing
   `claude-flow-codex` escalation behavior for scripts, and must not silently reinterpret
   existing configuration, templates, primary-host mirroring, or escalation behavior.

4. Select OpenCode's short-lived, loopback-only `opencode serve` HTTP/OpenAPI surface
   as the execution transport. Each owned server uses an allocated loopback
   port and an ephemeral `OPENCODE_SERVER_PASSWORD`, neither logged nor persisted. The
   adapter uses Node's built-in `fetch`, keeping the package free of runtime dependencies.
   ACP is not selected: it is an editor-oriented JSON-RPC transport and adds a client
   protocol obligation without improving this worker contract.

5. An OpenCode worker creates an isolated session, observes the event stream, submits an
   asynchronous prompt, and on cancellation or timeout calls the documented abort
   endpoint before terminating its owned server. A permission request becomes the
   deterministic `permission_required` result and is aborted; the runner never passes
   `--auto` or weakens user-owned OpenCode permission configuration.

   The worker instruction is a versioned, invocation-only template in the package. It
   is sent with the worker prompt, never deployed as an OpenCode agent, command, or
   configuration override. This avoids an agent-specific permission override (which
   would take precedence over global user policy) and makes the template side-effect
   free, inspectable, and testable.

6. OpenCode declares `canRouteActivities:true` only with the runnable adapter and its
   conformance evidence. Its routes are accepted by `ak run`, but are never auto-seeded,
   AQE-projected, primary-host eligible, or accepted by deprecated `ak dual`.

7. Dependency continuity uses a **runtime-only handoff protocol**. A worker with
   dependents must end its final response with one tagged JSON object containing exactly
   `outcome`, `artifacts`, `decisions`, and `risks`. Host adapters extract that object only
   from the host's structured final assistant surface—Claude's JSON `result`, Codex's final
   JSONL `agent_message`, or OpenCode's final assistant text parts. Raw stdout, tool output,
   and whole protocol streams are never fallback handoffs.

   Each handoff is sanitized and capped at 2 KiB; fan-in is capped at 8 KiB and preserves
   the dependent's declared `dependsOn` order rather than completion order. The runner
   appends summaries only at runtime inside an explicit untrusted-data/not-instructions
   boundary. Materialized/dry-run prompts remain unchanged, and handoffs never enter
   `WorkerResult` or `ak run --json`. A handoff may cross host and inference-vendor
   boundaries, so its request explicitly forbids secrets, credentials, raw logs, and
   transcript excerpts. A missing, duplicate, or malformed required handoff is a bounded,
   non-escalatable `protocol_error` and prevents both duplicate side effects and silent
   downstream execution. Escalation
   retains only the final successful rung's handoff.

8. `timeoutMs` is **one absolute budget per escalation attempt**, created before readiness
   and shared through:

   ```text
   readiness → prepare → launch → observe
   ```

   Every phase receives the same `AbortSignal` and only the remaining time; no phase
   renews the budget. `readiness` and `prepare` are resource-free. During `launch`, an
   adapter progressively registers each acquired resource on runner-owned prepared state
   before its next await. A deadline before prepared state exists returns `timed_out`
   without fabricated cleanup. A deadline after state exists aborts the operation, calls
   `cancel`, and returns `timed_out` only when termination is confirmed; surviving or
   uncertain resources are `orphaned`.

   Final cleanup remains separately bounded and may extend wall time past the worker
   deadline because termination proof is part of the safety contract. Explicit
   `orphaned:true` cleanup evidence, or a cleanup exception that leaves termination
   unproved, upgrades any apparent success or timeout and is never ignored or downgraded.
   On Windows, termination targets the full wrapper/CLI process tree rather than treating
   an exited npm PowerShell shim as proof that its descendant stopped.

### The trust boundary (stated, not weakened)

`ak run` executes workers with the **user's own CLI trust posture in the target
repository**. That means the repository itself is *inside* the trust boundary:

- An owned OpenCode server reads the project `opencode.json` from the target cwd. A
  repository that ships `{"permission":{"bash":"allow"}}` (or hostile `mcp` entries)
  pre-approves those permissions — **no `permission.updated` event ever fires, so the
  adapter's abort boundary does not trip by design**. The abort covers permission
  *requests*; it is not a sandbox.
- Claude/Codex workers likewise inherit the repo's `.claude/settings.json` hooks and
  permissions under the user's own workspace trust for that path.
- Repository content (`AGENTS.md`, README, source) flows into worker prompts — an
  indirect prompt-injection channel for any agent runner, ak included.

**Contract: run `ak` (and any agent runner) only in repositories you would trust with
your full user privileges.** ak will not silently weaken, bypass, or "secure" a hostile
repo for you; what it guarantees instead is the honest version: loopback-only owned
servers, ephemeral per-run credentials, no `--auto`, no permission approval on your
behalf, and terminal evidence that records what actually ran.

## Consequences

- `ak run` executes the host-neutral plan and result schema while preserving the legacy
  Claude/Codex adapter behind the deprecated `ak dual` command.
- Managed installation is testable independently of execution readiness: a missing CLI
  is installable, but wiring and routing never claim it is runnable until post-install
  detection succeeds.
- OpenCode automation needs a local server supervisor and sanitized event fixtures.
- The `providers.dualRouting` compatibility representation remains readable during the
  migration. AQE projection remains distinct: an OpenCode execution route without
  grounded provider evidence is diagnosed, never projected as an invented provider.
- Automatic seeding remains Claude/Codex subscription-only. No OpenCode route is seeded
  from unknown or metered provider/billing facts.
- Dependency summaries improve cross-worker continuity without exposing raw host output or
  creating a second public result schema. Disk mutations remain shared evidence, not the
  only communication channel.
- One attempt cannot consume `timeoutMs` independently in each lifecycle phase. Cleanup can
  exceed that budget only to establish whether owned resources actually terminated.

## Implementation evidence

- Exact-final-head fixtures establish OpenCode server readiness, isolated sessions, structured
  terminal results, explicit permission denial, malformed-event handling, no-prompt-hang,
  timeout/cancel abort, TERM/KILL cleanup, and launch-timeout classification.
- Claude/Codex materialization remains behaviorally identical for the deprecated `ak dual`
  compatibility wrapper; `ak run` is the supported execution command.
- OpenCode has parity tests for enabled-absent installation, npm-managed update drift,
  externally managed installs, post-install wiring, and marker-precise teardown.
- Routing-disable behavior, provenance, and cost safety are covered. OpenCode remains excluded
  from AQE projection and vendor-diversity claims because a host/model selector is not provider
  evidence.
- Handoff fixtures prove strict tag/schema extraction, control sanitization, UTF-8 bounds,
  fan-in ordering, injection delimiters, no raw-output fallback, final-success-only escalation,
  missing-summary blocking, and public-result privacy.
- Runner fixtures independently stall readiness, prepare, launch, and observe; prove one
  shared attempt budget; verify progressive cancellation/cleanup; and upgrade cleanup survivors
  to an orphaned terminal result.
