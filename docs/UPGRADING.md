# Upgrading `ak` & adopting new capabilities

New `ak` features almost always ship **opt-in**. That means moving your machine to the
latest capability is *two* motions, not one: get the newer code, then turn the feature on.
This page exists because those two are easy to conflate — and `ak sync`, despite its name,
only does the first.

## The one rule

> **`ak sync` converges to the choices already recorded in `kit.json`.** It updates the
> `ak` binary and heals whatever has drifted, but it **never makes a new opt-in decision for
> you.** Adopting a capability that shipped after your install = run that capability's own
> opt-in command.

So a feature can be *installed* (the code is on disk) without being *enabled* (your
`kit.json` never asked for it). `ak sync` will faithfully keep re-applying claude-only if
that's what you recorded — the same way it won't pick an LLM provider or exclude an MCP
family on your behalf.

## `sync` vs `setup` vs `host pick`

| Command              | What it's for                                   | Changes your `kit.json` choices? |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `ak sync`            | update the binary + heal to your recorded state | **no** — converges, never decides |
| `ak host pick` | opt into or retune execution hosts and host routing | **yes** — this is the switch |
| `ak x statusline codex native\|extended` | opt into a user-wide Codex status-line preset | **yes** — records the preset |
| `ak setup`           | first-time bootstrap of absent tooling          | only via explicit flags (`--codex`, `--opencode`, `--primary-host`) |

| Migration surface   | What to know                                    |
| ------------------- | ----------------------------------------------- |
| `ak dual` → `ak run` | `ak dual` is a deprecated compatibility wrapper — existing scripts keep working (it warns on stderr and will be removed before the stable release); use `ak run` for new execution work. OpenCode routes require the current release — remove them before downgrading. `--escalate` exists on both, with deliberately different semantics: the wrapper retries the *whole pipeline* once on any failure; `ak run` advances only the *failed worker* one rung of its route's ladder per attempt (ADR-0019) and records the attempt trail in the result. |

A **host** runs the work; a **provider** serves inference. A binding can connect one provider to
several hosts through separate native configuration **projections**, while **observability**
sources establish facts with observed, configured, inferred, or unknown provenance. Upgrading does
not silently create, adopt, or rewrite these bindings, and credentials remain environment-only.
See [ADR-0016](adr/0016-capability-driven-integration-adapters.md).

`ak provider` and `ak x provider` are deprecated alpha compatibility aliases for the former
combined command. They warn on stderr and will be removed before stable. Use top-level `ak host`
for execution-host lifecycle and selection (`ak x host` only when you specifically want the
plumbing spelling). This namespace correction does not rename inference providers or provider
bindings into hosts.

If you already have `ak` working, you almost never need `ak setup` again — it's the
installer. Enabling a shipped-but-opt-in host feature is a `host pick` (or an `x mcp pick`,
etc.), not a re-`setup`.

Codex status-line management is deliberately not enabled merely because an
upgrade adds support for it. Run `ak x statusline codex native` once to opt in;
later `ak sync` runs converge that recorded choice. Use
`ak x statusline codex off` to relinquish ownership. See
[Managed Codex status line](CODEX-STATUSLINE.md).

## Worked example: adopting ambidextrous dual-host

You have an older `ak` and both the `claude` and `codex` CLIs installed, and you want the
ambidextrous dual-host experience (per-activity routing across Claude + Codex). Two motions:

```bash
ak sync                              # 1. update the binary (+ heal everything)
ak host pick --host claude,codex   # 2. opt in → wires dual-host
ak host status                 # 3. verify: hosts "enabled, wired" + routing table
```

Step 1 gets the newer code onto disk. Step 2 is what actually turns dual-host on — it
records `codex` in `kit.json` and does the wiring: writes `ENABLE_CODEX` into
`.claude/settings.local.json`, runs `ruflo init --dual`, seeds the per-activity routing
policy, registers the Codex↔ruflo MCP bridge both ways, and generates the dual-mode agents.
Add `--primary-host codex` if you want Codex to lead (Claude becomes the alternate).

> [!NOTE]
> `ak sync` self-updates **last** in its pass, so the newer code applies from your *next*
> `ak` invocation — which is exactly `ak host pick` in the sequence above. Running the
> two in this order is correct; the pick runs under the freshly-installed version.

From then on, `ak sync` **maintains** the choice — it re-applies your recorded dual-host
config idempotently on every run. `ak status` flags drift; `ak host off` reverts to
the claude-only default, reversibly.

The full menu of host/provider levels — QE provider selection, deterministic fallback
chains, per-activity routing defaults, undo — lives in [PROVIDERS.md](PROVIDERS.md). This
page is only about the *upgrade motion*.

## How drift surfaces (you don't have to go looking)

Every `ak` command ends with a best-effort, never-blocking drift nudge. It has two halves:

- **Version drift** (npm-managed tools; TTL-cached network check):
  `↑ ruflo 4.1.0 available (installed 4.0.0) — run: ak sync`
- **Local artifact drift** (spawn-light file compares, evaluated on every run):
  `↻ drifted: 2 CLAUDE.md block(s) · codex MCP unregistered — run: ak sync`

The second half covers the artifacts `ak` *renders*: managed guidance blocks in the
machine-wide guidance files (`~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` on codex
machines), the Claude↔Codex MCP bridge (both
directions), and the statusline footer. These can drift with **no version change at all** —
a kit update (or, on an npm-linked dev checkout, merely merging a PR that edits a
`claude/*.md` template) revises the source of truth, and the rendered copies lag until the
next `ak sync`. The nudge closes that window, using the exact drift definitions `ak status` uses (the two
can never disagree) and stays quiet after `status`, `sync`, and `ak x reference`, which
already show the same information.

## Why `ak sync` pulled a prerelease

The `4.0.0-alpha.*` train publishes to npm's **`next`** dist-tag, not `latest` (`latest`
stays pinned at the last stable-ish release). A naive "is there a newer version?" check
reads `latest` and would conclude your alpha is already ahead — so it would never offer the
upgrade.

`ak` handles this: when your **installed** version is itself a prerelease, the self-drift
check consults **both** the `latest` and `next` dist-tags and takes the higher of the two.
That's why `ak sync` on `alpha.19` correctly pulls `alpha.20` even though `latest` points
further back. (If you'd rather move it by hand: `npm i -g @pacphi/agentic-kit@next`.)

## Appendix — design references

The *why* behind primary-host selection and ambidextrous mirroring is captured as an ADR —
[docs/adr/0006-primary-host-and-ambidextrous-mirroring.md](adr/0006-primary-host-and-ambidextrous-mirroring.md).
The per-activity routing model spans ADR-0001..0005 (see [docs/adr/](adr/)). This page
deliberately links rather than restates them, so the ADRs stay the source of truth.
