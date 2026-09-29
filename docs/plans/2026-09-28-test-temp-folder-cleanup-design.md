# Test temp folder cleanup design

## Status and decision

Research snapshot: 2026-09-28, `e2f9dcae0554ff63921df618a819fd5e6afe80d2`, macOS Darwin 27.0.0, Node 26.4.0; Node 22.22.3 used for CLI checks. Proposed behavior is **list-only for abandoned sibling roots on macOS, Linux and Windows**. No candidate establishes complete descendant liveness. This uses B9-R5's explicit fallback, preserves B9-R1–R8, and introduces no native sweeper or deletion authority.

The [execution plan](2026-09-28-runner-hygiene.md) maps subsequent work. Raw commands, JSON results, full lexical census, counts and literal experiment paths are retained in ignored `.superpowers/sdd/2026-09-28-runner-hygiene/`. No production/test code changed. Current creator lifecycles are fully classified below; native Windows/Linux behavior remains explicitly unmeasured.

## Verified runner and creator behavior

At `scripts/run-tests.mjs:57-85`, the runner creates a unique suite root, redirects all three temp variables, runs synchronous commands, reports leftovers and removes its root after commands finish, including failure. SIGKILL cannot reach this cleanup. The source has no owner record or sibling collector. It strips FORCE_COLOR only (`scripts/run-tests.mjs:68`); LQ-1's premise that this layer strips AQE_EMBEDDER variables is refuted at this revision. Downstream boundaries still need sentinel tests.

The completed AST and source census below classifies 647 creator sites across 279 files. The original 634-hit lexical inventory is superseded; two comment hits were excluded, three inline allocations and seven aliased calls were recovered, five sandboxConfigBase calls were added, and two executable child templates were retained separately.

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

Every site now has a current cleanup mechanism and evidence reference. This does not establish historical leak causality, successful native cleanup, or freedom from setup-before-registration gaps. The success-path classes identify assertion/error leak exposure; the parent-hook classes distinguish allocations already covered by enclosing cleanup.

## Child temp routing and paths outside the run root

The retained `temp-routing-sites.txt` records explicit temp-variable sites. `spawnEnv` places child temp under the supplied home; both it and redirectToolState remain beneath the outer suite when the home/base was created there. Nested runner refusal uses a temp base deliberately inside a disposable project (`tests/kit/run-tests-runner.test.mjs:119`); harvest redirects all three variables into its disposable repository (`tests/kit/agentdb-retirement.test.mjs:221-225`). Neither is a real repository escape. Chrome pins all four platform variables at `tests/ui/helpers/launch-chrome.mjs:22`.

The source does contain child environments that lose outer-root containment: the live AQE version probe at `tests/live/aqe-stop-hook-conformance.test.mjs:40` passes only PATH and NO_COLOR, so it does not inherit the runner's temp variables. Shell command-discovery probes at `tests/live/aqe-stop-hook-conformance.test.mjs:24` and `tests/live/aqe-codex-guidance-conformance.test.mjs:43` likewise use PATH-only environments. These are source-confirmed routing gaps, not measured folder leaks. Later live fixtures explicitly set TMPDIR but do not establish Windows TEMP/TMP containment. The proof-key guard test sets only TMPDIR (`tests/kit/aqe-live-proof-key-guard.test.mjs:24`); its expected early refusal does not make that a portable temp-isolation contract.

Literal Windows temp paths in ruflo-memory-location tests are injected path-classification inputs, not spawned child environments. dashboard-live-source's /tmp values are also parsing inputs. No cleanup design may assume every subprocess preserves the root simply because the top runner sets it.

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

## Completed creator census

The final census classifies **647 creator sites in 279 files, with zero unclassified current lifecycle sites**: 645 AST calls plus two executable child-template sites. It adds seven `makeTempDir` aliases, five sandboxConfigBase calls and three inline allocator definitions, and removes two comment-only lexical hits. Local factory invocations are represented by their allocator definition and caller contract, rather than counted as additional allocations. The retained AST/parser and manual override scripts reproduce the census without executing tests or tools.

This is a source lifecycle classification, not a guarantee that cleanup runs after SIGKILL or that recursive removal succeeds. Each returned fixture is traced to caller cleanup; mixed callers stay mixed. Assertions before hook registration were checked in the allocating scope, excluding callbacks that run later. `sandboxHome` and `sandboxProject` register **no** cleanup themselves; they must not inherit tempDir's safe-return contract. Allocation, setup and multiple cleanup operations can still throw before protection or skip a later cleanup.

