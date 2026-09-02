# Hook configuration assurance bounded context

## Purpose

Answer five questions without running hook code or changing trust:

1. Which lifecycle behaviors can each host discover?
2. Which exact source and owner produced every occurrence?
3. Which compatibility, security, ownership and duplication findings are proven?
4. Which remediation authority class applies, if any?
5. Can an explicitly selected, exact-profile repair be applied and reversed safely?

## Boundary

Hook configuration assurance consumes host identity, project scope and validated external
adapter manifests. It owns no host installation, route, model, session, plugin execution,
consent, capability grant or trust decision.

```text
Project Census ────────┐
Integration Management ├──> Hook Configuration Assurance ──> audit / deterministic plan
Host binaries + files ─┘                 │                         │
                                        │                         └──> explicit mutation port
                                        └──> no hook execution, trust, consent, or grants
```

## Aggregate and value objects

`HookAudit` is the aggregate root for one deterministic run. Its identity is the selected
host set plus source digests and exact version facts.

- `HookSource`: path/reference, scope, digest, authority, owner, generation posture and
  read status.
- `HookOccurrence`: one event/matcher/handler at one source pointer.
- `HookBehavior`: material execution identity shared only by genuinely equivalent
  occurrences.
- `HookSourceReference`: opaque, short-lived Dashboard Delivery reference to one audited
  physical locator; it is neither a filesystem path nor an authorization token.
- `SchemaProfile`: exact host version, supported shape, units, defaults, limits, evidence
  and verification date.
- `CoverageStatement`: complete/partial/unsupported plus concrete gaps.
- `Diagnostic`: category, severity, stable code, evidence and message.
- `RemediationProposal`: target, expected source digest, authority class, rationale,
  behavior impact and trust impact.
- `HealingPlan`: exact audit identity, runtime profiles, selected source preimages,
  candidate postimages and stable action identities.
- `HealingTransaction`: private backups, explicit authorization, action journal,
  verification evidence and guarded rollback state.
- `UpstreamConstraint`: dependency range, issue state, local strategy and sunset proof.

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
10. Only exact action IDs bound to an exact plan digest can reach the mutation port.
11. Every selected target passes a complete preflight and live re-audit before the first
    backup or target write.
12. Mutation cannot change trust, consent, grants, generated copies, caches, opaque
    modules, JSONC, unsupported schemas or Windows targets.
13. Receipt digests prove internal consistency, not authenticity against the same user.
14. A dashboard action requires an exact executable healing action or a separately
    verified published upstream URL; an authority class or review proposal alone is not
    actionability.
15. Source navigation resolves only a cached audited locator, rechecks containment and
    digest, masks selected content server-side, and grants no edit or healing authority.

## Dashboard read model

The browser projection separates four evidence classes:

- configured entries, distinct behaviors, repeated placements and source readability;
- host-neutral definition groups with their physical placements and ownership evidence;
- plain-language findings joined back to affected occurrences;
- typed runtime receipts, or explicit `not-recorded` state.

Repeated informational trust diagnostics collapse into one evidence-limit statement. A source
reference is safe to show in the summary because it is HMAC-derived and expires with the in-memory
audit cache. Resolving it is a separate authenticated read: the source is reopened through the
bounded-file port, its digest must still match, and only a masked selected JSON definition is
returned. Opaque formats are location-only. The client cannot supply a path or launch an editor.

The read model keeps source navigation independent from remediation. It may describe why a finding
is non-automatic, but it shows a next step only when the plan proves an executable occurrence-bound
action or an independently verified published upstream issue.

## Host anti-corruption layers

### Codex

Translates `hooks.json`, documented inline TOML and enabled plugin manifests. It preserves
Codex's merge semantics, seconds-based timeout rules, MCP-tool handlers and independent
definition trust. It also emits an exact-identity placement finding when the
`codex@openai-codex` Claude companion is enabled inside Codex; no manifest-directory
heuristic is used.

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

`ak heal hooks` implements `audit -> plan -> authorize -> preflight -> backup -> apply ->
verify -> commit`, with dry-run as the default. Undo and interrupted recovery are separate
explicit flows. The mutation port requires exact preimages, private backups, strict
file/directory durability, atomic same-directory replacement, per-action journal updates,
guarded rollback, an exact-profile second audit and a byte/mode/mtime no-op proof. The
domain rejects trust bypasses and cache writes before the port is reached.

The only plugin-table recipe targets that exact placement finding in user-owned
`config.toml`, with its policy pinned to the inspected OpenAI 1.0.6 release revision. It
requires conservative whole-document TOML validation, then byte-splices one unambiguous
live `enabled = true` scalar to `false`. It preserves the installation, cache, Claude Code
configuration, sibling TOML bytes, and trust state. Read-only discovery can safely follow
a bounded config symlink; the mutation port cannot. The ordinary setup/sync lifecycle
never enters this port.

Transactions use `prepared`, `applying`, `verifying`, `committed`, `undoing`,
`rolled-back`, and explicit failure/recovery states. A new apply refuses while an
unfinished transaction exists. Recovery never guesses: each target must equal its
recorded preimage or postimage, and every backup must match the receipt.
