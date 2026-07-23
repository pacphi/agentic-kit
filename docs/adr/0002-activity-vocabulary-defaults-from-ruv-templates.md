# ADR-0002 — Activity vocabulary & defaults seeded from rUv's shipped templates

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** agentic-kit maintainers

## Context

The routing policy (ADR-0001) is keyed by *activity*. We must choose (a) the canonical set of activities and
(b) the default host+model for each. Inventing an arbitrary mapping would be a product opinion presented as
fact and would drift from what the underlying tools actually do.

rUv already ships an opinionated activity→platform mapping in `@claude-flow/codex`'s `CollaborationTemplates`:
`featureDevelopment` routes **architect → claude**, **coder → codex**, **tester → codex**, **reviewer →
claude**; `securityAudit` routes **scanner/fixer → codex**, **analyzer → claude**. The `dual-orchestrator`
agent definition adds a "Platform Selection Guide" (Design/Debug/Review → Claude; Implementation/Test/Docs →
Codex).

## Decision

Adopt a canonical activity vocabulary — `specification, architecture, design, implementation, testing,
review, security-scan, security-analysis, documentation, debugging, packaging, release` — and seed each
activity's default host **from rUv's shipped templates**, not from opinion:

- Claude: specification, architecture, design, review, security-analysis, debugging
- Codex: implementation, testing, security-scan, documentation

`packaging` and `release` have **no** upstream template. They are **ak-originated gap-fills**
(packaging → codex as mechanical/parallelizable; release → claude as judgment/coordination) and are **flagged
as such** wherever surfaced (an `ak` tag in the UI, a comment in the defaults table).

Default *models* map to the host's appropriate tier (Opus for deep reasoning, Sonnet for review, a Codex
model for execution) and are treated as **soft defaults** — see the "open question" on pinning live model IDs.

## Consequences

- Defaults are **provably grounded** and explainable ("architect→claude because `featureDevelopment` does").
- The ak-originated activities are honestly labeled, not smuggled in as rUv defaults.
- The vocabulary must be **re-checked on each `@claude-flow/codex` / agentic-qe version bump** — templates or
  the constructible-provider set may change (mirrors the existing "re-check `ALL_PROVIDER_TYPES`" discipline).
- Model IDs are not hardcoded aggressively; they are defaults the user overrides (ADR-0003).

## References

- `@claude-flow/codex/dist/dual-mode/orchestrator.js` (`CollaborationTemplates.featureDevelopment`,
  `securityAudit`); `dual-orchestrator` agent definition (Platform Selection Guide)
- memory: `ruflo-codex-dual-mode-mechanics`
