# ADR-0033 — Retire Codex MCP and bound QE-Court participant transport

- **Status:** Implemented; handoff transport amended by
  [ADR-0034](0034-schema-native-handoffs-and-hermetic-seats.md)
- **Date:** 2026-08-25
- **Updated:** 2026-08-31
- **Update note:** Initial implementation retires only receipt-owned legacy MCP state,
  diagnoses effective Codex MCP topology, extends POSIX cleanup to process groups, and adds
  fail-closed QE-Court readiness plus a reciprocal live participant-transport regression.
  2026-08-26: the soak exposed the free-text handoff as the weak link; ADR-0034 moves
  handoff-bearing seats to schema-native output and hermetic isolation.
  2026-08-31: `ak sync` now discloses and confirmation-gates repair of user-owned recursive
  Codex and legacy duplicate Ruflo entries, using Codex's supported removal command and
  verifying the resulting topology. Sync also carries failed mutation results into its final
  convergence proof so stale on-disk presence cannot be reported as success. RuvNet Brain
  release drift is now actionable only when GitHub publishes the exact bundle asset consumed
  by the installer; tag-only releases remain visible but are deferred without touching the
  healthy installed Brain.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0001](0001-one-routing-policy-many-projections.md),
  [ADR-0006](0006-primary-host-and-ambidextrous-mirroring.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0020](0020-ga-stable-surfaces.md),
  [issue #108](https://github.com/pacphi/agentic-kit/issues/108)

## Context

Agentic-kit previously registered `codex mcp-server` as a project-scoped Claude Code MCP
server and described it together with Codex's Ruflo MCP registration as a bidirectional bridge.
That model was inaccurate: one leg exposed Codex as a nested host while the other exposed Ruflo
tools to Codex. It also put another long-lived transport inside a multi-participant workflow.

OpenAI deprecated `codex mcp-server` on 2026-08-24. OpenAI recommends App Server for custom
integrations and its Claude Code plugin for interactive Claude→Codex work. The plugin is a
user-scoped external integration and does not provide the inverse Codex→Claude path. Agentic-kit's
existing `ak run` supervisor already provides host-neutral routing, one absolute deadline per
attempt, bounded cancellation, and normalized terminal evidence.

The QE-Court investigation exposed a separate proof gap. The current Agentic-QE consumer skill
can pass local role/vendor checks while its generated package references schema, referee, and
oracle assets that are absent from the consumer. Agentic-QE does not currently expose a supported
host-neutral court runner, and `routing.primaryHost` mirrors activity routes rather than court
seats. A successful Claude/Codex transport check therefore cannot be called a court verdict.

## Decision

1. `ak run` remains the sole agentic-kit-managed cross-host executor. Claude-primary and
   Codex-primary policies select leadership without changing the transport contract.
2. Setup, sync, and host selection stop creating `codex mcp-server`. They remove a legacy project
   registration only when `integrations.ownership.codex.mcp === "ak"`, confirm its absence, and
   clear the receipt only after confirmation. User-owned recursive and legacy duplicate entries
   are disclosed by `ak sync`, removed only after explicit confirmation (or `--yes`), and verified;
   unrelated user-owned entries remain preserved.
3. Codex keeps one independent, workspace-aware Ruflo MCP registration. Agentic-QE continues to
   own its Codex platform/MCP integration. Agentic-kit detects recursive Codex self-registration,
   missing concrete Agentic-QE registration, and duplicate Ruflo transports without rewriting
   unowned Codex TOML.
4. OpenAI's Claude Code plugin is optional and user-owned. Agentic-kit may document and detect it,
   but does not silently install, enable, update, or remove it. A future managed App Server/plugin
   adapter requires a separate lifecycle, ownership, cancellation, and teardown decision.
5. POSIX host workers run as process-group leaders. Timeout, cancellation, and cleanup signal the
   whole group (TERM then bounded KILL), matching Windows whole-tree cleanup and preventing a host's
   MCP descendants from surviving the direct worker.
6. Status distinguishes three levels of QE-Court evidence:

   - local anti-collusion routing validation;
   - self-contained consumer artifacts and concrete provider-seat readiness;
   - a completed upstream court verdict.

   A lower level never claims a higher one.
7. The opt-in reciprocal live harness is named a **QE-Court participant-transport regression**.
   It runs bounded Claude-led and Codex-led direct-host DAGs, requires MCP-native Ruflo memory
   store→retrieve proofs in validated handoffs, independently confirms the project-memory values,
   rejects repository mutation and orphaned state, and never substitutes for Agentic-QE's court
   protocol.
8. Sync distinguishes advertised RuvNet Brain tags from installable releases. Its release probe
   requires the installer's exact `ruvnet-brain.zip` asset before prescribing a KB refresh. A
   missing asset is reported as an upstream deferral with no automatic action; an installer that
   was already launched still fails closed and preserves its causal error in convergence output.

## Consequences

- Existing agentic-kit-owned legacy MCP state converges safely on the next setup, sync, or host
  selection. Foreign state remains visible and untouched.
- Claude→Codex interactive delegation is no longer implied by enabling both hosts. Users who want
  it can install OpenAI's plugin explicitly; production automation should use `ak run`.
- Codex startup no longer needs to load a recursive `codex → codex mcp-server` topology.
- A transport regression can prove bounded participant lifecycle in both leadership directions,
  but full QE-Court parity remains blocked on an upstream Agentic-QE execution surface and complete
  Codex projection.
- A malformed upstream Brain release no longer creates an endless `ak sync` retry loop or rewrites
  a usable local Brain; the update becomes actionable automatically after a later release check sees
  the required bundle asset.
- ADR-0001's MCP projection is historical. ADR-0006's leadership decision, ADR-0016's ownership
  boundary, ADR-0018's worker lifecycle, and ADR-0020's stable execution surface remain in force.

## Verification

- Unit tests cover receipt-owned retirement, preservation of user-owned state, concrete Codex MCP
  topology, fail-closed court artifact readiness, POSIX descendant cleanup, and orphan reporting.
- `pnpm test:qe-court-live` runs one Claude-led and one Codex-led participant-transport trial.
  `AK_QE_COURT_TRIALS=5` raises this to a reciprocal soak test on POSIX shells.
- `ak status` fails recursive self-MCP and reports missing Agentic-QE or duplicate Ruflo MCP state.

## References

- [OpenAI Codex changelog](https://developers.openai.com/codex/changelog)
- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex Claude Code plugin](https://github.com/openai/codex-plugin-cc)
