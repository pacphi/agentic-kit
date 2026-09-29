# Branch 4 — Upstream Watch Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the upstream watch trustworthy enough to run daily: a release counts only when a published version provably contains the merged fixing change, AgentDB fixes count only when Ruflo bundles them, the registry separates "state re-read" from "conformance verified", and the registry's data (ledger issue, tracking issues, doc citations, the reply and stale queues) matches reality.

**Architecture:** Two sequential implementer slices in worktree `../agentic-kit-b4` on `feat/upstream-watch-live`. Slice 1 changes code and schema (`scripts/upstream-watch/*`, `src/lib/hook-audit/upstream*.mjs`, the JSON Schema, schema version 5 → 6). Slice 2 changes registry data, the citation guard, and documentation, and writes draft upstream comments into its report (never posted). All network access stays behind the injectable `exec` in `scripts/upstream-watch/fetch.mjs`; every rule is tested from recorded fixtures.

**Tech Stack:** Node 22+/26 ESM, `node:test`, GitHub CLI (`gh api`, `gh api graphql`), `npm view`.

**Spec:** [Remediation program, Branch 4](../plans/2026-09-26-remediation-program.md#branch-4-featupstream-watch-live), [audit record](../plans/2026-09-26-issues-237-238-239-verification-and-decisions.md) ("Upstream watch and dispatch", "Ruflo support window", "Ruflo 3.46.0", "Retroactive upstream sweep"), [the upstream watch](../upstream-watch.md), and the SDD ledger's Branch 4 maintainer decisions (B4-G1, B4-G2, B4-Q1, B4-Q2, B4-Q3) and rulings (main checkout `.superpowers/sdd/2026-09-26-remediation-program/progress.md`, lines 56 and 64–72).

## Global Constraints

Copied from the program plan; every task's requirements include these.

- Commits carry no `Co-Authored-By` or other attribution trailer.
- Nothing is pushed, opened as a pull request, merged, posted upstream, or created as a cloud routine without the maintainer's explicit go-ahead for that action.
- Upstream publication follows the constraint registry's `issuePublication: explicit-user-approval-required`.
- Never run `pnpm` in a worktree whose `node_modules` is a symlink; use `node --test`, `npx eslint`, `npx tsc -p tsconfig.json`, `npx markdownlint-cli2` and `node scripts/build-check.mjs`.
- Disposable environments use `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME` (or `env -i`), a `mktemp -d <template>` inside the scratch area (macOS ignores `TMPDIR` without a template), and assert every created path lies inside it.
- Tests never write real user state: not the repository's `.claude`/`.swarm`, not `~/.config/agentic-kit`, not `~/.local/state/agentic-kit`, not any real memory store.
- Runtime assets live under `src/` and are proven shipped with `npm pack --dry-run`.
- User-facing docs describe the current state only; history lives in ADRs and audit records; every branch passes the six-class documentation gate (ADR, DDD, supplemental, audit, research, user-facing).
- An ADR a branch changes gets its status, an `Updated` date and a one-line note in the same branch.
- Ruflo support window: the newest six minors, never fewer than the minors released in the last 30 days (n-5, at least 30 days, rolling).
- Never message a running workflow or background agent; start a fresh one instead.

Branch-specific (from the common brief and the ledger):

- Stage files by name; never `git add -A` / `git add .`; never commit `.harness/`, `.swarm/`, `.claude-flow/`, `.agentic-qe/`. No trailer-like last line in any commit message.
- Test-first: each commit's report shows the failing run, then the passing run.
- Branch 3 (`feat/ruflo-support-window`) edits the same registry file in parallel (entries `ruvnet/ruflo#3167`, `#3194`, `#3415`, and the Ruflo dependency policy). Touch only the top-level fields, the entries and the fields a task names, so the hand-resolved JSON merge stays small. Never re-order or re-format the file (write it with `JSON.stringify(doc, null, 2) + '\n'`, which is its current format — verify with `git diff --stat` that only intended lines moved).
- Draft upstream comments are written into the slice's report, never posted (ruling: the controller posts #213/#240 comments after merge).
- The daily routine is **not** created in this branch (B4-G2), and the agentic-qe#617 dispatch rehearsal is **not** in this branch (ruling).

## Scope verified against the code (2026-09-27, worktree base `be1c1d47`)

Live `node scripts/upstream-watch.mjs report --json` (gh authenticated): needs-reply 1, released-actionable 3, workaround-carried 9, fixed-unreleased 1, waiting 34, stale 3, ready-to-retire 9, tracking 2, unmapped 4, unchecked 0. The registry holds **84** watch entries (82 upstream + 2 tracking), not 83; 10 constraints; 7 dependency policies (`ruflo`, `agentic-qe`, `agent-browser`, `codex`, `ruvnet-brain`, `ruvector`, `agentic-flow`).

| Item | Verdict | Evidence |
|---|---|---|
| (a) confirm "candidate" releases via closing PRs | **Confirmed defect.** `releaseState` (`scripts/upstream-watch/classify.mjs:92-98`) calls the first version published after the fix a candidate and `liveGroups` (`:139`) puts it in `released-actionable` unconfirmed; the ledger line only adds `candidate=yes` (`:245`), and the routine prompt dispatches on every `released` line. | Live: ruflo#3167 closed by PR #3434 (merged 2026-09-26T22:31:21Z, merge `856249e`), #3194 by PR #3421 (`e45eeea`), #3415 by PR #3423 (`9be7366`); `gh api repos/ruvnet/ruflo/compare/v3.46.0...<sha>` → `behind` for all three (contained). #3167 also lists **unmerged** PR #3373 among its closing references — the filter on `merged` matters. v3.46.0's release body cites #3421/#3423/#3434 (corroboration only). |
| (a) tag spelling | **Design input.** `ruflo`, `agentic-qe` tag `v<version>`; `openai/codex` tags `rust-v<version>`; `ruvnet/agentdb` has **no tags**; npm `gitHead` is absent for ruflo, @claude-flow/cli, agentdb, agentic-qe, codex, agent-browser (present only for ruvector). | `gh api repos/<r>/tags`, `npm view <p> gitHead`. |
| (a) the `ruflo` package | **Assumption stated.** `ruflo@3.46.1` is a shim depending on `@claude-flow/cli ^3.33.0`; both are released from the one `ruvnet/ruflo` monorepo with shared `v<version>` tags, so containment by `v{version}` holds for Ruflo threads. | `npm view ruflo@3.46.1 dependencies`. |
| (b) B4-Q1 AgentDB | **Confirmed gap.** The three AgentDB entries (`ruvnet/agentdb#26/#27/#28`, dependency `ruflo`) gate on `npm agentdb` directly (`minVersion: null`), so an agentdb publish alone would read as released. All three are open today (no false positive yet). | Chain observed: `ruflo@latest` → `@claude-flow/cli ^3.33.0` → cli 3.46.1 `optionalDependencies.agentdb ^3.0.0-alpha.17` → max `3.0.0-alpha.20`; the maintainer's global install shows `agentdb@3.0.0-alpha.20` under `ruflo@3.46.1`. "Newest Ruflo in the support window" is by definition npm `dist-tags.latest`, so this needs **no Branch 3 code**. |
| (c) B4-Q3 dates | **Confirmed.** One date, `lastVerifiedAt`, is both the weekly state re-read and the tests' clock (`tests/kit/hook-upstream.test.mjs:11-12`, `upstream-watch-registry.test.mjs:17`, `upstream-watch-script.test.mjs:21-22`, `hook-audit-hosts.test.mjs:126`), and `docs/UPSTREAM-WATCH.md:52-58` tells the maintainer to move every `nextRetestAt` a week on a state re-read. **Trap:** `hook-upstream.test.mjs:38-43` asserts `evidenceStatus: 'current'`; once the clock is `lastCheckedAt` and `nextRetestAt` stops moving weekly, that assertion becomes false by design. Also `src/lib/hook-remediation/planner.mjs:377-389` copies upstream facts into `planIdentity` (plan digests are recomputed, never pinned — verify). `docs/schemas/README.md:16` says "schema 5". | |
| (d) B4-Q2 guard | **Confirmed.** `CITATION_DIRS = ['src','bin','claude','tests']` (`scripts/upstream-watch/citations.mjs:12`). CLI help text already lives under `src/`, so it is covered. Scanning `README.md` + top-level `docs/*.md` finds **29** unregistered threads (list in Task 7). Two repos cited there have **no dependency policy** (`anthropics/claude-code`, `anomalyco/opencode`), and the loader rejects a non-tracking entry without one (`src/lib/hook-audit/upstream-watch.mjs:100`). | |
| (e) ledger issue | **Not recorded.** `watchPolicy.ledger` has `repo`, `issueTitle`, `sentinel` only; the schema sets `additionalProperties: false` (`schema.json:31`). #243 exists (created, pinned, locked 2026-09-27; B4-G1). | |
| (f) #240 / #213 migration | **Mostly already done.** Both are `tracking` entries (#240 tracks agentic-qe#574/#719; #213 tracks ruflo#3196). Left: #213's remainder per its 2026-09-10 maintainer comments and our 2026-09-27T14:22Z reply — ruflo#3446 and #3450 (registered) should be tracked; threads its body cites (ruflo#2786, #3143, #2889, #3195) are unregistered; history lacks our 2026-09-27 comment. agentic-qe#719 is merged but unreleased (report group fixed-unreleased). Our 14:22Z #213 comment already says the remainder sits in the registry, so a second #213 comment is optional. | |
| (g) ruflo#3153 | **Confirmed.** Four comments by sparkling (2026-09-02T19:28Z … 2026-09-03T08:54Z) are scope corrections and revalidation for upstream; nothing is asked of ak. Needs-reply uses `max(lastOurWordAt, latest PROCESSED history date)` (`classify.mjs:106-113`); no history event records "we read it, no reply needed". Do **not** reuse the name `acknowledged` — it is the ledger event for automated acknowledgements. | |
| (h) codex#16045 | **Registry wrong.** Entry is `unmapped`, but `src/lib/host-health-connected.mjs:109` carries exactly its workaround (disables each MCP server with `-c mcp_servers.<name>.enabled=false` and verifies, because `-c 'mcp_servers={}'` is a no-op). No file cites #16045. → remap, "ask once". | |
| (h) codex#16921 | ak still wants a command-backed Codex status line (`src/lib/hosts.mjs:18-20` cites #16921/#17827/#20140/#20244), but the same request is watched via **openai/codex#17827** (open, updated 2026-09-27). → "retire, watched through #17827" (the dependence moves, it does not disappear — flagged). | |
| (h) ruflo#952 | **Partly addressed upstream, issue stale.** Installed Ruflo 3.46.1 filters *advertised* MCP tool schemas (`mcp start --tools`, `CLAUDE_FLOW_MCP_TOOLS`; `@claude-flow/cli@3.46.1 dist/src/mcp-server.js:114-137,193`) but "execution remains registered internally" (`:121-124`), so it does not replace ak's `permissions.deny` gating (`src/lib/mcp.mjs:1-3`). RuvNet Brain: `ruflo/ruflo/docs/adr/ADR-035-MCP-TOOL-GROUPS.md` (design intent, MCP bridge `MCP_GROUP_*`). → "ask once", rewrite the adjustment. | |
| (i) decisions into audit record | Not yet written. Branch 3 writes B3-D1..D4 into the same file — append a separate section at the end; the second merger reconciles. | |

## Review Focus

1. **Branch 3 also bumps the schema or edits the same entries.** If `main` is already schema 6 at rebase time, this branch becomes 7 and migrates on top; the registry test "the registry carries the watch list and stays valid" must pass on the rebased tip (Task 1 adds the version assertion that makes a double bump visible).
2. **A closing reference that is not a fix** (an unmerged PR such as ruflo#3373, a PR merged into a non-default branch, or a thread closed by hand with no change) must never confirm a release. Pinned by Task 3's "unmerged or off-branch closers never confirm" test.
3. **A compare failure that is not "tag missing"** (rate limit, auth, 5xx) must surface as "Could not check", never as "not contained" (which would silently hide a real release in fixed-unreleased). Pinned by Task 2's "404 is unknown, other failures throw" test.
4. **npm range answers**: `npm view pkg@range version --json` returns a bare string for one match and an array otherwise, and caret ranges on prereleases (`^3.0.0-alpha.17`) must pick the highest match by semver, not by string. Pinned by Task 4's resolver test.
5. **The weekly re-check moving `lastCheckedAt` past `nextRetestAt`** must leave the registry `valid` (evidence `stale`, constraints listed as due) and must not break the suite. Pinned by Task 1's "a state re-read past the retest date is stale evidence, not an invalid registry" test.

Also known and accepted (documented, not tested): an "ask once" comment does not clear the stale flag (staleness counts only others' activity), so an asked thread keeps reporting until upstream answers or the maintainer retires it.

---

## Slice 1 — check script + schema (implementer 1)

Tasks 1–4, in order. Report: main checkout `.superpowers/sdd/2026-09-26-remediation-program/reports/b4-impl-1.md`.

### Task 1: Schema 6 — `lastCheckedAt` separate from conformance dates (B4-Q3)

**Files:**

- Modify: `src/lib/hook-audit/upstream.mjs:36-148` (version check, date validation, `registryStale`, result)
- Modify: `docs/schemas/agentic-dependency-constraints.schema.json` (`schemaVersion` const 6, `lastCheckedAt` required)
- Modify: `src/lib/hook-audit/agentic-dependency-constraints.json` (top of file only: `"schemaVersion": 6`, add `"lastCheckedAt": "2026-09-27"` after `lastVerifiedAt`)
- Modify: `src/lib/hook-remediation/planner.mjs:377-389` (`publicUpstream` carries `lastCheckedAt`)
- Modify: `scripts/upstream-watch/classify.mjs:209` (report `registry.lastCheckedAt`), `scripts/upstream-watch/render.mjs:58` ("last checked …, last verified …")
- Test: `tests/kit/hook-upstream.test.mjs`, `tests/kit/upstream-watch-registry.test.mjs`, `tests/kit/upstream-watch-script.test.mjs`, `tests/kit/hook-audit-hosts.test.mjs:126`
- Docs: `docs/UPSTREAM-WATCH.md` "Re-verifying constraints", `docs/schemas/README.md:16`

**Interfaces:**

- Produces: registry document field `lastCheckedAt: 'YYYY-MM-DD'`; `loadUpstreamRegistry()` / `loadUpstreamConstraints()` results gain `lastCheckedAt: string|null`; `schemaVersion === 6` required. Semantics: `lastCheckedAt` = last state re-read (issue states, npm releases) and the tests' clock; `lastVerifiedAt` = last date **every** constraint's retest (reproduction/conformance) was re-run; a per-constraint retest moves only that constraint's `nextRetestAt`. `registryStale` (the `recheckPolicy.staleAfterDays` rule) keys on `lastCheckedAt`; `retestOverdue` keys on `nextRetestAt` (unchanged).

- [ ] **Step 1: Write the failing tests**

In `tests/kit/hook-upstream.test.mjs` replace the clock and add tests:

```js
// State re-reads move lastCheckedAt (the tests' clock); only a conformance run moves lastVerifiedAt.
const { lastVerifiedAt, lastCheckedAt } = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
const now = () => new Date(`${lastCheckedAt}T12:00:00Z`);
// Evidence is current by definition on the day every constraint was re-verified.
const verifiedNow = () => new Date(`${lastVerifiedAt}T12:00:00Z`);

function withDocument(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-upstream-'));
  try {
    const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    mutate(document);
    const file = path.join(root, 'constraints.json');
    fs.writeFileSync(file, JSON.stringify(document));
    return run(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the registry is schema 6 and records when state was last re-read', () => {
  const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(document.schemaVersion, 6);
  assert.match(document.lastCheckedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(document.lastCheckedAt >= document.lastVerifiedAt);
  assert.equal(loadUpstreamConstraints({ now }).lastCheckedAt, document.lastCheckedAt);
});

test('a state re-read past the retest date is stale evidence, not an invalid registry', () => {
  withDocument((document) => {
    document.lastVerifiedAt = '2026-09-20';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-09-27';
    document.lastCheckedAt = '2026-10-04';
  }, (file) => {
    const result = loadUpstreamConstraints({ file, now: () => new Date('2026-10-04T12:00:00Z') });
    assert.equal(result.registryStatus, 'valid', result.errors.join('\n'));
    assert.equal(result.evidenceStatus, 'stale');
    assert.ok(result.constraints.every((entry) => entry.evidence.status === 'stale'));
  });
});

test('a fresh state re-read keeps the registry from going stale on its own', () => {
  withDocument((document) => {
    document.lastVerifiedAt = '2026-09-01';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-12-31';
    document.lastCheckedAt = '2026-09-27';
  }, (file) => {
    // 26 days after lastVerifiedAt but 0 after lastCheckedAt: the 14-day rule uses lastCheckedAt.
    const result = loadUpstreamConstraints({ file, now: () => new Date('2026-09-27T12:00:00Z') });
    assert.equal(result.evidenceStatus, 'current');
  });
});

test('lastCheckedAt is a date, never in the future and never before lastVerifiedAt', () => {
  for (const [value, message] of [[undefined, /lastCheckedAt must be an ISO date/], ['2099-01-01', /lastCheckedAt cannot be in the future/], ['2026-01-01', /lastCheckedAt precedes lastVerifiedAt/]]) {
    withDocument((document) => { document.lastCheckedAt = value; }, (file) => {
      const result = loadUpstreamConstraints({ file, now });
      assert.equal(result.registryStatus, 'invalid');
      assert.match(result.errors.join('\n'), message);
    });
  }
  withDocument((document) => { document.schemaVersion = 5; }, (file) => {
    assert.match(loadUpstreamConstraints({ file, now }).errors.join('\n'), /unsupported upstream constraint schema/);
  });
});
```

Change the existing "separates valid shape, current evidence…" test to call `loadUpstreamConstraints({ file: registryFile, now: verifiedNow, observedVersions: … })`, and the "future verification dates" test to also set `document.lastCheckedAt = '2099-01-01'`.

In `tests/kit/upstream-watch-registry.test.mjs:16-17` and `tests/kit/upstream-watch-script.test.mjs:21-22`, take the clock from `lastCheckedAt`; in `registryWith()` (`upstream-watch-script.test.mjs:38-43`, the only helper that fabricates a registry object) add `lastCheckedAt: '2026-09-26'` beside `lastVerifiedAt` — otherwise the "nothing left to watch" test gets `idle undefined` once the idle line dates from `lastCheckedAt`; in `withRegistryFile` (`upstream-watch-script.test.mjs:278`) also set `document.lastCheckedAt = '2026-09-26'`. In `tests/kit/hook-audit-hosts.test.mjs:126` read `.lastCheckedAt`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/kit/hook-upstream.test.mjs tests/kit/upstream-watch-registry.test.mjs`
Expected: FAIL — `schemaVersion` is 5, `lastCheckedAt` is undefined (the clock becomes `Invalid Date`).

- [ ] **Step 3: Implement**

`src/lib/hook-audit/upstream.mjs` — in `loadRegistry`:

```js
  if (document?.schemaVersion !== 6) errors.push('unsupported upstream constraint schema');
  // ...existing lastVerifiedAt checks unchanged...
  if (!validDate(document?.lastCheckedAt)) errors.push('lastCheckedAt must be an ISO date');
  else if (Date.parse(`${document.lastCheckedAt}T00:00:00Z`) > asOf.getTime()) errors.push('lastCheckedAt cannot be in the future');
  else if (validDate(document?.lastVerifiedAt) && document.lastCheckedAt < document.lastVerifiedAt) {
    errors.push('lastCheckedAt precedes lastVerifiedAt');
  }
```

Replace the `lastVerified`/`registryStale` block (`:101-104`) so staleness keys on the last re-read:

```js
  const lastChecked = validDate(document?.lastCheckedAt) ? Date.parse(`${document.lastCheckedAt}T00:00:00Z`) : NaN;
  const staleAfterMs = Number(document?.recheckPolicy?.staleAfterDays) * 86_400_000;
  const registryStale = Number.isFinite(lastChecked) && Number.isFinite(staleAfterMs)
    ? asOf.getTime() - lastChecked > staleAfterMs : true;
```

Add `lastCheckedAt: document?.lastCheckedAt ?? null,` to the result beside `lastVerifiedAt`. Keep the per-constraint "nextRetestAt precedes lastVerifiedAt" check (a full re-verification still moves every `nextRetestAt`).

Schema: `"schemaVersion": { "const": 6 }`, add `"lastCheckedAt"` to top-level `required` and `"lastCheckedAt": { "type": "string", "format": "date" }` to `properties`.

Data (in place, top of file only): `"schemaVersion": 6`, `"lastCheckedAt": "2026-09-27"` inserted after `"lastVerifiedAt": "2026-09-27"`. `lastVerifiedAt` is left as recorded (see decisionsNeeded).

`planner.mjs` `publicUpstream`: add `lastCheckedAt: upstream.lastCheckedAt ?? null,` (`docs/schemas/hook-healing-plan.schema.json:28` describes `upstream` as a plain `object`, so that schema needs no change). Then `git grep -n "planDigest\|recomputeHookHealingPlanDigest" tests` and confirm no test pins a literal digest; if one does, recompute it in the same commit and say so in the report.

`classify.mjs` `buildReport`: `registry: { …, lastVerifiedAt: registry.lastVerifiedAt, lastCheckedAt: registry.lastCheckedAt, statuses }`; `render.mjs:58`: `registry ${status}, last checked ${lastCheckedAt}, last verified ${lastVerifiedAt}; …`; the `idle` ledger line (`classify.mjs:255`) dates from `registry.lastCheckedAt`.

Docs — replace `docs/UPSTREAM-WATCH.md` "Re-verifying constraints" with:

```markdown
## Re-checking and re-verifying

- **Re-check (weekly, and before a managed upgrade):** re-read each constraint's issue state on
  GitHub and the released versions on npm. Update `issueState` where it changed and set
  `lastCheckedAt` to the check date. Nothing else moves. The tests take their clock from
  `lastCheckedAt`, so this is a data-only change.
- **Re-verify (after a conformance run):** when a constraint's retest (its reproduction or
  conformance proof) has been run again, move that constraint's `nextRetestAt`. When every
  constraint has been re-run, also set `lastVerifiedAt` to that date. List in the commit body what
  was run and what was not.

A constraint whose `nextRetestAt` has passed shows as stale evidence in the hook audit and under
"Constraints past their retest date"; the registry stays valid.
```

`docs/schemas/README.md:16`: "the upstream registry is schema 6".

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/kit/hook-upstream.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-script.test.mjs tests/kit/hook-audit-hosts.test.mjs tests/kit/hook-remediation*.test.mjs`
Expected: PASS. Then `node scripts/upstream-watch.mjs report | head -3` shows "last checked 2026-09-27, last verified 2026-09-27".

- [ ] **Step 5: Commit**

```bash
git add src/lib/hook-audit/upstream.mjs src/lib/hook-audit/agentic-dependency-constraints.json docs/schemas/agentic-dependency-constraints.schema.json src/lib/hook-remediation/planner.mjs scripts/upstream-watch/classify.mjs scripts/upstream-watch/render.mjs tests/kit/hook-upstream.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-script.test.mjs tests/kit/hook-audit-hosts.test.mjs docs/UPSTREAM-WATCH.md docs/schemas/README.md
git commit -m "feat(upstream): split lastCheckedAt from conformance-verified dates (schema 6)"
```

### Task 2: Fetcher — fixing changes and tag containment

**Files:**

- Modify: `scripts/upstream-watch/fetch.mjs`
- Test: `tests/kit/upstream-watch-script.test.mjs` (fakeExec tests)
- Create: `tests/fixtures/upstream-watch/confirmations.json` (recorded 2026-09-27)

**Interfaces:**

- Produces on the object `createFetcher()` returns:
  - `fixingChanges(id: string): Promise<Array<{ repo: string, pr: number|null, sha: string }>>` — for an issue: its merged closing pull requests whose base is the repository's default branch; if none, the `ClosedEvent` closer commit (or closer PR if merged); for a PR: its own merge commit if merged. Empty array when nothing qualifies.
  - `contains(repo: string, refs: string[], sha: string): Promise<{ ref: string|null, contained: boolean|null }>` — tries each ref (tag name) in order via `gh api repos/<repo>/compare/<ref>...<sha>`; status `behind` or `identical` → `{ ref, contained: true }`; `ahead`/`diverged` → `{ ref, contained: false }`; `404`/"Not Found" for every ref → `{ ref: null, contained: null }`; any other failure **throws** (becomes "Could not check").

- [ ] **Step 1: Record fixtures (read-only)**

```bash
F=tests/fixtures/upstream-watch/confirmations.json
node -e '
const { execFileSync } = require("node:child_process");
const q = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} issueOrPullRequest(number:$number){__typename ... on Issue{closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename ... on Commit{oid} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}}} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}`;
const gh = (a) => JSON.parse(execFileSync("gh", a, { encoding: "utf8" }));
const out = { recordedAt: "2026-09-27", query: q, graphql: {}, compare: {} };
for (const n of [3167, 3194, 3415]) {
  const r = gh(["api","graphql","-f",`query=${q}`,"-F","owner=ruvnet","-F","name=ruflo","-F",`number=${n}`]);
  out.graphql[`ruvnet/ruflo#${n}`] = r;
  const nodes = r.data.repository.issueOrPullRequest.closedByPullRequestsReferences.nodes.filter((x) => x.merged);
  for (const x of nodes) out.compare[`ruvnet/ruflo v3.46.0...${x.mergeCommit.oid}`] = gh(["api",`repos/ruvnet/ruflo/compare/v3.46.0...${x.mergeCommit.oid}`,"--jq","{status:.status,ahead_by:.ahead_by,behind_by:.behind_by}"]);
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n");' > "$F"
```

Expected: three `graphql` records (#3167 with PR #3373 `merged:false` and #3434 `merged:true`) and three `compare` records with `status: "behind"`.

- [ ] **Step 2: Write the failing tests**

```js
const confirmations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'confirmations.json'), 'utf8'));

