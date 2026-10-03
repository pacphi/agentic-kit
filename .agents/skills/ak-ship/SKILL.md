---
name: ak-ship
description: Take an open agentic-kit pull request from "CI running" to a clean main - watch CI, fix red jobs, squash-merge, delete the backing branch and worktree, pull main, list stale branches. Use when the maintainer says "ship" with a PR number, "squash-merge it", "do the merge dance", or "get that PR progressed".
---

# Ship a pull request

## When to use

The maintainer names one or more open pull requests and wants them merged and cleaned up. If they
say "ship" without a number, ask which PR; never pick one.

## Preflight

1. `gh pr view <N> --json state,isDraft,mergeable,statusCheckRollup,headRefName,baseRefName`.
   Stop if it is not open or not based on `main`.
2. `git worktree list` and `git branch --show-current`. Note any worktree whose branch is the PR's
   head, and note any worktree owned by another session. Never switch branches in a checkout you
   did not create.
3. With several PRs, say the merge order and why (dependencies, shared files) before acting.

## Steps

1. Watch CI: `gh pr checks <N> --watch`. When a job is red, read its log (`gh run view <id>
   --log-failed`) and fix the cause on the PR branch with a test first. A failure that started
   within seconds across every dependency job is the `minimumReleaseAge` policy, not breakage:
   report it and wait.
2. When every required check is green, ask for the merge. After a yes: `gh pr merge <N> --squash`.
   Do not pass `--admin` unless the maintainer names it.
3. Clean up, one removal per call, each verified first:
   - the remote branch is gone: `git ls-remote --heads origin <head>`;
   - the local worktree: `git worktree list`, then `git worktree remove <literal absolute path>`;
   - the local branch: `git branch -d <head>` (use `-D` only when the maintainer says the squash
     is why it looks unmerged).
4. In the main checkout only if it is yours and clean: `git switch main && git pull --ff-only`.
5. Report stale branches (`git branch -vv` marked `gone`) and offer to list them. Do not delete
   them in bulk.

## Gates

- Merge only the pull requests the maintainer named. Never merge a PR that is draft, red or
  behind on required checks.
- One removal per call: list the literal target, check it, remove it, repeat. No blanket `rm`,
  no `git branch -D` loops, no paths directly under `~` or `/`.
- Never merge a release or dependency-consolidation PR without a fresh yes for that PR.
- Never force-push, rewrite history or skip hooks.

## Done

The PR shows `MERGED`, the remote and local branch and the worktree are gone (verified, not
assumed), `main` matches `origin/main`, and the report names anything left behind.
