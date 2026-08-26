# ADR-0034 — Schema-native worker handoffs and hermetic qe-court seats

- **Status:** Implemented
- **Date:** 2026-08-26
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0033](0033-retire-codex-mcp-and-bound-qe-court-participants.md),
  [issue #108](https://github.com/pacphi/agentic-kit/issues/108)

## Context

ADR-0033's reciprocal live regression passed its baseline but failed a
five-trial soak: a Codex-hosted seat in a Claude-led DAG exited cleanly in 39s
yet produced `protocol_error` — "worker emitted a malformed or duplicate
handoff block". The v1 handoff rode the FINAL FREE-TEXT message and required
the tagged block to end it, tolerating only one whitelisted receipt grammar.
A supervised seat, however, is a full agent session loaded with standing
instructions ak does not control: machine guidance files, plugin hooks and
receipts (Claude plugins and Codex plugins both mandate trailing output), and
whatever the model appends stochastically. Hard-failing on final-text SHAPE
made those collisions a per-seat coin flip; the raw offending text was also
redacted, so failures arrived without evidence.

Probes (2026-08-26) grounded the remedies:

- `codex exec --output-schema` held 5/5 with MCP servers active at codex
  0.149.1 (openai/codex#15451 did not reproduce); `-o` writes exactly the
  final message.
- `claude -p --json-schema` returns the validated object as
  `structured_output` on the stream-json `result` event; `--strict-mcp-config`
  mounts exactly one server; `--settings '{"disableAllHooks":true}'` silences
  plugin hooks. `--bare` is NOT usable: it disables subscription OAuth.
- Codex 0.149.x offers no per-invocation MCP-roster control: `-c mcp_servers`
  overrides do not change the effective roster, and plugins mount servers and
  instruction files regardless. Cleanroom `--ignore-user-config` also drops
  the project's `trust_level`, which blocks MCP tool approvals in exec mode.
- agentic-qe 3.13.12 ships a subscription Codex CLI provider
  (`dist/shared/llm/providers/codex.js`, built for qe-court cross-vendor
  seats), but a provider is reachable only via `defaultProvider`, the
  `fallbackChain`, or a `FALLBACK_PRIORITY` list that contains neither
  `codex` nor `claude-code` — so ak's projected codex `agentOverrides` sat
  dead behind "not enabled" warnings.

## Decision

1. **Schema-native handoff transport.** A worker whose summary a dependent
   needs (`worker.requiresHandoff`, set by the runner) carries the handoff as
   the host-enforced final object: `--json-schema` on claude,
   `--output-schema` on codex, one shipped schema
   (`src/lib/execution/handoff.schema.json`, kept inside OpenAI's
   structured-output keyword subset). Adapters supply the matching prompt
   instruction through a new optional `handoffRequestFor` hook; the tagged
   request stays the host-neutral default for hosts without a schema surface.
   `parseHandoffText` accepts bare objects (with benign wrapping) and routes
   tagged text through the strict extractor; `normalizeHandoff` remains the
   only authority on accepted shape.
2. **Tolerant-but-strict extractor.** `extractHandoff` tolerates text before
   and after ONE well-formed block; duplicate delimiters stay fatal (the
   shadowing/injection-suspicious case), and raw output is never a fallback.
   The RuvNet-Brain receipt whitelist is deleted as subsumed.
3. **Hermetic seats (opt-in `worker.hermetic`).** Claude seats disable all
   hooks, mount exactly the ruflo MCP server under `--strict-mcp-config`, and
   self-carry `--allowedTools mcp__ruflo` so seat permissions never depend on
   machine settings; never `--bare`. Codex seats take the bounded trims that
   exist: `--ephemeral`, medium reasoning effort, `project_doc_max_bytes=0`;
   their roster-independence comes from the schema transport, not isolation.
   The qe-court live regression runs every seat hermetic and persists a
   redacted raw final-message tail whenever a protocol failure recurs.
4. **Make the projected codex provider real.** The agentOverrides projection
   also enables exactly the providers it references in `llm-config.json`
   (merge-not-clobber, nothing beyond `enabled`), and the chain gate admits
   `codex` rungs (`AQE_CHAIN_PROVIDER_TYPES`) so the subscription Codex
   provider is reachable. `AQE_PROVIDER_TYPES` stays narrow — it also gates
   `AQE_LLM_PROVIDER`, whose accepted values are aqe's own list.

## Consequences

- Final-text shape is no longer load-bearing on claude/codex handoff workers;
  instruction collisions (receipts, trailing prose) cannot malform a handoff.
  Cross-host escalation stays sound: both instructions request the same four
  fields and `parseHandoffText` accepts both forms on every host.
- Seats are reproducible across machines: a hermetic claude seat carries its
  own MCP mount and permission; codex seats still inherit the machine's MCP
  roster and global AGENTS.md (both ak-managed here) — accepted and
  documented, not hidden.
- aqe's qe-court cross-vendor engine (codex, subscription-billed) actually
  participates; its startup no longer warns about dead overrides.
- Upstream asks recorded: aqe FALLBACK_PRIORITY omits host-CLI providers;
  aqe's court referee/oracle assets remain unshipped (the ADR-0033
  three-level evidence ladder is unchanged — transport proof still never
  claims a court verdict); codex `-c mcp_servers` silently no-ops.

## Verification

- Unit: extractor tolerance/duplicates, parseHandoffText forms, schema-flag
  argv per host, hermetic argv per host, structured_output preference,
  provider-enable + codex-rung projection (`tests/kit/execution-handoff`,
  `subprocess-execution`, `routing-projection`).
- Live: `pnpm test:qe-court-live` baseline plus `AK_QE_COURT_TRIALS=5` soak
  must pass with every participant terminal, MCP-native memory proofs
  matched, no timeout/orphan/malformed handoff, and no repository mutation.

## References

- [Claude Code headless mode](https://code.claude.com/docs/en/headless) —
  `--json-schema`/`structured_output`, `--bare` OAuth caveat
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
  — `--output-schema`, `-o`
- [openai/codex#15451](https://github.com/openai/codex/issues/15451) — not
  reproduced at 0.149.1 (5/5)
