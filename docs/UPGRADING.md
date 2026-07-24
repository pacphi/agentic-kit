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

## `sync` vs `setup` vs `provider pick`

| Command              | What it's for                                   | Changes your `kit.json` choices? |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `ak sync`            | update the binary + heal to your recorded state | **no** — converges, never decides |
| `ak x provider pick` | opt into / retune hosts & LLM providers         | **yes** — this is the switch     |
| `ak setup`           | first-time bootstrap of absent tooling          | only via explicit flags (`--codex`, `--primary-host`) |

If you already have `ak` working, you almost never need `ak setup` again — it's the
installer. Enabling a shipped-but-opt-in feature is a `provider pick` (or an `x mcp pick`,
etc.), not a re-`setup`.

## Worked example: adopting ambidextrous dual-host

You have an older `ak` and both the `claude` and `codex` CLIs installed, and you want the
ambidextrous dual-host experience (per-activity routing across Claude + Codex). Two motions:

```bash
ak sync                              # 1. update the binary (+ heal everything)
ak x provider pick --host claude,codex   # 2. opt in → wires dual-host
ak x provider status                 # 3. verify: hosts "enabled, wired" + routing table
```

Step 1 gets the newer code onto disk. Step 2 is what actually turns dual-host on — it
records `codex` in `kit.json` and does the wiring: writes `ENABLE_CODEX` into
`.claude/settings.local.json`, runs `ruflo init --dual`, seeds the per-activity routing
policy, registers the Codex↔ruflo MCP bridge both ways, and generates the dual-mode agents.
Add `--primary-host codex` if you want Codex to lead (Claude becomes the alternate).

> [!NOTE]
> `ak sync` self-updates **last** in its pass, so the newer code applies from your *next*
> `ak` invocation — which is exactly `ak x provider pick` in the sequence above. Running the
> two in this order is correct; the pick runs under the freshly-installed version.

From then on, `ak sync` **maintains** the choice — it re-applies your recorded dual-host
config idempotently on every run. `ak status` flags drift; `ak x provider off` reverts to
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

The second half covers the artifacts `ak` *renders*: managed guidance blocks in
`~/.claude/CLAUDE.md` and the project `AGENTS.md`, the Claude↔Codex MCP bridge (both
directions), and the statusline footer. These can drift with **no version change at all** —
a kit update (or, on an npm-linked dev checkout, merely merging a PR that edits a
`claude/*.md` template) revises the source of truth, and the rendered copies lag until the
next `ak sync`. Previously that lag was silent until someone happened to run `ak status`;
the nudge closes the window. It uses the exact drift definitions `ak status` uses (the two
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

## Where the design lives

The *why* behind primary-host selection and ambidextrous mirroring is captured as an ADR —
[docs/adr/0006-primary-host-and-ambidextrous-mirroring.md](adr/0006-primary-host-and-ambidextrous-mirroring.md).
The per-activity routing model spans ADR-0001..0005 (see [docs/adr/](adr/)). This page
deliberately links rather than restates them, so the ADRs stay the source of truth.
