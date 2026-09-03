# ADR-0043: Manage Ruflo's browser executor behind a replaceable boundary

- Status: Implemented
- Date: 2026-09-02
- Updated: 2026-09-02 — Linux ARM64 converges without retrying an unavailable
  Chrome for Testing payload; project and host policy boundaries are unchanged
- Context: issue #189 browser/runtime and capability-footprint verification

## Context

Ruflo 3.38.21 registers its browser MCP tools only when the `agent-browser`
command is available, and those tools shell out to that command. The published
`@claude-flow/browser@3.0.0-alpha.4` dependency accepts `agent-browser ^0.27.0`.
The current npm latest, 0.36.0, is outside that compatibility range, so a
generic install or latest-version updater is not a safe lifecycle.

Agent-browser also discovers repository `agent-browser.json` files by default.
That is inappropriate for a machine-curated MCP child because a repository can
then select an executable or plugin. The upstream report tracking that trust
boundary is [vercel-labs/agent-browser#1679](https://github.com/vercel-labs/agent-browser/issues/1679).

Ruflo's accepted
[ADR-036](https://github.com/ruvnet/ruflo/blob/main/ruflo/docs/adr/ADR-036-SERVO-RUST-BROWSER-MCP.md)
describes a future Servo backend. It is design intent, not released runtime
evidence: current Ruflo still uses agent-browser and no Servo-native package or
adapter is shipped.

## Decision

Agentic Kit manages the currently required agent-browser compatibility layer:

1. Node 22/23 receives exact `agent-browser@0.27.0`; Node 24+ receives exact
   `agent-browser@0.27.3`. Both are inside Ruflo's declared range. Generic npm
   latest drift does not apply.
2. The reviewed global lifecycle allowlist includes agent-browser because its
   postinstall downloads a native binary and rewrites its global shim. A zero
   npm exit is insufficient: the package manifest, package-owned native
   executable, and `--version` output must all agree before ownership is
   recorded.
3. A compatible pre-existing install can be used but remains external. An
   incompatible or receipt-drifted external install is reported and preserved.
4. Agentic Kit writes `~/.config/agentic-kit/agent-browser.json` with headless
   policy and passes its absolute path only to managed Ruflo MCP children through
   `AGENT_BROWSER_CONFIG`. It does not export browser settings to the user's
   shell or put trusted policy in a repository.
5. A local system Chrome or an agent-browser-owned Chrome for Testing payload
   can satisfy readiness. If neither exists, setup/sync may run the unprivileged
   `agent-browser install`; it never runs `install --with-deps` automatically.
   [Chrome for Testing has no Linux ARM64 distribution](https://github.com/GoogleChromeLabs/chrome-for-testing/issues/1),
   and agent-browser's installer rejects that target explicitly, so that platform
   instead converges with an external Chromium/Chrome requirement and no futile
   retry loop.
6. Status, System, and About expose package ownership, compatibility, native
   readiness, browser payload source, and MCP configuration separately. Their
   normal collectors never run doctor or launch a browser.
7. `ak uninstall` removes the trusted config by default. The global package is
   removed only with `--remove-agent-browser` or `--purge`, and only when its
   exact ownership receipt is current. Browser downloads, sessions, profiles,
   cookies, and authentication data are always preserved.
8. Agent-browser is not a Ruflo plugin, skill projection, host, provider, or
   managed companion. Agentic Kit does not install `@claude-flow/browser` or
   duplicate its skill catalog; Ruflo's existing MCP tool surface is the
   consumer.

## Servo transition

Do not implement or install Servo in Agentic Kit. Re-evaluate this adapter only
when a released Ruflo artifact exposes an observable backend capability and
actually defaults to Servo. During any upstream dual-backend window, retain a
receipt-owned agent-browser fallback until the released Ruflo build proves it
is unused. Only then stop new installs and offer receipt-gated removal.

## Consequences

Fresh setup gains browser capability without a second plugin/skill projection.
The lifecycle is more deliberate than a normal npm global because its version
authority is Ruflo compatibility rather than npm latest. MCP hosts must be
restarted or reconnected after configuration changes because stdio server
environments are captured when the process starts.
