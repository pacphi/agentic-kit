# ADR-0064 Project-Scoped Management Implementation Plan

## Status

**Executed** on branch `docs/adr-0064-project-scoped-management` (2026-10-03), without the per-task commits
below, and archived in the pull request that completes #326. Differences from the plan as written:
ADR-0035 is marked **Retired** in place (not superseded) and its guide is archived with it; the guide
and this plan moved to `docs/archive/` with `scripts/docs-relocate.mjs`. Open question 1 (why deja-vu
goes) is carried in the pull request description.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the project-scoped management design as ADR-0064 (Accepted, indexed), and link every ADR it supersedes or amends back to it. This is card #326 (`P0-06`, `4.0.0-beta.1`, `size:M`).

**Architecture:** Documentation only. One new ADR distils the decision from the design plan, and nine existing ADRs each get a status change plus a pointer. A small read-only test pins the cross-links so the acceptance criteria cannot rot.

**Tech Stack:** Markdown in `docs/adr/`, `node:test` in `tests/kit/`, `markdownlint` and `lychee` for checks.

**Spec:** [2026-10-01-project-scope-only-design.md](2026-10-01-project-scope-only-design.md) (decisions 1–11, "The rule", "What this replaces") and [section C of the supersession ledger](2026-10-01-v4-supersession-ledger.md) (the per-ADR table; gap G3 fixes the number at 0064).

## Global Constraints

- The new ADR is **0064**. 0056 and 0057 are reserved. 0059 is cited elsewhere but has no file. Do not reuse any of them.
- File name: `docs/adr/0064-project-scoped-management.md` (lower case, `NNNN-kebab-title.md`).
- ADR format: **Context → Decision → Consequences**, with the header block used by ADR-0063 (`Status`, `Date`, `Deciders`, `Related`, `Supersedes`, `Amends`).
- **Never move an ADR** (AGENTS.md). ADR-0035 is marked **Retired** in place and stays in `docs/adr/` (maintainer decision, 2026-10-03). Its Status says it was implemented and is being removed.
- Superseded or amended ADRs keep their body. Only the header gains a note, and the index row's status changes.
- Per-ADR notes for the other ~20 ADRs belong to #380 and #381, not here.
- The user-facing docs rule applies: the ADR describes the decision, not the migration story (no old-command-to-new-command aliases).
- Commit messages follow `<type>(<scope>): <description>`. No `Co-Authored-By` unless the repository configures it.
- Nothing in this card changes code, `kit.json` or any user-level file.

## Review Focus

