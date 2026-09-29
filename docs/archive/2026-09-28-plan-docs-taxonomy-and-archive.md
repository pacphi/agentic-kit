# Documentation Taxonomy, Naming and Archive Plan

> Execute task by task, in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every folder under `docs/` one purpose, give every document a quiet lower-case name, move point-in-time material into `docs/archive/`, and add rules and a guard test so all of this holds from then on. No link may break.

**Architecture:** Three phases, all run later.

- **Phase 1** adds two small, tested tools:
  - `scripts/docs-relocate.mjs` moves and renames files with `git mv`. It rewrites every Markdown and HTML link to and from them, and every exact mention of their paths in code, config and prose.
  - `scripts/docs-layout.mjs` states the layout and naming rules as code, and a guard test enforces them.
- **Phase 2** runs the relocation from a reviewed map, finishes the few edits that need judgment, writes the indexes, and adds the rules to this repository's `CLAUDE.md` and `AGENTS.md`.
- **Phase 3**, last, repairs every link inside `docs/archive/` and puts the archive under lychee and markdownlint.

**Tech Stack:** Node.js ESM scripts, `node:test`, git, lychee (offline in CI, online nightly), markdownlint-cli2, ESLint.

**Spec:** the maintainer decisions of 2026-09-28, recorded in [§ Decisions](#decisions). There is no separate spec document.

**Status:** Implemented, 2026-09-28. Phase 1 and Phase 2 merged in PR #264 at
`main@e7cfe9ca`; Phase 3 merged in PR #266 at `main@7936ca48`.

## Decisions

Recorded from the maintainer, 2026-09-28:

1. Dormant proposals get their own home: `docs/proposals/`.
2. Nothing moves now. This is a separate plan with rules and actions, executed later. Enforcement is ongoing through this repository's `CLAUDE.md` and `AGENTS.md`. Keep a clear line between rules for **this repository under development** and what is **packaged for users** (the templates ak installs or updates).
3. Repair every link inside `docs/archive/`. Relink to the original source where it can be found; otherwise remove the link and adjust the text. Never invent a connection. Both lychee and markdownlint must cover the archive. This goes last.
4. Archive index: one row per file, including each image.
5. Superpowers must write into the existing `docs/` folders, never `docs/superpowers/`:
   - plans (writing-plans) go to `docs/plans/`;
   - specs (brainstorming) also go to `docs/plans/`.

   No new sub-folders; use the convention above.
6. **Naming.** `README.md` is the only all-caps document name. Every other all-caps `.md` document is renamed to lower case, with its links and references updated; for example `docs/MODELS.md` becomes `docs/models.md`. `MAINTAINER.md` moves from the root to `docs/maintainer.md`.
7. **`explainer.html` moves to `docs/explainer.html`**, provided GitHub Pages keeps working. Why that holds:
   - Pages is built by `.github/workflows/pages.yml` (`build_type: workflow`), not served from a folder.
   - The site is that one self-contained file; it has no relative `src` or `href`.
   - The mention pass rewrites the workflow's trigger path and its `cp` step.

   The 2026-09-28 rehearsal staged the site from the new path; the page's only change was three doc-name mentions in lower case. Task 9 verifies the deploy after merge.

**Interpretation, for the maintainer to confirm:** `CLAUDE.md`, `AGENTS.md` and `SKILL.md` keep their capitals. Claude Code, Codex and OpenCode, and agent skills, read those exact names, so renaming them would switch the files off.

## Target layout

| Location | Purpose | What arrives | What leaves |
| --- | --- | --- | --- |
| Repository root | `README.md`, `CLAUDE.md`, `AGENTS.md` only | — | Every other document |
| `docs/*.md`, `docs/explainer.html` | Living guides and references, lower-case names, indexed with their audience in `docs/README.md` | New guides | Dated audits and proposals |
| `docs/adr/` | Decision records in every status | New ADRs | Nothing. ADRs never move |
| `docs/ddd/` | Living domain model | — | — |
| `docs/schemas/` | Living interchange contracts | — | — |
| `docs/assets/` | Figures that living guides use | — | Historical mocks go to the archive |
| `docs/plans/` | In-flight plans and specs (Superpowers included), and an active program's decision log | `YYYY-MM-DD-<feature>.md`, `YYYY-MM-DD-<topic>-design.md` | Everything, when its work merges |
| `docs/proposals/` | Dormant proposals awaiting a decision | `<topic>.md` or a `<topic>/` docset | Accepted: becomes a plan or ADR. Rejected or abandoned: archived as `YYYY-MM-DD-proposal-<topic>` |
| `docs/archive/` | Frozen history, flat, `YYYY-MM[-DD]-<origin>-<topic>.<ext>`, one index row per file | Finished plans and specs, dated audits and evidence, superseded material | — |

Origins used in archive names: `superpowers-plan`, `superpowers-spec`, `plan`, `audit`, `evidence`, `validation`, `artifact`, `design`, `proposal`, `research`, `shell-kit`, `swarm-prompt`, `upstream`.

Retired folders: `docs/superpowers/`, `docs/audits/`, `docs/evidence/`, `docs/implementation/`, `docs/autonomous/`, plus the on-disk leftovers `docs/design/` and `docs/research/`.

## Two layers of rules (decision 2)

**Layer A: this repository only (nothing is shipped).**

- Root `CLAUDE.md`: auto-loaded by Claude Code. Superpowers treats a location stated here as the user preference that overrides its `docs/superpowers/...` defaults.
- Root `AGENTS.md`: read by Codex and OpenCode.
- `docs/maintainer.md`, `docs/README.md` and each folder's `README.md`.
- `scripts/docs-layout.mjs` and its guard test, and `scripts/docs-relocate.mjs`.

**Layer B: packaged for users.**

- The `claude/*.md` blocks, which ak writes into users' `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and OpenCode `AGENTS.md`.
- `src/templates/**`.
- The project block from `src/lib/project-guidance.mjs`, which is only an `@AGENTS.md` pointer.

This plan adds no rule to Layer B. The only change there is a comment in `src/templates/statusline-footer.cjs` that names the maintainer guide's new path. The guard fails if any Layer B file names `docs/plans/`, `docs/proposals/` or `docs/archive/`, so this repository's layout can't leak into users' projects.

The renamed guides that ship in the npm package (`package.json#files`) are user documentation, not rules. Their new names reach users in the next release.

`AGENTS.md` also contains Ruflo-generated sections. The rule lives in its own authored section, and the guard fails if a regeneration drops it.

## Global Constraints

- Work in a worktree: `git worktree add ../agentic-kit-docs-taxonomy -b docs/taxonomy-reorg main`. Phase 3 uses its own branch, `docs/archive-link-repair`, cut from `main` after Phase 2 merges.
- **No `pnpm` in worktrees.** Run tests with `node scripts/run-tests.mjs unit` (or `node --test <file>`); lint with `npx --no-install eslint <changed files>` and `npx --no-install markdownlint-cli2`; check links with `lychee`.
- Scope ESLint to the files you changed. Never run `git add -A`.
- Every move or rename is a `git mv` made by `scripts/docs-relocate.mjs`. Case-only renames work on case-insensitive disks with git 2.54; the tool refuses a clash with a different file.
- Archived bodies are frozen except for:
  - link targets (Phases 2 and 3);
  - lint-only formatting (Phase 3);
  - the text beside a link that Phase 3 removes for lack of a source. Record each of these in the archive README.

  Mention rewriting skips `docs/archive/`.
- Shipped docs (`package.json#files`) link to unshipped files only through absolute `https://github.com/pacphi/agentic-kit/blob/main/...` URLs.
- Commit messages follow the repository's conventional style (`docs:`, `test:`, `feat(docs):`) with no attribution trailer. The maintainer opens and merges PRs.

## Review Focus

1. **Example links and paths inside code blocks or inline code in plans and specs.** The link pass must not touch them. Pinned by the Task 1 test "links inside fenced blocks and inline code are never edited".
2. **A link that was already broken before the move** must not be "repaired" to a guessed target. Pinned by the Task 1 test "prose that names an old path and a link that was already broken stay as written"; Phase 3 repairs these only on evidence.
3. **Case-only renames on a case-insensitive disk,** such as `docs/MODELS.md` → `docs/models.md`, must be allowed; a clash with a different file must be refused. Pinned by the Task 1 test "a case-only rename is allowed; a clash with another file or an existing destination is not".
4. **`ruflo init` or `aqe init` regenerating `AGENTS.md` or `CLAUDE.md`** must not silently drop the rule. Pinned by the Task 2 test "both agent instruction files carry the layout rule", and by Task 7's tree test.
5. **A Superpowers session writing to `docs/superpowers/`, or anyone adding an all-caps name,** must fail CI with a message saying what to do instead. Pinned by the Task 2 tests "only the named folders may exist under docs/" and "Markdown names are lower case except README.md and the names tools read verbatim".

---

## When to run

Run this plan only when **no open branch or PR** changes a file it moves or renames. That's nearly every top-level doc, so pick a quiet moment:

```bash
gh pr list --state open --json number,headRefName,files \
  --jq '.[] | select([.files[].path] | any(test("^(docs/[A-Z][^/]*[.]md|MAINTAINER[.]md|explainer[.]html|docker/[A-Z][^/]*[.]md|docs/(superpowers|audits|evidence|implementation|autonomous)/)"))) | "\(.number) \(.headRefName)"'
```

Expected: no output. If a PR is listed, merge or rebase it first. GitHub can return `files: []` for a very large or just-pushed PR, which this filter would pass silently, so check each open PR with `gh pr view <number> --json files` if in doubt.

**If the remediation program (`2026-09-26-remediation-program.md`) is still open**, both it and its decision log (`2026-09-26-issues-237-238-239-verification-and-decisions.md`) move to `docs/plans/` under the same names. Tests read that log, and it gains a section per branch. Both move to `docs/archive/` in the PR that merges Branch 9. After moving them:

```bash
printf 'docs/plans/2026-09-26-remediation-program.md\n' > .superpowers/sdd/2026-09-26-remediation-program/plan-path
```

If the program has finished, both go straight to `docs/archive/` as `2026-09-26-superpowers-plan-remediation-program.md` and `2026-09-26-audit-issues-237-238-239-verification-and-decisions.md`. Edit their rows in Appendix A accordingly.

**The tree drifts.** Appendix A was generated against `main@82d1211b`. Task 3 regenerates it.

---

## Phase 1: tools (PR A, commits 1–2)

### Task 1: Relocation tool that keeps links and references working

**Files:**

- Create: `scripts/docs-relocate.mjs`
- Test: `tests/kit/docs-relocate.test.mjs`

**Interfaces:**

- Produces:
  - `parseMap(tsv) → {from, to, mode: 'move'|'redirect'}[]`
  - `relocate(path, rows) → string`
  - `protectCode(text) → {masked, restore(text)}`
  - `rewriteText(text, oldFile, newFile, rows, exists) → {text, rewritten, broken}` (links)
  - `rewriteMentions(text, rows, {bare}) → {text, changed: {line, before, after}[]}` (exact paths, URLs, regex-literal paths, and bare names of same-folder renames)
  - `destinationProblem(row, tracked, exists) → string|null`
  - `emptiedDirs(moves) → string[]`
  - `isText(file) → boolean`
  - `DEFAULT_SKIPS` (the archive, this tool, the layout guard and their tests: their example paths are fixtures)
  - `main(argv)`
  - CLI: `node scripts/docs-relocate.mjs --map <file.tsv> [--mentions] [--bare] [--skip <prefix>]... [--dry-run]`
- Map rows: `move` rows are `git mv`ed. `redirect` rows only retarget links, and a folder row (ending in `/`) must be `redirect`.

- [ ] **Step 1: Write the failing test** at `tests/kit/docs-relocate.test.mjs`:

````js
// scripts/docs-relocate.mjs moves documentation without breaking a link to or
// from the moved files, and never touches code, prose or already-broken links.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKIPS, destinationProblem, emptiedDirs, isText, parseMap, protectCode, relocate, rewriteMentions, rewriteText,
} from '../../scripts/docs-relocate.mjs';

