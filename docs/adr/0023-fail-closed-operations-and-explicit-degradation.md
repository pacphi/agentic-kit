# ADR-0023 — Fail-closed mutations and explicit degraded operation evidence

- **Status:** Implemented
- **Date:** 2026-08-04
- **Updated:** 2026-08-04
- **Update note:** Generalized setup preflight into a required host-adapter trust contract, added
  Codex registration/OpenCode approval disclosure, documented current-UID installation-mode
  boundaries, and surfaced usage-source health in the dashboard UI.
- **Deciders:** agentic-kit maintainers
- **Related:** [issue #111](https://github.com/pacphi/agentic-kit/issues/111),
  [ADR-0008](0008-guidance-target-scope-split.md),
  [ADR-0009](0009-usage-scorecard-local-transcript-analytics.md),
  [ADR-0012](0012-observability.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md),
  [ADR-0016](0016-capability-driven-integration-adapters.md), and
  [ADR-0017](0017-opencode-host.md)

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

### 7. Usage source degradation is visible in the dashboard

The Usage API's `sourceHealth` field is rendered as persistent local-source chips across Usage
views. `ok`, `absent`, `degraded`, and `not-read` remain distinct, and bounded reasons such as
`busy`, `corrupt`, `query`, `schema`, or `sandboxed-roots` are visible without entering raw JSON.

### 8. Clean-machine proof is isolated at every mutable boundary

Required tests redirect HOME, USERPROFILE, XDG config/state, APPDATA, npm prefix/cache, Brain KB, and
PATH before loading or launching the CLI. The ordinary matrix runs these tests on Linux, macOS, and
Windows. The scheduled/manual nightly additionally packs the current artifact and performs real
setup on `macos-latest` with all global packages and user/project files under `runner.temp`.

## Consequences

- A fallback can keep work available without being mislabeled healthy.
- Temporary SQLite locks and corrupt stores no longer become measured zero usage.
- Backup-path problems stop setup/sync instead of destroying the only recoverable pre-write state.
- Status-line failures stay silent for ordinary users and become diagnosable without logging content.
- The normal macOS/Linux survey selects the dashboard process's numeric UID before reading candidate
  argv; shared logins and host-PID containers remain same-UID boundaries, not separate users.
- `ak setup` makes each enabled host's trust changes inspectable before acceptance and detects
  undisclosed Claude project grants introduced by upstream initializers.
- Some formerly best-effort writes now fail. This is deliberate: when ak promises a backup, mutation
  without one is a correctness failure.

## References

- Implementation: `src/lib/{file-write,settings,blocks,sqlite,heal,output}.mjs`,
  `src/lib/live/process-sessions.mjs`, `src/lib/{usage-index,usage-opencode,codex-state,trust-manifest}.mjs`,
  `src/lib/dashboard/{page,client,styles}.mjs`,
  `src/commands/{setup,sync}.mjs`, and `src/templates/statusline-footer.cjs`.
- Tests: `tests/kit/{clean-machine-setup,heal-natives,sqlite,settings-config,blocks,
  live-process-sessions,setup-command,trust-manifest,usage-index-opencode}.test.mjs`,
  `tests/dashboard.test.cjs`, and `tests/statusline-segments.test.cjs`.
- Clean-machine workflow: `.github/workflows/nightly.yml`.
