# Codex Hooks Audit — 2026-09-01

Review mode: discovery, provenance analysis, isolated safe benchmarks, and additive
doctor implementation

Scope: Codex global configuration, enabled plugins and cache generations, this
repository, sibling repositories found by bounded development-root and shared project
census discovery, upstream/local generators, and agentic-kit setup/sync/status code

Companion artifacts:

- [machine-readable inventory](codex-hooks-inventory-2026-09-01.json)
- [remediation plan](codex-hooks-remediation-2026-09-01.md)
- [ADR-0040 proposal](../adr/0040-codex-hook-audit-and-conservative-remediation.md)

## Executive summary

The Hooks UI is reporting two independent facts, and they must stay independent:

1. `SessionEnd` timeout clamping is a schema/runtime compatibility warning. Codex
   interprets `timeout` as seconds and permits at most three seconds for `SessionEnd`.
2. “Needs review” is an exact-definition trust decision. Project trust enables the
   project `.codex` layer, while each current non-managed hook definition is separately
   reviewed by hash. Changing a timeout can cause a new review prompt, but accepting a
   hook does not make its timeout valid and changing the timeout does not grant trust.

The timeout problem is systemic. Nine project files carry a Claude-oriented Ruflo hook
projection whose millisecond-style values became seconds in Codex. Their `SessionEnd`
value is `10000`, so Codex clamps it to three seconds. The enabled OpenAI Codex Companion
plugin 1.0.6 declares five seconds and is also clamped. Other project values such as
`5000`, `8000`, and `15000` are not clamped because they are on other events, but Codex
still interprets them as 83–250 minute timeouts. This is a host-schema translation defect,
not a slow-hook diagnosis.

The repeated project files are generated/ignored artifacts with unresolved writer
provenance. Eight full files are byte-identical; Ampel contains a subset. Their content
traces to Ruflo's Claude settings generator, while the installed Codex bridge delegates
Codex lifecycle ownership to the `ruflo-core@ruflo` plugin to avoid double firing.
Therefore the local projections are stale relative to current ownership, but removing
them still changes runtime behavior and is not safe to automate.

The highest-risk finding is not the timeout warning. RuvNet Brain's selected 4.2.2-dev
manifest invokes the machine's active 4.0.1 adapter. That runtime does not implement
the manifest's `decision-gate` or `session-snapshot` actions; both exit zero silently.
The decision gate must be treated as **HIGH / DO NOT TRUST as a security control** until
the active runtime and manifest are compatibility-checked and aligned. The plugin as a
whole remains **HUMAN REVIEW REQUIRED**.

No active hook, trust hash, project trust setting, plugin cache file, or source generator
was changed in this audit. The conservative implementation adds `ak audit hooks`, a
read-only occurrence-level inventory and remediation planner. On this machine it reports
161 selected hook occurrences, 45 behavior fingerprints, 10 current timeout warnings,
zero invalid sources, zero hook-discovery configuration issues, and zero automatic
remediations.

## Evidence and limits

Labels used below:

- **M — measured:** observed from local files, binaries, hashes, isolated execution, or
  command output.
- **D — documented:** supported by current primary documentation/source.
- **I — inferred:** a causal conclusion from measured/documented evidence whose remaining
  uncertainty is stated.

The audit did not read credential values. It inspected commands before execution. Hooks
that could kill processes, delete broker state, run a package-manager fallback, invoke a
model, use network credentials, spawn detached work, or mutate user learning/memory were
not benchmarked. The representative project hooks were copied into fresh temporary
fixtures with relevant state; the real repository was not used as their write target.

One optional direct frozen-body RuvNet Brain benchmark updated its warning-rate marker at
`~/.cache/ruvnet-brain/.spine-fallback-notice`. It did not change a repository, Codex
configuration, trust state, plugin cache, or active runtime. Because the prior marker
bytes were not recoverable, the audit did not attempt a blind reversal. Its timing is not
used as evidence for current runtime behavior.

Claude Code was not signed in during the dual-host architecture gate. The implementation
and ADR therefore remain Codex-reviewed and the ADR status is **Proposed**, not accepted.

## Runtime and version map

