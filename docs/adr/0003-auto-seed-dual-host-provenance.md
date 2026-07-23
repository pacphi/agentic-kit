# ADR-0003 — Auto-seed on dual-host, subscription-only, per-route provenance

- **Status:** Accepted
- **Date:** 2026-07-23
- **Deciders:** agentic-kit maintainers

## Context

The desired UX: when a user has **both** the Claude and Codex hosts, per-activity routing should "just work"
with sensible defaults (zero extra steps), while the user stays **aware** of those defaults and can **change**
any of them. Two risks to manage:

1. **Cost surprise** — silently routing work to a *metered* provider would spend money the user didn't intend.
2. **Clobbering user intent** — a naive "reapply defaults on every sync" would overwrite a user's deliberate
   override whenever ak's defaults change.

`ak`'s existing ethos already covers file-level safety (`_managedBy: agentic-kit` tag + one-time `.bak` +
"never touch a file we didn't write"). We need the same discipline one level finer — per route.

## Decision

**Auto-seed** `providers.dualRouting` from the ADR-0002 defaults **only when** all hold: both hosts enabled in
`kit.json` (`bothHostsEnabled`), installed `agentic-qe ≥ 3.13.1`, and the seeded routes target **only
subscription/local hosts** (`claude-code`, `codex`, `ollama` — never a metered API provider). Seeding happens
in `ak x provider pick` and `ak setup`; it prints the resulting activity-routing table.

Every `ActivityRoute` carries **provenance**: `source: 'default' | 'seeded' | 'user'`.

- `default` — the built-in value (in code, not yet written to disk).
- `seeded` — auto-written by ak from defaults.
- `user` — the user changed it (via `ak x provider pick --route`, the interactive editor, or a hand edit).

`ak` refreshes only `default`/`seeded` routes (e.g. when an aqe upgrade improves defaults). A `user` route is
**never clobbered**. `ak sync` reasserts the policy but never re-seeds or overwrites `user` routes.
`ak x provider off` clears the whole policy and reverts projections.

## Consequences

- **Zero-step** onboarding for dual-host users; **no cost surprise** (subscription/local only).
- User overrides are **durable** across syncs and version upgrades.
- Single-host users are unaffected — nothing is seeded, projections stay empty, behavior is unchanged.
- Requires tracking `source` on each route and honoring it in every write path (seed, pick, sync, refresh).
- If a route later points at a now-disabled host, `ak status` warns rather than silently mutating it.

## References

- `src/lib/providers.mjs` `bothHostsEnabled`, `_managedBy` / `.bak` discipline (`applyAqeRouter`,
  `undoAqeRouter`, `writeJsonWithBackup`)
- ADR-0001, ADR-0002