test('fixingChanges keeps only merged pull requests into the default branch', async () => {
  const { exec, calls } = fakeExec([
    [/^gh api graphql .*number=3167/, { status: 0, stdout: JSON.stringify(confirmations.graphql['ruvnet/ruflo#3167']), stderr: '' }],
  ]);
  const changes = await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3167');
  assert.deepEqual(changes, [{ repo: 'ruvnet/ruflo', pr: 3434, sha: '856249ed7e35e604fa58a3b93179570d7998b9d3' }]);
  assert.ok(calls.every((call) => call.startsWith('gh api graphql')), 'read-only: graphql query only');
});

test('fixingChanges drops an off-branch merge and falls back to the closing commit', async () => {
  const recorded = clone(confirmations.graphql['ruvnet/ruflo#3194']);
  const issue = recorded.data.repository.issueOrPullRequest;
  issue.closedByPullRequestsReferences.nodes[0].baseRefName = 'release/3.x';
  issue.timelineItems.nodes = [{ closer: { __typename: 'Commit', oid: 'abc1234abc1234abc1234abc1234abc1234abc12' } }];
  const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(recorded), stderr: '' }]]);
  assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3194'),
    [{ repo: 'ruvnet/ruflo', pr: null, sha: 'abc1234abc1234abc1234abc1234abc1234abc12' }]);
});

