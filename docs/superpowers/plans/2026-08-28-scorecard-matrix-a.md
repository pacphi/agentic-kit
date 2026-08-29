# Scorecard Matrix A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "Matrix A" consistent cross-host session metrics — hero deltas + sparklines, cadence/unit-cost KPIs, rhythm & responsiveness (session length + response latency), the How-you-run axes (mode / delegation / observed provider), tool mix, model mix over time, reliability, session chips, Limits pace tick — across parser → aggregate → dashboard UI → `ak usage score` CLI, plus the docs corrections the research surfaced.

**Architecture:** Evidence flows one way: parsers record raw per-session evidence (new fields, bounded histograms), `usage-aggregate` folds it into window buckets (`byMode`, `byInferenceProvider`, rhythm histograms, per-day series, a previous-window pass for deltas), `dashboard-server` exposes it on `/api/usage`, and two consumers render it (dashboard client panels; `ak usage score`). Absent evidence is always `not-recorded` — never inferred. A new pure module `usage-modes.mjs` owns the cross-host mode taxonomy so the judgment calls live in one doc-citable place.

**Tech Stack:** Node ESM (`.mjs`), `node --test` (run via `pnpm test`), no new dependencies, hand-rolled dashboard client (no chart lib).

**Spec:** The two research artifacts — Metric Evidence Matrix (<https://claude.ai/code/artifact/1682c1ea-2bbd-4970-8cdd-2cc5e17efcdf>) and Scorecard Additions mockup (<https://claude.ai/code/artifact/36adf798-625a-4d44-a84b-1dba7093e752>). Everything an executor needs is restated inline below; the artifacts are reference, not required reading.

## Global Constraints

- All work on branch `feat/scorecard-matrix-a`; **unit commits** (one task = one or two commits); conventional-commit subjects (`feat:`, `fix:`, `docs:`, `test:`).
- **Never `git add -A` / `git add .`** — stage named files only (untracked `.ruvector/`, `mise.toml`, and any ruflo-injected `AGENTS.md` drift must never enter a commit).
- **No `Co-Authored-By` trailer** on commits (machine rule).
- ESLint `complexity` warns at 25 — keep every new function under it; keep new files under ~500 lines; prefer a new focused module over growing a 50KB one.
- TDD: the failing test is written and run before the implementation, per task.
- `SCHEMA_VERSION` in `src/lib/usage-index.mjs:92` bumps 10 → 11 exactly once (Task 2). Any task that changes what parsers persist rides that one bump.
- Evidence honesty (ADR-0023 house rule): a missing field renders **not-recorded**; an unmapped raw value maps to `null`, never to a guessed category. No metric is ever labeled "TTFT". OpenCode's observed `costObserved` precedence must not regress.
- Docs are machine-checked: every `file:line` citation added to `docs/USAGE-SCORECARD-METRICS.md` must name an identifier present at that line (`tests/kit/doc-citations.test.mjs`). Docs tasks therefore run **after** code tasks are frozen.
- Full gate before push: `pnpm run check` (typecheck + lint + markdown lint + build + test) green.
- Limits **history sparkline is explicitly deferred** for both hosts (the Claude lane needs a new statusline-tee retention; the Codex lane needs per-day snapshot assembly) — this plan ships only the pace tick, which uses data the limits payload already carries. Record the deferral in ADR-0038.

## File Ownership Lanes (collision rules)

One file has exactly one lane; a lane's tasks run **serially in order**; different lanes may run in parallel only where the wave says so.

| Lane | Files owned | Tasks |
|---|---|---|
| **P** (parsers) | `src/lib/usage-parsers.mjs`, `src/lib/usage-index.mjs`, `src/lib/usage-opencode.mjs`, `src/lib/usage-modes.mjs` (new) | T1–T5 |
| **A** (aggregate/server) | `src/lib/usage-aggregate.mjs`, `src/lib/dashboard-server.mjs` | T6–T7 |
| **UI** | `src/lib/dashboard/client/usage-rhythm.mjs` (new), `src/lib/dashboard/client/usage.mjs`, `src/lib/dashboard/client.mjs`, `src/lib/dashboard/styles/usage.mjs` | T8–T9 |
| **CLI** | `src/commands/usage.mjs`, `tests/kit/usage-cli.test.mjs` | T10 |
| **INS** | `src/lib/usage-insights.mjs`, `tests/kit/usage-insights.test.mjs` | T11 |
| **D** (docs) | `docs/USAGE-SCORECARD-METRICS.md`, `docs/DASHBOARD.md`, `docs/TRANSCRIPTS.md`, `docs/adr/0038-*.md`, `src/lib/pricing.mjs` (comment text only) | T12–T13 |

**Waves:** W1 = T1 ∥ (T2→T3→T4→T4b→T5). W2 = T6→T7 (starts when W1 lands). W3 = T8→T9 ∥ T10 ∥ T11 (starts when T7 lands; T11 only needs T6). W4 = T12 ∥ T13 (starts when W3 lands — line numbers must be final). W5 = QE review → remediation → gate → push → PR (lead session).

---

### Task 1: Mode taxonomy module (`usage-modes.mjs`)

**Files:**

- Create: `src/lib/usage-modes.mjs`
- Test: `tests/kit/usage-modes.test.mjs`

**Interfaces:**

- Produces: `MODES = ['guarded','auto-edit','plan','unrestricted']`; `normalizeMode({ host, permissionMode, approvalPolicy, sandboxPolicy, opencodeMode }) → { mode: string|null, raw: string|null }`. `mode` is `null` whenever evidence is absent **or unrecognized** (never guessed); `raw` preserves the exact wire value(s) for the Sessions detail strip.

The full mapping table (pinned by tests; recorded in ADR-0038):

| Host evidence | → mode |
|---|---|
| CC `permissionMode`: `default` | guarded |
| CC `acceptEdits`, `auto`, `dontAsk` | auto-edit |
| CC `plan` | plan |
| CC `bypassPermissions` | unrestricted |
| CX `sandbox_policy` read-only (any approval) | plan |
| CX `approval_policy` `on-request`/`on-failure`/`untrusted` (writable sandbox) | guarded |
| CX `approval_policy` `never` + `workspace-write` | auto-edit |
| CX `approval_policy` `never` + `danger-full-access` | unrestricted |
| OC `mode` `plan` | plan |
| OC `mode` `build` | auto-edit |
| anything else | `null` (not recorded) |

- [ ] **Step 1: Write the failing test**

```js
// tests/kit/usage-modes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, normalizeMode } from '../../src/lib/usage-modes.mjs';

test('MODES is the closed four-value taxonomy', () => {
  assert.deepEqual(MODES, ['guarded', 'auto-edit', 'plan', 'unrestricted']);
});

test('claude permissionMode maps per table', () => {
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'default' }).mode, 'guarded');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'acceptEdits' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'auto' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'plan' }).mode, 'plan');
  assert.equal(normalizeMode({ host: 'claude', permissionMode: 'bypassPermissions' }).mode, 'unrestricted');
});

test('codex approval x sandbox maps per table, read-only sandbox wins as plan', () => {
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'danger-full-access' }).mode, 'unrestricted');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'workspace-write' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'on-request', sandboxPolicy: 'workspace-write' }).mode, 'guarded');
  assert.equal(normalizeMode({ host: 'codex', approvalPolicy: 'never', sandboxPolicy: 'read-only' }).mode, 'plan');
});

test('opencode mode maps build/plan', () => {
  assert.equal(normalizeMode({ host: 'opencode', opencodeMode: 'build' }).mode, 'auto-edit');
  assert.equal(normalizeMode({ host: 'opencode', opencodeMode: 'plan' }).mode, 'plan');
});

test('absent or unrecognized evidence is null, raw preserved, never guessed', () => {
  assert.equal(normalizeMode({ host: 'claude' }).mode, null);
  const odd = normalizeMode({ host: 'claude', permissionMode: 'superSafe9000' });
  assert.equal(odd.mode, null);
  assert.equal(odd.raw, 'superSafe9000');
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**: `node --test tests/kit/usage-modes.test.mjs`
- [ ] **Step 3: Implement `src/lib/usage-modes.mjs`**

```js
// usage-modes.mjs — the cross-host permission-posture taxonomy (ADR-0038).
// One closed vocabulary; every mapping is a recorded judgment call pinned by
// tests. An unmapped raw value is null (not recorded), NEVER a guess.
export const MODES = ['guarded', 'auto-edit', 'plan', 'unrestricted'];

const CC = { default: 'guarded', acceptEdits: 'auto-edit', auto: 'auto-edit', dontAsk: 'auto-edit', plan: 'plan', bypassPermissions: 'unrestricted' };
const OC = { build: 'auto-edit', plan: 'plan' };

function codexMode(approval, sandbox) {
  if (sandbox === 'read-only') return 'plan';
  if (approval === 'never' && sandbox === 'danger-full-access') return 'unrestricted';
  if (approval === 'never' && sandbox === 'workspace-write') return 'auto-edit';
  if (['on-request', 'on-failure', 'untrusted'].includes(approval)) return 'guarded';
  return null;
}

export function normalizeMode({ host, permissionMode, approvalPolicy, sandboxPolicy, opencodeMode } = {}) {
  if (host === 'claude' && typeof permissionMode === 'string') {
    return { mode: CC[permissionMode] ?? null, raw: permissionMode };
  }
  if (host === 'codex' && (approvalPolicy || sandboxPolicy)) {
    const raw = [approvalPolicy, sandboxPolicy].filter(Boolean).join('/');
    return { mode: codexMode(approvalPolicy, sandboxPolicy), raw };
  }
  if (host === 'opencode' && typeof opencodeMode === 'string') {
    return { mode: OC[opencodeMode] ?? null, raw: opencodeMode };
  }
  return { mode: null, raw: null };
}
```

- [ ] **Step 4: Run test — expect PASS**: `node --test tests/kit/usage-modes.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-modes.mjs tests/kit/usage-modes.test.mjs && git commit -m "feat(usage): cross-host mode taxonomy module"`

---

### Task 2: Session record v11 — shape, histogram helpers, schema bump

**Files:**

- Modify: `src/lib/usage-parsers.mjs` (blankSession ~line 180; add helpers near `noteSpan`)
- Modify: `src/lib/usage-index.mjs:92` (`SCHEMA_VERSION` 10 → 11)
- Test: `tests/kit/usage-index.test.mjs` (append)

**Interfaces (produces — every later task relies on these exact names):**

```js
// blankSession() gains, all serialization-safe defaults:
mode: null, modeRaw: null,          // from usage-modes.normalizeMode
latHist: null,                      // number[6] counts | null — response latency
latCount: 0,                        // total latency samples
lenSeconds: 0,                      // engaged seconds for THIS session (set at finish from active intervals)
ctxWindow: null,                    // model context window (tokens) when host states it
ctxLastTokens: null,                // last turn's input+cacheRead estimate
aborts: 0                           // explicit user-aborted turns (codex)
// exported constants + helpers:
export const LAT_BUCKET_EDGES = [2, 5, 10, 30, 60];        // seconds; 6th bucket = >60
export const LEN_BUCKET_EDGES = [300, 900, 2700, 7200];    // seconds; 5th bucket = >2h
export function noteLatencySample(rec, seconds) // increments latHist bucket + latCount
export function bucketIndex(edges, v)           // shared: first i with v <= edges[i], else edges.length
```

- [ ] **Step 1: Failing test** (append to `tests/kit/usage-index.test.mjs`):

```js
test('noteLatencySample buckets on the shared edges', () => {
  const rec = blankSession('s1', 'claude');
  noteLatencySample(rec, 1.2);   // bucket 0 (<2s)
  noteLatencySample(rec, 8.4);   // bucket 2 (5-10s)
  noteLatencySample(rec, 700);   // bucket 5 (>60s)
  assert.deepEqual(rec.latHist, [1, 0, 1, 0, 0, 1]);
  assert.equal(rec.latCount, 3);
});

test('blankSession v11 fields default honest-absent', () => {
  const rec = blankSession('s1', 'codex');
  assert.equal(rec.mode, null);
  assert.equal(rec.ctxWindow, null);
  assert.equal(rec.aborts, 0);
});
```

- [ ] **Step 2: Run — FAIL** (`noteLatencySample` not exported): `node --test tests/kit/usage-index.test.mjs`
- [ ] **Step 3: Implement** — extend `blankSession` with the fields above; add:

```js
export const LAT_BUCKET_EDGES = [2, 5, 10, 30, 60];
export const LEN_BUCKET_EDGES = [300, 900, 2700, 7200];
export function bucketIndex(edges, v) {
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i;
  return edges.length;
}
export function noteLatencySample(rec, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  rec.latHist ??= new Array(LAT_BUCKET_EDGES.length + 1).fill(0);
  rec.latHist[bucketIndex(LAT_BUCKET_EDGES, seconds)]++;
  rec.latCount++;
}
```

In the record-finishing function (the one that derives `active` from `stamps`, `usage-parsers.mjs:220` area), set `rec.lenSeconds = Math.round(rec.active.reduce((n, [a, b]) => n + (b - a), 0) / 1000)`. Mirror the same `lenSeconds` line in `usage-opencode.mjs` `parseSession` where it computes `rec.active`. Bump `SCHEMA_VERSION` to 11.

- [ ] **Step 4: Run — PASS**, then full parser suites: `node --test tests/kit/usage-index.test.mjs tests/kit/usage-opencode.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-parsers.mjs src/lib/usage-index.mjs src/lib/usage-opencode.mjs tests/kit/usage-index.test.mjs && git commit -m "feat(usage): session record v11 — latency/length/mode/ctx fields, schema 11"`

---

### Task 3: parseClaude — mode, latency, context pressure

**Files:**

- Modify: `src/lib/usage-parsers.mjs` (`parseClaude`, ~lines 376–401 entry loop; assistant handling ~328–368)
- Test: `tests/kit/usage-index.test.mjs`

**Interfaces:**

- Consumes: T1 `normalizeMode`, T2 helpers.
- Produces: Claude sessions carry `mode`/`modeRaw` (last human-turn `permissionMode` seen wins), `latHist`/`latCount` (gap human-prompt → next assistant entry), `ctxLastTokens` (last assistant turn's `input + cacheRead`).

Measurement rules (restated from the spec): a latency sample is taken **only** for entries that pass the existing `isHumanPrompt` filter; the sample is the gap to the **first** assistant-role entry that follows it (skip `isApiErrorMessage` placeholders — a dropped request is an exception, not a latency); cap samples at 3600s (a gap longer than an hour is an idle resume, not a response). `permissionMode` is read off human user entries only.

- [ ] **Step 1: Failing test** — extend the existing parseClaude fixture in `tests/kit/usage-index.test.mjs` (the fixture with 3 user / 2 assistant turns around line 330) with timestamps 10s apart and `permissionMode: 'acceptEdits'` on a user entry:

```js
test('parseClaude derives latency, mode, ctx from entries', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: T0, permissionMode: 'acceptEdits', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', timestamp: plusSec(T0, 8), message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 50 }, content: [] } }),
  ].join('\n');
  const rec = parseClaude('sess-lat', lines);
  assert.equal(rec.mode, 'auto-edit');
  assert.equal(rec.modeRaw, 'acceptEdits');
  assert.equal(rec.latCount, 1);
  assert.equal(rec.latHist[2], 1);            // 8s → 5-10s bucket
  assert.equal(rec.ctxLastTokens, 151000);    // input + cacheRead of last turn
});
```

(Reuse the file's existing fixture helpers for timestamps; if none exist, `const T0 = '2026-08-20T10:00:00.000Z'` and `plusSec` built with `new Date(Date.parse(t) + s * 1000).toISOString()`.)

- [ ] **Step 2: Run — FAIL**: `node --test tests/kit/usage-index.test.mjs`
- [ ] **Step 3: Implement** inside `parseClaude`'s entry loop: track `pendingPromptMs` (set when a human prompt is recorded; cleared when consumed); on each non-error assistant entry, if `pendingPromptMs` is set, `noteLatencySample(rec, (ms - pendingPromptMs) / 1000)` when ≤ 3600, then clear. Read `e.permissionMode` on human user entries → `const m = normalizeMode({ host: 'claude', permissionMode: e.permissionMode }); if (m.raw) { rec.mode = m.mode; rec.modeRaw = m.raw; }`. On each assistant entry with usage, set `rec.ctxLastTokens = tokens(u.input_tokens) + tokens(u.cache_read_input_tokens)` (overwrites; last turn wins).
- [ ] **Step 4: Run — PASS**, plus the whole file: `node --test tests/kit/usage-index.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-parsers.mjs tests/kit/usage-index.test.mjs && git commit -m "feat(usage): parseClaude records mode, response latency, context pressure"`

---

### Task 4: parseCodex — approval mode, host-measured timing, aborts/errors, ctx window, typed-item tools

**Files:**

- Modify: `src/lib/usage-parsers.mjs` (`parseCodex` ~578–681; `turn_context` handling ~431–437; `event_msg` dispatch)
- Test: `tests/kit/usage-index-v6.test.mjs` (append — this file owns Codex-detail coverage)

**Interfaces:**

- Consumes: T1, T2.
- Produces: Codex sessions carry `mode`/`modeRaw` (from `turn_context.approval_policy` + `sandbox_policy`, last wins), `latHist` (from `task_started.started_at` → first agent message, else `task_complete.duration_ms` as the whole-turn fallback sample), `aborts` (count of `turn_aborted`), `exceptions` += `task_complete` events whose `error` is non-null, `ctxWindow` (from `task_started.model_context_window`, last wins), and `rec.tools` counts from `item_completed` items, keyed by the item's own type name — `CommandExecution`, `McpToolCall`, `FileChange`, `CollabAgentToolCall`. Tool names are host vocabularies: never rename Codex activity to Claude tool names; the UI ranks names as-is.

- [ ] **Step 1: Failing test** (append to `tests/kit/usage-index-v6.test.mjs`, following its existing rollout-fixture style):

```js
test('parseCodex v11: mode, duration, aborts, ctx window, typed tools', () => {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx1', cwd: '/tmp/p', thread_source: 'user' }, timestamp: T0 }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6', approval_policy: 'never', sandbox_policy: 'workspace-write' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', started_at: T0, model_context_window: 272000, turn_id: 't1' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' }, timestamp: T0 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' }, timestamp: plusSec(T0, 6) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } }, timestamp: plusSec(T0, 7) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: 9000, error: null, turn_id: 't1' }, timestamp: plusSec(T0, 9) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'user_interrupt', turn_id: 't2' }, timestamp: plusSec(T0, 20) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } } }, timestamp: plusSec(T0, 21) }),
  ].join('\n');
  const rec = parseCodex('cx1', lines);
  assert.equal(rec.mode, 'auto-edit');
  assert.equal(rec.modeRaw, 'never/workspace-write');
  assert.equal(rec.latCount, 1);
  assert.equal(rec.latHist[2], 1);           // 6s prompt→agent gap
  assert.equal(rec.aborts, 1);
  assert.equal(rec.ctxWindow, 272000);
  assert.equal(rec.tools.CommandExecution, 1);
});
```

- [ ] **Step 2: Run — FAIL**: `node --test tests/kit/usage-index-v6.test.mjs`
- [ ] **Step 3: Implement** in `parseCodex`: extend the `turn_context` branch to call `normalizeMode({ host: 'codex', approvalPolicy: p.approval_policy, sandboxPolicy: p.sandbox_policy })`; add `event_msg` cases: `task_started` (record `model_context_window` when finite; remember `started_at`), `task_complete` (if no prompt-gap sample was taken this turn and `duration_ms` finite, `noteLatencySample(rec, duration_ms / 1000)`; `if (p.error != null) rec.exceptions++`), `turn_aborted` (`rec.aborts++`), and in the `item_completed` handler count `item.type` into `rec.tools` for the four types listed above. Prompt-gap latency reuses the same `pendingPromptMs` pattern as Task 3 (set on `user_message`/`UserMessage`, consumed by the first `agent_message`/`AgentMessage`). Keep the existing subagent exclusion untouched (`threadSource === 'subagent'` still skips usage — mode/latency fields may still record; they are excluded at aggregate time with the rest of the session).
- [ ] **Step 4: Run — PASS**, plus regression: `node --test tests/kit/usage-index-v6.test.mjs tests/kit/usage-index.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-parsers.mjs tests/kit/usage-index-v6.test.mjs && git commit -m "feat(usage): parseCodex mode, host-measured timing, aborts, ctx window, typed tool items"`

---

### Task 4b: OpenCode — mode/agent, latency, error, ctx derivation input

**Files:**

- Modify: `src/lib/usage-opencode.mjs` (`processMessageRow` / `recordAssistantMessage`, lines ~194–213)
- Test: `tests/kit/usage-opencode.test.mjs` (append, using its existing in-memory sqlite fixture helpers)

**Interfaces:**

- Consumes: T1, T2.
- Produces: OpenCode sessions carry `mode`/`modeRaw` (from message `data.mode`, last wins), `latHist` (user message → next assistant message gap), `exceptions` (messages with a non-null `data.error`), `ctxLastTokens` (last assistant `tokens.input + tokens.cache.read`).

- [ ] **Step 1: Failing test** — extend the existing fixture db with one user message at `t`, one assistant at `t+4s` carrying `{ mode: 'build', tokens: { input: 900, cache: { read: 20000 }, output: 10 } }`, and one assistant with `error: { name: 'ProviderAuthError' }`:

```js
assert.equal(session.mode, 'auto-edit');
assert.equal(session.modeRaw, 'build');
assert.equal(session.latHist[1], 1);        // 4s → 2-5s bucket
assert.equal(session.exceptions, 1);
assert.equal(session.ctxLastTokens, 20900);
```

- [ ] **Step 2: Run — FAIL**: `node --test tests/kit/usage-opencode.test.mjs`
- [ ] **Step 3: Implement** — in `processMessageRow` track `pendingPromptMs` on user rows; in `recordAssistantMessage` sample the gap, apply `normalizeMode({ host: 'opencode', opencodeMode: data.mode })`, `if (data.error != null) rec.exceptions++`, set `rec.ctxLastTokens`.
- [ ] **Step 4: Run — PASS**: `node --test tests/kit/usage-opencode.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-opencode.mjs tests/kit/usage-opencode.test.mjs && git commit -m "feat(usage): opencode mode, latency, errors, ctx input"`

---

### Task 5: Index carry-through + 2× lookback for deltas

**Files:**

- Modify: `src/lib/usage-index.mjs` (`buildIndex` ~402; the cached-entry projection)
- Test: `tests/kit/usage-index.test.mjs`

**Interfaces:**

- Produces: cached session entries round-trip the v11 fields (they ride the same record object — verify the cache projection does not strip unknown fields; if it whitelists, extend the whitelist). `buildIndex({ days, lookbackDays })`: when `lookbackDays` (default `days * 2`) is passed by the server, sessions are parsed back to the longer cutoff so a previous-window aggregate has data. Aggregation windows stay governed by `aggregate`'s own `cutoff`.

- [ ] **Step 1: Failing test** — round-trip: build an index over a fixture root twice (second run hits cache) and assert `mode`/`latHist` survive the cached read; assert `buildIndex({ days: 7, lookbackDays: 14 })` includes a session 10 days old.
- [ ] **Step 2: Run — FAIL**, **Step 3: implement**, **Step 4: PASS** (`node --test tests/kit/usage-index.test.mjs`)
- [ ] **Step 5: Commit**: `git add src/lib/usage-index.mjs tests/kit/usage-index.test.mjs && git commit -m "feat(usage): index round-trips v11 fields, optional 2x lookback"`

---

### Task 6: Aggregate — buckets, histograms, percentiles, per-day engaged, previous window

**Files:**

- Modify: `src/lib/usage-aggregate.mjs` (`aggregate` ~400, `buildSessionRows` ~304, totals block ~346)
- Test: `tests/kit/usage-index.test.mjs` (aggregate suites live here)

**Interfaces:**

- Consumes: v11 session fields (T2–T5), `MODES` (T1).
- Produces on the aggregate result:

```js
byMode:              { [mode|'not-recorded']: bucket }     // same bucket shape as byHost (addTo)
byInferenceProvider: { [provider|'not-recorded']: bucket } // key = s.inferenceProvider only when providerProvenance === 'observed'
bySource:            { main: bucket, subagent: bucket }    // subagent = s.sidechain || s.threadSource === 'subagent'
byTool:              { [toolName]: number }                // Σ s.tools maps (raw names; UI caps top 8 + Other)
rhythm: {
  latHist: number[6], latCount, latP50, latP95,            // seconds|null when latCount === 0
  lenHist: number[5], lenMedianSeconds, lenP90Seconds,     // from per-session lenSeconds
}
totals: { ...existing, aborts, humanPromptsPerHour, responsesPerPrompt, costPerSessionMedian, costPerEngagedHour, cacheSavedUsd }
                                                            // cacheSavedUsd = Σ over usage rows of 0.9 × cacheRead × rate_in(day) — tested against a hand-worked row