- **Status honesty.** ADR-0064 is Accepted while nothing is implemented. The status line must say so, or readers will assume `ak` already behaves this way. The test pins the words "not yet implemented" in the status.
- **Superseded in part means the rest survives.** ADR-0008 still governs "personal facts are never committed" and foreign-guidance preservation. The note must name what survives, or a reader will treat the whole ADR as dead.
- **ADR-0029 and ADR-0031 are withdrawn, not superseded.** They are carried to v5 (decision 10, gap G1). The ADR must say "withdrawn from v4", must not list them under `Supersedes`, and the test asserts they are absent from that list.
- **Index drift.** `docs/adr/README.md` has both a table row and a longer section per ADR. A row updated without its section (or the reverse) leaves two statuses.
- **Dead links.** Nine files gain relative links to a new file. `lint:links:internal` must stay clean.

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/adr/0064-project-scoped-management.md` (create) | The decision record |
| `docs/adr/README.md` (modify) | Index row for 0064; updated status text for the nine linked ADRs |
| `docs/adr/0035-…`, `0008-…`, `0015-…`, `0017-…`, `0058-…` (modify) | Header note: superseded or superseded in part |
| `docs/adr/0025-…`, `0027-…`, `0048-…`, `0014-…` (modify) | `Updated` line: amended by 0064 |
| `tests/kit/adr-0064-links.test.mjs` (create) | Pins existence, status, index row and every cross-link |

## Open questions for the maintainer

1. **Why deja-vu goes (needs your confirmation).** The recorded reason is design Decision 4: deja-vu indexes every agent history into a user-level index, so it cannot fit a project-only kit. ADR-0035 itself says deja-vu is "an evidence archive beside curated memory, not a replacement for it", so nothing recorded says Ruflo/AgentDB memory replaces it. The ADR therefore states the recorded reason and lists verbatim transcript recall as a capability that is dropped, not replaced. Change that sentence if you decided otherwise.
2. **Status wording.** Proposed: `Accepted (design approved 2026-10-01; not yet implemented — implementation starts in 4.0.0-beta.1)`. The card's acceptance criterion only says "Accepted"; this wording keeps the index honest.

---

### Task 1: Pin the contract with a failing test

**Files:**

- Create: `tests/kit/adr-0064-links.test.mjs`

**Interfaces:**

- Consumes: files under `docs/adr/` (read-only).
- Produces: `SUPERSEDED`, `AMENDED` lists that Task 3 and Task 4 must satisfy.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'adr');
const NEW_ADR = '0064-project-scoped-management.md';
const SUPERSEDED = ['0008', '0015', '0017', '0058'];
const RETIRED = '0035';
const AMENDED = ['0025', '0027', '0048', '0014'];
const WITHDRAWN = ['0029', '0031'];

const adrFile = (number) => fs.readdirSync(ADR_DIR).find((name) => name.startsWith(`${number}-`));
const read = (name) => fs.readFileSync(path.join(ADR_DIR, name), 'utf8');
const header = (text) => text.split(/^## /m)[0];

test('ADR-0064 exists, is Accepted, and says it is not yet implemented', () => {
  assert.ok(fs.existsSync(path.join(ADR_DIR, NEW_ADR)), `${NEW_ADR} is missing`);
  const head = header(read(NEW_ADR));
  assert.match(head, /^- \*\*Status:\*\* Accepted/m);
  assert.match(head, /not yet implemented/);
});

test('ADR-0064 lists every superseded and amended ADR, and none of the withdrawn ones', () => {
  const head = header(read(NEW_ADR));
  const supersedes = head.match(/^- \*\*Supersedes:\*\*[\s\S]*?(?=^- \*\*|$(?![\s\S]))/m)?.[0] ?? '';
  const amends = head.match(/^- \*\*Amends:\*\*[\s\S]*?(?=^- \*\*|$(?![\s\S]))/m)?.[0] ?? '';
  for (const n of [RETIRED, ...SUPERSEDED]) assert.match(supersedes, new RegExp(`ADR-${n}`), `Supersedes omits ADR-${n}`);
  for (const n of AMENDED) assert.match(amends, new RegExp(`ADR-${n}`), `Amends omits ADR-${n}`);
  for (const n of WITHDRAWN) assert.doesNotMatch(supersedes + amends, new RegExp(`ADR-${n}`), `ADR-${n} is withdrawn, not superseded`);
});

test('the ADR index has a row for 0064', () => {
  const index = read('README.md');
  assert.match(index, new RegExp(`^\\| \\[0064\\]\\(${NEW_ADR}\\) \\|`, 'm'));
});

test('ADR-0035 is marked Retired in place, links to 0064, and is not archived', () => {
  const head = header(read(adrFile(RETIRED)));
  assert.match(head, /^- \*\*Status:\*\* Retired/m);
  assert.ok(head.includes(NEW_ADR), `ADR-${RETIRED} header does not link to ${NEW_ADR}`);
  assert.ok(!fs.existsSync(path.join(ADR_DIR, '..', 'archive', adrFile(RETIRED))), 'ADR-0035 must not be archived');
});

test('every superseded ADR links to 0064 and says superseded in its header', () => {
  for (const n of SUPERSEDED) {
    const head = header(read(adrFile(n)));
    assert.ok(head.includes(NEW_ADR), `ADR-${n} header does not link to ${NEW_ADR}`);
    assert.match(head, /^- \*\*Status:\*\*[^\n]*[Ss]uperseded/m, `ADR-${n} status does not say superseded`);
  }
});

test('every amended ADR links to 0064 from an Updated line', () => {
  for (const n of AMENDED) {
    const head = header(read(adrFile(n)));
    assert.match(head, new RegExp(`^- \\*\\*Updated:\\*\\* 2026-10-03[^]*?${NEW_ADR.replace('.', '\\.')}`, 'm'), `ADR-${n} has no 2026-10-03 Updated line linking ${NEW_ADR}`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node scripts/run-tests.mjs focus tests/kit/adr-0064-links.test.mjs`