test('contains: behind or identical is contained, a missing tag is unknown, other failures throw', async () => {
  const sha = '856249ed7e35e604fa58a3b93179570d7998b9d3';
  const behind = JSON.stringify(confirmations.compare[`ruvnet/ruflo v3.46.0...${sha}`]);
  const { exec } = fakeExec([
    [/compare\/v3\.46\.0\.\.\./, { status: 0, stdout: behind, stderr: '' }],
    [/compare\/v3\.45\.0\.\.\./, { status: 0, stdout: JSON.stringify({ status: 'ahead', ahead_by: 3, behind_by: 0 }), stderr: '' }],
    [/compare\/(?:3\.46\.0|v9\.9\.9|9\.9\.9)\.\.\./, { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }],
    [/compare\/v7\.7\.7\.\.\./, { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)' }],
  ]);
  const fetcher = createFetcher({ exec });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.46.0', '3.46.0'], sha), { ref: 'v3.46.0', contained: true });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.45.0'], sha), { ref: 'v3.45.0', contained: false });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v9.9.9', '9.9.9'], sha), { ref: null, contained: null });
  await assert.rejects(fetcher.contains('ruvnet/ruflo', ['v7.7.7'], sha), /rate limit/);
  await assert.rejects(fetcher.contains('ruvnet/ruflo', ['v1.0.0'], 'not-a-sha'), /not a commit/);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test --test-name-pattern "fixingChanges|contains:" tests/kit/upstream-watch-script.test.mjs`
Expected: FAIL — `fetcher.fixingChanges is not a function`.

- [ ] **Step 4: Implement in `fetch.mjs`**

```js
const SHA = /^[0-9a-f]{7,40}$/;
const REF = /^[\w.\/-]+$/;
export const FIXING_CHANGES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} issueOrPullRequest(number:$number){__typename ... on Issue{closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename ... on Commit{oid} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}}} ... on PullRequest{number merged baseRefName mergeCommit{oid} repository{nameWithOwner}}}}}`;

// Inside createFetcher's returned object:
    async fixingChanges(id) {
      const [, repo, number] = ID.exec(id) ?? [];
      if (!repo) throw new Error(`not an owner/repo#number id: ${id}`);
      const [owner, name] = repo.split('/');
      const data = (await json('gh', ['api', 'graphql', '-f', `query=${FIXING_CHANGES_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`])).data.repository;
      const branch = data.defaultBranchRef?.name;
      const node = data.issueOrPullRequest;
      const merged = (pr) => pr?.merged && pr.mergeCommit?.oid && pr.baseRefName === branch && pr.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase();
      const asChange = (pr) => ({ repo, pr: pr.number, sha: pr.mergeCommit.oid });
      if (node.__typename === 'PullRequest') return merged(node) ? [asChange(node)] : [];
      const prs = node.closedByPullRequestsReferences.nodes.filter(merged).map(asChange);
      if (prs.length) return prs;
      const closer = node.timelineItems.nodes.at(-1)?.closer;
      if (closer?.__typename === 'Commit') return [{ repo, pr: null, sha: closer.oid }];
      if (closer?.__typename === 'PullRequest' && merged(closer)) return [asChange(closer)];
      return [];
    },
    async contains(repo, refs, sha) {
      if (!SHA.test(sha)) throw new Error(`not a commit: ${sha}`);
      for (const ref of refs) {
        if (!REF.test(ref)) throw new Error(`not a tag name: ${ref}`);
        const result = await exec('gh', ['api', `repos/${repo}/compare/${ref}...${sha}`, '--jq', '{status:.status}']);
        if (result.status !== 0) {
          if (/HTTP 404|Not Found/i.test(result.stderr ?? '')) continue;
          throw new Error(`gh api repos/${repo}/compare/${ref}...${sha} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
        }
        const { status } = JSON.parse(result.stdout);
        return { ref, contained: status === 'behind' || status === 'identical' };
      }
      return { ref: null, contained: null };
    },
```

(Adjust the fixture regexes in the test to match the actual argument order if the query string makes `number=` appear after other args — the test matches on `number=3167`, which appears in the `-F number=3167` argument.)

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/kit/upstream-watch-script.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/upstream-watch/fetch.mjs tests/kit/upstream-watch-script.test.mjs tests/fixtures/upstream-watch/confirmations.json
git commit -m "feat(upstream-watch): read fixing pull requests and tag containment"
```

### Task 3: A release counts only when it contains the merged fixing change

**Files:**

- Modify: `scripts/upstream-watch/classify.mjs` (`GROUPS`, `releaseState`, `liveGroups`, `ledgerEvents`, new export `candidateVersions`, `tagRefs`)
- Modify: `scripts/upstream-watch.mjs` `collect()` (fetch confirmations inside `mapLimit`)
- Modify: `scripts/upstream-watch/render.mjs` (`released-actionable` detail, new `release-unconfirmed` detail)
- Modify: `src/lib/hook-audit/upstream-watch.mjs:57-62` and the schema's release gate (optional `tagPattern`)
- Modify: `.claude/skills/upstream-status/SKILL.md` and `.agents/skills/upstream-status/SKILL.md` (identical)
- Modify: `docs/UPSTREAM-WATCH.md` (groups table, ledger events, lifecycle note)
- Data: `openai/codex` entries' release gates get `"tagPattern": "rust-v{version}"` (only the gates of `openai/codex#…` entries; no other fields)
- Test: `tests/kit/upstream-watch-script.test.mjs`, `tests/kit/upstream-watch-registry.test.mjs`

**Interfaces:**

- Consumes: `fetcher.fixingChanges`, `fetcher.contains` (Task 2).
- Produces:
  - `GROUPS` gains `['release-unconfirmed', 'Released, fix not confirmed']` directly after `released-actionable`.
  - `candidateVersions(fixedAt: string, facts: {versions, latest}, limit = 5): Array<{version, publishedAt}>` — versions published after `fixedAt`, oldest first, stable only unless `latest` is a prerelease, at most `limit`.
  - `tagRefs(gate, version): string[]` — `gate.tagPattern ? [pattern with {version}] : ['v' + version, version]`.
  - `live.confirmation` shape: `{ changes: Array<{repo, pr, sha}>, checks: Array<{ version, ref, contained: true|false|null }> } | null`.
  - `releaseState(entry, fixedAt, facts, confirmation)` returns, when no `minVersion` is recorded, one of:
    - `{ released: true, confirmed: true, version, date, change: {repo, pr, sha}, ref, basis }`
    - `{ released: false, basis }` (every checked version is `contained: false`)
    - `{ released: 'unconfirmed', version, date, basis }` (no fixing change, or no tag to prove it)
  - Ledger `released` line: `UPSTREAM-WATCH <id> released <date> version=<v> pr=<n>|commit=<sha7> branch=upstream/<slug>`; `candidate=` is gone. The recorded-`minVersion` path's line is unchanged.
  - Release gate may carry `tagPattern: string` containing `{version}`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/kit/upstream-watch-script.test.mjs` (and delete the test "without a recorded first fixed version the first release after the fix is only a candidate"):

```js
const rufloFacts = { versions: [
  { version: '3.45.0', publishedAt: '2026-09-24T22:54:53.174Z' },
  { version: '3.46.0', publishedAt: '2026-09-26T22:34:55.241Z' },
  { version: '3.46.1', publishedAt: '2026-09-26T23:27:22.133Z' },
], latest: '3.46.1' };
const closedThread = (id, closedAt) => ({ issue: { number: Number(id.split('#')[1]), state: 'closed', state_reason: 'completed', closed_at: closedAt, created_at: '2026-09-01T00:00:00Z', updated_at: closedAt, user: { login: 'pacphi' } }, comments: [] });
const change = { repo: 'ruvnet/ruflo', pr: 3421, sha: 'e45eeead28855b4f06b4afd184ffb408269ca2f8' };

test('a release is actionable only when it contains the merged fixing pull request', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
  assert.ok(result.groups.includes('released-actionable'));
  assert.equal(result.release.confirmed, true);
  assert.equal(result.release.version, '3.46.0');
  assert.equal(result.release.change.pr, 3421);
  assert.match(result.release.basis, /PR #3421 is in v3\.46\.0/);
});

test('without proof the first release after the fix is unconfirmed, not actionable', () => {
  for (const confirmation of [null, { changes: [], checks: [] }, { changes: [change], checks: [{ version: '3.46.0', ref: null, contained: null }] }]) {
    const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
    assert.deepEqual(result.groups.filter((group) => /^(released|release|fixed)/.test(group)), ['release-unconfirmed'], JSON.stringify(confirmation));
    assert.equal(result.release.version, '3.46.0');
  }
});

test('a fix no checked release contains is fixed but unreleased', () => {
  const confirmation = { changes: [change], checks: [
    { version: '3.46.0', ref: 'v3.46.0', contained: false }, { version: '3.46.1', ref: 'v3.46.1', contained: false },
  ] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
  assert.ok(result.groups.includes('fixed-unreleased'));
  assert.ok(!result.groups.includes('released-actionable'));
});

test('candidateVersions walks releases after the fix, oldest first, bounded', () => {
  assert.deepEqual(candidateVersions('2026-09-26T22:31:23Z', rufloFacts).map((item) => item.version), ['3.46.0', '3.46.1']);
  assert.equal(candidateVersions('2026-01-01T00:00:00Z', rufloFacts, 2).length, 2);
  assert.deepEqual(tagRefs({ channel: 'npm', name: 'ruflo', minVersion: null }, '3.46.0'), ['v3.46.0', '3.46.0']);
  assert.deepEqual(tagRefs({ channel: 'npm', name: '@openai/codex', minVersion: null, tagPattern: 'rust-v{version}' }, '0.153.4'), ['rust-v0.153.4']);
});

test('the released ledger line names the fixing pull request, never "candidate"', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const registry = registryWith([entry('ruvnet/ruflo#3194')]);
  const report = buildReport(registry, new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }]]), { now: NOW });
  const line = ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line;
  assert.equal(line, 'UPSTREAM-WATCH ruvnet/ruflo#3194 released 2026-09-26 version=3.46.0 pr=3421 branch=upstream/ruvnet-ruflo-3194');
});

