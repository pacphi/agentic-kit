# Completion acceptance ledger

## Status

**Blocked** on approval of the [completion program](2026-09-29-completion-program.md).
Snapshot: 2026-09-29, main `0511d575`. Thirteen live open issue bodies were read.
This is a planning crosswalk, not new test evidence or an assertion that every unchecked issue
row is unimplemented. P00 reuses proved work and reproduces remaining gaps before changing code.

## Closure contract

Each row requires: exact source/package/platform, command or observation, result, evidence link,
independent review and applicable merge/release/operation proof. Checkboxes below preserve issue
wording; their original unchecked state is not silently converted into a new completion claim.
Where an issue uses prose, separately labelled narrative requirements are enumerated afterward.
The source issue remains authoritative until a maintainer-approved amendment is recorded there.

All 155 source checkbox criteria map to a package. P00 verifies inherited evidence, P18 checks
artifact gates and P20 performs closure for every row; those common owners are not repeated.
Upstream status or a task ledger cannot stand in for actual execution/persistence evidence.

## Issue #95

[Live issue](https://github.com/pacphi/agentic-kit/issues/95) — 29 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I95-01 | Exact AQE and OpenCode versions are recorded. | P16 |
| I95-02 | Existing upstream work (#268 and #568) is distinguished from this direction. | P16 |
| I95-03 | A decision is recorded: first-class provider versus provider plugin seam. | P16 |
| I95-04 | Host, observed provider, model, cost, and billing semantics are specified independently. | P16 |
| I95-05 | qe-court vendor-diversity behavior is explicitly defined. | P16 |
| I95-06 | An upstream AQE issue or PR is linked. | P16 |
| I95-07 | AQE can route one named agent type through OpenCode. | P16 |
| I95-08 | `providerID/modelID` is selected explicitly. | P16 |
| I95-09 | OpenCode credentials remain in OpenCode's own store. | P16 |
| I95-10 | The server is loopback-only and uses ephemeral authentication. | P16 |
| I95-11 | Timeout/cancellation aborts the session and terminates owned processes. | P16 |
| I95-12 | Permission requests are never auto-approved. | P16 |
| I95-13 | Provider/model/token/cost values come from observed OpenCode output. | P16 |
| I95-14 | OpenCode is not falsely classified as a vendor or fixed billing mode. | P16 |
| I95-15 | Fallback behavior remains bounded and observable. | P16 |
| I95-16 | Projection is enabled only for a verified minimum AQE version. | P16 |
| I95-17 | Older AQE versions retain explicit `ak run` routing and report the limitation. | P16 |
| I95-18 | `ak sync` merges OpenCode AQE entries without clobbering foreign entries. | P16 |
| I95-19 | `ak status` distinguishes configured, runnable, drifted, and upstream-incompatible states. | P16 |
| I95-20 | No API key, OAuth token, or OpenCode auth material is persisted by Agentic Kit. | P16 |
| I95-21 | OpenCode AQE routes remain opt-in and are not automatically seeded. | P16 |
| I95-22 | Linux, macOS, and Windows fixtures cover success, timeout, cancellation, malformed output, and missing CLI/auth. | P16 |
| I95-23 | the accepted ADR/design decision | P16 |
| I95-24 | the upstream AQE issue and merged PR/release | P16 |
| I95-25 | the Agentic Kit implementation PR | P16 |
| I95-26 | exact-head CI for Linux, macOS, and Windows | P16 |
| I95-27 | focused AQE → OpenCode live proof showing configured and observed identities | P16 |
| I95-28 | teardown proof showing no orphaned OpenCode process and no persisted secret | P16 |
| I95-29 | documentation covering supported versions, configuration, limitations, and direct-provider alternatives | P16 |

## Issue #109

[Live issue](https://github.com/pacphi/agentic-kit/issues/109) — 35 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I109-01 | `OperationEpisode`, `OutcomeEvidence`, `EvidenceGrade`, `HarnessFingerprint`, and `RouteRecommendation` are defined in DDD/ADR documentation. | P17 |
| I109-02 | Host, inference provider, provider provenance, model, reasoning effort, and harness remain separate fields. | P17 |
| I109-03 | Every quality and cost claim carries provenance, timestamp/freshness, and evidence grade. | P17 |
| I109-04 | Historical, paired, and prospective evidence are distinguishable in the API and UI. | P17 |
| I109-05 | Assistant self-reported completion cannot independently create a success label. | P17 |
| I109-06 | Insufficient/confounded evidence produces no model recommendation. | P17 |
| I109-07 | Claude, Codex, and OpenCode fixtures yield deterministic episodes. | P17 |
| I109-08 | Structured `ak run` workers yield activity-bounded episodes with attempts and escalation. | P17 |
| I109-09 | Subagent replay/double-count protections remain intact. | P17 |
| I109-10 | Schema-version migration invalidates incompatible cached records. | P17 |
| I109-11 | OpenRouter account analytics remains unjoined without a correlation key. | P17 |
| I109-12 | Recommendations compare compatible activity/task/complexity/harness cohorts. | P17 |
| I109-13 | A cheaper candidate must clear the configured conservative quality bound. | P17 |
| I109-14 | Retry, repair, escalation, latency, and capacity/cost are included in net effect. | P17 |
| I109-15 | Ruflo's real MetaHarness-backed router supplies learned per-candidate quality. | P17 |
| I109-16 | Backend absence or insufficient labels yields no learned recommendation. | P17 |
| I109-17 | Accepted/rejected recommendations can feed qualified outcome learning. | P17 |
| I109-18 | Route Intelligence appears within Usage → Findings, not as a fourth primary area. | P17 |
| I109-19 | Findings show evidence grade, sample counts, uncertainty, freshness, and cost basis. | P17 |
| I109-20 | Findings disclose incumbent/candidate host, provider, model, and harness scope. | P17 |
| I109-21 | Actionable findings provide a copyable explicit route command. | P17 |
| I109-22 | The Dashboard never mutates routing policy. | P17 |
| I109-23 | Aggregate routes never expose raw transcript text or embeddings. | P17 |
| I109-24 | Keyboard, responsive, and accessibility contracts remain intact. | P17 |
| I109-25 | Normal Dashboard operation performs no external fetch. | P17 |
| I109-26 | Learning writes and replay remain explicit opt-ins. | P17 |
| I109-27 | Metered or cross-vendor evaluation requires confirmation. | P17 |
| I109-28 | No secret or credential reaches derived stores or Dashboard payloads. | P17 |
| I109-29 | Retention, rotation, rebuild, and deletion behavior is tested. | P17 |
| I109-30 | Full project checks and Agentic-QE gates pass before implementation closure. | P17 |
| I109-31 | New ADR is accepted before learned recommendations ship. | P17 |
| I109-32 | ADR-0009 is updated when the Findings contract changes. | P17 |
| I109-33 | ADR-0021 remains accurate or is updated in the same change that alters provenance behavior. | P17 |
| I109-34 | Metrics, transcript, Dashboard, provider, and troubleshooting docs are updated. | P17 |
| I109-35 | Closure links the implementation PR, exact-head CI, Agentic-QE evidence, paired-evaluation proof, privacy proof, and release seal. | P17 |

## Issue #115

[Live issue](https://github.com/pacphi/agentic-kit/issues/115) — 18 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I115-01 | GitNexus is represented as an optional managed companion providing a structural code index, distinct from Ruflo/AgentDB and from deja-vu (#114). | P13 |
| I115-02 | Existing configurations migrate additively to disabled/unowned GitNexus intent. | P13 |
| I115-03 | Setup offers an explicit opt-in, defaults file injection to off, and discloses the PolyForm Noncommercial 1.0.0 license before install. | P13 |
| I115-04 | Agentic Kit detects mise npm-backend, npm-global, and pnpm-global installs distinctly, and drives updates only through the backend that owns the artifact. | P13 |
| I115-05 | External/Docker-only installs remain visible but unowned. | P13 |
| I115-06 | Only enabled/present Agentic Kit hosts are wired, never GitNexus's full supported-editor set. | P13 |
| I115-07 | `ak status` and JSON distinguish presence, install method, ownership, version drift, native-binding health, MCP wiring health, and per-project index health. | P13 |
| I115-08 | `ak sync --dry-run` is non-mutating across every install method. | P13 |
| I115-09 | Repeated `ak sync` is idempotent and produces no duplicate MCP entries or repeated re-analysis. | P13 |
| I115-10 | Default index builds never mutate AGENTS.md/CLAUDE.md or write skill files unless the user separately opted into GitNexus's file injection. | P13 |
| I115-11 | Verification observes host config, `doctor`/`status`/`check` facts, and native-binding state independently of apply. | P13 |
| I115-12 | Default uninstall removes Agentic Kit-owned MCP wiring but preserves index data and any user-authored AGENTS.md/CLAUDE.md content. | P13 |
| I115-13 | `--remove-gitnexus` removes only an Agentic Kit-owned package, via its owning backend, after confirmation. | P13 |
| I115-14 | Data purge is separate, confirmed, exact-path guarded, and cannot delete source files. | P13 |
| I115-15 | Partial teardown retains ownership receipts and returns nonzero. | P13 |
| I115-16 | No indexed code content, query strings, or credentials appear in status, logs, receipts, or Dashboard output. | P13 |
| I115-17 | Shared lifecycle conformance, clean-machine, cross-platform (including a mise-managed PATH fixture), migration, drift, and no-clobber tests pass. | P13 |
| I115-18 | `pnpm run check` passes. | P13 |

## Issue #116

[Live issue](https://github.com/pacphi/agentic-kit/issues/116) — 7 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I116-01 | `src/lib/install-method.mjs` exists, is read-only, and covers every classification outcome in the table above with fixture tests, including at least three distinct mise backends (`npm`, one GitHub-release-shaped backend such as `aqua` or `http`, and one plugin-shaped backend such as `asdf`) to prove the design generalizes rather than special-casing exactly two. | P12 |
| I116-02 | Gap 3 (npm-global under a mise-managed Node) is explicitly regression-tested and continues to classify as `npm-global`, never `mise`. | P12 |
| I116-03 | `ak status`/`ak host status` shows the specific mise backend for host CLIs where classifiable, with zero change to which hosts `ak sync` updates (regression-tested). | P12 |
| I116-04 | The module's public API is documented well enough that #115's adapter can depend on it instead of duplicating classification logic. | P12 |
| I116-05 | No backend other than `npm` (mise or otherwise) is ever treated as `updatable`. | P12 |
| I116-06 | Agentic Kit's own source contains no hardcoded list of mise backend names used for classification decisions — backend identity always comes from `mise ls --json`'s own output. | P12 |
| I116-07 | `pnpm run check` passes. | P12 |

## Issue #117

[Live issue](https://github.com/pacphi/agentic-kit/issues/117) — 10 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I117-01 | Graphify is represented as an optional managed companion; its relationship to #115 (GitNexus) is explicitly documented, not left implicit. | P14 |
| I117-02 | Setup offers an explicit opt-in, discloses license + per-run token cost, and ships `alwaysOnBlocks: false` as the default. | P14 |
| I117-03 | Python install-method detection (pip/pipx/uv-tool) exists and correctly delegates the mise-`pipx:` case to #116's classifier rather than duplicating it. | P14 |
| I117-04 | No write ever produces overlapping/corrupted marker sections between Agentic Kit's own `blocks.mjs` sentinels and Graphify's marker-delimited sections in the same file — proven by the block-mediation test matrix above. | P14 |
| I117-05 | Only enabled/present Agentic Kit hosts are wired, never Graphify's full platform list. | P14 |
| I117-06 | `ak status` and JSON distinguish presence, install method, ownership, version drift (PyPI namespace), skill-wiring health, always-on block ownership/conflict state, and per-project graph health. | P14 |
| I117-07 | `ak sync --dry-run` is non-mutating; repeated `ak sync` is idempotent and never triggers unplanned Pass-3 token spend. | P14 |
| I117-08 | Default uninstall removes Agentic Kit-owned wiring and (if ever enabled) owned block contributions, but preserves `graphify-out/` data and pre-existing guidance-file content. | P14 |
| I117-09 | No indexed content, transcript text, or credentials appear in status, logs, receipts, or Dashboard output. | P14 |
| I117-10 | `pnpm run check` passes. | P14 |

## Issue #167

[Live issue](https://github.com/pacphi/agentic-kit/issues/167) — 15 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I167-01 | graft is represented as an optional managed companion, not a host/provider or AgentDB/Ruflo replacement. | P15 |
| I167-02 | `ak setup --with-graft` (machine phase) installs the npm package and touches no repository. | P15 |
| I167-03 | `graft init` runs only under project setup (`ak setup --project`, or wherever project setup already triggers), scoped to Agentic Kit's own enabled host set via `--agents`/`--yes`. | P15 |
| I167-04 | Codex/`agents` wiring defaults to `--no-global`; graft's own `~/.codex/config.toml`/`hooks.json` writes require a separate, explicit opt-in and never disturb Agentic Kit's own `[mcp_servers.ruflo]` entry. | P15 |
| I167-05 | `graft build --deep` never runs without explicit opt-in and a confirmed provider key. | P15 |
| I167-06 | `ak status`/JSON distinguish presence, ownership, install method, version drift, per-host wiring, graph freshness (`graft check --json`), and Codex-global-write ownership. | P15 |
| I167-07 | `ak sync --dry-run` is non-mutating; repeated `ak sync` is idempotent. | P15 |
| I167-08 | `ak sync` is the only caller of `npm install -g @nanonets/graft@latest`; Agentic Kit never invokes `graft upgrade`. | P15 |
| I167-09 | graft's own background update-check nudge is detected and does not produce a second, disagreeing drift story in `ak`-managed sessions. | P15 |
| I167-10 | Wiring drift repair reuses graft's own stamp-replay mechanism rather than a hand-rolled diff. | P15 |
| I167-11 | Default uninstall removes only Agentic Kit-owned wiring/package; `graft/` and its notes survive unless a separately confirmed purge is requested. | P15 |
| I167-12 | The GitNexus/graft overlap (Relationship section) is disclosed to the user at setup time when both would be enabled together, not silently allowed. | P15 |
| I167-13 | Native tree-sitter dependency install is proven clean on Linux, macOS, and Windows (the #45 precedent). | P15 |
| I167-14 | Shared lifecycle conformance, clean-machine, cross-platform, migration, and no-clobber tests pass. | P15 |
| I167-15 | `pnpm run check` passes. | P15 |

## Issue #213

[Live issue](https://github.com/pacphi/agentic-kit/issues/213) — 12 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I213-01 | Link the upstream fixing PR/commit(s) for #3196 and the path-identity behavior in #3143. | P05 |
| I213-02 | Record the first **published npm package** containing those fixes, its release notes, `@claude-flow/cli` dependency versions, and package/source integrity evidence. | P05 |
| I213-03 | Revisit this tracker when agentic-kit maintenance detects a newer Ruflo release; compare the changes to the reproduction rather than assuming any upgrade fixes it. | P05 |
| I213-04 | Verify whether custom filename env/flags, memory root configuration, encrypted compatibility files, and native-disabled mode are covered; record partial fixes separately. | P05 |
| I213-05 | Exact upstream release and fix commits recorded. | P05 |
| I213-06 | Cross-process CLI/MCP reproduction no longer shows divergent default stores under the documented supported configuration. | P05 |
| I213-07 | Explicit paths remain distinct within one process, or unsupported combinations fail explicitly. | P05 |
| I213-08 | Existing disjoint corpora and conflicting keys have a tested preservation/migration outcome, including rollback. | P05 |
| I213-09 | Native-disabled and encrypted paths are tested or explicitly gated as unsupported. | P05 |
| I213-10 | Agentic-kit reports observed route identity and preserves uncertainty on older/partial releases. | P05 |
| I213-11 | Relevant docs, regression tests, CI evidence, and integration PR linked. | P05 |
| I213-12 | Close only after the agentic-kit integration is merged; upstream closure alone is insufficient. | P05 |

## Issue #239

[Live issue](https://github.com/pacphi/agentic-kit/issues/239) — 25 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I239-01 | Validate worker input, handler availability, route capability, and ownership before launching. Registration and accepted submission must never count as completed execution. | P06 |
| I239-02 | Record task/executor identity, start, meaningful progress, terminal outcome, expected result, and persistence evidence separately. Verify actual packaged CLI behavior, not just imported source. | P06/P07 |
| I239-03 | Add an early-warning monitor: bounded start, queue, execution, and operation-appropriate progress deadlines; parent-visible failures/stalls; persistent dashboard alerts and truthful CLI exit codes. A heartbeat alone does not establish useful work. | P08 |
| I239-04 | Distinguish cancellation requested from execution stopped. Bound cancellation, fence late callbacks, and restrict retries to safely repeatable operations with a capped policy. | P07 |
| I239-05 | Detect claimed success without valid results, lost post-exit results, missing handlers, failed dependencies, and worker leaks. Await child outcomes before cleanup. Test the notification reaching the parent/UI, then prove a real executor path. | P07/P08 |
| I239-06 | Preserve live RVF owners, locks, databases, private/custom configuration, foreign executable ownership, credentials, unrelated valid TOML, and externally managed tools. Contention must not trigger destructive recovery. | P03/P09 |
| I239-07 | Prove the intended per-project memory route through CLI and active MCP, exact keys, independent persistent-row checks, and reopened processes. Do not delete one of two valid corpora merely to clear a warning. | P05 |
| I239-08 | Share ownership predicates, explicit host intent, and configuration context across status, nudge, sync plan, execution, and postcondition checks. A helper's success is not a verified repair. | P09 |
| I239-09 | Give sync an explicit component scope/exclusion. No-upgrade currently skips upgrades, but is not a permanent guarantee that every unrelated component will be untouched. | P09 |
| I239-10 | Separate installed, enabled for routing, authenticated, reachable, capability-tested, and actively executing. Missing quota does not mean logged out. Do not silently enable a host because historical activity exists. | P09 |
| I239-11 | Preserve diagnostic causes and distinguish failure, inconclusive check, expected contention, disabled optional capability, preserved external advisory, and stale/unreviewed evidence. A warning count must explain what needs action. | P09 |
| I239-12 | Detect selected services that are installed but stopped. Explain machine/project readiness and foreground-process lifetime. Startup services, backend switches, corpus migration, and new memory stores require explicit intent. | P09 |
| I239-13 | Distinguish host identity from actual provider identity. Configured routes and host diversity alone do not prove independent vendors; review claims need invocation-level provenance. | P10 |
| I239-14 | Inventory executable ownership and required capabilities before installs. Avoid force-overwriting foreign bins, silently pinning user-owned tools, or repeating known-impossible repairs. | P09; P12 optional reuse |
| I239-15 | A configured event source is not an ingested source. Show present/readable files, awaiting-file state, accepted/rejected events, last accepted timestamp, collection limits, and actual producer health separately. | P00/P09; P11 disclosure |
| I239-16 | Cover paths with spaces, non-Git launch folders, source rotation/recreation, malformed/schema-invalid events, denied reads, and capped discovery. Do not report complete acquisition when capped. | P00/P09 |
| I239-17 | Use explicit shared time ranges, timezone, filters, project identity, and accounting basis for dashboard comparisons. Surface partial historical parsing instead of implying a login/model failure. | P00/P09 |
| I239-18 | Diagnose unsupported/new event types and bounded clipping without fabricated records or unbounded reads. Refresh guidance must identify the real degraded source rather than endlessly suggesting refresh. | P00/P09 |
| I239-19 | Keep detailed catalog/footprint data lazy or paginated; disclose freshness and collection coverage. Treat the historical large-payload observation as a workload to remeasure, not a current benchmark. | P00/P09 |
| I239-20 | For every correction, identify the owning upstream project, fixing commit, first published package/dependency version, and remaining limitations. The prior Ruflo cache fix and the later local handler/embedding-path corrections require separate evidence. | P01/P03/P05 |
| I239-21 | Test clean and upgraded installations with custom MCP entries, foreign bins, disabled-but-installed hosts, existing data, and concurrent processes. | P09 |
| I239-22 | Test positive and negative outcomes: accepted-never-started, alive-without-progress, slow-valid work, missing handler, failed child, empty result, persistence failure, deadline expiry, cancellation refusal, late completion, live lock, and real I/O failure. | P07 |
| I239-23 | Upgrade the affected installation, restart affected processes, verify actual host/provider/memory/embedding/task paths and the rendered dashboard, then run sync twice to prove convergence. | P19 |
| I239-24 | Do not replay old local patches over a newer release. Compare upstream incorporation first; retain version/hash-bound recovery and preserve unknown user edits. | P18/P19 |
| I239-25 | Keep external telemetry opt-in and redacted. Local alerts should contain task ID, state, elapsed/deadline, error category, and safe next action; never prompts, transcripts, credentials, private paths, or raw results. | P08/P19 |

## Issue #240

[Live issue](https://github.com/pacphi/agentic-kit/issues/240) — 4 source checkbox criteria.

| ID | Acceptance criterion | Owner |
| --- | --- | --- |
| I240-01 | An agentic-qe release containing the fix (#719 or equivalent) is published | P03 |
| I240-02 | The kit's managed AQE version is at or above that release | P03 |
| I240-03 | With a live AQE MCP server holding `patterns.rvf`, `aqe status` no longer emits `FsyncFailed`, and `ak x verify aqe` reports startup `busy` through the pre-existing live-lock rule | P03 |
| I240-04 | The temporary contention rule and its test are removed; the existing "a live lock does not hide an independent storage error" tests remain and pass | P03 |

## Issues with narrative requirements

The following 16 rows paraphrase prose requirements; I262-N06 is the explicit additional
maintainer-confirmed v2 rule, not a checkbox originally present in issue #262.

| ID | Requirement | Owner |
| --- | --- | --- |
| I271-N01 | A recorded hold eventually rechecks after the bounded approved TTL; malformed times and active fresh holds behave safely. | P04 |
| I271-N02 | An explicit one-shot retry can bypass waiting while retaining safety checks and bounded retries. | P04 |
| I271-N03 | Plugin-present/KB-absent state is reported honestly and does not inherit an eternal stale-version hold. | P04 |
| I271-N04 | The documented fresh-install recovery path is reverified against the current Brain release; private snapshots are preserved. | P04 |
| I262-N01 | Windows Node-leg medians are under five minutes over the recorded ten-run cohort and the complete before/after table is published. | P02 |
| I262-N02 | Every original Windows-relevant case, including EBUSY, remains in the full OS/Node matrix. | P02 |
| I262-N03 | The original AQE merge assertions remain unchanged apart from relocation. | P02 |
| I262-N04 | The guarded unit runner passes real-state and temp-root checks. | P02 |
| I262-N05 | The 30-minute timeout remains unchanged. | P02 |
| I262-N06 | Maintainer-confirmed additional v2 gate: three consecutive PR runs have all Windows legs under 300 seconds; no outcome filtering or manufactured reruns. | P02 |
| I257-N01 | Per-platform metadata discovery proves where records live and which fields identify a project, using enumerated values/counts only. | P11 |
| I257-N02 | An optional source reports discovered sessions and skipped reasons, with bounded reads and schema-drift behavior. | P11 |
| I257-N03 | Until supported discovery is delivered, the UI clearly states Cowork is not covered. | P11 |
| I255-N01 | A reviewed spec defines reliable warning signals, display surfaces and threshold policy. | P08 |
| I255-N02 | An accepted ADR records the monitor contract. | P08 |
| I255-N03 | Implementation is test-first against retained sanitized fixtures plus deterministic fault executors; runtime proof meets the parent-visible warning contract. | P07/P08 |

## Eight plan-level gates

The program's §8 names all eight source documents and archive destinations. Before any move,
P20 records each plan's final source/PR/operation evidence and tests every remaining checkbox
against the governing approved decision, including all 14 v1 unchecked steps and v2's eight
Definition-of-Done clauses. Existing public V7 receipts remain frozen historical evidence.

Two newer plans are untracked in the primary checkout. Their recorded decisions and content
were read and privately hashed; this ledger does not quietly publish or adopt them. P00 owns
explicit adoption/reconciliation. A new master plan does not supersede an earlier plan by merely
linking it. All plan status and archival actions require a traceable closure row.

## Publication and validation

Upstream comments/PRs require exact text/diff approval. Kit feature PRs and issue closures follow
the confirmed execution authority; planning alone authorizes none. Release, real-machine writes,
real-store migration, deletion and metered runs remain separate gates.

The machine-readable planning snapshot is private in this worktree. No prompts, transcripts,
credentials, corpus values or private filesystem paths belong in public closure receipts.

## September 30 decisions and milestone precedence

Milestone corrections, D-22 cancellation, D-23 A, D-24 recovery, D-25 A, D-27 B,
D-28 A, D-29 A and session organization B are confirmed. This authorizes the planning choices,
not execution. Current instructions use current commands directly: no retired-command aliases
or redirects. #240's four source criteria require an explicit approved wording reconciliation;
the historical issue text and this source crosswalk are not silently rewritten.

P18/P19 gate the selected milestone only. M1 retains its own original closeout obligations and
approved dispositions; M2/#239 does not require the independent Cowork implementation or broad
M3 install classifier. ADR-0048 evaluation remains a named deferred track. For plan-level proof,
P00 must map the 14 v1 unchecked steps, eight v2 DoD clauses, execution-plan operation gates,
all six execution-evidence completion conditions and retained 246-row scope matrix. A reference
to a plan is not a verified acceptance row. Original issue snapshots remain frozen.

Each execution row must additionally record source clause, milestone, accountable owner,
dependency kind, exact source/artifact/platform, pass condition, result/evidence state,
independent review, applicable approval and rollback. Pending reproduction, inherited evidence,
verified, upstream-blocked, approval-pending and approved disposition are distinct.

## Session organization and Activity extension

These 26 additional design rows extend the original 171 issue-derived rows; they do not alter
issue wording or prove completeness of the still-pending plan-level expansion. Detail, research,
options and remaining decisions are in the [September 30 design](2026-09-30-session-organization-and-activity-design.md).
Owner P11S means an independent M3 feature track; it is not added to #257's literal closure criteria.

| ID | Observable acceptance condition | Owner |
| --- | --- | --- |
| S01 | One Sessions population supports repository, folder, application-workspace, automation and workspace-unknown views with composable filters. | P11S |
| S02 | Launch surface, later access, host, initiator, execution environment, workspace and Activity remain independent evidence fields. | P11S |
| S03 | Declared launch cwd, later executed locations and discussed targets are distinguishable; current Git state never rewrites historical launch claims. | P11S |
| S04 | Remote paths are environment-scoped; Git grouping follows verified common-directory/worktree proofs, not title/basename/remote-URL joins. | P11S |
| S05 | Native identity and host-specific import/fork/subagent/compression relationships prevent duplicate counts while preserving genuine activity. | P11S |
| S06 | Source scope A approved 2026-09-30: initial benchmark uses current Claude/Codex/OpenCode readers across repository/non-repository work. Cowork/Hermes/cloud-only/future sources enter only after verified observation contracts; all sources have version-bound fixtures and honest limitations. Exact resolved allowlist approval precedes excerpt reads. | P11S |
| S07 | Future host observation capabilities, bounded sources and permission are explicit; execution admission grants no transcript-reading authority. | P11S |
| S08 | User title wins; native, extractive and optional generated titles retain provenance and cannot change identity/accounting. | P11S |
| S09 | Bounded title context excludes injected/imported/replayed material, tool bodies and assistant outcome claims; ambiguous content can abstain. Initial benchmark user excerpts have an approved 8,000-character total ceiling across the initial substantive request and up to two clarifications, with clipping disclosed and no automatic expansion. | P11S |
| S10 | Private titles/excerpts never enter default public/export receipts; rendering, retention, invalidation and user corrections have proof. | P11S |
| S11 | Ordinary viewing makes no model/network call or full-corpus scan; optional processing has exact scope/backend/budget approval. | P11S |
| S12 | Repository terminology and affected ADR/DDD/API/cache contracts are reconciled explicitly, with no command aliases for retired surfaces. | P11S |
| S13 | Re-finding success/time and title faithfulness are evaluated against the existing presentation; research analogy is not product proof. | P11S |
| A01 | Unknown Activity fraction is strictly below 0.10 on the frozen in-scope genuine-session population; exactly 10% fails. | P11S |
| A02 | Missing/unreadable/insufficient-evidence genuine sessions stay in the denominator and Unknown numerator; equivalent rejection buckets count. | P11S |
| A03 | Imported-only/replayed records are excluded under predefined ownership rules; uncovered sources and cloud populations remain disclosed. | P11S |
| A04 | A consented representative gold set has a reviewed rubric, independent annotations/adjudication, frozen labels and family-disjoint splits. Pilot approved: up to 250 genuine sessions over the most recent 120 days, with frozen timestamp boundaries and no automatic widening. Pilot families stay out of final evaluation, whose size is proposed afterward. | P11S |
| A05 | Accuracy option A confirmed 2026-09-30: automatic accepted-label correctness is at least 95%, with a one-sided 95% lower confidence bound at least 95% on the independent holdout. | P11S |
| A06 | Overall and per-host/class metrics, automatic/user label shares, confidence intervals and risk/coverage curves expose class imbalance and gaps. | P11S |
| A07 | Host-normalized actions and bounded task evidence improve classification; skill invocation alone is not assumed whole-session truth. | P11S |
| A08 | Taxonomy B approved 2026-09-30: primary plus evidence-supported secondary Activities from a fixed reviewed coding/non-coding vocabulary; secondary precision/recall is separate. Mixed cannot serve as an Unknown escape hatch. | P11S |
| A09 | Current rules, improved evidence/rules and authorized supervised/semantic candidates are compared on the same frozen test protocol. | P11S |
| A10 | Heuristic scores and calibrated probabilities are distinguishable; generated titles do not create circular gold labels or independent evidence. | P11S |
| A11 | Latency/resource/cost/privacy and drift checks bind to exact sources/models; no implicit installation, provider call or policy promotion. | P11S |
| A12 | Versioned cache/label migration and rollback preserve originals/user labels; training feedback and private sampling remain explicit opt-ins. Retention A approved 2026-09-30: permitted bounded benchmark evidence stays private, versioned and outside tracked content until separately approved cleanup. | P11S |
| A13 | If both coverage and approved accuracy gates cannot pass, report a failed gate and causes; no fabricated labels, threshold-only fix or scope waiver. | P11S |
