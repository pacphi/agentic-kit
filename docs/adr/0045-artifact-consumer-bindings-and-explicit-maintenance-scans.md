# ADR-0045 — Physical artifacts, host consumers, and explicit Maintenance scans

- **Status:** Implemented
- **Date:** 2026-09-03
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #198](https://github.com/pacphi/agentic-kit/issues/198),
  [issue #200](https://github.com/pacphi/agentic-kit/issues/200),
  [ADR-0025](0025-machine-footprint-metrics.md), and
  [ADR-0044](0044-receipt-aware-maintenance-control-plane.md)

## Context

Issue #198 made standalone and plugin-contributed capabilities distinguishable. Issue #200 exposed
the next ambiguity: one skill tree can be discovered by more than one host. Counting each host edge
as another copy overstates inventory, while collapsing the edges hides the blast radius of a change.

Host discovery is not uniform:

- [Claude Code](https://code.claude.com/docs/en/slash-commands) loads personal, project, and plugin
  skills, applies scope precedence to same-name standalone skills, and namespaces plugin skills.
- [Codex](https://developers.openai.com/codex/skills/) discovers repository and user
  <code>.agents/skills</code> roots and does not merge equal names.
- [OpenCode](https://opencode.ai/docs/skills) discovers its own roots plus compatible
  <code>.claude/skills</code> and <code>.agents/skills</code> roots. Its Claude-compatible skill
  discovery can be disabled. [OpenCode v2](https://opencode.ai/v2/docs/skills) also documents
  additive local and HTTP sources through a different configuration shape.

The shared Agent Skills file format therefore establishes authoring portability, not discovery,
precedence, enablement, or runtime-use equivalence. MCP is stricter still: each host has its own
registration, scope, transport, authentication, and lifecycle surface.

A second ambiguity concerned freshness. Browser polling had to stay cheap and passive, while an
“Updates ready” claim requires current provider/version evidence. A cached directory name or version
embedded in a cache path is not a provider observation.

## Decision

### Count artifacts once and retain every consumer binding

Catalog v4 separates two identities:

- A **PhysicalArtifact** is one measured filesystem or configuration entry, identified by resource
  kind, locator kind, resolved path, and optional selector. The selector distinguishes several MCP
  or configuration entries held in one physical file.
- A **ConsumerBinding** states that one host discovers that artifact through one surface. It retains
  host, source scope, project scope, discovery mechanism, enablement, and evidence authority.

Logical Catalog items aggregate physical artifacts and bindings for display. Unique counts and
definition relationships count artifacts, not bindings. “Carried by Claude, Codex” is a blast-radius
fact, not evidence that two copies exist.

Disabled bindings remain evidence but do not contribute enabled-host counts, project pressure, or
cross-host remediation. The OpenCode Claude-compatibility switch is applied to the binding, not to
the shared artifact. A session whose working directory is the user home cannot reclassify a user
artifact as project-local.

Relationship findings group one physical artifact pair and the intersection of their active
consumer hosts. They do not multiply one decision into a finding per host.

### Keep discovery evidence-qualified

The stock adapters measure documented default roots plus bounded compatibility surfaces. The
OpenCode adapter understands the installed v1 <code>skills.paths</code> object form. OpenCode v2's
<code>skills</code> array, JSONC-only configuration, and HTTP catalog sources are reported as
partial or unsupported until a versioned adapter can acquire them correctly. A configured path
does not inherit project scope merely from the configuration file that named it.

Filesystem discovery proves presence. It does not prove that a host advertised a skill to a model,
selected it, loaded its body, successfully connected to an MCP server, or used either capability in
a session. Those would require host-native runtime receipts.

### Make scanning explicit and browser refresh passive

Maintenance has two read paths:

- <code>GET /api/maintenance</code> reads the latest private persisted report. It does not call a
  host CLI, provider, registry, network source, or version detector.
- <code>GET /api/maintenance?refresh=scan</code> performs one explicit provider scan, persists the
  resulting report atomically, and returns it. Unknown or duplicate query parameters fail closed.

The dashboard labels these controls **Browser refresh** and **Scan now**. The global poll clock uses
the first path. **Scan now** uses the second. A successful persisted System deep rescan chains one
Maintenance provider scan so inventory and provider evidence converge without double-scanning
concurrent callers.

The saved report includes capture time, provider coverage, completeness, source fingerprint, and
provider evidence fingerprint. Stale or drifted reports lose executable capabilities. A missing,
corrupt, or oversized report yields a scan-required read model rather than silently running a scan.

Provider status, installed version, candidate version, authority, and failure reason participate in
the evidence fingerprint even when the scan produced no findings. “No updates” is meaningful only
for the providers actually measured.

## Consequences

- Catalog can say “one artifact, three consumers” without inventing copies or hiding impact.
- A remediation preview lists exact affected hosts/capabilities/projects and what remains preserved.
- Same-name and same-definition relationships remain decision evidence, not ownership or deletion
  authority.
- Browser polling is predictable and offline; version checks happen only at an explicit scan
  boundary.
- OpenCode v2 configured/remote sources remain visibly incomplete instead of being misparsed as v1.
- Catalog v4 requires FootprintSnapshot v6; older snapshots are rejected rather than replayed under
  the new counting semantics.

## Alternatives considered

- **Count one row per host.** Rejected because one shared directory would look like several copies.
- **Collapse host consumers into the artifact.** Rejected because changes need an exact blast
  radius and host-specific enablement.
- **Treat a shared skill format as shared discovery behavior.** Rejected by the hosts' documented
  locations, precedence, and permission rules.
- **Check versions on every browser poll.** Rejected because an observation-only refresh would gain
  provider/network cost and unstable side effects.
- **Parse every OpenCode configuration dialect heuristically.** Rejected because an invented
  interpretation is worse than explicit partial evidence.

## Review triggers

Review this decision when a host changes documented discovery, precedence, or compatibility rules;
when a versioned OpenCode v2/HTTP catalog adapter lands; when runtime load/use receipts become
available; or before background provider polling is introduced.
