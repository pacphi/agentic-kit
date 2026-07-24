# 0006 — Primary host & ambidextrous mirroring

Status: Accepted

## Context

ADRs 0001–0005 define the dual-host routing *policy* — which host+model runs each
activity. They assume Claude leads: the seeded defaults (grounded in rUv's shipped
templates) put Claude on the reasoning/review activities and Codex on execution, and
the escalation ladders point at Claude.

But both hosts run **concurrently** (ruflo's `DualModeOrchestrator` is host-symmetric —
an interactive coordinator plus headless workers, each worker carrying its own
`{platform, model}`; confirmed against `@claude-flow/codex` source). Enabling codex does
not disable claude. So "which host is enabled" and "which host **leads**" are different
questions, and the second was implicit and hard-wired to claude. Users who want Codex to
be the driving host with Claude as the alternate had no first-class way to express it, and
`ak status` treated an absent `claude` as a hard failure even when codex was meant to lead.

## Decision

Make **host leadership** a first-class, explicit axis, separate from host enablement:

1. **`providers.primaryHost`** (kit.json), default `'claude'`. Set via
   `ak x provider pick --primary-host claude|codex` and `ak setup --primary-host …`.
   Choosing codex as primary implies enabling codex.
2. **Codex-primary mirrors the default routing table** (`swapRoute`/`seedDualRouting({primary})`
   in `routing.mjs`): each default route flips to the opposite host (host + model + escalation
   ladder), so Codex takes the lead roles and Claude becomes the alternate/escalation target —
   the same ambidextrous experience with the roles inverted, not a separate mechanism.
   Re-seeding on a primary change only replaces a wholly-seeded policy; user `--route` edits
   are preserved.
3. **Primary-absent is a `status` failure; alternate-absent is a warning.** The severity of a
   missing host is relative to leadership, not hard-coded to claude.
4. **`drivingHost()`** detects which host runs the *current* session (env markers), falling
   back to `providers.primaryHost` — distinct from what's enabled.

Leadership is a defaults/policy choice only; it never disables the other host, and the
orchestrator stays symmetric underneath.

## Consequences

- Codex-primary is expressible in one flag at setup or pick time, with the whole experience
  (routing, escalation, status severity, dashboard indicator) following symmetrically.
- The default (claude-primary) is unchanged, so existing repos see no difference.
- The mirror is coarse where host model tiers don't line up (claude tiers ≠ codex tiers): a
  swapped route falls back to the counterpart host's recommended model. Users tune per activity
  with `--route`.
- `status`/dashboard must read `primaryHost` to render the correct severity + primary marker
  (done: `status.mjs` host rows, `dashboard-server.mjs` routing matrix).

See also `docs/PROVIDERS.md` §3.5 and the `claude/dual-mode-reference.md` managed block.