byDay[day].engagedSeconds                                   // per-local-day union of active intervals
byDay[day].byMode                                           // { [mode|'not-recorded']: cost } for the stacked mode-by-day chart
byDay[day].byModelFamily                                    // { [family]: cost } via modelFamily(id)
previous: null | { totals, rhythm }                         // when opts.previous === true: same aggregation over [cutoff - windowMs, cutoff)
export function percentileFromBuckets(counts, edges, q)     // linear interpolation inside the bucket; null when empty
export function modelFamily(id)                             // 'claude-opus-5-20260115' → 'opus'; 'gpt-5.6-sol' → 'gpt-5'; unknown → 'other' — pinned by test
```

- [ ] **Step 1: Failing tests** (three focused tests):

```js
test('percentileFromBuckets interpolates and handles empty', () => {
  assert.equal(percentileFromBuckets([0, 0, 0, 0, 0, 0], LAT_BUCKET_EDGES, 0.5), null);
  // 10 samples all in 5-10s bucket → p50 sits mid-bucket
  const p = percentileFromBuckets([0, 0, 10, 0, 0, 0], LAT_BUCKET_EDGES, 0.5);
  assert.ok(p > 5 && p <= 10);
});

test('byMode and byInferenceProvider bucket honestly', () => {
  // three fixture sessions: mode 'auto-edit' observed openai; mode null; provenance 'unknown'
  const a = aggregate(records, { days: 14, now, cutoff, deps });
  assert.ok(a.byMode['auto-edit'].sessions === 1);
  assert.ok(a.byMode['not-recorded'].sessions === 2);
  assert.ok(a.byInferenceProvider['openai'].sessions === 1);
  assert.ok(a.byInferenceProvider['not-recorded'].sessions === 2);
});

