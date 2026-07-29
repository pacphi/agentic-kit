# ADR-0018 — Generalized host-worker execution; `ak run` canonical

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** agentic-kit maintainers

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
   readiness → prepare → launch → observe → interpret → cancel → cleanup
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
