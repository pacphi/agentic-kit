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
   the commit under test. If you are in a checkout another session uses, run read-only checks
   only and say so.
2. Check the environment: `env | grep -E '^(FORCE_COLOR|AQE_EMBEDDER_|XDG_)'`. Before any command
   below, unset `FORCE_COLOR`, unset `AQE_EMBEDDER_*`, and unset every relative `XDG_*`
   value (for example `env -u FORCE_COLOR -u XDG_STATE_HOME <command>`). Leaked values break tests
   that read plain text and real paths.
3. In a worktree, `node_modules` must be a link to the main checkout's (`ls -ld node_modules`).
   If it is missing, stop and ask the maintainer to set it up; do not install anything.

## Steps

1. Focused tests first, for the files the change touches:
   `node scripts/run-tests.mjs focus <test files>`. Add `tests/kit/docs-layout.test.mjs` when
   any Markdown or `docs/` file changed; `scripts/docs-layout.mjs` is a module, not a command.
2. Static checks, each reported on its own. In a main checkout use
   `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:cc`, `pnpm run lint:md` and
   `pnpm run build`. In a worktree run the same checks without `pnpm`:
   `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/eslint .`,
   `node_modules/.bin/eslint src bin --rule 'complexity: [2, 50]'`, `node_modules/.bin/markdownlint`
   with the globs of the `lint:md` script in `package.json`, and `node scripts/build-check.mjs`.
3. Full unit suite for a non-trivial change: `node scripts/run-tests.mjs unit` (what `pnpm test`
   runs). Read its exit code: 2 means the temp base is inside a git repository, 3 means real
   user state changed, 4 means temporary folders were left behind; each lists the paths.
4. Dashboard or UI changes add `node scripts/run-tests.mjs ui` (`pnpm run test:ui` in a main
   checkout) and a screenshot of the changed view. Needs Chrome; if it cannot launch, it is skipped.
5. Anything that runs `ak` for real uses a disposable home: create the folder, then
   `env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME HOME=<folder>/home ...`,
   and assert `HOME` and every XDG path resolve under it before any `ak` write.
6. When a check fails, read the failure, fix the cause in code you own and rerun that check and
   every check after it. Never edit a test to make it pass or loosen a threshold.

## Gates

- Never plain `node --test`: it lacks the runner's real-state tripwire and temp-root checks. Use
  `node scripts/run-tests.mjs`.
- Never `pnpm` inside a worktree: it tries to delete the linked `node_modules`. Use the runner and
  `node_modules/.bin/*`.
- Never sweep `$TMPDIR` or delete `ak-*` folders by pattern. The runner removes only its own root;
  leftovers are listed for the maintainer, who removes literal paths one per call.
- A check that cannot run (missing link, no Chrome, no `lychee`, no network) is skipped: report it as skipped, never as passed,
  and give the reason. A check you did not run is not a pass.
- Do not commit, push or open anything from this skill.

## Done

End with a plain list, one line per check, in the order run: pass, fail or skipped, the exact
command, and for a failure the first error line; then the commit the results belong to. Say
"gate green" only when nothing is failed and every skipped check was named and accepted by the
maintainer.
