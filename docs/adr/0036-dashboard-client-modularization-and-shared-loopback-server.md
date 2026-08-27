# ADR-0036 — Dashboard client modularization and shared loopback server

- **Status:** Implemented
- **Date:** 2026-08-26
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0005](0005-dashboard-in-page-routing-reveal.md),
  [ADR-0007](0007-maintainer-admin-local-telemetry.md),
  [ADR-0014](0014-dashboard-auth-and-remediation.md)

## Context

A 2026-08 complexity audit of `src/lib/dashboard-server.mjs`, `src/lib/dashboard/client.mjs`,
`src/lib/admin-server.mjs`, and `src/lib/dashboard/styles.mjs` found three unrelated problems that
shared one root cause — large amounts of served-but-never-parsed content:

1. `dashboard-server.mjs`'s `http.createServer` callback was one `async (req, res) => {...}`
   closure spanning ~680 lines (cyclomatic complexity 194): an if-chain of 15 routes, including
   two independent SSE state machines whose reserve-slot/early-close/channel-open lifecycle was
   copy-pasted verbatim three times (`/api/live/events`, `/api/live/intelligence`,
   `/api/live/transcripts/:host/:id/events`).
2. `dashboard/client.mjs` — the dashboard's entire browser-side SPA (5 tabs, a hash router, SSE
   clients, inline SVG charting, ~184 function declarations) — was one exported template-literal
   string (`export const JS` assigned one 4,044-line template literal). `node --check`, ESLint,
   and `tsc` all see a single string; none of them ever looked inside it. The same was true, at
   smaller scale, of
   `dashboard/styles.mjs`'s 1,309-line inline stylesheet.
3. `dashboard-server.mjs` and `admin-server.mjs` each independently defined `readJsonSafe`, minted
   their session token the same way, wrote the same 401/404 response headers, and repeated the
   same `server.listen(...).then(resolve {url, urlWithToken, port, token, close})` boilerplate.
   `dashboard-server.mjs` additionally imported `tokenMatches` — a security primitive — **from**
   `admin-server.mjs`, coupling two independent loopback servers for no architectural reason.

The "served JS/CSS must be one inline `<script>`/`<style>` block, so it must be authored as one
string" premise behind (2) was already false inside this codebase: `admin-server.mjs` has
inlined **real, separately-authored `.mjs` files** into one served page since ADR-0007 —
`admin-model.mjs` and `admin-view.mjs` are ordinary ES modules on disk, read with
`fs.readFileSync`, stripped of the one import line that would otherwise fail to resolve once
concatenated, and joined into a single `<script type="module">`. `eslint.config.mjs` already
carries a browser-globals override for `admin-view.mjs` for exactly this reason.
`dashboard/groups.mjs` proved the complementary technique for *pure* functions: real, node-tested
functions, spliced into the browser bundle via `.toString()` so the tested source and the shipped
source can never drift.

## Decision

### 1. The route table + `sseRoute()` lifecycle contract

`dashboard-server.mjs`'s request handler is now a small dispatcher: an exact-path lookup object
(`ROUTES`) for the ten fixed routes, a short list of `[RegExp, handler]` pairs (`PARAM_ROUTES`) for
the three parametrized ones, and one named `async function handleX(req, res, query[, match])` per
route — each holding exactly the logic that route always had, unchanged.

The three SSE routes' shared reserve-slot/early-close/channel-open scaffolding is factored into
`sseRoute()` in `dashboard/sse.mjs`. Its contract:

- `setup()` does the route's own async prep (open a service, resolve a project, open a transcript
  stream). It either already sent its own error response and returns a falsy value, or returns
  `{ headers, onOverflow, onClose }` — `onClose` is this route's teardown for a client **already**
  gone by the time `setup()` resolves.
- On success, `sseRoute` writes the SSE headers, opens the backpressure channel
  (`sseChannel`), and calls `afterOpen({ channel, write, cleanup, isGone, activate, setOnClose })`
  for the route's own subscribe/replay/snapshot sequencing.
