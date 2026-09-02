# Host-neutral hooks audit follow-up — 2026-09-01

## Outcome

The Codex audit is now a host-neutral, read-only assurance capability. The implementation
supports Codex, Claude Code, OpenCode and declarative external host adapters without
pretending those hosts share one hook format or one trust mechanism.

No active hook behavior, trust decision, plugin cache generation or project configuration
was changed. The new remediation output is a proposal only; the CLI has no apply flag.

A live `--host all` run after implementation and adversarial remediation found 37 bounded sources and 100 physical
occurrences: Codex 47, Claude Code 46, OpenCode 7 and no configured external adapter
hooks. It reported zero invalid sources, zero discovery configuration errors and zero
automatic actions. The proposal set contains 34 approval-required, two prohibited and two
upstream-required actions for generated Claude plugin occurrences.
These numbers describe the current command scope, not the
earlier all-sibling Codex census in the companion audit.

## Normalized coverage

| Provider | Sources | What is normalized | Honest limit |
|---|---|---|---|
| Codex | global/project JSON and inline TOML; enabled plugin files and inline manifests | command and MCP-tool handlers, event/matcher, seconds, cwd, async/context/presentation fields | trust hashes, project trust and undiscovered managed/session paths remain unknown |
| Claude Code | user/project/local/managed settings; installed plugin registry, manifest and hook documents | handler types, event/matcher, type-specific timeout defaults, SessionEnd budget semantics, command identity and source ownership | effective organization policy and runtime selection are not inferred |
| OpenCode | global/project plugin configuration and local plugin modules | package/module identity, digest and statically visible lifecycle event names | JSONC and module behavior stay opaque; modules are never imported |
| External adapters | local manifest lifecycle, execution and AQE provider hooks | validated argv, timeout, declared files and combined content identity | remote sources are offline; compatibility, consent, grants and reachability stay separate |

Every provider emits `partial` coverage with concrete gaps where the local files cannot
prove effective runtime state. That is deliberate: a static audit must not turn absence of
evidence into a false green check.

## Root causes generalized from the Codex findings

1. **Host schemas differ.** Codex and Claude both use seconds, but event defaults, limits,
   handlers and trust differ. OpenCode's extension point is executable plugin code.
2. **Generated copies obscure ownership.** Project projections and plugin caches are
   runtime copies; repair belongs in the proven generator or upstream package.
3. **Configuration composes.** A higher-precedence host setting does not always replace a
   lower hook layer, and OpenCode JSONC can load after JSON.
4. **Registration is not effectiveness.** Installed/configured, selected, trusted,
   reachable, healthy and authorized are independent facts.
5. **Version drift is recurring work.** A schema verified against one release cannot be
   assumed for the next release.

## Remediation policy

- Safe discovery, hashing, normalization and informational diagnostics are automatic.
- User/project behavior changes require approval.
- Generated dependency fixes are upstream-required and applied only to authoritative
  sources.
- Cache edits, trust bypasses, unknown schemas, unsafe files and unproven ownership are
  prohibited.
- The current implementation performs none of the proposed writes.

## Release and dependency maintenance

The version profile is exact and evidence-bearing. On a Claude, Codex or OpenCode release,
CI fixtures run first; unknown releases fall back to syntax-only validation until source
or current primary documentation proves the new contract.

Managed dependencies use `config/agentic-dependency-constraints.json`. Each entry keeps
issue state separate from installed lifecycle state and records a bounded workaround plus
objective sunset proof. The registry is rechecked weekly, before an upgrade and when a new
dependency release is observed. Upstream notification should include the smallest
reproducible source, host/dependency versions, expected/observed behavior and the local
workaround. Patches are kept narrow and removable; issue closure is followed by
released-artifact conformance before the workaround is retired.

The Claude provider is grounded in the current primary [hooks reference](https://code.claude.com/docs/en/hooks)
and [plugin reference](https://code.claude.com/docs/en/plugins-reference). In particular,
the plugin manifest is optional, default hook discovery uses `hooks/hooks.json`, the
`SessionEnd` default is 1.5 seconds, the settings-derived budget is capped at 60 seconds,
and a plugin-provided timeout cannot raise that budget.

## Post-implementation brutal-honesty review

The review crossed its action threshold and found four substantive defects before commit:

1. **HIGH — file identity race:** containment was checked before `open`, but the opened
   inode was not compared with the inspected inode. The bounded reader now verifies
   device/inode identity and repeats real-path containment after opening; a replacement
   race fixture proves refusal.
2. **HIGH — incomplete Claude provenance:** valid plugin registries and manifests were
   used for discovery but omitted from the public source chain, and a manifest-free
   plugin could be missed. Both sources are now reported and conventional optional-manifest
   discovery is tested.
3. **HIGH — incorrect Claude `SessionEnd` model:** the first implementation applied the
   generic 600-second command timeout. It now models the documented 1.5-second default,
   60-second settings cap and plugin-budget dependence separately.
4. **MEDIUM — provider coupling:** a Codex-only audit probed every host binary and loaded
   agentic-kit's adapter config. Version probes and config loading are now limited to the
   selected providers, preserving Codex-only audit independence.

Agentic-QE's local coverage analysis and security scan were run after implementation. Its
security scanner reported three lexical false positives (`RegExp.exec` and two relative
imports); manual inspection rejected them. The scanner's coverage result explicitly said
it was a low-confidence static estimate, so the decision used Node's measured coverage:
hook-audit source files are 83.64–100% line-covered in the focused suite, with the core
Codex parser, TOML parser and bounded reader at 96.79–100%. QE test generation and defect
prediction were not retried after the execution policy rejected transmitting nonpublic
source/history to a service boundary.

## Verification added

Adversarial fixtures cover:

- exact-version fallback;
- Codex inline TOML and MCP handlers;
- inline plugin hook manifests;
- symlinked manifest and hook-source refusal;
- credential redaction;
- cwd-sensitive behavior identity;
- Claude timeout-unit diagnostics;
- Claude optional-manifest plugin discovery and complete registry/manifest provenance;
- Claude `SessionEnd` settings clamping versus plugin budget dependence;
- OpenCode opaque full-process plugins;
- external manifest validation and hook-file identity;
- deterministic read-only output across repeated runs.
- source replacement between inspection and open;
- provider-scoped version probes and adapter-config loading.

See [ADR-0041](../adr/0041-host-neutral-hook-configuration-assurance.md) and the
[DDD boundary](../ddd/hook-configuration-assurance.md) for the permanent contracts. A
sanitized [machine-readable audit receipt](host-neutral-hooks-report-2026-09-01.json)
records the post-implementation run; the CLI emits the complete reusable inventory.
