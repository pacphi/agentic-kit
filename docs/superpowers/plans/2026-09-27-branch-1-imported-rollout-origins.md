# Branch 1: Imported Rollout Origins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex rollouts that the ChatGPT desktop app imported from Claude Code transcripts stop giving project folders a Codex host or a Desktop origin, and every scan says how many it set aside.

**Architecture:** One leaf module owns the single `external-import-turn` constant and two predicates: the existing line-level one and a new rollout-level wrapper over a bounded head. The usage parser, usage origin classifier and project discovery all use it. Discovery skips imported rollouts before reading their cwd and counts them (`importedExcluded`). The count flows up through the discovery payload and the Projects section, and the System KPI note shows it.

**Tech Stack:** Node 22+/26 ESM (`src/lib/**/*.mjs`), `node:test`, the dashboard client bundle (`src/lib/dashboard/client/*.mjs`, loaded as text in tests).

**Spec:** [Program plan, Branch 1](2026-09-26-remediation-program.md#branch-1-fiximported-rollout-origins); [ADR-0060 §3](../../adr/0060-session-surface-initiator-and-product-names.md) (imported copies excluded everywhere and counted); [ADR-0052 §3](../../adr/0052-codex-usage-attribution.md) (the in-rollout marker is the signal); [audit record, ADR-0060 section](../../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md).

## Global Constraints

- Work only in `/Users/cphillipson/Development/active/ai/agentic-kit-b1` on branch `fix/imported-rollout-origins`. Its `node_modules` is a symlink: never run `pnpm` there.
- Commits: conventional subject, test-first (show the failing run, then the passing run), no `Co-Authored-By` or any trailer-like final line. Stage files by name; never `git add -A` or `git add .`. Never commit `.harness/`, `.swarm/`, `.claude-flow/` or `.agentic-qe/`.
- Never push, open or comment on pull requests or issues, or message other agents.
- Tests never write real user state: not `~/.config/agentic-kit`, not `~/.local/state/agentic-kit`, not a repository's `.claude`/`.swarm`/`.agentic-qe`/`.claude-flow`/`.harness`, not `~/.codex` or `~/.claude`. Fixtures live under `fs.mkdtempSync(path.join(os.tmpdir(), 'ak-…'))` and are removed in `t.after`.
- One constant: `CODEX_IMPORT_TURN_PREFIX = 'external-import-turn'` exists in exactly one place after this branch.
- Official product names in any user-facing text: Claude Code, ChatGPT desktop app, Codex CLI.
- User-facing docs describe current state only; ADRs that change get an `Updated` line in this branch.
- Measurement reads of the real `~/.codex/sessions` are read-only and report counts only.

## Verification of the scope against the code (2026-09-27, worktree at `be1c1d47`)

| Item | Verdict | Evidence |
|---|---|---|
| Discovery records a sighting and a Desktop origin for imported rollouts | **Confirmed** | `src/lib/footprint/project-sources.mjs:304` pushes a sighting for every rollout with a cwd; `transcriptSessionOrigin` (`src/lib/footprint/session-origin.mjs:11-17`) maps `originator: "Codex Desktop"` to `codex-desktop` without looking at turn ids. |
| Size of the effect on the maintainer's machine | **Confirmed, numbers moved** | Read-only count on 2026-09-27: 1,692 rollouts; 924 imported, all with `originator: "Codex Desktop"`, all with a cwd, and in 924 of 924 the marker is on head line 2 (the first `event_msg/task_started`). 33 folders are named by an import; **32** show a Desktop origin only because of imports; **25** lose the Codex host entirely; **5** are named by nothing but an import and leave `everSeen` (114 today). The spec's 874 / 23 (2026-09-26) are the earlier measurement. One further file mentions the marker only in message text, not as a `turn_id`. |
| `usageSessionOrigin` labels imports `codex-desktop` | **Confirmed at the function, already neutral in effect** | `src/lib/usage-project-evidence.mjs:59-62` classifies the head without the marker, and `parseCodex` sets `rec.sessionOrigin` (`src/lib/usage-parsers.mjs:1230`) before stopping at the first imported line (`:1245`). But `recordCodexCandidate` counts the import and returns false (`src/lib/usage-index.mjs:698`) and `:920` keeps `session.imported` out of `records`, so no usage view ever shows that origin. The change here is for consistency and any future caller; it has no visible effect and needs no usage cache schema bump. |
| Maintenance "Session origin" facet | **Fixed by this branch, after a Full scan** | The facet reads the footprint snapshot's project rows (`src/lib/maintenance/management/projection.mjs:1083-1084` passes `footprint.projects.projects` and `discoveryProjects` to `enrichProjectPresentation`; `src/lib/maintenance/management/projection-projects.mjs:74` copies each row's `sessionOrigins`), and discovery builds those origins. A snapshot taken before this branch keeps the old origins, so the snapshot schema advances to v8 and the facet is correct once a Full scan writes a new one. `src/lib/project-census.mjs:142` is the Intelligence picker's `learningOrigins`, which the live census fixes directly. |
| Usage project groups (`usage-project-groups.mjs:4-6`) | **Already correct** | Built from `records`, which never contain imports. |
| The shared predicate "beside `CODEX_IMPORT_TURN_PREFIX` in `usage-parsers.mjs`" | **Placement changed (flagged)** | `usage-parsers.mjs:25` imports `usage-project-evidence.mjs`; `usage-project-evidence.mjs` does not reach `usage-parsers.mjs` today (checked by walking the import graph). Exporting the predicate from `usage-parsers.mjs` and importing it into `usage-project-evidence.mjs` would add a new import cycle. The plan moves the one constant and the existing `isCodexImportedLine` into a leaf module `src/lib/codex-import-marker.mjs` that all three modules import. Still one constant; the existing predicate is reused, not copied. |
| Storage attribution of rollout bytes to projects | **Out of scope** | `src/lib/footprint/storage.mjs:57,612` uses `transcriptMetadata` to attribute transcript bytes; those bytes are real disk use. Runtime and storage attribution belong to ADR-0060 Branch 7. |
| Head bound | **Accepted limit** | Discovery reads 256 KiB / 40 non-blank lines (`HEAD_BYTES`, `HEAD_MAX_LINES`). The usage parser scans the whole file for the marker. The measurement above found no imported rollout whose marker falls outside the head. |