| Component | Observed version/state | Evidence |
|---|---|---|
| Codex Desktop | 26.831.20005, build 7524 | M: application `Info.plist` |
| Desktop-bundled Codex CLI | 0.152.0 | M: direct bundled executable |
| `PATH` Codex CLI | 0.151.0 | M: mise/npm executable |
| agentic-kit | 4.0.0-alpha.44 | M: `package.json` |
| Ruflo | 3.38.20 | M: installed package |
| Agentic-QE | 3.14.0 | M: installed package |
| RuvNet Brain plugin cache | 4.2.2-dev | M: enabled plugin generation |
| RuvNet Brain active code root | 4.0.1 | M: `~/.cache/ruvnet-brain/active.json` |
| OpenAI Codex Companion plugin | 1.0.6 | M: enabled cache generation |
| Ruflo Core plugin | 0.2.6 | M: enabled cache generation |
| Beads plugin | 1.2.2 | M: enabled cache generation |

The two Codex CLI versions matter for reproducibility: Desktop runs its bundled 0.152.0
binary, while a shell normally resolves 0.151.0 first. Both local implementation evidence
and current docs agree on the `SessionEnd` cap.

## Codex timeout and trust rules

Codex's current official documentation states that hook timeouts are seconds and that
`SessionEnd` defaults to one second with a maximum of three seconds. The current source
defines the same constants and clamps larger values during discovery:

