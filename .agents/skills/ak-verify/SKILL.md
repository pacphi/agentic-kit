---
name: ak-verify
description: Run agentic-kit's completion gate before anything is called done - clean test environment, focused tests, typecheck, lint, markdown lint, build, docs layout, dashboard UI checks - and end with a plain pass, fail or skipped list. Use when the maintainer says "verify", "verify this", "run the completion gate", or "is it done".
---

# Verify before completion

## When to use

Work in this repository is about to be called finished, committed or handed to review. Run this
first and report from it; a claim of "done" without this list is not a claim.

## Preflight

1. `git rev-parse --show-toplevel`, `git branch --show-current` and `git status --short`. Note
   the commit under test. Run `git worktree list`: if this checkout is one another session
   uses (its branch is checked out there, or the maintainer says so), run read-only checks only
   and say so.
2. Check the environment: `env | grep -E '^(FORCE_COLOR|AQE_EMBEDDER_|XDG_)'`. The runner deletes
   `FORCE_COLOR` itself, but not `AQE_EMBEDDER_*` or `XDG_*`, and checks outside the runner get
   none of that. Before any command below, unset `FORCE_COLOR`, unset `AQE_EMBEDDER_*`, and unset every relative `XDG_*`
   value. `env -u` takes literal names, not globs: take each name from the `env | grep` output
   and pass it as its own `-u` (for example `env -u FORCE_COLOR -u AQE_EMBEDDER_X -u XDG_STATE_HOME <command>`).
   An XDG value is relative when it does not start with `/`. Also note which keys of
   `INHERITED_STATE_KEYS` in `tests/kit/helpers/home-sandbox.mjs` are set (`CLAUDE_FLOW_DB_PATH`
   can point at the real Ruflo store); step 5 unsets them for anything that runs `ak`.
3. In a worktree, `node_modules` must be a link to the main checkout's (`ls -ld node_modules`).
   If it is missing, stop and ask the maintainer to set it up; do not create it or install anything.
   Mark every check that needs it skipped, with that reason.

## Steps

1. Focused tests first, for the files the change touches:
   `node scripts/run-tests.mjs focus <test files>`. Add `tests/kit/docs-layout.test.mjs` when
   any Markdown or `docs/` file changed; `scripts/docs-layout.mjs` is a module, not a command.
   That test is only the layout half of the docs gate: for a change to code or docs, finish with
   `ak-docs-gate` for the alignment half.
2. Static checks, each reported on its own. In a main checkout use
   `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:cc`, `pnpm run lint:md` and
   `pnpm run build`. In a worktree run the same checks without `pnpm`:
   `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/eslint .`,
   `node_modules/.bin/eslint src bin --rule 'complexity: [2, 50]'`, `node_modules/.bin/markdownlint`
   with the globs of the `lint:md` script in `package.json`, and `node scripts/build-check.mjs`.
   For a change to docs, also run `lint:links:internal` (a `lychee --offline` script in
   `package.json`); with no `lychee`, it is skipped.
3. Full unit suite for a non-trivial change: `node scripts/run-tests.mjs unit` (what `pnpm test`
   runs). The runner fingerprints real user state before and after. Its exit code is the failing
   command's own code first, otherwise 2 (unsafe temp base such as one inside a git repository
   or the home directory, failed run-owner or hold setup, or bad usage), 3 (real user state
   changed) or 4 (temporary folders left behind); each lists the paths. An exit 3 or 4 is a FAIL
   reported with the listed paths, not retried or cleaned up.
   "Concurrent writers" lines are files a live Claude Code, Ruflo or AQE session wrote during
   the run; they do not fail a local run (CI and `AK_TRIPWIRE_STRICT=1` do fail on them). Report
   them as a note, and never as a pass over a nonzero exit.
4. Dashboard or UI changes add `node scripts/run-tests.mjs ui` (`pnpm run test:ui` in a main
   checkout) and a screenshot of the changed view, saved under the scratchpad or a disposable
   folder, never in the repository. It passes when the view renders the change without errors.
   Needs Chrome; if it cannot launch, it is skipped.
5. Anything that runs `ak` for real uses a disposable home. Create the folder outside any git
   repository and not directly under `~`: `mktemp -d "${TMPDIR:-/tmp}/ak-verify.XXXXXX"` makes it
   (the template form is needed because macOS `mktemp -d` ignores `TMPDIR` without one), then
   `mkdir <folder>/home`. Read `INHERITED_STATE_KEYS` in `tests/kit/helpers/home-sandbox.mjs`:
   the keys that point a child at real per-user state, `CLAUDE_FLOW_DB_PATH` among them. `HOME`
   is set, not unset; pass every key in that list other than `HOME` as its own `-u` (unsetting
   a key that is not set is harmless). Run as
   `env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u <each other key> HOME=<folder>/home <command>`.
   Run `<command>` from a folder inside the disposable folder, never from a checkout: `ak` writes
   into the project it runs in (`.claude`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`) whatever `HOME`
   is. So `mkdir <folder>/proj`, run `git init` in that subfolder and `cd` into it first; the
   disposable folder itself stays outside any repository. Only the assertion below runs from the
   repository root, since it reads `tests/kit/helpers/home-sandbox.mjs`.
   Before any `ak` write, assert `HOME` and every XDG path resolve under the disposable folder:
   from the repository root, with that same `env` prefix, run
   `node --input-type=module -e "import os from 'node:os';import {INHERITED_STATE_KEYS as K} from './tests/kit/helpers/home-sandbox.mjs';console.log(os.homedir());for(const k of K)console.log(k,process.env[k]??'(unset)')"`.
   Stop if `os.homedir()` or `HOME` is outside the folder or any other key prints a value. Leave
   the folder for the maintainer to remove by its literal path.
6. When a check fails, read the failure, fix the cause in code you own and rerun that check and
   every check after it. Never edit a test to make it pass or loosen a threshold.

## Gates

- Never plain `node --test`: it lacks the runner's real-state tripwire and temp-root checks. Use
  `node scripts/run-tests.mjs`.
- Never `pnpm` inside a worktree: it has deleted, or tried to delete, the linked `node_modules`
  (per the maintainer's notes). Use the runner and `node_modules/.bin/*`.
- Never sweep `$TMPDIR` or delete `ak-*` folders by pattern. The runner removes only its own root;
  leftovers are listed for the maintainer, who removes literal paths one per call.
- A check that cannot run (missing link, no Chrome, no `lychee`, no network) is skipped: report it as skipped, never as passed,
  and give the reason. A check you did not run is not a pass.
- Do not commit, push or open anything from this skill.

## Done

End with a plain list, one line per check, in the order run: pass, fail or skipped, the exact
command and its key output line (the test summary for a pass, the first error line for a
failure, "skipped: reason" for a skip); then the commit the results belong to. Say
"gate green" only when nothing is failed and every skipped check was named and accepted by the
maintainer.
