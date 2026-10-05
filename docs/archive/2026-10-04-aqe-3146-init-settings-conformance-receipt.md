# AQE 3.14.6 init-settings conformance receipt (2026-10-04)

Capture: 2026-10-04. Scope: the exact `agentic-qe#778` conformance from
[the 3.14.5 receipt](2026-09-29-aqe-released-artifact-receipt.md#selected-results), repeated
against the next published release. This receipt reports only the selected probe below; it is
not an issue-closing request and does not establish full/none-mode, `--minimal`, `--with-codex`,
backup-file-content, or all-platform conformance.

## Exact artifact and environment

`agentic-qe@3.14.6` was installed from the public npm registry into a disposable prefix
(`npm install -g agentic-qe@3.14.6 --prefix <disposable>`); the public `aqe` bin reported
`3.14.6`. Runtime: Node `v22.22.0`, npm `10.9.4`, Linux x86_64. The probe ran in a disposable
git-initialized project (`git init`, a minimal `package.json`) with no prior AQE state.

## Selected result

Three identical, same-option public `aqe init --auto` calls ran on the one unchanged project.
Each exited 0. `.claude/settings.json` was:

| Run | SHA-256 | mtime (ms, epoch) |
| --- | --- | --- |
| 1 | `375f06ae4d6791ccd62767aedc2b33e822ce3e829b529b75021c671441da4679` | `1791129561760.252` |
| 2 | `375f06ae4d6791ccd62767aedc2b33e822ce3e829b529b75021c671441da4679` | `1791129561760.252` |
| 3 | `375f06ae4d6791ccd62767aedc2b33e822ce3e829b529b75021c671441da4679` | `1791129561760.252` |

Byte- and mtime-identical across all three runs: run 2 did not rewrite the file at all, let
alone change its bytes, and no backup entry appeared under `.claude/`. This refutes, for the
default non-Codex `aqe init --auto` path, the churn the [2026-09-29 receipt](2026-09-29-aqe-released-artifact-receipt.md)
recorded on released 3.14.5 (settings hash/mtime changed on every run; run 2 added a backup and
changed domain/learning defaults; run 3 still changed `aqe.initialized`).

An earlier ad hoc probe via `npx -y agentic-qe@3.14.6 init --auto` (same project shape, not
captured as a fixture) showed the same stable-hash, stable-mtime, no-backup result and is not
separately tabulated here.

## Limitations

This is the single reported repro (plain `aqe init --auto`, three runs, one disposable Linux
project, one run of the probe). It does not cover `--minimal`, `--with-codex`, upgrade
(`--upgrade`) runs, Windows or macOS, or a byte-level diff of every file AQE writes (only
`.claude/settings.json` and a directory-listing check for backup-named entries under `.claude/`
were inspected). `AGENTS.md`/`CLAUDE.md` were not part of this run (no `--with-codex`). Keep
`proffesor-for-testing/agentic-qe#778` at its current status until a maintainer repeats this
under `tests/live/aqe-init-settings-conformance.test.mjs` with `AK_AQE_CONFORMANCE=1
AK_AQE_CONFORMANCE_STRICT=1` on the platforms and modes this receipt does not cover, and decides
whether to retire the constraint or set a minimum fixed version.

## Addendum 2026-10-05: strict run on 3.14.8, macOS

`tests/live/aqe-init-settings-conformance.test.mjs` ran with `AK_AQE_CONFORMANCE=1
AK_AQE_CONFORMANCE_STRICT=1` against the installed `agentic-qe` 3.14.8 (macOS, Node v26.4.0,
disposable project and HOME). It passed: the three same-option `aqe init --auto` calls left
`.claude/settings.json` byte- and mtime-identical (SHA-256
`1de29cdd13087da43dfa15e87a6cfc14873d7675ad71470072bb8c778264ff9f`), and no backup entry
appeared under `.claude/`. This adds macOS and a newer release to the Linux 3.14.6 result above.
The same limits apply: one run, the default non-Codex path only, no `--minimal`, `--with-codex`
or `--upgrade`, no Windows or Linux on 3.14.8.

The registry constraint for agentic-qe#778 was retired in
[#456](https://github.com/pacphi/agentic-kit/pull/456), so the paragraph above about keeping
the constraint is historical. The test stays as an opt-in regression guard.
