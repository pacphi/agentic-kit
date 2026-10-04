# Supersession ledger: what the project-scope redesign retires

## Status

**Active.** Compiled on 2026-10-01 from four read-only reviews, as master plan Decision 4
requires. The fourth covered the completion program that existed only on the maintainer's Mac
until 2026-10-01 (section H). It feeds the card inventory, and it serves as remediation v2's final Appendix A/B
reconciliation (V7 step 2). It is archived with the program.

**Amended 2026-10-03:** in section D, the guidance row points at the single `managed-tools` skill,
and the token-audit skill row says the skill leaves the product (master plan Decision G15).

## How to read it

Each entry has a source citation, a state, the redesign's impact on it, and one disposition.

**States:**

- planned, not started;
- started, not finished;
- finished: listed only when the redesign obsoletes it, or a defect or exit gap remains;
- deferred, usually waiting on upstream;
- decision pending.

**Dispositions** (master plan Decision 4):

| Disposition | Meaning |
| --- | --- |
| **exit-critical** | Fixed in `alpha.61` |
| **superseded** | Closed or deleted, citing the design phase. No fix is written |
| **still needed** | Scheduled in the earliest beta whose phase touches that area |
| **upstream-dependent** | Goes to v4.1.0 under Decision 3a |

**Phases map to releases** like this:

| Release | Phases |
| --- | --- |
| `alpha.61` | Prerequisites A–C and the exit release |
| `beta.1` | P0–P2, plus the Codex part of P3 |
| `beta.2` | The rest of P3 (OpenCode), and P4 |
| `beta.3` | P5, and the first half of P6 |
| `beta.4` | The rest of P6, and P7 |

**Citation keys:**