## Review Focus

1. **A native rollout that merely mentions the marker** (a prompt or answer containing `external-import-turn-1`, as one real file does) must stay a normal sighting. Pinned in Task 1 (`native rollout that quotes the marker text still counts`).
2. **An old footprint snapshot without `importedExcluded`** must render exactly as today, with no "undefined" or "0 imported" text. Pinned in Task 2 (`no sentence when the field is absent or zero`).
3. **An imported rollout without a cwd** must count as imported, not as `withoutCwd`, and the per-file counts must still add up to `files`. Pinned in Task 1 (`the counts partition every file`).
4. **A Claude Code transcript head** is never tested against the Codex marker, even if some line carried a `payload.turn_id`. Pinned in Task 1 (`the Codex marker is never applied to Claude transcripts`).
5. **Excluding imports must not make the census look incomplete**: `complete` stays true, and `everSeen` drops only for folders that nothing but an import names. Pinned in Task 1 (`discovery keeps a folder a Claude transcript names`, `an import-only folder is not a project`).

---

## Slice 1 (one implementer, tasks run in order)

All tasks below: shared rollout-level predicate, both call sites, excluded count, docs.

### File map

- Create: `src/lib/codex-import-marker.mjs`: the single constant, `isCodexImportedLine(e)`, `isImportedCodexRollout(headLines)`.
- Modify: `src/lib/usage-parsers.mjs:1149-1159`: delete the local constant and function; import `isCodexImportedLine` from the new module. The doc comment moves with them.
- Modify: `src/lib/usage-project-evidence.mjs:58-62`: `usageSessionOrigin` returns `{ origin: 'unknown', evidence: 'imported-copy' }` for an imported Codex head.
- Modify: `src/lib/footprint/project-sources.mjs`: `scanTranscriptCwds` (base object `:262-278`, loop `:293-307`, return `:322-336`) and `discoverProjectSources` (return `:511-523`, JSDoc `:414-427`).
- Modify: `src/lib/footprint/projects.mjs`: `summarizeCatalog` (`:615`), `resolveProjectCatalog` counts (`:709-718`), `buildProjectsSection` (`:797-801`).
- Modify: `src/lib/dashboard/client/system-readout.mjs:367-388` (`projectsLiner`).
- Create: `tests/kit/project-sources-imports.test.mjs`.
- Modify: `tests/kit/system-summary.test.mjs` (one new test beside the KPI rendering tests).
- Docs: `docs/adr/0052-codex-usage-attribution.md`, `docs/adr/0060-session-surface-initiator-and-product-names.md`, `docs/ddd/machine-footprint.md:648-651`, `docs/DASHBOARD.md` (the "A session cwd is only a discovery candidate" paragraph, near `:639`), `docs/MAINTENANCE.md:110-112`, `docs/TRANSCRIPTS.md:136-142`.

### Task 1: Shared predicate, both call sites and the discovery count

**Files:**

- Create: `src/lib/codex-import-marker.mjs`
- Modify: `src/lib/usage-parsers.mjs:1149-1159`
- Modify: `src/lib/usage-project-evidence.mjs:1-10,58-62`
- Modify: `src/lib/footprint/project-sources.mjs:41,262-336,414-427,511-523`
- Modify: `src/lib/footprint/projects.mjs:615,709-718,797-801`
- Test: `tests/kit/project-sources-imports.test.mjs`