Expected: FAIL. The first test reports `0064-project-scoped-management.md is missing`, and the later tests fail on the missing file.

- [ ] **Step 3: Commit the failing test on the card branch**

Create the branch first: `git switch -c docs/adr-0064-project-scoped-management`.

```bash
git add tests/kit/adr-0064-links.test.mjs
git commit -m "test(adr): pin ADR-0064 cross-links (#326)"
```

---

### Task 2: Write ADR-0064

**Files:**

- Create: `docs/adr/0064-project-scoped-management.md`

**Interfaces:**

- Consumes: the design plan's "The rule", decisions 1–11 and "What this replaces".
- Produces: the file Task 1 looks for, with `Supersedes` and `Amends` blocks that name every ADR in `SUPERSEDED` and `AMENDED`.

- [ ] **Step 1: Re-read the sources**

Read the design's `## The rule`, `## Decisions`, `## What this replaces`, `## Codex exception register` and `## Upgrading from the user-level versions`, then section C of the ledger. Read the `Status` of every ADR in `SUPERSEDED` and `AMENDED`, and say in one line each where it stands before editing anything (living-plans rule).

- [ ] **Step 2: Write the ADR**

```markdown
# ADR-0064 — Project-scoped management

- **Status:** Accepted (design approved 2026-10-01; not yet implemented — implementation starts in 4.0.0-beta.1)
- **Date:** 2026-10-03
- **Deciders:** agentic-kit maintainers
- **Related:** [design plan](../plans/2026-10-01-project-scope-only-design.md),
  [supersession ledger](../plans/2026-10-01-v4-supersession-ledger.md),
  [ADR-0020](0020-ga-stable-surfaces.md) (the GA surface freeze this must precede),
  [ADR-0063](0063-evidence-store-and-refresh-vocabulary.md)
- **Supersedes:**
  [ADR-0035](0035-managed-deja-vu-companion.md) in full (the companion is removed; the record is kept and marked Retired, not archived);
  [ADR-0008](0008-guidance-target-scope-split.md) user targets and machine retirement;
  [ADR-0015](0015-managed-codex-native-statusline.md) user-wide ownership;
  [ADR-0017](0017-opencode-host.md) user config, plugins, agents, skills, approvals and its guidance target;
  [ADR-0058](0058-managed-ruflo-components.md) §3 (user env), §4 (global typesafe install), §6 (funnel disable).
- **Amends:**
  [ADR-0025](0025-machine-footprint-metrics.md) and
  [ADR-0027](0027-shared-project-census.md) (footprint, census scopes, place kinds),
  [ADR-0048](0048-inventory-led-maintenance-resource-management.md) (Maintenance write gate),
  [ADR-0014](0014-dashboard-auth-and-remediation.md) (dashboard Refresh and Forget writes).
- **Withdrawn from v4, carried to v5 (not superseded):** ADR-0029 and ADR-0031, the external host-adapter contract.

## Context

Today `ak` writes user-level files (`~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.codex/`,
`~/.config/opencode/`), runs `npm install -g`, and reconciles whole machines. A user who never opted
a folder in still sees agentic-kit in every Claude Code, Codex and OpenCode session. The design plan
inventories each surface (`## What this replaces`).

## Decision

**The blast radius of every `ak` command is the opted-in project.** Judged by effect, not only by
file location, exactly four kinds of write are allowed:

1. Inside the project root, in a git-ignored layer by default.
2. A kit-owned cache that does nothing on its own, under `$XDG_CACHE_HOME/agentic-kit/`
   (`%LOCALAPPDATA%\agentic-kit\cache` on Windows).
3. A host's own per-project record, written through the host's own command. The only one is
   Claude's local-scope MCP registration (`claude mcp add|remove -s local`).
4. The Codex exception register: a closed, coded list of Codex user-level settings with no
   project-level equivalent, each shown in the plan, receipted and reference-counted.

Reading is unrestricted. The dashboard observes all agent work on every readable host, and writes
nothing outside the cache except an explicit Refresh (project state and cache) and Forget (the
project index only).

