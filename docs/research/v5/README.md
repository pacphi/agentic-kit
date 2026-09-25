# Agentic Kit v5 research and experience exploration

Research snapshot: **September 25, 2026**. These documents and interactive
mockups capture the product exploration; they are proposals, not a shipped
v5 implementation or accepted architecture decision.

## Start here

- [Full cited report](report.md) — meeting findings, implementation comparison,
  host compatibility, economics, architecture and delivery recommendations.
- [Rendered report](report.html) — the report, evidence appendices and latest
  interactive workbench in one browser document.
- [Latest management workbench](previews/management-workbench.html) — stable
  navigation, shared panels, persona attention, onboarding, settings categories,
  scoped plans, updates, optional schedules and navigation memory.
- [Navigation memory](navigation-memory.md) — audit of where deep jumps lost
  your place, the five-visit Back/Forward trail and what the workbench remembers.
- [Settings organization](settings-organization.md) — eight purpose categories,
  component filters, shared editors and ownership/scope distinctions.
- [Shared management design](shared-management-design.md) — the current design
  rationale and onboarding decisions.

Download or clone the branch to open the HTML documents in a browser. GitHub's
file view shows HTML source rather than running the mockups. The documents are
self-contained; a web server and package installation are not required.

All machine data, costs and operations in the mockups are illustrative.
Buttons do not install, configure, update or enroll actual resources. Source
links open external documentation; private meeting/artifact links require
their existing access permissions.

## Mockup evolution

| Iteration | Standalone preview | Editable fragment | Status |
| --- | --- | --- | --- |
| Initial v5 concept | [Preview](previews/agentic-kit-v5-concept.html) | [Source](agentic-kit-v5-concept.html) | Historical exploration |
| Persona compositions | [Preview](previews/role-workbench.html) | [Source](role-workbench.html) | Historical; separate role navigation superseded |
| Shared management and onboarding | [Preview](previews/management-workbench-before-grouping.html) | [Source](management-workbench-before-grouping.html) | Historical; before settings grouping |
| Shared workbench with grouped settings and navigation memory | [Preview](previews/management-workbench.html) | [Source](management-workbench.html) | Latest concept |

Standalone previews preserve the fragments in a sandboxed document and bundle
their display helpers. The latest workbench remembers its trail, views and
simulated drafts in the preview host's storage, or in browser storage when the
report or fragment is opened directly. That memory stays in one browser; it is
not durable system state.

## Research and traceability

| Document | Purpose |
| --- | --- |
| [Meeting evidence](meeting-evidence.md) | 53 requirement candidates, certainty labels and original meeting citations |
| [Implementation audit](implementation-audit.md) | Current implementation, defects and source evidence |
| [Host interoperability](hosts.md) | Claude, Codex, Hermes, OpenCode, Gemini CLI and Grok research |
| [Taxonomy and economics](taxonomy-economics.md) | Branch comparison, labels, cost bases and fleet semantics |
| [Panel migration map](panel-map.md) | One canonical destination for 101 existing functional panel/capability groups |
| [Settings and lifecycle audit](settings-audit.md) | Configuration coverage, lifecycle ownership and native boundaries |
| [Role experience review](role-experience-review.md) | Reference artifact clickthrough and earlier persona exploration |
| [Experience contract](experience-contract.md) | Earlier shared-panel and attention recommendations |
| [Navigation memory](navigation-memory.md) | Deep-jump audit, visit trail design, remembered state and storage limits |
| [Verification](verification.md) | Checks performed and explicit prototype limitations |
| [Packaging record](packaging.md) | Repository capture, portability and publication adjustments |

## Machine-readable catalogues

- [Panels](panels.json): 101 unique functional panel/capability groups.
- [Settings](settings.json): 330 source entries; these include record members,
  run options, observations and proposals, not 330 independent preferences.
- [Settings taxonomy](settings-taxonomy.json): category, entry kind, collection
  membership and related components for every source entry.
- [Lifecycle](lifecycle.json): 21 component families and ownership contracts.
- [Attention](attention.json): persona attention research.
- [Snapshot manifest](manifest.json): SHA-256 digests for this package's files.

## Evidence baseline

Repository comparison: [`847486c`](https://github.com/pacphi/agentic-kit/tree/847486c61689f8499ada08f5b5684ecf26b22db8),
version `4.0.0-alpha.55`. Taxonomy proposal branch:
[`7b9093e`](https://github.com/pacphi/agentic-kit/tree/7b9093ef3e6d4c0efb9453ee5e48532a2064e612).
Source citations pin those revisions where possible. Upstream documentation
was researched on September 25, 2026; vendor capability claims are not local
runtime certifications.

The report and original meeting links preserve attribution. Raw meeting
transcripts, credentials and machine caches are not part of this package.
