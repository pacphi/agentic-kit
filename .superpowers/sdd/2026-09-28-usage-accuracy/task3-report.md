# V6 Unit 3: Codex thread sources and Auto-review pricing

Source state: `bf8babd4` plus this unit's changes. Checked 2026-09-29 10:57 UTC with `codex-cli 0.158.0`.

## Findings and change

- **Verified kit defect:** an unfamiliar `thread_source` on a known interactive originator inherited `person`. The classifier now reports `unknown`, while recognized user, handoff, agent, and automation values retain their declared initiators. The fixed SDK, exec, and MCP rules still apply.
- **Verified kit defect:** SQLite ledger backfill changed `threadSource` without rebuilding `sessionOrigin`. It now classifies from bounded raw declaration evidence and preserves the first rollout declaration over a later replayed parent declaration.
- **Verified kit gap:** the observed `source.subagent.thread_spawn.parent_thread_id` was not retained. The first metadata line now accepts only a UUID-shaped parent ID. Aggregate rollup uses a parent present in the same Codex record set, rejects missing links and cycles, and groups child and reviewer records under that parent's surface. It keeps child-owned usage and strips only a ledger-identified subagent whose rollout could not separate replay.
- **Verified kit defect:** `codex-auto-review` token rows were assigned unknown-model fallback dollars. This exact server-side alias now contributes tokens and unpriced-message coverage, with zero estimated dollars and no invented cache saving. Published known-model pricing is unchanged.

## Bounded local metadata probe

Read only the first JSONL line of 1,806 local Codex rollout files, plus `turn_context.model` for guardian-review files. This is a file census, not a unique-session census or a billing statement. The `thread_source` counts were: `subagent` 510, `user` 200, absent/null 994, `guardian_review` 90, `chatgpt_handoff` 10, `agent_created_thread` 2. None had a structured `thread_source`; 600 had structured `source.subagent` (500 `thread_spawn`, 90 `other` with guardian review, 10 `other` with subagent). The 500 observed `thread_spawn` parent IDs were UUID-shaped. Guardian-review files contained 843 `turn_context` declarations of `codex-auto-review`. The probe did not read prompt text, deduplicate sessions, inspect imports, or verify a published price.

## Verification

- RED: new focused tests failed on unfamiliar source classification, parent extraction, ledger origin, and Auto-review fallback pricing. A separate cycle fixture failed before the cycle guard.
- GREEN: `node scripts/run-tests.mjs exec -- --test tests/kit/usage-codex-attribution.test.mjs tests/kit/usage-session-surface.test.mjs tests/kit/session-surface.test.mjs tests/kit/usage-index-v6.test.mjs tests/kit/usage-codex-thread-source.test.mjs tests/kit/pricing.test.mjs` — 101 passed, 0 failed.
- `node node_modules/typescript/bin/tsc --noEmit` — passed. `node node_modules/eslint/bin/eslint.js` on the six changed source/test files — passed. `git diff --check` — passed.
- The synthetic aggregate fixture checks parent, child, and reviewer totals and cold/warm cache consistency without touching the real usage cache.

## Accounting limits

The 26 schema remains unchanged. Existing schema-26 caches created before this unit may lack parsed parent IDs until a fresh cache rebuild; the final pre-PR gate owns that rebuild. A reviewer without a verified parent remains on its declared surface because no parent can be inferred. No provider calls, full unit/UI suite, real cache migration, or user database writes were made.
