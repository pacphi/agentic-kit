# Architecture Decision Records

Lightweight [MADR](https://adr.github.io/madr/)-style records for **agentic-kit** (`ak`) design
decisions. These are ak's own ADRs — distinct from the ruflo / agentic-qe ADRs that `.claude/helpers/`
tooling references.

Format: `NNNN-kebab-title.md`, monotonically numbered. Each record states **Context → Decision →
Consequences**, and cites the grounded source it rests on where relevant.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-one-routing-policy-many-projections.md) | One dual-host routing policy, many projections | Accepted |
| [0002](0002-activity-vocabulary-defaults-from-ruv-templates.md) | Activity vocabulary & defaults seeded from rUv's shipped templates | Accepted |
| [0003](0003-auto-seed-dual-host-provenance.md) | Auto-seed on dual-host, subscription-only, per-route provenance | Accepted |
| [0004](0004-escalation-per-projection.md) | Escalation is per-projection, availability stated per path | Accepted |
| [0005](0005-dashboard-in-page-routing-reveal.md) | Dashboard surfaces routing via in-page reveal | Accepted |
| [0006](0006-primary-host-and-ambidextrous-mirroring.md) | Primary host & ambidextrous mirroring (which host leads) | Accepted |
| [0007](0007-maintainer-admin-local-telemetry.md) | Maintainer admin: a loopback telemetry page with deliberate egress | Accepted |
| [0008](0008-guidance-target-scope-split.md) | Machine-scoped guidance blocks land in machine files, not a repo's AGENTS.md | Accepted |
| [0009](0009-usage-scorecard-local-transcript-analytics.md) | Usage scorecard: local transcript analytics with graded evidence | Accepted |
| [0010](0010-provider-mediated-quota-reads.md) | Provider-mediated quota reads (the only honest denominators) | Accepted |
| [0011](0011-local-model-provenance-zero-cost-and-transcript-fidelity.md) | Local models: provenance out-of-band, $0 per model, stated transcript fidelity | Proposed |

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
`docs/PROVIDERS.md`.