- **DSN** is the [design](2026-10-01-project-scope-only-design.md).
- **v2** is [remediation program v2](../archive/2026-09-28-plan-remediation-program-v2.md).
- **EX** is its [develop execution plan](../archive/2026-09-28-plan-remediation-v2-develop-execution.md).
- **v1** is [remediation program v1](../archive/2026-09-26-plan-remediation-program.md).
- **WP** and **WD** are the [CI Windows plan](../archive/2026-09-28-plan-ci-windows-test-speed.md) and its [design](../archive/2026-09-28-design-ci-windows-test-speed.md).
- **DL** is the [issues 237–239 decision log](../archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md).
- **SM** is the remediation v2 scope matrix, `docs/archive/2026-09-29-remediation-v2-scope-matrix.md`.
- The completion program (section H), cited as `KEY:line`. These files were on branches when this
  ledger was written. They are now on `main`, moved by [#317](https://github.com/pacphi/agentic-kit/issues/317):
  - in `docs/archive/`: **PRG**, `2026-09-29-plan-completion-program.md`; **ACC**,
    `2026-09-29-plan-completion-acceptance-ledger.md`; **M1X**, `2026-09-30-plan-completion-m1-execution.md`;
    **M1L**, `2026-09-30-plan-completion-m1-closeout-ledger.md`; **SHC**,
    `2026-09-30-upstream-aqe-mcp-shutdown-contribution.md`; **RCP**, `2026-09-30-aqe-m1-mcp-lock-proof.md`;
    **CL**, `2026-09-29-plan-issue-239-closure-and-v5-foundation.md`; **EV**,
    `2026-09-29-plan-execution-evidence-and-upgrade-acceptance.md`;
  - in `docs/proposals/v5/`: **SES**, `2026-09-30-session-organization-and-activity-design.md`; **TAX**,
    `2026-09-30-conversation-activity-and-topic-taxonomy-design.md`;
  - **REG**, `src/lib/hook-audit/agentic-dependency-constraints.json`, is on `main`;
  - **WFL**, `.github/workflows/aqe-m1-conformance.yml`, is still on branch `fix/completion-m1`, where it
    stays until its rewrite (#347).

**Excluded:** issues labelled `needs-review` (#95, #109, #115, #116, #117, #167) and every item
about them. That covers v2's D-12 to D-14, the matching decision-gate rows DG-3 to DG-5, and the
same items in v1. Maintainer rule, 2026-10-02: an issue labelled `needs-review` is out of scope for
every planned release (4.0.0, 4.1.0 and 5.0.0), so these rows need no card. D-31 ("archive a plan
only when every open row maps to a card") is met for them by this exclusion, not by a card.

## Summary

| Source | Entries | Exit-critical | Superseded | Still needed | Upstream-dependent |
| --- | --- | --- | --- | --- | --- |
| Remediation plans (v2, EX, v1, WP/WD) | 58 | 14 | 27 | 11 | 6 |
| Decision log for #237–#239 | 57 | 12 | 27 | 5 | 13 |
| ADRs, shipped features, docs, proposals, issues | 108 | 6 | 61 | 37 | 4 |
| Completion program, `fix/completion-m1`, the 2026-09-29 plans | 69 | 24 | 12 | 22 | 11 |

The entries overlap: the same item can appear in several sources. The combined, de-duplicated
work lists are the next three sections. The counts are as the reviews found them; decisions G1,
G6 and G12 later added four superseded entries in sections C and D.

## Exit-critical work for `alpha.61`

These are de-duplicated across all sources. Each becomes an `alpha.61` card.

1. **Prerequisites A, B and C** (design "Prerequisites").
2. **A complete `uninstall --purge`** (DSN "The exit release"):
   - every enabled host's teardown runs, including the Codex `ruflo` MCP entry;
   - provider env, the AQE router and the AQE embedding settings are removed by receipt;
   - the Ollama alias is removed after a confirmation;
   - the Brain plugin, shim and LaunchAgent are removed after a confirmation, and the knowledge
     base is kept;
   - the deja-vu wiring is removed; the package and the index are each confirmed separately;
   - the user-scope `claude-flow` MCP entry is removed;
   - the global `agentdb` is removed after an ownership check, or the command is printed;
   - the AQE store-merge archives and backups are **kept**, and `~/.claude-flow/memory` is
     **kept**, unless the user confirms;
   - the unrestorable pre-receipt Ruflo edits are disclosed;
   - the AQE pin is removed by its receipt, which needs the receipt to exist;
   - receipts are restored before `kit.json` is deleted;
   - a sandboxed-`HOME` regression test proves all of this.

   Sources: v2 D-2 and §2 step 2; DL D1, Problem 2, Problem 3, B5-D4, B3-D1; the ADR-0035 and
   ADR-0061 rows.
3. **`alpha.61` never updates itself.** Its `ak sync` prints the upgrade steps instead (DL
   cross-cutting; DSN "The exit release").
4. **#271**, the Brain held refresh that never clears. The fix already exists on
   `fix/completion-m1`:
   - `b535975`: a held refresh expires after the version-check TTL (24 hours by default);
   - `fb48cb3`: a missing knowledge base is reported as missing, not as the cached release;
   - `dfb5609`: `ak sync --retry-brain`, a guarded one-shot retry.

   They apply cleanly to `main`, and their focused tests pass. Land them as one PR, with the stale
   comment at `src/lib/heal.mjs:330-338` fixed and `--retry-brain` added to the README.
   `--retry-brain` exists only on `alpha.61`. The issue is superseded on the new line at P4.
5. **#240.** Close it with the AQE 3.14.4 evidence its registry entry names, plus the 3.14.6 macOS
   receipt (RCP) and the ADR-0055 and ADR-0062 lines from `248b1b6`. Criterion 3 is reworded to
   `ak status --refresh=live --only aqe` (v2 V4 C.1; DL U3k; CL D-25). See **G13**.
6. **#262.** Meet the rule approved on 2026-09-29 (PRG:60): a ten-run median under 5 minutes, plus
   three consecutive PR runs with every Windows leg under 300 seconds. Measure `6ab1c5e` first.
   Otherwise record a waiver, then close it. Measure again after P0 (v2 V1; WP Task 4; WD
   acceptance; M1L:35).
7. **Remediation v2 close-out:**
   - this ledger serves as the Appendix A/B re-check (V7.2);
   - add the v2 summary entry to the decision log (V7.3, DL close-out);
   - record the first dispatch (DoD-3), citing the read-back at M1L:51-60;
   - M1L is the row-by-row map of the 246-row matrix; this ledger holds the dispositions (**G11**);
   - after the master-plan PR, archive v1, v2, EX, WP, WD and the decision log, rewriting the
     links that point at them;
   - archive the completion program (PRG, ACC, M1X, M1L, SHC) and the two 2026-09-29 plans (CL,
     EV); move SES and TAX to `docs/proposals/v5/`;
   - refresh their stale Status sections, adopting the v2 and EX refreshes from `456ff58`;
   - record attended time as "not instrumented";
   - drop the global-match criterion (v2 §6.5).
8. **Jobs on the maintainer's machine, done before the purge or waived:**
   - merge the stray AQE store, keeping a copy of the receipt (v2 D-7);
   - delete the reviewed temp backlog (v2 §2 step 7, B9-14);
   - remove the leftover `/tmp` logs (v2 §2 step 4).

   The footprint snapshot refresh is dropped (superseded).
9. **Publish `alpha.61`** and check it with `npx @pacphi/agentic-kit@4.0.0-alpha.61 --version`
   (v2 D-2, §6.5; EX Phase E, reshaped into the exit regression test).
10. **Register agentic-qe#801** (from `f19f84c`) in the same PR that lands the files its entry
    names. The registry test requires every named file to exist.

## Gaps in the design that the reviews found

| # | Gap | Resolution |
| --- | --- | --- |
| G1 | `ak host adapters` (trust, conformance, grants: `src/commands/x/host-adapters.mjs`, `host-adapters-grants.mjs`, about 975 lines), the host binding and `--aqe-provider` controls (ADR-0020 Decision 2), and `ak host status` have no home in the trimmed command surface | **Decided (A), 2026-10-01.** The adapter contract and Hermes are retired in P0 and set aside for v5 (design Decision 10). Binding and provider controls become `init` choices; `ak host status` becomes the Hosts section of `ak status` |
| G2 | `x dashboard` and `x admin` are not duplicates. The top-level `dashboard` and `admin` commands import the same modules (`bin/agentic-kit.mjs:30-31`) | Only the `ak x` aliases go; the modules stay |
| G3 | The new ADR is **0064** (0056 and 0057 are reserved; 0059 is cited but has no file). About 20 more ADRs need notes beyond the three the design names (§C below), including ADR-0040 §5 (project trust) and ADR-0014 (dashboard writes) | One `ga-readiness` card per batch of ADR notes |
| G4 | `docs/adr/README.md` lists ADR-0051 as "Accepted; implemented locally", but the ADR says "Implemented; published in 4.0.0-alpha.48" | Fixed in the first ADR card |
| G5 | The companion registry is used only by deja-vu. MetaHarness (ADR-0022) does not use it | Delete it in P0 with deja-vu |
| G6 | `ak x harvest` is missing from the command fold table | **Decided (A), 2026-10-01.** Removed in P5 (design Decision 11) |
| G7 | The exit release would have deleted user data and self-updated into the new line | **Fixed** in the design at `505786e` |
| G9 | The completion program (M1–M3) and `fix/completion-m1` planned the same work as this program and were never reviewed | Triaged in section H. M1 → `alpha.61`; M2 → v5.0.0 and v4.1.0; M3 → v5.0.0 or P6. Archived in the close-out |
| G10 | CL D-20 (2026-09-29) pulled four #239 items out of v5; master plan Decision 3 (2026-10-01) puts #239 on v5.0.0 | **Decided (A), 2026-10-01.** Decision 3 supersedes D-20: all of #239 stays on v5.0.0. The P6 `ak run` records card leaves room in its schema for identity and outcome fields, shaped by EV E1 |
| G11 | Two documents claim to succeed the 246-row matrix: M1L (M1L:5-10) and this ledger | M1L is archived as the dated row map; this ledger decides dispositions |
| G12 | The design's fold table has no row for `ak x aqe-store` (stray-store merge, used by exit job D-7) or `ak x skills` (skill maintenance plan) | **Decided (A), 2026-10-01.** Both fold into `maintain` in P5: the store merge becomes an action with an undo receipt, and the skills plan a read-only finding (design fold table) |
| G13 | M1L adds Windows and installed-target proof to #240 (M1L:62-65); the master plan and the registry entry on `main` close it on the 3.14.4 evidence | **Decided (A), 2026-10-01.** Close #240 in `alpha.61` on its own criteria (exit item 5). Windows and installed-target proof move to the beta.1 conformance card |
| G14 | The unapproved upstream drafts (replies to agentic-qe #528, #532 and #535; the #801 source fix) promise work the redesign moves | v4.1.0 under Decision 3a; redraft before approval |
| G15 | PRG P06 and SES assume ADR-0029 host admission, which P0 removes (PRG:272; SES:49, 94, 130); CL cites the retired `ak x verify` (CL:76, 327) | Rewritten in the v5 cards |
| G8 | Items the v5 review sent to v4 (see the [v5 impact review](../proposals/v5-impact-of-v4.md#items-that-belong-on-the-v4-board)): D01 and D10 triage; an advised-commands test; "all healthy" while warnings are open; splitting `/api/system`; showing where limits were sampled; Codex per-profile configs; the not-OTLP wording; complexity limits for P6; the "[BLOCKED]" exit-code finding | Cards in the phases named there |

## A. Remediation program documents

### v2 decisions (§1)

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| D-2 | v2:90-101; EX:50-52, 241-244 | Releases: alpha.60, then alpha.61, then a close-out release, each checked with `npm i -g` | Started; alpha.60 is on `next`, alpha.61 is not cut | Partly obsoleted: alpha.61 is the exit release, checked through `npx` | Exit-critical |
| D-5 / B0-25 | v2:124-130, 493 | Four #239 items not yet scoped: execution identity, terminal outcomes, cancellation, the upgraded-install matrix | Planned | Partly obsoleted: the matrix is replaced by "no migration code", and `ak run` records feed execution identity | Still needed → v5.0.0 (#239); drop the matrix |
| D-6 / B5-15 | v2:132-137, 344 | `aqe init` is not idempotent (agentic-qe#778) | Finished on ak's side; released 3.14.5 still reproduces | Obsoleted for ak: initializers are staged (P1) | Superseded; the registry watch is upstream-dependent |
| D-7 / B5-9 | v2:139-145, 229; EX:247-248 | Merge the stray AQE store | Started: the scan fix shipped in #275; the real merge isn't done | Unaffected, but its receipts live in a folder the purge deletes | Exit-critical (run before the purge, or waive) |
| D-9 / HK-6 | v2:155-164 | Keep the two v5 branches; reserve ADR-0056 and 0057 | Finished (decision) | Partly: ADR-0057 must reconcile with the work view | Still needed → v5.0.0 |
| D-10 / DG-1 | v2:170 | Environment Auditor: designed, not built | Decision pending | Partly: a read-only audit is allowed, but its fixes must be copy-only advice | Still needed → v5.0.0 intake |
| D-11 / DG-2 | v2:171 | ADR-0059, encryption at rest for Ruflo data | Planned | Partly: stores become project plus cache (P2) | Still needed → v4.1.0 intake, after P2 |
| D-15 / DG-6 | v2:175; EX:89-90 | ADR-0048 human-evaluation gates | Planned (deferred to v5) | Partly: P6 replaces Overview | Still needed → v5.0.0 |

### v2 maintainer jobs (§2)

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| §2 step 1 | v2:215 | `ak --version` on the global install shows alpha.60 | Planned | Obsoleted: checked through `npx`, with no self-update | Superseded (replaced by the `npx` check) |
| §2 step 2 / B5-8 | v2:216, 336 | AQE pin converges after `ak sync` | Started: a read-only check passed; the real sync wasn't run | Partly: the receipt lives in `kit.json` | Exit-critical (confirm the receipt so the purge can remove the pin) |
| §2 step 3 / B1-3 | v2:217 | Refresh `footprint-snapshot.json` | Planned | Obsoleted: the snapshot moves to the cache and the purge deletes the folder | Superseded |
| §2 step 4 | v2:218-227 | Remove the leftover `/tmp` logs | Planned | Unaffected | Exit-critical (housekeeping) |
| §2 step 7 / B9-14 | v2:230, 359 | Delete the temp backlog by hand from the reviewed list | Started: the inventory exists; nothing deleted | Unaffected | Exit-critical (or waive) |

### v2 branches V1–V7

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| V1 / #262 | v2:271, 457 | Windows legs under 5 minutes; post the 10-run table and close #262 | Started: medians around 3.5 min, but single runs reach 311–359 s; #262 open | Partly: P0 removes 26 test files, but adds contract tests | Exit-critical |
| V2 point 5 / V7.3 | v2:288, 389, 466 | Archive the program documents | Started: their Status sections are stale | Unaffected; links need rewriting | Exit-critical (after the master-plan PR) |
| V7.3 log entry | v2:389 | Add v2's summary entry to the decision log | Planned | Unaffected | Exit-critical |
| V3 (6c-1…6c-5) | v2:293-309 | POST refresh, one Refresh control, read-only GETs | Finished (#276) | Extended: GETs still write `kit.json` and evidence, and Intelligence writes into projects | Still needed (the remainder) → Prerequisite B and P6 |
| V3 B0-22 | v2:300 | Claude Code badge reads "Unknown" when not assessed | Finished (#276) | Partly: badges read project state (P6) | Superseded at P6; keep the "Unknown" rule |
| V4 A.1 | v2:317 | Usage errors give one JSON object under `--json` | Finished (#275) | Partly: some of those commands are removed (P5) | Superseded for removed commands |
| V4 A.2 | v2:318 | `ak host … --dry-run --json` | Finished (#275) | Obsoleted: those verbs become re-running `init` | Superseded |
| V4 A.3 | v2:319 | Offline retry stamp for self-update checks, kept in `kit.json` | Finished (#275) | Partly: no self-update; version checks go to the cache | Superseded at P2; reuse the throttling logic |
| V4 B.2 | v2:325 | Re-record seam tests for `x daemon-gc`, `setup`, `x host pick` | Finished (#275) | Obsoleted: those commands go | Superseded; the tests go with them |
| V4 B.3 | v2:326 | `rufloMemoryLocation` gives both reasons; the `inside()` fix | Finished (#275) | Partly: launchers find their own root (P2) | Superseded at P2; keep the `inside()` fix |
| V4 B.4 | v2:116-122, 327 | The two-store memory row becomes info once routing evidence matches | Finished (#275) | Only its storage changes | Still needed → move it in P5 |
| V4 B.5 | v2:328 | `codex-mcp` hint; `~/.agentic-qe` home-store row | Finished (#275) | Partly: Codex MCP becomes project config; status sections change | Superseded at P3/P5 |
| V4 B.6 / LQ-2 | v2:329 | One restart instruction (done); a Codex hooks fix line waits on ruflo#3419 | Started | Partly: Codex hooks move to `.codex/hooks.json` | Upstream-dependent |
| V4 B.7 | v2:330 | F6 YAML daemon key precedence; F7 versions-only sync previews daemon changes | Finished (#275) | Partly: pins and a project pid receipt (P2) | Superseded at P2 for F7; F6 stays |
| V4 B.11 | v2:334 | deja-vu check says "skipped"; temp folders cleaned | Finished (#275) | Obsoleted (the deja-vu half) | Superseded at P0; the cleanup half stays |
| V4 B.12 | v2:335 | The setup memory probe leaves no stray store | Finished (#275) | Partly: `setup` becomes `init` | Superseded at P1; port the test |
| V4 C.1 / #240 | v2:340 | Retire the AQE busy rule, then close #240 | Started | Unaffected | Exit-critical |
| V5 B9-11 | v2:353 | About card's Ruflo install-edit line, with a rendered test | Finished (#274) | Obsoleted: no edits in a global install (P2) | Superseded |
| V6 UA-4 | v2:378 | statusLine classifier reads managed settings | Finished (#282) | Partly: classified per opted-in project (P6) | Still needed (the extension) → P6 |
| V6 item 6 / B1-6 | v2:379-381 | One label per value across the views | Finished (#282) | Partly: the views are rebuilt around places | Superseded at P6; reuse the vocabulary module |
| V7.2 | v2:388, 456 | Re-run the Appendix A/B row check | Started: the scope matrix is stale | Unaffected | Exit-critical: this ledger is that re-check |
| V7.5 | v2:391 | Update the auto-memory; record attended time | Planned | Unaffected | Superseded (auto-memory only if asked; attended time "not instrumented") |

### After v2, definition of done, and upstream items

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| #255 / B9-6 | v2:397 | Worker early-warning monitor | Planned | Unaffected; `ak run` records give it data | Still needed → v4.1.0 (design first) |
| #257 / UA-2 | v2:398 | Cowork as a discovery source | Started: the disclosure shipped in #282 | Partly: the coverage card and session sources | Still needed → P6 |
| §6.5 | v2:463 | Approved releases published; the global `ak` matches the latest | Started | Partly: the global-match rule conflicts with the redesign | Exit-critical (publish alpha.61; drop the global match) |
| §6.6 / DoD-3 | v2:464 | Upstream watch live; first dispatch recorded | Started: six records fired; PRs #286–#288 open | Unaffected | Upstream-dependent; triage #286–#288 under 3a |
| §6.7 / DoD-5 | v2:465 | Only `main` and the two v5 branches remain locally | Started | Unaffected | Superseded by EX:250-252; remove only v2's worktrees |
| B5-3 (agentic-qe#655) | v2:512 | Codex guidance constraint kept | Started | Partly: initializers are staged, and Codex guidance is per project | Upstream-dependent (a candidate for 3a's exception, since P1 and P3 touch it) |
| B5-5 (agentic-qe#753) | v2:514 | Audit-chain fork | Started | Unaffected | Upstream-dependent |
| HK-11 (ruvnet-brain#335) | v2:561 | Brain forge-update stuck once backups accumulate | Started | Partly: the installer's user mode isn't used | Upstream-dependent; superseded if P4 uses ak's own download |
| HK-5 | v2:557 | Three Ruflo install edits without receipts, documented | Finished (declined) | Obsoleted (P2) | Superseded; keep the "reinstall Ruflo" note |
| EX Phase E | EX:246 | Install, sync and footprint check on the released artifact | Planned | Partly: becomes the exit release's sandboxed-`HOME` test | Exit-critical, in its new form |

### v1 items without a v2 row

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| #213 | v1:139 | Ruflo memory-routing tracker | Started | Partly: the user-level fallback goes (P2) | Upstream-dependent (v4.0.0 until rc.1, then v4.1.0) |
| Branch 0 (#241) | v1:65-67 | Codex badge from `kit.json`; AQE in user configs; Brain hooks warning; user OpenCode guidance; natives in the global tree | Finished | Partly, at P2, P3, P4 and P6 | Superseded at those phases |
| Branch 3 item 1 | v1:123 | Rolling Ruflo support window | Finished (#247) | Partly: exact pins | Still needed (as the default-pin policy) → P2 |
| Branch 3 item 3 | v1:125 | Daemon auto-start with receipts in `kit.json` | Finished (#247) | Partly: pid receipt per project | Superseded at P1/P2 |
| Branch 3 item 4 | v1:126 | aidefence heal on the global Ruflo tree | Finished (#247) | Obsoleted (P2) | Superseded |
| B3-D1 | v1:119 | Claude registration through `ak x ruflo-mcp --host claude` | Finished (#247) | Obsoleted: a project launcher with local scope | Superseded |
| Branch 5 item 1 | v1:155 | AQE pin and Codex launcher, receipted in `kit.json` | Finished (#250) | Partly: receipt and launcher move into `.agentic-kit/` | Superseded at P1/P3 |
| Branch 6a item 1 | v1:175 | One user-level evidence store | Finished (#252) | Partly: project state and cache | Superseded at P5/P6; keep the record shape |
| Branch 6b items 4–5 | v1:187-188 | `host check-connection`, `host reset-routes` | Finished (#263) | Obsoleted (P5) | Superseded |
| Branch 9 item 6 | v1:247 | Per-machine acknowledgement of hook contracts | Finished (declined) | Obsoleted: Brain hooks become a per-project choice | Superseded |

## B. Decision log for issues #237–#239

### #237: verdicts and decisions

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| S1 | DL:54, 467 | Legacy user-scope `ruflo` entry; one ownership check | Finished (#241) | Obsoleted: local scope (P1) | Superseded |
| S2 | DL:55, 466, 916 | False `blocks` drift; a second OpenCode guidance writer | Finished (#241) | Obsoleted: no user guidance (P1) | Superseded |
| S3, Dec 10, Dec 13 | DL:56, 469-470, 1881-1923 | Repair contract and convergence verdict | Finished (#241, #248) | Partly: the sync engine is replaced | Superseded; carry the contract into P5 |
| S4, Dec 9 | DL:57, 405-453 | Remembered and opt-in live checks; evidence in user state | Finished | Partly: project state and cache; sandboxed `HOME` | Superseded in part (P6) |
| S5, Dec 5 | DL:58, 290-317 | `ak sync --skip <part>` | Finished (#241) | Partly: sync becomes per project | Superseded in part (P5) |
| D1, Decision A | DL:59, 576-604 | Retire the standalone agentdb install; it is not removed automatically | Finished | Partly: no exit step exists for the leftover global copy | Exit-critical (purge after an ownership check, or print the command) |
| D2/D3 + #271 | DL:60-61, 471-472, 893 | Brain refresh through its updater; the held refresh in `kit.json` | Finished; **#271 open** | Obsoleted on the new line (P4) | Exit-critical for #271; superseded at P4 |
| D3 upstream | DL:61, 524-526 | Brain `--update` runs a stale updater (ruvnet-brain#331) | Deferred | Obsoleted: ak stops driving Brain's updater | Superseded (retire #331 at P4) |
| D4, Dec 4 | DL:62, 254-288 | Hook-change warning; upstream asks for a "silence" mode | Deferred | Partly: Brain hooks become per project | Upstream-dependent; reuse the review in P4 |
| D5 | DL:63 | Options for an external agent-browser outside the supported range | Finished | Partly: cached and pinned (P4) | Superseded in part |
| P1, P2, Dec 3, Item 5 | DL:75-76, 218-252 | AQE MCP transport recognizer; embedder endpoint in user configs | Finished | Partly: user projections are removed by the purge; the recognizer is reused for existing setups | Superseded in part (P3/P4) |
| P3 | DL:77 | Rebuild native bindings inside the global Ruflo | Finished | Obsoleted: only the cached copy is touched (P2) | Superseded |
| N1 | DL:83, 1167-1169 | Codex MCP topology row; manual Codex rows | Finished | Obsoleted: project config and the register | Superseded |
| N3 | DL:85 | Non-git hints point at `ak setup --project` | Finished | Partly: `setup` becomes `init` | Superseded (reword in P5) |
| U3k, Dec 7, #240 | DL:81, 343-373 | Temporary AQE busy rule | Started: the rule is retired; #240 open | Unaffected | Exit-critical |
| U4, #213 | DL:82, 2246-2247 | Ruflo MCP memory path (ruflo#3196, #3143, #3508) | Deferred | The user-store part is obsoleted | Upstream-dependent |

### #237: addenda, the Ruflo 3.46 adoption, and Branches 3–5

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| Addendum-1 candidates | DL:614-625 | Filed upstream: ruflo#3444–#3447, agentdb#26–28, RuVector#1026, ruvnet-brain#329, agentic-qe#735 | Deferred | Unaffected; ruvnet-brain#329 is partly moot | Upstream-dependent |
| Problem 1 / ruflo#3193 | DL:632-657, 1780 | Pin the Ruflo memory root before `providers configure` | Deferred (#3193 partly released) | Unaffected | Upstream-dependent |
| Problem 2 and related | DL:659-682, 1221-1231, 1298-1305 | User-level store `~/.claude-flow/memory`; launcher Claude mode; harvest outside projects | Finished | Obsoleted: no user-level store; launchers find their root (P1/P2) | Exit-critical (the purge asks about the store and removes the user-scope entry); then superseded |
| Problem 3 | DL:684-705 | Receipts for edits inside the global Ruflo | Finished | Obsoleted (P2) | Superseded; keep the receipt restore in the purge |
| Edits without receipts | DL:1290-1297 | Three earlier better-sqlite3 edits that cannot be restored | Deferred (accepted) | Obsoleted from now on | Exit-critical (disclose in `--purge --dry-run`) |
| Item 1, V4 B.7 | DL:1516-1573 | Daemon auto-start in `kit.json`; daemon keys | Finished | Partly: `project.json` and a pid receipt | Superseded in part (P2/P5) |
| ruflo#3194 override | DL:1524-1526 | `daemon.idleSecs: 0` below 3.46.0 | Deferred (fixed in 3.46.0) | Partly: pins at 3.46 or later make it removable | Superseded on the new line (drop it in P2) |
| ruflo#2935 | DL:1527-1529 | macOS memory threshold override | Deferred | Unaffected | Upstream-dependent |
| ruflo#3449 | DL:1685-1699 | `config set` can't configure the daemon | Deferred | Unaffected | Upstream-dependent |
| Item 4, V3 | DL:1617-1664, 2544-2553 | One evidence store; refresh levels; connection check; reset-routes; Refresh button | Finished | Partly: project state and cache; command folds | Superseded in part (P5/P6) |
| Item 6 reports | DL:1701-1705 | Two upstream reports never filed | Deferred | Unaffected | Upstream-dependent (drop both unless reproduced) |
| Support window | DL:1741-1756 | Rolling window of Ruflo versions | Finished (#247) | Partly: exact pins; the window remains for `tools:"system"` | Superseded in part (P2) |
| ruflo#3167 adoption | DL:1775-1779 | Suppression flags on `ruflo init` | Finished (#247) | Partly: initializers are staged | Superseded in part (P1) |
| ruflo#3473, #3450 | DL:1690-1692, 1998-1999 | Security defend crash; purge misses the AgentDB mirror | Deferred | Unaffected | Upstream-dependent |
| B3-D3, N-3 / ruflo#2885 | DL:1788-1789, 2024-2044 | macOS nightly abort; an upstream comment awaits approval | Decision pending | Unaffected | Upstream-dependent |
| AQE audit chain | DL:1587-1588 | Root store chain broken at entry 135 | Deferred | Unaffected | Upstream-dependent (a first v4.1.0 card) |
| Branch 4 open items | DL:1267-1281 | Six dispatches fired; draft PRs #286–#288 | Started | Unaffected | Exit-critical (record DoD-3); the PRs are upstream-dependent |
| Codex `claude-flow` placeholder | DL:1990-1992 | Stops Codex re-importing Claude's MCP entry | Finished (#247) | Partly: becomes a register repair (P3) | Superseded in part; include it in the purge test |
| B3-D2 | DL:1994-2022 | One-time cleanup of setup probe rows | Finished | Partly: `kit.json` goes; no migration code | Superseded (`alpha.61` only) |
| B5-D1 + agentic-qe#735 | DL:2339-2411 | AQE pins in project settings, `.mcp.json` and project Codex config | Finished (#250) | Retired 2026-10-03 (#436, ADR-0062): ak writes no new pin; a legacy pin is released only on AQE 3.14.5+ with no stray store. P1/P3 only release legacy receipts; `.mcp.json` still becomes local scope in personal mode | Superseded → release legacy receipts in P1/P3 (#335) |
| B5-D4, B3-D2 backups | DL:2460-2484 | Merge archives and backups under `~/.local/state/agentic-kit/` | Finished (#250) | Partly: the purge deletes that folder | Exit-critical (keep or confirm) |
| Branch 5 real-store jobs | DL:1027-1030 | Merge the stray store; confirm the pin | Decision pending | Unaffected | Exit-critical (or waive) |
| #655, #755–#758 | DL:1003-1013 | AQE Codex guidance constraint; #755 has draft #287 | Deferred | Partly: per-project guidance | Upstream-dependent |
| agentic-qe#754 | DL:993 | "Embedder verified" wording; draft #288 | Deferred | Partly: embeddings default `unmanaged` | Upstream-dependent |

### #238 (dashboard) and #239

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| L1, Dec 1 | DL:64, 113-184 | Managed / found / not-installed from `kit.json`; a `host pick` hint | Finished | Partly: project state and `ak init` (P6) | Superseded in part |
| M3 | DL:73 | Explaining an empty Claude limits panel | Finished | Partly: classified per project (P6) | Superseded in part |
| B1-3 full scan | DL:1257-1260 | Rewrite the footprint snapshot | Planned | Partly: it moves to the cache | Superseded (dropped) |
| Browser checks | DL:1383-1389 | Real-data browser and screenshot review | Planned | Partly: the panels are rebuilt in P6 | Superseded (folded into P6 acceptance) |
| D-15 | DL:2555-2556 | ADR-0048 evaluation gates | Deferred to v5 | Partly | Still needed (v5; consider an accessibility check at rc) |
| #257 | DL:1876-1879 | Cowork as a discovery source | Planned | Fits the coverage card | Still needed (P6) |
| F1 / #255 | DL:89, 721 | Worker early-warning monitor | Deferred | Unaffected | Still needed (v4.1.0 design card) |
| D-5 items | DL:21-22 | Execution identity, terminal outcomes, cancellation, upgrade matrix | Deferred to v5 | Partly | Still needed (v5.0.0, #239; rescope the matrix) |

### Cross-cutting

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| Log close-out | DL:3-8 | Add the v2 entry, then archive the log | Planned | Unaffected | Exit-critical |
| `kit.json` fields | DL:115-117, 426, 1558, 2014 | Held refresh, daemon receipt, cleanups, host flags, AQE pin ownership | Finished | Obsoleted: `kit.json` retires | Superseded; `alpha.61` restores receipts before deleting `kit.json` |
| Self-update retries | DL:2556-2557 | Offline retries per npm tag | Finished (#275) | Obsoleted | Exit-critical (stop `alpha.61` updating itself) |
| Re-record seams | DL:1068, 1074, 1301-1302 | `x daemon-gc`, `setup`, `x host pick` seams | Finished | Obsoleted | Superseded |
| deja-vu items | DL:442, 1075, 1164 | Live check, "skipped" wording, teardown test isolation | Finished | Obsoleted (P0) | Superseded |
| Review-fix wave | DL:893-905 | MCP register rows, temp-root routing, manual version repair, erased held refresh | Finished (#241) | Obsoleted | Superseded |
| Temp backlog | DL:1070 | Delete the reviewed backlog | Started | Unaffected | Exit-critical (or waive) |
| `sync.mjs` size | DL:1326 | Close to the line limit | Deferred | Obsoleted: sync is rebuilt | Superseded |

## C. ADRs

The new ADR is 0064. **Superseded** and **Superseded in part** take a "Superseded by ADR-0064"
note; **Updated** takes an `Updated` line.

| ADR | Status | What changes | Phase | Note |
| --- | --- | --- | --- | --- |
| 0035 deja-vu | Implemented | The whole decision | P0 | **Superseded**; move it to the archive |
| 0061 Brain reclaim-stuck | Accepted | The whole decision on the new line; still valid on `alpha.61` | P4 | **Superseded** for the new line |
| 0008 guidance target split | Implemented | User targets and machine retirement; keeps "personal facts never committed" and the preservation of foreign guidance | P1, P3 | **Superseded in part** |
| 0015 Codex status line | Accepted | `ak x statusline` becomes an `init` choice; ownership moves to receipts and the register | P3, P5 | **Superseded in part** |
| 0017 OpenCode host | Accepted | User config, plugins, agents, skills, approvals, its guidance target, the sync model | P3 | **Superseded in part** |
| 0058 managed Ruflo components | Accepted | §3 user env, §4 global typesafe install, §6 funnel disable (explain only), `kit.json` intent | P1, P2 | **Superseded in part** |
| 0051 peer delegation and realignment | Implemented | The realignment half (`ak host align`); also fix its index status | P3, P5, P7 | **Superseded in part** |
| 0055 AQE embedding | Implemented | Default becomes `unmanaged`; two consents; user projections move; becomes an `init` choice | P4 | **Superseded in part** |
| 0043 Ruflo browser executor | Implemented | Install location, config and browser download placement | P4 | **Superseded in part** |
| 0020 GA stable surfaces | Implemented | Decision 2's host namespace; the new command surface | P5 | **Updated** (new surface table) |
| 0025, 0027, 0048 | Implemented / Accepted | Footprint, census scopes and place kinds, Maintenance write gate | P6 | **Updated** |
| 0044, 0040, 0041 | Implemented / Accepted | User-scope providers become advice; 0040 §5 (project trust) reversed for the consented register line | P3, P5, P6 | **Updated** |
| 0016, 0033 | Accepted / Implemented | Projections, registry rejects user scope, register repair matcher | P1, P3 | **Updated** |
| 0029, 0031 external host adapters | Accepted (experimental contract) | The whole contract leaves v4 (**G1**) | P0 | **Withdrawn from v4; carried to v5** |
| 0053, 0063, 0062, 0026, 0024 | Implemented / Accepted | Host health from project state; evidence store location; merge archive location; About card; Intelligence ring in the cache | Prereq B, P0, P5, P6 | **Updated** |
| 0006, 0009, 0032, 0042, 0050, 0054 | Amended / Implemented | Primary host in `project.json`; usage index and places; model store; context audit sources; place kinds; telemetry v2 | P5, P6 | **Updated** |
| 0014 dashboard auth | Implemented | The dashboard gains Refresh and Forget writes (from the v5 review) | P6 | **Updated** |
| 0001, 0003, 0005, 0007, 0010, 0012, 0022, 0023, 0028 | Various | Minor wording and store locations | P5, P6 | Optional |

Unaffected: 0002, 0004, 0011, 0013, 0018, 0019, 0021, 0034, 0036, 0037, 0038, 0039, 0045,
0046, 0047, 0052 and 0060.

## D. Shipped commands, features and modules

All are finished work. Sizes are line counts.

| Item | Paths (size) | Phase | Disposition |
| --- | --- | --- | --- |
| `ak setup` | `src/commands/setup.mjs` (1059), `src/lib/trust-manifest.mjs` (303) | P1, P5 | Superseded by `init` |
| `ruflo init --full --force` in place | `setup.mjs` project path | P1 | Superseded by staged initializers |
| `ak host pick`, `off`, `reset-routes`, `status`; `ak x host` | `src/commands/x/host.mjs` (1214) | P5 | Superseded. Binding and provider flags become `init` choices; `host status` becomes a section of `status` (**G1**) |
| `ak host adapters`, `ak x aqe-provider`, adapter routing in `ak run` | `x/host-adapters.mjs` (525), `x/host-adapters-grants.mjs` (450), `x/aqe-provider.mjs`, ten `src/lib/adapters/` modules, `execution/admitted.mjs` (372), `execution/adapters.mjs` (53), `hook-audit/providers/external.mjs` (114): about 5,700 lines | P0 | Withdrawn from v4; tagged `archive/v4-host-adapters` for v5 (**G1**) |
| `ak x harvest` | `x/harvest.mjs` (97), `harvest.mjs` (143), the `harvest` live check | P5 | Superseded (**G6**) |
| `ak x aqe-store`, `ak x skills plan` | `x/aqe-store.mjs`, `x/skills.mjs` | P5 | Superseded: folded into `maintain` (**G12**) |
| `ak host check-connection` | `x/host-connection.mjs` (100) | P5 | Superseded by `status --refresh=live` |
| `ak host align`, `ak x host-align` | `x/host-align.mjs` (71), `lib/host-alignment.mjs` (255), Maintenance provider (92) | P3, P5, P7 | Superseded; the `:32` matcher survives as the register repair matcher |
| `ak heal hooks` | `commands/heal.mjs` (168), `lib/hook-remediation/` (about 1,760) | P5, P6 | Partly superseded: project actions move to `maintain` |
| `ak x mcp` and user-scope MCP | `x/mcp.mjs` (92), `lib/mcp.mjs` (674), `providers.mjs:846` | P1, P3 | Superseded |
| `ak x statusline`, `ak x codex-context` | `x/statusline.mjs` (86), `codex-statusline.mjs` (222), `x/codex-context.mjs` (49), `codex-context.mjs` (125) | P3 | Superseded by `init` choices and the register |
| `ak x aqe-embedding`, Ollama provisioning | `x/aqe-embedding.mjs` (89), `aqe-embedding-lifecycle.mjs` (107) | P4 | Superseded |
| `ak x reference` | `x/reference.mjs` (39) | P1, P5 | Superseded |
| `ak x ruflo-mcp` and the user-level memory fallback | `x/ruflo-mcp.mjs` (73), `ruflo-memory.mjs` (152) | P2 | Superseded by `.agentic-kit/bin/ruflo-mcp` |
| `ak x daemon-gc` and the machine-wide sweep | `x/daemon-gc.mjs` (90), `daemons.mjs` (314), `sync.mjs:315` | P2, P6 | Superseded |
| The `ak x dashboard` and `ak x admin` aliases | `bin/agentic-kit.mjs:47,51` | P5 | Superseded (aliases only; **G2**) |
| Kit self-update | `heal.mjs:222`, `versions.mjs` (233) | P2 | Superseded; `alpha.61` stops self-updating |
| Global installs of Ruflo, AQE, agent-browser, typesafe | `heal.mjs:208`, `setup.mjs:322-345`, `ruflo-components/apply.mjs:59` | P2 | Superseded by the tool cache |
| Edits inside the global Ruflo tree | `heal.mjs:28-106`, `install-edits.mjs` (164) | P2 | Superseded; keep the `alpha.61` restore |
| Host CLI installs | `providers.mjs:358`, `sync.mjs:260-289` | P2 | Superseded |
| deja-vu | three modules (1,430) and references in 17 other files; 26 test files; 5 flags | P0 | Superseded; the exit purge removes it |
| Companion registry | `adapters/companion-registry.mjs` (61), `companion-lifecycle-registry.mjs` (27) | P0 | Superseded (**G5**) |
| User guidance blocks | `blocks.mjs` (608), `status/sections/blocks.mjs` (43) | P1, P3 | Superseded by the project rule and the `managed-tools` skill |
| Superpowers block | `blocks.mjs:114-128` | P4 | Superseded by the evidence rule |
| Token-audit skill deploy | `setup.mjs:369-376` | P1 | Superseded: the skill leaves the product and becomes a maintainer-only skill of this repository (master plan Decision G15) |
| `kit.json` schema | `config.mjs` (310), `health-history.mjs` (125), `adapters/grants.mjs:55` | P1, P5 | Superseded by `.agentic-kit/` and the cache |
| User-settings env | `claude-env-projection.mjs` (85), `providers.mjs:469` | P1 | Superseded; the exit purge removes it by receipt |
| User-scope auto-approvals | `registries.mjs:228-256` | P1, P3 | Superseded |
| Codex MCP reconcile and user repairs | `codex-mcp-reconcile.mjs` (109), Maintenance providers (231) | P3, P6 | Partly superseded |
| OpenCode user lifecycle | `opencode-*.mjs` (about 2,041) | P3 | Partly superseded (moves to `.opencode/`) |
| npx cache pruning | `npx.mjs` (76), `owned-storage.mjs` (228), `status/sections/npx.mjs` (25) | P2, P6, P7 | Superseded |
| Brain user mode | `ruvnet-brain.mjs` (324), `brain-hook-contract.mjs` (115), `heal.mjs` Brain functions, status section (134) | P4 | Superseded; the exit purge removes the plugin, shim and LaunchAgent |
| agent-browser placement | `agent-browser.mjs` (447) | P4 | Partly superseded |
| Maintenance user-scope providers | eight providers (about 1,700) | P6 | Partly superseded (become advice) |
| Bare `ak` nudge and writes on GET | `bin/agentic-kit.mjs:251-271`, `nudge.mjs` (73), `versions.mjs:85,184` | P5, P6 | Partly superseded |
| Evidence and derived state under `~/.config` and `~/.local/state` | `evidence.mjs`, `live-check-evidence.mjs`, `model-inventory/store.mjs`, `footprint/snapshot.mjs` | P6 | Partly superseded (moved to the cache) |
| Machine-level status sections | natives, user-memory, daemons, self, versions, statusline, codex-mcp, codex-plugins, codex-context | P5 | Partly superseded |
| `ak uninstall` | `commands/uninstall.mjs` (663) | `alpha.61`, P5 | Exit-critical, then rewritten |
| External adapter lifecycle hooks | `adapters/lifecycle-registry.mjs` (356) | P0 | Superseded with the adapter contract; the built-in hosts' lifecycle stays |

## E. User docs

| Doc | Invalidated sections | Disposition |
| --- | --- | --- |
| `README.md` | Install block, global-install note, commands, deja-vu and hook-heal paragraphs, verbs table, `ak x` list, Codex status line, OpenCode host, tool management | Upgrade steps at beta.1; full rewrite at P5 |
| `docs/installation.md` | Its package-scope versus operational-scope premise, and every global-install section | Rewritten at beta.1 |
| `docs/setup.md` | The whole document | Replaced by an `init` guide at beta.1 |
| `docs/upgrading.md` | Gains "Upgrading from the user-level versions"; host, self-update, daemon and deja-vu entries | beta.1; historical entries kept |
| `docs/archive/2026-10-03-guide-deja-vu.md` | The whole document | Archived at P0 |
| `docs/codex-statusline.md` | The whole document | Rewritten at beta.1 |
| `docs/managed-tools.md`, `docs/host-support.md` | Invariants, companion lifecycle, install modes, external adapters | beta.1 and beta.2 |
| `docs/providers.md`, `docs/hooks.md`, `docs/maintenance.md`, `docs/dashboard.md` | `ak host` and `heal hooks` references, discovery intent, what can act, local state, host badges | beta.3 and beta.4 |
| `docs/troubleshooting.md`, `docs/aqe-embeddings.md`, `docs/telemetry.md`, `docs/devcontainers.md` | Self-update, deja-vu, global installs, daemons, Brain installer, embeddings default, telemetry contract, container setup | Each in its own phase |
| `docs/authoring-host-adapters.md`, `docs/hermes-host-adapter.md`, `docs/host-adapter-freeze-checklist.md` | The whole documents | Removed at beta.1; kept at the `archive/v4-host-adapters` tag |
| `docs/README.md`, `docs/maintainer.md`, `docs/usage-scorecard-metrics.md`, `docs/models.md` | Index entries, self-update notes, store paths | Each in its own phase |
| `docs/ddd/*`, `docs/explainer.html` | Domain-model pages; the explainer's three-scopes section | Each in its own phase |

## F. Proposals

| Proposal | Impact | Disposition |
| --- | --- | --- |
| `metaharness-companion.md` (ADR-0022) | Substance unaffected; it doesn't use the companion registry. Only wording changes | Still needed (v5 intake); wording edits only |
| `autonomous-improvement/` | Partly obsoleted: `ak setup --project --autonomous-lab` becomes an `init` choice; its tracked files need team mode; its state must live in `.agentic-kit/state/`, not the cache; it cites the registry removed in P0 | Still needed (v5 intake); revise before acceptance |
| `project-metadata-adapters.md` | Unaffected; System Projects widens to places | Still needed |
| `v5-planning-sources.md`, `v5-impact-of-v4.md` | Registers | — |

## G. Open issues

| Issue | Impact | Disposition |
| --- | --- | --- |
| #271 Brain held refresh | Obsolete on the new line; a live defect for anyone staying on `alpha.61`. Fixed on `fix/completion-m1`, unmerged | Exit-critical (land the fix) |
| #262 Windows CI | Unaffected; P0's contract tests add Windows load | Exit-critical (the gate or a waiver); measure again after P0 |
| #257 Cowork discovery | Partly subsumed by the coverage card and session sources | Still needed (P6) |
| #255 worker monitor | Unaffected | Still needed (v4.1.0 design card) |
| #240 AQE busy rule | Unaffected; the rule is already retired | Exit-critical (close or rescope) |
| #239 v5 readiness | Partly met by the design. Add a comment mapping the items it meets | Still needed (v5.0.0) |
| #213 Ruflo memory path | The integration point moves to the project launcher | Upstream-dependent (v4.0.0 until rc.1, then v4.1.0) |

## H. The completion program (2026-09-29 and 2026-09-30)

Planned and partly executed on the maintainer's Mac. It reached GitHub on 2026-10-01. None of it
has been through review or CI. Items about `needs-review` issues are excluded: PRG P12–P17, the
ACC rows for those issues, the companion and Route Intelligence decisions (PRG:71-72), and the
part of P10 about #109.

### Code and evidence on `fix/completion-m1`

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| `b535975` | `src/lib/ruvnet-brain.mjs:255-267`; `tests/kit/brain-held-refresh-recovery.test.mjs` | #271: a held refresh expires after the TTL | Finished, unmerged | Brain user mode is superseded at P4 | **Exit-critical** |
| `fb48cb3` | `src/lib/ruvnet-brain.mjs:131-141,331-345` | #271: missing knowledge base versus cached state | Finished, unmerged | Same | **Exit-critical** |
| `dfb5609` | `src/commands/sync.mjs:188-191`; `src/commands/sync/brain-retry.mjs` | #271: `ak sync --retry-brain` | Finished, unmerged | The new `sync` has no such flag | **Exit-critical** (`alpha.61` only) |
| `heal.mjs` comment | `src/lib/heal.mjs:330-338`; CL:106 | Says the reinstall path "isn't blocked" | Not started | Same | **Exit-critical** (in the #271 PR) |
| I271-N04 | ACC:250; M1X:65-66 | Re-verify recovery against the current Brain installer | Not started | P4 stops using the installer's user mode | **Superseded** at P4 |
| `6ab1c5e` | `tests/kit/aqe-store-merge-fixture.test.mjs:14-25`; M1X:94-102 | One transaction for the migration oracle's schema (a #262 speed candidate) | Finished, not measured | Unaffected | **Exit-critical** (inside #262; keep only if timing improves) |
| Live-lock and MCP harness | `03bb230`, `40c2707` (tests), `16ccdd6`; RCP:12 | Opt-in proof that AQE startup reports "busy" and leaves the store intact | Finished | Seeds `kit.json` and runs `aqe init` in place | **Exit-critical** (#240 evidence); rewritten at beta.1 |
| WFL | `40c2707`, `0e42d02` | Dispatch-only AQE conformance job for Linux, macOS and Windows | Finished, never dispatched | Not replaced by staging: P1 changes how `aqe init` runs, not AQE's lock behaviour | **Still needed** → beta.1, rewritten for `ak init` and the tool cache; the shutdown leg waits on #801 |
| `248b1b6` | RCP; ADR-0055:6; ADR-0062:5 | 3.14.6 macOS receipt and ADR lines | Finished | Unaffected | **Exit-critical** (#240 evidence) |
| `f19f84c` | REG:2779-2797 | Registers agentic-qe#801 | Finished | Unaffected | **Upstream-dependent**; register it in `alpha.61` (exit item 10) |
| `456ff58` | v2:7-11; EX:9-13, 236-241 | v2 and EX Status refreshes after #285 | Finished | Unaffected | **Exit-critical** (exit item 7) |
| M1-G01 | M1L:33 | Regression run, review and CI for all of the above | Not started | — | **Exit-critical** (a gate on each PR) |

### Program, milestones and work packages (PRG, ACC)

| ID | Source | Item | State | Impact | Disposition |
| --- | --- | --- | --- | --- | --- |
| M1 | PRG:42-44 | Close the older remediation plans | Started | The same scope as the v2 close-out | **Exit-critical** (exit items 5–9) |
| M2 | PRG:45-46 | Execution evidence, monitor, upgrade proof, provenance; close #239 | Planned | #239 is on v5.0.0, #255 on v4.1.0; no migration code | **Still needed** → v5.0.0 and v4.1.0 |
| M3 | PRG:47-50 | Companions, routing, Cowork, Sessions, ADR-0048 | Planned | The companion registry goes in P0 | **Still needed** → P6 (Cowork) and v5.0.0 (Sessions, ADR-0048) |
| PRG §3, §9 | PRG:84-110, 471-478 | ADR reconciliation; start with P06's fake-worker receipt | Planned | Section C covers the ADRs; #239 is on v5.0.0 | **Superseded** |
| P00 / M1-G02 | PRG:185-195; M1L:34, 115-362 | One closure ledger mapping all 246 rows | Started | Overlaps this ledger | **Exit-critical** (**G11**) |
| P01 | PRG:197-207 | Upstream triage and replies | Started | Decision 3a | **Upstream-dependent** |
| P02 / M1-G03 | PRG:209-218; M1L:35 | #262 | Started | Unaffected | **Exit-critical** |
| P03 (init) | PRG:225; M1L:183, 195 | Repeated `aqe init` convergence; Codex guidance modes | Planned | Staged initializers (P1) | **Superseded** at P1 |
| P03 (#240) | PRG:220-230; M1L:62-73 | Close #240 | Started | Unaffected | **Exit-critical** (**G13**) |
| P03 (Windows) | M1X:111-122 | Windows shutdown proof and Windows run | Started | P1 and P2 change setup | **Still needed** → beta.1 |
| P03 (store) | PRG:227; M1L:185 | Repair old audit-chain forks | Planned | Unaffected | **Upstream-dependent** |
| P04 | PRG:232-241 | #271 | Finished, unmerged | P4 | **Exit-critical** |
| P05, P05b | PRG:243-263 | #213; the upstream contribution lane | Planned | Decision 3a | **Upstream-dependent** |
| P06 | PRG:265-274 | Execution evidence ADR; "preserve existing host admission" | Planned | Admission goes in P0; `ak run` records arrive in P6 | **Still needed** → v5.0.0 (#239), without the admission clause (**G15**) |
| P07, P10 | PRG:276-285, 309-317 | Cancellation and fault matrix; per-invocation provenance | Planned | — | **Still needed** → v5.0.0 |
| P08 | PRG:287-296 | #255 monitor | Planned | — | **Still needed** → v4.1.0 |
| P09 | PRG:298-307 | Clean versus upgraded matrix; setup and sync run twice | Planned | No migration code | **Superseded**; fixtures go to the P0 and P1 contract tests |
| P11 | PRG:319-328 | #257 Cowork | Planned | Coverage card | **Still needed** → P6 |
| P11S | PRG:329-331; ACC:305-339 | Sessions, titles, Activity | Decided, deferred | See SES below | **Still needed** → v5.0.0 intake |
| P18 | PRG:402-411 | Freeze the release candidate | Planned | Becomes the `alpha.61` release card | **Exit-critical** |
| P19 (release) | PRG:417; M1L:37 | Publish; global `ak` matches | Planned | Checked through `npx` | **Exit-critical**; the global match is superseded |
| P19 (jobs) / M1-G04 | PRG:419-420; M1L:36 | Pin, footprint, stray store, temp backlog | Planned | — | **Exit-critical** or waived (exit item 8); the footprint is superseded |
| P19 (upgrade check) | PRG:417-421 | Upgrade, restart, sync twice | Planned | The sandboxed-`HOME` exit test replaces it | **Superseded** |
| P19 (memory and attended time) | PRG:421 | Project-memory read-back with reopened-process evidence; record attended time as unmeasured | Planned | Attended time is recorded as "not instrumented" in DL (#423). One store per project through the project launchers (P1-04, P2-02) replaces the user-level memory path | **Superseded**; the residual upstream proof stays on the Ruflo memory-routing tracker (GA-05, #213) |
| P20 / M1-G08 | PRG:425-434; M1L:40 | Close the issues and archive the plans | Planned | — | **Exit-critical** (exit item 7) |
| M1-G06 | M1L:38, 51-60 | Dispatch evidence read back | Started | — | **Exit-critical** (DoD-3) |
| M1-G07 | M1L:39 | Branch and worktree cleanup | Planned | — | **Superseded** (v2 DoD item 7 already is) |
| v1 steps, AB-row-21 | M1L:78-98, 362 | 14 unchecked v1 steps mapped; a conditional pin check | Finished / planned | — | **Exit-critical** (evidence for archiving v1; with B5-8) |
| I239-01–05, 13, 22, 25 | ACC:203-227 | Validation, identity, monitor, cancellation, provenance, faults, alerts | Planned | `ak run` records are the base | **Still needed** → v5.0.0 |
| I239-06, 08–12, 14 | ACC:208-216 | Owners, predicates, sync scope, host states, causes, services, executables | Partly shipped | P1 and P5 rebuild them on project state | **Still needed** → beta.1 and beta.3 acceptance |
| I239-15–19 | ACC:217-221 | Ingestion states, clipping, lazy payloads | Partly shipped | P6 | **Still needed** → P6 |
| I239-07, 20 | ACC:209, 222 | Memory route proof; upstream owner and first fixed version | Partly shipped | #213; the registry | **Upstream-dependent** |
| I239-21, 23, 24 | ACC:223-226 | Upgrade matrix, upgrade run, sync twice | Planned | No migration code | **Superseded** |
| I255, I257 | ACC:257-262 | Narrative criteria | Planned | — | **Still needed** → v4.1.0 and P6 |
| I262 | ACC:251-256 | Narrative criteria | Started | — | **Exit-critical** |
| #756 | M1X:153-157 | Fix confirmed in AQE 3.14.5's history | Finished | — | **Upstream-dependent** |

### Upstream text

| ID | Source | Item | State | Disposition |
| --- | --- | --- | --- | --- |
| agentic-qe#801 issue | SHC:5-72; REG:2793 | MCP shutdown leaves the `patterns.rvf` lock marker | Posted 2026-10-01 under the maintainer's approval, according to SHC (not checked against GitHub) | **Upstream-dependent**: adoption in v4.1.0 |
| agentic-qe#801 fix | SHC:74-90 | Reset the shared adapter after the server drains | Private; not approved | **Upstream-dependent** (**G14**) |
| Replies to agentic-qe #528, #532, #535 | M1X:130-151 | Three drafts | Not approved, not posted | **Upstream-dependent**; redraft first (**G14**) |
| D-32 | CL:259-271 | Four Ruflo task-ledger defects | Not reproduced | **Upstream-dependent** |
| CL §2.2 | CL:69-80 | Snapshot of upstream-blocked threads | Snapshot | **Upstream-dependent** (the registry is current) |

### The two 2026-09-29 plans (CL, EV)

| ID | Source | Item | State | Disposition |
| --- | --- | --- | --- | --- |
| Status gates | CL:10-15; EV:11-13 | Wait for the develop → main PR | That happened (#285) | **Superseded** |
| D-20 | CL:114-125 | Move four #239 items out of v5 | Decided 2026-09-29 | **Superseded** by master plan Decision 3 (**G10**) |
| D-21, E3 | EV:84-106, 52-54 | Monitor only what `ak run` launches; monitor and alert store | Decided / planned | **Still needed** → v4.1.0 (#255) |
| D-22, D-23, E1, E2 | EV:33-50, 108-138 | Cancellation states and fencing; fake executors; evidence contract; fault-injection worker | Decided / planned | **Still needed** → v5.0.0 (#239); E1's fields shape the P6 `ak run` records card |
| D-24 | CL:132-145 | A hold with an expiry trial and a retry flag | Implemented, except "check the blocking condition first" | **Exit-critical** (#271) |
| D-25 | CL:147-160; PRG:65 | How #240 closes | Recorded twice, differently | **Exit-critical** (**G13**) |
| D-26, W8 (#254, #256) | CL:162-174, 311 | Diagnostics for issues now closed | Closed | **Superseded** |
| D-27 | CL:176-190 | Windows AQE job | Built as WFL | **Still needed** → beta.1 |
| D-28, W5 | CL:192-208 | Declared provider versus observed model | Decided | **Still needed** → v5.0.0 |
| D-29, W9 | CL:210-223 | Cowork spike | Decided | **Still needed** → P6 |
| D-31, W0 | CL:242-257, 342-370 | Archive a plan only when every open row maps to a card | Decided | **Exit-critical** (exit item 7) |
| D-33 | CL:273-282 | Ten green runs in a row for #262 | Replaced by the PRG:60 rule | **Superseded** |
| CL §6 | CL:319-340 | #239 closure map | Planned | **Still needed** → v5.0.0; reused as the #239 mapping comment |
| CL §8 | CL:376-381 | Probes not yet run | Not run | **Still needed** → v4.1.0, beta.1 and P6 |
| W6, E4, EV §5 | CL:297; EV:56-59, 150-163 | Release-level upgrade proof and its gate; upgraded-install matrix | Planned | **Superseded**; fixtures go to beta.1 |

### Session designs (SES, TAX)

| ID | Source | Item | State | Disposition |
| --- | --- | --- | --- | --- |
| SES | SES:3-21, 138-150, 447-476 | One Sessions catalog, meaningful titles, Activity classification, its accuracy gates | Decided, deferred | **Still needed** → v5.0.0 intake. Builds on P6: multiple workspace associations sit on top of each session's single place, the naming rebases on P6's "Places", and the retention decision waits on X4. Its "admitted external host" vocabulary is rewritten (**G15**) |
| TAX | TAX:3-18, 49-165 | Activity families plus a separate Topic hierarchy, including consumer chats | Decided, deferred | **Still needed** → v5.0.0 intake, alongside v5's claude.ai and ChatGPT support |

## Finished and unaffected

These were checked and need no card:

- **v2 decisions:** D-1, D-3, D-8 and D-16 to D-19.
- **v2 branches:** V1 Tasks 1–3; V2 PRs A and B; V3 B0-23, B6a-9 and B6a-12; most of V4; most of
  V5; V6's core items; V7.1.
- **Appendices A and B:** every remaining DONE, DECLINED and SUPERSEDED row.
- **Completion program:** CL D-30 (trunk-based branching, which the master plan follows); the CL §3
  read-only probes, kept as evidence for the #239 card; the M1 local gate run (M1X:216-222).
- **Decision log:** verdicts L2–L6, M1, M1b, M2, M4, P4, N2, N4, N5, U1 and U2. Decisions 2, 11,
  12, C, 14 and 15. Stage 4 items 4.1–4.7, and items 0b–0e. Branch 2 hermeticity. Branch 9
  Tasks 6, 7 and 9–12. The defects already fixed on `main`.
