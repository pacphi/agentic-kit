# AQE M1 native MCP lock proof

Capture: 2026-09-30 (local); final source-control observation 2026-10-01T00:06Z.
Scope: approved disposable local AQE 3.14.6 acquisition, SQLite native preparation,
real MCP-holder/packed-kit proof and bounded cleanup investigation. No publication,
hosted dispatch, global installation or real-store operation occurred.

## Artifact and execution identity

| Input | Bound value |
| --- | --- |
| Kit source | Clean `0e42d029edd011e1789df5218b332669a790b106` on fix/completion-m1 |
| Kit package | 4.0.0-alpha.60; SHA-256 `97da354544aa16ff5ad2dd578e666f8d369a40947c245a79cc3e3285f85eb1cb` |
| AQE package | Published 3.14.6; pinned SHA-512 verified against actual tarball bytes |
| AQE CLI SHA-256 | `ff447634f8fbe69711b61ef29166fc52c2ac4211583d7c57b70ba1fc245b737d` |
| AQE MCP SHA-256 | `33e3b33a68ad4cf20e6410b6acc6006c80bbfecb3edd532859f3c24f56b790f5` |
| Shared adapter SHA-256 | `573d471f81a34e2fab845407c1017c6e297a632871688893010e2127dfb2c0a0` |
| Environment | macOS, Node v26.4.0; better-sqlite3 12.11.1; rvf-node 0.1.8 |

AQE integrity:
`sha512-ObNw+nFHj4Kz7JYulAdBSJ5/QP5lmFeRTvwBRalUXeQSQZu5PoN4Xp3ZTug3q5EoHWXVd3+xdBdlbtgqq+8+bg==`.
Package lifecycle scripts were disabled. Only better-sqlite3 was rebuilt, in the private
prefix with private HOME/config/cache. Installed AQE executable/modules were not patched.
Acquired packages, dependency tree, commands and individual failed/successful logs are retained
under the ignored `.superpowers/completion-plan/aqe-3.14.6-m1/` evidence root.

## Released artifact observations

The stock published MCP completed initialize/tools-list (protocol 2025-03-26, 91 tools).
Its PID matched the 104-byte FLVR lock record for the disposable patterns.rvf store.
Discovery is not a fleet, provider, embedding or tool-execution verdict.

- Direct aqe status exited 0, reported the live-owner warning and SQLite fallback, and
  emitted no FsyncFailed/0x0303. The 3.14.6 live-owner sentinel deliberately avoids the
  generic adapter-error logger, so absence of a literal LockHeld/0x0300 token is expected.
- The extracted packed kit's current `status --refresh=live --only aqe --json` command
  reported ordinary startup busy. It exited 1 because semantic verification failed on
  the deliberately unmanaged/missing backend; that failure was not relabelled as success.
- During both challenger commands, the MCP stayed alive and patterns.rvf/sidecar bytes and filenames
  were identical. No quarantine artifact appeared. The empty RVF fixture was 162 bytes.
- EOF shutdown exited 0, signal null, logged server stopped and no watchdog. However,
  patterns.rvf.lock remained and named the exited MCP PID. The complete native test failed.

Three stock MCP runs retained that shutdown failure. The first run's finally-block error
masked any earlier assertion; the second exposed a harness error requiring a literal
native error token beyond the agreed busy-startup contract. The corrected harness
retains both errors and validates the semantic warning; the third run passed the startup
and preservation phase and failed only the owned-marker shutdown assertion.

Every guarded acquisition/probe returned a clean real-state tripwire and own-root hygiene
result. Temporary fixture removal followed call-owned child closure; acquisition artifacts
remain retained. Setup failures before acquisition (helper import, npm launcher/config)
were kept; npm's distinct-user/global-config requirement was fixed in 0e42d02.

## Root-cause bounds and controls

The published shutdown entry resets the shared dual writer, while shared patterns-adapter
consumers skip disposal and leave it to application lifecycle. The separate
resetSharedRvfAdapter closes that singleton but is not called by MCP shutdown.
The stock bundle preserves this omission; modifying an external ESM singleton would not
prove closure of its inlined bundled counterpart. Source references were independently read.

A direct native shared-adapter holder control passed fallback/preservation and EOF closure;
explicit adapter close removed its marker. This separates omitted lifecycle cleanup from
a claim that the native close binding itself is defective. A dead-PID marker alone is not
evidence that an OS lock remains live, nor did this probe establish data loss.

Matched original/proposed source-module controls used tagged v3.14.6 source blob
`202a56d0611cd6b13efd768a6fdb29a3ab948bbc`, the same published dependency graph and the
same createRequire interoperability shim. Original source reproduced the marker failure;
adding a static shared-adapter reset after server drain removed the marker and passed.
These controls were transpiled copies, not a normal rebuilt release bundle. Source-mode
fleet initialization additionally reported an unavailable optional attention module;
the control does not establish general fleet readiness. No extra dependency was installed.

The proposed source patch remains private and unmerged. Rebuilt-package proof, Windows,
Linux, duplicate shutdown, unavailable-RVF startup and preservation of unrelated live owners
remain required before claiming the upstream correction complete.

## M1 disposition

This supplies qualified macOS released-artifact startup/preservation evidence for #240.
The complete conformance gate failed on a separately identified upstream shutdown finding.
Keep the original issue criteria, installed-target and other-platform gates explicit; do not
silently substitute a passing source control for a passing published package or introduce
an unrelated feature blocker. #240 remains open. The approved local probe was executed;
M1 itself is not complete. See the [M1 execution plan](../plans/2026-09-30-completion-m1-execution.md)
and [successor ledger](../plans/2026-09-30-completion-m1-closeout-ledger.md).
