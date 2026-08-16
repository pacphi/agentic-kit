# Host-adapter contract freeze checklist (ADR-0029 §graduation, ADR-0031 §6)

The external host-adapter contract (`contract: 1`) is **experimental** and behind
`AK_EXPERIMENTAL_HOST_ADAPTERS=1`. This is the falsifiable checklist for freezing it —
turning `contract: 1` into a guaranteed-stable shape and dropping the flag. **Do not claim
the freeze until every box is genuinely checked against a real adapter.** The freeze is not
a maintainer's assertion; it is an earned, evidenced event.

## The freeze criterion (ADR-0031 §6, ADR-0029 graduation gate)

Freeze requires **all** of:

1. A **real external adapter** — maintained *outside this repository, by someone other than
   an agentic-kit maintainer* (Hermes is the expected first) — passes the full conformance
   kit against its real host.
2. That adapter completes **one full release's worth of soak** in the field with **no
   contract-shape change** required to keep it working.
3. Only then does the manifest **contract integer** freeze: `contract: 1` becomes stable,
   and any later breaking change ships as `contract: 2`, admitted alongside `contract: 1`.

Tier graduation and the contract freeze are distinct: an adapter can earn capability tiers
while the contract is still experimental.

## Readiness — machinery the freeze rests on (all shipped; verify before soak)

- [ ] Admission gate, hash-pinned consent, subprocess hook-runner, `admission` tier
      (ADR-0029).
- [ ] `ak host adapters trust` / `list` / `revoke` (+ `--expect-hash`).
- [ ] Remote manifest sources (file / `https` / `npm:`), resolve-before-hash.
- [ ] `ak run` drives an admitted routable host (cwd-anchored, exit-code authority,
      reserved 77/78, no trust laundering).
- [ ] Admitted lifecycle execution through setup / sync / uninstall.
- [ ] Tiered conformance kit: `admission`, `activity-routing`, `primary-eligible` pass
      against a real fixture; `session-driving` / `statusline` honestly gated.
- [ ] Capability-grant store + `grant`/`bless`, `gate`, `status`, `revoke-grant`; earned
      capability enforced at read time; granted caps live in the effective registry.

## Freeze gate — the real-adapter run (fill in with evidence, not intent)

- [ ] **Real external adapter identified**, maintained outside this repo by a non-maintainer.
      Adapter: `__________`  Maintainer: `__________`  Source: `__________`
- [ ] **Conformance report captured** from `ak host adapters conformance <name>` against the
      real host (attach or link the per-tier verdict).
  - [ ] `admission` passed
  - [ ] `activity-routing` passed
  - [ ] `primary-eligible` passed *(or consciously out of scope for this adapter)*
  - [ ] `session-driving` — passed **iff** the upstream ruflo backend-registration request
        ([ruvnet/ruflo#3046](https://github.com/ruvnet/ruflo/issues/3046)) has shipped; otherwise
        legitimately `gated` and recorded via `ak host adapters gate`.
  - [ ] `statusline` — `gated` remains acceptable at freeze (its render path is a later wave);
        the freeze is of the **contract shape**, not of every tier passing.
- [ ] **Hooks read** by a maintainer (the only executing part).
- [ ] **Grant/bless decision** recorded (blessed external adapter, or promoted built-in).
- [ ] **Soak: one full release** elapsed with the adapter in the field and **no
      contract-shape change** required. Release soaked through: `__________`.
- [ ] **No `contract: 1` shape change** was needed during soak (if one was, the clock resets).

## Only when every box above is genuinely checked

- [ ] Set the manifest `contract` shape to frozen; document that a breaking change now ships
      as `contract: 2` admitted alongside `contract: 1`.
- [ ] Drop `AK_EXPERIMENTAL_HOST_ADAPTERS` gating for the frozen surface (or flip its default),
      per the ADR-0029/0031 freeze decision.
- [ ] Update ADR-0029 (graduation gate) and ADR-0031 §6 status to **frozen**, dated, with the
      adapter + release that earned it.

## Honest ceilings that do NOT block the freeze

The freeze is of the **contract shape**, not of universal tier passage. These stay open by
design and are recorded as gated, not as failures:

- `session-driving` until ruflo ships a backend-registration surface (filed:
  [ruvnet/ruflo#3046](https://github.com/ruvnet/ruflo/issues/3046)).
- An `aqeProvider` identity until agentic-qe ships a provider-plugin API (filed:
  [proffesor-for-testing/agentic-qe#628](https://github.com/proffesor-for-testing/agentic-qe/issues/628)).
- `statusline` runtime rendering (no `ak` render surface for a third-party TUI yet).
- Grant *consumption* last-mile: selecting an external host as primary, and a `commandStatusline`
  runtime reader.