test('previous window aggregates the prior equal span only', () => {
  const a = aggregate(records, { days: 7, now, cutoff, deps, previous: true });
  assert.ok(a.previous.totals.sessions === /* fixture sessions aged 7-14d */ 2);
});
```

- [ ] **Step 2: Run — FAIL**: `node --test tests/kit/usage-index.test.mjs`
- [ ] **Step 3: Implement** — `buildSessionRows` gains an optional `endMs` (exclusive upper bound: `if (endMs && rec.end >= endMs) continue`); the main pass folds `s.mode ?? 'not-recorded'`, the provenance-gated provider key, and `bySource` (main vs subagent) with the existing `addTo`, and sums `s.tools` into `byTool`; merge `latHist` arrays; build `lenHist` from `LEN_BUCKET_EDGES`/`bucketIndex` over `s.lenSeconds`; medians via `percentileFromBuckets` (length/latency) and exact median over the per-session cost array (`costPerSessionMedian` — sort once); `cacheSavedUsd` accumulates `0.9 × cacheRead × rate_in(day)` inside the existing priced-row loop; `byDay.engagedSeconds` by splitting each active interval at local midnight (reuse `localDay`) and unioning per day with `mergeIntervals`; `byDay[*].byMode` and `byDay[*].byModelFamily` (via the new `modelFamily(id)` helper, pinned by its own test cases from the interface block) accumulate cost inside the same byDay loop; `previous` runs the same fold over `[cutoff - days*86400e3, cutoff)` records with a totals+rhythm-only projection. Keep every new helper under complexity 25 (small pure functions).
- [ ] **Step 4: Run — PASS** + whole suite: `pnpm test`
- [ ] **Step 5: Commit**: `git add src/lib/usage-aggregate.mjs tests/kit/usage-index.test.mjs && git commit -m "feat(usage): byMode/byInferenceProvider buckets, rhythm histograms, per-day engaged, previous window"`

---

### Task 7: `/api/usage` payload

**Files:**

- Modify: `src/lib/dashboard-server.mjs` (the `/api/usage` route handler — locate `aggregate(` call)
- Test: `tests/kit/dashboard-usage-telemetry.test.mjs` (append)

**Interfaces:**

- Produces: the JSON payload adds `previous`, `rhythm`, `byMode`, `byInferenceProvider`, and `byDay[*].engagedSeconds`, passing `previous: true` and `lookbackDays: days * 2` down. Nothing existing is renamed; `byProvider` (legacy host identity) is untouched.

- [ ] **Step 1: Failing test** — extend the existing payload test to assert `payload.rhythm.latHist.length === 6`, `payload.byMode` has only keys from `[...MODES, 'not-recorded']`, and `payload.previous.totals` exists when two windows of fixture data are present.
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS**: `node --test tests/kit/dashboard-usage-telemetry.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/dashboard-server.mjs tests/kit/dashboard-usage-telemetry.test.mjs && git commit -m "feat(dashboard): usage payload carries rhythm, mode, provider, previous window"`

---

### Task 8: Client render module `usage-rhythm.mjs` + styles

**Files:**

- Create: `src/lib/dashboard/client/usage-rhythm.mjs`
- Modify: `src/lib/dashboard/styles/usage.mjs` (append component CSS)
- Test: `tests/kit/dashboard-usage-telemetry.test.mjs` (string-shape smoke tests — these modules are pure string builders)

**Interfaces (exact exported names; T9 wires them):**

```js
export function deltaChip(curr, prev, { downIsGood = false, neutral = false, unit = '' }) → string  // '' when prev absent
export function sparklineSvg(series /* number[] */, { w = 130, h = 24 }) → string                    // '' when < 2 points
export function histogram({ counts, labels, markers /* [{atPct, label}] */ }) → string
export function stackedDays({ days /* [{day, parts: {key: value}}] */, order, palette }) → string
export function donut2({ aLabel, aValue, bLabel, bValue, centerLabel }) → string
export function rankedRows(rows /* [{label, value, share, dim}] */) → string
```

Mark rules (from the mockup): bars 4px top radius; 2px gaps between stacked segments; direct labels; `not-recorded`/Other always the de-emphasis token (`--dim`-equivalent in usage styles), never a series color; sparkline = de-emphasis stroke + accent endpoint dot; every chart carries text labels (no color-alone identity).

- [ ] **Step 1: Failing smoke test** — import the module in the node test, assert `deltaChip(584, 540, {})` contains `▲` and `8%`, `deltaChip(5, null, {})` is `''`, `sparklineSvg([1,2,3])` contains `<svg` and `polyline`, `donut2` output contains both labels.
- [ ] **Step 2: FAIL** → **Step 3: implement** (pure template-string builders; escape all interpolated text with the client's existing `esc` helper pattern — copy it locally, no DOM access) → **Step 4: PASS**.
- [ ] **Step 5: Commit**: `git add src/lib/dashboard/client/usage-rhythm.mjs src/lib/dashboard/styles/usage.mjs tests/kit/dashboard-usage-telemetry.test.mjs && git commit -m "feat(dashboard): rhythm/mode chart primitives for the usage client"`

---

### Task 9: Wire the panels — hero deltas, new rows/panels, session chips, limits pace tick

**Files:**

- Modify: `src/lib/dashboard/client/usage.mjs` (hero `kpi(...)` call sites; panel sequence noted at ~line 338), `src/lib/dashboard/client.mjs` (`renderLimits`/`limRow`), `src/lib/dashboard/client/bootstrap.mjs` only if the new module needs registration (follow how `usage-orchestrators.mjs` is included)

**Interfaces:** Consumes T7 payload fields + T8 renderers, exactly as named above.

Deliverables, all per the mockup (artifact 36adf798…):

1. Hero tiles: append `deltaChip` (cost + cache: `downIsGood`/up-good pt; tokens: `neutral: true`) and `sparklineSvg` over `byDay` series (cost/day, sessions/day, tokens/day, engagedSeconds/day, cache-share/day). Cache tile subtitle renders `saved ≈ $N vs uncached` from `totals.cacheSavedUsd` (T6).
2. Second KPI row: sessions/active-day + streak, autonomy (`responses/prompts`) + touch rate, cost/session median + P90, cost/engaged-hour — all from `totals`.
3. Rhythm panel: two `histogram(...)` blocks with median/P90 and p50/p95 markers; the latency card's tooltip carries the measurement note ("codex host-measured · claude/opencode derived from event gaps — not streaming TTFT").
4. How-you-run panel: `stackedDays` over `byDay[*].byMode` cost (T6), `donut2` over `bySource` main-vs-subagent cost (T6), `rankedRows` for byInferenceProvider with `not-recorded` as `dim: true`.
5. Tool mix panel: `rankedRows` top 8 + Other from T6's `byTool`.
6. Model mix over time: `stackedDays` over `byDay[*].byModelFamily` (T6's `modelFamily` fold).
7. Reliability strip: error rate `exceptions/responses × 1000` + per-day exceptions line, icon + label on the spike.
8. Sessions rows: chips for `lenSeconds` (fmt), per-session `p50` (from `latHist`), mode badge (`modeRaw` in tooltip), ctx % (`ctxLastTokens/ctxWindow` when both present; `ctxWindow` null → derive against the bundled published window only if the model record exposes it — otherwise omit the chip; never guess).
9. Limits: pace tick at the window's elapsed share on each `limRow` meter (data already present in the limits payload).

- [ ] **Step 1:** Implement in the order above, one commit per numbered deliverable group (1–2, 3–4, 5–7, 8, 9): subjects `feat(dashboard): hero deltas + cadence row`, `feat(dashboard): rhythm and how-you-run panels`, `feat(dashboard): tool/model mix and reliability`, `feat(dashboard): session row chips`, `feat(dashboard): limits pace tick`.
- [ ] **Step 2: Verify each group**: `pnpm test`, then `pnpm run check`; then launch `ak dashboard --no-open`, fetch the page + `/api/usage` with the printed token, and screenshot with headless Chrome in **both** themes (the repo memory: headless Chrome follows OS theme; force with `--force-dark-mode` and default). Attach screenshots to the PR later.
- [ ] **Step 3:** Any client function crossing complexity 25 gets split before commit (the 2026-08 audit's pattern: extract per-panel builders).

---

### Task 10: CLI — `ak usage score`

**Files:**

- Modify: `src/commands/usage.mjs` (add `score` subcommand; update `help` text — keep `status`/`refresh` untouched)
- Test: `tests/kit/usage-cli.test.mjs` (append)

**Interfaces:**

- Consumes: `buildIndex` + `aggregate` (same modules the dashboard uses — no new computation in the command).
- Produces: `ak usage score [--window 7|14|30] [--json]` printing: hero five (+deltas), cadence four, rhythm medians/percentiles, mode/provider tables with `not-recorded` rows, reliability rate. `--json` emits the aggregate projection verbatim (totals, rhythm, byMode, byInferenceProvider, previous) — additive, credential-free, offline.

- [ ] **Step 1: Failing test** — follow the file's existing command-invocation pattern; over a fixture root assert the text output contains `AUTONOMY` and a `not-recorded` row, and `--json` parses with `rhythm.latHist.length === 6`.
- [ ] **Step 2: FAIL** → **Step 3: implement** (rendering only: reuse `heading/info/dim` from `../lib/output.mjs`; window flag validated to {7,14,30}) → **Step 4: PASS**: `node --test tests/kit/usage-cli.test.mjs`
- [ ] **Step 5: Commit**: `git add src/commands/usage.mjs tests/kit/usage-cli.test.mjs && git commit -m "feat(cli): ak usage score — offline scorecard summary with matrix-a metrics"`

---

### Task 11: Findings detectors

**Files:**

- Modify: `src/lib/usage-insights.mjs` (two detectors + registry entries at ~584)
- Test: `tests/kit/usage-insights.test.mjs` (append)

**Interfaces:**

- Produces: `detectLatencyRegression({ sessions })` → id `latency-regression`, kind `trend`, severity `warn` when the second half-window's bucket-merged p50 exceeds the first half's by ≥25% **and** ≥2s absolute (both halves need ≥30 samples; otherwise no finding). `detectUnrestrictedMode({ sessions, windowCost })` → id `unrestricted-mode`, kind `coach`, severity `info` listing count + cost of sessions with `mode === 'unrestricted'` (zero sessions → no finding; `not-recorded` never counts).

- [ ] **Step 1: Failing tests** — fixture sessions with latHists split across halves (30+ samples each; p50 8s → 12s ⇒ finding fires; 8s → 9s ⇒ no finding) and one `unrestricted` session ⇒ finding with `sessions: 1`.
- [ ] **Step 2: FAIL** → **Step 3: implement** (follow the file's detector shape exactly — same `{ id, kind, severity, title, body, evidence }` contract as `detectSubagentShare`) → **Step 4: PASS**: `node --test tests/kit/usage-insights.test.mjs`
- [ ] **Step 5: Commit**: `git add src/lib/usage-insights.mjs tests/kit/usage-insights.test.mjs && git commit -m "feat(usage): latency-regression and unrestricted-mode findings"`

---

### Task 12: Metrics doc — new sections + the stale-claim corrections

**Files:**

- Modify: `docs/USAGE-SCORECARD-METRICS.md`; `src/lib/pricing.mjs` (comment text only, `UNMODELLED_PRICING_FACTORS` block ~131–150)
- Test: `tests/kit/doc-citations.test.mjs` (existing — must stay green; it machine-checks every `file:line` citation)

Deliverables:

1. New sections §15–§19 following the house entry shape (**Displayed as / Formula / Source / Worked example / What this does not model**) for: Rhythm & responsiveness (both histograms, the percentile-from-buckets method, the per-host measurement difference, the explicit "never labeled TTFT" rule); How you run (the full mode-mapping table from Task 1, `not-recorded` semantics, provider provenance gate); Cadence & unit economics (autonomy, touch rate, medians — and why median, with the heavy-tail worked example); Reliability (error-turn sources per host, aborts); Deltas & sparklines (previous-window definition, 2× lookback).
2. **§13.3 correction**: run a one-off census (scratchpad script, not committed) counting non-null `service_tier` / `inference_geo` / `speed` values across the local corpus; replace the "a transcript does not record which endpoint/tier" rationale with the truth: *recorded per turn since ~CLI version X, observed on N% of turns in the verification corpus; deliberately still unpriced pending semantics verification* — and update the matching `pricing.mjs` comment wording. Pricing **behavior** does not change.
3. **§8 clarification**: one paragraph distinguishing `byProvider` (legacy host identity, unchanged) from the new `byInferenceProvider` (observed-only, `not-recorded` first-class).
4. Every citation added uses final line numbers from the frozen code (this is why Wave 4 waits).

- [ ] Steps: draft → `node --test tests/kit/doc-citations.test.mjs` → fix citations → `pnpm run check` (markdown lint) → commit: `git add docs/USAGE-SCORECARD-METRICS.md src/lib/pricing.mjs && git commit -m "docs(usage): matrix-a metric sections; correct stale 13.3 tier/geo claim"`

---

### Task 13: DASHBOARD.md, TRANSCRIPTS.md, ADR-0038

**Files:**

- Modify: `docs/DASHBOARD.md` (Usage section: new panels, chips, pace tick — current-state voice only, no history); `docs/TRANSCRIPTS.md` (§1.1/§1.2 parser-read tables gain the new fields; §1.3 capability matrix rows for latency/mode/ctx)
- Create: `docs/adr/0038-consistent-cross-host-session-metrics.md` (status Accepted; records: the mode taxonomy judgment table and why unmapped → not-recorded; bucket-histogram percentiles over raw samples; response-latency semantics and the no-TTFT rule; `byInferenceProvider` provenance gate; schema v11; deferral of Claude tee history retention; links both research artifacts)
- Modify: `docs/adr/README.md` (index line, following its existing format)

- [ ] Steps: write all three → `pnpm run check` → commit: `git add docs/DASHBOARD.md docs/TRANSCRIPTS.md docs/adr/0038-consistent-cross-host-session-metrics.md docs/adr/README.md && git commit -m "docs: dashboard/transcripts updates + ADR-0038 matrix-a metrics"`

---

### Task 14 (Wave 5): Brutal-honesty QE review + remediation

Run by the lead session, not a lane agent:

- [ ] Invoke the `brutal-honesty-review` skill against `git diff main...feat/scorecard-matrix-a` with reviewers instructed to hunt: fabricated/guessed evidence anywhere `not-recorded` should appear; percentile arithmetic errors; double-counting (the codex cumulative-snapshot and subagent-replay traps); cache-key staleness (SCHEMA_VERSION); complexity-25 breaches; UI theme/a11y regressions (labels present, no color-alone identity, both themes).
- [ ] In parallel, dispatch `qe-code-reviewer` and `qe-security-reviewer` agents over the same diff; if the AQE MCP is used, `fleet_init` first per machine rules; otherwise native agents suffice.
- [ ] Optionally run `aqe quality-gate` for the two-gate verdict.
- [ ] Triage findings into: fix-now (remediation commits, `fix:` subjects, same lanes/files rule) / rejected-with-reason (recorded in the PR body). Re-run the review only on remediated areas.

### Task 15 (Wave 5): Gate, push, PR

- [ ] `pnpm run check` — must be fully green.
- [ ] Dashboard screenshots (light + dark) captured for the PR.
- [ ] `git push -u origin feat/scorecard-matrix-a`
- [ ] `gh pr create` — title `feat(usage): Matrix A consistent cross-host session metrics`; body: summary table of shipped metrics (name → where), the two docs corrections called out explicitly, ADR-0038 link, both artifact links, screenshots, QE review summary (findings found/fixed/rejected), and the standard generated-with footer.

---

## Execution Orchestration (swarm mapping)

Per the machine's ruflo/superpowers house rules: superpowers choreographs (this plan + subagent-driven-development), agents execute, agentic-qe gates. The RuvNet Brain MCP was disconnected when this plan was written, so ruflo usage below follows the machine CLAUDE.md reference rather than freshly-grounded source; if `ruflo memory store` misbehaves, check the `CLAUDE_FLOW_DB_PATH` pin first (known machine issue).

- **Dispatch:** one named agent per lane wave (`coder-parsers`, `coder-aggregate`, `coder-ui`, `coder-cli`, `coder-insights`, `doc-writer`), spawned in a single message with `run_in_background: true`, each prompt = the task text verbatim + Global Constraints + its lane's file-ownership rule. Reviewer gate between waves (subagent-driven-development's two-stage review).
- **Collision law:** an agent may modify only its lane's files. Cross-lane needs (e.g. UI discovers a missing aggregate field) are messaged to the lead, who queues a follow-up commit in the owning lane — never edited cross-lane.
- **State:** at each wave boundary the lead stores a checkpoint (`ruflo memory store -k scorecard-matrix-a/wave-N --value "<commits + open issues>" -n patterns`) so a compaction or crash never loses orchestration state.
- **Worktree note:** lanes share one branch with disjoint files, so a single checkout is sufficient; if parallel agents contend on the working tree, fall back to `superpowers:using-git-worktrees` per lane and merge lane branches into `feat/scorecard-matrix-a` in wave order.