- `activate()` swaps the client-cap reservation for the real per-connection cleanup at
  **whatever point this route originally did that swap** — routes differ here (two do it the
  instant the channel opens; `/api/live/events` defers it until its `subscribe()` call succeeds),
  and preserving each route's own timing was load-bearing for its TOCTOU/race-safety tests.
- `setOnClose(fn)` replaces the teardown `cleanup()`/shutdown will run for the rest of the
  connection's life, mirroring how each original route only assigned its full `realCleanup` once
  subscribe/watch actually succeeded.

`/api/live/events`' own snapshot/replay reconciliation (the densest part of that route, and the
biggest single contributor to its complexity) is further pulled into a pure `deliverLiveInit()`
helper in `dashboard-server.mjs`. Its statement order is itself part of the contract: reading
`postSnapshot.events` can synchronously re-enter the event-subscription callback (a live-service
implementation may publish from a getter), so the pending buffer must not be snapshotted — and
"live" mode must not be entered — until *after* that read, with no `await` in between.

### 2. `loopback-server.mjs`: one home for loopback security primitives

New `src/lib/loopback-server.mjs` owns what both servers repeated: `mintToken()` /
`tokenMatches()` (moved out of `admin-server.mjs`, which now re-exports `tokenMatches` for its own
existing callers), `readJsonSafe()`, the standard response shapes (`sendJson`, `sendUnauthorized`,
`sendNotFound`), and `listenLoopback(server, { port, token, close })` for the
bind-to-`127.0.0.1`-and-resolve-`{url, urlWithToken, port, token, close}` lifecycle. Each server
still supplies its own `close()` — dashboard's also releases SSE clients and background services;
admin's is a bare `server.close()`.

Every loopback security behavior is unchanged: `127.0.0.1` binding, the token-in-`#`-fragment URL
shape, the DNS-rebinding Host guard and Sec-Fetch-Site/Origin enforcement in
`dashboard/request-security.mjs` (shared by both servers already, untouched by this ADR), and each
server's CSP.

### 3. The readFileSync-concat module pattern, generalized

`admin-view.mjs`'s pattern is now the **sanctioned mechanism** for any dashboard-area bundle too
large to review as one string, and both `client.mjs` and `styles.mjs` are rebuilt on it:

- `dashboard/client.mjs` is now a ~90-line **collector**. The former template literal's content
  lives in eleven real, individually lintable and typecheckable browser modules under
  `dashboard/client/` (`bootstrap`, `overview`, `intelligence`, `poll`, `usage`,
  `model-lifecycle`, `usage-orchestrators`, `about`, `system-readout`, `system-projects`, `boot`),
  split along the file's own section-comment boundaries. Each declares real `import`/`export` for
  its actual cross-file dependencies — determined mechanically from ESLint's own `no-undef`
  output against the split files, not hand-traced. `client.mjs` reads each file's source, strips
  the cross-file `import`/`export` lines (never really resolved — nothing loads these files as
  real ES modules; concatenation collapses the graph into one flat scope, exactly as the
  pre-split bundle already was), splices in the same handful of Node-computed values the bundle
  always carried (`groups.mjs`'s functions and tables via `.toString()`, unchanged; the About
  directory via `JSON.stringify`, unchanged) at each file's own declared placeholder, and
  reassembles the exact same single IIFE.
- `dashboard/styles.mjs` is now a small collector over four plain `export const X_CSS` template-
  literal modules under `dashboard/styles/` (`base`, `usage`, `about`, `system`) — pure CSS text, so
  unlike the client split these need no placeholder or import-stripping step at all; they are
  ordinary Node-imported modules, concatenated in their original declaration order.