test('collect confirms through the fetcher with bounded, read-only calls', async () => {
  const calls = [];
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-26T22:31:23Z'),
    release: async () => rufloFacts,
    fixingChanges: async (id) => { calls.push(`changes ${id}`); return [change]; },
    contains: async (repo, refs) => { calls.push(`contains ${refs[0]}`); return { ref: refs[0], contained: refs[0] === 'v3.46.0' }; },
  };
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: NOW });
    const report = JSON.parse(out.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'released-actionable').items.map((item) => item.id), ['ruvnet/ruflo#3194']);
  });
  assert.deepEqual(calls, ['changes ruvnet/ruflo#3194', 'contains v3.46.0'], 'stops at the first containing version');
});
```

Update the tests this changes on purpose, and say so in the commit body:

- "a merged pull request is fixed; reopened…" (`ruvnet/ruflo#2986` PR): pass a `confirmation` containing its merge commit with `contained: true` to keep `released-actionable`, or assert `release-unconfirmed` without one.
- "a fix in a published release …" and the ledger test using `minVersion: '3.13.10'` stay as they are (recorded `minVersion` path unchanged).
- `fixtureFetcher()` gains `fixingChanges: async () => []` and `contains: async () => ({ ref: null, contained: null })`.

In `tests/kit/upstream-watch-registry.test.mjs` add:

```js
test('a release gate may name its tag spelling', () => {
  const errors = errorsOf((doc) => { entry(doc, 'ruvnet/ruflo#3194').doneWhen.release.tagPattern = 'v-no-placeholder'; });
  assert.match(errors, /ruvnet\/ruflo#3194.*tagPattern/);
  const codex = document().watch.filter((item) => item.id.startsWith('openai/codex#') && item.doneWhen.release);
  assert.ok(codex.every((item) => item.doneWhen.release.tagPattern === 'rust-v{version}'));
});
```

The existing skill test ("the skill names every report group") fails until both SKILL.md copies name `"Released, fix not confirmed"`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-skill.test.mjs`
Expected: FAIL — `candidateVersions` not exported, `release-unconfirmed` unknown, released line still has `candidate=yes`.

- [ ] **Step 3: Implement**

`classify.mjs`:

```js
const CONFIRM_LIMIT = 5;

export function candidateVersions(fixedAt, facts, limit = CONFIRM_LIMIT) {
  const prerelease = facts.latest?.includes('-');
  return facts.versions
    .filter((item) => item.publishedAt > fixedAt && (prerelease || !item.version.includes('-')))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(0, limit);
}

export function tagRefs(gate, version) {
  return gate.tagPattern ? [gate.tagPattern.replace('{version}', version)] : [`v${version}`, version];
}

const changeLabel = (change) => (change.pr ? `PR #${change.pr}` : `commit ${change.sha.slice(0, 7)}`);

export function releaseState(entry, fixedAt, facts, confirmation = null) {
  const gate = entry.doneWhen.release;
  if (gate === null) return { released: true, basis: 'no release gate: closing is enough', version: null, date: day(fixedAt) };
  if (!facts) return { released: null, basis: `release facts for ${gate.name} unavailable`, version: null, date: null };
  if (gate.minVersion) { /* unchanged recorded-version branch */ }
  const after = candidateVersions(fixedAt, facts);
  if (!after.length) return { released: false, basis: `no ${gate.name} release since the fix`, version: null, date: null };
  const change = confirmation?.changes?.[0] ?? null;
  const hit = confirmation?.checks?.find((check) => check.contained === true);
  if (change && hit) {
    const published = after.find((item) => item.version === hit.version);
    return { released: true, confirmed: true, version: hit.version, date: day(published?.publishedAt), change, ref: hit.ref, basis: `merged ${changeLabel(change)} is in ${hit.ref}` };
  }
  if (change && confirmation.checks.length === after.length && confirmation.checks.every((check) => check.contained === false)) {
    return { released: false, basis: `none of the first ${after.length} ${gate.name} releases after the fix contains ${changeLabel(change)}`, version: null, date: null };
  }
  return {
    released: 'unconfirmed', version: after[0].version, date: day(after[0].publishedAt),
    basis: change ? `no tag found to prove ${changeLabel(change)} is in ${gate.name} ${after[0].version}` : 'no merged pull request or commit closed the thread; confirm by hand and record minVersion',
  };
}
```

In `liveGroups`: `if (release?.released === true) … else if (release?.released === 'unconfirmed') groups.push('release-unconfirmed'); else if (release?.released === false) …`. In `classifyEntry`: `releaseState(entry, up.fixedAt, live.release, live.confirmation ?? null)`. In `ledgerEvents` released fields: `{ version: entry.release.version, pr: entry.release.change?.pr ?? null, commit: entry.release.change && !entry.release.change.pr ? entry.release.change.sha.slice(0, 7) : null, branch: entry.dispatch.branch }`.

`scripts/upstream-watch.mjs` `collect()`: after the release facts loop, confirm the entries that need it:

```js
  const confirmable = gated.filter((entry) => !entry.doneWhen.release.minVersion && live.get(entry.id).release);
  await mapLimit(confirmable, concurrency, async (entry) => {
    const state = live.get(entry.id);
    try {
      const changes = await fetcher.fixingChanges(entry.id);
      const checks = [];
      if (changes.length) {
        for (const item of candidateVersions(upstreamOf(state.thread).fixedAt, state.release)) {
          const found = await fetcher.contains(changes[0].repo, tagRefs(entry.doneWhen.release, item.version), changes[0].sha);
          checks.push({ version: item.version, ...found });
          if (found.contained !== false) break; // contained, or no tag to prove it
        }
      }
      state.confirmation = { changes, checks };
    } catch (error) {
      state.error = error.message;
      fetchErrors.push({ id: entry.id, error: error.message });
    }
  });
```

(`classifyEntry` already routes `live.error` to "Could not check".) Multiple fixing PRs: confirm against the first; list the rest in the report detail — note it as a known limit in the docs.

`render.mjs`: `released-actionable` first line becomes ``released in ${version} (${date}); ${item.release.basis ?? 'first fixed version recorded in the registry'}``; add:

```js
    case 'release-unconfirmed':
      return [`${item.release.version} (${item.release.date}) is the first release after the fix; ${item.release.basis}`, `change once confirmed: ${item.adjustment}`];
```

`src/lib/hook-audit/upstream-watch.mjs` `checkDoneWhen`: allow `tagPattern` (a string containing `{version}` and matching `^[\w.{}\/-]+$`); error text `${where}: doneWhen.release.tagPattern must contain {version}`. Schema: add `"tagPattern": { "type": "string", "pattern": "^[A-Za-z0-9_./-]*\\{version\\}[A-Za-z0-9_./-]*$" }` to the release object.

Data: for each `openai/codex#…` entry whose `doneWhen.release` is an object, add `"tagPattern": "rust-v{version}"` (script it with `node -e`, write with `JSON.stringify(doc, null, 2) + '\n'`, check `git diff` touches only those lines).

Both SKILL.md copies (identical bytes): in the group order list add `"Released, fix not confirmed"` after "Released and actionable" with the rule "offer to confirm by hand and record `minVersion`; never dispatch it"; replace the "A 'candidate' release…" rule with: "A release is actionable only when it contains the merged fixing pull request or commit (`release.basis` says which). An unconfirmed release is never dispatched."

`docs/UPSTREAM-WATCH.md`: the "Released and actionable" row becomes "Upstream fixed, and a published release contains the merged fixing pull request (or closing commit) — checked with the repository's tag for that version — or the registry records the first fixed version. …"; add row "Released, fix not confirmed | A release came out after the fix, but ak could not prove it contains the fixing change (no merged pull request closed the thread, or no tag for that version). Confirm by hand and record `minVersion`."; ledger events: `released` carries `pr=` or `commit=`; state that only confirmed releases produce a `released` line and so only they are dispatched.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-skill.test.mjs tests/kit/hook-upstream.test.mjs`
Expected: PASS. Then live (read-only): `node scripts/upstream-watch.mjs report --json | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.counts["released-actionable"],r.counts["release-unconfirmed"],r.fetchErrors)'` — expect #3167/#3194/#3415 confirmed (PRs #3434/#3421/#3423 in v3.46.0) unless Branch 3 has already moved them; record the output in the report.

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream-watch/classify.mjs scripts/upstream-watch.mjs scripts/upstream-watch/render.mjs src/lib/hook-audit/upstream-watch.mjs docs/schemas/agentic-dependency-constraints.schema.json src/lib/hook-audit/agentic-dependency-constraints.json .claude/skills/upstream-status/SKILL.md .agents/skills/upstream-status/SKILL.md docs/UPSTREAM-WATCH.md tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs
git commit -m "feat(upstream-watch): confirm releases from the merged fixing change"
```

The #243 ledger has no comments yet, so dropping `candidate=` changes no recorded line (B4-G2: the routine starts after this merges).

### Task 4: AgentDB fixes count only when the newest Ruflo bundles them (B4-Q1)

**Files:**

- Modify: `scripts/upstream-watch/fetch.mjs` (`bundled`), `scripts/upstream-watch/classify.mjs` (`releaseState` bundled rule, `maxVersion`), `scripts/upstream-watch.mjs` (`collect`), `scripts/upstream-watch/render.mjs`
- Modify: `src/lib/hook-audit/upstream-watch.mjs` `checkDoneWhen` and the schema (`bundledBy`)
- Data: `ruvnet/agentdb#26`, `#27`, `#28` release gates only: add `"bundledBy": ["ruflo", "@claude-flow/cli"]`
- Test: `tests/kit/upstream-watch-script.test.mjs`, `tests/kit/upstream-watch-registry.test.mjs`
- Docs: `docs/UPSTREAM-WATCH.md` (`dependency` row; groups note)

