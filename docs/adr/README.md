# Architecture Decision Records

Lightweight [MADR](https://adr.github.io/madr/)-style records for **agentic-kit** (`ak`) design
decisions. These are ak's own ADRs — distinct from the ruflo / agentic-qe ADRs that `.claude/helpers/`
tooling references.

Format: `NNNN-kebab-title.md`, monotonically numbered. Each record states **Context → Decision →
Consequences**, and cites the grounded source it rests on where relevant.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-one-routing-policy-many-projections.md) | One dual-host routing policy, many projections | Superseded in part by 0020 |
| [0002](0002-activity-vocabulary-defaults-from-ruv-templates.md) | Activity vocabulary & defaults seeded from rUv's shipped templates | Amended by 0020 |
| [0003](0003-auto-seed-dual-host-provenance.md) | Auto-seed on dual-host, subscription-only, per-route provenance | Amended by 0020 |
| [0004](0004-escalation-per-projection.md) | Escalation is per-projection, availability stated per path | Superseded by 0019/0020 |
| [0005](0005-dashboard-in-page-routing-reveal.md) | Dashboard surfaces routing via in-page reveal | Implemented |
| [0006](0006-primary-host-and-ambidextrous-mirroring.md) | Primary host & ambidextrous mirroring (which host leads) | Amended by 0020 |
| [0007](0007-maintainer-admin-local-telemetry.md) | Maintainer admin: a loopback telemetry page with deliberate egress | Accepted |
| [0008](0008-guidance-target-scope-split.md) | Machine-scoped guidance blocks land in machine files, not a repo's AGENTS.md | Implemented |
| [0009](0009-usage-scorecard-local-transcript-analytics.md) | Usage scorecard: local transcript analytics with graded evidence | Implemented |
| [0010](0010-provider-mediated-quota-reads.md) | Provider-mediated quota reads (the only honest denominators) | Accepted |
| [0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md) | Local models: provenance out-of-band, $0 per model, stated transcript fidelity | Proposed |
| [0012](0012-observability.md) | Evidence-graded session observability | Implemented |
| [0013](0013-admin-build-security-signals-and-honest-reach.md) | Admin: build/security signals, an honest Reach panel, and a pagination fix | Accepted |
| [0014](0014-dashboard-auth-and-remediation.md) | Dashboard auth token, plus a security/quality remediation pass | Implemented |
| [0015](0015-managed-codex-native-statusline.md) | Manage Codex's native user-wide status line without claiming rich-renderer parity | Accepted |
| [0016](0016-capability-driven-integration-adapters.md) | Capability-driven host, provider, binding, projection, and observability adapters | Accepted; compatibility amended; closed-registry clause superseded by 0029 |
| [0017](0017-opencode-host.md) | OpenCode as a managed, observable host through native surfaces | Accepted; compatibility amended |
| [0018](0018-generalized-host-worker-execution.md) | Generalized host-worker execution; `ak run` canonical | Implemented; compatibility amended |
| [0019](0019-escalation-in-ak-run.md) | Bounded per-worker escalation in `ak run` | Accepted; historical context closed |
| [0020](0020-ga-stable-surfaces.md) | One stable GA surface per capability | Implemented |
| [0021](0021-inference-provider-provenance.md) | Inference-provider provenance for live sessions | Accepted |
| [0022](0022-metaharness-as-optional-assurance-companion.md) | MetaHarness as an optional assurance companion | Proposed |
| [0023](0023-fail-closed-operations-and-explicit-degradation.md) | Fail-closed mutations and explicit degraded operation evidence | Implemented |
| [0024](0024-project-intelligence-telemetry.md) | Project intelligence: live learning telemetry from ruflo/agentic-qe's own state | Implemented |
| [0025](0025-machine-footprint-metrics.md) | Machine footprint: infrastructure metrics for install, runtime, storage, and catalog | Implemented |
| [0026](0026-about-component-directory.md) | About: a component directory that explains everything ak installs | Implemented |
| [0027](0027-shared-project-census.md) | One project census, four scopes, every count explains itself | Implemented |
| [0028](0028-local-openai-compatible-providers.md) | One generic local OpenAI-compatible provider, not a vendor enumeration | Accepted |
| [0029](0029-host-adapter-extension-point.md) | External host adapters: declarative manifest, subprocess hooks | Accepted (experimental contract) |
| [0031](0031-capability-graduation-and-upstream-requests.md) | Capability graduation: earned parity for external adapters, and the upstream request path | Accepted (governance; implementation staged) |
| [0032](0032-model-lifecycle-intelligence.md) | Model lifecycle intelligence from provenance-aware local evidence | Implemented |
| [0033](0033-retire-codex-mcp-and-bound-qe-court-participants.md) | Retire Codex MCP; bound reciprocal QE-Court participant transport | Implemented; handoff transport amended by 0034 |
| [0034](0034-schema-native-handoffs-and-hermetic-seats.md) | Schema-native worker handoffs and hermetic qe-court seats | Implemented |
| [0035](0035-managed-deja-vu-companion.md) | Manage deja-vu as an opt-in session-history companion | Accepted; implementation tracked by issue #114 |
| [0036](0036-dashboard-client-modularization-and-shared-loopback-server.md) | Dashboard client modularization and shared loopback server | Implemented |
| [0037](0037-complexity-program-structural-patterns.md) | Complexity program: structural patterns and gates | Implemented |
| [0038](0038-consistent-cross-host-session-metrics.md) | Consistent cross-host session metrics | Accepted |
| [0039](0039-prompts-intelligence.md) | Deterministic Prompts telemetry on main | Accepted |
| [0040](0040-codex-hook-audit-and-conservative-remediation.md) | Codex hook audit and conservative remediation | Implemented (Codex Wave 1) |
| [0041](0041-host-neutral-hook-configuration-assurance.md) | Host-neutral hook configuration assurance | Implemented; native runtime receipt acquisition deferred |
| [0042](0042-capability-aware-context-budget-intelligence.md) | Capability-aware context budget intelligence | Implemented |
| [0043](0043-managed-ruflo-browser-executor.md) | Manage Ruflo's browser executor behind a replaceable boundary | Accepted |
| [0044](0044-receipt-aware-maintenance-control-plane.md) | Receipt-aware Maintenance control plane | Implemented |
| [0045](0045-artifact-consumer-bindings-and-explicit-maintenance-scans.md) | Physical artifacts, host consumers, and explicit Maintenance scans | Implemented |

