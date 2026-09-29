# AQE integration repair — September 9, 2026

Source baseline: `fcc9d64` (agentic-kit 4.0.0-alpha.46). Changes remain uncommitted.
Reviewed all ten closed pacphi-authored AQE issues created June 9–September 9:
563, 568, 576, 617, 628, 631, 632, 654, 655, 656, and their linked PRs.

## Implemented

- Court readiness resolves the installed public referee export/executable. It
  no longer requires upstream source and test files inside consumer projects or
  a Codex court skill absent from AQE's curated manifest. Existing enabled legacy
  projections are checked for stale references. Static presence never claims a verdict.
- `aqeCodexGuidance` persists `compact` by default, with `full` and `none`
  alternatives. Setup passes the supported flag only on AQE 3.14.1+ with Codex.
- Exact-content hook migrations recognize reviewed old and packaged checkpoint
  helpers, preserve checkpoints on export failure, use installed AQE directly,
  and correct native timeout units while retaining unrelated hook group members.
  Replacements preserve file ownership/mode and use existing transactional backup,
  preimage checks, verification, idempotency, and conditional undo.
- Claude 2.1.266 received a separate native-artifact-bound timeout profile.
- `ak x verify mcp` probes commands from effective Codex configuration with a
  bounded initialize/tools-list exchange. It discloses the diagnostic environment;
  it does not impersonate the host. It is explicit, outside the default all suite.
- AQE status now describes the actual filesystem observation rather than declaring
  storage/runtime healthy. Deep verification separates live lock contention,
  embedding configuration, stored provenance, an actual semantic endpoint probe,
  and non-launching Vibium payload readiness.
- Provider conformance covers enabled external providers without fallback through
  CLI and MCP advisors. Generation retains its explicit-fallback transport test.
- Constraint metadata records the released #654/#655 fixes while keeping generated
  artifact state independent of the package version.

## Applied on this machine

- Installed Ollama `all-minilm:22m` and an explicit
  `Xenova/all-MiniLM-L6-v2` request-name alias, because AQE fixes that model name
  and 384 dimensions. Configured `http://127.0.0.1:11434` in project Claude MCP,
  project Codex MCP/shell environment, and global Codex AQE environment.
- The endpoint is a new embedding space, not ONNX vector equivalence. No existing
  vectors were relabelled or backfilled. Installed AQE client fingerprint:
  `6bc48638bda047d7`; 384 finite dimensions; related similarity 0.6231 versus
  unrelated -0.0572. The probe sends synthetic text only.
- Replaced this project's `npx agentic-qe@latest mcp` invocation with `aqe-mcp`.
  Removed the recognized recursive user-level `codex mcp-server` registration
  using the existing backup-preserving repair. The extra `claude-flow` registration
  carries custom environment and remains outside the exact legacy repair matcher.
- Applied upstream compact guidance through the installed unbundled CLI, retaining
  foreign AGENTS content. The public bundled platform command failed before setup.
- Migrated existing court references and supplied the missing legacy Codex schema;
  both routing configuration files were preserved.
- Applied three hook transactions under actual Claude 2.1.266. Receipt:
  `tx-2026-09-09T12-55-02.110Z-182e21dfb0501971`, stored under the user's
  agentic-kit hook-repair-transactions directory. Re-audit cleared targeted
  findings and produced an idempotent no-op. Runtime configuration and court
  backups reside in the user's agentic-kit backups directory.

## Validation and limits

- Full `pnpm test`: 3,725 Node tests passed, six skipped; subsequent CJS suites
  passed. Node coverage: 91.85% lines, 80.43% branches, 91.32% functions.
- Typecheck, build, and ESLint passed with zero errors. ESLint retains 60 warnings.
- Eight installed court/provider tests passed; all six deterministic court oracles
  passed. This does not establish a full multi-provider court verdict.
- Exact Claude 2.1.266 native timeout conformance passed.
- Ruflo CLI write/retrieve/independent database lookup/purge passed in isolation.
  Earlier current-session command records were independently found in native AgentDB.
- Direct configured discovery after repair: AQE 181 ms/88 tools, Brain 29 ms/four
  tools. Earlier warm npx invocation took 1,012 ms; these are smoke timings, not
  a controlled performance benchmark.
- A fresh ephemeral Codex subprocess completed with `AK_AQE_STARTUP_OK` and no
  MCP timeout warning. It did report the existing skill-context-budget warning.
- Isolated AQE fleet initialization/status passed with the local endpoint.
  The existing project has a live AQE process holding the RVF lock; concurrent
  status degrades to SQLite. No lock or existing process was forcibly removed.
  Stored embedding provenance reports 135 unverified vectors, left unchanged.
- AQE `quality_assess` was invoked after fleet initialization and returned a
  blocking score of 20 with coverage 19.41%. Its analyzer reads stored coverage;
  this receipt is not bound to the fresh Node coverage result. It is retained as
  a failed quality gate, not overridden or represented as a release approval.

## Upstream follow-up drafts — not submitted

### Packaged checkpoint and regeneration disagree

AQE 3.14.1 npm tarball SHA-256:
`1066460058a312594e6d187a484b303162727a979b526f148ddb4050f05d121f`.
Its `.claude/helpers/brain-checkpoint.cjs` still deletes RVF and idmap before export,
while `dist/init/phases/07-hooks.js` generates the preserving implementation.
The installer preserves an existing helper or copies the packaged helper from a
project-local install. Re-running init therefore does not reliably retire this bug.
Follow-up to [PR #640](https://github.com/proffesor-for-testing/agentic-qe/pull/640)
and [PR #661](https://github.com/proffesor-for-testing/agentic-qe/pull/661): unify
published/generated bytes and add fresh, project-local, and upgrade corpus tests
with failed export proving the previous mirror survives.

### Bundled platform setup cannot resolve installer

`aqe platform setup codex --codex-guidance compact` on installed 3.14.1 prints
`Module not found in bundle: ../../init/codex-installer.js`, yet exits zero.
Running the same platform command through installed `dist/cli/index.js` succeeds.
Add a packed-binary platform setup test, correct module bundling, and return a
nonzero exit on unsuccessful platform configuration. Inspect actual component
receipts rather than accepting exit zero alone.

### Generation identity differs from advisor reachability

Enabled external provider and matching defaultProvider, without fallback membership,
passed CLI advise and MCP advisor_consult sentinel/provider checks. Generation did
not return that provider's sentinel until the explicit fallback chain was retained.
Follow up on [PR #641](https://github.com/proffesor-for-testing/agentic-qe/pull/641)
with a minimal generation-route identity reproduction before assigning root cause.

## Other findings and remaining work

- Restart old host sessions to pick up new MCP environments and release their
  existing AQE store locks. A current process cannot be retroactively reconfigured.
- Ruflo's separate signed Codex Stop-output issue remains tracked independently.
- Codex skill-context-budget limits remain; compact AQE prose is not a fix for
  the entire installed skill catalog.
- The existing function named RVF `quarantine` deletes oversized stores and
  sidecars. It was not invoked against an oversized store during this repair.
  Review this separate behavior for preservation and live-owner safety.
- Actual publisher/provider identity remains required for court verdicts; host
  diversity alone is insufficient. Existing cross-host Guidance coverage is already
  implemented and was verified rather than rewritten.
- Reconcile AQE's stored quality evidence with current source-bound measurements
  before treating its quality gate as a release decision. No release was attempted.
