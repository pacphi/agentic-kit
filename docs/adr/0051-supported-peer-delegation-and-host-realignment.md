# ADR-0051 — Supported peer delegation and host realignment

- **Status:** Accepted; implemented locally, release not published
- **Date:** 2026-09-10
- **Deciders:** Project maintainer, through the current design discussion
- **Amends:** [ADR-0033](0033-retire-codex-mcp-and-bound-qe-court-participants.md)
- **Related:** [ADR-0001](0001-one-routing-policy-many-projections.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0037](0037-complexity-program-structural-patterns.md),
  [ADR-0040](0040-codex-hook-audit-and-conservative-remediation.md)

## Context

The maintainer requires ambidextrous hosts, no continued support for retired
transports, and an explicit offer of correction whenever user- or project-scoped
configuration diverges. Repeated setup or upgrades must not silently restore a
degraded state or report success while an anomaly remains.

MCP registration, agent execution, inference-provider selection, and routing
policy are different mechanisms. Removing every registration or provider named
`codex` or `claude` would break valid integrations. Research of installed Ruflo
3.41.1 and Agentic QE 3.14.1 established independent supported CLI execution paths.

## Decision

### Preserve supported delegation at each owning layer

| Layer | Supported mechanism | Owner |
| --- | --- | --- |
| General managed workflows | `ak run` supervises `claude --print` and `codex exec` | agentic-kit |
| Ruflo dual-mode workflows | Ruflo's orchestrator launches Claude/Codex CLI workers | Ruflo |
| QE inference | AQE's `claude-code` and `codex` providers launch the corresponding CLIs | Agentic QE |
| Interactive Claude to Codex | Optional official Codex companion plugin using App Server | User / OpenAI |
| MCP capabilities | Ruflo, AQE, and other tool servers expose their own tools | Respective integration owner |

Either Claude or Codex can initiate work targeting the other through the supported
execution paths. Ambidexterity means usable peer execution; it does not require
identical protocol names, identical capabilities, or a symmetric plugin pair.
OpenCode and admitted external adapters retain their existing capability gates;
this decision does not promote an adapter or grant new execution authority.

AQE's project `llm-config.json`, `agentOverrides`, provider enablement, external
provider declarations, and user fallback choices remain in their existing
ownership domains. Agentic-kit continues projecting only its curated explicit
activity routes. Realignment never rewrites these into another execution system.

### Identify transport anomalies by behavior, not names

- `codex mcp-server` is retired, whether registered in Claude, Codex, or under
  another alias. Do not provision it as a supported path.
- Codex registered inside Codex through that transport is a self-registration
  hazard, not evidence of Claude interoperability.
- `codex@openai-codex` belongs in Claude. An enabled Codex copy is a placement
  anomaly handled by the existing exact plugin-healing workflow.
- `claude mcp serve` is currently supported for exposing Claude Code's tools. It
  is informational, not deprecated, and is not substituted for a Claude agent
  session. Preserve intentionally configured tool servers.
- Modern remote servers named `codex` or `claude`, valid native providers, and
  Ruflo's host-specific `claude-flow` / `ruflo` names are not anomalies by name.

### Inspect, offer, correct, and verify

`ak status` reports relevant user and current-project findings without mutation.
`ak host align` previews the same policy; explicit `--project` locations and
`--all-projects` extend inspection to the bounded census and existing projects
declared in Claude configuration, preserving distinct worktree locations.
Additional locations can be selected explicitly. The all-projects scope also examines the home directory's
`.mcp.json` as a project-location file, not as a global Claude registration.

`--apply` offers exact file/scope/name corrections. A newly accepted correction
may be remembered for that same recipe and location; historical approval grants
no new ongoing authority. A new name, scope, custom environment, command shape,
or ambiguous file requires review. Approval does not convert arbitrary external
configuration into agentic-kit-owned data.

Every write requires a fresh matching source snapshot, regular bounded files,
a current-state recovery copy, and post-write verification. Unrelated settings,
servers, projects, provider routing, and plugin installations are preserved.
Malformed/ambiguous configuration is unassessed, never silently called aligned.
Partial failure reports completed changes and recovery copies without claiming
success. Existing exact plugin healing remains the correction path for a
misplaced companion; no new broad plugin mutation is introduced.

