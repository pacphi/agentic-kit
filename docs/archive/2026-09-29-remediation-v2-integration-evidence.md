# Remediation v2 integration evidence

Capture: 2026-09-29. Documentation basis: `b5a0a946ae0aca2e1d435c78b12a98bc587d1266`.
These are sanitized controller receipts, checked against local commit objects; they
record integration and the cited CI observations, not fresh runtime probes.
The [scope matrix](2026-09-29-remediation-v2-scope-matrix.md) retains original
dispositions and row-specific limits.

## Inherited documentation integration

The controller baseline receipt establishes these commits as ancestors of
`94890a00ec6f5869c186d1066076c5a2e17dfee4`. Titles and ancestry establish
provenance; they do not allocate every moved file to one PR or test current behavior.

| PR | Integration commit | Scope |
| --- | --- | --- |
| [#264](https://github.com/pacphi/agentic-kit/pull/264) | `e7cfe9ca4d49cb5e94fba698cd0e8376e0c829b7` | docs: one purpose per docs folder, lower-case names, archive point-in-time material |
| [#266](https://github.com/pacphi/agentic-kit/pull/266) | `7936ca48942e4ed1b629641eb61dc0dfbcf12951` | docs(archive): repair and validate historical links |
| [#269](https://github.com/pacphi/agentic-kit/pull/269) | `159c1c98d86d5fbb22b5752413f5889d8b8d172b` | docs: archive completed taxonomy and Sonnet routing plans |

## Reviewed feature integrations

| Work | PR | Reviewed source | Squash commit | Reviewed and squash tree |
| --- | --- | --- | --- | --- |
| V3 dashboard | [#276](https://github.com/pacphi/agentic-kit/pull/276) | `cd5cd08b52a190e2a91540b404b648f6b43a365c` | `eb963f503f806f80df7a8173d7c71314adbd7cfa` | `b5544923cee35a3e0217de1e22d9f6b7f7ddaf4c` |
| V5 intelligence | [#274](https://github.com/pacphi/agentic-kit/pull/274) | `36d78caf2fca6a61b7fd924499da9541ae85060c` | `af825c9f165575b3ef6e1ce0a5836fcf40a1ca3b` | `7966ba916018af69fc4f4908e2d7202da5c507d6` |
| V4 follow-ups | [#275](https://github.com/pacphi/agentic-kit/pull/275) | `f19566adf2d0f0d7027bc4ea45f9f990e2b0355e` | `bb2e7efe88abd3cb2d73baf26530386549e3dc2e` | `0674d0762339037dcf24c30b9adbf58056b01db5` |
| V6 usage | [#282](https://github.com/pacphi/agentic-kit/pull/282) | `fa0cb7b788791a90577a2dfd9f9ca61e07d0591e` | `069553586fb3ad1d824877259562eef0765a42a1` | `78de12a7c593fc79c889cf853ff6eedf39cb583e` |
| Main watcher reconciliation | [#283](https://github.com/pacphi/agentic-kit/pull/283) | `09b198b6960c2dae14819d08729caa8b3794129b` | `9dc018b903ac074af0d4dbfcea0891c4e2a34e94` | `9db3da69020c147a798032b2cbde74e4eb88fdda` |

V4 prerequisite [#273](https://github.com/pacphi/agentic-kit/pull/273), native trace
[#277](https://github.com/pacphi/agentic-kit/pull/277), and watcher follow-up
[#278](https://github.com/pacphi/agentic-kit/pull/278) remain separately reviewed
parts of the delivery. Public implementation detail is retained in the archived
[dashboard](2026-09-28-plan-dashboard-refresh.md),
[follow-ups](2026-09-28-plan-follow-ups-v2.md),
[usage](2026-09-28-plan-usage-accuracy.md), and
[native trace](2026-09-29-native-learning-trace.md) records.

## Latest source-bound CI and ancestry receipts

| Source | Run | Recorded result |
| --- | --- | --- |
| V6 reviewed `fa0cb7b788791a90577a2dfd9f9ca61e07d0591e` | [36614260309](https://github.com/pacphi/agentic-kit/actions/runs/36614260309) | 15 applicable checks passed; published-release consumer skipped |
| V6 develop squash `069553586fb3ad1d824877259562eef0765a42a1` | [36614973862](https://github.com/pacphi/agentic-kit/actions/runs/36614973862) | 13 checks passed |
| Main watcher reviewed `09b198b6960c2dae14819d08729caa8b3794129b` | [36616775739](https://github.com/pacphi/agentic-kit/actions/runs/36616775739) | 14 applicable checks passed; real watch skipped |
| Develop `88ce597f444d487a34d9871a447cf8942f76f760` | [36617683730](https://github.com/pacphi/agentic-kit/actions/runs/36617683730) | 13 checks passed |

The last develop commit records parents `9dc018b903ac074af0d4dbfcea0891c4e2a34e94`
and `cb54f42e11fb6ff152ec278eb2dc1e119ee05ac5`. Its tree remains
`9db3da69020c147a798032b2cbde74e4eb88fdda`, equal to the reviewed watcher tree
and squash. The main input is an ancestor of the reviewed feature. This records
already-reviewed content while retaining ancestry; it is not final main approval.

## Bounded dashboard observations

The V3 controller receipt supporting [#256](https://github.com/pacphi/agentic-kit/issues/256)
records actual native-transcript replay on bounded re-entry, a failing-before and
passing-after fixture, and stable accepted/session/project counts for that scenario.
Offsets live in bounded memory: eviction or a new process can replay, so this is
not durable exactly-once delivery. A separate real Codex CLI 0.159.0 idle-fork
process/transcript join in a plain folder used the real survey. It establishes
plain-folder binding for that case, without a model turn, billing or browser claim.
Structured live input remains experimental with no verified producer. These three
answers make #256 a candidate final-main closure, subject to controller reconciliation.
No Network event-stream trace or diagnosed fix is recorded for
[#254](https://github.com/pacphi/agentic-kit/issues/254); the final trace check remains.

## Remaining release and compatibility boundaries

Node.js [#65934](https://github.com/nodejs/node/issues/65934) remains an upstream
Node 22 runner-protocol/backport boundary. The V6 test-local change replaced a
`beforeEach` console emission with `t.diagnostic`, preserving Unicode and assertions.
An official SHA-verified Node 22.23.2 binary and a coalesced actual-child V8 replay
matched the CI error; native historical chunk boundaries were not proved. Five
focused checks and five fixed replays passed in the retained receipt. This does
not establish an upstream runtime fix or permit dropping Windows assertions.

The [Windows timing gate](2026-09-29-windows-ci-evidence.md) fails its recorded
three-run snapshot. AQE release and installed-state limitations are in the
[artifact receipt](2026-09-29-aqe-released-artifact-receipt.md). No real routine
trigger, paid provider run, global upgrade or real-store operation was performed
for these receipts. The memory loop remains OFF until main approval. Final
closeout CI, aggregate main PR review, releases, installations and approved
operational work remain separate gates. Attended time was not instrumented;
commit and run timestamps establish observed elapsed intervals only.