Theme: ADRs **0001–0006** define **dual-host LLM routing and leadership** — how `ak` lets ruflo route
each development activity (architecture, implementation, testing, review, …) to the right host (Claude
or Codex) and model, which host **leads** (0006), seeded on detection, tunable by the user, and surfaced
across `setup`/`sync`/`status`/`dashboard`. **0007** covers the local diagnostic surfaces — splitting the
offline-first `dashboard` from the deliberately-egressing, credential-touching maintainer `admin` along
the network-egress line. **0008** draws a second scope line — machine-scoped guidance blocks belong in
machine-wide files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), never a repo's checked-in `AGENTS.md` —
and folds the two duplicated target lists into one shared `guidanceTargets` helper. **0009** adds the
usage scorecard — local transcript analytics as a dashboard tab (no egress, so it stays inside 0005's
offline contract rather than joining 0007's egressing admin), with an incremental index over a
multi-GB corpus and an explicit evidence grading rule: findings claim a dollar figure only when they
can compute one, and capability claims carry citations or are not made. **0010** supplies the one
thing 0009 refused to invent — plan-utilisation denominators — by reading each vendor's own reported
percentages through supported channels (Claude Code's statusLine push, Codex's `app-server` RPC),
with provenance and freshness attached. **0011** extends the same discipline to the other end of the
price axis: a session served by a **local** model (`ollama launch claude` / `codex`) reports no cache
accounting, approximate token counts, and a model id the vendor documents how to forge — so
provenance is established out-of-band via a loopback catalogue read, local models are priced at an
exact `$0` **per model** rather than in one bucket, unrecognised models become `unpriced` instead of
silently fallback-priced, and each local session states what its provider could not report. See also
`docs/PROVIDERS.md`. **0012** adds a read-only Observability workspace: host-specific evidence is
normalized into a versioned, provenance-bearing event model, reduced into an interactive
agent/tool canvas, and paired with a rich selected-session transcript rail. Separate SSE planes
keep content out of broad topology snapshots/replay while preserving masked local evidence and
keeping chat/control absent. Claude/Codex collection is
implemented; ruflo and agentic-qe require explicit, repeatable `--live-source` registration.
Independent plugin/skill/MCP discovery and a measured frame-time budget remain
documented limitations rather than implied capabilities. **0013** extends 0007's admin collector with
CI-run and Dependabot-alert signals, fixes a releases-pagination cap that silently dropped older
releases, replaces two GitHub-release-asset Reach tiles that were permanently dead for this npm-only
project with real GitHub-native people signals (contributors, watchers), and states the existing
npm-mirror-inflation exclusion explicitly instead of as a footnote. **0014** closes a gap a
multi-reviewer audit found in the dashboard: `/api/session/:id` served full transcript text behind
only a browser-oriented guard, so any local non-browser process could read it. The dashboard now
mints a per-session token the same way 0007's admin already did, plus a cluster of correctness
fixes from the same audit — an SSE client-cap race, `shell:true` on Windows, non-atomic settings
writes, a build-gate that could pass having checked nothing, secret-masker gaps, an O(n) session
lookup, a stale-cache bug, prototype-pollution-shaped CLI dispatch, enforced coverage floors, and
new test coverage for the previously-untested machine-mutating commands.

**0015** recognizes Codex's native status line without pretending it can host
Claude's command-backed telemetry renderer. It adds opt-in, user-scoped presets,
narrowly projects only the owned `[tui]` keys into `~/.codex/config.toml`, and
keeps unowned or user-modified configuration outside `sync` and uninstall.

**0016** separates execution hosts, inference providers, configuration projections, and
observability sources into validated capability registries, with provider bindings as versioned
intent between them. It standardizes detect/plan/apply/verify/undo, value-precise ownership, and
field-level provenance; preserves legacy Claude/Codex routing; and proves the shape with one Ollama
provider behind two hosts, OpenRouter behind an existing host, and OpenCode managed without becoming
routable by accident. Its Ollama bindings are a structural multi-host proof; ADR-0011 remains the
independent Proposed decision for observed local execution, catalogue-backed identity, usage
pricing, and transcript fidelity.

**0017** applies ADR-0016 to OpenCode as a managed, observable host. It wires the rUv
stack through OpenCode's native JSON configuration, plugin, converted-agent, skill, and
machine-guidance surfaces; preserves user values through ownership receipts and guarded teardown;
and preserves primary/AQE routing boundaries. ADR-0018 adds the OpenCode execution-worker
contract and explicit activity routes through `ak run`.

**0018** defines the host-neutral worker lifecycle and normalized terminal evidence and makes
`ak run` canonical. It selects OpenCode's loopback HTTP/OpenAPI transport and documents its
permission, timeout, cleanup, provenance, and AQE-boundary evidence. Its temporary compatibility
clauses are superseded by ADR-0020.

**0020** closes the 4.0 alpha compatibility window. It establishes one execution command, one
host-management namespace, and the versioned top-level routing envelope; removes dynamic
adapter-specific execution bootstrap; limits old vocabulary to marked decision history and one
upgrade section; and preserves OpenCode's opt-in, supervised, non-primary, non-AQE boundary.

**0021** makes Observability answer who serves each session's models without overclaiming. Codex's
in-artifact `model_provider` (rollouts + state ledger) is read as observed evidence; Claude Code's
provider is resolved from its documented configuration surface (Bedrock/Vertex/Foundry flags,
`ANTHROPIC_BASE_URL` gateways) with configured/inferred provenance, since its transcripts never
record the serving endpoint.

**0022** places MetaHarness primarily around agentic-kit as optional assurance tooling. It may
score, audit, red/blue, compare, and evolve its own harness policies while `ak` retains lifecycle,
routing, and supervised-execution authority. A future internal integration is limited to a
capability-probed, read-only projection unless another decision authorizes mutation. The ADR also
requires a versioned, sanitized companion result contract before treating `ak run --json` as an
interop API.

**0023** reconciles seven independent clean-machine findings under one operational-truth contract:
managed fallbacks report degradation, SQLite retains classified failure evidence and last-good
usage, promised backups fail closed before atomic replacement, status-line failures gain redacted
opt-in diagnostics, process discovery is current-user and argv-minimized, setup discloses and
verifies its project auto-approve manifest, and clean-machine tests isolate every mutable path. A
follow-up closed a parity gap in the last item: `sourceHealth` originally covered only the two
secondary/corrective sources (OpenCode's store, Codex's thread ledger), not the primary Claude/Codex
transcript roots — an unreadable `~/.claude/projects` or `~/.codex/sessions` still read as silent
zero. It now reports all four.

**0024** gives Overview's Intelligence view real trend data instead of a permanently-empty strip:
a new `intel-history.mjs` module reads the neural pattern store, its lifetime learned-pattern
counter, and reasoning-graph size samples that ruflo/agentic-qe already write under
`.claude-flow/`, while a debounced `IntelligenceWatch` pushes near-instant updates over a new
`GET /api/live/intelligence` SSE route additive to the existing status poll. It establishes Project
intelligence as its own bounded context rather than an Observability extension — this telemetry
carries no session, actor, host, provider, or lifecycle identity and needs no per-field evidence
confidence, and the panel it feeds lives under Overview, not Observability's Live/History scope.

**0025** answers the fourth question family the dashboard had no owner for — not health, spend, or
activity, but **what this toolchain costs the machine itself**: install bytes per managed tool with
their install methods and duplicate native builds, live CPU/RSS per host process and daemon,
retained data broken down category → host → project → session with growth and advisory reclaimable
candidates, the deduplicated cross-host inventory of skills/agents/commands/plugins/MCP servers,
and per-project approximate LOC alongside working-tree, `.git`, and `node_modules` bytes. It
establishes Machine footprint as its own bounded context — metadata-only by construction, so
transcript content cannot enter it — and adds a fourth primary area, **System**, deliberately
amending 0005's three-area layout. Collection is tiered because the costs differ by orders of
magnitude: a cheap TTL-cached tier on every read, and an explicit single-flight deep scan persisted
to a snapshot so the panel paints instantly and always states how old its figures are. 0023's
honesty contract is load-bearing throughout — a never-scanned section reads "not measured yet",
never `0`; a partial total renders as a lower bound; an unreadable subtree degrades that node
alone. The tab and the CLI share one name (`ak system`); "footprint" survives only as the domain
name. Windows gets a guaranteed `Get-CimInstance` process census plus a best-effort P/Invoke
working-directory probe that degrades to an explicit "not attributable" rather than blanking the
view — no dependency added, and `windows-latest` is already in the CI matrix.

**0026** closes the trust gap the other four areas assume away: every existing view is an
*operational* view of components the user is presumed to already recognize, and nothing answered
"what did this thing just put on my machine, and why should I be glad it's there?" It adds
**About** as a fifth primary area, leftmost in reading order but never the landing view — Overview
stays the default and a dismissible first-run nudge points newcomers left. Its bounded context,
Component directory, owns the one kind of fact no neighboring context can supply: editorial
identity — a tagline, one ~50-word plain-language paragraph, outbound source/package/docs links, an
icon spec, and a curated order — authored and versioned with the release. The editorial/detection
split is the decision: prose never claims runtime state, chips render only detection facts already
produced by `/api/status`, and About adds no endpoint, no probe, and no cache. Completeness is a
test rather than a review hope — every managed tool must have exactly one entry, and no entry may
exist for something ak neither installs nor configures. Official marks appear only where the
dashboard already ships them as official; everything else gets an explicit monogram tile rather
than a fabricated logo. `ak about` prints the same directory in a terminal.

**0027** ends a four-way disagreement about what a project *is*. Overview, Usage, Observability and
System each discovered projects their own way, from their own source, with their own naming rule,
and reported four different numbers for the same machine — 4, 14, another 14, and ~48. None was
wrong; nothing said which question each answered, so four honest answers read as one broken
feature. It makes `discoverProjectSources()` the single census and names four **scopes** over it
(`everSeen`, `onDisk`, `gitRepos`, `learning`), with the rule that no surface may render a project
count without the sentence explaining what that count counted. Two decisions carry the weight. The
*learning* scope asks whether memory or intelligence has been **activated** — `.claude-flow`,
`.agentic-qe` or `.swarm`, whichever host created it — rather than whether ruflo has *trained*,
which is why Intelligence went from 4 projects to 17 on the deciding machine. And directory scopes
stay separate from project scopes: System measures directories because that is what has bytes in
it, while Intelligence folds a repo's sub-directories and throwaway agent worktrees onto one
identity because that is what a user picks — a distinction that was also a live bug, since keying
the picker off identity while listing directories made 7 of 24 rows unreachable. Counts that remain
different stay different, and say why.

**0028** adds a second local provider, `local-openai`, because a local model is normally served as
an OpenAI-compatible endpoint on loopback — MLX, LM Studio, `llama.cpp`, vLLM — and frequently under
a name the *user* chose, which no vendor enumeration can cover; the registry previously knew only
`ollama`. It deliberately claims less than `ollama` (no catalogue, no runtime probe, no digest),
puts the runtime's identity in the binding's endpoint rather than in the provider id, and projects
to `['ruflo', 'codex', 'opencode']` only — no `claude` (the row claims only the OpenAI-compatible
transport) and no `aqe` (AQE's provider set is upstream's own enumeration; `ollama` is in it,
`local-openai` deliberately is not). Proposed by community contributor adrianco in PR #131, accepted
with a correction to the PR's quoted Hermes reference config, whose `api_mode: openai` is not a
valid Hermes value.

**0029** answers the same PR #131 with a different mechanism than it proposed. Where the PR asked
for an in-process ESM module loaded by `import()`, this ADR accepts a declarative manifest driving
a fixed set of consented, subprocess-only hooks — no third-party code ever runs inside the `ak`
process, gated behind `AK_EXPERIMENTAL_HOST_ADAPTERS=1`, admitted only after a hash-pinned consent
that invalidates the moment the manifest's content changes. `canBePrimary`,
`commandStatusline`, and `host.legacy.aqeProvider` are not claims the manifest schema accepts, so
authority stays outside an adapter's own promise. Since the 2026-08-26 amendment, `aqe.provider`
may carry non-authoritative Agentic-QE 3.13.12+ candidate data; a real conformance tier and explicit
grant activate it. It formally supersedes
ADR-0016's closed-registry clause, folds in the maintainer's full PR #131 gate list (import-time
routable-host invariant, uninstall-through-undo, permission authorization by host, attribution
surfaces policy, and kit.json's unknown-key warning — landed in wave 1 and Phase 0; registry↔directory
test pins remain wave 3), and stays experimental until a real external adapter clears the
conformance kit and a release of soak.

