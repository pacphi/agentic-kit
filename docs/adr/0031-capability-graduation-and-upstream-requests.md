# ADR-0031 — Capability graduation: earned parity for external host adapters, and the upstream request path

- **Status:** Accepted (governance decision; implementation active)
- **Date:** 2026-08-16
- **Updated:** 2026-08-24
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0016](0016-capability-driven-integration-adapters.md),
  [ADR-0018](0018-generalized-host-worker-execution.md),
  [ADR-0019](0019-escalation-in-ak-run.md),
  [ADR-0023](0023-fail-closed-operations-and-explicit-degradation.md),
  [ADR-0029](0029-host-adapter-extension-point.md) (amends its "permanent caps" framing — see
  [Amendment](#amendment-to-adr-0029))
- **Amends:** ADR-0029, on one point only: the three capability caps are reframed from *permanent*
  to *not self-declarable, but earnable*.

## Context

[ADR-0029](0029-host-adapter-extension-point.md) admitted external host adapters as a declarative
manifest plus consented, subprocess-only hooks, behind `AK_EXPERIMENTAL_HOST_ADAPTERS=1`. To make
the door safe, three capabilities were made **inexpressible** in the manifest schema —
`canBePrimary`, `aqeProvider`, and `commandStatusline` — and ADR-0029 described that block as
permanent.

Two things push past that framing:

1. **The product intent is full parity.** A host that clears conformance should be able to
   participate exactly like a built-in — lead a run, own a status line, be accounted for in
   quality — not sit permanently behind a glass wall. "Second-class forever" is not the goal;
   "earn your way to first-class" is.

2. **`ak` is downstream of two other systems.** [ruflo](https://github.com/ruvnet/ruflo)
   orchestrates the agent loop and [agentic-qe](https://github.com/proffesor-for-testing/agentic-qe)
   runs quality. Some parity ceilings are genuinely not `ak`'s to lift — they live upstream — and a
   contributor chasing a conformance tier needs a real route to express what's missing, not a dead
   end.

This ADR resolves both. It keeps every safety property ADR-0029 established and adds the governance
model that turns the caps from a wall into a ladder.

## Decision

### 1. Earned, never self-declared

The manifest schema stays a **strict allow-list in which a capped capability is inexpressible**. An
adapter can never *write down* that it is primary, an AQE provider, or a command-statusline owner.
This is the safety invariant from ADR-0029 and it is permanent: self-declaration is the attack
surface, so it stays closed forever.

Parity comes through a **separate channel**. A capability is *earned* by passing a conformance tier
and *granted* by the maintainer — recorded as a hash-pinned **capability grant** (the same
edit-invalidation model as adapter consent), never as a field in the adapter's own manifest. The
adapter never asserts the capability; conformance evidence plus an explicit maintainer grant confers
it. `hostTierLabel()` and the registry already render behaviour from capabilities, so a granted
capability lights up at every call site without special-casing.

### 2. Tiered conformance

Conformance becomes tiered rather than pass/fail. Each tier is a black-box test set — spawn the real
host, assert the real behaviour, against an installed layout — that gates one capability:

| Tier | Gates | Evidence shape |
| ---- | ----- | -------------- |
| `admission` | Registration through the fail-closed gate (ADR-0029, shipped) | manifest validates, admits, hooks run |
| `session-driving` | `canDriveSession` — the host actually drives an interactive/oneshot session | a real session completes and is observed |
| `activity-routing` | `canRouteActivities` — the host runs a supervised `ak run` worker to a structured result | a worker completes under the runner's contract (ADR-0018) |
| `primary-eligible` | Grants `canBePrimary` — the host can *lead*: anchor routing, be escalated toward | leads a run and receives an escalation, per ADR-0019 |
| `statusline` | Grants `commandStatusline` — renders a command-backed footer through supervised hooks | a footer renders and refreshes |

Passing a tier records evidence; the maintainer's grant turns evidence into capability. A tier the
adapter cannot meet because the capability is upstream is marked **gated** (§4), not failed.

The recorded evidence is hash-pinned to the **combined adapter content identity** — the validated
manifest plus each explicitly declared relative hook-file digest — using the same content pin consent
uses (ADR-0029 §6). A manifest edit or declared hook-file edit therefore voids the evidence and the
grants that rest on it. File inventories are explicit rather than a language-specific import scan:
authors must list every adapter-owned file a hook executes. Immediately before every lifecycle or
execution spawn, `ak` re-reads the declared files and fails closed if that identity changed. Remote
manifest sources have no retained bundle and are limited to PATH binaries or inline commands in
contract v1; an immutable bundle/signature design remains a later strengthening for race-free TOCTOU
protection.

### 3. Two graduation destinations

A conformed adapter lands in one of two places, the maintainer's call:

- **Blessed external adapter** — added to a curated, hash-pinned list. It stays out-of-tree and
  experimental, holding exactly the capabilities its tiers earned. Right for niche or long-tail
  hosts the project does not want to own.
- **Promoted built-in** — its host descriptor is adopted as a first-party registry entry. Because of
  the registry-driven refactor delivered across Phases&nbsp;0–2, this is a small, ordinary PR (a
  registry entry, a lifecycle adapter, an About card). Once built-in, the caps no longer apply
  *because it is now first-party code the maintainer vouches for* — that is what promotion means. Its
  hook scripts either ship bundled or are reimplemented as in-process glue, the maintainer's choice.

### 4. The upstream capability-request path

When a conformance tier cannot be met, the first question is **whose capability is missing**:

- **`ak`-local** (run execution, the trust CLI, remote manifest sources, quality-gate anchors) — the
  project's to build. A normal `ak` change; no one to wait on.
- **Upstream — agentic-qe** — being a recognized **AQE provider type** is not `ak`'s to grant.
  agentic-qe's provider set is a closed, upstream-defined enumeration (verified against
  `agentic-qe@3.13.10`: `ALL_PROVIDER_TYPES` plus a `createProvider` switch, extended only by an
  upstream code change). The path: file a concrete capability request against agentic-qe (a
  provider-plugin API), record the tier as `gated: agentic-qe#NNN`, and light it up when the upstream
  release ships. *Interim:* quality still runs through the model provider underneath the host, so QE
  is not blocked — only the host's own AQE identity is.
- **Upstream — ruflo** — being a native ruflo **backend** (an `ENABLE_*` target that drives the loop)
  is defined inside ruflo (grounded against `ruvnet/ruflo@45e65b5`: backend enablement is per-host
  `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` / `ENABLE_GEMINI_MCP`, not an outside registration). The path:
  request a documented backend-registration surface upstream. *Interim:* the host runs through `ak`'s
  own supervised execution, just not as a ruflo-native backend.

The maintainer champions the request upstream with a named extension point, tracks the gated tier so
an adapter's status shows exactly what it waits on, and exposes the capability in the adapter contract
once upstream releases it. This is what keeps "no limitations after conformance" honest: the
limitations that *are* real get a documented, per-layer route to disappear.

### 5. The contributor-to-built-in lifecycle

Graduation runs on a fixed sequence. A contributor **authors** a manifest and hooks,
**self-tests** against the conformance kit, and **publishes** — at which point any user may opt in
behind the experimental flag with hash-pinned consent, needing nothing from the maintainer. To go
further, the contributor **proposes** it with a conformance report; the maintainer **verifies** by
re-running the conformance kit and reviewing the hook scripts (the only part that executes),
**decides** the tier and destination (§3), and **releases**. Conformance is objective; the
maintainer is the judge; trust rests on reproduced evidence plus a hook read, never on running the
contributor's code inside `ak`.

### 6. Freeze criteria

`contract: 1` (ADR-0029) freezes and the experimental flag is dropped when a **real** external
adapter (Hermes first) clears the full conformance kit and survives one release of soak. Graduation
of a capability tier and the freeze of the contract are distinct: tiers can be earned while the
contract is still experimental.

## Amendment to ADR-0029

ADR-0029 states the three caps are permanent. This ADR amends that: **the block on
*self-declaration* is permanent; the *capability* is earnable** through a conformance tier and a
maintainer grant (§1, §2). ADR-0029's schema, admission gate, consent model, and hook runner remain
the governing path; contract v1 now includes the additive `hook.files` inventory and combined
manifest/file identity. Capability grants still live outside the manifest. A matching update note is
added to ADR-0029 pointing here.

## Consequences

- An external adapter has a documented, evidence-gated route to full parity, up to and including
  shipping as a built-in — without ever loading third-party code into the `ak` process and without
  ever letting a manifest self-assert a capability.
- The maintainer's review burden is bounded and objective: reproduce a conformance report, read the
  hooks, grant a tier. No new trust primitive beyond the hash-pinned grant.
- Real upstream ceilings are neither hidden nor faked: they become tracked capability requests with
  an honest interim behaviour and a light-up path.
- `ak` positions itself as the integrator that *shapes* its substrates rather than only consuming
  them — the upstream-request path is a first-class part of the model, not a footnote.

## Implementation status

Per the ADR discipline this repository adopted (a dated, self-graded table before an Accepted claim
rests on delivery): the **governance decision** is accepted and the core machinery is working behind
the experimental flag. This table is the source of truth for what is real.

| Piece | Status | Note |
| ----- | ------------------- | ---- |
| Admission gate, consent store, hook runner, conformance kit (`admission` tier) | **Working** | ADR-0029, merged (PR #149) |
| `ak host adapters trust` CLI (records consent/grants) | **Working** (2026-08-16, wave A) | `list`/`trust`/`revoke` + `--expect-hash` pinning; disclosure prints the full validated manifest (control-char-safe); mirrors every pre-hash admission refusal; `revoke` works with the flag off (fail-safe) |
| External execution (`ak run` drives an admitted host) | **Working** (2026-08-16, wave B; integrity tightened 2026-08-24) | Manifest `execution.run` hook (coupled to `canRouteActivities`, else refused `execution-not-routable`); derived subprocess adapter behind `executionAdapterFor`; routing is overlay-aware via a lazy `effectiveRoutableHostIds()`. Security-hardened (adversarial review): hooks spawn with `cwd` pinned to the adapter's own resolved directory; remote path-backed hooks are refused before admission because no bundle is retained; declared local hook files are rechecked immediately before spawn; an unresolved-launch cancellation reports `orphaned` (non-escalating), never an escalatable `timed_out`; handoff data is redacted from public results; stderr is never promoted into a downstream prompt; reserved hook exit codes `77`/`78` express `permission_required`/`auth_required` boundaries; a self-declared `provider` is stamped `inferred`, never `observed` |
| External lifecycle execution wired into setup/sync/uninstall | **Working** (2026-08-16, wave C) | The loops iterate `hostsWithLifecycle()` (built-ins + admitted) through a shape-agnostic renderer; an admitted host's lifecycle runs only when explicitly enabled in `kit.json` **and** the flag is set. Admitted lifecycle hooks are cwd-anchored to the adapter's own directory (per-verb `lifecycle-unanchored` refusal for a relative hook on a remote source), the same F-1 protection as execution. `setup`, `uninstall`, **and now `sync`** are fully live: `status.mjs`'s collector emits a subsystem-tagged row for an enabled admitted lifecycle host, so `sync`'s convergence plan reaches its admitted-host branch (wave D4 closed the earlier `sync`-only reachability gap) |
| Tiered conformance harness (`session-driving` … `statusline`) | **Working** (2026-08-16, waves C+D2) | `runTieredConformance` + `ak host adapters conformance`: `admission`, `activity-routing`, and now `primary-eligible` genuinely pass black-box against a real fixture — `primary-eligible` drives a real `executeRunPlan` where the host anchors a run and receives a genuine ADR-0019 escalation onto itself (a real second subprocess), recorded with no pre-existing grant. `session-driving`/`statusline` stay honestly `gated`/`skipped` (external session driving and the statusline render path are not built) — the harness never fabricates a pass, and there is no injection seam through which a caller could substitute one. A failed `admission` tier short-circuits every downstream tier so no evidence is laundered. A grant-bearing tier that re-runs `failed` under the same adapter-content hash now auto-voids the stored tier **and** the live granted capability (wave D4, N-1) — the un-earn path mirrors the gated-downgrade; a `skipped` result never voids (prerequisite not evaluated ≠ disproof). Capabilities can also be withdrawn per-capability with `ak host adapters revoke-grant <name> [capability]`. The content identity covers the validated manifest plus declared hook-file bytes; the explicit inventory and immediate pre-spawn recheck are the remaining contract-v1 boundary. `statusline` un-earn lands with its render path |
| Hook-file integrity and development conformance mode | **Working** (2026-08-24, PR #131 follow-up) | `hook.files` validates an explicit relative inventory; `hashAdapterContent` adds per-path SHA-256 digests; admission, consent, grants, and pre-spawn execution use the combined identity; `ak host adapters conformance <name> --dev` runs real probes without persisting evidence or grants. |
| Capability-grant store + promotion command | **Working** (2026-08-16, waves D+D2) | `grants.mjs` (hash-pinned, evidence-gated, edit-invalidated like consent — the earned capability is enforced at **read** time, not only at grant time) plus `ak host adapters grant`/`bless`: the maintainer's explicit grant of a tier-earned capability, refused unless the gating tier is recorded `passed` at the current adapter-content hash. **Wave D2 makes a grant live:** at bootstrap the admitted-host overlay reads `grantedCapabilitiesFor` at the fresh current content hash and raises `canBePrimary`/`commandStatusline` on the effective-registry entry (through a local allow-list that can raise only those two, never `aqeProvider` or any other key), so `hostTierLabel` and `effectivePrimaryHostIds()` reflect it. Two consumption gaps remain, honestly disclosed at grant time: no path yet *selects* an external host as primary (`ak host pick` stays built-in-scoped), and `commandStatusline` has no runtime reader yet (its render path is a later wave) |
| Remote manifest sources (npm / URL) + resolve→hash ordering | **Working** (2026-08-16, wave A; tightened 2026-08-24) | file / https (no redirects, bounded time+bytes) / `npm:` (`npm pack --ignore-scripts` + `tar -xzOf` stdout-only — nothing extracted to disk, package scripts never run); resolver runs before hashing, and remote sources with script-like hook paths are refused because no bundle is retained. |
| Upstream request tracking (`gated: <repo>#NNN` against a tier) | **Working** (2026-08-16, wave D) | `ak host adapters gate <name> <tier> <ref>` records a ref-format-validated upstream gate; `ak host adapters status` surfaces per-tier passed/gated state (stale-marked on a manifest edit) and the granted capabilities |
| A real external adapter (Hermes) clearing the kit → contract freeze | **Not started** | Freeze criterion (§6) |

## Alternatives considered

- **Keep the caps permanent (ADR-0029 as written).** Rejected: it makes external hosts second-class
  forever and contradicts the product intent of full parity after conformance.
- **Let the manifest self-declare capabilities, checked at runtime.** Rejected outright. This is
  ruflo's own cautionary tale, surfaced in the research sweep behind this work: a fully typed
  capability-permission system shipped with *zero runtime enforcement*. Runtime checks on a
  self-asserted capability are exactly the honor-system trap the strict-allow-list schema exists to
  avoid. Self-declaration stays inexpressible; capability comes from earned evidence plus an explicit
  grant.
- **Treat every ceiling as `ak`-local and build around upstream.** Rejected as dishonest and
  unmaintainable: agentic-qe's provider enum and ruflo's backend model are upstream facts. Faking a
  local shim (e.g. projecting an unknown host into agentic-qe's config) would fabricate an identity
  the upstream tool never declared it understands. The upstream-request path (§4) is the honest
  alternative.

## References

- ADR-0029 (the extension point, schema, admission, consent, hook runner) and its amendment above.
- ADR-0018 (supervised worker contract), ADR-0019 (bounded escalation) — the substance of the
  `activity-routing` and `primary-eligible` tiers.
- Upstream facts grounded in a source-cited research sweep: `agentic-qe@3.13.10`
  (`ALL_PROVIDER_TYPES`, the `createProvider` switch, the closed provider enum) and
  `ruvnet/ruflo@45e65b5` (`ENABLE_*` backend model). The two §4 capability requests have been filed —
  the AQE provider-plugin request as
  [proffesor-for-testing/agentic-qe#628](https://github.com/proffesor-for-testing/agentic-qe/issues/628)
  and the ruflo backend-registration request as
  [ruvnet/ruflo#3046](https://github.com/ruvnet/ruflo/issues/3046), each inviting the maintainer to
  close-as-satisfied if the current source already provides the surface.
- Companion explainer for consumers and implementers:
  [`docs/HOST-EXTENSIBILITY-EXPLAINER.html`](../HOST-EXTENSIBILITY-EXPLAINER.html); design dossier:
  [`docs/ADAPTER-CONTRACT-DOSSIER.html`](../ADAPTER-CONTRACT-DOSSIER.html).