Supporting decisions, from the design (numbers are the design's):

- **1, 7.** The cache under `~/.cache/agentic-kit` is approved. There is no migration code: the
  last release of the current line (`4.0.0-alpha.61`) makes `ak uninstall --purge` remove everything.
- **2, 3.** Claude MCP uses local scope in personal mode; team mode (`.mcp.json`) is opt-in.
- **4.** deja-vu is removed entirely.
- **5.** Superpowers guidance goes only into projects with evidence of prior use.
- **6.** Codex settings with no project home are managed under the register.
- **8.** Four lifecycle verbs: `init`, `status`, `sync`, `uninstall`.
- **9.** The dashboard covers all work, every host and place; management stays opt-in per project.
- **10.** The external host-adapter contract and Hermes leave v4 and are tagged
  `archive/v4-host-adapters`.
- **11.** `ak x harvest` is removed.

## Consequences

- Opted-out folders behave as if agentic-kit were not installed.
- Verbatim transcript recall (exact errors, commands and tool output from past sessions) is dropped
  with deja-vu. Curated memory in Ruflo and AgentDB records decisions and patterns, not transcripts
  (ADR-0035 Context), so it does not replace that capability.
- Several accepted ADRs describe behaviour that stops being true as each phase lands. The notes on
  the nine linked ADRs say which parts, and #380 and #381 add notes to the rest.
- Because nothing is implemented yet, the linked ADRs describe current behaviour until the matching
  phase ships. Each phase's pull request moves this ADR's status toward Implemented.
- Phasing (P0–P7) and the release each phase ships in are in the design's `## Phasing`.
```

- [ ] **Step 3: Run the first two tests**

Run: `node scripts/run-tests.mjs focus tests/kit/adr-0064-links.test.mjs`
Expected: the first two tests PASS. The index and per-ADR tests still FAIL.

- [ ] **Step 4: Lint**

Run: `pnpm run lint:md`
Expected: clean for the new file.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0064-project-scoped-management.md
git commit -m "docs(adr): add ADR-0064, project-scoped management (#326)"
```

---

### Task 3: Retire ADR-0035, mark the four superseded ADRs and update the index

**Files:**

- Modify: `docs/adr/0035-managed-deja-vu-companion.md`, `0008-guidance-target-scope-split.md`, `0015-managed-codex-native-statusline.md`, `0017-opencode-host.md`, `0058-managed-ruflo-components.md` (header block only)
- Modify: `docs/adr/README.md` (table rows and, where present, the per-ADR section)

**Interfaces:**

- Consumes: the `Status:` line of each file. Edit that line, then add one `Updated` line below `Date`.
- Produces: header links to `0064-project-scoped-management.md` that Task 1 checks.

- [ ] **Step 1: Edit each header**

Use these exact status lines. ADR-0035 gets `Retired`; the other four get `superseded`. Keep the existing `Date`, and add the `Updated` line directly under the status block.

| ADR | New `Status` line | Surviving text to name in the `Updated` line |
| --- | --- | --- |
| 0035 | `Retired — implemented for [issue #114](https://github.com/pacphi/agentic-kit/issues/114), then removed under [ADR-0064](0064-project-scoped-management.md) (removal ships in 4.0.0-beta.1, #321)` | none; the whole decision goes. Add: "Kept in place as the record of why deja-vu existed; not archived." |
| 0008 | `Implemented; user targets and machine retirement superseded by [ADR-0064](0064-project-scoped-management.md)` | "personal facts are never committed" and foreign-guidance preservation still apply |
| 0015 | `Accepted; user-wide ownership superseded by [ADR-0064](0064-project-scoped-management.md)` | the capability limits stay; ownership moves to receipts and the Codex register |
| 0017 | `Accepted; compatibility amended; user config, plugins, agents, skills, approvals and guidance target superseded by [ADR-0064](0064-project-scoped-management.md)` | OpenCode stays a managed, observable host |
| 0058 | `Accepted (implementation in progress); §3, §4 and §6 superseded by [ADR-0064](0064-project-scoped-management.md)` | the catalogue (§1), states (§2) and MCP governance (§5) stand |

Each `Updated` line has this shape:
`- **Updated:** 2026-10-03 — superseded <what> by [ADR-0064](0064-project-scoped-management.md); <what survives>. Not yet implemented, so the text below describes current behaviour.`

- [ ] **Step 2: Update the index**

In `docs/adr/README.md`, add the row for 0064 after the 0063 row (`| [0064](0064-project-scoped-management.md) | Project-scoped management | Accepted; not yet implemented |`). Change the status cell of the rows for 0035, 0008, 0015, 0017 and 0058 to match the new status lines. Search the README's later sections for each ADR's own heading and align it.

- [ ] **Step 3: Run the tests**

Run: `node scripts/run-tests.mjs focus tests/kit/adr-0064-links.test.mjs`
Expected: all but the amended-ADR test PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/adr
git commit -m "docs(adr): mark ADRs superseded by ADR-0064 (#326)"
```

---

### Task 4: Mark the four amended ADRs

**Files:**

- Modify: `docs/adr/0025-machine-footprint-metrics.md`, `0027-shared-project-census.md`, `0048-inventory-led-maintenance-resource-management.md`, `0014-dashboard-auth-and-remediation.md` (header block only)
- Modify: `docs/adr/README.md` (status cells only where the text changes)

**Interfaces:**

- Consumes: each file's existing `Updated` lines. Add the new one first, above the others, and demote the previous top line to `Earlier update:` as those files already do.
- Produces: the `2026-10-03` `Updated` line the test requires.

- [ ] **Step 1: Add one `Updated` line to each**

| ADR | Line to add |
| --- | --- |
| 0025 | `- **Updated:** 2026-10-03 — amended by [ADR-0064](0064-project-scoped-management.md): footprint measures the cache and the places ak manages, not user-level installs. Not yet implemented.` |
| 0027 | `- **Updated:** 2026-10-03 — amended by [ADR-0064](0064-project-scoped-management.md): the census gains the opted-in scope and new place kinds. Not yet implemented.` |
| 0048 | `- **Updated:** 2026-10-03 — amended by [ADR-0064](0064-project-scoped-management.md): Maintenance writes only in opted-in projects. Not yet implemented.` |
| 0014 | `- **Updated:** 2026-10-03 — amended by [ADR-0064](0064-project-scoped-management.md): the dashboard gains explicit Refresh (project state and cache) and Forget (project index only) writes. Every other route keeps the non-GET rejection. Not yet implemented.` |

- [ ] **Step 2: Run the whole test file**

Run: `node scripts/run-tests.mjs focus tests/kit/adr-0064-links.test.mjs`
Expected: all five tests PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/adr
git commit -m "docs(adr): note ADR-0064 amendments on 0025, 0027, 0048 and 0014 (#326)"
```

---

### Task 5: Verify and hand off

**Files:** none.

- [ ] **Step 1: Run the card's verification and the neighbours**

Run each separately and read the output:

```bash
pnpm run lint:md
pnpm run lint:links:internal
node scripts/run-tests.mjs focus tests/kit/docs-layout.test.mjs
node scripts/run-tests.mjs focus tests/kit/adr-0064-links.test.mjs
node scripts/run-tests.mjs focus tests/kit/about-directory.test.mjs
node scripts/run-tests.mjs focus tests/kit/refresh-vocabulary-guard.test.mjs
```

Expected: all pass. The last two read `docs/adr`, so a broken index shows up there.

- [ ] **Step 2: Check the diff touches only docs and the one test**

Run: `git diff --stat origin/main...HEAD`
Expected: `docs/adr/*`, `tests/kit/adr-0064-links.test.mjs` and nothing else.

- [ ] **Step 3: Open the pull request**

Title: `docs(adr): add ADR-0064, project-scoped management`. Body: `Closes #326`, the two open questions above, and the output of Step 1. Then move #326 to In review on the v4.0.0 board.

## Self-review

- **Spec coverage:** acceptance criterion 1 (Accepted and indexed) is Tasks 2 and 3 Step 2; criterion 2 (each ADR links) is Tasks 3 and 4, pinned by Task 1. The verification line (`lint:md`) is Task 5 Step 1.
- **Placeholders:** none. The ADR body and every header edit are written out. The README section alignment in Task 3 Step 2 is a search instruction because the sections' text is not fixed.
- **Type consistency:** `SUPERSEDED`, `AMENDED` and `NEW_ADR` in Task 1 match the ADR numbers and file name used in Tasks 2 to 4.
- **Not covered, on purpose:** ADR-0061, ADR-0044/0040/0041, ADR-0020's new surface table and the other ~20 notes (#380, #381); the deja-vu archive move (#322).