| Code | Sites | Current lifecycle |
|---|---:|---|
| H | 130 | Shared helper registers cleanup before return; see temp-dir:19 or home-sandbox:176. |
| R | 168 | Local test/file hook registration; cleanup line shown. No preceding direct assert/assertSandboxed call in the allocating scope was found. |
| M | 87 | Module allocation with file hook; early imports/assertions can precede registration. |
| F | 113 | Removal in finally; setup before entering try remains exposed. |
| S | 68 | Direct cleanup reached only on normal execution, often after assertions. |
| CF | 20 | Factory returns root; callers remove in finally; pre-return setup remains exposed. |
| CH | 1 | Factory returns root; caller registers a hook; pre-registration setup remains exposed. |
| CM | 5 | Factory callers have mixed success-only/finally/hook lifecycles; exact examples in JSON. |
| O | 2 | Helper transfers ownership without registering cleanup; callers classified separately. |
| CS | 15 | Factory returns root; callers remove only on normal execution. |
| E | 6 | Process exit handler; normal exit only. |
| XS | 1 | Executable child template uses success-path cleanup. |
| XL | 1 | Executable child template deliberately leaks to exercise runner detection. |
| PE | 10 | Allocation covered transitively by enclosing private temp exit handler. |
| P | 15 | Allocation covered transitively by parent folder cleanup hook. |
| G | 2 | Root added to collection consumed by already registered/file cleanup hook. |
| C | 3 | Returns a cleanup method; construction failure handling and caller obligations described in JSON. |

Source index below uses `allocation line:code→cleanup/caller evidence line` within the named file. H and E also use the shared helper references in the legend. Full cleanup expressions, all evidence locations, caller notes and scope boundaries are in ignored `creator-lifecycle-final.json`; reproducible scripts are `ast-census.mjs`, `lifecycle.mjs`, `classify.py` and `render-census.py`. No site is deemed safe simply because its file contains an unrelated hook.