**0031** amends 0029 on one point and adds the governance around it. The three capability caps
(`canBePrimary`, `host.legacy.aqeProvider`, `commandStatusline`) stay *inexpressible* as capability
self-claims — that block is permanent — but capability becomes *earnable*: passing a
conformance tier plus an explicit maintainer grant (hash-pinned, outside the manifest) confers it,
up to and including promotion to a first-party built-in with full parity. It also records the
upstream-request path. Its AQE ceiling was satisfied by Agentic-QE 3.13.12 `externalProviders` on
2026-08-26: the six-tier ladder now includes `aqe-provider`, and a grant activates project-scoped
default/fallback/agentOverride projection. Native ruflo backend status remains upstream-owned.
Accepted as
a governance decision; the machinery (the trust CLI, external execution, tiered conformance, the
grant store) is staged and self-graded in the ADR's implementation-status table.

**0032** accepts Model lifecycle intelligence as a new bounded context. Its implementation and
exact-head release proof are recorded in the decision. It keeps configured,
effective, observed, discoverable, entitled, policy-allowed,
routable, lifecycle, and recommended state independent; normalizes host/provider catalogues through
bounded descriptor-driven source adapters; and persists sanitized same-scope snapshots whose
baselines advance only on sufficiently complete evidence. Diffs, explanations, and swap plans are
read-only. Canonical route mutation remains `ak host pick`, first-party migration remains distinct
from quality, and only Route Intelligence may claim evidence-backed equivalence. The feature adds
`ak models`, a cache-only status row, an Overview summary, and Models beneath Usage
without changing the Dashboard's five primary areas.

