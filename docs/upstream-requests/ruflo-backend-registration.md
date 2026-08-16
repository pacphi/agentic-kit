<!--
  DRAFT upstream capability request — NOT yet filed.
  Authored by agentic-kit for the ADR-0031 §4 upstream path. Review, RE-VERIFY the
  code references against ruflo (ruvnet/ruflo) HEAD (they are grounded against
  ruvnet/ruflo@45e65b5 as cited in ADR-0031 and may have moved), then file against
  https://github.com/ruvnet/ruflo and record the resulting issue number with
  `ak host adapters gate <adapter> session-driving ruvnet/ruflo#NNN`.
-->

# Feature request: a documented backend-registration surface for host CLIs

## Summary

ruflo's set of agent **backends** (the host CLIs that drive the loop) is enabled per-host
through fixed `ENABLE_*` flags. There is no documented way for a downstream tool to
register an *additional* backend, so a host CLI that a downstream integrator supervises
cannot become a ruflo-native backend without an upstream code change. We'd like a
documented registration surface for that.

## Where this stands today (please re-verify against HEAD)

Grounded against `ruvnet/ruflo@45e65b5` (as cited in agentic-kit's ADR-0031):

- Backend enablement is per-host and fixed: `ENABLE_CLAUDE_CODE`, `ENABLE_CODEX`,
  `ENABLE_GEMINI_MCP` (ADR-034 "Optional MCP Backends").
- A new backend is added by defining a new `ENABLE_*` target inside ruflo — there is no
  outside/plugin registration path.

If HEAD already exposes a backend-registration API or a documented plugin entrypoint, this
request may already be satisfied — please close it as such.

## The concrete ask

A documented way to register an additional agent backend from outside the ruflo tree, e.g.:

- a backend descriptor interface (how ruflo detects the CLI, launches an interactive /
  oneshot session, and observes completion) that a downstream package can implement and
  register, honored by the same loop the `ENABLE_*` backends drive; **or**
- a documented convention for an external backend entrypoint ruflo will discover and drive.

The goal is that a host CLI can *drive a ruflo session* as a first-class backend, not only
run under a downstream tool's own supervision.

## Why (the downstream context)

agentic-kit admits external host adapters and certifies them with a tiered conformance kit.
The `session-driving` tier — "the host actually drives an interactive/oneshot session" —
is the one an external adapter cannot clear on its own, because being a ruflo-native
backend is defined inside ruflo, not registered from outside. agentic-kit's honest interim
is to run such a host through its *own* supervised execution (`ak run`), and to mark the
tier `gated` on this request rather than fake a pass. A documented backend-registration
surface upstream is what lets that tier genuinely light up.

## Non-goals

- Not asking to bundle agentic-kit's hosts into ruflo.
- Not asking to loosen the trust model — a registered backend should be subject to the same
  enablement/consent posture as the built-in `ENABLE_*` backends.

## References

- agentic-kit ADR-0031 §4 (the upstream-request path) and ADR-0029 (the host-adapter
  contract).
- ruflo ADR-034 "Optional MCP Backends" and the `ENABLE_CLAUDE_CODE` / `ENABLE_CODEX` /
  `ENABLE_GEMINI_MCP` backend model (re-verify paths against HEAD).
