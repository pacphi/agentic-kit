# Windows CI historical cohort and current timing gate

Capture: 2026-09-29; compiled from retained GitHub job metadata, without new CI runs.
Documentation basis: `b5a0a946ae0aca2e1d435c78b12a98bc587d1266`.

## Fixed historical cohort

Preserve the ten before runs and the ten after runs, ending at run **36582013896**. These are fixed historical observations, not the current/latest ten runs. The complete observations appear below; retained controller JSON binds workload inputs and ancestry checks.

| Cohort | Node | All-job median s | Noncancelled median s | Successful-job median s | Success / failure / cancelled |
| --- | --- | ---: | ---: | ---: | --- |
| Before | 22 | 649 | 659 | 659 | 9 / 0 / 1 |
| Before | 24 | 705.5 | 723 | 705.5 | 8 / 1 / 1 |
| Before | 26 | 875 | 888 | 888 | 9 / 0 / 1 |
| Fixed after | 22 | 221.5 | 221.5 | 240 | 7 / 3 / 0 |
| Fixed after | 24 | 225 | 225 | 215 | 7 / 3 / 0 |
| Fixed after | 26 | 210 | 210 | 210 | 7 / 3 / 0 |

All-job medians in the earlier private draft are correct. Its “Median completed jobs” column mixes definitions: before excludes cancelled jobs but includes failure; after excludes failures. Rename/split the column as above. Cancelled observations are partial elapsed time, not completed workload performance. The after cohort includes three failed workflows and maximum Windows duration 359 s; preserve both. The earlier mixed after cohort containing pre-V1 run 36519742714 remains provenance, not a pure post-V1 comparison. Different source/workload/runner states prevent a controlled causal speedup claim.

All ten fixed after heads independently passed local `git merge-base --is-ancestor ab2fc5cb5104c2cf260fb9e3ff1721bd3b074202 <head>` (exit 0). No object fetch was needed.

## Separate current PR timing gate snapshot

The approved source plan `docs/plans/2026-09-28-remediation-program-v2.md:261` says “three consecutive PR runs with every Windows leg under 5 minutes.” Selected the newest three distinct completed `pull_request` runs for `.github/workflows/ci.yml` in creation order, with no outcome or branch filtering. Latest attempt per run; all three are attempt 1. Snapshot: 2026-09-29T19:20:24Z, from a repository-wide inventory of 100 entries; full head hashes appear below.