**Interfaces:**

- Produces:
  - `export const CODEX_IMPORT_TURN_PREFIX = 'external-import-turn'` (the only definition in `src/`).
  - `export function isCodexImportedLine(e: object|null|undefined): boolean`: true when `e.payload.turn_id` is a string starting with the prefix. Same behavior as today's private function.
  - `export function isImportedCodexRollout(headLines: string[]|null|undefined): boolean`: true when any line parses as JSON and satisfies `isCodexImportedLine`. Non-string entries and unparseable lines are skipped. A line that does not contain the prefix text is not parsed.
  - `usageSessionOrigin(raw, 'codex')` returns `{ origin: 'unknown', evidence: 'imported-copy' }` for an imported head; otherwise unchanged.
  - `scanTranscriptCwds(...)` result gains `importedExcluded: number` (always present; 0 for Claude and for absent/degraded roots).
  - `discoverProjectSources(...)` result gains top-level `importedExcluded: number` (sum over hosts, like `unresolved`).
  - The `collectProjects(...)` section gains `importedExcluded: number` (0 when the catalog came as an array or discovery failed).

- [ ] **Step 1: Write the failing test**

Create `tests/kit/project-sources-imports.test.mjs`:

```js
// Imported Codex rollouts (the ChatGPT desktop app's "Import from another
// agent" copies of Claude Code transcripts, turn ids `external-import-turn-N`)
// are not Codex activity: they give a folder no Codex host, no Desktop origin
// and no project, and every scan counts them. ADR-0052 §3, ADR-0060 §3.
// Fixtures live in a temporary folder; nothing reads ~/.codex or ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rollout } from './helpers/codex-rollout.mjs';
import { CODEX_IMPORT_TURN_PREFIX, isCodexImportedLine, isImportedCodexRollout } from '../../src/lib/codex-import-marker.mjs';
import { scanTranscriptCwds, discoverProjectSources } from '../../src/lib/footprint/project-sources.mjs';
import { collectProjects } from '../../src/lib/footprint/projects.mjs';
import { usageSessionOrigin } from '../../src/lib/usage-project-evidence.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';

const realpath = (file) => (fs.realpathSync.native ?? fs.realpathSync)(file);

function fixture(t) {
  const root = realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-imported-rollouts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function importedRollout(id, cwd) {
  return new Rollout({ id })
    .meta({ cwd, originator: 'Codex Desktop', source: 'vscode', thread_source: undefined })
    .taskStarted(`${CODEX_IMPORT_TURN_PREFIX}-1`).user('imported prompt').agent('imported answer')
    .lines;
}

function nativeRollout(id, cwd, { originator = 'codex_work_desktop', prompt = 'do the thing' } = {}) {
  return new Rollout({ id }).meta({ cwd, originator }).turn('gpt-5.6', { cwd })
    .taskStarted('t1').user(prompt).agent('done').lines;
}

function writeRollout(dir, name, lines) {
  const file = path.join(dir, '2026', '09', '27', `rollout-${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('the rollout predicate reads only a string payload.turn_id with the import prefix', () => {
  assert.equal(isCodexImportedLine({ payload: { turn_id: 'external-import-turn-3' } }), true);
  assert.equal(isCodexImportedLine({ payload: { turn_id: 't1' } }), false);
  assert.equal(isCodexImportedLine({ payload: { turn_id: 7 } }), false);
  assert.equal(isCodexImportedLine(null), false);
  assert.equal(isImportedCodexRollout(importedRollout('a', '/p')), true);
  assert.equal(isImportedCodexRollout(nativeRollout('b', '/p')), false);
  assert.equal(isImportedCodexRollout(['{not json external-import-turn-1', 42, null]), false);
  assert.equal(isImportedCodexRollout(null), false);
});

test('native rollout that quotes the marker text still counts', () => {
  const lines = nativeRollout('c', '/p', { prompt: 'why is my turn id external-import-turn-1?' });
  assert.equal(isImportedCodexRollout(lines), false);
});

test('an imported rollout contributes no sighting and is counted; a native Desktop one still is', (t) => {
  const root = fixture(t);
  const importedDir = path.join(root, 'imported-project'), nativeDir = path.join(root, 'native-project');
  fs.mkdirSync(importedDir); fs.mkdirSync(nativeDir);
  const sessions = path.join(root, 'sessions');
  writeRollout(sessions, 'imported', importedRollout('imp', importedDir));
  writeRollout(sessions, 'native', nativeRollout('nat', nativeDir));
  const scan = scanTranscriptCwds(sessions, 'codex');
  assert.deepEqual(scan.sightings.map(({ cwd, sessionOrigin }) => [cwd, sessionOrigin.origin]),
    [[nativeDir, 'codex-desktop']]);
  assert.equal(scan.importedExcluded, 1);
  assert.equal(scan.complete, true, 'setting an import aside is not a gap in the census');
});

test('the counts partition every file', (t) => {
  const root = fixture(t), sessions = path.join(root, 'sessions');
  writeRollout(sessions, 'imported', importedRollout('imp', root));
  writeRollout(sessions, 'imported-no-cwd', importedRollout('imp2', undefined));
  writeRollout(sessions, 'native', nativeRollout('nat', root));
  writeRollout(sessions, 'native-no-cwd', new Rollout({ id: 'x' }).raw('event_msg', { type: 'task_started', turn_id: 't1' }).lines);
  fs.writeFileSync(path.join(sessions, 'empty.jsonl'), '');
  const scan = scanTranscriptCwds(sessions, 'codex');
  assert.equal(scan.importedExcluded, 2, 'an import without a cwd is still an import');
  assert.equal(scan.withoutCwd, 1);
  assert.equal(scan.files, scan.withCwd + scan.withoutCwd + scan.empty + scan.unreadable + scan.importedExcluded);
});

test('the Codex marker is never applied to Claude transcripts', (t) => {
  const root = fixture(t), projects = path.join(root, 'projects', '-encoded');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 's.jsonl'), `${JSON.stringify({
    cwd: root, sessionId: 's', entrypoint: 'cli', payload: { turn_id: 'external-import-turn-1' },
  })}\n`);
  const scan = scanTranscriptCwds(path.join(root, 'projects'), 'claude');
  assert.equal(scan.sightings.length, 1);
  assert.equal(scan.importedExcluded, 0);
});

