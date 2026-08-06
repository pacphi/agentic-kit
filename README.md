# 🧰 @pacphi/agentic-kit

[![CI](https://github.com/pacphi/agentic-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/pacphi/agentic-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pacphi/agentic-kit/next?label=npm%40next)](https://www.npmjs.com/package/@pacphi/agentic-kit)
[![node](https://img.shields.io/node/v/@pacphi/agentic-kit)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/@pacphi/agentic-kit)](LICENSE)

**One npm package that installs, heals, and *proves* [ruflo](https://github.com/ruvnet/ruflo) (claude-flow) + [agentic-qe](https://github.com/proffesor-for-testing/agentic-qe), grounds them in *RuvNet Brain* — an offline, source-cited knowledge base over the rUv stack — and wires Claude Code + Codex (+ opencode) into one ambidextrous, self-routing setup. macOS · Linux · Windows.**

```bash
npm install -g @pacphi/agentic-kit@next   # alpha channel until 4.0.0 GA
ak setup            # once per machine; run inside a git repo to set that project up too
ak setup --codex    # …or bring up Claude + Codex together in one shot
ak setup --opencode # …and wire ruflo + ruvnet-brain into opencode (third host)
```

> [!IMPORTANT]
> That's the only package you install by hand — **you do not need to install ruflo or
> agentic-qe yourself.** `ak setup` installs them globally for you (building natives past
> npm ≥11.17's `allow-scripts` gate), then heals and proves them.

`npm install -g` is the recommended interactive install, but it is not the only
way to run the package. Local dependencies, `npm exec`/`npx`, verified tarballs,
Git revisions, and contributor links have different package footprints while
`ak setup` retains the same machine/user/project effects. See
[Installation and scope](docs/INSTALLATION.md) before choosing a non-global method
or deploying on a shared machine.

**What you get:**

- **One command** installs + heals + *proves* ruflo & agentic-qe — native SQLite, memory, security, statusline (past npm's `allow-scripts` gate).
- **Source-grounded knowledge:** *RuvNet Brain* — an offline knowledge base over the rUv stack — powers the `search_ruvnet` MCP tool, so answers about ruflo/AgentDB/RVF/SPARC cite real source instead of stale training priors.
- **Multi-host execution (optional):** Claude, Codex, and opt-in OpenCode can share one activity policy; `ak run` is the canonical executor, while `ak setup --codex` enables the subscription-backed Claude/Codex defaults.
- **Self-healing:** `ak sync` re-converges after every upgrade; `ak status` and a local dashboard show what's *actually* on — never assumed.
- **Honest by construction:** every guard traces to a filed upstream issue, and `ak x verify` proves the paths end-to-end against real CLIs.
- Cross-platform, **zero runtime dependencies** (SQLite embedded).

## Hosts, providers, and bindings

A **host** is the agent CLI driving a session (Claude Code, Codex CLI, or OpenCode). A
**provider** serves inference (Anthropic, OpenAI, OpenRouter, or Ollama). A **projection** is a
native configuration surface, and an **observability source** supplies transcript, usage, quota,
or catalogue evidence. A **binding** connects a host to a provider through a supported projection
and transport.

Those axes do not imply one another. OpenRouter is a provider behind a host, not another host.
Ollama can have independent bindings through Claude and Codex. OpenCode is an opt-in, explicitly
routable host through `ak run`, but it is never a primary host or AQE provider. Provider, model,
and billing claims state whether they are observed, configured, inferred, or unknown. Design
record: [docs/adr/0016-capability-driven-integration-adapters.md](docs/adr/0016-capability-driven-integration-adapters.md).

For a capability-by-capability comparison of Claude, Codex, and OpenCode across
Ruflo, agentic-qe, and RuvNet Brain—including current limitations and upstream
issues—see [Host support](docs/HOST-SUPPORT.md).

## Why this exists

ruflo promises persistent memory, self-learning, security scanning, and background
workers for Claude Code. In practice, a stock install drifts into quietly broken
states: native SQLite bindings get dropped by npm upgrades (memory writes vanish
while printing "OK"), packages the CLI still imports stop shipping
([#2670](https://github.com/ruvnet/ruflo/issues/2670) left prompt-injection defense
silently dead), pattern stores corrupt on interrupted writes, statuslines regenerate
without telling you what's actually on, and background daemons used to burn tokens
unsupervised. Upstream fixes land steadily — this kit's job is the *gap*: detect
drift, converge to a healthy state, and **prove it** rather than assume it.

The full investigative history behind each guard (with filed upstream issues) lives
in [docs/archive/](docs/archive/).

## The commands

```text
ak              status + one suggested next action
ak setup        first-time setup — machine and/or the project you're standing in
                [--codex] [--opencode] [--primary-host claude|codex] [--project] [--minimal] [--yes] [--no-aqe] [--no-security] [--reconfigure]
ak status       read-only dashboard: what's true, what's drifted   [--json] [--deep]
ak sync         converge to good: upgrade + heal + verify          [--dry-run] [--no-upgrade]
ak dashboard    open the local web dashboard (auto-opens your browser)
                [--port N] [--no-open] [--live-source 'surface=path']
ak about        what each installed component is and why it's there
ak system       machine footprint: install size, runtime, storage, catalog, projects
                [--deep] [--json]
ak usage        inspect/refresh offline provider account analytics
                status | refresh openrouter
ak host         manage execution hosts, routing, and provider bindings
                status | pick | refresh | off
ak run          execute a host-neutral activity pipeline (including explicit OpenCode routes)
                <template> "<task>"  [--dry-run] [--route ...] [--max-concurrent N] [--timeout ms] [--json]
ak x statusline manage Codex's native user-wide status line          status | codex native|extended|off
ak uninstall    leave cleanly                [--dry-run] [--this-project] [--remove-ruflo] [--remove-aqe] [--purge] [--yes]
```

> [!TIP]
> **When in doubt: `ak sync`.** Every mutating command takes `--dry-run` and
> prints its plan with reasons — you always see the impact before anything changes.

`ak` is the daily-driver alias; the full `agentic-kit` command is identical.
(Heads-up if you also use AutoKitteh: its CLI is also named `ak` — the full
command always works.)

<details>
<summary>What the verbs cover</summary>

| Verb | What it does |
| ------ | -------------- |
| **setup** | Installs/updates ruflo + agentic-qe + the **agentdb** CLI globally (handling npm ≥11.17's `allow-scripts` so natives build; agentdb is pinned to ruflo's bundled version so the shared learning store stays coherent), installs the **RuvNet Brain** (an offline knowledge base over the rUv stack, powering the `search_ruvnet` MCP — a ~2 GB one-time download, prompted; skip with `--no-ruvnet-brain`), deploys the token-audit skill, merges the managed guidance blocks into the machine-wide guidance files (`~/.claude/CLAUDE.md`, plus `~/.codex/AGENTS.md` on codex machines), offers one-time MCP registration (user scope, with a tool-family picker), and — inside a repo — initializes the project: sanitized `ruflo init`, absolute memory-path pin, a **verified** store→disk write, statusline footer, and a background daemon with **local-only ($0) workers** (token-spending AI workers stay opt-in behind upstream's machine-wide budget). Project scope triggers on a `.git` entry in the current folder; without one it's skipped with a note. `--project` forces the same project setup in the current directory (e.g. a not-yet-`git init`-ed folder); it does not locate an ancestor repository. Project initialization runs `ruflo init --full --force` and can replace existing agent configuration, so read the [setup scope and project mutation contract](docs/SETUP.md) before using it on an existing project. `--minimal` skips it, `--yes` accepts all prompts (non-interactive), `--no-aqe` / `--no-ruvnet-brain` / `--no-security` disable those subsystems, and `--reconfigure` re-offers MCP registration. `--codex` enables + installs the Codex host during setup (ambidextrous dual-host mode; both hosts then run at once), and `--primary-host claude\|codex` picks which host leads (codex implies `--codex`). |
| **status** | Per-subsystem ✓/⚠/✗ (versions, the kit's own version, **ruvnet-brain** (present + release drift, or "not installed"), natives (agentdb copies **and** ruflo's own memory runtime — the one `npx ruflo memory` loads — load-tested for a native better-sqlite3, not just the agentdb dirs), **memory-pin** (warns when `CLAUDE_FLOW_DB_PATH` points off the live DB), security, learning, aqe/RVF, **agentdb** (CLI present + coherent with ruflo's bundled version, or a store-skew warning), MCP, **hosts** (claude/codex/opencode version + install method; the Claude/Codex **primary** marked and failed when absent), **providers** (host wiring + aqe fallback chain, or "drifted"/claude-only default), **routing** (the persisted activity host+model policy; only Claude/Codex routes project into AQE), daemons, guidance-file blocks (`~/.claude/CLAUDE.md`, project `AGENTS.md`, and `~/.codex/AGENTS.md` on codex machines), statusline), each drift row naming what `sync` would do about it — plus a **health-history** line that flags regressions since the last sync (learning shrank, native slots dropped, drift/security backslid). |
| **sync** | The one convergence verb: upgrades first when a new release exists, then re-heals everything an upgrade wipes, then re-checks and reports. Included in that heal: it **installs any enabled frontier host** (claude/codex/opencode) that's entirely absent — never touching an external (mise/brew/native) install — and **re-applies provider wiring** (the `ENABLE_*` host env, OpenCode's native configuration, the aqe fallback chain, and ruflo API providers) whenever it has drifted — and, on a dual-host project, **seeds/heals the Claude/Codex default routing policy** (materializing eligible routes into agentic-qe's `agentOverrides`, e.g. after an aqe upgrade first makes it eligible). It also **installs/repins the standalone `agentdb` CLI** to ruflo's bundled version (keeping the shared cognitive store coherent) and appends a **health-history snapshot** so `status` can flag regressions across syncs. It also **re-runs the RuvNet Brain installer** to pull the latest release when the on-disk KB has drifted (or installs it if absent, when enabled). It also **self-updates the kit**: when a newer `@pacphi/agentic-kit` exists it installs it as the *last* step (the new code applies from the next `ak` run, never mid-sync). Prerelease installs (`4.0.0-alpha.*`) track the `next` npm dist-tag as well as `latest`, so alphas see their successors; stable installs only ever follow `latest`. `--no-upgrade` skips the self-update along with the package upgrades. |
| **dashboard** | Opens an observation-only local web dashboard (`127.0.0.1:7431`, localhost-only, never detaches) with three primary areas: **Overview · Usage · Observability**. One fixed, left-aligned secondary rail exposes Overview's Summary/Hosts & Routing/Providers/Runtime/Intelligence views, Usage's Scorecard/Limits/Findings/Sessions/Transcript views, and Observability's Live/History scopes. Canonical deep links are hierarchical (`#overview/summary`, `#usage/sessions`, `#usage/<session-id>`, `#observability/live`); arrow keys plus Home/End operate focused tab rows. Usage indexes local Claude/Codex/OpenCode transcripts on demand. Observability groups eligible sessions by project and pairs an interactive agent/tool execution canvas with masked transcript or review evidence; its Session Stream can collapse without disconnecting so Agent activity gets more room. Live shows only current roots; History shows only retained non-live roots. A bounded owner-only cache retains safe last-recorded workspace context; no dashboard action mutates agents or repositories. Ruflo and agentic-qe stores are opt-in through repeatable `--live-source 'surface=path'`. The page is self-contained, offline-first, localhost-only, and protected by a per-session token. See the [Dashboard guide](docs/DASHBOARD.md) and [Observability guide](docs/OBSERVABILITY.md). **Auto-opens your browser** (`--no-open` for headless/SSH); `--port N` changes the port. Stop with Ctrl-C. (Also available as `ak x dashboard`.) |
| **usage** | Reads provider-account analytics from local cache (`ak usage status`) or performs one explicit OpenRouter management-API refresh (`ak usage refresh openrouter`). Refresh requires `OPENROUTER_MANAGEMENT_KEY`, writes a credential-free mode-`0600` cache, and discards endpoint/user/key/session identifiers. `status` and dashboard reads make no network request. OpenRouter account rows have no grounded host/session/project correlation and are never merged into transcript totals. |
| **admin** | Opens the **maintainer admin** (`127.0.0.1:7432`, localhost-only, foreground) — the project-telemetry sibling of `dashboard`, with the same dark/light visual theme and persisted theme preference: unique repo visitors and cloners (GitHub traffic API, needs a push-access token via `GITHUB_TOKEN`/`GH_TOKEN`/`gh auth token` — panels degrade honestly without one), contributors and watchers, npm download momentum (last 7d vs prior 7d, sparklines — shown as trend only, never an absolute reach number, since mirrors/CI inflate the raw count), latest CI run status and open Dependabot alerts, a **"since you last looked"** delta strip over a local baseline, open issues/PRs from others (oldest first), and external humans ranked by recency (bots excluded). Access is gated by a **per-session token** carried in the URL fragment and sent header-only; the page makes **zero external fetches** (the server proxies GitHub/npm; your credential never reaches the page or the payload). Where `dashboard` is offline-first, `admin` does deliberate GitHub/npm egress — that contract split is why they're siblings, not tabs. `--port N`, `--no-open`; Ctrl-C stops. (Also available as `ak x admin`.) |
| **run** | **Canonical execution surface.** Executes the template vocabulary through host-neutral supervised adapters. It accepts an explicit OpenCode route (persisted or `--route`) alongside Claude/Codex; `--dry-run` prints the exact static plan (with each worker's escalation ladder); at runtime, successful dependencies pass runtime-only, sanitized handoffs capped at 2 KiB each/8 KiB fan-in, never exposed in public JSON. A handoff may cross hosts/vendors and must exclude secrets, credentials, raw logs, and transcript excerpts. `--escalate` advances a failed worker one rung of its route's ladder per attempt (bounded by the ladder; permission/consent and uncertain results are never escalated). `--timeout` is one absolute readiness→prepare→launch→observe budget per attempt, while separately bounded teardown proves whether resources terminated. An OpenCode worker runs an isolated loopback server with ephemeral basic authentication, returns only normalized observed facts, and aborts instead of approving a permission request. `ak run` does not turn OpenCode into an AQE provider or primary host. |
| **host** | Execution-host status, selection, primary-host choice, activity routing, and reversible teardown: `ak host status\|pick\|refresh\|off`. The plumbing spelling is `ak x host`. Inference providers and bindings remain separate concepts even though their controls share this workflow. |
| **uninstall** | Removes the kit's footprint (and any legacy shell-kit install); project data is never touched; `--purge` also offers to remove the global packages. |

</details>

Power-user mechanisms live under `ak x …` (`daemon-gc`, `harvest`,
`mcp pick|off`, `host status|pick|refresh|off`, `reference diff|sync`,
`statusline status|codex native|extended|off`,
`verify learning|security|aqe|providers|harvest`, `improvement-eval`) — see `ak --help --all`.

One of those is worth calling out:

- **`ak x harvest`** — an **opt-in** (`kit.json` `harvest:true`), foreground learning-*write*:
  it records the session outcome and consolidates accumulated episodes into durable skills via
  the real `ruflo hooks post-task` / `agentdb skill consolidate` verbs, reporting the actual
  skills created/updated. Off and `--dry-run`-safe by default; no daemon, ever.
  `ak x verify harvest` proves the whole path end-to-end against real CLIs.

## The status line

Projects set up by the kit get an append-only footer under ruflo's own status line,
each segment shown **only when genuinely active**: 🧠 SONA patterns/trajectories (+
live micro-LoRA Δ‖W‖), 📈 route-RL metrics, 🛡 aidefence, 🧿 RuvNet Brain KB,
⚙ machine-wide daemon count, and 🎓 Agentic-QE stats.

That rich, command-backed footer is a Claude Code surface. Codex supports a
single native line made from built-in fields instead. Opt into a compact
machine-wide preset with `ak x statusline codex native` (or use `extended` on
a wide terminal); `ak sync` then keeps the selected preset converged without
rewriting unrelated `~/.codex/config.toml` settings. See
[Managed Codex status line](docs/CODEX-STATUSLINE.md) for fields, ownership,
rollback, and the current parity boundary.

## Requirements

Node ≥ 22, npm, and the `claude` CLI (Claude Code). That's the whole list —
**ruflo and agentic-qe are not prerequisites; `ak setup` installs them for you**
(pre-installing them is fine too — setup just detects and reuses them). Everything
else — including SQLite — is embedded; there are no runtime dependencies. npm stays
required at runtime even though this repo develops with pnpm: the kit heals the
*npm-managed* global ruflo/agentic-qe trees (`npm root -g`, `npm i -g`), which is how
those packages are installed on target machines. (pnpm-managed globals: tracked follow-up.)

### Frontier hosts & LLM providers

`ak` detects the frontier-agent CLIs on your machine and can wire ruflo + agentic-qe to
one or both — **claude-default, codex opt-in**, so existing repos see zero change until
you opt in.

<details>
<summary>Two independent axes: hosts, providers, and per-activity routing</summary>

- **Hosts** — which agent CLI runs the ruflo loop: `claude` (Claude Code) and/or `codex`
  (OpenAI Codex), **both at once** in ambidextrous dual-host mode (enabling codex doesn't disable claude).
  Turn codex on at first-time setup with `ak setup --codex` (add `--primary-host codex` to
  make it lead), or later with `ak host pick`. A host that is *entirely absent* is
  installed for you (`npm i -g @anthropic-ai/claude-code` / `@openai/codex`); an
  externally-managed install (mise/brew/native) is detected, reused, and never shadowed.
- **Providers** — which LLM the routers use, independent of the host: agentic-qe's
  `AQE_LLM_PROVIDER` (`claude-code`/`claude`/`openai`/`gemini`/`openrouter`/`azure-openai`/
  `bedrock`/`cognitum`/`ollama`/`onnx`) plus an ordered fallback chain, and ruflo's API providers.
  API keys stay in the environment — never written to `kit.json`.

> [!NOTE]
> ruflo and agentic-qe keep **separate config stores** — they don't share one file. `ak`
> converges both from `kit.json`. Which store to edit for which knob is in
> [docs/PROVIDERS.md](docs/PROVIDERS.md#two-configs-one-front-door).

- **Per-activity routing** — when **both** hosts are enabled (and agentic-qe ≥ 3.13.1), `ak` seeds a
  policy that routes each kind of work to the host + model that suits it — Claude for architecture,
  design, review; Codex for implementation, testing — and materializes it into agentic-qe's
  `agentOverrides` (adopting upstream [#568](https://github.com/proffesor-for-testing/agentic-qe/issues/568)).
  It's seeded automatically (subscription-only, so no metered surprises), shown in `status` and the
  dashboard matrix, and **tunable per activity** (`ak host pick --route 'testing:claude:claude-sonnet-5'`)
  with your edits preserved across syncs. **`--primary-host claude|codex`** chooses which host leads:
  codex-primary *mirrors* the default table so Codex drives and Claude is the alternate — symmetric
  either way. `ak run <template> "<task>"` executes a materialized plan from that policy. Nothing is
  seeded for claude-only projects.

  **OpenCode is explicit, not seeded.** Enable it with `ak host pick --host claude,opencode`,
  then route a compatible activity through `ak run`, for example
  `ak run security "src/auth/" --route 'security-scan:opencode:provider/model'`.
  OpenCode routes are not projected to AQE, do not affect vendor-diversity claims, and cannot be a
  primary host.

`ak host status` shows what's detected, wired, and routed; `ak host pick` chooses and
applies (reversibly); `ak host off` restores the claude-only default. Full guide:
[docs/PROVIDERS.md](docs/PROVIDERS.md). Already on an older `ak` and adopting a later capability
(like dual-host)? [docs/UPGRADING.md](docs/UPGRADING.md) covers the `sync` vs `host pick` motion.
The detailed compatibility matrix is in [docs/HOST-SUPPORT.md](docs/HOST-SUPPORT.md).

</details>

### opencode host (opt-in)

[opencode](https://opencode.ai) is a third host alongside claude/codex — wired through its own
native surfaces rather than env flags.

<details>
<summary>What <code>ak setup --opencode</code> / <code>ak sync</code> converge</summary>

`ak setup --opencode` (or `integrations.hosts.opencode: true`
in `kit.json`) converges, on every `ak sync`:

- **`~/.config/opencode/opencode.json`** — the `claude-flow` MCP server (ruflo's 300+ tools,
  via `claude-flow-mcp` with `ruflo mcp start` fallback) and `ruvnet-brain` MCP (the
  stable-spine shim, hot-swapped on brain updates), plus ruflo's `skills.paths` and
  pre-approved `permission` patterns — merged backup-first into whatever you already have
  (a JSONC file ak can't parse is refused, never clobbered). Opting in authorizes the
  `claude-flow_*` and `ruvnet-brain_*` MCP tool families without per-call prompts; use
  OpenCode's permission configuration if you need narrower approval policy.
- **Lifecycle hooks** — `~/.config/opencode/plugins/ruflo-hooks.js`: session restore/end,
  best-effort bash safety screening (defense-in-depth, fail-open if the local handler is
  unavailable), edit/task outcome recording for ruflo's learning substrate
  (opencode has no settings-hooks surface; its plugin events are the hook spine).
- **Subagents + skills** — ruflo's agent set converted to opencode subagents
  (`~/.config/opencode/agents/`, re-converted whenever the catalog source changes) and the
  platform skill (`~/.config/opencode/skills/ruflo/`). The catalog source resolves
  automatically: claude marketplace clone (full set, auto-updated) → published
  `@claude-flow/cli` package (substrate set); override via
  `integrations.ownership.opencode.catalogDir` or `$RUFLO_REPO`.
- **Guidance** — `~/.config/opencode/AGENTS.md` gets ak's managed blocks with
  opencode-correct tool names (`claude-flow_*`, `ruvnet-brain_search_ruvnet`).

Everything is ownership-recorded (`integrations.ownership.opencode.mcp`) and stripped surgically by
`ak host off` / `ak uninstall` — your own opencode.json entries are never touched.

**Execution routing.** `ak run` is the host-neutral runner for explicit OpenCode routes. For
each worker it starts an owned `opencode serve` instance on loopback with an ephemeral basic-auth
password, creates an isolated session, and returns normalized terminal evidence. A timeout or
cancellation aborts the session before the owned server is terminated. A permission request is
reported as blocked and aborted — `ak` never supplies `--auto` or changes your OpenCode permission
policy. The configured `provider/model` selector is not provider or billing evidence; those facts
remain unknown unless OpenCode reports them in the terminal session data.
Design record: [docs/adr/0017-opencode-host.md](docs/adr/0017-opencode-host.md).

</details>

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → `agentic-kit` command.

[docs/INSTALLATION.md](docs/INSTALLATION.md) — global versus local, one-shot,
tarball, Git, and source-checkout installs, including user/machine/project impact.

[docs/HOST-SUPPORT.md](docs/HOST-SUPPORT.md) — Claude, Codex, and OpenCode support
across Ruflo, AQE, and RuvNet Brain, with limitations and current upstream risks.

[docs/DASHBOARD.md](docs/DASHBOARD.md) — dashboard navigation, deep links, keyboard behavior, and
the meaning of each primary and secondary view.

## How tools are managed

[docs/MANAGED-TOOLS.md](docs/MANAGED-TOOLS.md) — the consistency contract every
managed tool follows (release-pinned installs, sync as the single updater,
disk-first version truth, one drift story across status/statusline/dashboard),
with the per-tool table and the checklist for adding a new tool.

## Domain design

[docs/ddd/](docs/ddd/) defines the shared language, bounded contexts, and invariants behind hosts,
inference providers, bindings, routing, orchestration, evidence, usage, and Observability. ADRs
explain why decisions were made; the domain documents define what those concepts mean across the
codebase.

## Credits

### Upstream & prior art

- [rUv](https://github.com/ruvnet) — [ruflo/claude-flow](https://github.com/ruvnet/ruflo); upstream issues filed from this kit's verification work: [#2219](https://github.com/ruvnet/ruflo/issues/2219), [#2222](https://github.com/ruvnet/ruflo/issues/2222), [#2239](https://github.com/ruvnet/ruflo/issues/2239), [#2360](https://github.com/ruvnet/ruflo/issues/2360), [#2549](https://github.com/ruvnet/ruflo/issues/2549), [#2670](https://github.com/ruvnet/ruflo/issues/2670)
- [Dragan Spiridonov](https://github.com/proffesor-for-testing) — [agentic-qe](https://github.com/proffesor-for-testing/agentic-qe)
- [Stuart Kerr](https://github.com/stuinfla) — [RuvNet Brain](https://github.com/stuinfla/ruvnet-brain), the source-grounded knowledge base over the rUv stack that `ak setup` installs and `ak sync` keeps current
- [Ciprian Melian](https://github.com/ciprianmelian) — prior art: [repair gist](https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6)

### Contributors

Thanks to everyone who opened PRs against this kit (v4.0.0-alpha.15 through the
current release):

- [@robertelee78](https://github.com/robertelee78) — [#67](https://github.com/pacphi/agentic-kit/pull/67), [#85](https://github.com/pacphi/agentic-kit/pull/85), [#86](https://github.com/pacphi/agentic-kit/pull/86), [#87](https://github.com/pacphi/agentic-kit/pull/87), [#89](https://github.com/pacphi/agentic-kit/pull/89), [#90](https://github.com/pacphi/agentic-kit/pull/90), [#91](https://github.com/pacphi/agentic-kit/pull/91)
- [Anupam Mediratta](https://github.com/anupamme) — [#78](https://github.com/pacphi/agentic-kit/pull/78)

> v4 (npm, cross-platform). The shell-based v3 kit is archived in
> [docs/archive/](docs/archive/) — `ak setup` migrates an existing shell-kit
> install automatically. A thin, reversible layer — not a fork. PRs welcome.
