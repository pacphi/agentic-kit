# ADR-0014 — Dashboard auth token, plus a security/quality remediation pass

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** agentic-kit maintainers

## Context

A multi-reviewer brutal-honesty audit (three independent passes — security, code
quality, test quality — see `docs/adr/README.md`'s theme note for the summary) found
one urgent gap and a cluster of correctness/hygiene issues, concentrated in the parts
of the codebase that shipped fastest: the live-sessions dashboard and usage-index work
from the preceding few commits.

**The urgent gap.** `ak dashboard` (ADR-0005) serves `/api/session/:id` — full
transcript text, masked server-side but otherwise unrestricted — behind only a
browser-oriented guard (`requestRejection`: Host + Sec-Fetch-Site + Origin). That guard
stops a hostile *browser tab*; it does nothing against a *non-browser local process* —
an npm postinstall script, an MCP server, any other program that can merely reach
`127.0.0.1:7431`, none of which sends the headers the guard inspects. Meanwhile `ak
admin` (ADR-0007), which serves a strictly less sensitive payload (GitHub stars, npm
download counts), already required a per-session token. The dashboard was the more
sensitive surface with the weaker gate.

## Decision

### 1. The dashboard now requires a per-session token, mirroring admin's contract

Same mechanism as ADR-0007 §2, applied to `dashboard-server.mjs`:

- `crypto.randomBytes(32)` minted fresh at every `ak dashboard` startup, never persisted.
- Every `/api/*` route requires it (`x-dash-token` header, or the token reused from
  admin-server's exported `tokenMatches` — no duplicated constant-time-compare logic).
- The launch URL carries it in the `#` fragment; the client lifts it into
  `localStorage` under `ak-dash-token` and strips the fragment from the address bar,
  identical to admin's bootstrap.
- **One necessary deviation from admin:** `EventSource` cannot set custom request
  headers. The two SSE routes (`/api/live/events`,
  `/api/live/transcripts/:host/:id/events`) additionally accept the token as a `?token=`
  query parameter. This is a narrower exception than a full page navigation — it is a
  same-origin background stream, never enters browser history, and there is no
  third-party `Referer` for it to leak into. Every other route stays header-only, no
  query-param fallback, matching admin's stated rejection of query-param tokens
  (ADR-0007 "Alternatives considered").
- The page itself (`GET /`) is **not** gated — only `/api/*` — because the token gate
  lives client-side (a paste-the-token screen) and needs the shell HTML to render
  before it can prompt.

### 2. A cluster of correctness fixes, landed alongside the token work

Found by the same audit, fixed in the same remediation pass:

- **SSE client-cap TOCTOU + leak on early abort.** The `/api/live/events` and
  `/api/live/transcripts/...` handlers checked their client cap *before* several
  `await`s (a dynamic `import()`, `service.start()`) and only registered the
  reservation *after* — concurrent requests during that window could all observe the
  same pre-registration size and all pass a cap of 1. A client that disconnected mid-
  window leaked its slot permanently (the `req.once('close', ...)` listener attaches
  too late to catch a `close` that already fired). Fixed by reserving the cap slot
  before the first await and re-checking liveness after every await
  (`src/lib/dashboard/sse.mjs`'s `reserveClientSlot`/`clientGone`), with the shared SSE
  transport (backpressure, overflow, heartbeat) extracted into that new module so the
  fix lands once instead of twice.
- **`shell: true` on Windows for provider-configurable commands.** `exec.mjs` shelled
  out `npm`/`npx`/`claude`/`ruflo`/`aqe`/`claude-flow` on Windows to work around `.cmd`
  shims — but `shell: true` hands Node's own cmd+args string-join to `cmd.exe`, and
  `providers.mjs`'s `applyProviders()` feeds `kit.json`-sourced provider/model strings
  into that argv. Fixed by resolving the shim to its real file on `PATH` and running
  with `shell: false` always (Node's own `.cmd`/`.bat` re-invocation, safe since
  18.20.2/20.12.2/21.7.2), plus a defense-in-depth grammar check on provider/model
  strings before they reach the subprocess.
- **Non-atomic `writeJsonWithBackup`.** Truncate-then-write on `~/.claude/settings.json`
  — the file Claude Code reads on every startup — meant an interrupt mid-write (Ctrl-C,
  OOM) could leave it zero-length or partial. Fixed with write-tmp-then-rename
  (`rename(2)` is atomic within a filesystem).
- **`build-check.mjs` silent-pass.** `git ls-files` failing (not a repo, git absent)
  degraded to an empty file list, and the syntax-check step reported `✓` having parsed
  zero files. Fixed: a failed `git ls-files` now throws, and a floor assertion
  (`shipped.length >= 20`) catches a near-empty list even if the call itself "succeeds".
- **Secret-masker gaps.** `usage-index.mjs`'s `SECRET_PATTERNS` caught
  `SCREAMING_CASE=value` env-style assignments but missed quoted-JSON keys
  (`"apiKey": "..."`) and lowercase YAML/TOML assignments (`api_key = ...`) — the two
  most common non-env credential shapes. Two narrow additions (quote-delimited,
  line-anchored) close the gap without reopening the case-sensitivity false-positive
  the original pattern was built to avoid (`"tokens used = 10028979467"` must never
  match).
- **`/api/session/:id` reparsing the whole index per request.** `readCache()` did a
  synchronous `JSON.parse` of the full usage-index JSON (several MB on the module's
  documented reference corpus) on every call; `locate()` linear-scanned it for one id.
  Fixed with an mtime-keyed memo plus a companion id→file `Map`, and the scan's
  carry-forward loop now prunes entries whose last activity exceeds
  `dashboard-server.mjs`'s 365-day query ceiling (`KEEP_MS = 366 days`) — an entry no
  query can ever reach was pure dead weight.
- **`readIndex`'s memo key omitted `force`.** A `readIndex({ force: true })` call
  within the memo's TTL could silently return the stale cached aggregate — the same bug
  class `buildIndex`'s `scanKey()` was written to prevent one layer down. `readIndex`
  now reuses `scanKey()` directly instead of a second hand-rolled key.
- **`ak toString` / `ak __proto__` crashed with a raw stack trace.** The CLI's
  dispatch tables were plain object literals, so `cmd in table` resolved
  `Object.prototype` members as legitimate commands. Both tables are now
  `Object.create(null)`-based.
- **Coverage instrumentation.** `pnpm test` now runs with
  `--experimental-test-coverage` and enforced floors (70% lines/branches/functions on
  the `tests/kit/*.test.mjs` suite) — a zero-dependency Node built-in, no new tooling.
- **Flaky-sleep tests.** ~10 hardcoded `setTimeout` waits in the live-transcript/
  live-service tests (a 35ms sleep against a 10ms tailer interval — 3.5 ticks of
  margin) replaced with condition-polling (`tests/kit/helpers/wait-until.mjs`), except
  two tests that are provably event-driven-incompatible (proving an *absence*, or
  proving an idle-timer fired — polling would itself reset the timer under test); those
  two keep fixed sleeps with generous, documented margins instead of the original tight
  ones.
- **Silent test-count erosion.** The eight hand-rolled `.cjs` test harnesses
  (`tests/*.test.cjs`) could not detect a test block silently vanishing (an early
  return, a mis-scoped brace) — `passed` would shrink, `failed` would stay 0, exit
  code would stay 0. Each now asserts `passed + failed === EXPECTED`, with `EXPECTED`
  bumped deliberately on every add/remove so a deletion is a visible diff.
- **Zero test coverage on the machine-mutating commands.** `setup`/`status`/`sync`/
  `x/verify`/`uninstall` — the code that actually writes into `$HOME` — had no test
  files at all, despite being the highest-blast-radius code in the kit. New coverage
  under `tests/kit/`, sandboxed via `tests/kit/helpers/home-sandbox.mjs` (redirects
  `HOME`/`XDG_CONFIG_HOME`/`USERPROFILE`/`APPDATA` before `paths.mjs` is ever imported,
  so no test can reach the developer's real home directory).
- **`admin-server.mjs`'s DNS-rebinding guard was Host-only.** It reimplemented (inline,
  under a comment claiming parity) only the Host-header layer of
  `dashboard-server.mjs`'s three-layer `requestRejection` guard, missing Sec-Fetch-Site
  and Origin. Not a live bypass (the token check still held), but a defense-in-depth
  regression a future admin route would have silently inherited. Now imports and uses
  the shared `requestRejection` directly.
- **Dashboard had no CSP; JSON routes were inconsistent on `nosniff`.** Admin already
  carried a strict CSP; the dashboard — a larger inline-script surface, and the one
  page that renders attacker-influenced transcript text — had none. Added a matching
  policy, and folded `x-content-type-options: nosniff` into the shared `sendJson()`
  helper so every JSON route carries it, not just the transcript-specific ones.

## Consequences

- `ak dashboard`'s launch flow now mirrors `ak admin`'s exactly: a printed
  `urlWithToken`, a paste-the-token gate on first load, `localStorage` persistence,
  "Forget token" semantics available the same way admin's are.
- Any external tool or script that was polling `/api/status` or `/api/usage` directly
  (bypassing the browser UI) now needs the token too — this is a deliberate breaking
  change for that class of caller, in favor of not serving transcripts to anonymous
  local processes.
- `src/lib/dashboard/sse.mjs` is new and shared by both SSE routes; a future SSE
  endpoint should build on it rather than re-copying the inline pattern this ADR
  removed.
- `src/lib/admin-server.mjs` gained an export dependency from `dashboard-server.mjs`
  (`tokenMatches`) and a dependency *from* `admin-server.mjs` on
  `dashboard/request-security.mjs` (`requestRejection`) — both already-shared,
  already-tested primitives; no new security-relevant code was written twice.
- Coverage thresholds are a floor, not a target — they were set at the suite's
  measured level at merge time (75.84/76.88/75.39%), not an aspirational number that
  would fail CI on day one.

## Alternatives considered

- **Gate the dashboard's SSE routes with header-only auth and drop the query-param
  fallback.** Rejected: `EventSource` genuinely cannot set headers; the alternative
  (hand-rolling a `fetch`-based SSE client) is a materially larger change for the same
  security property, and the query-param exception is scoped narrowly (same-origin
  background stream only, never a navigation).
- **Gate the dashboard's page (`GET /`) behind the token too, closing the page/API
  gap entirely.** Rejected: the token gate is a client-side UI concern (a paste screen
  rendered *by* the page); gating the page itself would need a second, separate
  server-side secret just to see the paste screen, adding complexity without closing
  any real gap — an attacker who can reach `/` but not guess the token still can't read
  `/api/*`.
- **Full pagination for the usage-index cache instead of pruning by age.** Deferred (as
  in ADR-0013): no observed cache currently needs it, and the fix that matters today
  (memoized re-parse + an id index) is the one that removes the *repeated* cost, not
  the *total* size.

## References

- ADR-0005 (dashboard as read-only offline-first diagnostic).
- ADR-0007 (admin's token/fragment/header-only auth contract, which this ADR extends
  to the dashboard).
- ADR-0013 (the prior admin remediation pass — same review lineage, different surface).
- `src/lib/dashboard-server.mjs`, `src/lib/dashboard/sse.mjs`,
  `src/lib/dashboard/client.mjs`, `src/lib/dashboard/live/client.mjs`,
  `src/lib/dashboard/page.mjs`, `src/lib/dashboard/styles.mjs`,
  `src/lib/admin-server.mjs`, `src/lib/exec.mjs`, `src/lib/providers.mjs`,
  `src/lib/settings.mjs`, `src/lib/usage-index.mjs`, `scripts/build-check.mjs`,
  `bin/agentic-kit.mjs`, `package.json` (`test` script), `tests/kit/helpers/`.