- [Codex Hooks documentation](https://developers.openai.com/codex/hooks)
- [Codex `SessionEnd` implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/session_end.rs)

The same documentation states that matching hooks merge and run rather than overriding
one another. New or modified non-managed definitions are skipped until reviewed. Local
source inspection confirms current-hash comparison against `trusted_hash` is separate
from project `trust_level`.

No trust-bypass flag was used. This report does not recommend one.

## Inventory summary

The bounded full audit selected 14 runtime source files:

- 10 project `.codex/hooks.json` files;
- four manifest-selected enabled plugin hook files;
- no direct executable global `~/.codex/hooks.json`.

Those sources contain 161 physical hook occurrences and 45 behavior fingerprints.
Occurrence rows are retained in the command output so provenance is never lost when
behaviors are deduplicated.

### Project hooks

Eight full Ruflo projections are byte-identical (SHA-256
`53398d1ac227a34cf3e9ee466f327cfbacf9464bfec55b4f3588b4a644576d3`):

- agentic-kit
- java-spring-modernization-marketplace
- finima
- keel
- prompt-genie
- reelbox-cli
- tub-vault
- site

Ampel contains seven entries from the same projection. Emailibrium contains four Beads
lifecycle hooks that are behavior-identical to the enabled Beads plugin. The earlier UI
reported `scripts`, but no current project hook file was found for it in the bounded roots;
that diagnostic is likely stale or points outside current discovery.

The full Ruflo projection contains 15 occurrences:

| Event / matcher | Implementation | Declared timeout | Current behavior |
|---|---|---:|---|
| PreToolUse / Bash | `hook-handler.cjs pre-bash` | 5000 | implemented weak denylist; wrong Codex blocking contract |
| PreToolUse / Write/Edit/MultiEdit | `hook-handler.cjs pre-edit` | 5000 | unknown-success no-op |
| PostToolUse / Write/Edit/MultiEdit | `hook-handler.cjs post-edit` | 10000 | records edit/intelligence state |
| PostToolUse / Bash | `hook-handler.cjs post-bash` | 5000 | unknown-success no-op |
| PreCompact / manual | `compact-manual` | default | unknown-success no-op |
| PreCompact / manual | `session-end` | 5000 | state consolidation/end |
| PreCompact / auto | `compact-auto` | default | unknown-success no-op |
| PreCompact / auto | `session-end` | 6000 | state consolidation/end |
| SessionStart | `session-restore` | 15000 | restore/start, state writes, detached refresh possibilities |
| SessionStart | `auto-memory import` | 8000 | dynamic sidecar import |
| SessionEnd | `session-end` | 10000 | clamped to 3 |
| UserPromptSubmit | `route` | 10000 | local routing/advisory output |
| SubagentStart | `status` | 3000 | unknown-success no-op |
| SubagentStop | `post-task` | 5000 | records outcome |
| Stop | `auto-memory sync` | 10000 | project/user auto-memory write |

Every command is a `sh -c` wrapper that tries
`${CLAUDE_PROJECT_DIR}/.claude/helpers/...` and falls back to
`${HOME}/.claude/helpers/...`. `CLAUDE_PROJECT_DIR` is not a documented Codex project-hook
environment contract. The fallback can cross the repository boundary, and launching in a
subdirectory can select a different helper or fail to find the intended one.

### Enabled plugin hooks

| Plugin | Selected occurrences | Canonical source | Cache posture |
|---|---:|---|---|
| RuvNet Brain 4.2.2-dev | 16 | `stuinfla/ruvnet-brain` marketplace/local installer | read-only runtime copy |
| Ruflo Core 0.2.6 | 7 | `ruvnet/ruflo` marketplace | read-only runtime copy |
| Beads 1.2.2 | 4 | `steveyegge/beads` marketplace | read-only runtime copy |
| OpenAI Codex 1.0.6 | 3 | `openai/codex-plugin-cc` marketplace | read-only runtime copy |

Non-selected cache files were recorded as provenance but not counted as active. In
particular, RuvNet Brain's Claude-oriented `hooks/hooks.json` is shadowed by the explicit
`hooks/codex-hooks.json` manifest declaration. Its larger SessionEnd values are therefore
not current clamp warnings. Disabled n8n/security-guidance hook files and Superpowers'
shadowed conventional file are also not active sources.

## Source-to-runtime ownership maps

### Historic project projection

```text
Ruflo Claude settings generator
  -> unknown historic copier/projection step
    -> <project>/.codex/hooks.json (ignored, generated-origin-unknown)
      -> <project>/.claude/helpers/* or ~/.claude/helpers/*
        -> Codex runtime / Hooks UI
```

The commands and numeric timeout values trace exactly to Ruflo's Claude settings
generator. The inspected Ruflo code does not prove which historical process copied them
into Codex files, so the project artifacts remain `authority: unknown`.

### Current Ruflo ownership

```text
ruvnet/ruflo marketplace source
  -> Codex installed cache ruflo-core/0.2.6
    -> plugin hooks/hooks.json
      -> ruflo-hook.cjs
        -> local Ruflo CLI, else npx ruflo@latest fallback
          -> Codex runtime / Hooks UI
```

The installed Codex bridge explicitly delegates lifecycle ownership to the upstream
plugin to avoid double firing. This makes the project projections stale, but
not safe to delete without a reviewed diff and backup.

### Agentic-QE installation

```text
agentic-qe/.codex/hooks.json + .codex/hooks/*
  -> CodexInstaller.installCodexHooks()
    -> merge into <project>/.codex/hooks.json
    -> copy <project>/.codex/hooks/*
      -> Codex runtime / Hooks UI
```

Agentic-kit invokes `aqe init --auto --with-codex`. Agentic-QE's installer is an
authoritative generator for its owned groups, but the current project file does not match
that packaged template. The installer writes the merged target without a backup,
transaction receipt, rollback, or post-write schema proof—an architectural gap addressed
by the remediation proposal.

### Plugin source chains

```text
openai/codex-plugin-cc checkout -> cache 1.0.6 -> hooks/hooks.json
ruvnet/ruflo checkout           -> cache 0.2.6 -> hooks/hooks.json
steveyegge/beads checkout       -> cache 1.2.2 -> .codex-plugin/hooks/hooks.json
stuinfla/ruvnet-brain checkout  -> managed marketplace -> cache 4.2.2-dev
```

Source and cache hashes matched in the inspected chains. That proves the cache is a
faithful installed payload; it does not make the cache authoritative or writable.

## Root causes

### RC1 — Claude-to-Codex timeout-unit translation defect

Claude-oriented generator values in the thousands were copied into a Codex schema whose
unit is seconds. Only `SessionEnd` has the explicit three-second cap and warning, so the UI
exposes one symptom while much larger effective budgets remain on other events.

### RC2 — Hook ownership migrated without removing old project projections

Current Ruflo Codex ownership lives in the `ruflo-core` plugin, but generated project
copies remain. Codex merges matching sources, so this is process duplication rather than
configuration override.

### RC3 — Generated files lack receipts and canonical provenance

Project `.codex/hooks.json` files are ignored/untracked. The current Agentic-QE installer
merges generated groups directly and does not emit backup/ownership receipts. Once two
generators have touched the same file, safe healing cannot distinguish user intent from
generated residue using content alone.

### RC4 — Manifest/runtime compatibility is not validated

RuvNet Brain loads a 4.2.2-dev hook manifest through an active 4.0.1 runtime. Unknown
action IDs return success, and the adapter forwards stderr only on nonzero status. The
result is silent control loss.

### RC5 — Lifecycle hooks are treated as both enforcement and telemetry

The project `pre-bash` hook looks like a safety gate, but it exits 1 on rejection while
Codex's blocking contract uses a structured deny result or exit 2 with a reason. Ruflo's
plugin shim always exits zero and suppresses errors. These may provide telemetry, but
must not be described or trusted as a fail-closed security wall.

## Security and trust review

| Behavior | Risk | Recommendation | Reason |
|---|---|---|---|
| Project shell bootstrap | MEDIUM | TRUST AFTER CHANGE | dynamic shell, undocumented project env, `$HOME` fallback |
| Project `pre-bash` as enforcement | HIGH | DO NOT TRUST | weak substring list and wrong Codex rejection contract |
| Project no-op handlers | LOW | TRUST AFTER CHANGE | pure process cost and misleading success |
| Project post-edit/session lifecycle | MEDIUM | TRUST AFTER CHANGE | project learning/state mutation; dedupe/root fix first |
| Project auto-memory import/sync | HIGH | HUMAN REVIEW REQUIRED | absolute dynamic import; project/user writes; inherited authority |
| Ruflo Core plugin shim | HIGH | HUMAN REVIEW REQUIRED | child CLI; unpinned `npx ... ruflo@latest` fallback; errors hidden |
| Brain `decision-gate` | HIGH | DO NOT TRUST | silently missing from active 4.0.1 runtime |
| Brain snapshot body | LOW | TRUST AFTER CHANGE | append-only minimal receipt, but currently unreachable |
| Brain learning/update/signal hooks | HIGH | HUMAN REVIEW REQUIRED | detached work, cache/learning writes, possible network/credentials |
| OpenAI Companion SessionEnd | HIGH | HUMAN REVIEW REQUIRED | broker IPC, process-tree kill, state/path deletion |
| OpenAI Companion Stop review | HIGH | HUMAN REVIEW REQUIRED | nested model task, inherited credentials, may block for 15 minutes |
| Beads lifecycle | MEDIUM | HUMAN REVIEW REQUIRED | external command; duplicated in Emailibrium |

Trust recommendations are review outcomes, not authorization for agentic-kit to modify
Codex trust state.

## Benchmark results

Ten samples were used for each representative candidate. With fewer than 20 samples the
table reports max rather than presenting a low-sample max as a stable p95.

| Candidate | Min ms | Median ms | Max ms | Exit/signal | Bounded output |
|---|---:|---:|---:|---|---|
| project `session-end` | 62.776 | 64.797 | 68.078 | 10×0 / none | consolidation summary + session ended |
| project `pre-bash` | 20.504 | 21.308 | 22.714 | 10×0 / none | command validated |
| project `pre-edit` no-op | 20.441 | 20.918 | 21.686 | 10×0 / none | unknown-hook success |
| project `post-bash` no-op | 20.777 | 21.469 | 22.534 | 10×0 / none | unknown-hook success |
| project `post-edit` | 20.779 | 22.390 | 26.743 | 10×0 / none | edit recorded |
| current Brain wrapper `session-snapshot` | 59.857 | 62.475 | 66.515 | 10×0 / none | empty; no receipt |

The representative project-only Bash pre/post pair costs about 42.8 ms median, while the
post hook is a no-op. The edit pair costs about 43.3 ms median, while the pre hook is a
no-op. Across selected project/plugin definitions, one Bash event can launch eight hook
processes and one edit can launch seven, subject to each exact definition's trust state.

The Brain wrapper result is functional evidence of version skew: all runs reported
success, no output, and no snapshot receipt.

Not benchmarked after inspection:

- OpenAI Companion SessionEnd/Stop review: process kill/deletion/model behavior;
- Ruflo Core fallback: possible package/network execution;
- Brain update, signal-watch, learn-flush: network, credentials, detached work, or global
  learning/cache writes;
- project auto-memory and SessionStart: user/project writes and detached refreshes.

## Architecture overhead assessment

The project PreToolUse/PostToolUse layer is presently the worst cost/clarity trade:

- `pre-edit` and `post-bash` consume a Node process but implement no behavior;
- `pre-bash` is not a valid Codex enforcement gate;
- post-edit and session persistence overlap with Ruflo Core;
- Emailibrium duplicates Beads exactly;
- only post-edit/session-end have a temp-file dedupe path, and that does not avoid process
  startup;
- plugin sources merge, so a second source is additive overhead, not a replacement.

The target architecture should assign one canonical owner per behavior and treat other
sources as provenance-bearing duplicates. Deduplication must never discard occurrences;
it should make their relationships and costs visible.

## Remediation decision

The current estate has **no automatic mutation that satisfies the safety rules**.

- Plugin cache fixes are never automatic; repair upstream/source and reinstall.
- Project projections have unresolved authoritative writers and behavior changes; retire
  only with explicit per-action approval, backup, diff, and verification.
- Brain manifest/runtime alignment belongs in the Brain installer/activation source, not
  this repository or cache.
- Trust remains manual in Codex.

The safe change implemented here is additive and read-only:

```text
ak audit hooks
ak audit hooks --all-projects
ak audit hooks --all-projects --json
```

It discovers only direct global, current project(s), and selected enabled plugin hook
definitions; rejects unsafe plugin references and canonical cache escapes; refuses
symlink, broken-symlink, and special-file sources; validates nested group, matcher, hook,
and timeout syntax; records source digests and JSON pointers; preserves material command
whitespace in behavior fingerprints; reports schema compatibility independently of
trust; and classifies every current timeout action as approval-required or
never-automatic. Unknown or future Codex versions receive syntax-only findings and no
timeout remediation plan.

It does not run hook commands, write reports implicitly, alter trust, edit generated
projects, or touch plugin cache files. Running it a second time is therefore a no-op by
construction; verification below confirms target hook hashes/mtimes were unchanged.

## Implemented-wave verification

Fresh verification after the additive implementation:

| Gate | Result |
|---|---|
| Focused hook-audit and plugin-boundary tests | 25 passed, 0 failed |
| Measured hook-audit module coverage | 92.94% lines, 76.30% branches, 100% functions |
| Full repository `npm test` | exit 0 outside the filesystem/network sandbox |
| TypeScript check | exit 0 |
| ESLint | 0 errors; 34 pre-existing complexity/size warnings across the repository |
| Build/package check | exit 0; syntax checked 254 shipped files; 287 package files resolved |
| New/updated Markdown files | 0 issues |
| Inventory JSON parse | valid |
| Agentic-QE targeted SAST before the final fail-closed boundary patches | 0 vulnerabilities at all severities |

Agentic-QE's coverage analyzer also returned a 19.7% static estimate, but its own result
states that no instrumentation ran and confidence was 0.2. That estimate is not treated as
coverage evidence; the measured Node coverage above supersedes it. The targetless generic
AQE quality assessor ran against its server workspace rather than this repository and is
likewise excluded from the artifact gate.

A final Agentic-QE SAST rerun was refused by the environment's source-export guard because
the MCP scan could transmit private repository source. No workaround was attempted. The
final patches are instead covered by focused traversal, canonical-containment, malformed
schema, and broken-symlink regressions plus local lint, the full suite, and independent
read-only code review.

Two consecutive explicit-scope audits returned the same 14 valid sources, zero
hook-discovery configuration issues, 161 occurrences, 45 behaviors, 10 compatibility
warnings, and zero automatic actions. Every source digest and mtime remained unchanged.
The second run is an exact report no-op.

## Verification requirements for future healing

Any later apply wave must implement:

1. version-aware schema proof;
2. proven canonical ownership and exact preimage digest;
3. unique transaction backups preserving bytes and modes;
4. a disclosed per-action diff and behavior impact;
5. refusal of symlinks/special files and cache/trust targets;
6. atomic writes plus post-write schema/behavior verification;
7. rollback only while the current digest still matches the transaction postimage;
8. a complete second audit with no targeted finding;
9. a third run with unchanged bytes and mtimes;
10. no trust-state mutation.

The full contract and provider boundaries are recorded in ADR-0040 and the remediation
plan.
