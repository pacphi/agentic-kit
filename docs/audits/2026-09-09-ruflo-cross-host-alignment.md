# Ruflo release alignment and RuvNet Brain health — September 9, 2026

Audit baseline: `98e170611d754594d25f48e75d4fa58f8cb79e8a`, after merging
[PR #205](https://github.com/pacphi/agentic-kit/pull/205) and then
[PR #206](https://github.com/pacphi/agentic-kit/pull/206).
Branch: `audit/ruflo-last-ten-releases`. This is a report of observed state and
proposed follow-ups; the audit did not upgrade packages or repair host configuration.

## Findings that need attention first

1. **Codex exposes Ruflo twice, and kit status misses it.** Both effective
   registrations are enabled: `claude-flow` runs `ruflo mcp start`, and `ruflo`
   runs `ak x ruflo-mcp`. This session exposes 356 tools in each namespace.
   `codexMcpTopology()` nevertheless returns `duplicateRuflo: false`.
   Its recognition of the legacy transport depends on the strict removal
   matcher; the older entry's `AGENT_BROWSER_CONFIG` environment section makes
   it ineligible for removal and also invisible to duplicate detection.
   Separate broad detection from narrow ownership-based repair. Preserve
   custom configuration and compare effective enabled entries, including
   project overrides. Add a regression proving detection without deletion.
   Sources: [MCP topology](../../src/lib/mcp.mjs), effective `codex mcp list
   --json`, and the current tool registry.

2. **Installed Ruflo still resolves an affected security dependency.** Installed
   Ruflo is 3.39.0; its nested CLI resolves `fast-uri@3.1.5`. New
   [3.39.2](https://github.com/ruvnet/ruflo/releases/tag/v3.39.2) fixes the
   shipping dependency pin. Qualify and upgrade to that exact release, then
   inspect the installed dependency graph and restart affected MCP clients.
   A clean agentic-kit development dependency audit does not cover this global
   runtime. Do not substitute 3.39.1: its attempted fix did not reach consumers.

3. **Brain retrieval works, but Claude plugin health fails.** Corpus integrity
   and citation verification pass; the complete Brain doctor exits 1. Claude's
   enabled plugin registry still selects `0.5.0-dev`, whereas the marketplace
   manifest says 4.3.15 and the KB is 4.3.14. The selected old payload lacks
   the expected `commands/rvbc.md`; its hook manifest still declares
   `SessionStart`, `UserPromptSubmit`, and `PreToolUse`. Those bodies were not
   executed. Reconcile the actual host registry through the supported plugin
   lifecycle and re-prove automatic hook retirement. Checking the marketplace
   version alone is insufficient. See the detailed Brain evidence below.

## Brain: intact corpus, working search, incomplete host convergence

| Check | Observed result | What it establishes |
| --- | --- | --- |
| Installed KB | Release and manifest 4.3.14; 184 RVF stores | Presence and version identity |
| Coverage validation | `valid: true`, `COMPLETE`, zero failures; expected version 4.3.14 | Installed release/corpus/ledger consistency under the upstream validator |
| Current Codex `search_ruvnet` | Three Ruflo source results; receipt `009b4b083087` | A real query succeeded in this session |
| Independent citation verification | `grounded: true`; first citation resolves in `ruflo.passages.jsonl` | Returned citation exists in the local corpus |
| Fresh configured MCP discovery | Brain ready in 29 ms, four tools; owned Ruflo ready in 457 ms, 356 tools | Bounded initialize/tools-list succeeds; not a latency benchmark |
| Brain doctor live query | Source-backed answer in 122.3 seconds, `concepts/ruvector/CARD/ruvector-card` | Separate CLI retrieval and citation check passed |
| Brain doctor overall | Exit 1: Claude plugin registry cannot satisfy managed-install contract | Full host health is not green |
| Automatic hooks | Codex inactive by design; old registered Claude payload still contains three events | Cross-host retirement is not proven |
| Latest installable Brain | GitHub API reports 4.3.16, published September 9 at 03:40:46 UTC; ZIP asset present | Installed KB is behind the live release |

The integrity validator was loaded from the installed marketplace's 4.3.15
source. It binds the KB to release snapshot
`80c5322e6eaf87dd93cdeaac9fd12b49811cf034`; this is not an independent
signature verification of the downloaded ZIP. The Codex skill cache exposed
to this session is 4.3.14. These identities must not be collapsed into one
installed-version claim.

Brain's returned “1.1 days” corpus-age message is not proof that Ruflo's latest
changes are indexed. `manifest.json` identifies its Ruflo source commit as
[`fa13ee4`](https://github.com/ruvnet/ruflo/commit/fa13ee4ad60ac2090b1480656eb233521790d640),
dated August 15. `SOURCE.json` records an August 18 Ruflo build. The query
returned historical material, including an old `codex mcp-server` audit.
Use those citations as historical evidence, not current configuration advice.
Use live release artifacts for this audit's currency claims.
Latest Brain release: [4.3.16](https://github.com/stuinfla/ruvnet-brain/releases/tag/v4.3.16).

Doctor also reports an unspecified Codex startup deadline and no readiness
proof in its own state. The actual MCP query and the fresh discovery above
provide narrower positive evidence. They do not erase the failed Claude
registry check or explain the 122-second CLI query; a cold/warm comparison is
needed before attributing that delay to a specific component.

## Last ten published GitHub releases

Scope: the ten newest non-draft releases by publication time, observed on
September 9. All ten have `prerelease: false`; one is explicitly superseded.
Dates are UTC. GitHub release entries differ from npm versions: this list
contains neither 3.39.0 nor 3.39.1. Live npm tags `latest`, `alpha`, and
`v3alpha` all resolve to 3.39.2 for `ruflo`, `claude-flow`, and `@claude-flow/cli`.

| Release | Published | Relevant changes and kit implications |
| --- | --- | --- |
| [3.39.2](https://github.com/ruvnet/ruflo/releases/tag/v3.39.2) | Sep 9, 13:45:08 | Shipping `fast-uri` fix; honest Windows bridge reporting; internal AgentPool heartbeat correction. Security upgrade needs local qualification. |
| [3.38.23](https://github.com/ruvnet/ruflo/releases/tag/v3.38.23) | Sep 7, 17:41:46 | Routing escalation clears stale model identity; bounded regexes; cosine MMR; real startup measurement; upstream workspace/test repairs. Keep route and model evidence distinct. Explains skipped 3.38.22 publication. |
| [3.38.21](https://github.com/ruvnet/ruflo/releases/tag/v3.38.21) | Sep 2, 13:40:40 | HTTP MCP initializes memory registry with the intended path. Kit's stdio and per-project launch contracts still need their own checks. |
| [3.38.20](https://github.com/ruvnet/ruflo/releases/tag/v3.38.20) | Aug 24, 19:46:01 | Claude statusline derives intelligence from local patterns and shows unavailable measurements as unknown. Does not add a Codex custom footer. |
| [3.38.19](https://github.com/ruvnet/ruflo/releases/tag/v3.38.19) | Aug 22, 16:39:08 | Repairs broken publication; removes dead AgentDB imports; reports unavailable controllers; driver diagnostic and HTTP transport fixes. Retain the bad-version block. |
| [3.38.18](https://github.com/ruvnet/ruflo/releases/tag/v3.38.18) | Aug 22, 16:30:28 | Broken dependency graph from concurrent publication; explicitly superseded by 3.38.19. Never treat this release as an upgrade candidate. |
| [3.38.16](https://github.com/ruvnet/ruflo/releases/tag/v3.38.16) | Aug 21, 15:23:38 | Bounded MessageBus retries; opt-in hybrid retrieval and bandit decay. No basis to enable experiments or change routes automatically. |
| [3.38.15](https://github.com/ruvnet/ruflo/releases/tag/v3.38.15) | Aug 21, 14:42:00 | CLI tool listing honors filters; Windows Claude launch resolution; real session-end metrics; advisory settings scan. Recheck effective tools and Windows execution separately. |
| [3.38.14](https://github.com/ruvnet/ruflo/releases/tag/v3.38.14) | Aug 21, 14:31:33 | Invalidates incomplete memory write-through cache; tags and metadata round-trip. Installed train includes it; it does not prove correct corpus selection. |
| [3.38.13](https://github.com/ruvnet/ruflo/releases/tag/v3.38.13) | Aug 21, 14:20:04 | Cached statusline Git calls; namespaced agent identifiers; skill YAML fixes; optional DeepSeek plugin. No automatic host/provider expansion is required. |

The installed 3.39.0 train also needs explicit accounting. Its
[tagged release commit](https://github.com/ruvnet/ruflo/commit/e341ec8c4aba8ea616499180dee53035af7e295c)
documents the ADR-322C canonical receipt fix: fractional candidate-policy
numbers use decimal strings and policy schema advances to v2. Old signed
receipts remain historical evidence, but cannot authorize promotion under the
new schema. Kit has no direct candidate-policy/flywheel integration requiring
an adapter edit. Do not rewrite old receipts or reset champions as an automatic
upgrade step; the upstream reset path requires explicit confirmation and a
recorded reason. The 3.39.1 security attempt is covered by the corrective
3.39.2 notes above.

## Cross-host discrepancies and follow-up acceptance criteria

| Priority / scope | Evidence and discrepancy | Proposed completion criterion |
| --- | --- | --- |
| P1 — Codex context | Two enabled Ruflo transports, 712 total namespaced tools, but duplicate detection false. | Detect both without broadening deletion authority; reconcile the redundant registration preserving custom environment; fresh session exposes only intended tools. |
| P1 — all Ruflo consumers | Global CLI 3.39.0 resolves affected `fast-uri@3.1.5`. | Qualify 3.39.2, verify resolved package graph, run host startup/coordination and memory checks, then restart managed clients. |
| P1 — Claude Brain | Enabled registry targets 0.5.0-dev; expected command missing; old hook events remain; doctor exits 1. | Host registry and supported payload agree; no retired hook registrations; fresh Claude query and doctor both pass. |
| P2 — all hosts, status | `ak status` labels Ruflo 3.39.0 and Brain 4.3.14 “latest” from a 24-hour cache; live versions are 3.39.2 and 4.3.16. | Show observation timestamp/cache age and a refresh route; report latest-known rather than implying a live check. |
| P2 — OpenCode / Claude | One OpenCode agent projection is from 3.38.21 while its source is 3.39.0; status also reports stale injected statusline blocks. | After qualifying the dependency train, refresh owned projections and verify content receipts and preservation; inspect Claude's effective footer command. |
| P2 — memory, especially Windows | Canary success does not prove access to existing data; [#3228](https://github.com/ruvnet/ruflo/issues/3228) remains open. | Verify a known pre-existing record against an independently identified corpus, plus isolated write/metadata round-trip. Report native gating and fallback explicitly. |
| P2 — all project-memory users | [#3143](https://github.com/ruvnet/ruflo/issues/3143) and [#3196](https://github.com/ruvnet/ruflo/issues/3196) remain open: singleton/path propagation gaps. | Test two isolated workspaces and explicit path handling; prove no cross-project reads or writes through every supported invocation. |
| P2 — Claude memory preservation | Open [#3224](https://github.com/ruvnet/ruflo/issues/3224) reports AutoMemory replacing a hand-maintained index. Codex quarantine is not Claude protection. | Reproduce only in an isolated fixture, preserve original index bytes, verify merge/backup behavior before any live memory sync. |
| P2 — dependency governance | Exact-version guidance/init/Stop/browser evidence covers older releases; retests are due September 9. | Re-run source-bound checks on 3.39.2 and current host binaries; renew ranges and dates only from passing evidence. |
| P3 — constraint provenance | Bad-version block cites [#2885](https://github.com/ruvnet/ruflo/issues/2885), a 3.33.0 macOS neural mutex crash, rather than the broken publication. | Link the publication block to 3.38.19's release evidence and track the distinct crash separately. |

The Windows bridge change in 3.39.2 clarifies the backend label; it does not
repair wrong-corpus fallback or the native allocation abort. Kit's
[`verifyMemory()`](../../src/commands/x/verify.mjs) usefully identifies which
of two databases receives its isolated canary, but accepts either and does
not test an existing live key. This is a verification gap, not a reproduction
of data loss on this macOS machine.

Relevant tracked implementations:
[constraints](../../config/agentic-dependency-constraints.json),
[project-memory launch](../../src/lib/ruflo-memory.mjs),
[OpenCode gateway](../../src/templates/opencode-ruflo-gateway.js),
[Brain version detection](../../src/lib/ruvnet-brain.mjs),
[version cache](../../src/lib/versions.mjs), and
[host descriptors](../../src/lib/hosts.mjs).

## Context cost and host coverage

Ruflo doctor estimates **64,858 schema tokens for one 356-tool catalog**.
That is its estimate, not measured Codex request consumption. Two registrations
prove duplicate tool exposure, not that every request embeds both complete
schemas. Tool loading, serialization, skills, instructions, and transcript
history also affect consumption. Measure a fresh session before and after
deduplication before claiming a token saving. Increasing the Codex capacity
in #206 does not remove unnecessary tool exposure.

| Host | Observed or implemented integration | Remaining proof boundary |
| --- | --- | --- |
| Claude 2.1.266 | User-scope `claude-flow` stdio registration; subscription auth inferred; command statusline supported. Nine other project records retain Ruflo registrations. | Per-project effective duplicates need ownership review; do not remove unrelated project entries from this audit. Brain plugin convergence fails. No fresh Claude execution was launched. |
| Codex 0.153.4 | Working Brain query; fresh owned Ruflo discovery; canonical workspace-aware launcher plus duplicate legacy transport; native maximum request 872,000. | Deduplicate safely and measure context. Native per-model effective limits remain distinct from API capacity. |
| OpenCode 1.18.29 | Configured Ruflo/AQE/Brain, compact gateway, project DB path injected by gateway; one stale agent projection. | Config convergence is not a fresh host execution proof. Explicit permission boundaries remain; no custom statusline exists. |
| Admitted external adapters | Kit capability/grant system permits bounded routing; session-driving, primary eligibility and native backend registration are separate. | No new Ruflo-native backend contract in reviewed notes; do not infer Hermes or other adapters are installed, healthy, or provider-equivalent. |

The active session and doctor provide narrower evidence than a fresh three-host
end-to-end run. No paid provider inference, browser workload, external adapter
execution, Windows live-store mutation, or near-limit context test was performed
for this audit.

## Open issues and areas already aligned

Screened the newest 300 open Ruflo issue titles and inspected selected relevant
bodies and linked reports, plus all six open agentic-kit issues. This is a bounded issue sweep, not an assertion
that every upstream issue was inspected. Open issue reports are leads unless
independently reproduced here.

- Ruflo [#3153](https://github.com/ruvnet/ruflo/issues/3153),
  [#3167](https://github.com/ruvnet/ruflo/issues/3167), and
  [#3163](https://github.com/ruvnet/ruflo/issues/3163) remain open. Release notes
  do not close the guidance selector, init suppression, and Stop output gaps.
  Kit's suppression flags, scripted JSON mode, and `RUFLO_NO_SKILLS_SH=1`
  remain bounded mitigations, not universal compatibility guarantees.
- The owned Codex launcher uses installed Ruflo, avoiding the cwd-dependent
  package-resolution path reported in
  [#3213](https://github.com/ruvnet/ruflo/issues/3213). Separately installed
  plugin launchers require independent inspection.
- Native kit worker adapters pass configured model IDs through `--model`;
  OpenCode preserves provider identity. Ruflo's typed schema issue
  [#3215](https://github.com/ruvnet/ruflo/issues/3215) does not demonstrate that
  those execution adapters need Claude aliases.
- [#3046](https://github.com/ruvnet/ruflo/issues/3046) remains the upstream
  backend-registration gap. Kit already distinguishes an external adapter from
  a Ruflo-native backend.
- Kit [#95](https://github.com/pacphi/agentic-kit/issues/95) correctly keeps
  OpenCode host execution separate from an AQE inference-provider integration;
  [#109](https://github.com/pacphi/agentic-kit/issues/109) keeps evidence-backed
  route learning as future work. The four other open kit issues (#116 install
  classification; #115 GitNexus; #117 Graphify; #167 graft) are not requirements
  created by this release train.
- HTTP transport fixes, optional DeepSeek/hybrid/bandit features, upstream
  monorepo build changes, and the package-internal AgentPool fix do not require
  automatic changes to kit's stdio transport or zero-runtime-dependency package.
- Missing API keys, Cognitum login, or Meta LLM proxy do not establish a broken
  subscription-based host setup. Ruflo CLI's STOPPED/zero-memory overview also
  does not negate successful direct MCP calls or independently observed stores.

## Closure and verification record

Neither prior PR superseded the other. #205 supplied AQE repairs; #206 built on
them with Codex capacity management. #205 merged as `9832451` at 13:47:24 UTC;
PR #206 was retargeted to main and merged as `98e1706` at 13:55:22 UTC.

The #205 Windows failures came from three tests expecting executable artifact
repairs on a deliberately read-only platform. Commit `25db634` scopes those
tests and adds a Windows preservation check. #206's separate package guard
required two shipped paths in `MAINTAINER.md`; commit `bbf71d8` supplies them.
Both PRs passed every applicable CI check before merge. The final #206 run's
Windows/Node 22 attempt hit three unrelated subprocess timing/cleanup failures;
the failed-job rerun passed with no code changes. This is retained as a
possible CI-flake follow-up, not evidence that its underlying timing fragility
was repaired. Local focused validation: 13 repair/inventory tests passed;
timing suites: 55 passed, one skipped.

Evidence summary: [machine-readable receipt](../evidence/ruflo-cross-host-audit-2026-09-09.json).
Raw local diagnostic logs are retained under `/tmp/ak-audit-*`; the receipt
records their hashes without publishing personal paths, configuration values,
or memory contents. Diagnostic commands may refresh their own caches/receipts;
no configuration repair or package update was applied. No upstream issues were
opened, and no package release was published.
