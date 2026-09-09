# ADR-0023 — Fail-closed mutations and explicit degraded operation evidence

- **Status:** Implemented
- **Updated:** 2026-08-26 — ADR-0035 applies fail-closed preflight, bounded evidence, and
  content-free degradation to the opt-in deja-vu companion
- **Updated:** 2026-09-03 — ADR-0044 implements these fail-closed principles in the Maintenance
  coordinator while explicitly refusing to claim filesystem atomicity for native lifecycle,
  network, package, or process operations
- **Date:** 2026-08-04
- **Previous updates:** 2026-08-24 — issue #170 parser-yield diagnostics distinguish readable Codex
  roots from readable roots whose transcript schema produces no normalized responses; 2026-08-06
- **Update note:** Generalized setup preflight into a required host-adapter trust contract, added
  Codex registration/OpenCode approval disclosure, documented current-UID installation-mode
  boundaries, and surfaced usage-source health in the dashboard UI. Closed a parity gap §7 left
  behind: `sourceHealth` covered only the two secondary/corrective sources (OpenCode's SQLite
  store, Codex's thread ledger) and never the primary Claude/Codex transcript roots, so a missing
  or unreadable `~/.claude/projects` or `~/.codex/sessions` still silently read as zero — the exact
  failure class this ADR exists to close, just left open on the two sources most people depend on.
  Relocated the resulting indicator out of the Usage panel into the dashboard's persistent tabbar
  (right-aligned, visible on every view) and replaced its host text labels with the same branded
  icons the Observability Live view already uses, after the original chip design proved illegible
  and was redesigned through several rounds against live screenshots.
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #111](https://github.com/pacphi/agentic-kit/issues/111),
  [ADR-0008](0008-guidance-target-scope-split.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0012](0012-observability.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0017](0017-opencode-host.md),
  [ADR-0035](0035-managed-deja-vu-companion.md),
  [ADR-0044](0044-receipt-aware-maintenance-control-plane.md), and
  [issue #114](https://github.com/pacphi/agentic-kit/issues/114)

## Context

Independent clean-Mac testing found seven cases where agentic-kit preserved runtime continuity at
the cost of operator truth or least privilege:

1. failed RuvNet Brain and optional AQE solver installs could render as successful;
2. the SQLite helper collapsed absence, locks, corruption, bad SQL, and I/O into one fallback;
3. JSON settings backup failures were ignored before replacement;
4. managed-guidance backup failures were ignored before a non-atomic rewrite;
5. the status-line footer intentionally failed to blank but exposed no opt-in diagnostics;
6. runtime discovery read every user's process list before filtering host controllers; and
7. project setup did not disclose the seven upstream Claude Code auto-approve rules before mutation.

The common defect was not fallback itself. Fallback is often the correct availability policy. The
defect was losing the evidence needed to distinguish healthy, degraded, absent, and failed states,
or mutating user state after a promised safety prerequisite failed.

## Decision

### 1. Managed operations carry explicit outcome status

Managed heals use `ok`, `degraded`, `failed`, or `skipped` status, independently of whether an old
artifact or fallback remains usable. `usable` records that secondary fact. A nonzero Brain installer
exit is failed even when an older KB marker remains; only exit zero records the installed release.
The AQE TypeScript solver fallback is usable but degraded. Setup and sync share one renderer, so a
degraded result is never shown with a green success glyph.

### 2. SQLite failures remain classified through the helper boundary

`withDb` returns a discriminated result instead of a caller-supplied fallback:

```text
{ ok: true, value }
{ ok: false, error: { kind, stage, errcode, code, message } }
```

`kind` is `absent`, `busy`, `corrupt`, `query`, `io`, or `close`; `stage` is `open`, `query`, or
`close`. Compatibility helpers may still return a scalar fallback, but they must do so after the
failure has been classified. OpenCode usage preserves current-window last-good records on transient
source failure and reports `sourceHealth.opencode` as degraded; valid empty data remains distinct.
Codex ledger reads retain their JSONL fallback and expose ledger source health. Project-memory status
retains unreadable stores with a reason instead of silently selecting a different store.

### 3. Promised backups are fail-closed and replacements are atomic

Settings and managed guidance share one writer. Before replacing an existing file, it either proves
that the one-time `.bak` is a regular non-symlink file or creates it exclusively. Any backup error
aborts before mutation. The replacement uses a same-directory temporary file plus rename, preserves
the original mode, and removes failed temporaries. A recovery promise is part of the write contract,
not best effort.

### 4. Status-line diagnostics are explicit, bounded, and redacted

Fail-to-blank remains the default. `AK_STATUSLINE_DEBUG=1` writes stage-level diagnostics to
`$XDG_STATE_HOME/agentic-kit/statusline-debug.log`, falling back to
`~/.local/state/agentic-kit/statusline-debug.log`; `AK_STATUSLINE_DEBUG_FILE` is a test/operator
override. The log is owner-only, capped by resetting at 64 KiB, and contains only timestamp, stable
stage, error name, and error code. It never records messages, stacks, paths, argv, subprocess output,
payloads, or environment values. Diagnostic failures cannot affect rendering.

### 5. Runtime process discovery follows least privilege

macOS and Linux discovery uses the real current UID (`ps -U <uid> -x`) rather than `ps -a`. The first
survey omits argv. A second query reads argv only for current-user executables that can be a supported
host controller or Node launcher. CWD lookup then receives only filtered controller PIDs. The public
event boundary remains path-redacted as defined by ADR-0012.

`AK_RUNTIME_DEBUG=1` traces this pipeline stage-by-stage (survey row count, which PIDs were classified
as a host, which were dropped as a nested child of another candidate, and per-controller cwd
resolution) to `$XDG_STATE_HOME/agentic-kit/runtime-debug.log`, mirroring the statusline diagnostic's
opt-in/bounded-at-64-KiB/owner-only-0600 contract (`AK_RUNTIME_DEBUG_FILE` overrides the path). It is a
narrower redaction than the statusline diagnostic: raw argv/command strings are still never logged
(a pasted prompt or token could be sitting in one), but cwd paths ARE — resolving "why didn't project
X's controller show up" is the flag's entire purpose, the operator turned it on deliberately, and a
local directory path is not a secret the way a command line can be.

### 6. Every host setup has a pre-mutation trust boundary

Each host adapter must declare whether agentic-kit manages approval grants or leaves the host's
approval/sandbox policy unchanged, plus every setup-time approval, MCP registration, lifecycle
extension, and host integration it can apply. Setup derives one manifest from those declarations,
prints the applicable changes before machine, user, or project mutation, and asks for one consent;
`--yes` is explicit batch acceptance and still prints the set. A future host cannot validate without
the declaration and needs no command-specific disclosure branch. `ak host pick` applies the same
preflight when it enables a new host, limited to changes that command can actually perform.

For Claude project setup, `--no-aqe` reduces the four Ruflo and three Agentic-QE auto-approve rules
to four. Setup snapshots pre-existing user rules and verifies upstream output after Ruflo and AQE
init. Any new rule outside the disclosed manifest is removed and setup fails; pre-existing user
rules survive. OpenCode discloses its user-scope wildcard approvals, MCP registrations, lifecycle
plugin, and managed host assets. Codex discloses MCP/AQE registrations while explicitly retaining
its sandbox and approval policy.

#### 6.1 Sensitive companion reads and injections require their own consent

ADR-0035 applies the same boundary to deja-vu before the first transcript scan or index write, not
only before host configuration changes. Consent names the stores read, the unencrypted derived
index, each explicit host target, and the automatic event set. MCP-only recall is the opt-in
default. Auto-recall is a second per-host consent because v0.19.0 can inject untrusted history at
prompt, compaction, command, and edit boundaries rather than only at session start.

Companion diagnosis stays offline, bounded, schema-checked, and content-free. A zero exit from
`deja doctor --json --offline` does not upgrade a reported fault to healthy; missing auto-hook,
plugin-coexistence, Codex-trust, or index-integrity evidence remains unknown. A destructive data
purge is planned and confirmed separately from wiring or package removal.

### 7. Usage source degradation is visible in the dashboard, for all four local sources

The Usage API's `sourceHealth` field is rendered as persistent local-source pills in the
dashboard's sticky tabbar (right-aligned, visible on every view once Usage data has loaded once —
not confined to the Usage panel). `ok`, `absent`, `degraded`, and `not-read` remain distinct, and
bounded reasons such as `busy`, `corrupt`, `query`, `schema`, `sandboxed-roots`, or an fs error code
(`ENOENT`, `EACCES`, `ENOTDIR`) are visible without entering raw JSON.

`sourceHealth` originally covered only the two sources with a *secondary, corrective* read layered
on top of a primary parse — OpenCode's SQLite store and Codex's own thread ledger — because those
are exactly where item 2 above found silent collapse in practice. It did not cover the primary
Claude and Codex transcript roots (`~/.claude/projects`, `~/.codex/sessions`) themselves: `listClaude`
and `listCodex` walk those directories through a `readdirSync` wrapped in a bare `catch { return [] }`,
so a missing root, a permissions error, or any other I/O failure was indistinguishable from "no
sessions in this window" — the same silent-zero failure class item 2 closed for OpenCode/Codex, just
left open on the two sources every installation actually depends on.

Closing it required checking what's real to check against, not inventing a status: Anthropic
documents `~/.claude/projects/<encoded-cwd>/*.jsonl` and its 30-day default retention directly (Claude
Code's Data usage page; the `transcript_path` every hook receives). Codex's `~/.codex/sessions/**/rollout-*.jsonl`
is real and load-bearing for Codex's own `codex resume`, though OpenAI does not publish it as a
formal contract the way Anthropic does. Both are markedly more stable ground than the two sources
already tracked — the Codex thread ledger (`state_N.sqlite`) and OpenCode's `opencode.db` are
undocumented internal storage, confirmed real only by their own upstream bug trackers (e.g.
openai/codex#21750, a corrupt `state_5.sqlite` wedging Codex's own startup) and defensive code
already treating the ledger's generation suffix as "not a stable name." None of the four are
fabricated; `rootHealth()` performs a real `readdirSync` against a real path exactly like the
existing checks, just one level up the trust stack from the two sources already wired.

`sourceHealth` now reports `claude`, `codex`, `opencode`, and `codexLedger`. The dashboard renders
this by HOST, not by field: three pills for the three supported hosts (Claude, Codex, OpenCode), not
four. `codex` and `codexLedger` are both Codex-only evidence, so they fold into one Codex pill — its
status is the worse of the two, and both sub-statuses stay reachable via the status side's tooltip
(e.g. hovering "degraded" shows `Codex: transcripts: ok · ledger: corrupt`). No evidence is dropped;
the API keeps four independently-diagnosable fields, the UI just groups by the thing the operator
actually cares about (which host needs attention), matching how Claude and OpenCode already render
as one pill each.

Each pill leads with a branded host icon rather than a text label — the same mark
`live/client.mjs`'s `hostIcon()` uses in the Observability Live view's session list (Anthropic's
asterisk, OpenAI's Blossom, OpenCode's square), reused verbatim so a host reads as the same glyph
everywhere in the dashboard. The icon sits in a circular badge (`var(--bg)` fill, 1px border) at
32px/20px glyph — matching the Live view's own proven scale — after two smaller, badge-less passes
proved illegible against live screenshots: a floating icon with nothing to contrast against, and
Codex's multi-lobed Blossom geometry specifically, both need real size and a defined edge to resolve.
Hovering the icon shows what it monitors (its transcript path or store); hovering the status word
shows the full per-field detail. The pill itself uses a solid `var(--panel-2)` background matching
the segmented tab control's own look — no border, state shown via status-text color/weight — rather
than the colored-outline chip style originally shipped.

#### 7.1 Cross-host telemetry coverage is additive and evidence-graded (2026-08-24)

**[Superseded 2026-08-29: the capabilities matrix was removed with the telemetry-coverage panel —
see [ADR-0038](0038-consistent-cross-host-session-metrics.md). `diagnostics.common` and the
source-health pill described below still ship.]**

Usage adds `sourceHealth.<host>.diagnostics.common` and
`sourceHealth.<host>.capabilities` without changing existing status/reason or Codex-specific
diagnostic fields. `supported`, `unsupported`, and `unavailable` are capability states, not
observed counts: a readable source may report a supported zero, while an absent or degraded source
must not render a fabricated zero. The Usage panel therefore says coverage is unavailable when
common evidence cannot be read, and labels the Codex card as transcript coverage because
`codexLedger` remains a separate corrective source folded only into the persistent host-health pill.
The common unknown-kind map is capped at 32 names with overflow volume retained separately.

### 8. Clean-machine proof is isolated at every mutable boundary

Required tests redirect HOME, USERPROFILE, XDG config/state, APPDATA, npm prefix/cache, Brain KB, and
PATH before loading or launching the CLI. The ordinary matrix runs these tests on Linux, macOS, and
Windows. The scheduled/manual nightly additionally packs the current artifact and performs real
setup on `macos-latest` with all global packages and user/project files under `runner.temp`.

### 9. A permanently unmeasurable quantity is deleted, not degraded (2026-08-07)

The rules above cover a quantity that *could* be measured and was not: it renders as unknown with a
reason. They did not cover a quantity that no code path can *ever* produce. The System area shipped
one — an "AI-worker budget" tile hardcoded to unknown with the reason "ruflo exposes no local budget
state this collector can read". It could never render anything else.

An always-unknown tile is not honest degradation, it is a promise the product cannot keep, occupying
space and teaching the reader to ignore unknowns. So: a field whose reason is *structural* rather
than circumstantial is **removed from the collector, the payload and the panel**, not rendered as
degraded. The distinction is whether a plausible future state of the machine would populate it. If
one would, it stays and degrades; if none would, it was never a measurement.

### 10. An excluded figure is still stated (2026-08-07)

Storage lifts learning stores out of its shared charts because at ~99% of retained bytes they flatten
every other series. Exclusion for legibility is allowed; *silent* exclusion is not. The excluded
category is reported on its own card, the charts say what they leave out, and the per-host split
names the non-host bytes it drops with their figure — so the bars still account for the whole of the
donut beside them. A reader must never have to reconcile two panels and find the difference
unexplained.

## Consequences

- A fallback can keep work available without being mislabeled healthy.
- An unknown carries information, because nothing that is permanently unknowable is rendered as one.
- A chart may exclude a category for legibility, but the panel says so and the excluded figure is
  still reachable.
- Temporary SQLite locks and corrupt stores no longer become measured zero usage.
- Backup-path problems stop setup/sync instead of destroying the only recoverable pre-write state.
- Status-line failures stay silent for ordinary users and become diagnosable without logging content.
- The normal macOS/Linux survey selects the dashboard process's numeric UID before reading candidate
  argv; shared logins and host-PID containers remain same-UID boundaries, not separate users.
- `ak setup` makes each enabled host's trust changes inspectable before acceptance and detects
  undisclosed Claude project grants introduced by upstream initializers.
- Enabling deja-vu discloses the history read and index write before either occurs; automatic
  injection and destructive data purge require separate, narrower consent.
- Some formerly best-effort writes now fail. This is deliberate: when ak promises a backup, mutation
  without one is a correctness failure.
- An unreadable `~/.claude/projects` or `~/.codex/sessions` (permissions, a corrupt filesystem entry,
  the path replaced by a non-directory) now renders as a degraded local-source pill instead of a
  quietly empty Usage scorecard; all four local sources share one status vocabulary.

## References

- Implementation: `src/lib/{file-write,settings,blocks,sqlite,heal,output}.mjs`,
  `src/lib/live/process-sessions.mjs`, `src/lib/{usage-index,usage-opencode,codex-state,trust-manifest}.mjs`,
  `src/lib/dashboard/{page,client,styles}.mjs`,
  `src/commands/{setup,sync}.mjs`, and `src/templates/statusline-footer.cjs`.
- Tests: `tests/kit/{clean-machine-setup,heal-natives,sqlite,settings-config,blocks,
  live-process-sessions,setup-command,trust-manifest,usage-index,usage-index-opencode}.test.mjs`,
  `tests/dashboard.test.cjs`, and `tests/statusline-segments.test.cjs`.
- Clean-machine workflow: `.github/workflows/nightly.yml`.