| Source file | Every creator site and lifecycle evidence |
|---|---|
| `tests/dashboard.test.cjs` | 19:E→helper; 70:PE→19 |
| `tests/kit/about-install-edits.test.mjs` | 11:M→12 |
| `tests/kit/about-security.test.mjs` | 10:M→11 |
| `tests/kit/adapter-admission.test.mjs` | 253:H→helper; 274:H→helper; 303:H→helper; 506:F→540 |
| `tests/kit/adapter-aqe-provider.test.mjs` | 89:CM→115,206,252; 247:H→helper; 350:H→helper; 498:F→514 |
| `tests/kit/adapter-conformance.test.mjs` | 127:S→240; 333:F→345; 356:F→369 |
| `tests/kit/adapter-execution.test.mjs` | 481:F→499 |
| `tests/kit/adapter-grants.test.mjs` | 16:H→helper; 169:H→helper |
| `tests/kit/adapter-hook-runner.test.mjs` | 197:F→208; 304:CS→305,313,320 |
| `tests/kit/adapter-integrity.test.mjs` | 48:F→61; 66:F→76; 81:F→96; 109:F→129; 134:F→152; 157:F→173; 158:F→174; 179:F→187 |
| `tests/kit/adapter-registries.test.mjs` | 74:H→helper |
| `tests/kit/adapter-sources.test.mjs` | 150:F→159; 171:F→182; 187:F→194; 199:F→208; 349:F→361; 367:F→376; 382:F→389; 395:F→402; 439:F→453; 458:F→470; 475:F→487; 492:F→505; 512:F→528 |
| `tests/kit/agent-browser-runtime.test.mjs` | 23:CS→23,88,126 |
| `tests/kit/agentdb-retirement.test.mjs` | 26:M→27; 40:M→41; 218:R→225 |
| `tests/kit/ak-launcher-evidence.test.mjs` | 17:H→helper |
| `tests/kit/aqe-embedding-probe.test.mjs` | 10:R→11 |
| `tests/kit/aqe-embedding-projection.test.mjs` | 14:R→15 |
| `tests/kit/aqe-embedding-transport.test.mjs` | 93:R→94; 109:R→110 |
| `tests/kit/aqe-guidance.test.mjs` | 38:R→39; 50:R→51; 71:H→helper |
| `tests/kit/aqe-lifecycle-migration.test.mjs` | 18:R→19 |
| `tests/kit/aqe-live-proof-key-guard.test.mjs` | 15:H→helper |
| `tests/kit/aqe-project-pin.test.mjs` | 24:H→helper; 283:H→helper; 349:H→helper |
| `tests/kit/aqe-readiness.test.mjs` | 11:F→17 |
| `tests/kit/aqe-store-holders.test.mjs` | 28:H→helper; 39:H→helper; 47:H→helper; 57:H→helper; 78:H→helper; 93:H→helper; 131:H→helper; 149:H→helper; 157:H→helper; 167:H→helper; 183:H→helper; 196:H→helper |
| `tests/kit/aqe-store-merge-fixture.test.mjs` | 30:H→helper; 49:H→helper; 71:H→helper |
| `tests/kit/aqe-store-merge-preview.test.mjs` | 44:H→helper |
| `tests/kit/aqe-store-merge.test.mjs` | 174:H→helper |
| `tests/kit/blocks-drift-parity.test.mjs` | 19:M→20; 30:M→31,36 |
| `tests/kit/blocks-dual-mode.test.mjs` | 33:S→53; 58:S→74; 79:S→96 |
| `tests/kit/blocks.test.mjs` | 99:S→106; 110:S→135; 139:S→146; 178:S→185; 189:S→199 |
| `tests/kit/brain-held-refresh-sync.test.mjs` | 21:M→36; 31:M→36 |
| `tests/kit/brain-held-refresh.test.mjs` | 13:M→14 |
| `tests/kit/claude-env-projection.test.mjs` | 13:R→15; 14:R→15 |
| `tests/kit/claude-window-ledger.test.mjs` | 14:H→helper |
| `tests/kit/clean-machine-setup.test.mjs` | 14:S→46; 50:S→76 |
| `tests/kit/cli-help.test.mjs` | 13:M→14 |
| `tests/kit/cli-json-honesty.test.mjs` | 16:M→18; 17:M→18 |
| `tests/kit/codex-context-command.test.mjs` | 7:M→67 |
| `tests/kit/codex-context.test.mjs` | 11:R→12 |
| `tests/kit/codex-mcp-convergence.test.mjs` | 11:M→12; 23:M→24 |
| `tests/kit/codex-mcp.test.mjs` | 14:CF→18,38,46; 94:F→126; 131:F→145; 150:F→164; 169:F→178; 183:F→196; 201:F→219; 224:F→256; 261:F→297; 302:F→327; 332:F→354; 360:F→398 |
| `tests/kit/codex-plugins.test.mjs` | 10:M→269; 214:F→231 |
| `tests/kit/codex-state.test.mjs` | 13:H→helper |
| `tests/kit/codex-statusline.test.mjs` | 13:G→14,103 |
| `tests/kit/codex-usage-diagnostic.test.mjs` | 13:R→14 |
| `tests/kit/conformance-tiers.test.mjs` | 24:H→helper; 260:H→helper; 298:H→helper; 317:H→helper; 355:H→helper; 389:H→helper; 673:H→helper |
| `tests/kit/context-audit.test.mjs` | 151:F→178 |
| `tests/kit/daemon-sweep-evidence.test.mjs` | 33:H→helper; 49:F→54 |
| `tests/kit/daemons-status.test.mjs` | 11:R→12 |
| `tests/kit/dashboard-context-hooks.test.mjs` | 203:F→262; 267:F→304 |
| `tests/kit/dashboard-hermetic-defaults.test.mjs` | 15:M→16; 56:P→14,16,56 |
| `tests/kit/dashboard-intel-integration.test.mjs` | 129:H→helper |
| `tests/kit/dashboard-project-identity.test.mjs` | 16:R→17 |
| `tests/kit/dashboard-status-cost.test.mjs` | 27:F→75; 29:F→76 |
| `tests/kit/dashboard-status-inprocess.test.mjs` | 36:CF→48,101,104; 38:CF→48,101,104 |
| `tests/kit/deja-vu-lifecycle.test.mjs` | 17:H→helper |
| `tests/kit/deja-vu-teardown-verify.test.mjs` | 15:M→503 |
| `tests/kit/deja-vu.test.mjs` | 160:F→197; 202:F→237; 242:F→277; 282:F→339; 344:F→359 |
| `tests/kit/dispatch-surface.test.mjs` | 79:H→helper |
| `tests/kit/disposable-memory-project.test.mjs` | 40:R→41; 130:R→131 |
| `tests/kit/drift-freshness.test.mjs` | 16:M→17; 26:M→27 |
| `tests/kit/dry-run-nudge.test.mjs` | 26:CF→43,64,65; 28:CF→43,64,65; 37:CF→43,64,65 |
| `tests/kit/evidence.test.mjs` | 9:M→231 |
| `tests/kit/exec-kill-tree.test.mjs` | 23:R→24; 81:R→82 |
| `tests/kit/exec.test.mjs` | 93:F→111; 147:F→185; 190:F→215; 222:F→234 |
| `tests/kit/execution-runner.test.mjs` | 470:H→helper |
| `tests/kit/external-lifecycle.test.mjs` | 31:M→445; 172:F→188; 193:F→209; 214:F→230; 235:F→251; 258:F→271; 276:F→288; 293:F→306; 313:F→328; 335:F→356; 369:F→440; 370:F→441 |
| `tests/kit/file-identity-bigint.test.mjs` | 151:H→helper |
| `tests/kit/footprint-collectors.test.mjs` | 50:R→51 |
| `tests/kit/footprint-executable-paths.test.mjs` | 9:R→10 |
| `tests/kit/footprint-known-files.test.mjs` | 12:F→19 |
| `tests/kit/footprint-observation-forest.test.mjs` | 11:R→12 |
| `tests/kit/footprint-performance.test.mjs` | 20:R→21 |
| `tests/kit/footprint-projects.test.mjs` | 44:R→45 |
| `tests/kit/footprint-snapshot-v2.test.mjs` | 12:R→13 |
| `tests/kit/footprint-stack.test.mjs` | 47:R→48 |
| `tests/kit/guidance-targets.test.mjs` | 34:S→40; 74:S→82; 88:S→95; 100:S→109; 101:S→110; 239:S→259; 265:S→279; 283:S→296 |
| `tests/kit/heal-natives.test.mjs` | 30:H→helper; 34:H→helper; 52:H→helper; 114:H→helper; 139:H→helper; 150:H→helper; 166:H→helper; 214:H→helper; 254:H→helper; 277:H→helper; 297:H→helper |
| `tests/kit/helper-stamp.test.mjs` | 85:H→helper |
| `tests/kit/helpers/aqe-store-merge-fixture.mjs` | 14:H→helper |
| `tests/kit/helpers/aqe-store-merge-harness.mjs` | 119:H→helper |
| `tests/kit/helpers/codex-rollout.mjs` | 130:H→helper |
| `tests/kit/helpers/home-sandbox.mjs` | 110:C→124,125,129; 140:O→139,158,303; 169:R→181; 304:O→139,158,303 |
| `tests/kit/helpers/private-tmpdir.cjs` | 12:E→16 |
| `tests/kit/helpers/project-isolation.mjs` | 117:R→122 |
| `tests/kit/helpers/temp-dir.mjs` | 17:H→18,19,20 |
| `tests/kit/home-sandbox-tripwire.test.mjs` | 19:R→20; 27:XS→49,50,63 |
| `tests/kit/hook-audit-hosts.test.mjs` | 21:CF→138,139,164 |
| `tests/kit/hook-audit.test.mjs` | 20:CF→61,62,90 |
| `tests/kit/hook-auto-memory-retirement.test.mjs` | 123:CF→176,177,192 |
| `tests/kit/hook-legacy-retirement.test.mjs` | 84:CF→125,126,157 |
| `tests/kit/hook-remediation-cli.test.mjs` | 27:F→83; 88:F→141 |
| `tests/kit/hook-remediation.test.mjs` | 30:CF→68,69,98; 104:F→164; 169:F→204; 240:F→274; 279:F→305; 432:F→456; 481:F→506; 531:F→537; 542:F→553 |
| `tests/kit/hook-upstream.test.mjs` | 17:F→25 |
| `tests/kit/host-adapters-cli.test.mjs` | 77:H→helper; 754:H→helper |
| `tests/kit/host-alignment.test.mjs` | 7:M→8; 9:M→10; 11:M→12 |
| `tests/kit/host-cli-migration.test.mjs` | 13:H→helper; 14:H→helper |
| `tests/kit/host-dry-run.test.mjs` | 38:R→39; 41:R→42 |
| `tests/kit/host-executable.test.mjs` | 9:H→helper |
| `tests/kit/host-health-connected.test.mjs` | 202:R→203 |
| `tests/kit/host-health-evidence.test.mjs` | 9:R→10; 29:R→30; 39:R→40 |
| `tests/kit/host-readiness-local.test.mjs` | 9:R→12 |
| `tests/kit/host-setup-evidence.test.mjs` | 28:H→helper; 44:F→52 |
| `tests/kit/hosts.test.mjs` | 152:H→helper |
| `tests/kit/install-edits.test.mjs` | 21:R→22 |
| `tests/kit/integration-command-facts.test.mjs` | 9:M→10 |
| `tests/kit/intel-history.test.mjs` | 21:H→helper |
| `tests/kit/intelligence-picker-groups.test.mjs` | 51:R→52; 67:R→68 |
| `tests/kit/intelligence-table-groups.test.mjs` | 10:R→11 |
| `tests/kit/intelligence-watch.test.mjs` | 8:H→helper |
| `tests/kit/language-coverage.test.mjs` | 10:R→10 |
| `tests/kit/live-check-evidence.test.mjs` | 15:M→260; 25:M→260 |
| `tests/kit/live-checks.test.mjs` | 21:M→688; 30:M→688; 401:F→415; 421:R→422; 440:F→449; 468:R→469; 701:R→702; 733:R→734 |
| `tests/kit/live-core.test.mjs` | 149:H→helper; 178:H→helper; 202:H→helper; 226:H→helper; 248:H→helper; 263:H→helper; 274:H→helper; 275:H→helper; 288:H→helper; 299:H→helper; 309:H→helper |
| `tests/kit/live-folder-correlator.test.mjs` | 14:R→15 |
| `tests/kit/live-process-sessions.test.mjs` | 250:F→293; 299:F→314 |
| `tests/kit/live-qe-contract.test.mjs` | 40:H→helper |
| `tests/kit/live-service.test.mjs` | 9:H→helper |
| `tests/kit/live-tailer.test.mjs` | 9:H→helper; 150:H→helper |
| `tests/kit/live-transcript.test.mjs` | 15:H→helper |
| `tests/kit/maintenance-action-service.test.mjs` | 25:R→26 |
| `tests/kit/maintenance-cli.test.mjs` | 15:H→helper |
| `tests/kit/maintenance-dashboard-api.test.mjs` | 600:R→601 |
| `tests/kit/maintenance-dashboard-e2e.test.mjs` | 177:R→179 |
| `tests/kit/maintenance-discovery-checkpoint.test.mjs` | 14:R→15 |
| `tests/kit/maintenance-discovery-configuration.test.mjs` | 21:R→22 |
| `tests/kit/maintenance-discovery-coverage.test.mjs` | 15:R→16 |
| `tests/kit/maintenance-discovery-orchestrator.test.mjs` | 23:R→24; 649:R→650 |
| `tests/kit/maintenance-discovery-preview.test.mjs` | 17:R→18 |
| `tests/kit/maintenance-git-project-patch.test.mjs` | 26:R→27; 41:R→42; 178:R→179 |
| `tests/kit/maintenance-host-alignment.test.mjs` | 6:M→7; 8:M→9 |
| `tests/kit/maintenance-interruption-audit.test.mjs` | 21:R→22 |
| `tests/kit/maintenance-management-activity.test.mjs` | 15:H→helper; 149:H→helper |
| `tests/kit/maintenance-management-procedures.test.mjs` | 21:R→22 |
| `tests/kit/maintenance-management-service.test.mjs` | 42:R→43 |
| `tests/kit/maintenance-native-findings.test.mjs` | 24:R→25 |
| `tests/kit/maintenance-one-action.test.mjs` | 20:R→21 |
| `tests/kit/maintenance-owned-providers.test.mjs` | 25:R→26 |
| `tests/kit/maintenance-persistence-support.test.mjs` | 22:R→23 |
| `tests/kit/maintenance-project-kind.test.mjs` | 13:R→14 |
| `tests/kit/maintenance-read-model.test.mjs` | 87:R→88; 104:R→105; 144:R→145; 187:R→188; 205:R→206; 236:R→237; 251:R→252; 269:R→270 |
| `tests/kit/maintenance-recovery.test.mjs` | 20:R→21 |
| `tests/kit/maintenance-transaction.test.mjs` | 19:R→20 |
| `tests/kit/mcp-scopes.test.mjs` | 21:R→26 |
| `tests/kit/mcp-tool-call.test.mjs` | 64:R→65 |
| `tests/kit/memory-maintenance.test.mjs` | 17:R→18 |
| `tests/kit/memory-probe-cleanup.test.mjs` | 16:M→17,186; 59:R→60 |
| `tests/kit/model-dashboard-read-model.test.mjs` | 553:F→604; 609:F→645 |
| `tests/kit/model-inventory-store.test.mjs` | 27:CS→38,60,73 |
| `tests/kit/natives-probe.test.mjs` | 16:CF→31,40,52 |
| `tests/kit/natives-runtime.test.mjs` | 23:H→helper; 26:CM→39,47,57; 74:S→82 |
| `tests/kit/natives.test.mjs` | 13:CS→29,41,47; 33:S→35; 53:S→60; 68:S→79; 88:S→95; 99:S→106; 110:S→113; 117:CF→128,130,143 |
| `tests/kit/node-runtime.test.mjs` | 23:H→helper |
| `tests/kit/npx.test.mjs` | 33:CS→40,47,54; 109:S→116 |
| `tests/kit/nudge.test.mjs` | 15:H→helper |
| `tests/kit/opencode-agents-stale-reason.test.mjs` | 25:M→39; 35:M→39 |
| `tests/kit/opencode-aqe-embedding.test.mjs` | 9:R→10 |
| `tests/kit/opencode-ruflo-gateway.test.mjs` | 8:CF→9,237,238 |
| `tests/kit/opencode-state-hermeticity.test.mjs` | 27:F→32; 43:R→44 |
| `tests/kit/opencode-stock-ruflo-gateway.test.mjs` | 33:CH→280,289,297 |
| `tests/kit/opencode-version-drift.test.mjs` | 14:M→56 |
| `tests/kit/opencode.test.mjs` | 20:M→21; 23:P→20,21,23 |
| `tests/kit/output-progress.test.mjs` | 119:H→helper |
| `tests/kit/owned-env-backup-prune.test.mjs` | 13:M→14 |
| `tests/kit/owned-env-projection.test.mjs` | 11:R→12; 131:R→132 |
| `tests/kit/paths-global-root-evidence.test.mjs` | 37:H→helper; 156:H→helper; 159:F→198 |
| `tests/kit/paths-global-root.test.mjs` | 94:F→106; 111:F→117 |
| `tests/kit/project-census.test.mjs` | 27:H→helper |
| `tests/kit/project-guidance.test.mjs` | 20:R→21 |
| `tests/kit/project-isolation.test.mjs` | 27:R→28 |
| `tests/kit/project-memory-status.test.mjs` | 11:R→12; 37:R→38; 83:R→92; 118:R→119; 139:R→140; 156:R→157; 170:R→171; 195:R→196; 211:R→212; 235:R→236; 328:R→329 |
| `tests/kit/project-memory.test.mjs` | 11:M→51,65,79; 82:R→83; 98:R→99; 107:R→108; 120:R→121; 133:R→134; 143:R→144; 160:R→168; 190:R→191; 201:R→202; 222:R→223; 269:R→270; 283:R→284 |
| `tests/kit/project-sources-imports.test.mjs` | 21:R→22 |
| `tests/kit/prompts-mainline-boundary.test.mjs` | 14:F→22 |
| `tests/kit/provider-cli.test.mjs` | 51:CS→86,103,109; 62:CS→86,103,109; 193:CF→297,335,336; 215:CF→297,335,336 |
| `tests/kit/provider-credentials.test.mjs` | 24:M→25; 33:P→24,25,33; 40:S→42 |
| `tests/kit/provider-refresh-cli.test.mjs` | 28:CS→48,84,89; 43:CS→48,84,89 |
| `tests/kit/provider-teardown-preservation.test.mjs` | 9:R→11 |
| `tests/kit/providers-drift-parity.test.mjs` | 22:M→113; 62:R→63; 96:R→97 |
| `tests/kit/providers-external.test.mjs` | 22:G→16,18,23 |
| `tests/kit/providers.test.mjs` | 170:CS→175,193,210; 178:S→180; 371:S→378; 437:F→466; 475:S→483 |
| `tests/kit/qeCourt.test.mjs` | 214:S→216; 220:S→226; 230:F→253; 257:F→279; 283:R→284 |
| `tests/kit/quota-codex-presence.test.mjs` | 18:M→25 |
| `tests/kit/quota.test.mjs` | 17:H→helper |
| `tests/kit/real-state-tripwire.test.mjs` | 16:R→17 |
| `tests/kit/reference-command.test.mjs` | 11:M→64; 19:F→60 |
| `tests/kit/refresh.test.mjs` | 17:M→19; 18:M→19 |
| `tests/kit/reverse-bridge.test.mjs` | 10:H→helper; 67:H→helper |
| `tests/kit/routing-config.test.mjs` | 147:S→176; 180:S→189; 193:S→211 |
| `tests/kit/routing-projection.test.mjs` | 13:CS→17,49,50; 21:CS→17,49,50 |
| `tests/kit/routing-retirement-convergence.test.mjs` | 29:M→30; 109:R→110,124; 128:R→129,154; 165:R→166,185 |
| `tests/kit/ruflo-components-apply.test.mjs` | 132:R→133; 164:R→165; 189:R→190; 211:R→212; 234:R→235; 245:R→246; 262:R→263; 276:R→277 |
| `tests/kit/ruflo-components-catalogue.test.mjs` | 81:R→82 |
| `tests/kit/ruflo-components-convergence.test.mjs` | 12:M→13; 42:R→43; 197:R→198; 213:R→214 |
| `tests/kit/ruflo-components-env.test.mjs` | 15:R→16 |
| `tests/kit/ruflo-components-evidence-location.test.mjs` | 6:M→18 |
| `tests/kit/ruflo-components-evidence.test.mjs` | 67:R→68; 188:R→189 |
| `tests/kit/ruflo-components-git-exclude.test.mjs` | 19:H→helper; 33:R→34; 100:R→101 |
| `tests/kit/ruflo-components-hosts.test.mjs` | 19:R→20; 45:R→46; 142:R→143; 161:F→170 |
| `tests/kit/ruflo-components-snapshot.test.mjs` | 194:F→210 |
| `tests/kit/ruflo-daemon-config.test.mjs` | 19:R→20 |
| `tests/kit/ruflo-mcp-launcher.test.mjs` | 21:R→22; 83:R→84 |
| `tests/kit/ruflo-memory-location.test.mjs` | 19:R→20; 50:R→51 |
| `tests/kit/ruflo-memory-root-pin.test.mjs` | 24:R→25 |
| `tests/kit/ruflo-memory.test.mjs` | 11:F→31; 39:R→40 |
| `tests/kit/run-tests-runner.test.mjs` | 15:R→16; 108:XL→16,110 |
| `tests/kit/ruvector.test.mjs` | 18:M→214; 25:M→214 |
| `tests/kit/ruvnet-brain-plugin.test.mjs` | 10:R→11 |
| `tests/kit/ruvnet-brain.test.mjs` | 87:H→helper; 118:H→helper; 181:H→helper; 196:H→helper; 213:H→helper; 222:H→helper; 238:H→helper; 257:H→helper |
| `tests/kit/rvf.test.mjs` | 22:CS→49,56,64 |
| `tests/kit/scaffold.test.mjs` | 19:CF→34,42,52; 25:CF→34,42,52; 85:F→91; 143:F→157 |
| `tests/kit/security-status.test.mjs` | 12:M→13 |
| `tests/kit/settings-config.test.mjs` | 12:S→19; 29:S→34; 38:S→45; 49:S→57; 61:S→67; 71:S→77; 81:S→99; 103:S→119; 130:S→141; 146:S→153; 178:S→188; 192:S→197; 201:S→209; 213:S→224; 228:S→234 |
| `tests/kit/setup-command.test.mjs` | 19:M→104,775; 122:S→136; 191:S→197; 208:S→220; 225:S→239; 474:F→484; 489:F→506; 512:F→541; 546:F→588; 593:S→601; 606:S→622; 607:P→775; 627:P→775; 783:S→798; 803:S→811 |
| `tests/kit/setup-host-flags.test.mjs` | 103:S→107 |
| `tests/kit/setup-memory-probe.test.mjs` | 26:R→27; 83:R→84 |
| `tests/kit/spawn-env-guard.test.mjs` | 176:R→177 |
| `tests/kit/sqlite.test.mjs` | 18:S→27; 31:S→42; 46:S→60 |
| `tests/kit/status-agent-browser.test.mjs` | 13:R→17 |
| `tests/kit/status-aqe-drift.test.mjs` | 17:M→18; 58:R→59; 71:R→72; 83:R→84; 103:H→helper; 127:R→128; 145:R→146; 160:R→161; 171:R→172 |
| `tests/kit/status-command.test.mjs` | 19:M→1451; 29:M→386,536,671; 340:F→387 |
| `tests/kit/status-golden.test.mjs` | 21:M→22; 29:M→30 |
| `tests/kit/status-live.test.mjs` | 17:M→267; 31:M→144,267; 125:F→144 |
| `tests/kit/status-manual-fixes.test.mjs` | 17:M→28; 27:M→28 |
| `tests/kit/status-repair-contract.test.mjs` | 17:M→18; 30:M→31,146 |
| `tests/kit/status-setup-hints.test.mjs` | 14:M→38,62; 22:M→62; 23:P→14,23,62 |
| `tests/kit/status-version-drift-refresh.test.mjs` | 27:M→40; 37:M→40; 47:P→40,47 |
| `tests/kit/status-viability.test.mjs` | 24:M→347; 35:M→347 |
| `tests/kit/status-zero-spawn.test.mjs` | 41:F→54; 43:F→55 |
| `tests/kit/statusline-config-dir-parity.test.mjs` | 42:H→helper |
| `tests/kit/statusline-version.test.mjs` | 20:M→212; 62:P→62,212 |
| `tests/kit/statusline.test.mjs` | 22:M→23; 44:H→helper |
| `tests/kit/sync-command.test.mjs` | 20:M→35,1320; 31:M→1320 |
| `tests/kit/sync-daemon-repair.test.mjs` | 16:M→17; 27:CF→46,61,76 |
| `tests/kit/sync-dry-run-preview.test.mjs` | 20:M→42; 33:M→42; 183:P→40,42,339; 184:P→40,42,339; 254:P→40,42,339; 325:P→40,42,339; 339:P→40,42,339 |
| `tests/kit/sync-host-repair.test.mjs` | 5:M→6 |
| `tests/kit/sync-needs-your-action.test.mjs` | 25:M→26; 35:M→36 |
| `tests/kit/sync-self-freshness.test.mjs` | 10:M→11 |
| `tests/kit/sync-skip-versions.test.mjs` | 22:M→43; 34:M→43; 107:P→41,43,107 |
| `tests/kit/system-command.test.mjs` | 21:H→helper; 22:H→helper |
| `tests/kit/system-summary.test.mjs` | 644:H→helper; 666:H→helper |
| `tests/kit/telemetry-cli.test.mjs` | 15:R→16; 19:H→helper |
| `tests/kit/telemetry-source-bounds.test.mjs` | 19:R→20 |
| `tests/kit/temp-dir-helper.test.mjs` | 10:H→helper |
| `tests/kit/uninstall-command.test.mjs` | 18:M→493; 170:S→187; 192:S→203; 449:CS→448,452,474; 458:S→474; 501:S→519; 507:S→519 |
| `tests/kit/upstream-watch-fixtures.mjs` | 31:F→48 |
| `tests/kit/upstream-watch-ledger-branch.test.mjs` | 128:F→167 |
| `tests/kit/upstream-watch-registry.test.mjs` | 30:F→38 |
| `tests/kit/upstream-watch-script.test.mjs` | 878:F→904 |
| `tests/kit/usage-audit-211.test.mjs` | 15:R→16 |
| `tests/kit/usage-claude-dedup.test.mjs` | 193:H→helper |
| `tests/kit/usage-cli.test.mjs` | 16:H→helper |
| `tests/kit/usage-codex-large-rollout.test.mjs` | 22:H→helper |
| `tests/kit/usage-deps-contract.test.mjs` | 42:H→helper |
| `tests/kit/usage-git-projects.test.mjs` | 37:R→38 |
| `tests/kit/usage-index-claude-window.test.mjs` | 31:CM→70,81,138 |
| `tests/kit/usage-index-opencode.test.mjs` | 15:CM→118,130,268 |
| `tests/kit/usage-index-v6.test.mjs` | 87:H→helper |
| `tests/kit/usage-index.test.mjs` | 33:H→helper; 66:H→helper; 929:H→helper; 970:H→helper |
| `tests/kit/usage-local-pricing.test.mjs` | 20:CF→126,133,173 |
| `tests/kit/usage-opencode.test.mjs` | 14:CM→95,137,325 |
| `tests/kit/usage-openrouter.test.mjs` | 13:CS→137,192,211 |
| `tests/kit/usage-project-groups.test.mjs` | 81:R→82 |
| `tests/kit/usage-truncation.test.mjs` | 43:H→helper |
| `tests/kit/verify-memory-routes.test.mjs` | 91:M→92; 96:M→97; 106:H→helper; 157:H→helper; 217:R→219; 218:P→217,218,219 |
| `tests/kit/version-lookup-record.test.mjs` | 22:M→41 |
| `tests/kit/versions.test.mjs` | 112:F→126 |
| `tests/kit/working-context.test.mjs` | 9:R→10 |
| `tests/live/aqe-codex-guidance-conformance.test.mjs` | 84:R→85 |
| `tests/live/aqe-external-provider-transport.test.mjs` | 258:R→280 |
| `tests/live/aqe-stop-hook-conformance.test.mjs` | 44:R→45 |
| `tests/live/codex-context-contract.test.mjs` | 16:R→17 |
| `tests/live/disposable-memory-project.mjs` | 49:C→41,43,57 |
| `tests/live/ruflo-memory-routing.test.mjs` | 26:M→28 |
| `tests/statusline-brain.test.cjs` | 18:E→helper; 41:PE→18 |
| `tests/statusline-segments.test.cjs` | 19:E→helper; 64:PE→19; 346:PE→19; 380:PE→19 |
| `tests/statusline-window-ledger.test.cjs` | 21:E→helper; 45:F→54; 176:PE→21; 186:PE→21 |
| `tests/ui/dashboard-ui.mjs` | 68:E→helper; 162:PE→68; 1102:PE→68; 1103:PE→68 |
| `tests/ui/helpers/launch-chrome.mjs` | 20:C→21,29,31 |