Setup/sync offer alignment and reject unresolved in-scope anomalies. `ak run`
refuses to launch an affected host while its selected scope contains a blocking
transport anomaly. The guard includes configured escalation hosts.

## Grounding and rationale

1. OpenAI explicitly marks `codex mcp-server` deprecated and directs Claude users
   to its companion plugin/App Server: [official notice](https://learn.chatgpt.com/docs/mcp-server).
2. `codex exec` is documented for pipeline use and structured events:
   [OpenAI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
3. `claude -p` exposes the agent loop programmatically:
   [Anthropic programmatic usage](https://code.claude.com/docs/en/headless).
4. `claude mcp serve` exposes tools, with confirmation delegated to the client:
   [Anthropic MCP server documentation](https://code.claude.com/docs/en/mcp#use-claude-code-as-an-mcp-server).
5. Ruflo launches each native CLI in `executeHeadless`:
   [dual-mode orchestrator](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/codex/src/dual-mode/orchestrator.ts).
6. AQE independently launches each CLI and strips the relevant API billing keys:
   [Claude provider](https://github.com/proffesor-for-testing/agentic-qe/blob/main/src/shared/llm/providers/claude-code.ts),
   [Codex provider](https://github.com/proffesor-for-testing/agentic-qe/blob/main/src/shared/llm/providers/codex.ts).

The installed AQE resolver selected Codex for test architecture/security scanning
and Claude Code for code/security review under this workstation's existing
overrides. That proves route resolution, not authentication or model availability.
Those routes must resolve identically before and after MCP realignment.

Ruflo also ships a separate optional HTTP MCP bridge with a legacy Codex backend.
Its configuration is not the native dual-mode orchestrator or AQE provider route.
Do not silently patch installed upstream code or assume that bridge is running.
An active use of that backend requires an upstream migration, not removal of
working native providers. Environment flags alone do not prove runtime health.

## Consequences and limits

The managed surface rejects retired transports without maintaining a legacy
execution fallback. Detection and migration remain necessary to remove residue.
Supported upstream execution paths coexist rather than being replaced by a
single new router. Host login, provider billing, model access, sandbox settings,
and runtime health remain separate facts.

This policy governs agentic-kit's workflows and explicit alignment actions. It
cannot prevent another application editing configuration or police every direct
upstream CLI invocation. AQE/Ruflo children may inherit other host configuration;
removing the known legacy transport is not a proof of complete child isolation.

## Acceptance evidence

Required checks: user/local/project coverage; fresh and repeated alignment;
declined and stale approval; custom/modern transport preservation; distinct
worktree scope; no secret payload in public output; unchanged AQE routes; and
zero worker launches when a relevant retired transport is detected.

Implementation: `src/lib/host-alignment.mjs`, `src/commands/x/host-align.mjs`,
status/setup/sync integration, and the pre-execution guard in `src/commands/run.mjs`.
Executable regressions: `tests/kit/host-alignment.test.mjs`.

### Maintenance dashboard amendment — 2026-09-10

The Maintenance inventory exposes a Host alignment view compatible with User,
Project and specific-project filters. A read-only evidence provider projects
opaque placement identities and field-local evidence; raw configuration and paths
remain outside public inventory payloads. Unassessed project files retain their
project identity and cannot abort the entire projection or obtain an Apply action.

The existing one-placement transaction workflow owns preview, explicit approval,
source revalidation, application, verification and receipt recording. The provider
selects one finding ID, even when several findings share a physical file. It never
delegates a row click to the CLI's whole-scope apply. This recipe retains a backup
but does not offer automated dashboard Undo. Dashboard approval does not silently
create the CLI's remembered correction policy.

Regression evidence covers scope filtering, path-free projection, stale action
rejection, selected-only removal, and the real transaction coordinator. Browser
verification exercises the actual markup, filtering client and preview selection
against deterministic evidence fixtures.
