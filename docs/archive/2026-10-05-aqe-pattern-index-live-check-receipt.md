# AQE pattern-index live check receipt (2026-10-05)

Capture: 2026-10-05 (local), after the [3.14.8 verification](2026-10-05-audit-aqe-3-14-8-verification.md).
It runs ak's pattern-index probe (`src/lib/aqe-pattern-index-probe.mjs`,
[agentic-qe#754](https://github.com/proffesor-for-testing/agentic-qe/issues/754)) against the same
disposable `agentic-qe@3.14.8` install (integrity
`sha512-VCqf3p6epkFDHAUtvglYvJpzW8Ls7UjbDGMZKvApGCvOxVNAH/Hyw9rRTIUJxz52aexbuwQXeuCQkNeR0Ryp5A==`) and the
local Ollama endpoint `http://127.0.0.1:11434` (`Xenova/all-MiniLM-L6-v2`, 384 dimensions). macOS 27.0.1
arm64, Node v26.4.0. One platform; Linux and Windows were not run.

## What was run

| Check | Result |
| --- | --- |
| `AK_AQE_PATTERN_INDEX_LIVE=1 … node scripts/run-tests.mjs exec -- --test tests/live/aqe-pattern-index-conformance.test.mjs` | 2 tests, 2 pass, 0 skipped |
| Probe against the real endpoint | `{"status":"passed"}` in about 2.2 s |
| Control: the same probe against `http://127.0.0.1:9`, where nothing listens | `{"status":"failed","reason":"learn-failed"}` in about 0.5 s |
| `ak status --refresh=live --only aqe` from this branch, in a sandboxed home with AQE 3.14.8 as the global package and the saved `endpoint` choice | The live stage printed "embedder verified: live embedding request passed; dimension=384; AQE pattern index binding verified (agentic-qe#754)", and the `aqe-embedding` status row read "embedder verified just now (ak status --refresh=live); AQE pattern index binding verified (agentic-qe#754); corpus compatibility unverified" |

The control matters: a probe that cannot fail proves nothing. Unit tests inject the command runner and cover
every reason (`version-below-fix`, `backend-not-endpoint`, `aqe-package-unavailable`, `learn-failed`,
`search-failed`, `invalid-output`, `pattern-not-retrieved`, `lexical-fallback`, `timeout`).

## Why a new probe

The embedder probe imports AQE's unbundled `dist/` modules. There the native RVF binding is unavailable (the
adapter calls `require` from an ES module), so `createPatternStore()` returns the in-memory store and a probe
built on that path reports "not bound" on every release, 3.14.8 included. The shipped bundle binds. The new
probe therefore runs the installed `aqe hooks learn --json` and `hooks search --json` in a disposable project
with a private `HOME`, and requires the learned pattern back with `matchType: "vector"`.

## Limitations

- One embedder model and one platform. The probe reads human-facing CLI JSON, so a change to the shape of
  `hooks learn` or `hooks search` output reads as `invalid-output`, never as a pass.
- Not run: AQE versions between 3.14.5 and 3.14.7, an authenticated endpoint, a unix-socket endpoint, and the
  `ak sync` and `ak setup` paths against a live AQE (their unit tests inject the probe).
- `npm root -g` masks UUID-like path segments in its output, so a global prefix whose path contains one
  resolves to a path with `***` in it. The run above used a prefix path without one. This is npm's behaviour and
  was not changed.
- This was a repeated check, not a before-and-after pair: no run on 3.14.4, where the index does not bind, was
  made, so `version-below-fix` rests on the probe's version gate and upstream's tag containment.
