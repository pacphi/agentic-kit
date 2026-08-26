# ADR-0029 — External host adapters: declarative manifest, subprocess hooks (experimental contract)

- **Status:** Accepted (experimental contract)
- **Date:** 2026-08-15
- **Updated:** 2026-08-26
- **Update note:** [ADR-0031](0031-capability-graduation-and-upstream-requests.md) amends this ADR's
  "permanent caps" framing. The block on *self-declaring* `canBePrimary` / `aqeProvider` /
  `commandStatusline` in the manifest is permanent (the safety invariant here), but the *capability*
  is earnable through a conformance tier plus a maintainer grant recorded outside the manifest — up
  to promotion to a first-party built-in. The schema, admission gate, consent model, and hook runner
  now also pin declared hook-file bytes as described in §6. **2026-08-26:** Agentic-QE 3.13.12
  satisfied [#628](https://github.com/proffesor-for-testing/agentic-qe/issues/628) with
  `externalProviders`. The manifest may now carry non-authoritative `aqe.provider` candidate data;
  the `host.legacy.aqeProvider` self-claim remains forbidden, while a passed `aqe-provider` tier and
  explicit hash-pinned grant activate the projection. The production bridge copies verified
  command/relative-import bytes into a private per-call snapshot and rechecks host intent, consent,
  and the exact-hash grant immediately before spawn. This is byte pinning, not an OS sandbox;
  absolute file access by consented hook code remains outside the snapshot boundary.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md) (closed-registry clause
  superseded — see [Supersession](#supersession-of-adr-0016s-closed-registry-clause)),
  [ADR-0017](0017-opencode-host.md), [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0019](0019-escalation-in-ak-run.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0028](0028-local-openai-compatible-providers.md)

Proposed by [@adrianco](https://github.com/adrianco) in
[PR #131](https://github.com/pacphi/agentic-kit/pull/131), as an in-process ESM module — one
manifest export, dynamically `import()`-ed from a package path named in `kit.json`, validated by
the same validators as a built-in host. **Accepted with a different mechanism**, recorded below,
after maintainer review found that shape's in-tree gate list materially incomplete and its
underlying safety premise unmet.

## Context

[ADR-0016](0016-capability-driven-integration-adapters.md) deliberately built a **closed** registry:
"a closed, validated registry of built-in code, not an arbitrary third-party plugin runtime." Every
host added since — OpenCode in [ADR-0017](0017-opencode-host.md) — paid that cost in full: a
dedicated owner module, native surfaces reverse-engineered from scratch, and edits across roughly a
dozen files and eight test suites.

PR #131 named the fourth-host problem this creates: a new host is a **permanent obligation of
whoever maintains agentic-kit**, including a CLI they may not run, cannot easily verify, and did not
choose. Its own `docs/HOST-ADAPTER-EXTENSION-PROPOSAL.md` observed, correctly, that ADR-0016's own
contracts — `validateHostAdapter`, `validateLifecycleAdapter`'s five-verb
detect/plan/apply/verify/undo cycle, ownership receipts, `validateExecutionAdapter`,
`normalizedFacts` — are already host-agnostic and already partly proven: `OPENCODE_LIFECYCLE_ADAPTER`
is driven through the fully generic `runLifecycle`, not opencode-specific dispatch. The proposal's
central claim was that publishing that seam is a small last mile, not a new subsystem.

The maintainer's review of PR #131 (posted to the PR, quoted throughout this ADR) verified that
claim on the ak side — "adapter selection is indeed a named import at the five call sites,"
`status.mjs`'s hand-rolled opencode block and unguarded `npmRoot` call are as described, and the
validators are genuinely host-agnostic (a synthetic `grok` host is already exercised end-to-end
through setup disclosure in `trust-manifest.test.mjs:47-69`). It also found the in-tree gate list the
PR offered materially incomplete, and directed that any accepted design carry the honest full list
rather than the honest case-against alone. Both findings are the direct inputs to this ADR.

## Why the mechanism changed

PR #131's proposal was an **in-process** extension: a third party's ESM module, loaded by `import()`
and executed inside the same process as `ak` itself, gated only by explicit registration,
capability-cap fields in its declared manifest, and disclosure before mutation. Those three
constraints are real, but they only make untrusted in-process code *visible* — none of them make it
*safe*, and the evidence gathered in reviewing this proposal argues the gap is not closable by
adding more constraints of the same kind:

1. **No host CLI ak already integrates or evaluated sandboxes or verifies extension code before
   running it.** [ADR-0018](0018-generalized-host-worker-execution.md)'s own trust-boundary section
   already states this of `ak run`'s built-in workers: a hostile repository's `opencode.json` or
   `.claude/settings.json` pre-approves permissions and "no `permission.updated` event ever fires,
   so the adapter's abort boundary does not trip by design — the abort covers permission
   *requests*; it is not a sandbox." The PR #131 review independently confirmed the same shape at
   the fourth host: Hermes's headless `-z` mode sets `HERMES_YOLO_MODE=1` by its own documented
   contract, so there is no permission event to intercept and no `permission_required` result to
   return at all. Four hosts surveyed, zero that isolate extension code from the process trusting
   it — that is a precedent for the opposite of a fifth precedent, not for one.
2. **A typed capability cap is not the same thing as an enforced one, and this repository already
   has the near-miss on record.** The review's own item 6 (§ "The amended gate list" below) found
   that `src/lib/execution/adapters.mjs`'s routable-host invariant threw at **import time** for a
   registry-only change — a schema-correct, fully first-party host flip could have bricked `ak run`
   for every consumer before the corresponding execution adapter shipped. If a typed invariant on
   ak's own built-in registry needed a maintainer's line-by-line review to catch, the same class of
   cap expressed as a boolean field in a third party's manifest — `canBePrimary: false`,
   self-declared, in code that party also controls — is not a safe place to put the only enforcement
   of "this adapter may never become primary." A capability cap is only as strong as the code that
   is *unable* to ignore it, and in-process code sharing ak's own call stack is never in that
   position by construction.
3. **The integrity primitives this contract adopts instead already exist, tested, in the tools this
   review examined.** Codex CLI's trust model for a registered MCP server pins a content hash at
   approval time and invalidates that approval the instant the pinned content changes — never
   re-approving silently on drift. Hermes draws the same line one level lower: interactive
   `mcp add` requires an explicit confirmation before registering a server, contrasted directly
   against `-z`'s blanket, event-free auto-approval the review flagged as the honest-disclosure
   case in ADR-0030's own posture. Both are **consent gates outside the code being trusted**, not
   capability fields inside it. That is the shape this ADR adopts: hash-pinned consent on a
   manifest, invalidated the instant the manifest's content changes, enforced by `ak`'s own loader —
   never by the adapter's own declaration.

The accepted mechanism is therefore: **a declarative manifest, driving a fixed set of consented
subprocess hooks. No third-party code ever executes inside the `ak` process.** Everything the
manifest can express is data; everything the adapter *does* happens in a spawned process ak owns
the lifecycle of, exactly the way ADR-0016 §3 already bounds built-in projection network/process
probes and ADR-0018 already bounds worker subprocess termination proof.

## Decision

### 1. The manifest (contract: 1)

`kit.json` gains a `hostAdapters` array. Each entry names a manifest file, never a module:

```json
{
  "hostAdapters": [
    {
      "name": "hermes",
      "source": "~/.config/ak/adapters/hermes.json",
      "contract": 1
    }
  ]
}
```

The manifest itself is JSON: a host descriptor and capability block shaped like `HostAdapter` in
ADR-0016 §1 (minus the three fields capped in §3 below), plus a `hooks` block. Each hook names one
lifecycle or execution verb (`detect`, `plan`, `apply`, `verify`, `undo`, and the execution-adapter
methods when `capabilities.activityRouting` is declared) and the subprocess command that implements
it. There is no function-valued field anywhere in the manifest — every value is JSON-serializable,
which is itself part of the safety property: a manifest that cannot express a closure cannot smuggle
one in.

The 2026-08-26 amendment adds optional `aqe.provider` candidate data. Its provider identity is fixed
to `host.id`; the block may declare a supervised stdin/stdout hook, billing mode, models, default
model, concurrency, environment allow/strip lists, and display name. It requires
`cli-subprocess`, `canRouteActivities: true`, and `execution.run.hook`. Candidate data does not
activate itself: the `aqe-provider` tier must pass and a maintainer must grant `aqeProvider` at the
same combined content hash before bootstrap exposes it to Agentic-QE 3.13.12+.

### 2. Driving-surface vocabulary: `cli-subprocess` / `acp` / `mcp`

Every declared hook names the driving surface that invokes it. Contract v1 recognizes three surface
names:

- **`cli-subprocess`** — spawn the declared binary/script as a subprocess, apply the same bounded
  timeout and honest-unreachable discipline ADR-0016 §3 already requires of built-in projection
  probes, and read back either a structured JSON result (the `normalizedFacts`/`WorkerResult` shape)
  or a plain-text summary capture (the generic sibling of `createJsonlSummaryCapture`, needed for a
  host like Hermes that has no structured run mode). This is the **only surface with a working
  implementation in this wave.**
- **`acp`** — Agent Client Protocol invocation. Named for forward compatibility with driving
  surfaces this contract anticipates but has not built.
- **`mcp`** — Model Context Protocol tool call, the same shape this session's own Claude↔Codex
  bridge uses to drive one host from another. Also named, also not implemented.

An adapter manifest declaring `acp` or `mcp` today fails admission with an explicit "surface not yet
supported" diagnostic. It is never silently downgraded to `cli-subprocess` — a silent downgrade
would run a hook the adapter author never tested against that surface, exactly the kind of guessed
success ADR-0016 §5 and ADR-0023 already forbid elsewhere. An admitted host is given a
`cli-subprocess` **execution** adapter only when it declares that surface; a manifest missing it is
refused (`surface-unsupported`) rather than downgraded.

**`cli-subprocess` execution details** (settled while wiring [ADR-0031](0031-capability-graduation-and-upstream-requests.md)'s
external-execution row, after an adversarial review of the surface):

- **Command resolution is anchored, not ambient.** A hook subprocess runs with its working
  directory pinned to the adapter's own resolved directory (a file-sourced manifest's `realpath`
  directory), never `ak`'s current working directory — so a manifest declaring
  `["node", "run-hook.mjs"]` runs *the adapter's* `run-hook.mjs`, and a file planted in the
  operator's cwd is unreachable. A remote-sourced manifest (`npm:`/`https://`) has no persistent
  local directory, so a *relative* hook command from such a source is refused
  (`execution-unanchored`) rather than resolved against an ambient path; a bare PATH binary
  (`node`, `hermes`) stays legal. The combined content hash pins the manifest text and any declared
  local hook bytes; the resolution is anchored to the source's real directory, so those bytes cannot
  drift without the hash changing.
  - *Remote sources are path-independent in contract v1.* A remote (`npm:`/`https://`) resolver does
    not retain a bundle after extracting the manifest, so admission refuses script-like hook paths
    and any declared `hook.files` with `hook-files-unavailable`. Remote adapters must use PATH
    binaries or inline evaluator commands. A retained file source may use relative hook paths, but
    every adapter-owned file must be listed in that hook's `files` inventory and is hashed before
    consent.
- **Reserved exit codes carry consent/auth boundaries.** Hook exit `77` maps to
  `permission_required` (a blocked, never-escalated result — escalating around a consent boundary
  is the safety violation ADR-0019 already forbids) and `78` to `auth_required`. This gives an
  external host an honest way to say "I refused" or "I am not logged in" instead of a bare
  non-zero exit that would be re-run on another host.
- **Results never launder trust.** Exit code is the sole authority for success; a self-declared
  `provider` in hook stdout is stamped `inferred`, never `observed`; stderr is never promoted into
  a downstream worker's prompt; and handoff data is redacted from public `WorkerResult`s.

### 3. Capability self-claims are schema-structural, not runtime-checked

`canBePrimary`, `host.legacy.aqeProvider`, and `commandStatusline` are not claims the
external-adapter manifest schema accepts. An adapter author cannot express the claim "I am
primary-eligible" —
not because `ak` reads and rejects `true`, but because the accepted JSON Schema has no place to put
it. This is the direct fix for the gap identified in "Why the mechanism changed" above: a capability
cap enforced by field-absence cannot be bypassed by anything the adapter's own code does, because
there is no code — only a document a schema either accepts or rejects before anything runs.
`canRouteActivities` remains expressible. Since the 2026-08-26 amendment, `aqe.provider` may also
describe a candidate external CLI provider, but it is data rather than capability: it requires
`cli-subprocess`, activity routing, an execution hook, a dedicated provider hook, a passed real
`aqe-provider` tier, and an explicit maintainer grant at the same content hash before bootstrap
registers it.

### 4. Admission: fail-closed, per-adapter isolated, behind an experimental flag

The entire surface is inert unless `AK_EXPERIMENTAL_HOST_ADAPTERS=1` is set in the environment. With
the flag unset, a `hostAdapters` entry in `kit.json` is parsed and preserved (never silently
dropped) but never admitted — `ak` reports it present-but-inactive rather than pretending it does
not exist.

With the flag set, admission of each declared adapter is independent:

- schema validation of the manifest, hash verification against the persisted `trust.hash`, and
  hook-surface support are all checked before any hook of that adapter ever runs;
- a failure at any of those steps is reported and that one adapter is skipped — it never brings down
  `ak status`, `ak sync`, or any built-in host's handling;
- first-party registries keep throwing at construction. A broken built-in is a build error; a broken
  external adapter is a diagnosed, isolated fact, per ADR-0023's fail-closed-and-explicit posture
  applied to a source ak did not author.

### 5. The admitted overlay

An admitted external host is exposed through an overlay alongside `HOST_REGISTRY`, never by
mutating the frozen built-in registry itself — the same non-negotiable ADR-0016 §1 drew around
compatibility exports ("derived… but not independent sources of truth"), generalized to a second,
explicitly consented source instead of legacy-compat alone. Every consumer that already derives its
behavior from capability lookups over the registry (ADR-0016 §2: host selection, primary-host
eligibility, activity routing, install/MCP/guidance/status-line/transcript/usage work, verification)
picks up an admitted host automatically, with no adapter-specific branch to add. An admitted host is
invisible as a special case to any consumer that was already capability-driven — and visible only
where a consumer still hardcodes `claude`/`codex`/`opencode` by name. That residue is exactly the
amended gate list below.

### 6. Consent: hash-pinned, edit-invalidated

Registering an adapter computes a content hash over the validated manifest and every declared
subprocess hook command. For a file-sourced adapter, each hook's explicit relative `files` inventory
also contributes a per-path SHA-256 digest; the combined identity is disclosed before confirmation
and stored in `trust.hash`/`trust.consentedAt`. Every subsequent load re-hashes the manifest and
declared files and compares: a mismatch means the adapter is **not admitted** until re-consented.
Every admitted spawn repeats the file check immediately before execution, so a file edited after
admission cannot run under the old consent or grant. This is Codex's pin-and-invalidate model,
extended to the bytes the manifest names. It is not a race-free immutable snapshot; a future retained
bundle/signature design can provide that stronger TOCTOU guarantee.

### 7. No in-process third-party code, ever

Every hook — lifecycle and execution alike — is a subprocess `ak` spawns and owns the termination
proof of, on the same bounded-timeout, honest-diagnostics terms ADR-0016 §3 and ADR-0018's worker
cleanup contract already hold built-in projections and workers to. `ak` never calls `import()` or
`require()` on a path an adapter supplies, and an adapter's existence adds no npm dependency to
`@pacphi/agentic-kit` — the package remains zero-runtime-dependency regardless of how many external
adapters a user registers.

### 8. The amended gate list

The maintainer's PR #131 review found the proposal's in-tree gate list (its §8) materially
incomplete for the in-process shape, and asked that any accepted design carry the complete list.
The mechanism changed, but every named gap is a real, mechanism-independent seam in how `ak` treats
"the host set" today, so all six remain load-bearing for the subprocess-hook design too. Status as
observed in this worktree:

| # | Gap (maintainer's review) | Disposition |
|---|---|---|
| 1 | **The import-time invariant.** `execution/adapters.mjs` enforced a *bidirectional* built-in↔routable-hosts check at import; a registry-only host flip to `canRouteActivities: true` ahead of its adapter landing would brick `ak run` for everyone. | **Done, wave 1.** `assertBuiltinAdaptersRoutable` now checks only the built-in→registry direction (an in-tree wiring mistake still throws at import, exactly as before); the reverse direction is a merge seam — `executionAdapterFor()` returns `null` and the runner degrades that one worker with `cli_unavailable`, per [ADR-0019](0019-escalation-in-ak-run.md)'s existing degradation precedent for a host with no adapter (`src/lib/execution/adapters.mjs`). |
| 2 | **Uninstall-through-undo.** `ak uninstall` bypassed `runLifecycle` entirely; a third-party footprint would persist forever. | **Done, wave 1.** `uninstall.mjs` now runs registry-driven teardown for `hostsWithLifecycle()`, calling each host's own `undo` through `runLifecycle` — opencode-specific dispatch is gone; an admitted external host's `undo` hook runs on the identical path (`src/commands/uninstall.mjs`). |
| 3 | **Permission authorization by host.** Setup's permission pass authorized only claude-host rules; `removeUndisclosedPermissions` would strip a non-claude host's permissions and fail setup. | **Done, wave 1.** `projectPermissionManifest` now unions the authorized auto-approve set across every *enabled* host's trust manifest (a host not gating on enablement always contributes; an opt-in host contributes once `cfg` enables it) instead of hardcoding claude's rules, with `hosts` injectable for tests (`src/commands/setup.mjs`). |
| 4 | **Attribution-surfaces policy.** Three surfaces handled an unrecognized host differently and by accident: the usage scorecard collapsed it into `claude`, live sessions rewrote it to `'internal'`, and qe-court's `vendorOf` mapped it to a shared `'unknown'` — each capable of distorting a count in either direction. | **Done, Phase 0.** All three now exclude-and-label instead of silently collapsing: qe-court gives every unregistered id its own `unregistered:<id>` tag and excludes unregistered vendors from the diversity count entirely (`src/lib/qeCourt.mjs`); live events pass a safely-shaped unknown host id through verbatim and bucket anything unsafe as the explicit `'unknown-host'` (`src/lib/live/event-schema.mjs`); the usage scorecard buckets by `host ?? 'unknown'` rather than defaulting to `claude` (`src/lib/usage-index.mjs`). |
| 5 | **Unknown-key warning.** `kit.json` silently round-trips unknown top-level keys, so `hostAdapters` on an ak version that predates this ADR is a silent no-op. | **Done, wave 1** (as a general mechanism, not one written for `hostAdapters` specifically). `loadKitConfig` now warns once per process per distinct unknown-key set — "kit.json keys not recognized by this ak version: …, preserved, ignored" — for *any* key the running version doesn't know, `hostAdapters` included on an older `ak` (`src/lib/config.mjs`). |
| 6 | **Test pins.** ~12 assertions pinned the built-in host set directly, and the test-enforced registry↔directory parity meant a registered host with no authored About card failed CI. | **Working (wave 3, merged #148).** Host-set and default-map expectations across nine test files now derive from `managedHostIds()`/`routableHostIds()`/`primaryHostIds()`/`defaultHostMap()`, scoped to built-ins; the component-directory parity invariant is stated built-in-scoped, exempting admitted adapters until this contract graduates them. |

## Supersession of ADR-0016's closed-registry clause

ADR-0016 states, as a design requirement:

> Agentic-kit remains a plain-ESM, zero-runtime-dependency CLI. Its normal operation is
> offline-first. The design must therefore be a closed, validated registry of built-in code, not
> an arbitrary third-party plugin runtime.

and restates it in its non-goals:

> It does not implement every provider, a public adapter SDK, or arbitrary third-party code
> loading.

**This ADR formally supersedes that clause.** The registry is no longer exclusively built-in code:
an explicitly registered, hash-pinned, subprocess-only external adapter may be admitted into an
overlay alongside it, gated by `AK_EXPERIMENTAL_HOST_ADAPTERS=1`. Every other requirement that
clause was protecting — zero-runtime-dependency, offline-first normal operation, no dynamically
imported third-party code inside the `ak` process — remains intact and is in fact the specific
design this ADR uses to satisfy the request without reopening either property. ADR-0016 §1's
sentence "Agentic-kit does not dynamically import adapter paths from `kit.json`, npm packages, or
user directories" is superseded in the same, narrow sense: `kit.json` may now name an adapter
manifest, but nothing under that name is ever `import()`-ed — the clause's *intent* (no in-process
third-party code) is preserved even as its literal *mechanism description* (no `kit.json`-driven
external reference of any kind) is not.

A matching one-line update-note has been added to ADR-0016 itself, pointing here.

## Non-goals

- **No marketplace, discovery, or naming-convention scan.** Admission is always explicit
  registration by manifest path; there is no `ak-host-*` npm-tree scan, ever — that is exactly the
  fail-open pattern ADR-0023 exists to prevent, and PR #131's own proposal already rejected it for
  the in-process shape.
- **No code signing.** Consent is a hash pin plus explicit user confirmation, not a signature chain
  or a claim of provenance beyond "this is the content the user agreed to run."
- **No in-process plugin API, now or as a later contract version.** Contract v1's ban on `import()`
  of adapter-supplied code is not a bootstrapping restriction to be lifted once the mechanism
  matures; it is the property "Why the mechanism changed" argues for. A future contract version may
  add driving surfaces (`acp`, `mcp`) or hook verbs; it may not add in-process code execution.
- **Historical decision — no AQE projection (superseded 2026-08-26).** The original contract
  permanently excluded external AQE providers because AQE had no safe registration surface. AQE
  3.13.12's `externalProviders` implementation for #628 removes that upstream premise. The current
  decision admits `aqe.provider` candidate data but preserves the original trust goal: admission
  alone grants nothing; only a passed transport tier plus a maintainer grant activates it.
- **No automatic routing or seeding.** An admitted host is never auto-seeded into `routing.routes`;
  it must be explicitly routed, matching [ADR-0018](0018-generalized-host-worker-execution.md)'s
  existing rule that automatic seeding stays Claude/Codex subscription-only.
- **No subprocess/RPC protocol beyond the three named driving surfaces**, and no promise that `acp`
  or `mcp` ship in this contract version. Re-specifying two lifecycles as a wire protocol is a
  larger commitment than this ADR's evidence currently justifies.
- **No vendoring of any specific third-party adapter into this repository**, and no obligation that
  agentic-kit maintainers verify, support, or track the release cadence of any host an adapter
  targets. An adapter author owns their host's correctness; `ak` owns only the contract.

## Consequences

- A fourth (fifth, …) host CLI can be described to `ak` without a dedicated ADR, owner module, or
  maintainer commitment to a CLI they may not run — at the cost of everything that host can express
  being strictly less than a built-in: no in-process code, three capped fields, and admission gated
  behind an explicit flag and an explicit content-hash consent.
- The gap the amended gate list closes was real independent of this ADR: items 1–5 harden the
  built-in host set's own correctness (a registry-only routable-host flip, uninstall completeness,
  permission authorization, attribution honesty, and unknown-key visibility) whether or not any
  external adapter is ever registered. Publishing the extension point is what surfaced them; keeping
  them fixed does not depend on the extension point staying enabled.
- `AK_EXPERIMENTAL_HOST_ADAPTERS` being unset is the default, and the default behavior of every
  existing command is unchanged: an unset flag makes the whole surface inert, and a `hostAdapters`
  key with the flag unset round-trips through `kit.json` untouched.
- Capability self-claims remain inexpressible. `aqeProvider` is now earned outside the manifest from
  `aqe.provider` candidate data; `canBePrimary` and `commandStatusline` remain earned the same way.
  Graduation freezes the contract, not the right to bypass evidence or grants.

## Self-graded implementation status

Dated 2026-08-26, after the Agentic-QE #628 integration. Rows already covered by the amended
gate list are not repeated; this table grades the mechanism this ADR newly decides. **Working** means
implemented and tested in this worktree.

| Mechanism | Grade (2026-08-26) | Evidence |
|---|---|---|
| Manifest schema (contract: 1) | **Working** | `src/lib/adapters/manifest.mjs`; strict hook `files` inventory validation; manifest tests. |
| Admission gate (fail-closed, per-adapter isolated) | **Working** | `src/lib/adapters/admission.mjs`; admission and integrity tests. |
| `AK_EXPERIMENTAL_HOST_ADAPTERS` flag gating | **Working** | Bootstrap and CLI flag-off tests. |
| Admitted-host overlay (registry-adjacent, non-mutating) | **Working** | `src/lib/adapters/admitted.mjs`; overlay/grant tests. |
| Subprocess hook-runner (`cli-subprocess` surface) | **Working** | `src/lib/adapters/hook-runner.mjs`; bounded real-subprocess tests. |
| Hash-pinned consent + edit-invalidation | **Working** | `src/lib/adapters/integrity.mjs`; manifest + declared hook-file digests, pre-spawn recheck, integrity tests. |
| Capability-cap schema absence (§3) | **Working** | Schema refusal tests and maintainer-only grant allow-list. |
| AQE external-provider candidate + projection | **Working** | Strict `aqe.provider` validation; six-tier conformance includes a real `aqe-provider` probe; live pre-spawn host/consent/grant reauthorization; private verified-byte execution snapshots for declared command paths and relative imports; Agentic-QE 3.13.12 gate; project-only default/fallback/agentOverrides projection; independent exact ownership receipts for declarations, activations, and external defaults; foreign-entry preservation, explicit-disable/conflict refusal, and same-command stale-reference pruning. |
| Gate item 1 — import-time invariant | **Working** | `assertBuiltinAdaptersRoutable`, one-directional since W1-B (`src/lib/execution/adapters.mjs`). |
| Gate item 2 — uninstall-through-undo | **Working** | Registry-driven `hostsWithLifecycle()` teardown loop (`src/commands/uninstall.mjs`). |
| Gate item 3 — permission authorization by host | **Working** | `projectPermissionManifest` union-across-enabled-hosts, F-04 (`src/commands/setup.mjs`). |
| Gate item 4 — attribution surfaces policy | **Working** | F-11 qe-court tagging (`src/lib/qeCourt.mjs`); `resolveHost` safe-passthrough/`unknown-host` (`src/lib/live/event-schema.mjs`); `host ?? 'unknown'` bucketing (`src/lib/usage-index.mjs`). |
| Gate item 5 — unknown-key warning | **Working** | F-14 `warnUnknownTopLevelKeys` (`src/lib/config.mjs`). |
| Gate item 6 — test pins (registry↔directory parity) | Working (wave 3, #148) | Registry-derived, built-in-scoped. |

## Graduation gate

Contract v1 is **experimental** for the life of the `4.0.0-alpha.*` line and remains so afterward
until it explicitly graduates. Graduation is a written, falsifiable event, not a vibe:

1. A **real external adapter** — maintained outside this repository, by someone other than an
   agentic-kit maintainer — passes the full conformance kit (the same lifecycle, execution,
   ownership, and `normalizedFacts` conformance tests a built-in host is held to, run against the
   external adapter's declared hooks).
2. That adapter then completes **one full release's worth of soak** in the field with no
   contract-shape change required to keep it working.
3. Only once both hold does the manifest **contract integer** freeze: `contract: 1` becomes a
   guaranteed-stable shape, and any subsequent breaking change to the manifest, hook verbs, or
   driving-surface vocabulary ships as `contract: 2`, admitted alongside `contract: 1` rather than
   replacing it outright.

Before graduation, `contract: 1` may change between alpha releases without a version bump. That
instability is bounded, not open-ended: it exists to let the first real adapter's conformance run
surface shape problems cheaply, the same way carrying Hermes surfaced one widening and one guard for
the in-process proposal's own subprocess base. It is not a license to redesign the contract
speculatively.

## References

- `src/lib/adapters/registries.mjs` (`HOST_REGISTRY`, `validateHostAdapter`, `validateRegistries`),
  `src/lib/adapters/lifecycle.mjs` / `lifecycle-registry.mjs` (`validateLifecycleAdapter`,
  `registerBuiltinLifecycle`), `src/lib/execution/adapters.mjs`
  (`assertBuiltinAdaptersRoutable`, the merge seam), `src/commands/uninstall.mjs`
  (`hostsWithLifecycle()` teardown loop), `src/commands/setup.mjs`
  (`projectPermissionManifest`, `removeUndisclosedPermissions`), `src/lib/config.mjs`
  (`KNOWN_TOP_LEVEL_KEYS`, `warnUnknownTopLevelKeys`), `src/lib/qeCourt.mjs` (F-11 unregistered-id
  tagging), `src/lib/live/event-schema.mjs` (`resolveHost`, `SAFE_HOST_ID`), `src/lib/usage-index.mjs`
  (host bucketing).
- [ADR-0016](0016-capability-driven-integration-adapters.md) — the closed-registry clause this ADR
  supersedes, and every capability/lifecycle/ownership/provenance contract this ADR reuses without
  change.
- [ADR-0018](0018-generalized-host-worker-execution.md) — the trust-boundary section this ADR's
  "no host sandboxes extension code" evidence line rests on, and the worker termination-proof
  discipline the subprocess hook-runner inherits.
- [ADR-0019](0019-escalation-in-ak-run.md) — the `cli_unavailable` degradation precedent the
  import-time invariant fix (gate item 1) generalizes.
- [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md) — the fail-closed-and-honest
  posture the admission gate and the ban on naming-convention discovery both apply.
- [ADR-0028](0028-local-openai-compatible-providers.md) — the sibling ADR accepted from the same PR
  #131, and the precedent for "accepted with corrections after review," which this ADR follows in
  house style.
- `docs/HOST-ADAPTER-EXTENSION-PROPOSAL.md` — the companion document PR #131 shipped alongside its
  own draft of this ADR number; §§1–2 and §5 of that document remain accurate background even though
  §3's in-process mechanism is not what this ADR accepts.
- [PR #131](https://github.com/pacphi/agentic-kit/pull/131) — original proposal and its maintainer
  review comment, the source of the amended gate list and the Hermes-behavior findings cited above.