function discover(root, { claudeCwd = null } = {}) {
  const claudeRoot = path.join(root, 'claude-projects');
  fs.mkdirSync(path.join(claudeRoot, '-encoded'), { recursive: true });
  if (claudeCwd) {
    fs.writeFileSync(path.join(claudeRoot, '-encoded', 's.jsonl'),
      `${JSON.stringify({ cwd: claudeCwd, sessionId: 's', entrypoint: 'cli', timestamp: '2026-09-27T00:00:00Z' })}\n`);
  }
  return discoverProjectSources({
    claudeRoot, codexRoot: path.join(root, 'sessions'), opencodeDbFile: path.join(root, 'absent.db'),
    decodeEncodedDirs: false, resolveLabel: (p) => path.basename(p),
  });
}

test('discovery keeps a folder a Claude transcript names, without a Codex host or Desktop origin', (t) => {
  const root = fixture(t), shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  writeRollout(path.join(root, 'sessions'), 'imported', importedRollout('imp', shared));
  const payload = discover(root, { claudeCwd: shared });
  const row = payload.projects.find((p) => p.path === shared);
  assert.deepEqual(row.hosts, ['claude']);
  assert.deepEqual(row.sessionOrigins.map((o) => o.origin), ['unknown']);
  assert.equal(payload.importedExcluded, 1);
  assert.equal(payload.complete, true);
});

test('an import-only folder is not a project', (t) => {
  const root = fixture(t), only = path.join(root, 'only-imported');
  fs.mkdirSync(only);
  writeRollout(path.join(root, 'sessions'), 'imported', importedRollout('imp', only));
  const payload = discover(root);
  assert.equal(payload.projects.some((p) => p.path === only), false);
  assert.equal(payload.everSeen, 0);
  assert.equal(payload.importedExcluded, 1);
});

test('the Projects section carries the discovery count', () => {
  const section = collectProjects({
    sources: { projects: [], everSeen: 0, onDisk: 0, gitRepos: 0, unresolved: 0, importedExcluded: 3, complete: true, method: 'm', sources: {} },
    loc: false, now: () => 1,
  });
  assert.equal(section.importedExcluded, 3);
  assert.equal(collectProjects({ projects: [], loc: false, now: () => 1 }).importedExcluded, 0);
});

test('the usage origin of an imported head is unknown and says why', () => {
  const imported = importedRollout('imp', '/p').join('\n');
  assert.deepEqual(usageSessionOrigin(imported, 'codex'), { origin: 'unknown', evidence: 'imported-copy' });
  assert.equal(usageSessionOrigin(nativeRollout('n', '/p').join('\n'), 'codex').origin, 'codex-desktop');
  const parsed = parseCodex(imported, { id: 'imp' });
  assert.equal(parsed.session.imported, true);
  assert.equal(parsed.session.sessionOrigin.origin, 'unknown');
});
```

Notes for the implementer: `Rollout.meta` spreads `extra` over `{ id, cwd: '/Users/me/proj', thread_source: 'user' }`, so `cwd: undefined` produces a `session_meta` without a usable cwd (JSON drops `undefined`), and `thread_source: undefined` removes it, as in a real import. If `collectProjects` with an empty `sources` payload needs more options to run hermetically (it should not walk anything when there are no rows), pass `walk: () => ({ complete: true })` and `detect: () => ({})` rather than changing the product code for the test.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/kit/project-sources-imports.test.mjs`
Expected: FAIL at import time with `Cannot find module '…/src/lib/codex-import-marker.mjs'`. Record the output for the commit evidence.