- `eslint.config.mjs` gains one browser-globals override for `dashboard/client/**/*.mjs`
  (extending the existing `admin-view.mjs` override's pattern), plus two narrow accommodations
  specific to this bundle: `no-var`/`no-redeclare` are off (the bundle is deliberately `var`
  throughout — concatenating several files' `let`/`const` locals of the same name would be a hard
  `SyntaxError` at the flattened scope, where `var`'s redeclare tolerance is safe by design), and
  ~26 names that are genuinely reassigned from more than one file (`usageView`, `SYSTEM`, and
  similar cross-tab state) are declared as shared globals rather than imported — a real ES
  `import` binding is read-only from the importing side, which would make a legitimate
  cross-file reassignment an error.
- Every split browser file carries `// @ts-nocheck` (stripped from the served bundle by the
  collector, so it never ships): these files are never node-imported, so nothing in them should
  be typechecked against `tsc`'s node lib — the same reasoning `tsconfig.json` already applies to
  `admin-view.mjs`, applied here per-file instead of via a shared config change.

**The serving contract is unchanged by any of the above.** `dashboard/page.mjs` still does
`import { JS } from './client.mjs'` and `import { CSS } from './styles.mjs'`, and still embeds
exactly one `<script>${JS}</script>` and one `<style>${CSS}</style>` in one HTML response, under
the same CSP, with no new HTTP routes.

## Consequences

### Positive

- `dashboard-server.mjs`'s request handler drops from one CC-194 closure to a trivial dispatcher
  plus named per-route handlers, each independently under CC 25.
- The SSE reserve-slot/early-close/channel lifecycle exists in exactly one place; a fourth SSE
  route only has to supply `setup`/`afterOpen`, not re-derive the TOCTOU-safe scaffolding.
- `client.mjs` and `styles.mjs` are real, lintable, typecheckable source for the first time —
  ESLint's very first pass over this code found (and this refactor fixed) a handful of pre-existing
  dead locals and unused catch bindings that had been invisible inside the template literal.
- `tokenMatches` and the loopback listen/response boilerplate have one home, independent of either
  server, closing the backwards dependency of dashboard-server on admin-server.
- The readFileSync-concat pattern is now documented as the sanctioned mechanism for future
  dashboard-area growth, rather than something only admin's page happened to do.

### Negative

- The dashboard bundle is now 11 files instead of 1 for the browser client (plus 4 for styles);
  understanding the whole bundle requires opening more files, though each one is now small enough
  to actually read.
- The split files' real `import`/`export` graph is a lint/documentation aid only — it is never
  actually resolved at runtime, which is a source of confusion if not called out (hence the header
  comment convention followed in every split file and in `client.mjs`/`styles.mjs` themselves).
- The shared-mutable-global list in `eslint.config.mjs` is a manually maintained contract: adding a
  new cross-file-reassigned name requires adding it there too, or ESLint will (correctly) flag the
  reassignment as `no-import-assign` once the name is imported instead.

### Verification

Both collectors were checked against a captured snapshot of their pre-refactor resolved output
(`JS`/`CSS`'s actual string value, not the template-literal source): the only differences are
harmless inter-file blank lines and two deliberate `_`-prefixed renames of pre-existing dead
locals that ESLint's first-ever pass surfaced. `dashboard.test.cjs`, `admin.test.cjs`, and the
full Playwright `dashboard-ui` suite (331 cases) pass unmodified.

## References

- `src/lib/dashboard/sse.mjs` (`sseRoute`, `sseChannel`, `reserveClientSlot`, `clientGone`)
- `src/lib/dashboard-server.mjs` (the route table, `deliverLiveInit`)
- `src/lib/loopback-server.mjs`
- `src/lib/admin-server.mjs`, `src/lib/admin-view.mjs`, `src/lib/admin-model.mjs` (the original
  readFileSync-concat precedent)
- `src/lib/dashboard/client.mjs` and `src/lib/dashboard/client/` (the collector and its 11 modules)
- `src/lib/dashboard/styles.mjs` and `src/lib/dashboard/styles/` (the collector and its 4 modules)
- `eslint.config.mjs` (the `dashboard/client/**` override)
- [Dashboard user guide](../DASHBOARD.md)
