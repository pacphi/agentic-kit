# Test temp folder cleanup design

## Status and decision

Research snapshot: 2026-09-28, `e2f9dcae0554ff63921df618a819fd5e6afe80d2`, macOS Darwin 27.0.0, Node 26.4.0; Node 22.22.3 used for CLI checks. Proposed behavior is **list-only for abandoned sibling roots on macOS, Linux and Windows**. No candidate establishes complete descendant liveness. This uses B9-R5's explicit fallback, preserves B9-R1–R8, and introduces no native sweeper or deletion authority.

The [execution plan](2026-09-28-runner-hygiene.md) maps subsequent work. Raw commands, JSON results, full lexical census, counts and literal experiment paths are retained in ignored `.superpowers/sdd/2026-09-28-runner-hygiene/`. No production/test code changed. This design is reviewable with known evidence gaps; it is not a claim that every creator lifecycle or platform has been certified.

## Verified runner and creator behavior

At `scripts/run-tests.mjs:57-85`, the runner creates a unique suite root, redirects all three temp variables, runs synchronous commands, reports leftovers and removes its root after commands finish, including failure. SIGKILL cannot reach this cleanup. The source has no owner record or sibling collector. It strips FORCE_COLOR only (`scripts/run-tests.mjs:68`); LQ-1's premise that this layer strips AQE_EMBEDDER variables is refuted at this revision. Downstream boundaries still need sentinel tests.

The static census scans `.js`, `.mjs` and `.cjs` under tests for calls to mkdtemp/mkdtempSync/tempDir/sandboxHome/sandboxProject/usePrivateTmpdir/redirectToolState, retaining file, line and source. It finds 634 candidate call sites across 277 files: 117 tempDir calls, 83 module-level sandbox calls, 434 manually managed or unresolved sites. This is a lexical census, not a control-flow proof: aliases, generated fixture strings and wrapper calls require review. The complete `creator-census.json` is the review queue; unresolved sites are never classified safe merely because the file contains an after hook.

| Lifecycle class | Source evidence | Failure boundary |
|---|---|---|
| Cleanup registered before caller assertions | `tests/kit/helpers/temp-dir.mjs:16-20` creates then registers t.after or file after; `tests/kit/run-tests-runner.test.mjs:15-16` registers immediately | Assertion failure is covered after registration; process kill, allocation-to-registration failure and removal error remain |
| Manual cleanup after successful operations | `tests/kit/status-zero-spawn.test.mjs:86-90` removes its ledger after exec/read | Failed exec or parsing skips ledger removal; the parent run still diagnoses it |
| Module-level creator with file hook | `tests/kit/evidence.test.mjs:9` and `:231`; `tests/kit/refresh.test.mjs:17-19` | Abrupt exit misses hooks; in evidence, an early import/assertion may occur before hook registration |
| Exit hook in plain scripts | `tests/kit/helpers/private-tmpdir.cjs:11-16`; dashboard/statusline callers | Normal exit runs synchronous removal; SIGKILL never does; registration is after allocation |
| Caller-owned tools state | `tests/kit/helpers/home-sandbox.mjs:108-130` | redirectToolState returns restore; caller must arrange finally/hook before assertions; helper itself registers none |
| Caller-owned home/project | `tests/kit/helpers/home-sandbox.mjs:141-157` and `:303-306` | Creation does not register cleanup; consumers determine lifetime |
| Child temp base | `tests/kit/helpers/home-sandbox.mjs:83-97` | spawnEnv uses home/tmp and permits extra overrides; containment requires caller's home and final TMP values to be inside run root |
| Non-Node child | `tests/ui/helpers/launch-chrome.mjs:20-33` | Launch failure and browser.close remove private root; killed test or omitted close bypasses cleanup; Chrome is outside a Node-only registry |
| Hardcoded /tmp strings | `tests/kit/dashboard-live-source.test.mjs:7-21` | Path parsing and assertions only; these lines create no directory or file |

A full per-site manual classification of the 434 unresolved entries remains a research limitation. It is not needed to establish the conservative list-only decision, but must be completed before claiming exhaustive failure-path coverage or changing helper lifecycle policy.