- [ ] **Step 3: Create the leaf module**

Create `src/lib/codex-import-marker.mjs`:

```js
// The one place that knows how an imported Codex rollout is marked.
//
// Codex (the ChatGPT desktop app's "Import from another agent") can copy a
// Claude Code transcript in as a thread. The host stamps such a rollout's turns
// `external-import-turn-N` (measured 2026-09-19: 796 imports, every one carrying
// it from its first task_started, none of a native thread; 2026-09-27: 924 of
// 924 on the rollout's second line). The in-rollout marker is the signal: the
// host's imports file is deliberately not read, so detection works without it.
// Usage parsing, usage origin and project discovery all use these predicates
// (ADR-0052 §3, ADR-0060 §3). Leaf module: imports nothing, so any of them can
// use it without an import cycle.

export const CODEX_IMPORT_TURN_PREFIX = 'external-import-turn';

/** One decoded rollout record: is it a turn of an imported thread? Only a
 *  string `payload.turn_id` counts; the marker text inside a message does not. */
export function isCodexImportedLine(e) {
  const turnId = e?.payload?.turn_id;
  return typeof turnId === 'string' && turnId.startsWith(CODEX_IMPORT_TURN_PREFIX);
}

/** A rollout's bounded head (raw JSON lines): is the rollout an imported copy?
 *  A line without the marker text is not parsed, which keeps this cheap on the
 *  large native heads; unparseable and non-string lines are skipped. */
export function isImportedCodexRollout(headLines) {
  for (const line of headLines ?? []) {
    if (typeof line !== 'string' || !line.includes(CODEX_IMPORT_TURN_PREFIX)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (isCodexImportedLine(record)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Point the usage parser at it**

In `src/lib/usage-parsers.mjs`, delete lines `1149-1159` (the doc comment, `const CODEX_IMPORT_TURN_PREFIX` and `function isCodexImportedLine`) and add to the import block near line 25:

```js
import { isCodexImportedLine } from './codex-import-marker.mjs';
```

The call site at `:1245` (`if (isCodexImportedLine(e)) return importedCodexSession(rec, stats);`) stays unchanged. Check: `grep -rn "external-import-turn'" src` prints only `src/lib/codex-import-marker.mjs`.

- [ ] **Step 5: Classify an imported head in `usageSessionOrigin`**

In `src/lib/usage-project-evidence.mjs`, add the import and replace the function:

```js
import { isImportedCodexRollout } from './codex-import-marker.mjs';
```

```js
/** Same bounded head and exact origin allowlists as footprint discovery. An
 *  imported Codex copy of a Claude Code transcript declares the ChatGPT desktop
 *  app as its originator but is not a session from it (ADR-0060 §3). */
export function usageSessionOrigin(raw, host) {
  const head = Buffer.from(String(raw).slice(0, 256 * 1024)).subarray(0, 256 * 1024).toString('utf8');
  const lines = head.split('\n').filter((line) => line.trim()).slice(0, 40);
  if (host === 'codex' && isImportedCodexRollout(lines)) return { origin: 'unknown', evidence: 'imported-copy' };
  return transcriptSessionOrigin(lines, host);
}
```

- [ ] **Step 6: Skip and count imports in discovery**

In `src/lib/footprint/project-sources.mjs`:

1. Add `import { isImportedCodexRollout } from '../codex-import-marker.mjs';` after the `session-origin.mjs` import (`:41`).
2. In the `base` object of `scanTranscriptCwds`, add `importedExcluded: 0,` after `recoveredFromDirName: 0,`.
3. Declare `let importedExcluded = 0;` beside `let unreadable = 0;`.
4. In the loop, after the `empty` check and before `firstCwd`:

```js
    // An imported copy of a Claude Code transcript is not a Codex session: it
    // names the folder the Claude session ran in and declares the ChatGPT
    // desktop app as originator. It gives no project, host or origin and is
    // counted, never dropped silently (ADR-0052 §3, ADR-0060 §3).
    if (host === 'codex' && isImportedCodexRollout(lines)) { importedExcluded += 1; continue; }
```

Then, in the final return, add `importedExcluded,` after `recoveredFromDirName,`. Leave `complete` as it is: an import set aside is not an unreadable file.

Finally, in `discoverProjectSources`, beside `unresolved`:

```js
  const importedExcluded = PROJECT_SOURCE_HOSTS
    .reduce((total, host) => total + (sources[host]?.importedExcluded ?? 0), 0);
