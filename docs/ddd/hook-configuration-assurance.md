# Hook configuration assurance bounded context

## Purpose

Answer four questions without running hook code or changing trust, then permit a
separate, explicit write model to apply only independently proven recipes:

1. Which lifecycle behaviors can each host discover?
2. Which exact source and owner produced every occurrence?
3. Which compatibility, security, ownership and duplication findings are proven?
4. Which remediation authority class applies, if any?

## Boundary

Hook configuration assurance consumes host identity, project scope and validated external
adapter manifests. It owns no host installation, route, model, session, plugin execution,
consent, capability grant or trust decision.

```text
Project Census ────────┐
Integration Management ├──> Hook Configuration Assurance ──> audit / healing plan
Host binaries + files ─┘                 │
                                        └──> Hook Remediation transaction port
                                             (no execution or trust mutation)
```

## Aggregate and value objects

`HookAudit` is the aggregate root for one deterministic run. Its identity is the selected
host set plus source digests and exact version facts.

- `HookSource`: path/reference, scope, digest, authority, owner, generation posture and
  read status.
- `HookOccurrence`: one event/matcher/handler at one source pointer.
- `HookBehavior`: material execution identity shared only by genuinely equivalent
  occurrences.
- `SchemaProfile`: exact host version, supported shape, units, defaults, limits, evidence
  and verification date.
- `CoverageStatement`: complete/partial/unsupported plus concrete gaps.
- `Diagnostic`: category, severity, stable code, evidence and message.
- `RemediationProposal`: target, expected source digest, authority class, rationale,
  behavior impact and trust impact.
- `UpstreamConstraint`: dependency range, issue state, local strategy and sunset proof.

`HookHealingPlan` is the immutable write-model input. Its digest binds the audit identity,
exact runtime facts, public action content and classification. A provider compiler may
produce candidate bytes in memory, but planning never creates transaction state.

- `HookHealingAction`: exact action ID, provider recipe, canonical target/owner,
  preimage/postimage, mode, impact, activation, verification and rollback.
- `HookTransaction`: private backup-first journal for one explicitly selected plan.
- `HookReceipt`: integrity-sealed record of action state, exact digests, backup references,
  mode, verification and guarded undo.

## Provider contract

Each built-in provider performs this lifecycle:

```text
detect version facts -> discover bounded sources -> validate without execution
-> normalize occurrences -> classify diagnostics -> propose authority -> summarize gaps
```

Providers may reduce capability when evidence is incomplete; they may never fabricate a
selected state or widen authority. External providers are data from admitted-format
manifests, not imported implementation modules.

## Invariants

1. Discovery never executes a hook, imports a plugin or invokes a host debug/effective
   config command.
2. Files are bounded regular files contained by a proven root; symlinks and special files
   are refused, and the opened inode/path must still match the inspected source.
3. Public command text is redacted while behavior identity retains a one-way digest.
4. Every physical occurrence survives deduplication.
5. Working directory, async mode, platform command, MCP contract and timeout are material.
6. Unknown versions cannot produce an automatic compatibility repair.
7. Compatibility, trust, security, provenance, ownership and performance are independent
   diagnostic dimensions.
8. Plugin caches and generated projections are never direct healing targets.
9. Audit results never confer trust, consent, grants, reachability or health.
10. Mutation exists only through the ADR-0042 transaction port; provider discovery cannot
    invoke it or grant itself authority.
11. Every selected preimage is checked before transaction creation; every backup exists
    and verifies before the first target write.
12. Undo restores only while current bytes equal the recorded postimage, preserving later
    user or generator drift.

## Host anti-corruption layers

### Codex

Translates `hooks.json`, documented inline TOML and enabled plugin manifests. It preserves
Codex's merge semantics, seconds-based timeout rules, MCP-tool handlers and independent
definition trust.

### Claude Code

Translates user/project/managed settings and installed plugin registry, manifest and hook
documents. It honors optional manifests, conventional `hooks/hooks.json`,
`CLAUDE_CONFIG_DIR`, type-specific timeout defaults and `SessionEnd` budget rules; runtime
policy and organization state remain explicit gaps.

### OpenCode

Translates configured package plugins and local plugin modules. A plugin runs inside the
host process, so the normalized record describes the whole module as a trust unit. Static
event-name evidence is not a behavioral proof.

### External adapters

Translates validated manifest lifecycle, execution and Agentic-QE provider subprocess
hooks. Content identity includes declared hook files. Admission, consent and grants stay
owned by Integration Management.

## Remediation process

ADR-0042 implements `plan -> apply -> verify -> undo` through a separate mutation port
with exact preimages, verified backups, durable receipts, atomic replacement, repeated
audits and guarded rollback. The domain rejects trust bypasses, cache writes, generated
copies, project targets, unknown schemas and unproven ownership before the port is
reached. The first executable recipe is limited to Codex `0.151.0` direct global JSON
`SessionEnd` timeout normalization; all other current provider proposals remain read-only.