const rows = parseMap([
  '# comment',
  'docs/superpowers/plans/2026-01-02-x.md\tdocs/archive/2026-01-02-superpowers-plan-x.md',
  'docs/audits/README.md\tdocs/archive/README.md\tredirect',
  'docs/audits/\tdocs/archive/\tredirect',
].join('\n'));
const exists = (p) => !p.includes('missing');

test('a move map defaults to move, skips comments and refuses a folder move', () => {
  assert.deepEqual(rows.map((row) => row.mode), ['move', 'redirect', 'redirect']);
  assert.throws(() => parseMap('docs/a/\tdocs/b/'), /folder row can only redirect/);
  assert.throws(() => parseMap('docs/a.md'), /bad map row/);
});

test('relocate follows exact rows first, then folder rows, else leaves the path', () => {
  assert.equal(relocate('docs/superpowers/plans/2026-01-02-x.md', rows), 'docs/archive/2026-01-02-superpowers-plan-x.md');
  assert.equal(relocate('docs/audits/README.md', rows), 'docs/archive/README.md');
  assert.equal(relocate('docs/audits/other.md', rows), 'docs/archive/other.md');
  assert.equal(relocate('docs/HOOKS.md', rows), 'docs/HOOKS.md');
});

test('a link into a moved file follows it and keeps its fragment', () => {
  const { text, rewritten } = rewriteText('See [x](superpowers/plans/2026-01-02-x.md#task-2).', 'docs/HOOKS.md', 'docs/HOOKS.md', rows, exists);
  assert.equal(text, 'See [x](archive/2026-01-02-superpowers-plan-x.md#task-2).');
  assert.equal(rewritten, 1);
});

test('a moved file\'s own links are re-based on its new folder', () => {
  const { text } = rewriteText('[ADR](../../adr/0001-a.md) [same](2026-01-02-x.md)',
    'docs/superpowers/plans/2026-01-02-x.md', 'docs/archive/2026-01-02-superpowers-plan-x.md', rows, exists);
  assert.equal(text, '[ADR](../adr/0001-a.md) [same](2026-01-02-superpowers-plan-x.md)');
});

test('absolute blob/main URLs to a moved file are rewritten; other URLs are not', () => {
  const before = 'https://github.com/pacphi/agentic-kit/blob/main/docs/superpowers/plans/2026-01-02-x.md#a and https://github.com/pacphi/agentic-kit/blob/main/docs/HOOKS.md';
  const { text } = rewriteText(before, 'README.md', 'README.md', rows, exists);
  assert.equal(text, 'https://github.com/pacphi/agentic-kit/blob/main/docs/archive/2026-01-02-superpowers-plan-x.md#a and https://github.com/pacphi/agentic-kit/blob/main/docs/HOOKS.md');
});

test('links inside fenced blocks and inline code are never edited', () => {
  const before = 'Use `[x](superpowers/plans/2026-01-02-x.md)` like this:\n\n```md\n[x](superpowers/plans/2026-01-02-x.md)\n```\n';
  const { text, rewritten, broken } = rewriteText(before, 'docs/HOOKS.md', 'docs/HOOKS.md', rows, exists);
  assert.equal(text, before);
  assert.equal(rewritten, 0);
  assert.deepEqual(broken, []);
  const guarded = protectCode(before);
  assert.equal(guarded.restore(guarded.masked), before);
});

test('prose that names an old path and a link that was already broken stay as written', () => {
  const before = 'Moved from docs/superpowers/plans/2026-01-02-x.md. [gone](missing.md)';
  const { text, broken } = rewriteText(before, 'docs/HOOKS.md', 'docs/HOOKS.md', rows, exists);
  assert.equal(text, before);
  assert.deepEqual(broken, ['missing.md']);
});

test('HTML href attributes are rewritten too', () => {
  const { text } = rewriteText('<a href="../superpowers/plans/2026-01-02-x.md#t">x</a>', 'docs/assets/m.html', 'docs/assets/m.html', rows, exists);
  assert.equal(text, '<a href="../archive/2026-01-02-superpowers-plan-x.md#t">x</a>');
});

test('the folders a move may empty are listed deepest first and stop above docs/', () => {
  assert.deepEqual(emptiedDirs([
    { from: 'docs/evidence/context/usage/a.png' },
    { from: 'docs/audits/b.md' },
  ]), ['docs/evidence/context/usage', 'docs/evidence/context', 'docs/audits', 'docs/evidence']);
});

test('a case-only rename is allowed; a clash with another file or an existing destination is not', () => {
  const tracked = new Set(['docs/MODELS.md', 'docs/models-old.md', 'docs/Other.md', 'docs/other.md']);
  const caseInsensitive = (p) => [...tracked].some((file) => file.toLowerCase() === p.toLowerCase());
  assert.equal(destinationProblem({ from: 'docs/MODELS.md', to: 'docs/models.md' }, tracked, caseInsensitive), null);
  assert.match(destinationProblem({ from: 'docs/Other.md', to: 'docs/other.md' }, tracked, caseInsensitive), /clashes with docs\/other\.md/);
  assert.match(destinationProblem({ from: 'docs/MODELS.md', to: 'docs/models-old.md' }, tracked, caseInsensitive), /clashes/);
  assert.match(destinationProblem({ from: 'docs/gone.md', to: 'docs/x.md' }, tracked, caseInsensitive), /not tracked/);
});

test('mentions: exact repository paths and URLs change; longer names and other repositories do not', () => {
  const renames = parseMap('docs/MAINTENANCE.md\tdocs/maintenance.md\nMAINTAINER.md\tdocs/maintainer.md\n');
  const before = [
    "const DOCS = ['docs/MAINTENANCE.md'];",
    'see docs/MAINTENANCE-ACCEPTANCE.md and ruvnet/ruflo/docs/MAINTENANCE.md',
    'https://github.com/pacphi/agentic-kit/blob/main/docs/MAINTENANCE.md#gates',
    "path.join(ROOT, 'MAINTAINER.md')",
  ].join('\n');
  const { text, changed } = rewriteMentions(before, renames);
  assert.deepEqual(text.split('\n'), [
    "const DOCS = ['docs/maintenance.md'];",
    'see docs/MAINTENANCE-ACCEPTANCE.md and ruvnet/ruflo/docs/MAINTENANCE.md',
    'https://github.com/pacphi/agentic-kit/blob/main/docs/maintenance.md#gates',
    "path.join(ROOT, 'docs/maintainer.md')",
  ]);
  assert.deepEqual(changed.map((c) => c.line), [1, 3, 4]);
});

test('bare names change only with --bare and only for same-folder renames', () => {
  const rows = parseMap('docs/UPGRADING.md\tdocs/upgrading.md\ndocs/MODEL-PRICING-AUDIT.md\tdocs/archive/2026-09-23-audit-model-pricing.md\n');
  const before = "path.join(ROOT, 'docs', 'UPGRADING.md'); see MODEL-PRICING-AUDIT.md";
  assert.equal(rewriteMentions(before, rows).text, before);
  assert.equal(rewriteMentions(before, rows, { bare: true }).text, "path.join(ROOT, 'docs', 'upgrading.md'); see MODEL-PRICING-AUDIT.md");
});

test('mentions inside a regex literal are rewritten in their escaped form', () => {
  const rows = parseMap('docs/SETUP.md\tdocs/setup.md\n');
  assert.equal(rewriteMentions('assert.match(out, /docs\\/SETUP\\.md/);', rows).text, 'assert.match(out, /docs\\/setup\\.md/);');
  assert.equal(rewriteMentions('/SETUP\\.md/', rows, { bare: true }).text, '/setup\\.md/');
});

