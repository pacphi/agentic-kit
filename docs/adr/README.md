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
| [0005](0005-dashboard-in-page-routing-reveal.md) | Dashboard surfaces routing via in-page reveal | Amended by 0020 |
| [0006](0006-primary-host-and-ambidextrous-mirroring.md) | Primary host & ambidextrous mirroring (which host leads) | Amended by 0020 |
| [0007](0007-maintainer-admin-local-telemetry.md) | Maintainer admin: a loopback telemetry page with deliberate egress | Accepted |
| [0008](0008-guidance-target-scope-split.md) | Machine-scoped guidance blocks land in machine files, not a repo's AGENTS.md | Accepted |
| [0009](0009-usage-scorecard-local-transcript-analytics.md) | Usage scorecard: local transcript analytics with graded evidence | Accepted |
| [0010](0010-provider-mediated-quota-reads.md) | Provider-mediated quota reads (the only honest denominators) | Accepted |
| [0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md) | Local models: provenance out-of-band, $0 per model, stated transcript fidelity | Proposed |
| [0012](0012-live-sessions-observability.md) | Live sessions as local, evidence-graded observability | Accepted; compatibility source amended |
| [0013](0013-admin-build-security-signals-and-honest-reach.md) | Admin: build/security signals, an honest Reach panel, and a pagination fix | Accepted |
| [0014](0014-dashboard-auth-and-remediation.md) | Dashboard auth token, plus a security/quality remediation pass | Accepted |
| [0015](0015-managed-codex-native-statusline.md) | Manage Codex's native user-wide status line without claiming rich-renderer parity | Accepted |
| [0016](0016-capability-driven-integration-adapters.md) | Capability-driven host, provider, binding, projection, and observability adapters | Accepted; compatibility amended |
| [0017](0017-opencode-host.md) | OpenCode as a managed, observable host through native surfaces | Accepted; compatibility amended |
| [0018](0018-generalized-host-worker-execution.md) | Generalized host-worker execution; `ak run` canonical | Accepted; compatibility amended |
| [0019](0019-escalation-in-ak-run.md) | Bounded per-worker escalation in `ak run` | Accepted; historical context closed |
| [0020](0020-ga-stable-surfaces.md) | One stable GA surface per capability | Implemented |
| [0021](0021-inference-provider-provenance.md) | Inference-provider provenance for live sessions | Accepted |

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
`docs/PROVIDERS.md`. **0012** adds a read-only Live Sessions workspace: host-specific evidence is
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

**0021** makes the Live view answer who serves each session's models without overclaiming. Codex's
in-artifact `model_provider` (rollouts + state ledger) is read as observed evidence; Claude Code's
provider is resolved from its documented configuration surface (Bedrock/Vertex/Foundry flags,
`ANTHROPIC_BASE_URL` gateways) with configured/inferred provenance, since its transcripts never
record the serving endpoint.