## The fourteen reported post-runner leaks

The [archived premise table](../archive/2026-09-28-superpowers-plan-branch-9-follow-ups.md#premise-verification-done-by-the-planner-tasks-carry-the-evidence-forward) records fourteen newer folders by prefix. These are historical observations, not fourteen reproduced failures today.

| Historical entries | Attributed creator and cleanup | What can be concluded |
|---|---|---|
| ak-evidence-home ×2 | `tests/kit/evidence.test.mjs:9`, file after at `:231` | Creation precedes imports/assertions and late hook. Early failure or killed process can leak; exact historical cause unknown |
| ak-ruflo-components-evidence-location-home ×2 | `tests/kit/ruflo-components-evidence-location.test.mjs:6`, after at `:18` | Early import/assertion before hook or interruption possible; exact cause unknown |
| ak-refresh-home ×3; ak-refresh-proj ×3 | `tests/kit/refresh.test.mjs:17-19` | Hook is early, so ordinary later assertion failure should clean. Kill, failure before registration or failed removal remain hypotheses |
| ak-status-live-home ×3 | `tests/kit/status-live.test.mjs:17`, after at `:267` | Late registration leaves early initialization failure window; interruption/removal failure possible |
| ak-live-checks-home ×1 | `tests/kit/live-checks.test.mjs:21`, after at `:688` | Late registration has the same exposure; no historical exit trace identifies cause |

A basename and mtime cannot tell whether an assertion, import, kill or cleanup error caused a specific leak. Reconstructing that requires corresponding process/test logs. Do not rewrite this attribution as proof that every ordinary failed test leaks.

## Concurrent runs and race windows

Each mkdtemp root is unique, but sibling worktrees share the temp parent. An owner file is proposed to be written atomically via a temporary file and rename immediately after root creation. Until a valid record exists, keep the root (B9-R3). Old runners also have no owner and remain untouched. Malformed records, wrong host/user/platform, unreadable entries and unknown schema all mean keep.

An owner may finish during inspection, a PID may be reused, a descendant may start after a snapshot, and a root could change between validation and deletion. Owner records and start identities do not close these races. Current selection performs no sibling removal, so racing observations cannot authorize it. A future collector needs complete process containment plus a stable filesystem identity/revalidation protocol; a path name and PID are insufficient.

## Abandonment candidates and proof limits

| Candidate | macOS | Linux | Windows | Signal and cost assessment |
|---|---|---|---|---|
| A: process group / parent descent | Reject: detached descendants escape recorded group | Same source counterexample; no native execution here | Reject: snapshots can lose exited intermediate parents; PID reuse complicates descent | detached changes session/group and requires signal forwarding; no equivalence proof |
| B: parent identity plus handle scan / descent | Reject: measured live orphan has no root handle | Same logical gap; native /proc and lsof not measured | ParentProcessId/CreationDate cannot recover every missing intermediate ancestor | Avoiding signal changes is possible; fast probes still cannot prove absence |
| C: every Node process imports PID registrar | Reject: non-Node children; env replacement; startup registration race | Same coverage gap; no native execution | Same coverage gap; no native execution | NODE_OPTIONS affects children and can be removed; no transparent behavior proof |
| Selected: list-only | Never returns abandoned | Never returns abandoned | Never returns abandoned | No process launch/signal change; no expensive liveness probe required for removal |

`tests/kit/process-tree.test.mjs:52`, `tests/kit/exec-kill-tree.test.mjs:53` and `tests/kit/mcp-tool-call.test.mjs:21` deliberately use detached children. POSIX detached children create a new group/session; unref and stdio determine parent waiting behavior. Thus even an empty original group is insufficient. [Node child process documentation](https://nodejs.org/api/child_process.html#optionsdetached).

Windows ParentProcessId may refer to a dead or reused parent. CreationDate helps disambiguate identity, but a snapshot cannot reconstruct an already vanished chain of intermediate processes. This is a design inference from the documented fields, not a native Windows experiment. [Microsoft Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process).

B9-R6's startedAt milliseconds and 2-second reuse tolerance can distinguish a later process, but never establishes that the original process's children exited. Clock precision, permission errors and unparseable identity must resolve to unknown/keep. A newly started owner record should bind observed process start identity, not simply assume its file-write timestamp is the process start.

## Real macOS orphan experiment and timings

Scratch `probe.mjs` created an isolated temp parent, home, project and tmp. It launched the existing runner using `exec --repo <sandbox-project> -- <sleep.mjs>`. The child wrote PID/cwd/TMPDIR to a handshake file then idled for 60 seconds. The controller killed only the exact runner PID, waited for its exit, inspected the known child and finally sent SIGTERM to that child. No process search was used to select kill targets.

Trimmed evidence:

```text
runner PID 57521: SIGKILL
child PID 57522: alive=true
  PID  PPID  PGID COMMAND
57522     1 57490 node <sandbox>/sleep.mjs
child TMPDIR: <sandbox>/tmp/ak-suite-tHEZEe
child cwd: <sandbox>/project
root exists=true
lsof -nP +D <root>: exit 1, stdout empty, stderr empty
cleanup ps -p 57522: header only; child gone
```

The child cwd was the disposable project, outside its suite root. It had no open root file. The root was retained for review. This proves candidate B unsound for this case and disproves parent-death-only collection. The script's finally targets only its exact owned PIDs; its bounded timer is secondary protection.

Five sequential samples on this host (no cross-platform claim):

| Probe/workload | Measured range | Median |
|---|---|---|
| process.kill(childPid, 0) | 0.00075–0.008 ms | 0.00108 ms |
| ps -o lstart= -p childPid | 1.625–2.054 ms | 1.742 ms |
| lsof -nP +D empty suite root | 144.769–150.222 ms | 145.634 ms |
| Plain node --test inert.test.mjs | 64.153–66.150 ms | 64.621 ms |
| Guarded exec of same one-file test | 91.135–100.622 ms | 96.753 ms |

Observed median guarded overhead was 32.132 ms with 22 empty sandbox tripwire roots. This is not a measurement of a populated real home, a large backlog or the future collector. `/proc` and PowerShell CIM cost are **unmeasured** because there is no native Linux/Windows runtime in this task. A list-only inventory still needs bounded I/O and later performance validation against many roots; no production latency claim is made.

## Windows locks and CI failure

The controller supplied CI run **36520154869**, Windows Node 24: `status-zero-spawn.test.mjs` failed in inSandbox rmSync(project), line 55, EPERM; the leftover was ak-spawn-guard-smoke-proj. This failure is attributed evidence from the brief, not a freshly downloaded CI log.

Verified source: the smoke script forks at `tests/kit/status-zero-spawn.test.mjs:82` then calls process.exit(0) at `:83`, explicitly avoiding waiting for the grandchild. execFileSync waits for that immediate child; it does not establish that the grandchild released its project cwd. A surviving grandchild causing the observed EPERM is a plausible hypothesis, not proven root cause. The fork target itself exits immediately, making scheduling relevant.

Proposed regression: in a copied disposable fixture, hold the fork on a bounded handshake; record exact child/grandchild PID and spawn/exit/close timestamps; attempt cleanup while held; compare an explicit wait-for-close variant. Capture Windows error code/path and remaining entries. Preserve both assertion and cleanup errors rather than letting finally mask the first. The ignored `windows-probe-plan.md` specifies native Windows Node 24/26 diagnostics, one timed CIM snapshot and exact-PID cleanup. No workflow was edited or run.

Recursive rm is not atomic; an error can leave a partially removed tree. On a removal error, report retained/partially removed and never claim an intact preserved root. Windows cwd/open-handle behavior depends on handle sharing; not every open handle universally blocks deletion. Native locking behavior remains unmeasured here. The proof must precede any future removal attempt.

Node documents recursive rm retries for EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM with linear backoff; maxRetries defaults to 0 and retryDelay to 100 ms. These options are ignored without recursive mode. Retries cannot establish ownership or abandonment. [Node fs.rmSync](https://nodejs.org/api/fs.html#fsrmsyncpath-options).

## Focused runs on Node 22 and 26

Both installed binaries were executed in the sandbox with an invalid node.config.json and one inert test. Plain `node --test inert.test.mjs` passed on 22.22.3 and 26.4.0, demonstrating that neither loaded the config by default. Adding `--experimental-default-config-file` failed with exit 9 and invalid-content diagnostics on both. Explicit `--experimental-config-file` and `--import` are also opt-in; external NODE_OPTIONS can inject imports, but a repository file cannot silently establish that environment.

`--test-global-setup=./missing.mjs` is rejected as a bad option (exit 9) by installed 22.22.3; 26.4.0 recognizes it and fails resolving the intentionally missing module (exit 7). Thus the inherited wording must not imply global setup exists on Node 22.22.3. B9-R7's conclusion stands: plain node --test is unguarded; use the explicit wrapper. [Node 22.22.3 CLI](https://nodejs.org/download/release/v22.22.3/docs/api/cli.html), [Node 26.4.0 CLI](https://nodejs.org/download/release/v26.4.0/docs/api/cli.html).

## Backlog and classification boundary

A read-only direct-child listing of the real temp parent observed **34,013** current-user, non-symlink entries beginning ak-, grouped into 127 suffix-normalized prefixes. These raw counts include this research's own new root and concurrent activity; they are not removal candidates. The full per-prefix snapshot is `backlog-counts.json`, generated by retained `census.py`. Leading counts: ak-usage 2,520; ak-adapter-conformance-cli 2,301; ak-quota 2,152; ak-live-service 2,150; ak-adapter-consent 2,124; ak-intel-history 2,106; ak-adapter-grants 1,836; ak-stamp 1,525; ak-conformance-tiers-grants 1,512; ak-usage-solo 1,400; ak-host-cli 855; ak-host-project 855.

Task 13 must take a fresh snapshot after the last focused run. Direct children only, real absolute parent, current owner, no symlinks; exclude valid owner roots, product ak-sync-preview-npm roots, all paths found by one lsof snapshot, anything changed in 24 hours, and unattributed prefixes. A: before 2026-09-27 12:01 local runner landing; B: later attributable leaks; C: legacy ownerless suite roots. Keep all exclusion counts and script source, independently rederive counts, and submit literal paths for maintainer judgment. A missing lsof result due to error is incomplete evidence, not proof that nothing is in use. Idle orphans can evade lsof, so this remains a manual review list with no deletion authority.

## Decisions for Tasks 11–13

1. Implement one proveAbandoned interface with **abandoned=false, reason=cannot prove complete descendant exit** by default on macOS/Linux/Windows. Unit fixtures may exercise collector plumbing but cannot enable a production deletion path or constitute native platform proof.
2. Proposed owner fields: schema=1, random runId, absolute canonical root/temp parent, pid, startedAt milliseconds, hostname, platform, uid (null only when unavailable), proofMode=list-only. Validate schema, finite positive PID/timestamp, host/user identity, path and file type. Atomic record writing improves attribution only.
3. Retain B9-R4 path rules for own-root removal; refuse real home/filesystem-root temp bases before allocation, check absolute canonical direct parent, exact suite basename, lstat/non-symlink, POSIX owner. Unknown/error means refuse. List sibling roots without deleting them; do not change command/tripwire/leftover exit precedence (B9-R2).
4. Preserve synchronous runner and Ctrl-C/tool-kill behavior. Owner files are ignored in own leftovers. Interrupted runners remove nothing; completed runs retain current own-root semantics under B9-R1. Own-root cleanup is not a descendant-exit proof; the Windows lifetime regression must address unfinished children explicitly.
5. Task 12's list-only exit proof keeps a killed runner's root while its child lives **and after that child exits**. Do not execute the archived example's unconditional run-3 removal on a list-only platform. This follows B9-R5; controller was notified before dependent implementation.
6. B9-R1–R8 need no safety-rule relaxation. R7 has a factual clarification: global setup is unavailable in installed 22.22.3; config/import still require explicit opt-in. Task 13 remains report-only. Unresolved manual census and native Windows diagnostics stay visible; no claim of exhaustive leak causes or automatic backlog cleanup is justified.
