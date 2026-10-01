# agentic-kit v4 GA program: master plan

## Status

**Active: decisions complete; inventory in progress.** Decisions 1–8 are made, including the
amendment to Decision 3. The supersession ledger that Decision 4 calls for is being compiled. No GitHub issues have been created yet. When the decisions are
complete, this file gains the card inventory (scope, acceptance criteria, size, release and
dependencies for every card) for review before any issue is created.

## Boards

There are three GitHub Projects owned by `pacphi`. Each is linked to `pacphi/agentic-kit` and
has the same columns: Backlog, Ready, In progress, In review and Done.

| Board | Routing label | Milestones | Card depth |
| --- | --- | --- | --- |
| `v4.0.0` | `v4.0.0` | `4.0.0-alpha.61`, `4.0.0-beta.1` … `4.0.0-beta.4`, `4.0.0-rc.1`, `4.0.0` | Unit cards: scope, acceptance criteria, size, release, dependencies |
| `v4.1.0` | `v4.1.0` | `4.1.0` (split into prereleases when v4.1 planning starts) | Intake: problem, outcome, size range, dependencies |
| `v5.0.0` | `v5.0.0` | `5.0.0` | Intake |

## Standing rules

- **`needs-review` is excluded.** An issue labelled `needs-review` is out of the program entirely:
  - It is never put on a board, routed, linked or used as a source for cards.
  - The label is re-checked before every GitHub write.
  - Removing the label brings the issue back for triage.
- **One issue, one board.** Each issue carries exactly one routing label. Work that spans releases
  is split into linked issues: sub-issues for hierarchy, and **Blocked by** / **Blocks** lines for
  dependencies, which work across boards.
- **Epics stay within one major version.** An epic lives on the board where most of its work
  lands.
