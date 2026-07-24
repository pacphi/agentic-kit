# ADR-0007 — Maintainer admin: a loopback telemetry page with deliberate egress

- **Status:** Accepted
- **Date:** 2026-07-24
- **Deciders:** agentic-kit maintainers

## Context

`ak dashboard` (ADR-0005, `src/lib/dashboard-server.mjs`) is a read-only, loopback-only,
**offline-first** health panel: a self-contained page that shells `ak status --json` and makes
zero network calls. Its whole contract is "nothing leaves your machine."

Maintainers want a different thing: *how is this project actually doing* — who filed issues, who
forked, release-asset pulls, npm range, GitHub traffic. That data lives on **github.com and
api.npmjs.org**, so answering it requires **network egress** and, for the traffic panels, a GitHub
credential with push access. That is the exact opposite of the dashboard's offline contract, and it
carries a secret. Folding it into the dashboard would either break the offline promise for every
user or bury a privileged, egressing view behind a tab on an otherwise-airgapped panel.

We are adapting a proven design — the RuvNet Brain explainer admin
(`stuinfla/ruvnet-brain` `explainer/{admin.html,admin.js,api/admin-stats.mjs}`, MIT © 2026 Stuart
Kerr / Isovision.ai). The reference is a **hosted** Vercel page gated by a static `ADMIN_TOKEN`; we
are making it **local-first** — a `node:http` sibling of the dashboard, zero runtime deps, bound to
`127.0.0.1`. Spec: `docs/adr/../../sparc/spec-ak-admin.md` (Phase 1); design: `pseudocode-ak-admin.md`
(Phase 2).

## Decision

### 1. A sibling command, not a dashboard tab — split by network-egress contract

`ak x admin` (with a top-level `ak admin` alias, mirroring `dashboard`) is a **separate command and
server**, default port **7432** (dashboard is 7431). The split is drawn along the one line that
matters: **egress**.

- `dashboard` = offline-first. No fetch ever leaves the machine; safe to leave running, safe for the
  privacy-conscious, needs no credential.
- `admin` = deliberate egress. It exists *to* call GitHub and npm, and it touches a credential. That
  is a conscious act the maintainer opts into by name, not a tab they might wander onto.

Both remain **loopback-only** (`127.0.0.1`), both carry the dashboard's DNS-rebinding `Host`-header
guard, both are foreground-until-Ctrl-C. What differs — and what justifies two commands — is that
one promises silence and the other promises reach. Collapsing them would force one contract to lie.

### 2. Auth: per-session random token, URL-fragment bootstrap, header-only transport, fail-closed

The reference trusts a static `ADMIN_TOKEN` from hosting env. A local tool can do better:

- The server **mints a fresh ≥128-bit token** (`crypto.randomBytes(32)`) at every startup. There is
  **no unauthenticated mode** and **no "not configured" path** — the secret always exists because we
  generate it. Comparison is `crypto.timingSafeEqual` behind a **length guard** (unequal length
  returns `false`, never throws — a bare `timingSafeEqual` throws on length mismatch, and that throw
  is itself a length/timing oracle).
- The launch URL carries the token in the **URL fragment** (`#token=…`), not a query parameter. The
  fragment is **never sent to the server**, never written to an access log, never forwarded by a
  proxy or middlebox. The page lifts it into `localStorage`, `history.replaceState`s the fragment
  out of the address bar, and thereafter sends it **only** as the `x-admin-token` request header.
  There is no query-param fallback. A query param would leak the secret into exactly the sinks the
  fragment avoids; that is why fragment beats query param here.
- Wrong or missing token → **401 JSON with no data fields**; the page drops the stored token and
  shows a paste-from-terminal gate with a "Forget token" control.

### 3. Server proxies everything — the credential never reaches the browser

The GitHub credential is resolved **server-side at collect time** from
`GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token` (execFile, best-effort; absent → traffic panels
degrade to `configured:false`, never an error). It is **read at runtime, persisted nowhere by the
kit, and never appears in the `/api/admin-stats` payload or the page** (NFR-3). The **page makes
exactly one network call — a same-origin `fetch('/api/admin-stats')`** — and the server does every
GitHub/npm fetch on its behalf. A strict CSP (`default-src 'none'`; `connect-src 'self'`;
`script-src`/`style-src 'unsafe-inline'` for the two inline module scripts and the one inline style;
`img-src 'none'` since sparklines are inline SVG) makes "no external fetch" a header the browser
enforces, not just a convention, and `Cache-Control: no-store` covers every `/api/*` response.

### 4. Three client correctness rules, inherited verbatim (attribution: stuinfla/ruvnet-brain, MIT)

The reference earned three rules the hard way; we adopt them wholesale and keep the attribution:

1. **Unknown is not zero.** Every metric passes through `metric()`, which rejects `null`/`''`
   *before* `Number()` coercion (both coerce to a finite `0` and would otherwise report a confident
   zero for a merely-absent source) and returns `{known:false, why}`. Absence renders "—" + reason.
2. **Never diff a rolling window.** Cumulative counters (stars, forks, asset downloads) get
   `current − baseline` deltas; rolling windows (GitHub 14-day traffic, npm 7/30-day) are excluded
   from the "since you last looked" strip and get equal-window `momentum()` inside their own series
   instead — subtracting two readings of a rolling window compares two different time spans.
3. **No control without an executor and an undo.** "Mark all reviewed" stashes the prior baseline
   and reveals a real "Undo"; "Forget token", auto-refresh, and feed paging each have their inverse.

