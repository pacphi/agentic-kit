# AQE 3.14.7 conformance receipt (2026-10-05)

Capture: 2026-10-05. Documentation basis: `a0932481a61004571926cfd5606a621f893a8c30`. The
runs used the globally installed `agentic-qe@3.14.7` (registry integrity
`sha512-UCZkhgmN+CPjuU0rH/x4J46JpFmc1i5WhJki9A3yNxSZZM0e4P3TNUHFJwnQENa1q+Wp6ltTujX86e+hhoV/Yg==`,
registry modified 2026-10-04T11:56:33Z) on macOS 27.0.1 arm64 with Node v26.4.0. This is a single
platform; Linux and Windows were not run.

| Package-relative path | SHA-256 |
| --- | --- |
| `package.json` | `98df2b1870103b673c6fec638d4562d5900ffb64b2d474f9c4bbcc9b1b354acb` |
| `dist/cli/bundle.js` | `6b07c2525627e623ca5d27481292bfd994fb338d1e1925e2bd73379aede19ffd` |
| `dist/init/codex-installer.js` | `5257a103bab50150005fa17f80333b10c3ffbc9ca40b07da3d61a7af8e098629` |

## Method

The opt-in live suites ran through `node scripts/run-tests.mjs exec -- --test <file>` with
`AK_AQE_CONFORMANCE=1` and `AK_AQE_CONFORMANCE_STRICT=1`. Each sandboxes `HOME`, `TMPDIR`, the npm
prefix and mise state in its own temporary folder and calls `aqe` by absolute path. Direct probes
ran in a disposable folder outside any repository, under `env -i` with `HOME`, the four `XDG_*`
folders, `TMPDIR`, `npm_config_prefix` and `npm_config_cache` all inside it, and with no `AQE_*`
variable except `AQE_SKIP_CODE_INDEX=1` and, for the embedder run only,
`AQE_EMBEDDER_ENDPOINT=http://127.0.0.1:11434`. The MCP probes drove `aqe mcp` over stdio.

## Results

| Issue | Verdict on 3.14.7 | Observation |
| --- | --- | --- |
| [#655](https://github.com/proffesor-for-testing/agentic-qe/issues/655) | Pass | `tests/live/aqe-codex-guidance-conformance.test.mjs`, strict: `full`, `compact` and `none` each select their guidance on ak's path, keep the user's `AGENTS.md` text byte for byte outside the sentinel, are idempotent over two runs, report owned bytes in the `--json` receipt and pass `aqe platform verify codex --codex-guidance <mode>` (3 of 3). |
| [#755](https://github.com/proffesor-for-testing/agentic-qe/issues/755) | Pass | Covered by the same suite: `platform verify codex` passes in every mode, which fails when the Codex hooks and skills are absent. |
| [#756](https://github.com/proffesor-for-testing/agentic-qe/issues/756) | Pass | The `full` mode of the same suite on an existing `AGENTS.md`. |
| [#758](https://github.com/proffesor-for-testing/agentic-qe/issues/758) | Pass | `aqe platform verify codex` in a bare project printed `[fail]` lines for the config file, behavioral rules, guidance and lifecycle hooks, and exited 1. |
| [#757](https://github.com/proffesor-for-testing/agentic-qe/issues/757) | Pass | `aqe platform setup <id>` exited 0 and printed "configured successfully" for `copilot`, `cursor`, `cline`, `kilocode`, `roocode`, `codex`, `windsurf` and `continuedev`. |
| [#532](https://github.com/proffesor-for-testing/agentic-qe/issues/532) | Pass | `aqe init --auto --minimal --with-codex --no-claude` wrote `AGENTS.md`, `.codex`, `.agents` and `.agentic-qe`, and no `CLAUDE.md` or `.claude`. |
| [#778](https://github.com/proffesor-for-testing/agentic-qe/issues/778) | Pass | Three same-option `aqe init --auto --minimal --skip-patterns --no-statusline` runs left `.claude/settings.json` (`ab248ec71882…`) and `CLAUDE.md` (`fbc03861f350…`) identical, with no backup file. Option set differs from the 3.14.5 receipt in `--skip-patterns` and `--no-statusline`. |
| [#528](https://github.com/proffesor-for-testing/agentic-qe/issues/528) | Pass | `aqe mcp` started as one process with no descendants, answered `tools/list` (91 tools) and kept stdin attached. |
| [#735](https://github.com/proffesor-for-testing/agentic-qe/issues/735) | Pass | With no pin variables set, `aqe memory store` run from `pkg/sub` wrote to the root `.agentic-qe/memory.db` and created no store below the root. |
| [#535](https://github.com/proffesor-for-testing/agentic-qe/issues/535) | Mostly pass | `memory_delete` removes the key (`found:false` on retrieve). `cross_phase_stats` reports `totalSignals:1` after one stored signal. `qe/planning/goap_plan` honors `maxSteps` (11 actions without it; refused at 3, 6 and 10). `qe/planning/goap_execute` with `dryRun` finds the plan (11 steps). `qe/coherence/consensus` for votes true, true, false says "2 of 3 votes 'true'". Not re-exercised: `test_generate_enhanced` quality and the GOAP `activeAgents` count. |
| [#574](https://github.com/proffesor-for-testing/agentic-qe/issues/574) / [#753](https://github.com/proffesor-for-testing/agentic-qe/issues/753) | Unchanged | `tests/live/aqe-live-lock-conformance.test.mjs` with `AK_AQE_LOCK_LIVE=1` passes. No concurrent-append check was added. |
| Stop hooks | Pass | `tests/live/aqe-stop-hook-conformance.test.mjs`, strict, passes (the constraint it served is already sunset). |
| [#754](https://github.com/proffesor-for-testing/agentic-qe/issues/754) | Partial | In the disposable repro, `patterns.rvf.space.json` is now written with the stored space id. `aqe learning embedding-health` still reports `unverified`, 71 mismatched vectors and "runtime not initialized", so index binding and semantic search were not shown. The real-project `ak status --refresh=live --only aqe` fell back to SQLite because a live session held the RVF lock. |

## Not run or not established

- `tests/live/aqe-mcp-lock-conformance.test.mjs` is skipped without `AK_AQE_MCP_LOCK_LIVE=1`, which
  needs an approved exact-artifact acquisition ([#801](https://github.com/proffesor-for-testing/agentic-qe/issues/801)).
- [#759](https://github.com/proffesor-for-testing/agentic-qe/issues/759): no store with witness rows was imported.
- `tests/live/aqe-external-provider-transport.test.mjs` refused to start with provider API keys in
  the environment.
- Linux and Windows. Results hold for 3.14.7; they do not say which earlier release first fixed
  each item.
