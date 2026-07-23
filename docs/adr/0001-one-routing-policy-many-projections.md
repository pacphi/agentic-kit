# ADR-0001 — One dual-host routing policy, many projections

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** agentic-kit maintainers

## Context

agentic-qe 3.13.1 shipped issue #568 — on-disk per-agent LLM routing (`agentOverrides` in
`.agentic-qe/llm-config.json`). Separately, ruflo already ships a Claude+Codex "dual-mode" substrate:
`@claude-flow/codex`'s `DualModeOrchestrator` and `claude-flow-codex dual run` (templates +
`--worker`/`--config`), a `codex mcp-server` MCP backend, and a 3-tier + `auto-escalation-tracker` model
router. These are real and shipped — but they are **three separate configuration surfaces**, each with its
own vocabulary, reached through raw CLI or hand-authored agent definitions.

If `ak` exposed each surface independently, a user wanting "architecture on Claude, implementation on Codex"
would have to keep an `agentOverrides` map, a dual-run worker config, and MCP registration in sync by hand —
drift-prone and hostile to a good UX.

## Decision

`ak` owns **one** routing policy — `kit.json → providers.dualRouting`, a map of *activity → host + model
(+ escalation)* — as the single source of truth. Everything downstream is a **projection**: a pure function
`policy → artifact`. The three projections are:

1. aqe `agentOverrides` (`.agentic-qe/llm-config.json`)
2. dual-run collaboration config JSON (`claude-flow-codex dual run --config`)
3. codex MCP backend registration (`mcp__codex__codex` availability)

`ak` invents no new routing capability; it configures and materializes what rUv already ships.

## Consequences

- **One edit point.** Users (and `ak x provider pick`) change the policy; projections regenerate.
- **Projectors are pure and unit-testable** in isolation (no I/O) — the core of implementation Slice 0.
- **Consistent state** across the QE fleet, dual-run swarms, and inline MCP calls.
- Materialized files reuse the existing `_managedBy: agentic-kit` + `.bak` discipline, so teardown
  (`ak x provider off`) and drift detection already have a home.
- New downstream consumers are added as new projectors, not new user-facing config.
- Cost: one more `kit.json` key and a projector layer to maintain; justified by eliminating three
  hand-synced surfaces.

## References

- agentic-qe 3.13.1 release / issue #568; `dist/shared/llm/router/{config-store,agent-router-config,types}.d.ts`
- `@claude-flow/codex` `dual-mode/orchestrator.js`, `dual-mode/cli.js`
- memory: `ruflo-codex-dual-mode-mechanics`, `multi-llm-ux-issue-36`
