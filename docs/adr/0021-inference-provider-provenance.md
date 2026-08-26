# ADR-0021 — Inference-provider provenance for observed sessions

- **Status:** Accepted
- **Date:** 2026-07-31
- **Updated:** 2026-08-25
- **Update note:** Claude provider resolution now covers runtime leases as well as transcript
  discovery, while stronger observed identity remains authoritative; OpenCode runtime presence is
  acknowledged without manufacturing provider identity. The user-facing surface is now named
  Observability; Live remains one navigation scope within it. ADR-0032 reuses only independently
  evidenced host/provider/model facts and never infers provider identity from a host or model name.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0012](0012-observability.md)

## Context

ADR-0012 keeps the execution-host and inference-provider axes independent and forbids promoting
a host-based assumption to an observed provider claim. In practice every Claude Code session in
the Observability view rendered "Provider not established", and — unnoticed — every Codex session
did too.
Investigation against current upstream sources found two distinct causes:

1. **Codex records the provider; ak read the wrong field.** Codex rollout `session_meta`
   payloads and the `threads` table of `state_N.sqlite` both spell the field `model_provider`
   (verified live against `~/.codex` and openai/codex session examples). The adapters and the
   state reader looked for a bare `provider` column/key that does not exist, so real observed
   evidence — including custom `model_providers` entries such as `openrouter`, `azure`, or
   `ollama` from `~/.codex/config.toml` — was silently dropped by the schema-tolerant column
   filter.
2. **Claude Code genuinely never writes the provider.** No record type in
   `~/.claude/projects/*/*.jsonl` carries one. Which endpoint serves a session is decided by the
   host's documented configuration surface instead: `CLAUDE_CODE_USE_BEDROCK`,
   `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, and `ANTHROPIC_BASE_URL` (gateway/proxy),
   where settings-file `env` blocks override the shell with managed > project local > project
   shared > user precedence and an empty string means "unset at this layer"
   (code.claude.com/docs/en/env-vars and the Bedrock/Vertex/Foundry deployment guides).

The event schema already reserved the vocabulary for this: `providerProvenance ∈ observed |
configured | inferred | unknown`, populated from field-level evidence. Only emitters were missing.

## Decision

- **Codex: read `model_provider`** in the rollout adapter and the state-ledger reader, keeping
  the bare `provider` spelling only as legacy tolerance. The claim remains **observed** — it is
  in the artifact. Custom provider ids pass through untranslated.
- **Claude: resolve the provider from the host's configuration surface** whenever session evidence
  supplies a canonical working directory, including transcript discovery and runtime leases
  (`src/lib/live/claude-provider.mjs`), mirroring the documented selection order:
  Bedrock flag → Vertex flag → Foundry flag → `ANTHROPIC_BASE_URL` (classified to `anthropic`,
  `openrouter`, or generic `gateway` by hostname) → first-party default `anthropic`. Explicit
  selections are **configured**; the first-party default is **inferred**; an unknown gateway stays
  a `gateway`, never a guessed vendor. Resolution is memoized per session `cwd` and injectable
  for tests.
- **Provenance is carried, never upgraded.** Adapters put the resolution's own provenance into
  `source.fields.provider`; the schema lifts it into `providerProvenance`. Nothing configured or
  inferred may be displayed as observed, per ADR-0012.
- **Identity evidence is retained.** Projection (server and browser reducers alike) keeps an
  established provider/model claim when a later event for the same node carries none — absence of
  evidence on one event does not erase evidence already observed. Metadata learned while
  bootstrapping a transcript (codex `session_meta` identity in particular) persists into live
  tailing for the same reason.
- **Presentation** names the new values (AWS Bedrock, Google Vertex AI, Microsoft Foundry,
  Custom gateway) and continues to render "Provider not established" only when no evidence of any
  grade exists.
- **Model lifecycle reuse** consumes the independently evidenced host, provider, and model fields
  without upgrading provenance or inferring provider identity from a host/model string. A structured
  successful observation proves only that exact path at capture time.

## Consequences

- Codex sessions now show their serving provider with observed provenance, including
  OpenRouter/Azure/Ollama-served sessions configured through `model_providers`.
- Claude Code sessions show who serves Claude models — Anthropic, Bedrock, Vertex, Foundry,
  OpenRouter, or an unnamed gateway — labeled configured or inferred, answering the operator
  question without overclaiming.
- OpenCode runtime leases can establish host presence, but provider identity remains unavailable
  until OpenCode supplies direct evidence; its usage-side records already carry an observed
  `providerID` on that separate historical analytics path.
- If codex renames or Claude Code starts recording the serving endpoint, the adapters prefer the
  in-artifact (observed) value automatically.
