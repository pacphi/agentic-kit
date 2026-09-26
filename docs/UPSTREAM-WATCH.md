# Upstream watch

agentic-kit depends on fixes in Ruflo, Agentic QE, AgentDB, RuVector, RuvNet Brain, Codex and
agent-browser. The upstream watch tracks every upstream thread ak relies on, says when a fix
is ready for ak, and records each event once.

## One registry

[`src/lib/hook-audit/agentic-dependency-constraints.json`](../src/lib/hook-audit/agentic-dependency-constraints.json)
is the only upstream registry. It ships with ak because the hook audit reads it. It holds:

- `dependencyPolicies`: per dependency, the publication rule (`explicit-user-approval-required`),
  the evidence needed, and the **removal proof** a workaround must pass before it goes.
- `constraints`: version-bound workarounds with a retest date and a sunset condition
  ([ADR-0041 §7](adr/0041-host-neutral-hook-configuration-assurance.md#7-upstream-constraints-are-lifecycle-data)).
- `watchPolicy`: our GitHub logins, the stale limit (90 days), automated-reply patterns, the
  ledger issue and its sentinel, and the dispatch rules.
- `watch`: every upstream issue or pull request ak filed, commented on, or cites in `src/`,
  `bin/`, `claude/` or `tests/`, plus ak's own tracking issues that migrate here.

The [schema](schemas/agentic-dependency-constraints.schema.json) describes the shape; the
loader (`src/lib/hook-audit/upstream.mjs`) also checks that each constraint's issue has a
watch entry naming it. `tests/kit/upstream-watch-registry.test.mjs` fails when source cites a
watched-repository thread the list lacks, or when a file an entry names no longer cites it.

A watch entry records:

| Field | Meaning |
|---|---|
| `id`, `url`, `kind`, `title` | The thread (`owner/repo#n`, issue or pr). |
| `relation` | `filed`, `commented`, `referenced` (cited, not ours) or `tracking` (our issue that migrates here; lists `tracks`). |
| `dependency` | The dependency policy that governs it. AgentDB threads use `ruflo`: ak gets AgentDB through Ruflo. |
| `doneWhen` | `closed-completed` or `merged`, plus the release channel and the first fixed version when known. |
| `mapping`, `kitImpact`, `adjustment` | Whether ak carries something for it, which files and plan or decision refs, and the change ak makes when it lands. |
| `status`, `history` | Lifecycle status and dated events. |
| `constraintIds` | Constraints this thread backs. |

## Lifecycle

`watching` → `fixed-unreleased` → `released` → `dispatched` → `adopted` → `retired`.

- **watching**: open upstream.
- **fixed-unreleased**: closed as completed or merged; no release contains it yet.
- **released**: a published release contains the fix; the ak change is pending.
- **dispatched**: a draft pull request on `upstream/<id>` makes the ak change.
- **adopted**: ak relies on the fix; nothing is left to change.
- **retired**: nothing to watch. Retired entries stay as records and are not checked.

The watcher does not change statuses. The maintainer, or a dispatch pull request, updates the
entry and adds a dated `history` line.

## Re-verifying constraints

Weekly, and before a managed upgrade, re-check each constraint's issue state on GitHub and the
released versions on npm. Update `issueState` where it changed, set `lastVerifiedAt` to the
check date and every `nextRetestAt` one week later, and list what was not re-verified
(reproductions, conformance, sunset conditions) in the commit body. The tests take their
clock from `lastVerifiedAt`, so this is a data-only change.

## The check

`scripts/upstream-watch.mjs` is maintainer tooling; it is not published. It reads GitHub with
`gh api` and releases with `npm view` or GitHub releases, at most four calls at a time, and
writes nothing. If `gh` is missing or signed out it says so and reports only what the registry
records. It exits 0 unless the command line is wrong.

```bash
node scripts/upstream-watch.mjs report [--json]
node scripts/upstream-watch.mjs check --since <iso-date> [--ledger <file>] [--json]
```

`report` gives counts, then these groups (a thread can be in more than one):

| Group | Rule |
|---|---|
| Needs our reply | A comment from someone else, not a bot, after our last word (a filed issue's body counts) and after the entry's last status change. Automated acknowledgements show as "acknowledged" instead. |
| Released and actionable | Upstream fixed, a release contains the fix, the entry is `watching` or `fixed-unreleased`, and ak has an adjustment. Carries the dispatch branch and removal proof. With no recorded first fixed version, the first release after the fix is a **candidate**: confirm it contains the fix. |
| Fixed upstream, ak still carries the workaround | The entry is `released` or `dispatched` and ak has an adjustment. |
| Fixed upstream, not yet released | Upstream fixed, no release contains it, and the entry is `watching` or `fixed-unreleased`. |
| Reopened upstream | Open upstream while the entry says fixed, released, dispatched or adopted. |
| Waiting on upstream | Open, not stale, and nobody is waiting on us. |
| No upstream activity for 90+ days | Open, and nobody but us has written for `staleAfterDays`. |
| Closed upstream as not planned | Closed with reason `not_planned`. |
| Ready to retire | `adopted`, or closed upstream with nothing in ak waiting on it. |
| Constraints past their retest date | A constraint's `nextRetestAt` has passed. |
| Tracking issues to migrate | Open `tracking` entries. |
| Unmapped | No ak change recorded. |

## The ledger

The ledger is one pinned issue titled "Upstream watch" in `pacphi/agentic-kit`. The maintainer
creates and pins it when creating the daily routine. Each event is a line:

```text
UPSTREAM-WATCH <id> <event> <yyyy-mm-dd> [key=value ...]
```

Events: `reply`, `acknowledged`, `closed`, `merged`, `released`, `reopened`, `stale`,
`retire-proposed`, `retest-due` (constraint id) and `idle` (id `registry`, nothing left to
watch). `check --since` limits replies, acknowledgements, closures and merges to activity after
`--since`. The other events repeat while their condition holds, dated by the upstream fact, so
the same fact always gives the same line. `--ledger <file>` drops any line already in the
ledger: an exact line is never acted on twice.

## Dispatch

For a `released` line: branch `upstream/<id>` (for example `upstream/ruvnet-ruflo-3194`) from
`main`, make the entry's `adjustment` test-first, pass the dependency policy's `removalProof`,
set the entry to `dispatched` with a dated history line, and open a **draft** pull request that
links the upstream thread. Nothing merges it but the maintainer.

## The skill

Ask Claude Code or Codex for "upstream status" in this repository. The `upstream-status` skill
(`.claude/skills/` and `.agents/skills/`, identical) runs `report --json`, gives counts first
and the action items with links, and offers to draft a reply, dispatch a released item or
update the registry. It never posts, pushes or merges without explicit confirmation.

## The daily routine (create after this reaches `main`)

There is one watcher: a claude.ai cloud routine on this repository. The tracking issues
pacphi/agentic-kit#240 and pacphi/agentic-kit#213 migrate into the registry once it is live. The maintainer creates the routine, and that
authorizes exactly its writes in this repository: ledger comments, `upstream/*` branches and
draft pull requests. It never comments upstream and never merges.

- **Schedule:** daily at 14:00 UTC (`0 14 * * *`).
- **Prompt:**

```text
You are agentic-kit's upstream watcher. Work in a fresh clone of pacphi/agentic-kit on main.
1. Find the pinned open issue titled "Upstream watch". Save every comment body to ledger.md.
   SINCE is the time of its newest comment, or 7 days ago if it has none.
2. Run: node scripts/upstream-watch.mjs check --since "$SINCE" --ledger ledger.md
3. If it prints "No new upstream events." (or "No events:"), stop.
4. Post one comment on the ledger issue: the printed lines verbatim in a text code block, then
   one plain sentence per line saying what happened.
5. For each "released" line whose branch= does not exist yet: create that branch from main,
   make the registry entry's adjustment test-first, run the repository checks, set the entry
   to dispatched with a dated history line, push, and open a DRAFT pull request that links the
   upstream thread and quotes the dependency policy's removal proof. Never merge.
6. Take no other action. Never comment on upstream repositories.
```