test('the mention pass reads code, config and Dockerfiles, and never its own fixtures or the archive', () => {
  for (const file of ['docker/Dockerfile', 'src/a.mjs', 'package.json', '.github/workflows/ci.yml', 'docs/x.md']) assert.ok(isText(file), file);
  for (const file of ['docs/a.png', 'docs/x.svg', 'bin/tool']) assert.ok(!isText(file), file);
  assert.deepEqual(DEFAULT_SKIPS, [
    'docs/archive/', 'scripts/docs-relocate.mjs', 'scripts/docs-layout.mjs',
    'tests/kit/docs-relocate.test.mjs', 'tests/kit/docs-layout.test.mjs',
  ]);
});
````

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/kit/docs-relocate.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/docs-relocate.mjs`.

- [ ] **Step 3: Write the implementation** at `scripts/docs-relocate.mjs`:

```js
// Move documentation files and keep every link to and from them working.
//
// A move map is a TSV of `from<TAB>to[<TAB>redirect]` repository paths.
// `move` rows are `git mv`ed; `redirect` rows only retarget links (the
// caller folds or deletes the source). A row ending in `/` maps a folder.
// Links are rewritten in every tracked .md and .html file: relative links
// into a moved file, relative links out of a moved file whose folder changed,
// and absolute github.com/pacphi/agentic-kit blob|tree/main URLs. Fragments
// are kept verbatim; prose and code spans are never edited, and a link that
// was already broken is left as it is and reported. Folders a move empties are
// removed, so no empty directory is left behind.
//
// `--mentions` also rewrites exact repository paths and github.com URLs in
// every tracked text file (code, config, prose), except DEFAULT_SKIPS and any
// `--skip <prefix>`. `--bare` adds bare file names for renames that
// stay in the same folder (`'UPGRADING.md'` in a path.join). Paths written
// inside a regex literal (`/docs\/SETUP\.md/`) are rewritten too. A dry run lists
// every mention it would change, for review. Case-only renames are allowed on
// case-insensitive disks; a clash with a different file is refused.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const posix = path.posix;
const REPO_URL = /(https:\/\/github\.com\/pacphi\/agentic-kit\/(?:blob|tree)\/main\/)([^\s)"'#<>]+)/g;
const LINK = /(\]\()([^)\s#]+)(#[^)\s]*)?(\))|(href=")([^"#]+)(#[^"]*)?(")/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;
const TEXT = /(?:\.(?:md|mjs|cjs|js|json|jsonc|ya?ml|toml|html|txt|sh)|(?:^|\/)(?:Dockerfile|Makefile))$/;
/** Whether the mention pass reads `file` as text. */
export const isText = (file) => TEXT.test(file);
// Never rewritten by the mention pass: frozen history, and this tool, the layout
// guard and their tests, whose example paths are fixtures, not references.
export const DEFAULT_SKIPS = [
  'docs/archive/',
  'scripts/docs-relocate.mjs',
  'scripts/docs-layout.mjs',
  'tests/kit/docs-relocate.test.mjs',
  'tests/kit/docs-layout.test.mjs',
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path token: not glued to a longer path or name on either side.
const token = (value) => new RegExp(`(?<![A-Za-z0-9_./-])${escape(value)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');
// The same path as written inside a JavaScript regex literal: /docs\/SETUP\.md/.
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const literalToken = (value) => new RegExp(`(?<![A-Za-z0-9_.-])${escape(literal(value))}(?![A-Za-z0-9_-])`, 'g');
const both = (text, from, to) => text.replace(token(from), to).replace(literalToken(from), literal(to));

/**
 * Hide Markdown code (fenced blocks and inline spans) behind placeholders so
 * example links inside code are never rewritten or reported.
 */
export function protectCode(text) {
  const kept = [];
  const stash = (chunk) => `\u0000${kept.push(chunk) - 1}\u0000`;
  const out = [];
  let fence = null;
  let block = [];
  for (const line of text.split('\n')) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      block.push(line);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        out.push(stash(block.join('\n')));
        block = [];
        fence = null;
      }
      continue;
    }
    if (open) { fence = open[1]; block = [line]; continue; }
    out.push(line);
  }
  if (fence) out.push(stash(block.join('\n')));
  const masked = out.join('\n').replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (span) => stash(span));
  return { masked, restore: (value) => value.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]) };
}

/** @returns {{ from: string, to: string, mode: 'move'|'redirect' }[]} */
export function parseMap(tsv) {
  return tsv.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [from, to, mode = 'move'] = line.split('\t');
    if (!from || !to || !['move', 'redirect'].includes(mode)) throw new Error(`bad map row: ${line}`);
    if (from.endsWith('/') && mode === 'move') throw new Error(`a folder row can only redirect: ${line}`);
    return { from, to, mode };
  });
}

/** New location for a repository path, or the path itself when nothing moved it. */
export function relocate(target, rows) {
  const exact = rows.find((row) => row.from === target || row.from === `${target}/`);
  if (exact) return exact.to.endsWith('/') && !target.endsWith('/') ? exact.to.slice(0, -1) : exact.to;
  const folder = rows.find((row) => row.from.endsWith('/') && target.startsWith(row.from));
  return folder ? folder.to + target.slice(folder.from.length) : target;
}

/**
 * Rewrite the links in `text`, a file that lived at `oldFile` and now lives at
 * `newFile`. `exists(path)` answers whether a repository path exists before the
 * move (so already-broken links are left alone). Returns the text and counts.
 */
export function rewriteText(text, oldFile, newFile, rows, exists) {
  let rewritten = 0;
  const broken = [];
  const code = oldFile.endsWith('.md') ? protectCode(text) : { masked: text, restore: (value) => value };
  let out = code.masked.replace(LINK, (match, open, raw, frag = '', close, hOpen, hRaw, hFrag = '', hClose) => {
    const target = raw ?? hRaw;
    if (EXTERNAL.test(target)) return match;
    let decoded;
    try { decoded = decodeURIComponent(target); } catch { return match; }
    const trailing = decoded.endsWith('/');
    const resolved = posix.normalize(posix.join(posix.dirname(oldFile), decoded));
    const bare = trailing ? resolved.replace(/\/$/, '') : resolved;
    if (!exists(bare)) { broken.push(target); return match; }
    const moved = relocate(bare, rows);
    if (moved === bare && oldFile === newFile) return match;
    let next = posix.relative(posix.dirname(newFile), moved.replace(/\/$/, '')) || '.';
    if (trailing || moved.endsWith('/')) next += '/';
    if (target !== decoded) next = encodeURI(next);
    if (next === target) return match;
    rewritten++;
    return raw !== undefined ? `${open}${next}${frag}${close}` : `${hOpen}${next}${hFrag}${hClose}`;
  });
  out = out.replace(REPO_URL, (match, prefix, repoPath) => {
    const moved = relocate(repoPath, rows);
    if (moved === repoPath) return match;
    rewritten++;
    return prefix + moved;
  });
  return { text: code.restore(out), rewritten, broken };
}

/**
 * Why `row` cannot be moved, or null. A case-only rename is fine even though a
 * case-insensitive disk reports the destination as existing.
 * @param {{from: string, to: string}} row
 * @param {Set<string>} tracked
 * @param {(path: string) => boolean} exists
 */
export function destinationProblem(row, tracked, exists) {
  if (!tracked.has(row.from)) return `not tracked: ${row.from}`;
  const caseOnly = row.from !== row.to && row.from.toLowerCase() === row.to.toLowerCase();
  const clash = [...tracked].find((file) => file !== row.from && file.toLowerCase() === row.to.toLowerCase());
  if (clash) return `destination clashes with ${clash}: ${row.to}`;
  if (!caseOnly && exists(row.to)) return `destination exists: ${row.to}`;
  return null;
}

/**
 * Rewrite exact mentions of moved paths in any text: repository paths and
 * github.com blob|tree/main URLs, plus bare names of same-folder renames when
 * `bare` is set. Returns the text and the lines that changed.
 */
export function rewriteMentions(text, rows, { bare = false } = {}) {
  const moves = rows.filter((row) => row.mode === 'move').sort((a, b) => b.from.length - a.from.length);
  let out = text.replace(REPO_URL, (match, prefix, repoPath) => prefix + relocate(repoPath, rows));
  for (const row of moves) out = both(out, row.from, row.to);
  if (bare) {
    for (const row of moves) {
      const [from, to] = [posix.basename(row.from), posix.basename(row.to)];
      if (from !== to && posix.dirname(row.from) === posix.dirname(row.to)) out = both(out, from, to);
    }
  }
  const before = text.split('\n');
  const changed = out.split('\n').flatMap((line, i) => (line === before[i] ? [] : [{ line: i + 1, before: before[i], after: line }]));
  return { text: out, changed };
}

/** Folders the moves may empty, deepest first, never `docs` itself or above. */
export function emptiedDirs(moves) {
  const dirs = new Set();
  for (const { from } of moves) {
    for (let dir = posix.dirname(from); dir.startsWith('docs/'); dir = posix.dirname(dir)) dirs.add(dir);
  }
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

export function main(argv) {
  const mapFile = argv[argv.indexOf('--map') + 1];
  const dryRun = argv.includes('--dry-run');
  const bare = argv.includes('--bare');
  const mentions = bare || argv.includes('--mentions');
  const skips = [...DEFAULT_SKIPS, ...argv.flatMap((arg, i) => (arg === '--skip' ? [argv[i + 1]] : []))];
  if (!argv.includes('--map') || !mapFile) {
    console.error('usage: node scripts/docs-relocate.mjs --map <file.tsv> [--mentions] [--bare] [--skip <prefix>]... [--dry-run]');
    return 2;
  }
  const rows = parseMap(fs.readFileSync(mapFile, 'utf8'));
  const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
  const trackedDirs = new Set([...tracked].flatMap((file) => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const existsBefore = (p) => tracked.has(p) || trackedDirs.has(p);
  const moves = rows.filter((r) => r.mode === 'move');
  for (const row of moves) {
    const problem = destinationProblem(row, tracked, fs.existsSync);
    if (problem) throw new Error(problem);
  }
  const docs = [...tracked].filter((file) => /\.(md|html)$/.test(file));
  let links = 0; let files = 0; const broken = [];
  const edits = docs.map((oldFile) => {
    const newFile = moves.find((r) => r.from === oldFile)?.to ?? oldFile;
    const result = rewriteText(fs.readFileSync(oldFile, 'utf8'), oldFile, newFile, rows, existsBefore);
    broken.push(...result.broken.map((link) => `${oldFile}: ${link}`));
    if (result.rewritten) { links += result.rewritten; files++; }
    return { oldFile, newFile, ...result };
  });
  if (!dryRun) {
    for (const row of moves) {
      fs.mkdirSync(posix.dirname(row.to), { recursive: true });
      git(['mv', row.from, row.to]);
    }
    for (const edit of edits) if (edit.rewritten) fs.writeFileSync(edit.newFile, edit.text);
    for (const dir of emptiedDirs(moves)) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
  let mentionLines = 0;
  if (mentions) {
    const byFrom = new Map(moves.map((row) => [row.from, row.to]));
    for (const oldFile of [...tracked].filter(isText)) {
      const file = byFrom.get(oldFile) ?? oldFile;
      if (skips.some((prefix) => file.startsWith(prefix) || oldFile.startsWith(prefix))) continue;
      const edited = edits.find((edit) => edit.oldFile === oldFile && edit.rewritten);
      const source = edited ? edited.text : fs.readFileSync(dryRun ? oldFile : file, 'utf8');
      const result = rewriteMentions(source, rows, { bare });
      if (!result.changed.length) continue;
      mentionLines += result.changed.length;
      if (dryRun) for (const c of result.changed) console.log(`${oldFile}:${c.line}\n  - ${c.before.trim()}\n  + ${c.after.trim()}`);
      else fs.writeFileSync(file, result.text);
    }
  }
  console.log(`${dryRun ? 'would move' : 'moved'} ${moves.length}; ${links} link(s) in ${files} file(s)`
    + (mentions ? `; ${mentionLines} mention line(s)` : ''));
  if (broken.length) console.log(`already broken (left unchanged):\n  ${broken.join('\n  ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node --test tests/kit/docs-relocate.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx --no-install eslint scripts/docs-relocate.mjs tests/kit/docs-relocate.test.mjs
git add scripts/docs-relocate.mjs tests/kit/docs-relocate.test.mjs
git commit -m "feat(docs): relocation tool that keeps every link and reference to moved docs"
```

### Task 2: The layout and naming rules as code, with fixture tests

**Files:**

- Create: `scripts/docs-layout.mjs`
- Test: `tests/kit/docs-layout.test.mjs`

**Interfaces:**

- Produces:
  - `DOC_FOLDERS`, `NAME_EXCEPTIONS`, `ROOT_DOCS`
  - `RULE_HEADING = '## Documentation layout'`
  - `RULE_FILES`, `PACKAGED_PREFIXES`, `REPO_ONLY_PATHS`
  - `layoutProblems({files, read}) → string[]`
- Consumed by: Task 7 (the tracked-tree test) and Task 6 (the index check).

- [ ] **Step 1: Write the failing test** at `tests/kit/docs-layout.test.mjs`:

```js
// The documentation layout guard. Fixture tests pin each rule; the last test
// holds the tracked tree to it (enabled once the reorganisation lands).
import test from 'node:test';
import assert from 'node:assert/strict';

import { DOC_FOLDERS, NAME_EXCEPTIONS, ROOT_DOCS, RULE_HEADING, layoutProblems } from '../../scripts/docs-layout.mjs';

const RULE = `${RULE_HEADING}\n\nPlans and specs go to docs/plans/.\n`;
const tree = (entries) => ({ files: Object.keys(entries), read: (file) => entries[file] ?? '' });
const base = {
  'CLAUDE.md': RULE,
  'AGENTS.md': RULE,
  'docs/README.md': '[Hooks](hooks.md)',
  'docs/archive/README.md': '[a](2026-01-02-audit-x.md)',
};

test('a conforming tree has no problems', () => {
  assert.deepEqual(layoutProblems(tree({
    ...base,
    'docs/archive/2026-01-02-audit-x.md': '',
    'docs/plans/2026-01-02-y.md': '',
    'docs/plans/README.md': '',
    'docs/proposals/autonomous-improvement/contracts.md': '',
    'docs/proposals/metaharness-companion.md': '',
    'docs/hooks.md': '',
    'claude/skills/x/SKILL.md': '',
    'README.md': '',
    'claude/ruflo-preamble.md': 'use /docs for documentation',
  })), []);
});

test('only the named folders may exist under docs/', () => {
  assert.deepEqual(Object.keys(DOC_FOLDERS).sort(), ['adr', 'archive', 'assets', 'ddd', 'plans', 'proposals', 'schemas']);
  const [problem] = layoutProblems(tree({ ...base, 'docs/superpowers/plans/2026-01-02-y.md': '' }));
  assert.match(problem, /docs\/superpowers\/ is not a documentation folder.*docs\/plans\//);
});

test('archive files are flat, dated, and each has an index row', () => {
  const problems = layoutProblems(tree({
    ...base,
    'docs/archive/sub/2026-01-02-a.md': '',
    'docs/archive/notes.md': '',
    'docs/archive/2026-01-03-audit-unindexed.md': '',
  }));
  assert.equal(problems.length, 3);
  assert.match(problems[0], /flat/);
  assert.match(problems[1], /YYYY-MM\[-DD\]-<origin>-<topic>/);
  assert.match(problems[2], /add a row/);
});

test('plan and proposal names follow their patterns', () => {
  const problems = layoutProblems(tree({ ...base, 'docs/plans/my-plan.md': '', 'docs/proposals/a/b/c.md': '' }));
  assert.equal(problems.length, 2);
});

test('every top-level guide is listed in docs/README.md', () => {
  assert.deepEqual(layoutProblems(tree({ ...base, 'docs/new-guide.md': '' })), ['docs/new-guide.md: list it in docs/README.md']);
});

test('both agent instruction files carry the layout rule', () => {
  const problems = layoutProblems(tree({ ...base, 'AGENTS.md': '# agentic-kit\n' }));
  assert.deepEqual(problems, ['AGENTS.md: missing the "## Documentation layout" section that names docs/plans/']);
});

test('shipped guidance never names this repository\'s own folders', () => {
  const [problem] = layoutProblems(tree({ ...base, 'claude/superpowers-reference.md': 'write plans to docs/plans/' }));
  assert.match(problem, /^claude\/superpowers-reference\.md: shipped guidance names this repository's own docs\/plans\//);
});

test('Markdown names are lower case except README.md and the names tools read verbatim', () => {
  assert.deepEqual(Object.keys(NAME_EXCEPTIONS).sort(), ['AGENTS.md', 'CLAUDE.md', 'README.md', 'SKILL.md']);
  const problems = layoutProblems(tree({
    ...base,
    'docs/README.md': '[Models](MODELS.md) [Maintainer](maintainer.md)',
    'docs/MODELS.md': '',
    'docs/maintainer.md': '',
    'docker/USER-GUIDE.md': '',
  }));
  assert.deepEqual(problems, [
    'docs/MODELS.md: Markdown names are lower case; rename it to models.md',
    'docker/USER-GUIDE.md: Markdown names are lower case; rename it to user-guide.md',
  ]);
});

test('the repository root keeps only README.md, CLAUDE.md and AGENTS.md', () => {
  assert.deepEqual(ROOT_DOCS, ['README.md', 'CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(layoutProblems(tree({ ...base, 'maintainer.md': '', 'explainer.html': '' })), [
    'maintainer.md: documentation lives under docs/; the root keeps only README.md, CLAUDE.md, AGENTS.md',
    'explainer.html: documentation lives under docs/; the root keeps only README.md, CLAUDE.md, AGENTS.md',
  ]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/kit/docs-layout.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/docs-layout.mjs`.

- [ ] **Step 3: Write the implementation** at `scripts/docs-layout.mjs`:

```js
// The documentation layout, as code: which folders `docs/` may contain, how
// archived and planned files are named, and the rule text the repository's
// own agent instructions must carry. tests/kit/docs-layout.test.mjs runs
// layoutProblems() over the tracked tree; the fixture tests pin each rule.
//
// Repository-only: nothing here is shipped, and the kit's own layout must not
// leak into the guidance templates ak projects onto users' machines.

export const DOC_FOLDERS = {
  adr: 'decision records, every status; never moved',
  archive: 'frozen history, flat, YYYY-MM[-DD]-<origin>-<topic>.<ext>, one index row per file',
  assets: 'figures that living guides use',
  ddd: 'the living domain model',
  plans: 'in-flight plans, specs and an active program\'s decision log',
  proposals: 'dormant proposals awaiting a decision',
  schemas: 'living interchange contracts',
};

// Markdown names are lower case. These are the only exceptions: README.md by
// convention, and the names a tool reads verbatim.
export const NAME_EXCEPTIONS = {
  'README.md': 'the one all-caps document name, by convention',
  'CLAUDE.md': 'Claude Code reads this exact name',
  'AGENTS.md': 'Codex and OpenCode read this exact name',
  'SKILL.md': 'agent skills require this exact name',
};
const MD_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;
// The repository root keeps only these documents; everything else is under docs/.
export const ROOT_DOCS = ['README.md', 'CLAUDE.md', 'AGENTS.md'];

// The heading and path both agent instruction files must carry.
export const RULE_HEADING = '## Documentation layout';
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md'];
// Shipped guidance (npm `files`) that must never name the kit's own folders.
export const PACKAGED_PREFIXES = ['claude/', 'src/templates/'];
export const REPO_ONLY_PATHS = ['docs/plans/', 'docs/proposals/', 'docs/archive/'];

const ARCHIVE_NAME = /^\d{4}-\d{2}(?:-\d{2})?-[a-z0-9][a-z0-9.-]*\.(?:md|html|json|jsonl|csv|mjs|png|svg)$/;
const PLAN_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9.-]*\.md$/;
const PROPOSAL_NAME = /^(?:[a-z0-9][a-z0-9-]*\/)?(?:[a-z0-9][a-z0-9-]*|README)\.md$/;

/**
 * Every way the tracked tree breaks the layout, as readable sentences.
 * @param {{ files: string[], read: (file: string) => string }} tree
 * @returns {string[]}
 */
export function layoutProblems({ files, read }) {
  const problems = [];
  const archiveIndex = files.includes('docs/archive/README.md') ? read('docs/archive/README.md') : '';
  const guideIndex = files.includes('docs/README.md') ? read('docs/README.md') : '';
  for (const file of files) {
    const parts = file.split('/');
    const name = parts.at(-1);
    if (parts.length === 1 && /\.(?:md|html)$/.test(file) && !ROOT_DOCS.includes(file)) {
      problems.push(`${file}: documentation lives under docs/; the root keeps only ${ROOT_DOCS.join(', ')}`);
    }
    if (name.endsWith('.md') && !(name in NAME_EXCEPTIONS) && !MD_NAME.test(name)) {
      problems.push(`${file}: Markdown names are lower case; rename it to ${name.toLowerCase()}`);
    }
    if (parts[0] === 'docs' && parts.length === 2 && file.endsWith('.md') && file !== 'docs/README.md'
      && !guideIndex.includes(`](${parts[1]})`)) {
      problems.push(`${file}: list it in docs/README.md`);
    }
    if (parts[0] === 'docs' && parts.length > 2) {
      const folder = parts[1];
      const rest = parts.slice(2).join('/');
      if (!(folder in DOC_FOLDERS)) {
        problems.push(`${file}: docs/${folder}/ is not a documentation folder; in-flight plans and specs go to docs/plans/, finished work to docs/archive/`);
      } else if (folder === 'archive' && rest !== 'README.md') {
        if (parts.length > 3) problems.push(`${file}: docs/archive/ is flat; no subfolders`);
        else if (!ARCHIVE_NAME.test(rest)) problems.push(`${file}: archive names are YYYY-MM[-DD]-<origin>-<topic>.<ext>`);
        else if (!archiveIndex.includes(`](${rest})`)) problems.push(`${file}: add a row for it to docs/archive/README.md`);
      } else if (folder === 'plans' && rest !== 'README.md' && !PLAN_NAME.test(rest)) {
        problems.push(`${file}: plan names are YYYY-MM-DD-<topic>.md`);
      } else if (folder === 'proposals' && !PROPOSAL_NAME.test(rest)) {
        problems.push(`${file}: proposals are docs/proposals/<topic>.md or docs/proposals/<topic>/<name>.md`);
      }
    }
    if (PACKAGED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      const leaked = REPO_ONLY_PATHS.filter((repoPath) => read(file).includes(repoPath));
      if (leaked.length) problems.push(`${file}: shipped guidance names this repository's own ${leaked.join(', ')}`);
    }
  }
  for (const file of RULE_FILES) {
    const text = files.includes(file) ? read(file) : '';
    if (!text.includes(RULE_HEADING) || !text.includes('docs/plans/')) {
      problems.push(`${file}: missing the "${RULE_HEADING}" section that names docs/plans/`);
    }
  }
  return problems;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node --test tests/kit/docs-layout.test.mjs`
Expected: PASS, 9 tests. The tracked tree isn't checked yet; Task 7 adds that.

- [ ] **Step 5: Lint and commit**

```bash
npx --no-install eslint scripts/docs-layout.mjs tests/kit/docs-layout.test.mjs
git add scripts/docs-layout.mjs tests/kit/docs-layout.test.mjs
git commit -m "test(docs): state the documentation layout and naming rules as code"
```

## Phase 2: reorganize and rename (PR A, commits 3–7)

### Task 3: Refresh the move map

**Files:**

- Modify: this plan's Appendix A

- [ ] **Step 1: List every file the rules say must move or be renamed**

```bash
{ git ls-files docs/superpowers docs/audits docs/evidence docs/implementation docs/autonomous \
    docs/assets/about-tab-mock.html docs/assets/system-tab-mock.html explainer.html
  git ls-files '*.md' | awk -F/ '$NF ~ /[A-Z]/ && $NF !~ /^(README|CLAUDE|AGENTS|SKILL)\.md$/'
} | sort -u > /tmp/docs-due.txt
wc -l < /tmp/docs-due.txt
```

- [ ] **Step 2: Compare with Appendix A**

```bash
sed -n '/<!-- move-map:start -->/,/<!-- move-map:end -->/p' docs/plans/2026-09-28-docs-taxonomy-and-archive.md \
  | awk -F'`' '/^\| `/ && $2 !~ /\/$/ {print $2}' | sort > /tmp/docs-mapped.txt   # file rows, move or redirect
comm -23 /tmp/docs-due.txt /tmp/docs-mapped.txt   # new files the map lacks
comm -13 /tmp/docs-due.txt /tmp/docs-mapped.txt   # rows whose file is gone
```

- [ ] **Step 3: Add or remove rows** so both `comm` outputs are empty. Classify each new file:
  - **An all-caps document name:** lower-case it in place (`docs/NEW-GUIDE.md` → `docs/new-guide.md`). A root document moves to `docs/` in lower case.
  - **A plan or spec whose implementing PR has merged:** `docs/archive/<date>-superpowers-plan-<name>` or `-superpowers-spec-<name>`. Find the merge with `git log --oneline main -S'<file basename>'`.
  - **A plan or spec whose work is still open:** `docs/plans/<same name>`.
  - **A dated audit or evidence record:** `docs/archive/<date>-audit-<topic>` or `-evidence-<topic>`, using the date in its name or its first commit (`git log --diff-filter=A --format=%cs -- <file> | tail -1`).
  - **The remediation program and its decision log:** as [§ When to run](#when-to-run) says.

- [ ] **Step 4: Extract the map**

```bash
MAP=/tmp/docs-move-map.tsv
sed -n '/<!-- move-map:start -->/,/<!-- move-map:end -->/p' docs/plans/2026-09-28-docs-taxonomy-and-archive.md \
  | awk -F'`' '/^\| `/{ mode = ($0 ~ /\| redirect \|$/) ? "redirect" : "move"; print $2 "\t" $4 "\t" mode }' > "$MAP"
awk -F'\t' '{print $3}' "$MAP" | sort | uniq -c
```

Expected: one line per mode. At `82d1211b` that was 121 `move` and 9 `redirect`.

- [ ] **Step 5: Commit the refreshed plan**

```bash
git add docs/plans/2026-09-28-docs-taxonomy-and-archive.md
git commit -m "docs(plans): refresh the docs taxonomy move map"
```

### Task 4: Move, rename, and rewrite references

**Files:** every row of Appendix A. The mention pass also edits code, config and prose that name a moved path.

- [ ] **Step 1: Record which shipped docs already link to unshipped files** (the baseline for Task 5)

```bash
node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path';
const files = JSON.parse(fs.readFileSync('package.json','utf8')).files.filter(f => f.startsWith('docs/') && f.endsWith('.md'));
const shipped = new Set(files.map(f => f.toLowerCase()));
for (const f of files) for (const m of fs.readFileSync(f,'utf8').matchAll(/\]\(([^)#\s:]+\.md)/g)) {
  const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).toLowerCase();
  if (!shipped.has(t)) console.log(f.toLowerCase() + ' -> ' + t);
}" | sort > /tmp/shipped-links-before.txt; wc -l < /tmp/shipped-links-before.txt
```

Paths are lower-cased so the before and after lists compare across the rename.

- [ ] **Step 2: Dry run, and review every mention it would change**

```bash
node scripts/docs-relocate.mjs --map /tmp/docs-move-map.tsv --bare \
  --skip tests/kit/usage-prompt-patterns.test.mjs \
  --skip docs/plans/2026-09-28-docs-taxonomy-and-archive.md \
  --dry-run > /tmp/docs-dry-run.txt
grep -E '^would move' /tmp/docs-dry-run.txt
```

The two `--skip` entries are deliberate:

- The prompt fixture quotes a user saying "See MAINTAINER.md's…", which is data, not a reference.
- This plan's own map must keep its `from` column.

The tool also skips `DEFAULT_SKIPS` on its own: the archive, and itself, the layout guard and their tests, which were committed in Phase 1 and whose example paths are fixtures.

Expected:

- At `82d1211b`: `would move 121; 359 link(s) in 100 file(s); 254 mention line(s)`. The counts shift a little with drift.
- The "already broken" list is exactly the 12 links in [Appendix B](#appendix-b--the-12-historical-archive-links).

Read every `-`/`+` pair in `/tmp/docs-dry-run.txt`. If a line names another project's file, add `--skip <that file>` and re-run the dry run.

- [ ] **Step 3: Run it for real**

```bash
node scripts/docs-relocate.mjs --map /tmp/docs-move-map.tsv --bare \
  --skip tests/kit/usage-prompt-patterns.test.mjs \
  --skip docs/plans/2026-09-28-docs-taxonomy-and-archive.md
find docs docker -type d -empty   # expect no output
git diff --quiet HEAD -- scripts/docs-relocate.mjs scripts/docs-layout.mjs \
  tests/kit/docs-relocate.test.mjs tests/kit/docs-layout.test.mjs && echo "tool fixtures untouched"
grep -nE "docs/explainer\.html" .github/workflows/pages.yml   # the trigger path and the cp step
```

- [ ] **Step 4: Fold the two retired folder READMEs into the archive README**

In `docs/archive/README.md`, add this section after "Reading archived material safely":

```markdown
### Reading audit and evidence records

Audit reports and evidence records describe the source, installed artifacts, local observations,
environment and test method they name, and only those. "Current", "implemented" or "uncommitted"
is relative to the recorded inspection, not a claim about this checkout or another machine. A
saved digest or passing fixture does not establish current runtime health, all-host parity,
production readiness or permission to release. A proposed repair is not authorization to run it.
Opt-in conformance commands inside these records may run real host processes or inference; their
presence is not a request to run them. Machine-readable inventories are observations, not
executable policy, ownership receipts or release capabilities.
```

Then remove the old READMEs. The tool has already retargeted their links and rewritten links inside them, which is why `-f` is needed:

```bash
git rm -f docs/audits/README.md docs/evidence/README.md
```

- [ ] **Step 5: Check links: the CI scope first, then the archive on its own**

```bash
lychee --offline --include-fragments --no-progress --config lychee.toml README.md CLAUDE.md AGENTS.md \
  'docker/*.md' 'claude/**/*.md' 'src/templates/**/*.md' 'docs/**/*.md'
printf '' > /tmp/empty-lychee.toml
lychee --config /tmp/empty-lychee.toml --offline --include-fragments --no-progress --format compact \
  docs/archive/*.md docs/archive/*.html docs/plans/*.md docs/proposals/*.md docs/proposals/*/*.md docs/explainer.html
```

Expected: the first reports `0 Errors`; the second reports exactly the 12 Appendix B errors.

- [ ] **Step 6: Commit**

```bash
git add -u && git add docs docker
git commit -m "docs: lower-case document names, archive point-in-time docs, home proposals and open plans, update references"
```

### Task 5: The edits that need judgment

**Files:**

- Modify: `scripts/upstream-watch/citations.mjs`, `tests/kit/upstream-watch-registry.test.mjs`
- Modify: `package.json` (`files`, `lint:links`, `lint:links:internal`), `.markdownlint-cli2.jsonc`, `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`
- Modify: `docs/maintainer.md`, `docs/codex-statusline.md`, `docs/adr/0058-managed-ruflo-components.md`, `docs/assets/README.md`

- [ ] **Step 1: List what is left**

```bash
git grep -nE 'docs/(superpowers|audits|evidence|implementation|autonomous)/|docs/assets/(about|system)-tab-mock|(^|[^A-Za-z/-])(MAINTAINER|[A-Z]+(-[A-Z]+)*)\.md' \
  -- . ':!docs/archive' ':!docs/plans/2026-09-28-docs-taxonomy-and-archive.md' \
  | grep -vE '(README|CLAUDE|AGENTS|SKILL)\.md' | grep -vE 'usage-prompt-patterns.test.mjs'
```

What remains is:

- bare names of files that moved to another folder (the bare pass only covers same-folder renames);
- names that belong to other projects.

For each hit:

- Other project's file (for example `docs/OPERATIONS.md` in the autonomous proposal, which names another repository's file): leave it.
- Moved file, in a live document, as an instruction still to carry out: write the new path.
- Moved file, in a record (the decision log's historical statements): leave it as written.

- [ ] **Step 2: Shrink the citation exemptions**

The two archived files no longer need exempting, and the key is now lower case. In `scripts/upstream-watch/citations.mjs`:

```js
// User-facing documentation whose upstream citations must be registered too:
// README.md and the top-level docs/*.md guides. CLI help lives in src/, which
// CITATION_DIRS already covers. Subfolders are not guides: ADRs, plans,
// proposals and the archive are exempt by location, and docs/ddd and
// docs/schemas cite through the source they describe.
export const USER_DOC_EXEMPT = new Map([
  ['docs/usage-scorecard-metrics.md', 'research reference'],
]);
```

In `tests/kit/upstream-watch-registry.test.mjs`, change the message `'only top-level guides; ADRs, audits, plans and research are history'` to `'only top-level guides; subfolders are records, plans, proposals or history'`.

- [ ] **Step 3: Stop shipping the archived evidence record, and link to it absolutely**
  - Delete the `package.json#files` line the mention pass rewrote to `"docs/archive/2026-09-09-evidence-codex-context-0.153.4.md",`, and the same path in `docs/maintainer.md`'s shipped list.
  - In `docs/codex-statusline.md`, change the relative evidence link to `https://github.com/pacphi/agentic-kit/blob/main/docs/archive/2026-09-09-evidence-codex-context-0.153.4.md`.

- [ ] **Step 4: Remove the now-redundant maintainer-guide entry from the lint scopes.** The mention pass turned `MAINTAINER.md` into `docs/maintainer.md`, which `docs/**/*.md` already covers. Delete that one entry from:
  - both `lint:links` scripts in `package.json`;
  - the `args` in `.github/workflows/ci.yml` and `.github/workflows/nightly.yml`;
  - `globs` in `.markdownlint-cli2.jsonc`.

- [ ] **Step 5: Update the maintainer guide's layout.** In `docs/maintainer.md`, replace the `docs/` block of the repository layout tree with this, and remove the root `MAINTAINER.md` and `explainer.html` entries from it:

```text
README.md, CLAUDE.md, AGENTS.md   # the only documents at the root
docs/
  *.md                   # living guides, lower-case names, indexed in docs/README.md
  explainer.html         # GitHub Pages source (pages.yml publishes it as index.html)
  maintainer.md          # this guide
  adr/                   # decision records, every status; never moved
  ddd/                   # living domain model
  schemas/               # living interchange contracts
  assets/                # figures the living guides use
  plans/                 # in-flight plans and specs, Superpowers' included
  proposals/             # dormant proposals awaiting a decision
  archive/               # frozen history, one index row per file (not shipped)
```

- [ ] **Step 6: The two small doc fixes**
  - In `docs/adr/0058-managed-ruflo-components.md:6`, change the link label to the new path; the tool already rewrote the target.
  - In `docs/assets/README.md`, delete the "About mock, System mock" row and add below the table:

```markdown
The About and System design mocks for ADR-0026/0025 are archived as
[2026-08-08-artifact-about-tab-mock.html](../archive/2026-08-08-artifact-about-tab-mock.html) and
[2026-08-08-artifact-system-tab-mock.html](../archive/2026-08-08-artifact-system-tab-mock.html).
```

- [ ] **Step 7: Check that no shipped doc gained a link to an unshipped file.** Re-run Task 4 Step 1's command, writing to `/tmp/shipped-links-after.txt`, then:

```bash
comm -13 /tmp/shipped-links-before.txt /tmp/shipped-links-after.txt   # expect no output
npm pack --dry-run 2>&1 | grep -E 'docs/' | sort                      # lower-case names; no docs/evidence/
```

- [ ] **Step 8: Run the suite, and lint the changed code**

```bash
node scripts/run-tests.mjs unit
npx --no-install eslint $(git diff --name-only main -- '*.mjs' '*.cjs' '*.js')
```

Expected: all pass. See Appendix A for the rehearsal's result.

- [ ] **Step 9: Commit**

```bash
git add scripts/upstream-watch/citations.mjs tests/kit/upstream-watch-registry.test.mjs package.json \
  .markdownlint-cli2.jsonc .github/workflows/ci.yml .github/workflows/nightly.yml \
  docs/maintainer.md docs/codex-statusline.md docs/adr/0058-managed-ruflo-components.md docs/assets/README.md
git commit -m "docs: finish the references the relocation could not decide alone"
```

### Task 6: Indexes and folder guides

**Files:**

- Create: `docs/README.md`, `docs/plans/README.md`, `docs/proposals/README.md`
- Modify: `docs/archive/README.md`

- [ ] **Step 1: Write `docs/README.md`**

```markdown
# Documentation

The Markdown files in this folder are living guides: each describes the current behavior of
`ak`, and changes in the same pull request as the behavior it describes. Everything else lives
in a subfolder with one purpose.

| Folder | Purpose |
| --- | --- |
| [adr/](adr/README.md) | Decision records in every status; never moved |
| [ddd/](ddd/README.md) | The domain model: shared language, boundaries and invariants |
| [schemas/](schemas/README.md) | Versioned interchange contracts |
| [assets/](assets/README.md) | Figures the guides use |
| [plans/](plans/README.md) | In-flight plans and specs; they leave when their work merges |
| [proposals/](proposals/README.md) | Dormant proposals awaiting a decision |
| [archive/](archive/README.md) | Frozen history, one index row per file |

## Using ak

| Guide | Covers |
| --- | --- |
| [Installation](installation.md) | Where the package and its `ak` binary go, and what installing changes |
| [Setup](setup.md) | What `ak setup` changes on the machine and in a project |
| [Upgrading](upgrading.md) | Getting newer code and turning new capabilities on |
| [Troubleshooting](troubleshooting.md) | From a symptom to the `ak` command that fixes it |
| [Providers](providers.md) | Choosing inference providers and routing work |
| [Host support](host-support.md) | Claude Code, Codex and OpenCode with Ruflo, Agentic QE and RuvNet Brain |
| [Dashboard](dashboard.md) | `ak dashboard` navigation, evidence and guarded actions |
| [Maintenance](maintenance.md) | The inventory-led Maintenance workspace and its runbook |
| [Hooks](hooks.md) | Auditing and healing hook configuration |
| [Models](models.md) | The model inventory and read-only change planning |
| [Telemetry](telemetry.md) | Exporting and aggregating fleet evidence |
| [Observability](observability.md) | The Observability tab |
| [AQE embeddings](aqe-embeddings.md) | Choosing and recovering the Agentic QE embedding backend |
| [Codex status line](codex-statusline.md) | The managed Codex status line |
| [deja-vu](deja-vu.md) | The optional transcript-search companion |
| [Dev containers](devcontainers.md) | The two dev container configurations |
| [Hermes host adapter](hermes-host-adapter.md) | Running Hermes through the external host-adapter contract |
| [Codex usage diagnostic](codex-usage-diagnostic.md) | Checking whether the Codex usage-parser fix changed your numbers |

## Extending ak

| Guide | Covers |
| --- | --- |
| [Authoring host adapters](authoring-host-adapters.md) | Adding a new agent CLI without changing `ak` |

## Maintaining ak

| Guide | Covers |
| --- | --- |
| [Maintainer's guide](maintainer.md) | Architecture, repository layout, testing, branching, versioning and releases |
| [Managed tools](managed-tools.md) | The install, update, version and display contract every managed tool follows |
| [Transcripts](transcripts.md) | The transcript pipeline and session detail |
| [Usage scorecard metrics](usage-scorecard-metrics.md) | Every scorecard figure, its formula and its evidence |
| [Upstream watch](upstream-watch.md) | The upstream registry and the watch that reads it |
| [Maintenance acceptance](maintenance-acceptance.md) | Maintenance requirement IDs and open release gates |
| [Host-adapter freeze checklist](host-adapter-freeze-checklist.md) | The evidence needed before adapter contract 1 is frozen |
| [Local model validation](local-model-validation.md) | The protocol that would move ADR-0011 to Accepted |
| [Language coverage](language-coverage.md) | The dated language-detection baseline |
| [Language logos](language-logos.md) | Sources and licenses of the bundled language logos |
| [Date and time presentation](date-time-presentation.md) | How the dashboard formats dates and times |

Markdown file names are lower case; `README.md` and the names tools read verbatim (`CLAUDE.md`,
`AGENTS.md`, `SKILL.md`) are the only exceptions. Repository rules for where documents go are in
[CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md); `tests/kit/docs-layout.test.mjs` enforces them.
```

- [ ] **Step 2: Write `docs/plans/README.md`**

````markdown
# In-flight plans

Plans, specs and an active program's decision log live here only while their work is open.

- Superpowers writes here: plans (writing-plans) as `YYYY-MM-DD-<feature>.md`, specs
  (brainstorming) as `YYYY-MM-DD-<topic>-design.md`. There is no separate specs folder.
- The pull request that finishes the work moves its plan and spec to
  [the archive](../archive/README.md) as `YYYY-MM-DD-superpowers-plan-<feature>.md` and
  `YYYY-MM-DD-superpowers-spec-<topic>-design.md`, with one index row per file:

  ```bash
  printf 'docs/plans/<file>\tdocs/archive/<archived name>\n' > /tmp/move.tsv
  node scripts/docs-relocate.mjs --map /tmp/move.tsv
  ```

- A program that spans several branches keeps its plan and decision log here until its last
  branch merges.
````

- [ ] **Step 3: Write `docs/proposals/README.md`**

```markdown
# Proposals

Proposals that are written but not yet decided. A proposal is a single `<topic>.md`, or a
`<topic>/` folder when it has several documents. Its governing ADR, if there is one, carries the
live status.

| Proposal | Governing decision |
| --- | --- |
| [Autonomous improvement](autonomous-improvement/README.md) | ADR-0022 (Proposed) |
| [MetaHarness companion](metaharness-companion.md) | [ADR-0022](../adr/0022-metaharness-as-optional-assurance-companion.md) (Proposed) |
| [Project metadata adapters](project-metadata-adapters.md) | ADR-0025 (Implemented) and ADR-0048 (Accepted) |

When a proposal is accepted, it becomes a plan in [plans/](../plans/README.md) or is recorded in
an ADR. When it is rejected or abandoned, it moves to [the archive](../archive/README.md) as
`YYYY-MM-DD-proposal-<topic>` with `node scripts/docs-relocate.mjs`.
```

- [ ] **Step 4: Draft one archive index row per newly archived file**

```bash
awk -F'\t' '$3 == "move" && $2 ~ /^docs\/archive\//' /tmp/docs-move-map.tsv | while IFS=$'\t' read -r from to mode; do
  name=${to#docs/archive/}
  title=$(grep -m1 -E '^# ' "$to" 2>/dev/null | sed 's/^# //')
  printf '| [%s](%s) | `%s` | %s | %s |\n' "$name" "$name" "$from" "${title:-${name##*.} file}" "WHY"
done > /tmp/archive-rows.md; wc -l < /tmp/archive-rows.md
```

- [ ] **Step 5: Replace each `WHY` by class**, confirming every PR or ADR number in `git log` or in the file itself:
  - **Finished Superpowers plan or spec:** "Implemented in PR #NNN; durable record ADR-NNNN." Find the PR with `git log --oneline main -S'<old basename>'`.
  - **Audit:** "Dated audit of `<commit or version>`; findings preserved as recorded; later reports may supersede them."
  - **Evidence:** "Evidence valid for its named source, version, time and method only; not a current health claim." For images: "Viewport capture for PR #210's fixture evidence, <width> px."
  - **Validation or plan:** "Shipped in PR #NNN."
  - **Artifact mock:** "Historical design example for ADR-0025/0026; current UI is generated by `src/lib/dashboard/page.mjs`."

- [ ] **Step 6: Add the rows to `docs/archive/README.md`**
  - Add a section `## Added <execution date> — documentation reorganization` with the table header `| File | Original location | What it was | Why it's historical |` and every row (decision 4: one per file, each PNG included).
  - In `## Naming convention`, list the origins from [§ Target layout](#target-layout), and state that archive names are lower case.

- [ ] **Step 7: Check with the guard's rules**

```bash
node --input-type=module -e "
import { execFileSync } from 'node:child_process'; import fs from 'node:fs';
import { layoutProblems } from './scripts/docs-layout.mjs';
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
console.log(layoutProblems({ files, read: (f) => fs.readFileSync(f, 'utf8') }).join('\n'));"
```

Expected: only the two `missing the "## Documentation layout" section` lines, which Task 7 fixes.

- [ ] **Step 8: Commit**

```bash
git add docs/README.md docs/plans/README.md docs/proposals/README.md docs/archive/README.md
git commit -m "docs: index every guide and archived file; describe plans and proposals"
```

### Task 7: This repository's rules, and the tracked-tree guard

**Files:**

- Modify: `CLAUDE.md` and `AGENTS.md` (Layer A)
- Modify: `tests/kit/docs-layout.test.mjs`

- [ ] **Step 1: Add the tracked-tree test** at the end of `tests/kit/docs-layout.test.mjs`, with its two imports at the top:

```js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
```

```js
test('the tracked tree follows the documentation layout', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(layoutProblems({ files, read: (file) => fs.readFileSync(file, 'utf8') }), []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/kit/docs-layout.test.mjs`
Expected: FAIL, with the only problems being `CLAUDE.md` and `AGENTS.md` missing "## Documentation layout".

- [ ] **Step 3: Add the rule to `CLAUDE.md`,** after the "Repository workflow" section:

```markdown
## Documentation layout

Rules for this repository only. They are not shipped and are not written into user projects.

- Superpowers writes plans (writing-plans) to `docs/plans/YYYY-MM-DD-<feature>.md` and specs
  (brainstorming) to `docs/plans/YYYY-MM-DD-<topic>-design.md`. Never create `docs/superpowers/`.
- Finished plans and specs move to `docs/archive/` in the pull request that completes the work,
  using `node scripts/docs-relocate.mjs`, with one index row per file in `docs/archive/README.md`.
- Dated audits and evidence go straight to `docs/archive/`; dormant proposals to `docs/proposals/`.
  Don't add another folder under `docs/`.
- Markdown file names are lower case (`models.md`). The only exceptions are `README.md` and the
  names tools read verbatim: `CLAUDE.md`, `AGENTS.md`, `SKILL.md`.
- Folder purposes: [docs/README.md](docs/README.md). `tests/kit/docs-layout.test.mjs` enforces this.
```

- [ ] **Step 4: Add the rule to `AGENTS.md`,** directly before `## Quick Start`:

```markdown
## Documentation layout

<!-- Authored by the maintainers, not generated. tests/kit/docs-layout.test.mjs fails if a
     regeneration drops this section. This repository only: it is not shipped. -->

- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md` and specs to
  `docs/plans/YYYY-MM-DD-<topic>-design.md`, including the ones Superpowers writes. Never create
  `docs/superpowers/` or any other new folder under `docs/`.
- Finished plans and specs move to `docs/archive/` in the pull request that completes the work,
  using `node scripts/docs-relocate.mjs`, with one index row per file in `docs/archive/README.md`.
- Dated audits and evidence go straight to `docs/archive/`; dormant proposals to `docs/proposals/`.
- Top-level `docs/*.md` files are living guides, each listed in `docs/README.md`.
- Markdown file names are lower case. Only `README.md`, `CLAUDE.md`, `AGENTS.md` and `SKILL.md`
  keep capitals. Never move an ADR.
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `node --test tests/kit/docs-layout.test.mjs`
Expected: PASS, 10 tests.

Then run the whole gate:

```bash
node scripts/run-tests.mjs unit
npx --no-install markdownlint-cli2
lychee --offline --include-fragments --no-progress --config lychee.toml README.md CLAUDE.md AGENTS.md \
  'docker/*.md' 'claude/**/*.md' 'src/templates/**/*.md' 'docs/**/*.md'
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md tests/kit/docs-layout.test.mjs
git commit -m "docs: add this repository's documentation rules and hold the tree to them"
```

- [ ] **Step 7: Update local state** (not committed)
  - If the program plan moved, run the `plan-path` command from [§ When to run](#when-to-run).
  - In the auto-memory folder, update memories that name old paths.
  - Point the newest handoff in `.superpowers/handoff/` at the new program path.

### Task 8: Remove the gitignored clutter in `docs/`

- [ ] **Step 1: Inspect**

```bash
ls -la docs/.claude-flow docs/archive/.claude-flow docs/assets/.claude-flow docs/research docs/design docs/.DS_Store 2>&1
git ls-files docs/research docs/design | wc -l   # expect 0
```

The v5 research lives on `codex/v5-experience-research`. If that branch merges, its `docs/research/v5` content goes to `docs/proposals/` or the archive by these rules, never to `docs/research/`.

- [ ] **Step 2: Remove each path, one command at a time, confirming each is gone**

```bash
rm -r docs/.claude-flow && test ! -e docs/.claude-flow && echo gone
rm -r docs/archive/.claude-flow && test ! -e docs/archive/.claude-flow && echo gone
rm -r docs/assets/.claude-flow && test ! -e docs/assets/.claude-flow && echo gone
rm -r docs/research && test ! -e docs/research && echo gone
rmdir docs/design && test ! -e docs/design && echo gone
rm docs/.DS_Store && test ! -e docs/.DS_Store && echo gone
```

- [ ] **Step 3: Confirm no empty folder remains.** Run `find docs docker -type d -empty -print`, inspect the output, and `rmdir` each listed folder (`rmdir` refuses anything that isn't empty).

### Task 9: PR A

- [ ] **Step 1: Open the PR when the maintainer asks.** Push `docs/taxonomy-reorg` and open a PR titled `docs: one purpose per docs folder, lower-case names, archive point-in-time material`. Paste the Task 4 dry-run summary and the Task 5 Step 7 `npm pack` list into the description. Also say two things there:
  - GitHub doesn't redirect renamed files, so older links to all-caps doc URLs (including the one in shipped ak code) resolve only on older tags.
  - `blob/main` links to the new paths resolve only after merge.
- [ ] **Step 2: After merge, confirm GitHub Pages redeployed from `docs/explainer.html`.** The merge changes `pages.yml`, which triggers the workflow.

```bash
gh run list --workflow pages.yml --limit 1 --json conclusion,headSha,createdAt
curl -sS -o /dev/null -w '%{http_code}\n' https://pacphi.github.io/agentic-kit/   # expect 200
```

Expected: a successful run for the merge commit, and `200`. If the run failed, re-run it with `gh workflow run pages.yml` and read its log before anything else.

- [ ] **Step 3: After merge, point the maintainer's own GitHub issues at the new paths** (only with their go-ahead). On 2026-09-28:
  - #243 links `docs/UPSTREAM-WATCH.md`.
  - #109 links `docs/USAGE-SCORECARD-METRICS.md` and `docs/TRANSCRIPTS.md`.

  Then rebase any open branch that touched moved files.

## Phase 3: archive link repair and lint (PR B, last)

### Task 10: Repair every internal link in the archive

**Files:**

- Modify: `lychee.toml`, `docs/archive/2026-07-14-shell-kit-readme.md`, `docs/archive/2026-07-14-shell-kit-troubleshooting.md`, `docs/archive/2026-08-16-artifact-host-extensibility-explainer.html`, `docs/archive/README.md`

- [ ] **Step 1: Bring the archive into lychee's scope first.** In `lychee.toml`, delete `"docs/archive",` from `exclude_path`. This must come first: `exclude_path` also filters files passed on the command line, so any archive check before this change silently checks nothing.

- [ ] **Step 2: List the broken internal links**

```bash
lychee --offline --include-fragments --no-progress --format compact --config lychee.toml \
  docs/archive/*.md docs/archive/*.html
```

Expected: the 12 in [Appendix B](#appendix-b--the-12-historical-archive-links) and nothing else. The 2026-09-28 rehearsal found exactly these.

- [ ] **Step 3: Repair each one** using Appendix B's target and evidence.
  - A new break must go through the same test: find the file the text originally meant, using its original location in the archive index, `git log --follow`, or `git log -S'<link text>'`.
  - Link to that file if it exists, in the archive or live.
  - If no original can be found, remove the link, keep the words, and record that in Step 4.
  - Never link to a merely similar document.

- [ ] **Step 4: Record the repair in `docs/archive/README.md`**
  - Replace "Original-location links retained in frozen files" with `### Link repair (<date>)`: one row per repaired link, with the file, the old target, the new target or "unlinked", and the evidence.
  - Change the opening "Do not update them" sentence to: "Bodies are not edited, except to repair links and apply lint-only formatting; each repair is recorded below."

- [ ] **Step 5: Re-run Step 2** and expect `0 Errors`.

- [ ] **Step 6: Commit**

```bash
git add lychee.toml docs/archive
git commit -m "docs(archive): repair the historical links left by earlier moves"
```

### Task 11: Repair every external link in the archive

- [ ] **Step 1: Check online**

```bash
lychee --config lychee.toml --no-progress --format compact docs/archive/*.md docs/archive/*.html
```

Because Task 10 Step 1 removed the exclusion, the repository's `accept` codes and bot-block exclusions apply.

- [ ] **Step 2: Triage each failure**, and record a row for it in the Task 10 table:

| Result | Action |
| --- | --- |
| Moved (a redirect to a new canonical URL, such as `ruvnet/claude-flow` → `ruvnet/ruflo`) | Replace it with the canonical URL |
| A `claude.ai` artifact link | Check it with the Artifact tool's `read` action. If it still exists and is the same document, keep it and add `"^https://claude\\.ai/",  # authenticated artifact pages` to `exclude` in `lychee.toml`. If it's gone, unlink it and keep the words |
| Rate-limited or bot-blocked (403 or 429 from a host already in `exclude`) | Keep it |
| Gone, with no successor found | Unlink it, keep the words, note "no successor found" |

- [ ] **Step 3: Re-run Step 1, then commit**

```bash
git add lychee.toml docs/archive
git commit -m "docs(archive): repair or unlink dead external links, with evidence"
```

### Task 12: Put the archive under markdownlint, and check HTML docs

**Files:**

- Modify: `.markdownlint-cli2.jsonc`, `package.json` (`lint:links`, `lint:links:internal`), `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`
- Modify: the archived Markdown files markdownlint flags

- [ ] **Step 1:** In `.markdownlint-cli2.jsonc`, delete `"docs/archive"` from `ignores` and change the header comment to say archived docs are linted too.

- [ ] **Step 2: Keep archived shell scripts byte-exact.** In the root `config`, add:

```jsonc
    "MD010": { "code_blocks": false }, // tabs inside code are content (archived shell heredocs)
```

It must go in the root config. A `docs/archive/.markdownlint.jsonc` replaces the root rules rather than extending them; a 2026-09-28 test showed it re-enabled MD013 with 5,103 hits.

- [ ] **Step 3: Check HTML docs too.** Add `'docs/**/*.html'` after `'docs/**/*.md'` in:
  - both `lint:links` scripts in `package.json`;
  - the lychee `args` in `.github/workflows/ci.yml` and `.github/workflows/nightly.yml`.

This brings `docs/explainer.html` and the archived HTML under the checks. Run the online check once on `docs/explainer.html` and handle failures with the Task 11 table.

- [ ] **Step 4: Apply the mechanical fixes**

Run: `npx --no-install markdownlint-cli2 --fix 'docs/archive/*.md'`
Expected: on 2026-09-28 this cleared 218 of 259 issues (blank lines, list markers, emphasis markers, a bare URL).

- [ ] **Step 5: Fix the rest by hand.** On 2026-09-28 there were 41:
  - **MD040:** add a fence language: `bash` for shell, `json` for JSON, `text` for everything else.
  - **MD036:** turn an emphasized line used as a heading into a heading at the correct level.
  - **MD028:** join blockquote paragraphs with a `>` line.
  - **MD001:** move the heading to the next level down.
  - **MD059:** replace vague link text with the target's name.
  - Change no other words.

- [ ] **Step 6: Run the gates**

```bash
npx --no-install markdownlint-cli2
lychee --offline --include-fragments --no-progress --config lychee.toml README.md CLAUDE.md AGENTS.md \
  'docker/*.md' 'claude/**/*.md' 'src/templates/**/*.md' 'docs/**/*.md' 'docs/**/*.html'
node scripts/run-tests.mjs unit
```

Expected: `0 issues`, `0 Errors`, and all tests passing.

- [ ] **Step 7: Commit, and open PR B when the maintainer asks**

```bash
git add .markdownlint-cli2.jsonc package.json .github/workflows/ci.yml .github/workflows/nightly.yml docs/archive
git commit -m "docs(archive): lint and link-check the archive like the rest of docs"
```

## Out of scope

- Stopping ak's own `.bak` sidecars from reappearing beside users' files. That's a separate plan; the 2026-09-28 cleanup already ran.
- Any packaged (Layer B) advice about where plans go. That would be a product decision with its own ADR.

---

## Appendix A — move map

Generated 2026-09-28 against `main@82d1211b` and rehearsed end to end in a throwaway clone. In the plan's own order, it committed Tasks 1–2 and then applied Tasks 4, 6 (READMEs) and 7 (rules):

- 123 moves and renames: 90 into archive, plans and proposals; 29 lower-case guide renames; `MAINTAINER.md`; two docker guides; `explainer.html`.
- 359 links in 100 files and 254 mention lines rewritten, with no empty folder left. The Phase 1 tool and guard files were committed first and came through untouched.
- `pages.yml` pointed at `docs/explainer.html`, and staging the site from it worked.
- 0 errors in the CI-equivalent link check (1,609 links, fragments included), and exactly the 12 Appendix B links in the archive-only check.
- 0 markdownlint issues, and only `README.md`, `CLAUDE.md` and `AGENTS.md` at the root.
- The guard reported only the archive index rows that Task 6 writes.
- The full unit suite passed 5,659 of 5,667. The 2 failures were Chrome-launcher tests that need `playwright`, which the clone had no `node_modules` for.

Task 3 refreshes the map. `move` rows are `git mv`ed; `redirect` rows only retarget links.

<!-- move-map:start -->
| From | To | Mode |
| --- | --- | --- |
| `docs/METAHARNESS-COMPANION-PROPOSAL.md` | `docs/proposals/metaharness-companion.md` | move |
| `docs/MODEL-PRICING-AUDIT.md` | `docs/archive/2026-09-23-audit-model-pricing.md` | move |
| `docs/PROJECT-METADATA-ADAPTERS.md` | `docs/proposals/project-metadata-adapters.md` | move |
| `docs/assets/about-tab-mock.html` | `docs/archive/2026-08-08-artifact-about-tab-mock.html` | move |
| `docs/assets/system-tab-mock.html` | `docs/archive/2026-08-08-artifact-system-tab-mock.html` | move |
| `docs/audits/2026-09-09-aqe-integration-repair.md` | `docs/archive/2026-09-09-audit-aqe-integration-repair.md` | move |
| `docs/audits/2026-09-09-memory-brain-alignment.md` | `docs/archive/2026-09-09-audit-memory-brain-alignment.md` | move |
| `docs/audits/2026-09-09-ruflo-cross-host-alignment.md` | `docs/archive/2026-09-09-audit-ruflo-cross-host-alignment.md` | move |
| `docs/audits/2026-09-09-ruflo-remediation.md` | `docs/archive/2026-09-09-audit-ruflo-remediation.md` | move |
| `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` | `docs/plans/2026-09-26-issues-237-238-239-verification-and-decisions.md` | move |
| `docs/audits/211-adrs-matrix.md` | `docs/archive/2026-09-09-audit-211-adrs-matrix.md` | move |
| `docs/audits/211-code-followups.md` | `docs/archive/2026-09-09-audit-211-code-followups.md` | move |
| `docs/audits/211-core-matrix.md` | `docs/archive/2026-09-09-audit-211-core-matrix.md` | move |
| `docs/audits/211-dashboard-matrix.md` | `docs/archive/2026-09-09-audit-211-dashboard-matrix.md` | move |
| `docs/audits/211-ddd-matrix.md` | `docs/archive/2026-09-09-audit-211-ddd-matrix.md` | move |
| `docs/audits/211-documentation-audit.md` | `docs/archive/2026-09-09-audit-211-documentation-audit.md` | move |
| `docs/audits/211-history-files.csv` | `docs/archive/2026-09-09-audit-211-history-files.csv` | move |
| `docs/audits/211-history-matrix.md` | `docs/archive/2026-09-09-audit-211-history-matrix.md` | move |
| `docs/audits/211-hosts-matrix.md` | `docs/archive/2026-09-09-audit-211-hosts-matrix.md` | move |
| `docs/audits/211-inventory.csv` | `docs/archive/2026-09-09-audit-211-inventory.csv` | move |
| `docs/audits/211-remediation-results.json` | `docs/archive/2026-09-09-audit-211-remediation-results.json` | move |
| `docs/audits/211-remediation.md` | `docs/archive/2026-09-09-audit-211-remediation.md` | move |
| `docs/audits/211-repro-results.json` | `docs/archive/2026-09-09-audit-211-repro-results.json` | move |
| `docs/audits/211-repros.mjs` | `docs/archive/2026-09-09-audit-211-repros.mjs` | move |
| `docs/audits/codex-hooks-audit-2026-09-01.md` | `docs/archive/2026-09-01-audit-codex-hooks.md` | move |
| `docs/audits/codex-hooks-inventory-2026-09-01.json` | `docs/archive/2026-09-01-audit-codex-hooks-inventory.json` | move |
| `docs/audits/codex-hooks-remediation-2026-09-01.md` | `docs/archive/2026-09-01-audit-codex-hooks-remediation.md` | move |
| `docs/audits/context-startup-stop-audit-2026-09-02.md` | `docs/archive/2026-09-02-audit-context-startup-stop.md` | move |
| `docs/audits/host-neutral-hook-healing-2026-09-02.md` | `docs/archive/2026-09-02-audit-host-neutral-hook-healing.md` | move |
| `docs/audits/host-neutral-hooks-follow-up-2026-09-01.md` | `docs/archive/2026-09-01-audit-host-neutral-hooks-follow-up.md` | move |
| `docs/audits/host-neutral-hooks-report-2026-09-01.json` | `docs/archive/2026-09-01-audit-host-neutral-hooks-report.json` | move |
| `docs/audits/plugin-memory-status-followup.md` | `docs/archive/2026-09-09-audit-plugin-memory-status-followup.md` | move |
| `docs/audits/ruflo-memory-route-repro.mjs` | `docs/archive/2026-09-09-audit-ruflo-memory-route-repro.mjs` | move |
| `docs/audits/ruflo-memory-route-results.jsonl` | `docs/archive/2026-09-09-audit-ruflo-memory-route-results.jsonl` | move |
| `docs/autonomous/README.md` | `docs/proposals/autonomous-improvement/README.md` | move |
| `docs/autonomous/contracts.md` | `docs/proposals/autonomous-improvement/contracts.md` | move |
| `docs/autonomous/foundation.md` | `docs/proposals/autonomous-improvement/foundation.md` | move |
| `docs/autonomous/graduation-and-actions.md` | `docs/proposals/autonomous-improvement/graduation-and-actions.md` | move |
| `docs/autonomous/implementation-plan.md` | `docs/proposals/autonomous-improvement/implementation-plan.md` | move |
| `docs/autonomous/learning-and-operations.md` | `docs/proposals/autonomous-improvement/learning-and-operations.md` | move |
| `docs/autonomous/project-companion-design.md` | `docs/proposals/autonomous-improvement/project-companion-design.md` | move |
| `docs/autonomous/project-companion-foundation-plan.md` | `docs/proposals/autonomous-improvement/project-companion-foundation-plan.md` | move |
| `docs/autonomous/project-companion-operations-plan.md` | `docs/proposals/autonomous-improvement/project-companion-operations-plan.md` | move |
| `docs/autonomous/project-companion-research.md` | `docs/proposals/autonomous-improvement/project-companion-research.md` | move |
| `docs/autonomous/ruvnet-evolution-adoption.md` | `docs/proposals/autonomous-improvement/ruvnet-evolution-adoption.md` | move |
| `docs/evidence/aqe-embedding-lifecycle-2026-09-20.json` | `docs/archive/2026-09-20-evidence-aqe-embedding-lifecycle.json` | move |
| `docs/evidence/aqe-repair-source-receipt-2026-09-09.json` | `docs/archive/2026-09-09-evidence-aqe-repair-source-receipt.json` | move |
| `docs/evidence/claude-2.1.266-hook-timeouts.md` | `docs/archive/2026-09-09-evidence-claude-2.1.266-hook-timeouts.md` | move |
| `docs/evidence/codex-context-0.153.4.md` | `docs/archive/2026-09-09-evidence-codex-context-0.153.4.md` | move |
| `docs/evidence/dashboard-project-context/README.md` | `docs/archive/2026-09-09-evidence-dashboard-project-context.md` | move |
| `docs/evidence/dashboard-project-context/context-390.png` | `docs/archive/2026-09-09-evidence-dashboard-context-390.png` | move |
| `docs/evidence/dashboard-project-context/context-768.png` | `docs/archive/2026-09-09-evidence-dashboard-context-768.png` | move |
| `docs/evidence/dashboard-project-context/context-desktop.png` | `docs/archive/2026-09-09-evidence-dashboard-context-desktop.png` | move |
| `docs/evidence/dashboard-project-context/context-models-desktop.png` | `docs/archive/2026-09-09-evidence-dashboard-context-models-desktop.png` | move |
| `docs/evidence/dashboard-project-context/coverage/context-coverage-1440.png` | `docs/archive/2026-09-09-evidence-dashboard-context-coverage-1440.png` | move |
| `docs/evidence/dashboard-project-context/coverage/context-coverage-390.png` | `docs/archive/2026-09-09-evidence-dashboard-context-coverage-390.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-picker-1360.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-picker-1360.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-picker-390.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-picker-390.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-table-1100.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-table-1100.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-table-1360.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-table-1360.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-table-390-scrolled.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-table-390-scrolled.png` | move |
| `docs/evidence/dashboard-project-context/intelligence/intelligence-table-390.png` | `docs/archive/2026-09-09-evidence-dashboard-intelligence-table-390.png` | move |
| `docs/evidence/dashboard-project-context/maintenance/project-cards-desktop.png` | `docs/archive/2026-09-09-evidence-dashboard-project-cards-desktop.png` | move |
| `docs/evidence/dashboard-project-context/maintenance/project-cards-mobile.png` | `docs/archive/2026-09-09-evidence-dashboard-project-cards-mobile.png` | move |
| `docs/evidence/dashboard-project-context/maintenance/projects-desktop.png` | `docs/archive/2026-09-09-evidence-dashboard-projects-desktop.png` | move |
| `docs/evidence/dashboard-project-context/maintenance/projects-mobile.png` | `docs/archive/2026-09-09-evidence-dashboard-projects-mobile.png` | move |
| `docs/evidence/dashboard-project-context/system-projects-390.png` | `docs/archive/2026-09-09-evidence-dashboard-system-projects-390.png` | move |
| `docs/evidence/dashboard-project-context/system-projects-768.png` | `docs/archive/2026-09-09-evidence-dashboard-system-projects-768.png` | move |
| `docs/evidence/dashboard-project-context/system-projects-desktop.png` | `docs/archive/2026-09-09-evidence-dashboard-system-projects-desktop.png` | move |
| `docs/evidence/dashboard-project-context/usage/usage-project-groups-1440.png` | `docs/archive/2026-09-09-evidence-dashboard-usage-project-groups-1440.png` | move |
| `docs/evidence/dashboard-project-context/usage/usage-project-groups-390.png` | `docs/archive/2026-09-09-evidence-dashboard-usage-project-groups-390.png` | move |
| `docs/evidence/dual-host-mcp-convergence-2026-09-10.md` | `docs/archive/2026-09-10-evidence-dual-host-mcp-convergence.md` | move |
| `docs/evidence/host-realignment-2026-09-10.md` | `docs/archive/2026-09-10-evidence-host-realignment.md` | move |
| `docs/evidence/ruflo-cross-host-audit-2026-09-09.json` | `docs/archive/2026-09-09-evidence-ruflo-cross-host-audit.json` | move |
| `docs/implementation/fleet-evidence-export-verification.json` | `docs/archive/2026-09-20-validation-fleet-evidence-export.json` | move |
| `docs/implementation/fleet-evidence-export.md` | `docs/archive/2026-09-20-plan-fleet-evidence-export.md` | move |
| `docs/superpowers/plans/2026-09-20-aqe-embedding-lifecycle.md` | `docs/archive/2026-09-20-superpowers-plan-aqe-embedding-lifecycle.md` | move |
| `docs/superpowers/plans/2026-09-23-managed-ruflo-components.md` | `docs/archive/2026-09-23-superpowers-plan-managed-ruflo-components.md` | move |
| `docs/superpowers/plans/2026-09-26-remediation-program.md` | `docs/plans/2026-09-26-remediation-program.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-1-imported-rollout-origins.md` | `docs/archive/2026-09-27-superpowers-plan-branch-1-imported-rollout-origins.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-2-test-hermeticity.md` | `docs/archive/2026-09-27-superpowers-plan-branch-2-test-hermeticity.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-3-ruflo-support-window.md` | `docs/archive/2026-09-27-superpowers-plan-branch-3-ruflo-support-window.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-4-upstream-watch-live.md` | `docs/archive/2026-09-27-superpowers-plan-branch-4-upstream-watch-live.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-4b-upstream-watch-actions.md` | `docs/archive/2026-09-27-superpowers-plan-branch-4b-upstream-watch-actions.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-5-aqe-store-integrity.md` | `docs/archive/2026-09-27-superpowers-plan-branch-5-aqe-store-integrity.md` | move |
| `docs/superpowers/plans/2026-09-27-branch-6a-evidence-store.md` | `docs/archive/2026-09-27-superpowers-plan-branch-6a-evidence-store.md` | move |
| `docs/superpowers/plans/2026-09-28-branch-6b-one-refresh-flag.md` | `docs/archive/2026-09-28-superpowers-plan-branch-6b-one-refresh-flag.md` | move |
| `docs/superpowers/plans/2026-09-28-branch-9-follow-ups.md` | `docs/archive/2026-09-28-superpowers-plan-branch-9-follow-ups.md` | move |
| `docs/superpowers/plans/2026-09-28-upstream-watch-ledger-branch.md` | `docs/archive/2026-09-28-superpowers-plan-upstream-watch-ledger-branch.md` | move |
| `docs/superpowers/specs/2026-09-28-upstream-watch-ledger-branch-design.md` | `docs/archive/2026-09-28-superpowers-spec-upstream-watch-ledger-branch-design.md` | move |
| `MAINTAINER.md` | `docs/maintainer.md` | move |
| `docker/MAINTAINER-GUIDE.md` | `docker/maintainer-guide.md` | move |
| `docker/USER-GUIDE.md` | `docker/user-guide.md` | move |
| `docs/AQE-EMBEDDINGS.md` | `docs/aqe-embeddings.md` | move |
| `docs/AUTHORING-HOST-ADAPTERS.md` | `docs/authoring-host-adapters.md` | move |
| `docs/CODEX-STATUSLINE.md` | `docs/codex-statusline.md` | move |
| `docs/CODEX-USAGE-DIAGNOSTIC.md` | `docs/codex-usage-diagnostic.md` | move |
| `docs/DASHBOARD.md` | `docs/dashboard.md` | move |
| `docs/DATE-TIME-PRESENTATION.md` | `docs/date-time-presentation.md` | move |
| `docs/DEJA-VU.md` | `docs/deja-vu.md` | move |
| `docs/DEVCONTAINERS.md` | `docs/devcontainers.md` | move |
| `docs/HERMES-HOST-ADAPTER.md` | `docs/hermes-host-adapter.md` | move |
| `docs/HOOKS.md` | `docs/hooks.md` | move |
| `docs/HOST-ADAPTER-FREEZE-CHECKLIST.md` | `docs/host-adapter-freeze-checklist.md` | move |
| `docs/HOST-SUPPORT.md` | `docs/host-support.md` | move |
| `docs/INSTALLATION.md` | `docs/installation.md` | move |
| `docs/LANGUAGE-COVERAGE.md` | `docs/language-coverage.md` | move |
| `docs/LANGUAGE-LOGOS.md` | `docs/language-logos.md` | move |
| `docs/LOCAL-MODEL-VALIDATION.md` | `docs/local-model-validation.md` | move |
| `docs/MAINTENANCE-ACCEPTANCE.md` | `docs/maintenance-acceptance.md` | move |
| `docs/MAINTENANCE.md` | `docs/maintenance.md` | move |
| `docs/MANAGED-TOOLS.md` | `docs/managed-tools.md` | move |
| `docs/MODELS.md` | `docs/models.md` | move |
| `docs/OBSERVABILITY.md` | `docs/observability.md` | move |
| `docs/PROVIDERS.md` | `docs/providers.md` | move |
| `docs/SETUP.md` | `docs/setup.md` | move |
| `docs/TELEMETRY.md` | `docs/telemetry.md` | move |
| `docs/TRANSCRIPTS.md` | `docs/transcripts.md` | move |
| `docs/TROUBLESHOOTING.md` | `docs/troubleshooting.md` | move |
| `docs/UPGRADING.md` | `docs/upgrading.md` | move |
| `docs/UPSTREAM-WATCH.md` | `docs/upstream-watch.md` | move |
| `docs/USAGE-SCORECARD-METRICS.md` | `docs/usage-scorecard-metrics.md` | move |
| `explainer.html` | `docs/explainer.html` | move |
| `docs/audits/README.md` | `docs/archive/README.md` | redirect |
| `docs/evidence/README.md` | `docs/archive/README.md` | redirect |
| `docs/autonomous/` | `docs/proposals/autonomous-improvement/` | redirect |
| `docs/audits/` | `docs/archive/` | redirect |
| `docs/evidence/` | `docs/archive/` | redirect |
| `docs/implementation/` | `docs/archive/` | redirect |
| `docs/superpowers/plans/` | `docs/plans/` | redirect |
| `docs/superpowers/specs/` | `docs/plans/` | redirect |
| `docs/evidence/dashboard-project-context/` | `docs/archive/` | redirect |
<!-- move-map:end -->

## Appendix B — the 12 historical archive links

Found by lychee on 2026-09-28 and repaired in Phase 3. Each target was confirmed by the archive
index's "Original location" column and its 2026-07-14 flattening note.

| File:line | Written target | Repair | Evidence |
| --- | --- | --- | --- |
| `2026-07-14-shell-kit-readme.md:49` | `docs/archive/2026-06-token-consumption-incident.md` | `2026-06-token-consumption-incident.md` | Same file, flattened into this folder on 2026-07-14 |
| `2026-07-14-shell-kit-readme.md:51` | `docs/BACKGROUND.md` | `2026-07-14-shell-kit-background.md` | Index row: original location `docs/BACKGROUND.md` |
| `2026-07-14-shell-kit-readme.md:53` | `docs/BACKGROUND.md` | `2026-07-14-shell-kit-background.md` | As above |
| `2026-07-14-shell-kit-readme.md:160` | `docs/archive/2026-06-token-consumption-incident.md` | `2026-06-token-consumption-incident.md` | As line 49 |
| `2026-07-14-shell-kit-readme.md:349` | `docs/BACKGROUND.md` | `2026-07-14-shell-kit-background.md` | As line 51 |
| `2026-07-14-shell-kit-readme.md:350` | `docs/TROUBLESHOOTING.md` | `2026-07-14-shell-kit-troubleshooting.md` | The shell-era README meant the shell-era runbook; index row: original location `docs/TROUBLESHOOTING.md` |
| `2026-07-14-shell-kit-readme.md:351` | `docs/CONDITIONAL-BLOCKS.md` | `2026-07-14-shell-kit-conditional-blocks.md` | Index row: original location `docs/CONDITIONAL-BLOCKS.md` |
| `2026-07-14-shell-kit-readme.md:352` | `docs/archive` | `README.md` | The archive folder's index is this README |
| `2026-07-14-shell-kit-troubleshooting.md:320` | `archive/2026-06-token-consumption-incident.md` | `2026-06-token-consumption-incident.md` | Same file, same folder |
| `2026-07-14-shell-kit-troubleshooting.md:321` | `archive/2026-06-11-token-consumption-recurrence.md` | `2026-06-11-token-consumption-recurrence.md` | Same file, same folder |
| `2026-08-16-artifact-host-extensibility-explainer.html:227` | `AUTHORING-HOST-ADAPTERS.md` | `../authoring-host-adapters.md` | The explainer lived at `docs/HOST-EXTENSIBILITY-EXPLAINER.html`, so the link meant `docs/AUTHORING-HOST-ADAPTERS.md`, now `docs/authoring-host-adapters.md` |
| `2026-08-16-artifact-host-extensibility-explainer.html:679` | `AUTHORING-HOST-ADAPTERS.md` | `../authoring-host-adapters.md` | As above |

Line numbers are from 2026-09-28. Match on the written target if the lines have moved.