### 5. Pure-model module: `src/lib/admin-model.mjs` is both embedded and imported — tested code is shipped code

All number logic (`metric`, `ascend`, `momentum`, `shape`, `snapshot`, `cumDelta`, `safeUrl`,
`esc`, bot/date helpers) lives in **`src/lib/admin-model.mjs`**, which **imports nothing** and
touches no DOM and no Node builtin — pure, browser-safe functions. This one file is:

- **imported directly** by `tests/admin-model.test.cjs` (node), and
- **embedded verbatim** into the served page by `admin-server.mjs`.

So the code the tests exercise *is byte-for-byte the code the browser runs* — no reimplementation, no
"tested logic drifts from shipped logic." The browser controller (DOM/fetch/events) that cannot be
node-imported lives separately in `src/lib/admin-view.mjs`; its single
`import … from './admin-model.mjs'` line is stripped at serve time so model + view concatenate into
one inline `<script type="module">` scope — keeping the page a single self-contained document (no
browser-side module fetch, preserving AC-5) while both files stay independently
`node --check`/eslint-clean.

### 6. Module boundaries and file layout

```text
src/commands/x/admin.mjs     CLI: flags (--port 7432, --no-open), foreground SIGINT loop
src/lib/admin-server.mjs     node:http server, token mint, Host guard, auth, page assembly
src/lib/admin-collect.mjs    server-side Promise.all fan-out → the typed payload (injectable fetchers)
src/lib/admin-model.mjs      PURE model — imports NOTHING; embedded AND node-imported
src/lib/admin-view.mjs       browser controller (embedded; not node-tested)
src/lib/browser.mjs          openInBrowser — EXTRACTED from x/dashboard.mjs, shared by both commands
tests/admin-model.test.cjs   pure-model unit tests (metric/momentum/shape/snapshot/cumDelta)
tests/admin.test.cjs         server tests over real HTTP with injected collect/fetchers (network-free)
```

Dependency direction (acyclic): `admin.mjs → {admin-server, browser}`;
`admin-server → {admin-collect, admin-model(source), admin-view(source)}`;
`admin-collect → admin-model`; `admin-model → ∅`. **`admin-model.mjs` is the sink — it imports
nothing — so no cycle is possible.** `openInBrowser` moves out of `x/dashboard.mjs` into
`src/lib/browser.mjs` (IP-4) and `dashboard.mjs` imports it from there rather than duplicating it.

No new directories are introduced beyond these files.

## Consequences

- The offline-first dashboard contract is preserved intact; the egressing, credential-touching view
  is a deliberate, separately-named opt-in — the two contracts never blur.
- Zero runtime dependencies hold: `node:http`/`crypto`/`child_process`/`fs`/`path`/`url` only, Node
  ≥22 ESM, matching the dashboard.
- The credential's blast radius is minimal: runtime-only, server-side-only, never persisted, never in
  the payload, never in the page; the browser holds only the per-session UI token.
- `admin-model.mjs`'s import-nothing constraint is load-bearing for both the no-cycle guarantee and
  the browser-safety of the embed — a future edit that adds an import to it breaks both and must be
  rejected in review.
- Extracting `openInBrowser` to `src/lib/browser.mjs` is a small refactor of existing dashboard code
  (behaviour-preserving) that both commands now share.
- The honesty section ("Not instrumented yet") makes ak's real gaps first-class: no opt-in telemetry
  (`code`), no traffic token (`config`), comment bodies/sentiment and Discussions unread (`code`),
  remote hosting never (`design`). A dashboard that admits a gap beats one that fills it with a
  plausible number.

## Alternatives considered

- **A tab on `ak dashboard`.** Rejected: it would either break the dashboard's offline-first promise
  for every user or hide a privileged egressing view behind a tab. The contracts differ at the
  network boundary, so the commands should too (Decision 1).
- **Static token via env var (as in the reference).** Rejected for a local tool: a per-session
  random token is simpler (no setup, no "not configured" 503 path) and strictly safer (no long-lived
  shared secret on disk). (Decision 2.)
- **Token in a query parameter.** Rejected: query strings leak into server logs, browser history,
  and proxies — the exact sinks the fragment avoids. (Decision 2.)
- **Page fetches GitHub/npm directly.** Rejected: it would either expose the credential to the
  browser or force an unauthenticated, degraded view, and would violate the "zero external fetch"
  CSP. Server-proxies-everything keeps the secret server-side and the page self-contained. (Decision 3.)
- **One `admin.js` like the reference (no model/view split).** Rejected: NFR-5 requires the number
  logic be node-testable, and DOM code is not node-importable. The two-file split is the minimal way
  to make the tested code the shipped code. (Decision 5.)

## References

- Reference (MIT): `stuinfla/ruvnet-brain` — `explainer/admin.html`, `explainer/admin.js`,
  `explainer/api/admin-stats.mjs`.
- House patterns: `src/lib/dashboard-server.mjs` (loopback server, Host guard, self-contained page,
  injectable collector), `src/commands/x/dashboard.mjs` (`openInBrowser`, option parsing, foreground
  loop), `tests/dashboard.test.cjs` (injected-fetcher harness), `bin/agentic-kit.mjs` (dispatch).
- ADR-0005 (dashboard as read-only offline-first diagnostic); spec `sparc/spec-ak-admin.md`;
  pseudocode `sparc/pseudocode-ak-admin.md`.