- **Each card is one branch and one PR.** The PR says `Closes #N`. Execution follows
  [remediation v2's standing rules](2026-09-28-remediation-program-v2.md#5-standing-rules-carried-from-v1).

## Labels and milestones

Labels and milestones belong to the repository, so all three boards share them.

| Label | Meaning |
| --- | --- |
| `v4.0.0`, `v4.1.0`, `v5.0.0` | Routing: which board the issue is on (exactly one) |
| `size:XS` | One file or one setting |
| `size:S` | One module plus tests; under a day |
| `size:M` | A few modules; one to three days |
| `size:L` | Crosses subsystems; three to five days; the card states why it can't be split |
| `ws:project-scope` | The project-scoped management redesign |
| `ws:remediation` | Remediation leftovers and bugs |
| `ws:upstream` | Upstream integration and tracking |
| `ws:ga-readiness` | 4.0 GA readiness: docs, ADRs, upgrade guide |
| `ws:release` | Cutting and publishing a release |
| `ws:capability` | New capability (post-GA) |
| `ws:v5-research` | v5 planning intake |

There is no `size:XL`: an XL card is split.

| Milestone | Board | Contents | npm tag |
| --- | --- | --- | --- |
| `4.0.0-alpha.61` | v4.0.0 | The exit release: v2 close-out, prerequisites A–C, a complete `uninstall --purge` | `next` |
| `4.0.0-beta.1` | v4.0.0 | P0–P2 plus Codex; Claude Code and Codex only | `beta` |
| `4.0.0-beta.2` | v4.0.0 | OpenCode and add-on hosts; P4 | `beta` |
| `4.0.0-beta.3` | v4.0.0 | P5; first half of P6 | `beta` |
| `4.0.0-beta.4` | v4.0.0 | Rest of P6; P7; design closed | `beta` |
| `4.0.0-rc.1` | v4.0.0 | GA readiness and remaining remediation | `next` |
| `4.0.0` | v4.0.0 | General availability | `latest` |
| `4.1.0` | v4.1.0 | Post-GA: upstream integration and new capability | — |
| `5.0.0` | v5.0.0 | v5 planning intake | — |

## Decisions

| # | Decision | Choice (2026-10-01) |
| --- | --- | --- |
| 1 | Release train and version names | **A.** `4.0.0-alpha.61` is the last alpha and the exit release; `next` stays on it. The project-scoped line ships as `4.0.0-beta.1` … `beta.4` on a new **`beta`** npm tag, so older installations never update into it on their own. Then `4.0.0-rc.N` on `next`, and `4.0.0` on `latest`. The release workflow change is a `beta.1` card. Because the release candidates later go on `next`, `alpha.61` never self-updates: its `ak sync` prints the upgrade steps instead (an `alpha.61` card). |
| 2 | What `beta.1` covers | **B.** Claude Code and Codex, including the Codex exception register. OpenCode and add-on hosts follow in `beta.2`. Acceptance criterion on every beta release card until all hosts are back: the release notes say which hosts are supported, which are not yet, the release each is planned for, and that users who rely on them should stay on `alpha.61`. |
| 3 | What each board holds | **A, across three boards.** **v4.0.0:** the project-scope redesign (prerequisites A–C, then P0–P7), remediation v2 close-out and its surviving leftovers, #271, #262, #257, #240 and #213 (waiting on upstream), the gpt-6.1-sol model registry update, and GA readiness. **v4.1.0:** #255, starting with a design card. **v5.0.0:** #239, plus intake cards for the `codex/v5-experience-research` branch, the dashboard taxonomy proposal, and the Claude artifacts and meeting sources in the [v5 planning sources](../proposals/v5-planning-sources.md) register. |
| 3a | Upstream integration (amendment, confirmed) | v4.1.0 gains an **Upstream integration** epic. Its standing card runs the upstream report at the start of v4.1 planning and turns each released fix, or each workaround ak still carries, into a unit card through the existing dispatch flow. A second card raises the tested version range and the default pins. First cards: agentic-qe#655 and #753 (released, workaround still carried), plus an intake card for the three threads with no recorded ak change. **The rule:** upstream work belongs to v4.1.0, unless a fix ships before `4.0.0-rc.1` **and** either removes a workaround the redesign is already touching or affects GA quality. Items still waiting at rc.1 move to v4.1.0. |
| 4 | How the remaining remediation is sequenced against the redesign | **A, triage and fold in.** Each remaining item gets one outcome: **exit-critical** (`alpha.61`: a v2 close-out step, prerequisites A–C, needed for a complete `uninstall --purge`, or a defect that would hurt users staying on `alpha.61`), **superseded** (closed, citing the design section or phase that removes the code; no fix written), **still needed** (the earliest beta whose phase touches that area), or **upstream-dependent** (Decision 3a). The calls are recorded in a supersession ledger. It lists everything planned and not started, started and not finished, or finished and made obsolete by the redesign, with citations, and is reviewed with the master plan. |
| 5 | How release, size and workstream are recorded | **A.** Release is the issue's milestone. Size and workstream are labels. Kind is the GitHub issue type (Task, Bug or Feature). Phases come from the epic and sub-issue structure. The maintainer creates the labels and milestones once (see [Labels and milestones](#labels-and-milestones)); Claude sets them on every card. |
| 6 | How dependencies are recorded | **C.** Every card body carries **Blocked by** and **Blocks** lines; Claude writes and maintains them, and they are the source of truth. `scripts/issue-dependencies.mjs` mirrors them into GitHub's native "Blocked by" links. The maintainer runs it when told to; see the [dependency sync runbook](#dependency-sync-runbook). No `blocked` label. |
| 7 | Review flow: master-plan PR first, or straight to issues | **A, plus a spreadsheet.** The full inventory is reviewed in one PR before any issue exists. The card data is one CSV, `.github/program/v4-ga-cards.csv`: one row per card, with a stable card ID, and dependencies written as card IDs until the issues exist. An XLSX with filterable column headers is generated from it for review; GitHub also renders the CSV as a searchable table. This master plan holds the narrative and per-release summaries; the supersession ledger and the v5 impact review sit beside it. GitHub has no native CSV or XLSX import for issues. After approval, Claude creates the issues from the CSV with its GitHub tools, fills an `issue` column, and rewrites card-ID dependencies as `#number` lines; then the maintainer runs the dependency sync. The design branch gets its own PR first. |
| 8 | Branches and worktrees not visible from the cloud session | **C.** A Claude Code session on the maintainer's Mac, started with `claude remote-control` in the agentic-kit clone, runs read-only checks: worktrees, branches with unpushed commits, uncommitted work, and a search of local Claude Code and Codex session histories for v5 and mockup material. Its findings are pushed as `wip/local-inventory-2026-10-01` and recorded in the supersession ledger and the v5 sources register. Remediation v2's D-9 is the baseline: as of 2026-09-28 the only unmerged local branches were the two v5 branches, both on origin. |

## Card format

Every card's body has these sections, in this order:

1. **Why:** links to the design section, decision-log entry or issue it comes from.
2. **In scope**, then **Out of scope**.
3. **Acceptance criteria:** testable checkboxes.
4. **Dependencies:** exactly two lines, which the dependency script reads.

   ```markdown
   **Blocked by:** #12, #34
   **Blocks:** #56
   ```

   Either line can read `None`. Only `#number` references in this repository count. An issue
   labelled `needs-review` is never listed.
5. **Plan:** release (the milestone), size and workstream (labels), and phase or epic (the parent
   issue).
6. **Verification:** the commands that prove it.

## Dependency sync runbook

`scripts/issue-dependencies.mjs` makes GitHub's native "Blocked by" links match the
**Blocked by** lines in the cards. It reads open issues that carry a routing label (`v4.0.0`,
`v4.1.0`, `v5.0.0`), skips anything labelled `needs-review`, and adds only missing links. A plain
run is a dry run. It is safe to re-run at any time.

**When to run it.** Claude tells you each time, with the number of links to expect:

- after a batch of cards is created, starting with the first population of the boards;
- after Claude adds, changes or removes **Blocked by** lines, for example at a release reconcile;
- whenever you want to check: the dry run never changes anything.

Do not add dependencies by hand in GitHub's UI. Ask Claude to add them to the card text instead,
because the text is the source of truth, and `--prune` would remove hand-made links.

**One-time preparation:**

1. Check the GitHub CLI: `gh --version`. You need 2.48 or newer. If it's missing or older, run
   `brew install gh` or `brew upgrade gh`.
2. Check the sign-in: `gh auth status`. It must show `Logged in to github.com account pacphi`,
   with `repo` among the token scopes. If not, run `gh auth login` (GitHub.com → HTTPS → log in
   with a browser), or `gh auth refresh -s repo`.
3. Check Node: `node --version`. You need 22.13 or newer.
4. Have a local clone of `pacphi/agentic-kit`.

**Each run:**

1. Update the clone so the script is current:

   ```bash
   cd /path/to/agentic-kit && git switch main && git pull --ff-only
   ```

2. Preview, which changes nothing:

   ```bash
   node scripts/issue-dependencies.mjs
   ```

   Read the output:
   - `would add #45 blocked by #12` lines are the links it will create;
   - `kept …` lines are native links not in any card text;
   - `ignored …` lines are self-references or `needs-review` issues;
   - the last line is the summary, for example `14 to add, 0 to remove, 0 kept, 0 ignored`.

   Check that the "to add" count matches what Claude told you to expect.
3. Apply:

   ```bash
   node scripts/issue-dependencies.mjs --apply
   ```

   It prints `added #45 blocked by #12` for each link, pausing about a second between writes.
4. Confirm: run step 2 again. The summary must read `0 to add, 0 to remove`.
5. Spot-check one card on GitHub. The issue's sidebar shows the blocking issue under
   **Relationships → Blocked by**, and the board card shows the *Blocked* marker.
6. Paste the summary line from step 3 into the conversation, so Claude can record the run.

**`--prune`** removes native links that no card lists any more. Use it only when Claude tells you
a dependency was removed from a card's text:

```bash
node scripts/issue-dependencies.mjs --prune
node scripts/issue-dependencies.mjs --apply --prune
```

The first command previews; the second applies.

**If something goes wrong:**

| Symptom | What to do |
| --- | --- |
| `gh: command not found` | Install the GitHub CLI (`brew install gh`), then do the one-time preparation |
| `HTTP 401` or `HTTP 403` (not a rate limit) | `gh auth refresh -s repo`, then run again |
| `secondary rate limit` | Wait five minutes, then run `--apply` again. It continues where it stopped |
| `HTTP 422` on an add | The link already exists or would form a cycle. Run the preview again and paste the output to Claude |
| `HTTP 404` on a dependencies call | Paste the output to Claude. The issue may have been transferred or deleted |
| The run was interrupted | Run `--apply` again. It only adds what is still missing |

Exit codes: `0` means success, `1` an error (the message says which), `2` a usage mistake.

## Release train (v4.0.0)

| Release | Line | Contents |
| --- | --- | --- |
| `4.0.0-alpha.61` | Current line, final release | Remediation v2 close-out (V7; #240 can close with the AQE 3.14.4 evidence its registry entry names), prerequisites A–C, and the exit release with a complete `uninstall --purge` |
| `4.0.0-beta.1` | Project-scoped | P0–P2 and the Codex part of P3 |
| `4.0.0-beta.2` | | OpenCode and add-on hosts (the rest of P3), and P4 |
| `4.0.0-beta.3` | | P5, and the first half of P6 |
| `4.0.0-beta.4` | | The rest of P6, and P7. The design is closed |
| `4.0.0-rc.N`, then `4.0.0` | | GA readiness and any remaining remediation |

## Sources

- [Project-scoped management only](https://github.com/pacphi/agentic-kit/blob/docs/project-scope-only-design/docs/plans/2026-10-01-project-scope-only-design.md), and its prerequisites:
  - [A: the dangling Ruflo reference pointer](https://github.com/pacphi/agentic-kit/blob/docs/project-scope-only-design/docs/plans/2026-10-01-prereq-ruflo-reference-pointer.md);
  - [B: Intelligence writes into projects](https://github.com/pacphi/agentic-kit/blob/docs/project-scope-only-design/docs/plans/2026-10-01-prereq-intelligence-no-project-writes.md);
  - [C: hook scope in the Maintenance inventory](https://github.com/pacphi/agentic-kit/blob/docs/project-scope-only-design/docs/plans/2026-10-01-prereq-maintenance-hook-scope.md).

  Until that design's pull request merges, these documents live on the branch
  `docs/project-scope-only-design`.
- [Remediation program v2](2026-09-28-remediation-program-v2.md), its
  [develop execution plan](2026-09-28-remediation-v2-develop-execution.md), and the
  [issues 237–239 decision log](2026-09-26-issues-237-238-239-verification-and-decisions.md).
- The upstream registry (`src/lib/hook-audit/agentic-dependency-constraints.json`) and its report
  (`node scripts/upstream-watch.mjs report`).
- [v5 planning sources](../proposals/v5-planning-sources.md).