```

and add `importedExcluded,` to the returned object after `unresolved,`. Extend the `@returns` JSDoc with `importedExcluded: number` and one sentence: "`importedExcluded` counts Codex rollouts that are imported copies of Claude Code transcripts, which name no project."

- [ ] **Step 7: Carry the count into the Projects section**

In `src/lib/footprint/projects.mjs`:

- `summarizeCatalog` return (`:615`): `{ everSeen: rows.length, onDisk, gitRepos, unresolved: 0, importedExcluded: 0, complete: true }`.
- `resolveProjectCatalog` counts (`:709-718`): add `importedExcluded: payload?.importedExcluded ?? 0,` after `unresolved`.
- `buildProjectsSection` (`:800`): add `importedExcluded: counts?.importedExcluded ?? 0,` after `unresolved`.

`systemSummaryPayload` (`src/lib/dashboard/system-summary.mjs:61`) passes `projects` through untouched, so `/api/system/summary` carries the field with no change there.

- [ ] **Step 8: Run the focused tests and watch them pass**

Run:

```bash
node --test tests/kit/project-sources-imports.test.mjs tests/kit/dashboard-project-identity.test.mjs tests/kit/footprint-projects.test.mjs tests/kit/usage-codex-attribution.test.mjs tests/kit/project-census.test.mjs tests/kit/usage-index-v6.test.mjs
```

Expected: PASS, 0 failures. If a `deepEqual` on a whole scan or section object elsewhere fails only because of the new field, add the field to that expectation and name the test in the commit body.

- [ ] **Step 9: Lint and type-check the touched files**

```bash
npx eslint src/lib/codex-import-marker.mjs src/lib/usage-parsers.mjs src/lib/usage-project-evidence.mjs src/lib/footprint/project-sources.mjs src/lib/footprint/projects.mjs tests/kit/project-sources-imports.test.mjs
npx eslint src/lib/footprint/project-sources.mjs --rule 'complexity: [2, 50]'
npx tsc -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/cphillipson/Development/active/ai/agentic-kit-b1
git add src/lib/codex-import-marker.mjs src/lib/usage-parsers.mjs src/lib/usage-project-evidence.mjs src/lib/footprint/project-sources.mjs src/lib/footprint/projects.mjs tests/kit/project-sources-imports.test.mjs
git commit -m "fix(discovery): keep imported Codex copies out of project origins" -m "Rollouts the ChatGPT desktop app imported from Claude Code transcripts (turn ids external-import-turn-N) no longer give a folder a Codex host, a Desktop origin or a project row. Discovery counts them as importedExcluded, and the count reaches the Projects section. The one marker constant moves to a leaf module used by the usage parser, usage origin and discovery, so no import cycle is added. Failing first: the new test file failed on the missing module; passing after: <paste counts>."
```

### Task 2: Say how many imports discovery set aside

**Files:**

- Modify: `src/lib/dashboard/client/system-readout.mjs:367-388` (`projectsLiner`)
- Test: `tests/kit/system-summary.test.mjs` (add one test after the "KPI band and every catalog card" test, near `:218`)

**Interfaces:**

- Consumes: `projects.importedExcluded: number|undefined` from Task 1 (the Projects section).
- Produces: the `sys-kpis-note` HTML gains one sentence when `importedExcluded > 0`.

- [ ] **Step 1: Write the failing test**

Add to `tests/kit/system-summary.test.mjs`, reusing the file's `systemClient()` and `fullPayload()`:

```js
test('the projects note says how many imported copies discovery set aside, and nothing when there are none', () => {
  const noteFor = (extra) => {
    const client = systemClient();
    const projects = { everSeen: { value: 114 }, onDisk: { value: 90 }, gitRepos: { value: 60 }, unresolved: 0,
      method: 'm', projects: [], ...extra };
    client.readout.renderSysKpis({ ...fullPayload(1), projects });
    return client.document.getElementById('sys-kpis-note').innerHTML;
  };
  const note = noteFor({ importedExcluded: 924 });
  assert.match(note, /924 Codex copies of Claude Code sessions, imported by the ChatGPT desktop app, are not counted/);
  assert.match(noteFor({ importedExcluded: 1 }), /1 Codex copy of a Claude Code session, imported by the ChatGPT desktop app, is not counted/);
  for (const extra of [{}, { importedExcluded: 0 }]) {
    const plain = noteFor(extra);
    assert.doesNotMatch(plain, /imported|undefined/, 'an old snapshot or a zero renders exactly as before');
  }
});
```

If `fakeDocument().getElementById` in this file returns `null` for ids it has not seen, use the same accessor the neighbouring test uses (`[...client.document.elements]`) to read `sys-kpis-note`; do not change the fake.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/kit/system-summary.test.mjs --test-name-pattern "imported copies"`
Expected: FAIL on the first `assert.match` (the note has no such sentence).

- [ ] **Step 3: Add the sentence**

In `projectsLiner`, after the `unresolved` block and before the `truncated` line:

```js
    var imported=typeof p.importedExcluded==="number"&&p.importedExcluded>0?p.importedExcluded:0;
    if(imported){
      note+=" "+esc(fmtNum(imported))+(imported===1
        ?" Codex copy of a Claude Code session, imported by the ChatGPT desktop app, is not counted"
        :" Codex copies of Claude Code sessions, imported by the ChatGPT desktop app, are not counted")
        +"; the Claude Code transcript already names its folder.";
    }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test tests/kit/system-summary.test.mjs`
Expected: PASS, including the existing "renders identically from the summary and the full payload" test.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/cphillipson/Development/active/ai/agentic-kit-b1
npx eslint src/lib/dashboard/client/system-readout.mjs tests/kit/system-summary.test.mjs
git add src/lib/dashboard/client/system-readout.mjs tests/kit/system-summary.test.mjs
git commit -m "feat(system): say how many imported Codex copies project discovery set aside" -m "Failing first: the new system-summary test failed on the missing sentence; passing after: <paste counts>."
```

### Task 3: Documentation

**Files:**

- Modify: `docs/adr/0052-codex-usage-attribution.md` (header and §3)
- Modify: `docs/adr/0060-session-surface-initiator-and-product-names.md` (header)
- Modify: `docs/ddd/machine-footprint.md:648-651`
- Modify: `docs/DASHBOARD.md` (the "A session cwd is only a discovery candidate" paragraph, near `:639-642`)
- Modify: `docs/MAINTENANCE.md:110-112`
- Modify: `docs/TRANSCRIPTS.md:136-142`

Documentation has no failing test of its own; its gates are `npx markdownlint-cli2` and `node --test tests/kit/doc-citations.test.mjs`. Do not add `file.mjs:NNN` citations to these docs unless you check them against that test: it verifies the cited line against the current source.

- [ ] **Step 1: ADR-0052.** After `- **Date:** 2026-09-19` add:

```markdown
- **Updated:** 2026-09-27 — imported copies are also excluded from project discovery: they give no
  project, host or Desktop origin, and the discovery scan counts them in `importedExcluded`
  (ADR-0060 §3). The marker now lives in one leaf module shared by usage and discovery.
```

At the end of §3 (after "The record itself is still cached, so a rescan is cheap."), add one paragraph:

```markdown
Project discovery applies the same marker to each rollout's bounded head (256 KiB, 40 lines): an
imported copy names no project, host or Desktop origin, and the scan reports how many it set aside
(`importedExcluded`, 924 on the reference machine on 2026-09-27, every marker on the rollout's
second line).
```

- [ ] **Step 2: ADR-0060.** Leave `Status` as the maintainer set it. Change `(staged follow-on; nothing implemented)` to `(staged follow-on)` and add under `Date`:

```markdown
- **Updated:** 2026-09-27 — §3 implemented for project discovery and the System projects note:
  imported copies give no project, host or origin and are counted. The ledger-derived source labels
  (Cursor, Cowork) and the other views remain proposed.