**0035** accepts deja-vu v0.19.0 as an opt-in managed companion for local cross-host session
history. It keeps Ruflo/AgentDB authoritative for curated operational memory, defaults recall to
MCP, requires separate per-host consent for automatic injection, and applies the shared
detect/plan/apply/verify/undo lifecycle without making the companion a host, provider, binding,
routing target, or observability authority. Package, target, plugin, and data ownership stay
separate; normal diagnosis parses offline doctor schema version 2; indexing uses bounded
`deja index` rather than guidance-writing `deja warmup`; teardown preserves external installs and
user data unless a separately previewed purge is confirmed.

**0036** answers a 2026-08 complexity audit of the dashboard/admin implementation, not a
user-facing change. `dashboard-server.mjs`'s 15-route request handler becomes a route table plus
one `sseRoute()` lifecycle contract in `dashboard/sse.mjs` for the three SSE routes' shared
reserve-slot/early-close/channel-open scaffolding. New `loopback-server.mjs` gives token
mint/compare, `readJsonSafe`, and the listen/response boilerplate one home shared by both
`dashboard-server.mjs` and `admin-server.mjs`, ending the latter importing a security primitive
from the former. `dashboard/client.mjs`'s 4,044-line inline-script string and
`dashboard/styles.mjs`'s 1,309-line inline stylesheet are rebuilt as small collectors over real,
individually lintable modules, generalizing the readFileSync-concat pattern ADR-0007's admin page
already used. The served page, its routes, and its CSP are unchanged.