**Interfaces:**

- Produces:
  - Release gate may carry `bundledBy: string[]` (minItems 1): the carrier chain from the top package ak installs down to the parent of `release.name`.
  - `fetcher.bundled(chain: string[], name: string): Promise<{ carrier: string, carrierVersion: string, version: string|null, basis: string }>` — `carrierVersion` = `dist-tags.latest` of `chain[0]` (the newest Ruflo, hence the newest inside the support window); walks each manifest's `dependencies` then `optionalDependencies` for the next package's range and resolves it to the highest published version with `npm view <pkg>@<range> version --json`.
  - `maxVersion(values: string|string[]): string|null` exported from `classify.mjs` (uses `compareVersions`).
  - `live.bundle` = the `bundled()` result; `releaseState` with `gate.bundledBy`: fixed version = `gate.minVersion` or the confirmed version; `released: true` only when `compareVersions(bundle.version, fixed) >= 0`; `released: false` with basis `ruflo <v> bundles agentdb <b>, before the fix in <fixed>`; unconfirmed fixed version → `released: 'unconfirmed'` with basis naming what Ruflo bundles.

- [ ] **Step 1: Write the failing tests**

```js
test('bundled resolves the agentdb version the newest Ruflo installs', async () => {
  const manifests = {
    'ruflo@3.46.1': { name: 'ruflo', version: '3.46.1', dependencies: { '@claude-flow/cli': '^3.33.0' } },
    '@claude-flow/cli@3.46.1': { name: '@claude-flow/cli', version: '3.46.1', dependencies: {}, optionalDependencies: { agentdb: '^3.0.0-alpha.17' } },
  };
  const { exec } = fakeExec([
    [/^npm view ruflo version --json$/, { status: 0, stdout: '"3.46.1"', stderr: '' }],
    [/^npm view ruflo@3\.46\.1 --json$/, { status: 0, stdout: JSON.stringify(manifests['ruflo@3.46.1']), stderr: '' }],
    [/^npm view @claude-flow\/cli@\^3\.33\.0 version --json$/, { status: 0, stdout: '["3.45.0","3.46.0","3.46.1"]', stderr: '' }],
    [/^npm view @claude-flow\/cli@3\.46\.1 --json$/, { status: 0, stdout: JSON.stringify(manifests['@claude-flow/cli@3.46.1']), stderr: '' }],
    [/^npm view agentdb@\^3\.0\.0-alpha\.17 version --json$/, { status: 0, stdout: '["3.0.0-alpha.9","3.0.0-alpha.20","3.0.0-alpha.17"]', stderr: '' }],
  ]);
  const result = await createFetcher({ exec }).bundled(['ruflo', '@claude-flow/cli'], 'agentdb');
  assert.deepEqual(result, { carrier: 'ruflo', carrierVersion: '3.46.1', version: '3.0.0-alpha.20', basis: 'ruflo 3.46.1 → @claude-flow/cli 3.46.1 → agentdb 3.0.0-alpha.20' });
});

test('a single npm range match is a bare string; a missing dependency is reported, not thrown', async () => {
  assert.equal(maxVersion('3.0.0-alpha.20'), '3.0.0-alpha.20');
  assert.equal(maxVersion(['3.0.0-alpha.9', '3.0.0-alpha.20']), '3.0.0-alpha.20');
  assert.equal(maxVersion([]), null);
  const { exec } = fakeExec([
    [/^npm view ruflo version --json$/, { status: 0, stdout: '"9.0.0"', stderr: '' }],
    [/^npm view ruflo@9\.0\.0 --json$/, { status: 0, stdout: JSON.stringify({ name: 'ruflo', version: '9.0.0', dependencies: {} }), stderr: '' }],
  ]);
  const result = await createFetcher({ exec }).bundled(['ruflo', '@claude-flow/cli'], 'agentdb');
  assert.equal(result.version, null);
  assert.match(result.basis, /ruflo 9\.0\.0 does not depend on @claude-flow\/cli/);
});

test('an AgentDB fix is released only when the newest Ruflo bundles a fixed agentdb', () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const target = entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } });
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-10-01T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const thread = closedThread('ruvnet/agentdb#26', '2026-09-30T00:00:00Z');
  const behind = classifyEntry(target, { thread, release: agentdb, bundle: { carrier: 'ruflo', carrierVersion: '3.46.1', version: '3.0.0-alpha.20', basis: 'x' } }, context);
  assert.ok(behind.groups.includes('fixed-unreleased'));
  assert.match(behind.release.basis, /ruflo 3\.46\.1 bundles agentdb 3\.0\.0-alpha\.20/);
  const bundled = classifyEntry(target, { thread, release: agentdb, bundle: { carrier: 'ruflo', carrierVersion: '3.47.0', version: '3.0.0-alpha.21', basis: 'x' } }, context);
  assert.ok(bundled.groups.includes('released-actionable'));
  const unknown = classifyEntry(target, { thread, release: agentdb, bundle: null }, context);
  assert.ok(unknown.groups.includes('unchecked'));
});
```

Registry test:

```js
test('AgentDB threads gate on what Ruflo bundles', () => {
  const agentdb = document().watch.filter((item) => item.id.startsWith('ruvnet/agentdb#'));
  assert.equal(agentdb.length, 3);
  for (const item of agentdb) {
    assert.equal(item.dependency, 'ruflo');
    assert.deepEqual(item.doneWhen.release.bundledBy, ['ruflo', '@claude-flow/cli']);
  }
  const errors = errorsOf((doc) => { entry(doc, 'ruvnet/agentdb#26').doneWhen.release.bundledBy = []; });
  assert.match(errors, /ruvnet\/agentdb#26.*bundledBy/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test --test-name-pattern "bundle|AgentDB|bare string" tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs`
Expected: FAIL — `bundled is not a function`, `maxVersion` not exported.

- [ ] **Step 3: Implement**

`classify.mjs`:

```js
export function maxVersion(values) {
  const list = [].concat(values ?? []).filter((value) => typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value));
  return list.sort(compareVersions).at(-1) ?? null;
}
```