## Decisions for Tasks 11–13

1. Implement one proveAbandoned interface with **abandoned=false, reason=cannot prove complete descendant exit** by default on macOS/Linux/Windows. Unit fixtures may exercise collector plumbing but cannot enable a production deletion path or constitute native platform proof.
2. Proposed owner fields: schema=1, random runId, absolute canonical root/temp parent, pid, startedAt milliseconds, hostname, platform, uid (null only when unavailable), proofMode=list-only. Validate schema, finite positive PID/timestamp, host/user identity, path and file type. Atomic record writing improves attribution only.
3. Retain B9-R4 path rules for own-root removal; refuse real home/filesystem-root temp bases before allocation, check absolute canonical direct parent, exact suite basename, lstat/non-symlink, POSIX owner. Unknown/error means refuse. List sibling roots without deleting them; do not change command/tripwire/leftover exit precedence (B9-R2).
4. Preserve synchronous runner and Ctrl-C/tool-kill behavior. Owner files are ignored in own leftovers. Interrupted runners remove nothing; completed runs retain current own-root semantics under B9-R1. Own-root cleanup is not a descendant-exit proof; the Windows lifetime regression must address unfinished children explicitly.
5. Task 12's list-only exit proof keeps a killed runner's root while its child lives **and after that child exits**. Do not execute the archived example's unconditional run-3 removal on a list-only platform. This follows B9-R5; controller was notified before dependent implementation.
6. B9-R1–R8 need no safety-rule relaxation. R7 has a factual clarification: global setup is unavailable in installed 22.22.3; config/import still require explicit opt-in. Task 13 remains report-only. Native Windows diagnostics and historical-cause limitations stay visible; no claim of exhaustive leak causes or automatic backlog cleanup is justified.