**0037** is the program-level record of the same 2026-08 complexity audit: five file-disjoint
refactor tracks that removed every function over CC 100 and fixed the five behavioral
divergences duplication had caused. Its durable content is the set of sanctioned structures —
the `ak status` section registry pinned by a golden snapshot, `convergeProviderStack()` as the
one provider pipeline with ordered surface reconcilers, writer-owned drift comparators with a
status/writer parity test (closing the issue #129 class), the `telemetry-records.mjs` decode
layer shared by batch and live telemetry, statusline segment providers, and the complexity
lint warnings (25/5/1000 over `src`+`bin`) that ratchet to errors as areas come clean — plus
the honestly-stated residual backlog it did not take on.

**0038** extends 0009's scorecard from what a window cost to how it was worked, across three hosts
that record that evidence asymmetrically. It fixes one closed four-value permission-posture
vocabulary whose every mapping is a pinned judgment (approval evidence alone suffices for `guarded`,
and only for `guarded`), makes an unmapped value a first-class `not-recorded` bucket rather than a
guess or a display fallback, defines response latency as prompt-to-response — never
time-to-first-token — with Codex's host-measured duration as a fallback only, and derives
percentiles from bucket histograms whose overflow slot reports a floor rendered `≥`. It keeps
`byDay`'s billed-days presence contract by putting per-day engaged time in a sibling map, derives
previous-window deltas from the display window while discovery widens its own cutoff, excludes
structurally-$0 sessions from the cost distribution, declines to bucket window spend by inference
provider at all (only one of three transcript formats records one — 0021's rule applied to spend),
keeps host-native tool names, and prices cache savings by differencing the pricer instead of a
multiplier. Schema v11 carries the new record fields, and
discovery gains exactly one nested shape — Claude Code's `<sessionId>/subagents/` sidechain
transcripts, whose absence had made a quarter of the sessions and 39% of the cost in a reference
window invisible — behind a namespaced id grammar that narrows the traversal guard rather than
loosening it.

**0039** adds privacy-preserving prompts intelligence to the usage scorecard. It separates human
prompts from control/agent/adapter turns, retains bounded fingerprints rather than text, uses
history-backed baselines where evidence permits, and keeps model enrichment opt-in and
receipt-bound.

**0040** proposes a separate hook-audit bounded context. It discovers direct, project, and
selected-plugin Codex lifecycle hooks without executing them; preserves every occurrence while
behavior-deduplicating; keeps compatibility, trust, security, provenance, ownership, duplicate,
performance, and runtime diagnostics independent; and classifies healing as automatic,
approval-required, or never-automatic. Plugin caches and trust state remain unwritable. A later
apply wave requires exact preimages, transaction-specific backups/receipts, guarded rollback, a
clean second audit, and a byte/mtime no-op proof. The ADR remains Proposed pending independent
dual-host review.

**0044** implements Maintenance as a separate control-plane bounded context under System without
giving Machine Footprint mutation authority. It separates evidence-backed
findings, immutable source-bound plans, one-use action capabilities, provider-owned operations,
verification, durable receipts, guarded undo, and observation-only receipt recovery. Its provider boundary exposes only
host-native lifecycle verbs or exact agentic-kit-owned procedures; plugin cache children, incomplete
skill receipts, unsupported host verbs, and uncertain evidence remain report-only. The dashboard
stays read-only except for four explicitly allowlisted Maintenance route shapes,
each retaining ADR-0014's loopback protections and adding bounded JSON, fixed server-side actions,
explicit confirmation, and one-use authorization. Interrupted outcomes require explicit CLI
reconciliation; recovery never retries or rolls back an uncertain provider effect.