In `releaseState`, after computing the fixed version (the `minVersion` branch's `gate.minVersion`, or the confirmed `hit.version`), when `gate.bundledBy`:

```js
function bundledState(gate, fixed, bundle, base) {
  if (!bundle) return { released: null, basis: `could not resolve the ${gate.name} that ${gate.bundledBy[0]} bundles`, version: null, date: null };
  if (!bundle.version || compareVersions(bundle.version, fixed) < 0) {
    return { released: false, basis: `${bundle.carrier} ${bundle.carrierVersion} bundles ${gate.name} ${bundle.version ?? 'none'}, before the fix in ${fixed}`, version: null, date: null };
  }
  return { ...base, version: bundle.carrierVersion, basis: `${base.basis}; ${bundle.carrier} ${bundle.carrierVersion} bundles ${gate.name} ${bundle.version}` };
}
```

and pass `live.bundle` into `releaseState(entry, fixedAt, facts, confirmation, bundle)`. In the released result, `version` is the **Ruflo** version that bundles the fix (the thing ak installs), `fixedVersion` is the agentdb version, and `date` stays the fixed agentdb version's publish date from `facts` (`base.date`), so the ledger line (`released <date> version=<ruflo version> …`) is stable across runs until the Ruflo that bundles it changes.

`fetch.mjs`:

```js
    async bundled(chain, name) {
      for (const pkg of [...chain, name]) if (!/^[@\w][\w@./-]*$/.test(pkg)) throw new Error(`not a package name: ${pkg}`);
      const carrierVersion = await json('npm', ['view', chain[0], 'version', '--json']);
      let [pkg, version] = [chain[0], carrierVersion];
      const trail = [`${pkg} ${version}`];
      for (const next of [...chain.slice(1), name]) {
        const manifest = await json('npm', ['view', `${pkg}@${version}`, '--json']);
        const range = manifest.dependencies?.[next] ?? manifest.optionalDependencies?.[next];
        if (!range) return { carrier: chain[0], carrierVersion, version: null, basis: `${pkg} ${version} does not depend on ${next}` };
        const resolved = maxVersion(await json('npm', ['view', `${next}@${range}`, 'version', '--json']));
        if (!resolved) return { carrier: chain[0], carrierVersion, version: null, basis: `no published ${next} satisfies ${range}` };
        [pkg, version] = [next, resolved];
        trail.push(`${pkg} ${version}`);
      }
      return { carrier: chain[0], carrierVersion, version, basis: trail.join(' → ') };
    },
```

(Import `maxVersion` from `./classify.mjs`, like `releaseFacts`.) Delegating range matching to npm keeps ak free of a semver dependency.

`collect()`: for `gated` entries with `doneWhen.release.bundledBy`, call `fetcher.bundled(gate.bundledBy, gate.name)` once per distinct `bundledBy.join('>')+name` key (inside `mapLimit`), set `live.get(id).bundle`; a failure → `fetchErrors` and `bundle` stays `undefined` → "Could not check".

Validation (`checkDoneWhen`): `bundledBy`, when present, must be a non-empty array of package-name strings; message `${where}: doneWhen.release.bundledBy must list the carrier packages`. Schema: `"bundledBy": { "type": "array", "minItems": 1, "items": { "type": "string", "pattern": "^[@A-Za-z0-9_][A-Za-z0-9_@./-]*$" } }`. Add `fixtureFetcher().bundled = async () => null` for existing tests that never reach it.

Data: add `"bundledBy": ["ruflo", "@claude-flow/cli"]` to the three `ruvnet/agentdb#…` gates only.

Docs: in `docs/UPSTREAM-WATCH.md` the `dependency` row: "AgentDB threads use `ruflo`: ak gets AgentDB through Ruflo, so an AgentDB fix counts as released only when the newest Ruflo (npm `latest`, the newest version in the support window) installs a fixed agentdb (`doneWhen.release.bundledBy`). AgentDB publishes no tags, so a fix is confirmed by hand and recorded as `minVersion` until then."

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs tests/kit/hook-upstream.test.mjs` → PASS. Live (read-only): `node scripts/upstream-watch.mjs report --json` still shows agentdb#26/#27/#28 as waiting (open) and no fetch errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/upstream-watch/fetch.mjs scripts/upstream-watch/classify.mjs scripts/upstream-watch.mjs scripts/upstream-watch/render.mjs src/lib/hook-audit/upstream-watch.mjs docs/schemas/agentic-dependency-constraints.schema.json src/lib/hook-audit/agentic-dependency-constraints.json tests/kit/upstream-watch-script.test.mjs tests/kit/upstream-watch-registry.test.mjs docs/UPSTREAM-WATCH.md
git commit -m "feat(upstream-watch): count AgentDB fixes released only when Ruflo bundles them"
```

**Slice 1 exit:** focused tests pass on Node 26 and `mise exec node@22.22.3 -- node --test tests/kit/upstream-watch-*.test.mjs tests/kit/hook-upstream.test.mjs`; `npx eslint scripts src/lib/hook-audit tests/kit/upstream-watch-*.test.mjs tests/kit/hook-upstream.test.mjs`; `npx eslint src bin --rule 'complexity: [2, 50]'`; `npx tsc -p tsconfig.json`; `npx markdownlint-cli2 docs/UPSTREAM-WATCH.md docs/schemas/README.md .claude/skills/upstream-status/SKILL.md`.

---

## Slice 2 — registry data + guard + docs (implementer 2)

Tasks 5–10, in order, after Slice 1 is committed. Report: main checkout `.superpowers/sdd/2026-09-26-remediation-program/reports/b4-impl-2.md`, which also holds the **draft comments** (heading "Draft comments (not posted)").

Registry edits: load with `JSON.parse`, change only the named entries/fields, write with `JSON.stringify(doc, null, 2) + '\n'`, append new entries at the end of `watch` (keeps the Branch 3 merge to appended hunks). Every live fact (thread state, dates) is read with `gh api` at the time of the edit and quoted in the report.

### Task 5: Record the ledger issue (#243) in `watchPolicy.ledger`

**Files:**

- Modify: `src/lib/hook-audit/upstream-watch.mjs:40-43` (`checkPolicy`), schema `watchPolicy.ledger` (`issue` required, integer ≥ 1)
- Data: `watchPolicy.ledger.issue: 243`
- Docs: `docs/UPSTREAM-WATCH.md` "The ledger" and the routine prompt step 1; `docs/ddd/ubiquitous-language.md:36`
- Test: `tests/kit/upstream-watch-registry.test.mjs`, `tests/kit/upstream-watch-script.test.mjs` (routine-doc test)

**Interfaces:** Produces `registry.watchPolicy.ledger.issue: number`.

- [ ] **Step 1: Failing tests**

```js
test('the ledger is issue #243 in the ledger repository', () => {
  const { ledger } = loadUpstreamRegistry({ now }).watchPolicy;
  assert.deepEqual({ repo: ledger.repo, issue: ledger.issue, issueTitle: ledger.issueTitle }, { repo: 'pacphi/agentic-kit', issue: 243, issueTitle: 'Upstream watch' });
  assert.match(errorsOf((doc) => { doc.watchPolicy.ledger.issue = 0; }), /watchPolicy\.ledger/);
  assert.match(errorsOf((doc) => { delete doc.watchPolicy.ledger.issue; }), /watchPolicy\.ledger/);
});
```

In the routine-doc test (`upstream-watch-script.test.mjs`, last test) add `assert.match(prompt, /pacphi\/agentic-kit#243/, 'the routine reads the recorded ledger issue');`.

- [ ] **Step 2:** `node --test --test-name-pattern "ledger is issue|documented routine" tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-script.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** `checkPolicy`: add `|| !Number.isInteger(ledger.issue) || ledger.issue < 1` to the ledger condition and change its message to `'watchPolicy.ledger must name repo, issue, issueTitle and an upper-case sentinel'`. Schema: add `"issue"` to `required` and `"issue": { "type": "integer", "minimum": 1 }`. Data: `"issue": 243` after `"repo"`. Docs: "The ledger" opens with "The ledger is [pacphi/agentic-kit#243](https://github.com/pacphi/agentic-kit/issues/243), titled "Upstream watch", pinned and locked (`gh issue lock`, so only collaborators can comment); `watchPolicy.ledger.issue` records it."; drop "The maintainer creates, pins and locks it … when creating the daily routine"; routine prompt step 1 becomes "Open the ledger issue pacphi/agentic-kit#243 ("Upstream watch", pinned and locked). Read only the comments written by this routine's own GitHub account or by a login in the registry's watchPolicy.ours; …" (keep the other phrases the test checks). Glossary line 36: "The pinned, locked "Upstream watch" issue (pacphi/agentic-kit#243); …".
- [ ] **Step 4:** re-run → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/hook-audit/upstream-watch.mjs docs/schemas/agentic-dependency-constraints.schema.json src/lib/hook-audit/agentic-dependency-constraints.json docs/UPSTREAM-WATCH.md docs/ddd/ubiquitous-language.md tests/kit/upstream-watch-registry.test.mjs tests/kit/upstream-watch-script.test.mjs` then `git commit -m "feat(upstream-watch): record the ledger issue pacphi/agentic-kit#243"`.

### Task 6: A reviewed thread leaves "Needs our reply" (ruflo#3153)

**Files:**

- Modify: `src/lib/hook-audit/upstream-watch.mjs:8` (`WATCH_HISTORY_EVENTS` gains `'reviewed'`), schema history `event` enum, `scripts/upstream-watch/classify.mjs:6` (`PROCESSED` gains `'reviewed'`)
- Data: `ruvnet/ruflo#3153` history only
- Docs: `docs/UPSTREAM-WATCH.md` ("Needs our reply" rule; `status`, `history` row)
- Test: `tests/kit/upstream-watch-script.test.mjs`, `tests/kit/upstream-watch-registry.test.mjs`

**Interfaces:** Produces history event `reviewed` (`{ date, event: 'reviewed', note }`): "we read every comment up to the end of this date; none needs a reply". It counts like a status change for needs-reply only (not for staleness).

- [ ] **Step 1: Failing tests**

```js
test('a reviewed history line clears the comments before it, not later ones', () => {
  const reviewed = entry('ruvnet/ruflo#3153', { relation: 'commented', history: [
    { date: '2026-09-02', event: 'commented' }, { date: '2026-09-27', event: 'reviewed', note: 'four scope corrections; nothing asked of ak' },
  ] });
  const quiet = classifyEntry(reviewed, live('ruvnet/ruflo#3153'), context);
  assert.ok(!quiet.groups.includes('needs-reply'));
  const thread = clone(threads['ruvnet/ruflo#3153']);
  thread.comments.push({ ...thread.comments.at(-1), id: 1, created_at: '2026-09-28T09:00:00Z', user: { login: 'sparkling', type: 'User' }, body: 'A question for agentic-kit?' });
  assert.ok(classifyEntry(reviewed, { thread }, { ...context, now: new Date('2026-09-29T00:00:00Z') }).groups.includes('needs-reply'));
});
```

Registry test:

```js
test('ruflo#3153 records that its third-party comments were reviewed', () => {
  const history = document().watch.find((item) => item.id === 'ruvnet/ruflo#3153').history;
  assert.ok(history.some((item) => item.event === 'reviewed' && item.date === '2026-09-27' && /sparkling/.test(item.note)));
});
```

- [ ] **Step 2:** run both → FAIL (`history[…].event is unknown` / needs-reply still present).
- [ ] **Step 3: Implement.** Add `'reviewed'` to `WATCH_HISTORY_EVENTS` (after `'registered'`), to the schema enum, and to `PROCESSED`. Data: append to #3153's history `{ "date": "2026-09-27", "event": "reviewed", "note": "four comments by sparkling (2026-09-02 to 2026-09-03): scope corrections and revalidation for upstream; nothing asked of ak" }`. Docs: "Needs our reply" rule gains "… and after the entry's last status change or `reviewed` history line (the maintainer read the thread and nothing needs a reply)".
- [ ] **Step 4:** re-run → PASS; live report shows `needs-reply` 0.
- [ ] **Step 5: Commit** — stage the five files by name; `git commit -m "feat(upstream-watch): let a reviewed thread leave the reply queue"`.

### Task 7: The citation guard covers user-facing docs (B4-Q2)

**Files:**

- Modify: `scripts/upstream-watch/citations.mjs` (export `USER_DOC_EXEMPT`, `userFacingDocs(root)`)
- Modify: `tests/kit/upstream-watch-registry.test.mjs:18-20,135-145` (scan docs; `SYNTHETIC` gains `ruvnet/ruflo#1234`)
- Data: two new dependency policies (`claude-code`, `opencode`); new watch entries appended (list below)
- Docs: `docs/UPSTREAM-WATCH.md` (what `watch` holds; guard sentence), `docs/schemas/README.md:9`

**Interfaces:**

- Produces: `USER_DOC_EXEMPT: Map<string, string>` (path → reason) and `userFacingDocs(root: string): string[]` = `README.md` plus every top-level `docs/*.md` not in `USER_DOC_EXEMPT`. `docs/adr`, `docs/audits`, `docs/superpowers`, `docs/archive`, `docs/research`-style subfolders are never scanned (history). CLI help lives in `src/` and is already scanned.

Exemptions (recommended; flagged): `docs/MODEL-PRICING-AUDIT.md` (dated audit), `docs/METAHARNESS-COMPANION-PROPOSAL.md` (proposal), `docs/USAGE-SCORECARD-METRICS.md` (research reference with a citations appendix).

Threads to register (live states read 2026-09-27; re-read at edit time):

| Thread | Cited in | State | Planned entry |
|---|---|---|---|
| ruvnet/ruflo#2360 | README.md | closed completed | retired |
| ruvnet/ruflo#2356 | HOST-SUPPORT.md | open | watching |
| ruvnet/ruflo#420 | HOST-SUPPORT.md | open | watching |
| ruvnet/ruflo#2638 | HOST-SUPPORT.md | open | watching |
| ruvnet/ruflo#2640 | HOST-SUPPORT.md | open | watching |
| ruvnet/ruflo#2854 | HOST-SUPPORT.md | open | watching |
| ruvnet/ruflo#2887 | HOST-SUPPORT.md | closed completed | retired |
| ruvnet/ruflo#2661 | UPGRADING.md | closed completed | retired |
| proffesor-for-testing/agentic-qe#528, #532, #535 | HOST-SUPPORT.md | open | watching |
| proffesor-for-testing/agentic-qe#615 | HOST-SUPPORT.md | closed completed | retired |
| stuinfla/ruvnet-brain#77, #78, #84 | HOST-SUPPORT.md | closed completed | retired |
| anthropics/claude-code#83643, #83953 | HOST-SUPPORT.md | open | watching (policy `claude-code`) |
| anthropics/claude-code#83675 | HOST-SUPPORT.md | closed not_planned | retired |
| openai/codex#19425, #30408, #13386 | HOST-SUPPORT.md | open | watching (`tagPattern: "rust-v{version}"`) |
| openai/codex#14489 | CODEX-USAGE-DIAGNOSTIC.md (+ exempt USAGE-SCORECARD-METRICS.md) | closed not_planned | retired |
| anomalyco/opencode#38266, #13715, #33223, #40348 | HOST-SUPPORT.md | open | watching (policy `opencode`) |

Not registered: `ruvnet/ruflo#1234` (placeholder in an example command, `docs/AUTHORING-HOST-ADAPTERS.md:419` → `SYNTHETIC`); `openai/codex#18169` and `#23001` (cited only in exempt docs).

Entry template for an open thread (implementer fills `title` from `gh api`, the adjustment from the doc's sentence, one per thread):

```json
{
  "id": "ruvnet/ruflo#420",
  "url": "https://github.com/ruvnet/ruflo/issues/420",
  "relation": "referenced",
  "kind": "issue",
  "title": "Init Wipes Out Other MCPs in .MCP.json",
  "dependency": "ruflo",
  "doneWhen": { "state": "closed-completed", "release": { "channel": "npm", "name": "ruflo", "minVersion": null } },
  "mapping": "mapped",
  "kitImpact": { "refs": [], "files": ["docs/HOST-SUPPORT.md"] },
  "adjustment": "Once a released Ruflo keeps other MCP servers on init, drop the HOST-SUPPORT.md caveat.",
  "status": "watching",
  "constraintIds": [],
  "history": [{ "date": "2026-09-27", "event": "registered" }]
}
```

For a closed thread: `mapping: "mapped"` with `kitImpact: { "refs": [], "files": ["<doc>"] }` (the loader rejects `unmapped` with a non-null adjustment; the retired `openai/codex#20140` is the pattern, and the "still cites" test then guards the doc), `status: "retired"`, `doneWhen.release: null`, `adjustment: "None: closed upstream; cited in <doc> as background."`, history `[{ date: <closed day>, event: "closed", note: <state_reason> }, { date: "2026-09-27", event: "registered" }, { date: "2026-09-27", event: "retired", note: "closed upstream; nothing in ak waits on it" }]`. If the implementer finds the doc still describes a workaround ak carries for a closed thread, register it `mapped`/`watching` instead and say why in the report. If the relation is ours (we filed/commented — check `gh api` for `pacphi` as author/commenter), use `filed`/`commented`.

New dependency policies (recommended text; flagged):

```json
{ "dependency": "claude-code", "owner": "anthropics", "issuePublication": "explicit-user-approval-required",
  "evidenceRequired": ["installed-version", "reproduction", "official-docs-reference"],
  "workaroundPolicy": "document the host limitation and bound agentic-kit-owned configuration; never patch Claude Code installs, plugin caches or remote-session sync",
  "retestPolicy": "on a Claude Code release whose changelog names the thread, or when the thread closes",
  "removalProof": "a released Claude Code reproduces the documented behavior as fixed in a disposable home" }
{ "dependency": "opencode", "owner": "anomalyco", "issuePublication": "explicit-user-approval-required",
  "evidenceRequired": ["installed-version", "reproduction"],
  "workaroundPolicy": "document the host limitation and bound agentic-kit-owned configuration; never patch OpenCode installs",
  "retestPolicy": "on an OpenCode release, or when the thread closes",
  "removalProof": "a released OpenCode reproduces the documented behavior as fixed in a disposable home" }
```

Release gates: claude-code `{ "channel": "npm", "name": "@anthropic-ai/claude-code", "minVersion": null }`; opencode `{ "channel": "npm", "name": "opencode-ai", "minVersion": null }` (verify both package names with `npm view <name> name` before writing).

- [ ] **Step 1: Failing test** — replace the scan in "every watched-repository thread cited in tracked source is registered":

```js
const SYNTHETIC = new Map([
  ['ruvnet/ruflo#9001', ['tests/kit/conformance-tiers.test.mjs']],
  // A placeholder id in an example command, not a real thread.
  ['ruvnet/ruflo#1234', ['docs/AUTHORING-HOST-ADAPTERS.md']],
]);

test('every watched-repository thread cited in tracked source or user-facing docs is registered', () => {
  const dirs = [...CITATION_DIRS, ...userFacingDocs(process.cwd())];
  const citations = new Map([...scanCitations({ root: process.cwd(), dirs })] /* …rest unchanged… */);
  // …unchanged assertions…
});

test('user-facing docs are scanned; history and research are exempt by name', () => {
  const docs = userFacingDocs(process.cwd());
  assert.ok(docs.includes('README.md') && docs.includes('docs/HOST-SUPPORT.md') && docs.includes('docs/UPSTREAM-WATCH.md'));
  for (const [file, reason] of USER_DOC_EXEMPT) {
    assert.ok(!docs.includes(file), file);
    assert.ok(fs.existsSync(file), `${file} no longer exists; drop its exemption`);
    assert.match(reason, /\w/);
  }
  assert.ok(!docs.some((file) => /^docs\/(adr|audits|superpowers|archive)\//.test(file)));
});
```

- [ ] **Step 2:** `node --test tests/kit/upstream-watch-registry.test.mjs` → FAIL listing the 26 threads above (and `userFacingDocs` undefined).
- [ ] **Step 3: Implement** `citations.mjs`:

```js
// User-facing documentation whose upstream citations must be registered too.
// Dated audits, proposals and research references are history, not guidance.
export const USER_DOC_EXEMPT = new Map([
  ['docs/MODEL-PRICING-AUDIT.md', 'dated audit'],
  ['docs/METAHARNESS-COMPANION-PROPOSAL.md', 'proposal'],
  ['docs/USAGE-SCORECARD-METRICS.md', 'research reference'],
]);

/** README.md plus every top-level docs/*.md guide, minus the named exemptions. */
export function userFacingDocs(root) {
  const guides = fs.readdirSync(path.join(root, 'docs'), { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.md'))
    .map((item) => `docs/${item.name}`)
    .filter((file) => !USER_DOC_EXEMPT.has(file));
  return ['README.md', ...guides.sort()];
}
```

Then add the two policies, append the entries (script the append from the table, re-reading each thread with `gh api`), run the guard until it passes. Docs: `docs/UPSTREAM-WATCH.md` "`watch`: every upstream issue or pull request ak filed, commented on, or cites in `src/`, `bin/`, `claude/`, `tests/`, `README.md` or a guide in `docs/` (dated audits, proposals and research references are exempt by name in `scripts/upstream-watch/citations.mjs`), plus …"; the guard sentence names docs too; the opening sentence's dependency list gains Claude Code and OpenCode; `docs/schemas/README.md:9` "checks that source and user-facing doc citations are registered".

- [ ] **Step 4:** `node --test tests/kit/upstream-watch-registry.test.mjs tests/kit/hook-upstream.test.mjs` → PASS; `node scripts/upstream-watch.mjs report` → registry valid, no fetch errors (record counts).
- [ ] **Step 5: Commit** — `git add scripts/upstream-watch/citations.mjs tests/kit/upstream-watch-registry.test.mjs src/lib/hook-audit/agentic-dependency-constraints.json docs/UPSTREAM-WATCH.md docs/schemas/README.md` then `git commit -m "feat(upstream-watch): register every upstream thread user-facing docs cite"`.

### Task 8: Migrate #213's and #240's upstream remainder

**Files:**

- Data: `pacphi/agentic-kit#213`, `pacphi/agentic-kit#240` entries; new entries for threads #213 cites (appended)
- Test: `tests/kit/upstream-watch-registry.test.mjs`
- Report: draft comments for #213 and #240

- [ ] **Step 1: Failing test**

```js
test('the tracking issues carry their whole upstream remainder', () => {
  const doc = document();
  const t213 = entry(doc, 'pacphi/agentic-kit#213');
  assert.deepEqual([...t213.tracks].sort(), ['ruvnet/ruflo#3196', 'ruvnet/ruflo#3446', 'ruvnet/ruflo#3450']);
  assert.ok(t213.history.some((item) => item.event === 'commented' && item.date === '2026-09-27'));
  for (const id of ['ruvnet/ruflo#2786', 'ruvnet/ruflo#3143', 'ruvnet/ruflo#2889', 'ruvnet/ruflo#3195']) assert.ok(entry(doc, id), id);
  const t240 = entry(doc, 'pacphi/agentic-kit#240');
  assert.deepEqual([...t240.tracks].sort(), ['proffesor-for-testing/agentic-qe#574', 'proffesor-for-testing/agentic-qe#719']);
  assert.match(t240.adjustment, /agentic-qe#574/);
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement (data).** Re-read #213's comments (`gh api repos/pacphi/agentic-kit/issues/213/comments`) and the state of ruflo#2786/#3143/#2889/#3195. #213: `tracks` = 3196, 3446, 3450; history append `{ "date": "2026-09-27", "event": "commented", "note": "replied to the Ruflo maintainer and stuinfla: two stores are deliberate (ruvnet/ruflo#2786); 3.41.1 fixed route identity; open remainder is a tested preservation or migration outcome for separate corpora; a read-only route/peek API issue is still to be filed" }`; `adjustment`: "Closes when a released Ruflo gives existing separate corpora a tested preservation or migration outcome (ruvnet/ruflo#3196) and ak's backup, distill and purge gaps (ruvnet/ruflo#3446, #3450) are adopted; the route/peek API request is filed separately."; `kitImpact.refs` add `"B3 investigation: read-only route/peek API"`. Register #2786 (`referenced`; if closed → `retired` with note "deliberate design: AgentDB keeps its own plaintext file for encryption at rest; ak keeps both stores"), #3143, #2889, #3195 (`referenced`, `mapping` per what ak carries — unmapped if nothing; `kitImpact.files` only for files that cite them). #240: `adjustment`: "Close #240 when a released agentic-qe no longer falls through to create after a live RVF lock (agentic-qe#574) and ak removes the temporary busy rule; agentic-qe#719 is merged but unreleased as of 2026-09-27."; `kitImpact.files` add `src/lib/aqe-readiness.mjs` only if that file cites #240 or #574 (the "still cites" test enforces it).
- [ ] **Step 4:** re-run the registry tests → PASS.
- [ ] **Step 5: Draft comments into the report** (not posted; the controller posts after merge):

```markdown
#### Draft: pacphi/agentic-kit#240
The upstream part of this tracker now lives in ak's upstream watch registry
(https://github.com/pacphi/agentic-kit/blob/main/src/lib/hook-audit/agentic-dependency-constraints.json),
which watches proffesor-for-testing/agentic-qe#574 and #719 and reports when a release changes them
(ledger: #243). #719 is merged but not yet released. This issue closes when a released agentic-qe no
longer falls through to create after a live lock and ak removes the temporary busy rule.

#### Draft: pacphi/agentic-kit#213 (optional — the 2026-09-27 reply already says this)
The registry entry is now on main:
https://github.com/pacphi/agentic-kit/blob/main/src/lib/hook-audit/agentic-dependency-constraints.json
(tracks ruvnet/ruflo#3196, #3446 and #3450; ledger: #243).
```

- [ ] **Step 6: Commit** — `git add src/lib/hook-audit/agentic-dependency-constraints.json tests/kit/upstream-watch-registry.test.mjs` then `git commit -m "chore(upstream-watch): migrate the #213 and #240 upstream remainder into the registry"`.

### Task 9: Resolve the three stale threads

**Files:**

- Modify: `src/lib/host-health-connected.mjs:107-108` (comment cites openai/codex#16045)
- Data: `openai/codex#16045`, `openai/codex#16921`, `ruvnet/ruflo#952`
- Test: `tests/kit/upstream-watch-registry.test.mjs`
- Report: draft comments for #16045 and #952; recommendation table

- [ ] **Step 1: Re-check dependence (evidence for the report).** `git grep -n "16045\|16921\|#952\|mcp_servers.*enabled=false\|permissions.deny" -- src bin claude docs README.md`. For #952 ground the Ruflo claim twice: installed code (`$(npm root -g)/ruflo/node_modules/@claude-flow/cli/dist/src/mcp-server.js` — `parseMcpToolSelection`, `filterAdvertisedMcpTools`, the "Execution remains registered internally" comment; quote version and line numbers) and `search_ruvnet` ("ruflo MCP tool filtering CLAUDE_FLOW_MCP_TOOLS mcp start --tools"; cite returned paths, e.g. `ruflo/ruflo/docs/adr/ADR-035-MCP-TOOL-GROUPS.md`). For #16045 run, in a disposable `CODEX_HOME` (`env -u XDG_* CODEX_HOME=$T HOME=$T`), `codex mcp list --json -c 'mcp_servers={}'` against a config with one dummy stdio server and record whether it still lists the server, with `codex --version`.
- [ ] **Step 2: Failing test**

```js
test('stale threads are mapped to what ak carries, or retired with a reason', () => {
  const doc = document();
  const clear = entry(doc, 'openai/codex#16045');
  assert.equal(clear.mapping, 'mapped');
  assert.deepEqual(clear.kitImpact.files, ['src/lib/host-health-connected.mjs']);
  const statusLine = entry(doc, 'openai/codex#16921');
  assert.equal(statusLine.status, 'retired');
  assert.match(statusLine.history.at(-1).note, /openai\/codex#17827/);
  assert.equal(entry(doc, 'openai/codex#17827').status, 'watching');
  assert.match(entry(doc, 'ruvnet/ruflo#952').adjustment, /execution/);
});
```

- [ ] **Step 3:** run → FAIL.
- [ ] **Step 4: Implement.**
  - `host-health-connected.mjs` above line 109, add: `// Codex ignores \`-c mcp_servers={}\` (openai/codex#16045), so each server is disabled by name.`
  - #16045: `mapping: "mapped"`, `kitImpact: { refs: [], files: ["src/lib/host-health-connected.mjs"] }`, `adjustment: "Once Codex clears the roster with -c mcp_servers={}, replace the per-server enabled=false overrides in the connected host check."`, release gate gains `tagPattern` if Task 3 did not already add it. Status stays `watching`; recommendation **ask once**.
  - #16921: history append `{ "date": "2026-09-27", "event": "retired", "note": "the same request is watched through openai/codex#17827 (active); ak's Codex status-line adjustment moves there" }`, `status: "retired"`. Keep the `hosts.mjs` citation (retired entries stay registered). Confirm #17827's `adjustment` matches #16921's; if not, copy it there.
  - #952: `adjustment: "Ruflo's mcp start --tools / CLAUDE_FLOW_MCP_TOOLS (released) narrows only the advertised tool schemas; execution stays registered. Once a released Ruflo also refuses execution of unselected tools, replace the permissions.deny tool-family gating in mcp.mjs; until then consider using --tools to cut schema overhead alongside the deny rules."` Status stays `watching`; recommendation **ask once**.
- [ ] **Step 5:** re-run → PASS.
- [ ] **Step 6: Draft comments into the report** (verify every fact first; not posted):

```markdown
#### Draft: openai/codex#16045
Still seeing this on Codex CLI <version from Step 1>: `-c 'mcp_servers={}'` leaves every configured
server in `codex mcp list --json` (reproduced in a fresh CODEX_HOME with one stdio server). We work
around it by disabling each server by name with `-c mcp_servers.<name>.enabled=false`. Is clearing the
table with an override intended to work, or is per-server disabling the supported way?

#### Draft: ruvnet/ruflo#952
Checking in on this one. In 3.46.1, `mcp start --tools` / `CLAUDE_FLOW_MCP_TOOLS` narrows the advertised
tool catalogue by category or prefix (mcp-server.js `filterAdvertisedMcpTools`), which covers the
context-size part of this request. The comment there says execution stays registered, so an unselected
tool can still be called. Do you consider #952 done with `--tools`, or is enablement that also refuses
execution of unselected groups planned? We gate tool families with Claude Code `permissions.deny` rules
today and would switch to a server-side option if one enforces execution.
```

Recommendation table in the report: #16045 ask once (ak depends: `host-health-connected.mjs:109`); #16921 retire (watched via #17827); #952 ask once (partially shipped; enforcement gap). Note: asking does not clear the stale flag.

- [ ] **Step 7: Commit** — `git add src/lib/host-health-connected.mjs src/lib/hook-audit/agentic-dependency-constraints.json tests/kit/upstream-watch-registry.test.mjs` then `git commit -m "chore(upstream-watch): map, retire or query the three stale threads"`.

### Task 10: Record the Branch 4 decisions and align the docs

**Files:**

- Modify: `docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md` (append a section at the end)
- Modify: `docs/adr/0041-host-neutral-hook-configuration-assurance.md` (header `Updated` line; §7 sentence on dates and confirmation)
- Modify: `docs/UPSTREAM-WATCH.md` ("The daily routine" section: created after this merges; tracking issues migrated)
- Modify: `docs/ddd/ubiquitous-language.md` (terms "Confirmed release", "Reviewed thread")
- Test: `node --test tests/kit/doc-citations.test.mjs tests/kit/upstream-watch-*.test.mjs`, `npx markdownlint-cli2`

- [ ] **Step 1: Failing test** (documentation guard in `tests/kit/upstream-watch-registry.test.mjs`):

```js
test('the audit record carries the Branch 4 decisions in decision format', () => {
  const audit = fs.readFileSync('docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md', 'utf8').replace(/\r\n/g, '\n');
  const start = audit.indexOf('## Branch 4 decisions');
  assert.ok(start > 0);
  const section = audit.slice(start);
  for (const id of ['B4-G1', 'B4-G2', 'B4-Q1', 'B4-Q2', 'B4-Q3']) assert.match(section, new RegExp(`### ${id} `));
  for (const part of ['**The situation.**', '**The problem.**', '**What should be the case.**', '**The choices.**', '**Recommendation', '**Choice']) {
    assert.ok(section.split(part).length - 1 >= 5, part);
  }
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Write.** Append `## Branch 4 decisions (2026-09-27)` with an intro ("Asked at the start of Branch 4 in the decision format of the Decision walkthrough; the maintainer's choices are recorded as given in the program ledger.") and five subsections `### B4-G1 — the ledger issue`, `### B4-G2 — when the daily routine is created`, `### B4-Q1 — AgentDB under the Ruflo policy`, `### B4-Q2 — widening the citation guard`, `### B4-Q3 — checked versus verified dates`, each with **The situation.** / **The problem.** / **What the user sees.** / **What should be the case.** / **The choices.** / **Recommendation: …** / **Choice: …** and the implementing commit hashes. Content:
  - G1: choices create+pin now / create with the routine; choice: created, pinned and locked as pacphi/agentic-kit#243; recorded in `watchPolicy.ledger.issue`.
  - G2: choices create now / after Branch 4 merges; choice: after merge, because until candidate confirmation lands every post-fix release reads as released and the routine would dispatch unconfirmed fixes.
  - Q1: choices separate AgentDB policy / keep under Ruflo gated on what Ruflo bundles; choice: keep under Ruflo; released only when the newest Ruflo in the support window (npm `latest`) installs a fixed agentdb, resolved through npm (`ruflo` → `@claude-flow/cli` → `agentdb`); AgentDB has no tags, so its fixes are confirmed by hand as `minVersion`.
  - Q2: choices source only / all of `docs/` / user-facing docs only; choice: README, `docs/*.md` guides and CLI help (already in `src/`); ADRs, audits, research and plans exempt as history; list the three named exemptions and the 26 threads registered.
  - Q3: choices one date / split; choice: `lastCheckedAt` (state re-read, the tests' clock) separate from `lastVerifiedAt` and `nextRetestAt` (moved only after a conformance run); schema 6, migrated in place with `lastCheckedAt: 2026-09-27` and `lastVerifiedAt` unchanged.
  Then a short "Also settled on Branch 4" list: the new "Released, fix not confirmed" group; the `reviewed` history event (ruflo#3153); the two new dependency policies; the stale-thread outcomes; drafts left for the controller.
  - ADR-0041 header: `- **Updated:** 2026-09-27 — §7: schema 6 separates \`lastCheckedAt\` (state re-read) from \`lastVerifiedAt\`/\`nextRetestAt\` (conformance); a release counts only when it contains the merged fixing change; AgentDB fixes count when Ruflo bundles them` (move the current `Updated` line to `Earlier update`); in §7 add one sentence stating the same rules.
  - `docs/UPSTREAM-WATCH.md` "The daily routine": heading "The daily routine (created after the watch's release confirmation reaches `main`)"; replace "The tracking issues … migrate into the registry once it is live." with "The tracking issues pacphi/agentic-kit#240 and #213 are registry entries (`relation: tracking`) listing the upstream threads they wait on."
  - Glossary: "Confirmed release — a published version whose tag contains the merged pull request or commit that fixed a watched thread; only a confirmed release is dispatched." and "Reviewed thread — a watch entry with a dated `reviewed` history line: its comments up to that day were read and need no reply."
- [ ] **Step 4:** `node --test tests/kit/upstream-watch-registry.test.mjs tests/kit/doc-citations.test.mjs` and `npx markdownlint-cli2 docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md docs/adr/0041-host-neutral-hook-configuration-assurance.md docs/UPSTREAM-WATCH.md docs/ddd/ubiquitous-language.md` → PASS.
- [ ] **Step 5: Commit** — stage the five files by name; `git commit -m "docs(upstream-watch): record Branch 4 decisions and the live watch"`.

**Slice 2 exit:** re-read ADR-0041 and the audit record's Branch 4 section against the code; live `node scripts/upstream-watch.mjs report` (valid, needs-reply 0, stale 2: #16045 and #952); focused tests on Node 22 and 26.

---

## Gate (gate agent, after Slice 2)

Run the common brief's full gate set from the worktree, with the fingerprint before and after, and record counts, coverage and the fingerprint diff verbatim. `npm pack --dry-run 2>&1 | grep agentic-dependency-constraints.json` must list the registry (runtime asset under `src/`). Re-run `node scripts/upstream-watch.mjs report --json` and compare with the Branch 3 tip if it has merged (Review Focus 1). Six-class docs gate: ADR (0041), DDD (glossary), supplemental (`docs/schemas/README.md`), audit (Branch 4 decisions), research (none changed), user-facing (`docs/UPSTREAM-WATCH.md`, both skill copies).

## Commits at a glance

| # | Slice | Subject |
|---|---|---|
| 1 | 1 | `feat(upstream): split lastCheckedAt from conformance-verified dates (schema 6)` |
| 2 | 1 | `feat(upstream-watch): read fixing pull requests and tag containment` |
| 3 | 1 | `feat(upstream-watch): confirm releases from the merged fixing change` |
| 4 | 1 | `feat(upstream-watch): count AgentDB fixes released only when Ruflo bundles them` |
| 5 | 2 | `feat(upstream-watch): record the ledger issue pacphi/agentic-kit#243` |
| 6 | 2 | `feat(upstream-watch): let a reviewed thread leave the reply queue` |
| 7 | 2 | `feat(upstream-watch): register every upstream thread user-facing docs cite` |
| 8 | 2 | `chore(upstream-watch): migrate the #213 and #240 upstream remainder into the registry` |
| 9 | 2 | `chore(upstream-watch): map, retire or query the three stale threads` |
| 10 | 2 | `docs(upstream-watch): record Branch 4 decisions and the live watch` |

## Decisions this plan makes provisionally (flag to the maintainer; not blocking)

1. "Newest Ruflo inside the support window" is read as npm `dist-tags.latest` (the newest version is always inside the window), so B4-Q1 needs no Branch 3 code.
2. A release after the fix that cannot be proven to contain the fixing change goes to a new report group, "Released, fix not confirmed", and is never dispatched (not "released and actionable", not "could not check").
3. Migration keeps `lastVerifiedAt: 2026-09-27` as recorded (it may have been a state re-read, not a conformance run) and sets `lastCheckedAt: 2026-09-27`; `lastVerifiedAt` moves only when every constraint is re-run.
4. Two new dependency policies, `claude-code` and `opencode`, with the text in Task 7, so their doc-cited threads can be registered.
5. Three top-level docs are exempt from the guard: `MODEL-PRICING-AUDIT.md`, `METAHARNESS-COMPANION-PROPOSAL.md`, `USAGE-SCORECARD-METRICS.md`.
6. Stale threads: codex#16045 remapped and "ask once"; codex#16921 retired as watched through #17827 (ak still wants the feature); ruflo#952 "ask once" with a rewritten adjustment. Asking does not clear the stale flag.
7. The second #213 comment is optional because the 2026-09-27 reply already points at the registry.
8. The #3153 acknowledgement is a new `reviewed` history event (not `acknowledged`, which already names automated acknowledgements).
