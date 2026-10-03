# AQE pin retirement: what released agentic-qe resolves from a subfolder

Written 2026-10-03 for the pull request that retires ak's AQE project-root pin
([ADR-0062](../adr/0062-aqe-project-store-integrity.md) §1, agentic-qe#735). It records what was
run, what was seen, and what was not run.

## What was run

The published `agentic-qe` 3.14.5 package, installed into a scratch folder (`npm install
agentic-qe@3.14.5`), and 3.14.5 and 3.14.7 unpacked from `npm pack`. Each scenario ran in a fresh
disposable git repository whose root holds `.agentic-qe/`, from `pkg/sub`, with a sandboxed `HOME`
and `AQE_PROJECT_ROOT`, `AQE_MEMORY_PATH` and `AQE_STORAGE_PATH` unset unless stated. macOS 27.0.1
(arm64), Node 26.4.0.

Two checks:

1. `dist/kernel/project-root.js`'s `findProjectRoot()` (3.14.5 and 3.14.7), called with `pkg/sub` as
   the start folder.
2. The two store writers 3.14.5 uses, called from `pkg/sub`:
   `dist/learning/embedder-identity-store.js` (`saveEmbedderIdentity`, which opens `memory.db`) and
   `dist/init/token-bootstrap.js` (`bootstrapTokenTracking`, which creates the storage folder).

## What was seen

| Scenario (no pin written) | `findProjectRoot()` 3.14.5 / 3.14.7 | Store writers on 3.14.5 |
| --- | --- | --- |
| A. No env, no stray store | the repository root / the repository root | `memory.db` at the root; nothing in `pkg/sub` |
| B. AQE's own relative `AQE_MEMORY_PATH=.agentic-qe/memory.db` (what `aqe init` writes) | not applicable | same: relative values are anchored at the root |
| C. Relative `AQE_MEMORY_PATH` and `AQE_STORAGE_PATH` | not applicable | same |
| D. A stray `.agentic-qe` already in `pkg/sub` | `pkg/sub` / `pkg/sub` | the stray received `memory.db`; nothing at the root |
| E. A stray in `pkg`, run from `pkg/sub/deep` | `pkg` / `pkg` | not run |

A to C confirm the fix: from a subfolder, AQE 3.14.5 and later use the project's store without any
pin. D and E are the caveat. AQE uses the **nearest** `.agentic-qe` (agentic-qe#516, v3.10.4 release
notes: "`findProjectRoot()` now prefers the **nearest** `.agentic-qe`"), so a stray store left in a
subfolder by an older AQE is adopted there once `AQE_PROJECT_ROOT` no longer overrides it. The pin
overrode it; nothing else does.

## What follows for ak

- ak writes no new pin.
- ak releases a pin an older version wrote only when the installed AQE is 3.14.5 or later and no
  stray AQE store exists below the root. Otherwise it keeps that pin converged, and `ak status`
  shows one `aqe-pin` row saying why.
- The stray-store status row says that an AQE run from the stray's folder adopts it.

## What was not run

- The `aqe` command line, an AQE hook and the AQE MCP server started in a subfolder. Only the two
  library entry points above were called.
- 3.14.7's store writers (only its `findProjectRoot()`), and AQE older than 3.14.5.
- Linux and Windows. The lock-conformance workflow (#347) covers all three systems for the lock
  proof, not for this behaviour.
- A real `aqe init`: the relative `AQE_MEMORY_PATH` value in scenarios B and C was set by hand to
  what ADR-0062 records `aqe init` writing.

The scenario scripts were small throwaway files in the session's scratch folder and are not kept.
