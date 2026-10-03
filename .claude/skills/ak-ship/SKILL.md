---
name: ak-ship
description: Take an open agentic-kit pull request from "CI running" to a clean main - watch CI, fix red jobs, squash-merge, delete the backing branch and worktree, pull main, list stale branches. Use when the maintainer says "ship" with a PR number, "squash-merge it", "do the merge dance", or "get that PR progressed".
---

# Ship a pull request

## When to use

The maintainer names one or more open pull requests and wants them merged and cleaned up. If they
say "ship" without a number, ask which PR; never pick one.

## Preflight

1. `gh pr view <N> --json state,isDraft,mergeable,statusCheckRollup,headRefName,headRefOid,baseRefName,author,isCrossRepository`.
   Stop and report if it is not open, is a draft, is `CONFLICTING`, or is not based on `main`
   (a stacked PR: say so and ask what to do).
2. `git worktree list` and `git branch --show-current`. Note any worktree whose branch is the PR's
   head, and any worktree owned by another session. Never switch branches in a checkout you
   did not create.
3. With several PRs, say the merge order and why (dependencies, shared files) before acting.

## Steps

1. Watch required CI: `gh pr checks <N> --required --watch`, bounded by the maintainer's patience;
   report if it runs long. For a red job, take the run id from the link in the checks output and
   read it with `gh run view <id> --log-failed`. A failure that started within seconds across
   every dependency job is the `minimumReleaseAge` policy, not breakage: report it and wait.
2. Fix a red job only in a worktree this session created for the PR's head branch (for example
   `git worktree add ../agentic-kit-wt-ship-<N> <head>`), never in a checkout another session
   uses. Write the failing test first and commit locally. Ask before pushing. A PR from another
   author or a fork is reported, not pushed to.
3. When every required check is green, ask for the merge. After a yes for that PR:
   `gh pr merge <N> --squash --match-head-commit <sha>`, where `<sha>` is `headRefOid` from the
   preflight (re-read it if the branch moved, and ask again). No `--admin` unless named.
4. Clean up. List each literal target (remote branch, worktree path, local branch) and get an
   explicit yes for that action, then remove one per call:
   - remote branch: GitHub auto-delete is expected; check `git fetch --prune`, then
     `git ls-remote --heads origin <head>`. If it is still there, say so and ask before
     `git push origin --delete <head>`;
   - worktree: only when the PR is `MERGED` with `headRefOid` equal to the merged head, `git -C
     <path> status --porcelain` is empty, the shell's cwd is not inside it and no other session
     owns it. Then `git worktree remove <literal absolute path>`;
   - local branch: a squash merge always looks unmerged, so `git branch -d` fails and `-D` is the
     normal path. Name the branch, say why, and use `-D` only after the yes.
5. In the main checkout only if it is yours and has an empty `git status --porcelain`:
   `git switch main && git pull --ff-only`. If `main` is checked out in another worktree, run
   `git pull --ff-only` there only if it is yours, else report and skip.
6. After `git fetch --prune`, report stale branches (`git branch -vv` marked `gone`) and offer to
   list them. Do not delete them in bulk.

## Gates

- Merge only the pull requests the maintainer named. Every merge needs a yes for that PR, and
  a release or dependency-consolidation PR needs a fresh one. Never merge a PR that is draft,
  red, conflicting or short of required checks.
- Get an explicit yes before any deletion (remote branch, worktree, local branch), per target.
- One removal per call: list the literal target, check it, remove it, repeat. No blanket `rm`,
  no `git branch -D` loops, no paths directly under `~` or `/`.
- Never `--force` a worktree removal; a dirty worktree is reported and left.
- Never force-push, rewrite history or skip hooks.

## Done

The PR shows `MERGED`, and each cleanup the maintainer approved is verified, not assumed. `main`
matches `origin/main` unless step 5 was skipped, and the report names anything left behind.
