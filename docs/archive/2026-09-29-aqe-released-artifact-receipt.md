# AQE 3.14.5 released-artifact receipt (2026-09-29)

Capture: 2026-09-29. Documentation basis: `b5a0a946ae0aca2e1d435c78b12a98bc587d1266`. Probe observations: 2026-09-29T14:27:38Z; compilation of retained evidence, without new runtime probes. The upstream issues [#655](https://github.com/proffesor-for-testing/agentic-qe/issues/655), [#753](https://github.com/proffesor-for-testing/agentic-qe/issues/753), and [#778](https://github.com/proffesor-for-testing/agentic-qe/issues/778) are closed, but closure does not establish installed behavior. This receipt reports only the selected tests below. It is not an issue-closing request.

## Exact artifact and environment

The controller registry capture at 2026-09-29 14:16:56 UTC listed `agentic-qe@3.14.5` as latest. The registry tarball had SHA-512 integrity `sha512-mDvWB1fUaGevg6F3QNWK7ESXHeZnlvc0MiQ4Ue9do4SJwggM6aP5dl3DZNWKmO2g5GGFjYJuikl53KeuT3uazg==` and SHA-256 `32cd29f00201cbcba19313b62bac20ffaa5c7d032b5246e5d08d94d6d24b9221`. Its installed selected source files matched tarball bytes:

| Package-relative path | SHA-256 |
| --- | --- |
| `package.json` | `6a854da5e68636739a400b6237ad77b2250480471d5a4e643cc6474f297ee3a0` |
| `dist/cli/bundle.js` | `a8b61993b4286336f79f9d7db9195b26d86626924adbd522a158fad222b08a84` |
| `dist/init/codex-installer.js` | `79dda90da0faa7202ea61fc0c449d9ef4062d96f6062324bb98ecd6e9980d78a` |
| `dist/audit/witness-chain.js` | `a712fa97849efdfe160c3c2e440901d25e48450e2d6bdaa69af4225c824f3458` |

The tarball was installed in a disposable private prefix with lifecycle scripts ignored; only `better-sqlite3` was rebuilt there. Both commands exited 0. Acquisition and native dependency preparation ran unsandboxed with a private constructed environment; the sandbox claim applies only to the later probes. The before/after global check covered package metadata, not a complete global installation fingerprint. Public `aqe` bin reported 3.14.5. Runtime: Node 26.4.0, `better-sqlite3` 12.11.1, SQLite 3.53.2, macOS arm64. Probe invocations ran with a credential-free, private environment, denied network, and sandboxed writes. The probe script relied on an earlier setup step that created the empty project and environment; the retained setup commands and logs support that initial state, but the probe script is not a self-contained fresh-root reproducer. Optional Vibium bootstrap attempted network access and failed as expected under the sandbox during the three init runs. No global install was made: global AQE metadata was 3.14.4 both before and after. The release's npm publication timestamp was 2026-09-29 10:08:33 UTC; [PR #783's merge commit](https://github.com/proffesor-for-testing/agentic-qe/commit/63d3debab54105dbc93030eb0b0088e2f9bebd9c) is dated 13:05:19 UTC, after that publication. The release metadata supplied no `gitHead`, so this ordering and the artifact probe bound the conclusion rather than an assumed source tag.

## Selected results

| Issue | Verdict on released 3.14.5 | Observed contract and limit |
| --- | --- | --- |
| [#655](https://github.com/proffesor-for-testing/agentic-qe/issues/655) | Verified selected compact path | `aqe init --auto --with-codex --codex-guidance compact` exited 0. The AQE-owned sentinel region was 315 UTF-8 bytes, below the released 512-byte constant. A separate foreign prefix/suffix fixture survived two identical calls with complete `AGENTS.md` bytes and mtime stable between calls 1 and 2. The fixture creation mtime was not captured. Full/none modes, CRLF and malformed/duplicate sentinels, all-platform verification, and receipt correctness remain unverified. Prior 3.14.4 broader conformance failed; this narrow result does not sunset the registry constraint. |
| [#753](https://github.com/proffesor-for-testing/agentic-qe/issues/753) | Verified fresh-chain append case | Released `createWitnessChain` places tail read and insert inside an immediate SQLite transaction. One native WAL sequential control and three synchronized two-process rounds each ended at 4001 rows (seed plus 2000 per process), `valid: true`, `signatureFailures: 0`, and SQLite integrity check `ok`. Only concurrent round 1 demonstrably interleaved the writers. Entries were synthesized unsigned `PATTERN_CREATE` records; signature validation, old-fork repair, import splices, live host concurrency, and Windows/Linux remain unverified. The kit's live-holder refusal still protects stray-store merge and must not be removed from this proof. |
| [#778](https://github.com/proffesor-for-testing/agentic-qe/issues/778) | Refuted fixed-in-3.14.5 claim | Three same-option public init calls on one unchanged minimal project each exited 0, yet `.claude/settings.json` hashes and mtimes changed on every call. Run 2 added a backup and changed domain/learning defaults; run 3 still changed `aqe.initialized`. `AGENTS.md` and `CLAUDE.md` bytes/mtimes were stable after run 1. The merged source fix is newer than the tested release. Subsequent-release conformance is unverified; keep installed/released convergence outstanding under own [#239](https://github.com/pacphi/agentic-kit/issues/239). |

The source-bound report's private retained logs, snapshots, lockfile, scripts and synthesized databases have SHA-256 receipts. The digest of its artifact binding record is `200d11393cab0617bdd92b7218e5dcc5ab146e26e55ba7f58efee20d17471b1b`; selected result records are `init-results.json` `c03ee35435c5946bb18afa2bab96bbf5a29d2c3761bb102e80083d8e492789e4`, `foreign-results.json` `933883e6b9720ad01fb9b560919077247d65ab601750bf3fa4213a0c4ee3fb7b`, and `witness-results.json` `95b38b5c30380a53c1f7284fcaafb257a6b8c513381c9c824ad3a0748451c3f4`. This receipt intentionally omits private acquisition locations and raw project data. Time bounds were 30/60 s registry requests, 240 s dependency install, 180 s native rebuild, 150 s per init, 45 s per native child, and 20 s readiness; none expired in successful observed runs. The retained witness harness has a failure-path cleanup gap: if the first child fails, it can raise before killing and reaping its sibling. Do not reuse it without fixing that gap.

There is no evidence here for broad Windows AQE support, repaired old forks, signed-entry verification, all guidance modes, or installed 3.14.4 conformance with the selected 3.14.5 behaviors. No upstream post, local store merge, or issue closure is authorized by this receipt.

## Native holder and host-support boundary

The [dated host-support addendum](../host-support.md) records released AQE 3.14.4 and
3.14.5 live-owner lock checks on macOS and Linux: status and the shipped adapter
reported `LockHeld`, without `FsyncFailed`; holder and storage bytes remained intact.
V4 [PR #275](https://github.com/pacphi/agentic-kit/pull/275), squash
`bb2e7efe88abd3cb2d73baf26530386549e3dc2e`, removed the exact temporary
`FsyncFailed`-as-busy exception. Ordinary `LockHeld` remains busy. Older 3.14.3
error sequences now fail closed; no universal managed AQE minimum was introduced.

Native Windows AQE was untested. Ruflo 3.48.0 native Windows CLI-to-MCP and
MCP-to-CLI visibility used one database with reported sql.js + HNSW and its native
bridge disabled. That separate proof establishes neither Windows AQE behavior nor
one native backend guarantee across platforms. The earlier Linux Ruflo result was
asymmetric. Own [#240](https://github.com/pacphi/agentic-kit/issues/240) remains open
on its literal managed-floor and combined live-MCP/`ak x verify aqe` criteria;
the native holder probe does not prove that combined final-artifact path.
