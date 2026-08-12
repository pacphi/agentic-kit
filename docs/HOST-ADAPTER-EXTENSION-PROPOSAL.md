# Host adapters as a published extension point

**Companion proposal to [ADR-0029](adr/0029-host-adapter-extension-point.md), with
[ADR-0030](adr/0030-hermes-reference-adapter.md) as its first consumer and
[ADR-0028](adr/0028-local-openai-compatible-providers.md) as an independent prerequisite.**

Status: **Proposed.** No implementation is authorized or claimed by this document.

---

## 1. The request behind the proposal

Someone wants agentic-kit to manage a fourth agent CLI — [Hermes
Agent](https://github.com/NousResearch/hermes-agent) — because it is the host that most naturally
drives local models, and local-model work is where they operate.

The obvious way to grant that request is the way OpenCode was granted: an ADR, an owner module, and
edits across nine files. [ADR-0017](adr/0017-opencode-host.md) is an excellent record of what that
costs. Its own references section lists fourteen source files and eight test suites for **one**
host.

The obvious way is also the wrong way here, for a reason that has nothing to do with hermes: it
makes every host a permanent obligation of whoever maintains agentic-kit. A fourth host means the
maintainer now owns compatibility with a CLI they may not run, cannot easily verify, and did not
choose. That is a poor trade for the maintainer and a fragile arrangement for the requester, whose
feature survives only as long as someone else's patience.

This proposal asks for something different, and smaller: **publish the seam that already exists.**

---

## 2. The seam already exists

This is not a request to build an extension mechanism. It is a request to make one reachable.

Every contract a host adapter would need is already specified **and already enforced** in this
repository:

| What an adapter must satisfy | Where it is already defined |
|---|---|
| Host descriptor + capabilities | `validateHostAdapter` — `src/lib/adapters/registries.mjs` |
| Cross-axis invariants | `validateRegistries`, run at construction |
| Configuration lifecycle | `validateLifecycleAdapter` — `detect`/`plan`/`apply`/`verify`/`undo` |
| Ownership and safe teardown | `ownership`, `mayUndo`, `undoOwnedValues` |
| Worker execution | `validateExecutionAdapter` (8 methods), `validateWorkerResult` |
| Shared subprocess base | `createSubprocessExecutionAdapter` |
| Normalized, provenance-bearing facts | `normalizedFacts` — `schemaVersion: 1` |
| Guidance rows | `registry(customBlocks)` — **already user-extensible via kit.json** |

And adoption is real. `OPENCODE_LIFECYCLE_ADAPTER` implements the full five-verb contract, and both
`src/commands/sync.mjs` and `src/commands/x/host.mjs` already drive it through the generic
`runLifecycle` — not through opencode-specific dispatch.

ADR-0016 did the hard part. ADR-0017 proved it by using it. ADR-0018 generalized execution behind
it. What remains is the last mile.

### 2.1 The last mile, precisely

Two things are still hardcoded:

**Adapter selection is a named import.** `runLifecycle({ adapter: OPENCODE_LIFECYCLE_ADAPTER, … })`
— the driver is generic, the lookup is not.

**`status` hand-rolls a per-host block.** `src/commands/status.mjs` imports eight functions directly
from `src/lib/opencode.mjs` to render opencode's rows, even though `detect` already returns facts in
the versioned `normalizedFacts` schema that a generic renderer could consume.

That is the whole gap. Closing it deletes host-specific code from `status.mjs` rather than adding
any — which is why both changes are worth making even if no external adapter is ever registered.

---

## 3. What is actually being proposed

An out-of-tree adapter is one module exporting one manifest, validated by the validators above:

```js
export const akHostAdapter = {
  contract: 1,
  host, projections: [], observability: [],
  lifecycle,          // detect / plan / apply / verify / undo
  execution,          // required iff canRouteActivities
  guidance: [],       // existing customBlocks row shape
};
```

Registered explicitly, in the user's own config:

```json
{ "hostAdapters": [ { "id": "hermes", "module": "@example/ak-host-hermes" } ] }
```

Four constraints make this safe to publish rather than merely convenient:

1. **Explicit registration, never a naming convention.** Scanning the global npm tree for
   `ak-host-*` would make an unrelated `npm install` sufficient to get third-party code executed
   inside ak on the next `ak status`. That is the fail-open pattern
   [ADR-0023](adr/0023-fail-closed-operations-and-explicit-degradation.md) exists to prevent.

2. **Disclosure, not a sandbox claim.** ak cannot sandbox an in-process module and the ADR does not
   pretend it can. The trust manifest gains a `third-party-adapter` kind naming the package, its
   resolved path, and its version, printed before any mutation — the same pre-disclosure surface
   ADR-0023 already requires elsewhere.

3. **Capability caps.** External adapters may not claim `canBePrimary`, an `aqeProvider`, or
   `commandStatusline`. Not distrust — those three carry first-party obligations ak cannot discharge
   for code it does not ship. The cap is exactly the shape OpenCode already occupies, so it is a
   tested configuration rather than new policy.

4. **Fail-closed per adapter.** A broken third-party adapter is reported and skipped; it must never
   brick `ak status` for the hosts that work. First-party registries keep throwing at construction,
   because a broken built-in *is* a build error.

Plus one thing said out loud rather than discovered later: **while the package is `4.0.0-alpha.*`,
this surface is unstable and may change between alphas.** Publishing an extension point acquires an
obligation, and the alpha statement is what keeps it bounded until there is evidence about what
actually needs to change.

---

## 4. Why hermes is a good first consumer

A contract never satisfied by code its authors did not write is a guess. Hermes is a useful test
precisely because it is awkward — it breaks five assumptions the three built-in hosts share:

| Built-in hosts assume | Hermes |
|---|---|
| JSON or TOML config | **YAML**, relocatable via `HERMES_HOME` and profiles |
| npm-installable | pip / uv / vendor installer — **no npm package** |
| A structured JSON or JSONL run mode | plain text on stdout |
| An interceptable permission event | none — headless mode auto-approves by contract |
| A ruflo `ENABLE_*` backend flag | none; ruflo's backend list is fixed |

The conformance result is the interesting part. Carrying hermes needed **one widening and one
guard**:

- a plain-text summary capture alongside `createJsonlSummaryCapture` in the shared subprocess base;
- a guard on `npmRoot(host.install.npmPackage)` in `src/lib/footprint/install.mjs`, since hermes is
  the first host with no npm package.

Everything else fit: the capability caps, the lifecycle verbs, ownership receipts, guidance rows,
`normalizedFacts`, and ADR-0018's handoff surface. That is a good result for a contract designed
without hermes in view, and it is the kind of evidence that only a genuine outside consumer
produces.

Two findings are worth reading even if the extension point is declined, because they are the sort of
thing that becomes a bug report later:

- **`hermes mcp add` is not safely idempotent.** Overwrite prompts with `default=False`; `remove`
  prompts with `default=True`; `_confirm` returns its default on `EOFError`, which is what a non-TTY
  `ak sync` supplies. A bare re-`add` prints "Cancelled." and **exits zero** — a silent no-op that
  reads as convergence. Hence remove-then-add.
- **`hermes -z` auto-approves everything.** It sets `HERMES_YOLO_MODE=1` by its own headless
  contract, so unlike OpenCode there is no permission event to intercept and no `permission_required`
  result to return. ADR-0030 discloses this at enable time rather than letting a hermes worker
  appear to carry a guarantee it does not have.

---

## 5. Who maintains what

| agentic-kit | The adapter author |
|---|---|
| The contract, its version, and its tests | The adapter and its tests |
| Registry admission and validation | `detect`/`plan`/`apply`/`verify`/`undo` |
| Driving the lifecycle | Its host's config writing — backup-first, merge-not-clobber |
| Command wiring (setup, sync, status, uninstall, `host pick`) | An execution adapter if routable |
| Trust disclosure before mutation | Honest capability declarations |
| Calling `undo` on teardown | Ownership receipts |
| A fixture adapter proving the contract in CI | Its host's correctness and vendor churn |

The hermes adapter is offered on those terms: authored and maintained outside this repository, by
the person who wants it, with agentic-kit owning only the contract it conforms to.

The package also stays **zero-runtime-dependency**. An adapter is something the *user* installs and
registers; it is never a dependency of `@pacphi/agentic-kit`. That property was load-bearing in the
hermes design too — it is why ADR-0030 drives `hermes config path` / `mcp add` instead of taking a
YAML library and writing hermes's config directly.

---

## 6. Scope

**In scope.** Registry-driven adapter selection; a `status` renderer over `normalizedFacts`; a
loader with explicit registration, contract versioning, capability caps, per-adapter fail-closed
admission, and trust disclosure; a fixture adapter in `tests/`; the `npmPackage` guard; a plain-text
subprocess capture.

**Out of scope.** A subprocess/RPC adapter protocol — genuinely sandboxable and language-agnostic,
and deferred rather than dismissed, because re-specifying two lifecycles as a wire protocol is a far
larger commitment than one requesting consumer justifies. Extension points for providers,
observability sources, or commands: providers are already declarable as data, and command extension
has no requesting use case. Any semver-stability promise, which belongs to a later decision made
with evidence.

**Explicitly not requested.** That hermes be vendored into this repository, that agentic-kit take on
hermes's correctness or NousResearch's release cadence, or that any built-in host's behavior change.

---

## 7. Sequencing

Each step is independently valuable and independently reversible.

1. **[#130](https://github.com/pacphi/agentic-kit/pull/130)** — an unrelated bug fix, already filed:
   `globalRoot()` misses Homebrew's kegged layout, failing six `provider-cli` tests on any
   Homebrew-node macOS checkout. Mentioned only because it currently blocks any new test evidence on
   such a machine.
2. **ADR-0028** — the local OpenAI-compatible provider. Independent of everything here, and useful
   to the hosts already shipped.
3. **ADR-0029** — this proposal, as a decision. Nothing is built until it is accepted.
4. **The two in-tree refactors**, which stand on their own merits: registry-driven selection, and
   `status` over `normalizedFacts`.
5. **ADR-0030** — the hermes adapter, published and maintained externally, returning conformance
   evidence.

Declining at step 3 costs nothing already spent, and steps 1 and 2 remain worth having.

---

## 8. The honest case against

- **A published contract acquires consumers, and consumers constrain refactors.** This is the real
  cost, and §3's alpha-instability statement bounds it rather than eliminating it.
- **One requesting consumer is thin evidence for a general mechanism.** A fair objection. The
  counter is that the mechanism is mostly already built and partly already adopted, so the marginal
  cost is a loader and two refactors that delete code — not a speculative framework.
- **In-process third-party code cannot be sandboxed.** True, and stated rather than mitigated. The
  disclosure surface is the honest version of the guarantee, in the same spirit as ADR-0018's
  trust-boundary section.
- **The status quo works.** It does — for three hosts chosen by one maintainer. The question this
  proposal raises is what happens at the fourth request, and whether it is better answered once than
  four times.
