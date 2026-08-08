# ADR-0003 — Auto-seed on dual-host, subscription-only, per-route provenance

- **Status:** Amended by [ADR-0020](0020-ga-stable-surfaces.md)
- **Date:** 2026-07-23
- **Updated:** 2026-08-07
- **Update note:** Preserved subscription-safe seeding and provenance while moving intent to the
  canonical routing envelope; separated model **retirement** from route **divergence** (2026-08-07).
- **Deciders:** agentic-kit maintainers

> **GA amendment:** subscription-safe seeding and user-intent preservation remain. The persisted
> paths and command spellings below are historical; ADR-0020 defines the GA schema and commands.

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

### Amendment (2026-08-07) — retired models are not divergence

Provenance answers "may ak change this value?". It does **not** answer "does this value still work?",
and one case needs both: a model the host has **withdrawn**. A route naming one is not a stale
preference, it is a scheduled hard failure — `gpt-5.4` and `gpt-5.4-mini` stop answering in Codex on
2026-08-31, and `gpt-5.3-codex` already has.

So retirement is separated from divergence, and the two are handled differently:

| | divergence (`divergedRoutes`) | retirement (`RETIRED_MODELS`) |
|---|---|---|
| what happened | the defaults moved | the model stops answering |
| is there a trade? | yes — a newer default can cost 2–3× the agentic turns | no |
| reported as | a choice, with both models' cost-per-task notes | a fact, with the retirement date |
| cleared by | an explicit `ak x host refresh` | `ak sync`, automatically |
| touches a `user` pin? | never | **substituted at read time, never rewritten on disk** |

That last row is the only place ak overrides deliberate user intent, and it is deliberate: honoring a
pin into a model that no longer exists fails the run rather than respecting the pin. The override is
confined to `resolveRoutes()` — the read boundary every dispatch path already goes through — so the
file on disk still says what the user wrote, and every surface that shows the substituted model also
names the id it replaced (`retiredFrom`).

Because this power is easy to misuse, `RETIRED_MODELS` admits **only** models with a published
withdrawal notice from the host, cited in the map. "We would rather they used the newer one" is
divergence, not retirement — `claude-opus-4-8` is the worked example: superseded as a default, no
deprecation notice, therefore deliberately absent from the map and still pinnable.

## Consequences

- **Zero-step** onboarding for dual-host users; **no cost surprise** (subscription/local only).
- User overrides are **durable** across syncs and version upgrades.
- Single-host users are unaffected — nothing is seeded, projections stay empty, behavior is unchanged.
- Requires tracking `source` on each route and honoring it in every write path (seed, pick, sync, refresh).
- If a route later points at a now-disabled host, `ak status` warns rather than silently mutating it.
- A retired model can never be dispatched, whatever the policy on disk says — but the substitution is
  invisible unless surfaces render `retiredFrom`, so every route-rendering surface must carry it.
- `RETIRED_MODELS` needs maintaining against host deprecation notices. A missed entry degrades to a
  failed run with a clear upstream error; a *wrong* entry silently ignores a user's pin, which is far
  worse — hence the citation requirement.

## References

- `src/lib/routing.mjs` `RETIRED_MODELS`, `retirementOf`, `migrateRetiredRoutes`, `resolveRoutes`
- `src/lib/providers.mjs` `bothHostsEnabled`, `migrateRetiredRoutesInConfig`, `_managedBy` / `.bak`
  discipline (`applyAqeRouter`, `undoAqeRouter`, `writeJsonWithBackup`)
- `tests/kit/routing-retirement.test.mjs`
- ADR-0001, ADR-0002