```

- [ ] **Step 3: DDD.** In `docs/ddd/machine-footprint.md`, replace the sentence of the "Proposed change" paragraph that begins "Imported session copies" with current state, and move it out of the "Proposed change" paragraph as its own paragraph:

```markdown
Imported session copies are not sightings. A Codex rollout stamped `external-import-turn-*` is a
Claude Code transcript that the ChatGPT desktop app imported; the Claude transcript already names
its folder. Discovery skips it before reading its cwd, so it adds no project, host or Session
origin, and counts it in `importedExcluded` (per host scan and in total). `complete` is unaffected.
```

- [ ] **Step 4: DASHBOARD.md.** Append to the "A session cwd is only a discovery candidate" paragraph:

```markdown
A Codex session that the ChatGPT desktop app imported from a Claude Code transcript is not a
candidate at all: it adds no project, host or Desktop origin, and the Projects note under the System
KPIs says how many were set aside.
```

- [ ] **Step 5: MAINTENANCE.md.** After "Desktop origin never replaces repository membership." insert: "Codex copies of Claude Code sessions imported by the ChatGPT desktop app never count as a Desktop origin."

- [ ] **Step 6: TRANSCRIPTS.md.** At the end of the "Imported Claude sessions" bullet, add: "Project discovery reads the same marker in each rollout's head and leaves the rollout out of projects, hosts and Desktop origins, counting it in the discovery scan's `importedExcluded`."

- [ ] **Step 7: Check the product names and run the doc gates**

```bash
cd /Users/cphillipson/Development/active/ai/agentic-kit-b1
npx markdownlint-cli2
node --test tests/kit/doc-citations.test.mjs tests/kit/ga-surface-guard.test.mjs
```

Expected: 0 errors, PASS. Also re-read ADR-0050 (session origin rule) and `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` (ADR-0060 section, "staged as follow-on, starting with that exclusion") for anything the change now contradicts; the audit record is history, so leave it unless it states a current fact that is now false.

- [ ] **Step 8: Commit**

```bash
git add docs/adr/0052-codex-usage-attribution.md docs/adr/0060-session-surface-initiator-and-product-names.md docs/ddd/machine-footprint.md docs/DASHBOARD.md docs/MAINTENANCE.md docs/TRANSCRIPTS.md
git commit -m "docs(adr): record that discovery excludes imported copies (ADR-0052)"
```

### Task 4: Full gate set and real-machine check (gate agent)

- [ ] **Step 1: Run the gate set from the worktree, exactly as in the common brief**

```bash
cd /Users/cphillipson/Development/active/ai/agentic-kit-b1
S=$(mktemp -d "$PWD/../ak-gate.XXXXXX")
FP=/Users/cphillipson/Development/active/ai/agentic-kit/.superpowers/sdd/2026-09-26-remediation-program/briefs/fingerprint.sh
$FP "$PWD" > "$S/fp-before.txt"
env XDG_STATE_HOME="$S/state" LOCALAPPDATA="$S/localappdata" node --test --experimental-test-coverage --test-coverage-lines=70 --test-coverage-branches=70 --test-coverage-functions=70 "tests/kit/*.test.mjs"
env XDG_STATE_HOME="$S/state22" mise exec node@22.22.3 -- node --test "tests/kit/*.test.mjs"
for f in statusline-segments statusline-window-ledger statusline-brain health-history dashboard admin-model admin; do env XDG_STATE_HOME="$S/state" node "tests/$f.test.cjs" || echo "FAIL $f"; done
npx tsc -p tsconfig.json
npx eslint . --ignore-pattern '.superpowers/**'
npx eslint src bin --rule 'complexity: [2, 50]'
npx markdownlint-cli2
node scripts/build-check.mjs
env XDG_STATE_HOME="$S/state" node tests/ui/dashboard-ui.mjs && env XDG_STATE_HOME="$S/state" node --test tests/ui/dashboard-project-context.mjs tests/ui/maintenance-projects.mjs tests/ui/maintenance-host-alignment.mjs tests/ui/intelligence-picker.mjs tests/ui/usage-project-groups.mjs tests/ui/context-coverage.mjs tests/ui/host-readiness.mjs
node --test tests/kit/doc-citations.test.mjs tests/kit/ga-surface-guard.test.mjs
npm pack --dry-run 2>&1 | grep codex-import-marker   # the new runtime module ships
$FP "$PWD" > "$S/fp-after.txt"; diff "$S/fp-before.txt" "$S/fp-after.txt"
rm -rf "$S"
```

Expected: 0 failures; coverage at or above 70/70/70; eslint 0 errors; `npm pack` lists `src/lib/codex-import-marker.mjs`; the fingerprint diff is empty (or each line is explained with evidence).

- [ ] **Step 2: Read-only check on the real machine (counts only)**

```bash
cd /Users/cphillipson/Development/active/ai/agentic-kit-b1
node --input-type=module -e "
import { discoverProjectSources } from './src/lib/footprint/project-sources.mjs';
const p = discoverProjectSources();
const desktop = p.projects.filter((r) => r.sessionOrigins.some((o) => o.origin === 'codex-desktop')).length;
console.log(JSON.stringify({ everSeen: p.everSeen, importedExcluded: p.importedExcluded, codexImported: p.sources.codex.importedExcluded, foldersWithCodexDesktop: desktop, complete: p.complete }));
"
```

Expected on the maintainer's machine: `importedExcluded` about 924 (grows with new imports), `everSeen` about 5 lower than before the branch (114 on 2026-09-27), and `foldersWithCodexDesktop` equal to the folders genuine ChatGPT desktop app sessions name (17 on 2026-09-26). Record the figures in the branch report; this is discovery only and writes nothing.

## Self-review

- Spec coverage: program-plan interface `isImportedCodexRollout(headLines: string[]): boolean` (Task 1 Step 3); fixture with `turn_id: "external-import-turn-1"` gives no sighting and no origin, a native `codex_work_desktop` rollout still does, scan reports `importedExcluded: 1` (Task 1 tests 3 and 6); both call sites (Steps 5 and 6); count surfaced where the scan result is reported (Steps 6 and 7, Task 2); the listed docs (Task 3). ADR-0060 §3's per-source labels from the imports ledger (Cursor, Cowork) are not in the program-plan scope and stay proposed.
- Commit subjects match the program plan for the fix and the docs; Task 2 adds one `feat(system)` commit because the note is a separately reviewable user-facing change.
- Names used across tasks: `CODEX_IMPORT_TURN_PREFIX`, `isCodexImportedLine`, `isImportedCodexRollout`, `importedExcluded`, evidence value `imported-copy`.