| Run (newest first) | Head | Windows 22 s | Windows 24 s | Windows 26 s | Workflow |
| --- | --- | ---: | ---: | ---: | --- |
| [36616775739](https://github.com/pacphi/agentic-kit/actions/runs/36616775739) | 09b198b6960c2dae14819d08729caa8b3794129b | 245 | 227 | 254 | success |
| [36614260309](https://github.com/pacphi/agentic-kit/actions/runs/36614260309) | fa0cb7b788791a90577a2dfd9f9ca61e07d0591e | 239 | 233 | 262 | success |
| [36612394617](https://github.com/pacphi/agentic-kit/actions/runs/36612394617) | 87234bdb2499200ce3fbe280894f6bb7ace74cde | 187 | **358** | 241 | **failure** |

All nine Windows jobs completed successfully; all three heads pass the same V1 ancestry check. The third run failed on `test (macos-latest, node 22)`. Its Windows Node 24 duration independently violates the literal timing gate. Therefore this snapshot supports **two consecutive qualifying PR runs, not three**, and **two green workflows, not three**. Keep the failed third run. Refresh this separate gate after V7 PR CI; do not replace historical cohort membership.

Raw per-run metadata and complete latest-attempt job lists are saved as `<run>-run.json` and `<run>-jobs.json`; total_count matched fetched job count for each. Job records bind URLs, start/end timestamps, duration, status, conclusion, attempt and head. Durations exclude queue time.

API caveat: querying `actions/workflows/ci.yml/runs` returned a stale September 28 subset. The repository-wide `actions/runs?event=pull_request&status=completed&per_page=100` inventory correctly includes September 29 runs with workflow ID 313185208 and exact path `.github/workflows/ci.yml`; use that inventory plus attempt-specific job endpoints for refresh. Do not infer PR identity from the empty `pull_requests` arrays.

## Complete fixed observations

Cells retain seconds and conclusion for each Windows Node job. Full heads bind source;
job links retain timestamps and runner metadata. Cancelled values are partial elapsed times.

| Cohort | Run | Source head | Node 22 | Node 24 | Node 26 |
| --- | --- | --- | --- | --- | --- |
| before | [36512746752](https://github.com/pacphi/agentic-kit/actions/runs/36512746752) | `ec7497179a2a6321ce2906b4346d5720ba50cba2` | [832 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512746752/job/109228289572) | [588 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512746752/job/109228289560) | [695 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512746752/job/109228289704) |
| before | [36512738230](https://github.com/pacphi/agentic-kit/actions/runs/36512738230) | `bd8335748fbf117147a930322d3cc032009dfce2` | [604 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512738230/job/109228262744) | [752 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512738230/job/109228262957) | [968 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512738230/job/109228263062) |
| before | [36512520521](https://github.com/pacphi/agentic-kit/actions/runs/36512520521) | `7936ca48942e4ed1b629641eb61dc0dfbcf12951` | [639 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512520521/job/109227580342) | [591 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512520521/job/109227580275) | [1027 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36512520521/job/109227580466) |
| before | [36507895935](https://github.com/pacphi/agentic-kit/actions/runs/36507895935) | `4d654d81dbaf59b475ff86d77e7a7ed3d10d4caa` | [755 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507895935/job/109213354743) | [688 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507895935/job/109213354777) | [776 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507895935/job/109213354580) |
| before | [36507430463](https://github.com/pacphi/agentic-kit/actions/runs/36507430463) | `4f4f0201527952a99e4d5c165dd37c6a94cbc334` | [469 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507430463/job/109211906632) | [512 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507430463/job/109211906387) | [862 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507430463/job/109211906551) |
| before | [36507067003](https://github.com/pacphi/agentic-kit/actions/runs/36507067003) | `174e5032e2dc36b8280941bc98593da18280e234` | [187 s, cancelled](https://github.com/pacphi/agentic-kit/actions/runs/36507067003/job/109210765385) | [157 s, cancelled](https://github.com/pacphi/agentic-kit/actions/runs/36507067003/job/109210765383) | [149 s, cancelled](https://github.com/pacphi/agentic-kit/actions/runs/36507067003/job/109210765403) |
| before | [36507043837](https://github.com/pacphi/agentic-kit/actions/runs/36507043837) | `b3761ba62f8b6253b3908a25c677a4ebbb565663` | [711 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507043837/job/109210682350) | [723 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507043837/job/109210682327) | [525 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36507043837/job/109210682409) |
| before | [36506687833](https://github.com/pacphi/agentic-kit/actions/runs/36506687833) | `2992c93c92ce1d8ea84f26283d6ccac2d146c8ee` | [607 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36506687833/job/109209580335) | [743 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36506687833/job/109209580181) | [1044 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36506687833/job/109209580209) |
| before | [36506455012](https://github.com/pacphi/agentic-kit/actions/runs/36506455012) | `e7cfe9ca4d49cb5e94fba698cd0e8376e0c829b7` | [659 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36506455012/job/109208858912) | [1413 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36506455012/job/109208858930) | [888 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36506455012/job/109208858967) |
| before | [36505126704](https://github.com/pacphi/agentic-kit/actions/runs/36505126704) | `c959db36a9c01e0a6454fb3386747bbe908971ea` | [795 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36505126704/job/109204728092) | [1243 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36505126704/job/109204728189) | [1088 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36505126704/job/109204728047) |
| after | [36582013896](https://github.com/pacphi/agentic-kit/actions/runs/36582013896) | `bb2e7efe88abd3cb2d73baf26530386549e3dc2e` | [247 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36582013896/job/109452341642) | [235 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36582013896/job/109452341600) | [214 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36582013896/job/109452341616) |
| after | [36581206489](https://github.com/pacphi/agentic-kit/actions/runs/36581206489) | `f19566adf2d0f0d7027bc4ea45f9f990e2b0355e` | [247 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36581206489/job/109449555718) | [174 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36581206489/job/109449556023) | [210 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36581206489/job/109449555782) |
| after | [36578593054](https://github.com/pacphi/agentic-kit/actions/runs/36578593054) | `989c5e563c8aa0527b1497fb64643f8277664c0a` | [214 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36578593054/job/109440525366) | [215 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36578593054/job/109440525563) | [200 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36578593054/job/109440525398) |
| after | [36577987831](https://github.com/pacphi/agentic-kit/actions/runs/36577987831) | `e8751224857f1301a350c8fa6e51dfc999c81206` | [225 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36577987831/job/109438467919) | [209 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36577987831/job/109438468373) | [222 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36577987831/job/109438468285) |
| after | [36573303236](https://github.com/pacphi/agentic-kit/actions/runs/36573303236) | `8430757488d1c154611d0f857d6c32db73e6fcca` | [240 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36573303236/job/109422417956) | [241 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36573303236/job/109422417926) | [220 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36573303236/job/109422417766) |
| after | [36573174471](https://github.com/pacphi/agentic-kit/actions/runs/36573174471) | `00a6faaa2622396309a231ef794628c856fc1071` | [209 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36573174471/job/109421970920) | [355 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36573174471/job/109421971175) | [184 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36573174471/job/109421971019) |
| after | [36572475641](https://github.com/pacphi/agentic-kit/actions/runs/36572475641) | `f440c1ec2e055f633438ea329ce629156439b3ba` | [214 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36572475641/job/109419613374) | [292 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36572475641/job/109419613443) | [195 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36572475641/job/109419613517) |
| after | [36569982241](https://github.com/pacphi/agentic-kit/actions/runs/36569982241) | `087a67154dccba79399900545574c72c86815041` | [218 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36569982241/job/109411273607) | [165 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36569982241/job/109411274140) | [187 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36569982241/job/109411274198) |
| after | [36569976640](https://github.com/pacphi/agentic-kit/actions/runs/36569976640) | `886b565dd5304f485af4c079c0c7c06aa83a13cd` | [283 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36569976640/job/109411256908) | [195 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36569976640/job/109411257316) | [210 s, success](https://github.com/pacphi/agentic-kit/actions/runs/36569976640/job/109411257237) |
| after | [36567912820](https://github.com/pacphi/agentic-kit/actions/runs/36567912820) | `ed8f4cb96836e1911aae9a89bbb3f015f033e115` | [197 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36567912820/job/109404334440) | [359 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36567912820/job/109404334368) | [231 s, failure](https://github.com/pacphi/agentic-kit/actions/runs/36567912820/job/109404334534) |

Issue publication remains pending controller review; no posted table or closure is proved.
[Issue #262](https://github.com/pacphi/agentic-kit/issues/262) remains open.
