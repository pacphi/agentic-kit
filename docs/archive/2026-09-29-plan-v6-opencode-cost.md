# V6 Unit 15: OpenCode reported-zero cost trust

## Status

The scoped parser/cost work and core cache invalidation handoff are implemented and independently accepted. The final OpenCode marker also includes observation semantics.
Full V6 verification passed at `1c02db91`; feature PR CI and develop integration
remain separate gates at this archival capture. No live store mutation is claimed.

## Decision and scope

OpenCode may record zero when a model has no configured rate. A positive-token
assistant response with recorded cost zero is therefore unpriced when its
provider is nonlocal or unknown. A known local provider's zero remains observed.
Positive recorded costs, zero-token responses, and missing-cost estimates keep
their existing treatment. Provider attribution remains per response.

This unit changes only the OpenCode parser and the shared cost reader at its
OpenCode-specific row boundary. No rate is inferred from the model name, host,
or environment.

## Evidence and acceptance

- A bounded, read-only live-store query checks counts and shape, with a file
  digest before and after. No affected positive-token zero-cost row was found.
- Synthetic SQLite messages with the real storage shape test remote, unknown,
  and local provider IDs; mixed observed and missing cost; malformed costs;
  and cold/warm cache conservation.
- Focused tests, typecheck, scoped lint, and diff checks gate the unit commit.

## Integration dependency

Existing schema-26 cached OpenCode records cannot reconstruct which responses
had an untrusted reported zero after per-response data was coalesced. The core
owner must invalidate or reparse those old records before release. This unit
does not edit the core-owned cache/index module.
