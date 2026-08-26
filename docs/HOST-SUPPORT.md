# Host support: Claude Code, Codex, and OpenCode

This is the canonical compatibility reference for agentic-kit's three **built-in**
execution hosts. It compares the host itself, Ruflo, agentic-qe (AQE), and
RuvNet Brain without treating those independent layers as interchangeable.

Behind an experimental flag, agentic-kit can also admit **external host adapters**
that extend this set with a host not shipped in-tree — see
[External host adapters](PROVIDERS.md#external-host-adapters-experimental),
[Using Hermes through the external adapter](HERMES-HOST-ADAPTER.md),
[AUTHORING-HOST-ADAPTERS.md](AUTHORING-HOST-ADAPTERS.md),
[ADR-0029](adr/0029-host-adapter-extension-point.md), and
[ADR-0031](adr/0031-capability-graduation-and-upstream-requests.md). An admitted
external host picks up the same capability-driven treatment described here, but it
is not one of the three built-ins this reference compares. It can never
**self-declare** primary-host, AQE-provider, or status-line status — that ban is
permanent — while `canBePrimary` and `commandStatusline` are **earnable** through
a passed conformance tier plus an explicit maintainer grant. `aqeProvider` stays
upstream-owned and is never `ak`-grantable. See
[External host adapters](#external-host-adapters) below for what a grant does and
does not buy today.

Evidence cutoff: **2026-08-04**. The comparison was checked against agentic-kit
`4.0.0-alpha.36`, Ruflo `3.34.0`, agentic-qe `3.13.x`, RuvNet Brain `4.0.7`,
Claude Code `2.1.222`, Codex CLI `0.146.0`, and OpenCode `1.18.x`. Host and
upstream behavior changes quickly; open issues below are a risk snapshot, not a
promise that an issue remains open forever.

The stock OpenCode gateway acceptance test currently covers the stable compatibility
window **`>=1.18.18 <1.19.0`**. This is a tested release-line window, not a claim
that every future OpenCode release is compatible and not a target for `ak sync` to
downgrade toward. Expanding the window requires the gateway behavior test to pass
against the new release line.

## Reading the matrices

- **Native** means the upstream project ships a host-specific integration.
- **Managed** means agentic-kit owns the adapter, generated assets, or lifecycle.
- **Indirect** means the capability is reachable through MCP or compatibility
  assets, but the host is not a first-class backend/provider for that subsystem.
- **Gap** means the capability is unavailable or intentionally outside the
  supported contract.

A **host** executes an agent session. An inference **provider** serves a model. An
MCP **client** can call tools. A host can be an MCP client without being a Ruflo or
AQE inference provider, and a configured model name does not prove which vendor
served it. See [Providers and hosts](PROVIDERS.md) for those axes in detail.

## Executive matrix

| Area | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| agentic-kit standing | Default-enabled; primary-eligible | Opt-in; primary-eligible | Opt-in; explicitly non-primary |
| `ak run` execution | Native CLI adapter | Native CLI adapter | Managed supervised-server adapter |
| Automatic activity routes | Yes | Yes | No; explicit routes only |
| Ruflo support | Reference/native surface | Strong, with integration and parity gaps | Managed compatibility layer |
| AQE support | Default and fullest path | Strong platform path; one direct-provider gap in `ak` | Upstream platform assets, not an AQE inference provider |
| RuvNet Brain | Native plugin, hooks, MCP, console | Native plugin, hooks, MCP, skills | Managed search MCP and guidance; no native Brain plugin |
| Managed command status line | Yes | No; Codex's native built-in fields only | No |
| Local transcript analytics | Yes | Yes | Yes |
| Main constraint | Hook behavior remains host-dependent | Nested MCP/plugin parity is less mature | Adapter-mediated and intentionally partial |

Claude is the reference integration. Codex is a strong peer and can lead the
same routing policy, but it has concrete MCP, guidance, and plugin maturity gaps.
OpenCode is a useful routed worker; it should not be described as having full
Ruflo, AQE, or Brain parity merely because it can call their MCP tools.

## Host execution and lifecycle

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Enable during setup | Default | `ak setup --codex` | `ak setup --opencode` |
| Enable later | `ak host pick` | `ak host pick` | `ak host pick` |
| May be `primaryHost` | Yes | Yes | No |
| May be an explicit route | Yes | Yes | Yes |
| Automatically seeded | Claude-only default; dual-host defaults when Codex is enabled | Dual-host defaults | Never |
| Escalation rung | Yes | Yes | Yes, when explicitly configured |
| Worker transport | `claude --print` streaming JSON | `codex exec --json` | Owned `opencode serve` over loopback HTTP/SSE |
| Model selector | Claude model id | Codex model id | Required `provider/model` selector |
| Turn bound | Native `--max-turns` | No turn-cap flag; runner deadline applies | No turn-cap flag; runner deadline applies |
| Cancellation | Supervised process | Supervised process | Session abort, then owned-server termination |
| Permission boundary | Host-native settings/hooks | Codex sandbox and approval policy | Permission requests abort; repository pre-approvals remain trusted |
| Project guidance | `CLAUDE.md` | `AGENTS.md` | Managed OpenCode `AGENTS.md` |
| Native MCP projection | Claude MCP configuration | Codex TOML MCP configuration | OpenCode JSON MCP configuration |
| Custom command status line | Supported | Not supported by agentic-kit | No supported upstream surface |
| Transcript and token parsing | Supported | Supported | Supported from OpenCode's SQLite store |

OpenCode supervision is a safety boundary around resources, not a sandbox around
the repository. An `opencode.json` that pre-approves a tool is inside the user's
workspace trust decision; no permission-request event exists for agentic-kit to
deny. Claude and Codex likewise inherit repository-owned hooks, instructions,
and permissions. `ak setup` and new enablements through `ak host pick` disclose
the applicable host-neutral trust manifest
before machine, user, or project mutation: Claude auto-approvals, OpenCode
wildcard approvals and managed extensions, and Codex registrations while its
sandbox/approval policy remains unchanged. See
[Setup trust manifest](SETUP.md#setup-trust-manifest).

Official extension references: [Claude hooks](https://code.claude.com/docs/en/hooks),
[Claude MCP](https://code.claude.com/docs/en/mcp),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), and
[OpenCode server](https://opencode.ai/docs/server/).

## Ruflo support

| Ruflo capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Upstream host orientation | **Native:** primary/reference CLI surface | **Native + managed:** upstream backend/plugin pieces plus agentic-kit integration | **Managed:** no equivalent upstream backend flag |
| Ruflo MCP tools | Native registration | Managed Ruflo MCP registration | Connected managed MCP; compact lazy `ak_ruflo_*` provider projection |
| Shared Ruflo memory | Same project store | Same project store | Same project store when pointed at the same Ruflo server |
| Agents and skills | Upstream Claude assets | Codex-compatible skills/plugin assets and generated guidance | Receipt-owned lazy profile catalogue through one stock `ak-specialist`; stock skills loaded on demand |
| Lifecycle hooks | Native Claude hooks | Codex hooks/plugin surfaces | OpenCode events translated by `ruflo-hooks.js` |
| Inference-backend flag | `ENABLE_CLAUDE_CODE` | `ENABLE_CODEX` | None |
| Cross-host execution | `ak run` can lead bounded Codex workers | `ak run` can lead bounded Claude workers | Explicit `ak run` routes only |
| Interactive peer path | Optional user-owned OpenAI Codex plugin/App Server | No supported inverse Claude plugin | None |
| Upgrade convergence | `ak sync` heals managed assets | `ak sync` heals Ruflo/AQE access and retires owned legacy MCP | `ak sync` regenerates the embedded catalogue and repairs exact-receipted plugins/config |
| Teardown | Managed blocks and registrations | Receipt-based managed teardown | Value- and hash-receipt teardown; user-owned values survive |

Ruflo MCP access and Ruflo-backed inference are different contracts. In
particular, Ruflo's [`agent_execute` provider-key behavior](https://github.com/ruvnet/ruflo/issues/2356)
can still require a separate provider credential even when invoked from Codex.
`ak run` avoids that conflation by executing the selected host directly and using
Ruflo for tools, memory, routing context, and orchestration assets.

Current cross-host Ruflo risks include:

- force initialization can overwrite unrelated `.mcp.json` content
  ([ruflo #420](https://github.com/ruvnet/ruflo/issues/420));
- generated Claude and Codex instructions can diverge
  ([#2638](https://github.com/ruvnet/ruflo/issues/2638));
- init and plugin installation can duplicate assets or hooks
  ([#2640](https://github.com/ruvnet/ruflo/issues/2640));
- dual-host marketplace parity remains incomplete
  ([#2854](https://github.com/ruvnet/ruflo/issues/2854)); and
- hierarchical AgentDB writes can report success without durable persistence
  ([#2887](https://github.com/ruvnet/ruflo/issues/2887)).

## Agentic QE support

| AQE capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Project installation | Default AQE platform | Explicit `--with-codex` path used by agentic-kit | AQE upstream has `--with-opencode`; agentic-kit does not deliberately request it |
| Agents and skills | Native/default assets | Native Codex-compatible assets | Upstream OpenCode agent/skill assets when that platform is initialized |
| MCP server | Supported | Supported | Supported upstream |
| Subscription inference provider | `claude-code` | AQE upstream includes `codex` | None |
| Direct `ak --aqe-provider` selection | `claude-code` | Not currently accepted by agentic-kit | Not applicable |
| Activity `agentOverrides` | Yes | Yes | No |
| Default route projection | Yes | Yes | No |
| QE-Court routed seat | Full routed role | Supported, with the integrated stall risk below | May call QE tools, but cannot be an AQE provider-backed seat |
| Subscription-provider embeddings | Not supported | Not supported | Not applicable |

The OpenCode boundary is precise: AQE can provision OpenCode agents, skills, MCP,
and permissions, but OpenCode is not an AQE LLM-provider type. Agentic-kit
therefore does not infer an AQE provider from an OpenCode host/model route and
does not write that route into `agentOverrides`.

Codex has the reverse limitation. Current AQE includes a subscription-backed
`codex` provider, and agentic-kit can project Codex activity routes into AQE.
However, agentic-kit's direct provider allow-list still rejects
`ak host pick --aqe-provider codex`; use per-activity routing rather than claiming
that direct selector works. This is a documented implementation gap, not a host
or billing distinction.

AQE risks relevant across hosts include its
[MCP entrypoint double-spawn](https://github.com/proffesor-for-testing/agentic-qe/issues/528),
[multi-platform initialization behavior](https://github.com/proffesor-for-testing/agentic-qe/issues/532),
[MCP tool correctness gaps](https://github.com/proffesor-for-testing/agentic-qe/issues/535),
[RVF recovery loop](https://github.com/proffesor-for-testing/agentic-qe/issues/574),
and [local-embedding audit findings](https://github.com/proffesor-for-testing/agentic-qe/issues/615).

The Codex QE-Court investigation in
[agentic-kit #108](https://github.com/pacphi/agentic-kit/issues/108) is a
**Proposed** living plan, updated 2026-08-03, not an implemented fix. It records
Codex seats stalling while awaiting nested Ruflo memory calls even though direct
Ruflo and isolated Codex checks remain healthy.

## RuvNet Brain support

| Brain capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Official upstream target | Yes | Yes | No |
| Plugin manifest | `.claude-plugin` | `.codex-plugin` | None |
| `search_ruvnet` | Native plugin MCP | Native plugin MCP | Managed OpenCode MCP entry |
| Knowledge bundle | Shared user-level Stable Spine | Same shared installation | Same shared MCP-backed installation |
| Grounding hooks | Native Brain hook suite | Native Brain hook suite | No equivalent native Brain hooks |
| Visual console | `/rvbc` | `$ruvnet-brain:rvbc` | No dedicated command |
| Skills | Native | Native | Managed guidance only; not plugin parity |
| Update path | Agentic-kit refreshes the installed Brain release | Same shared release | Stable MCP shim follows the shared release |

OpenCode can search the same source-grounded Brain, but it lacks the official
plugin lifecycle, console, and enforcement hooks. Describe it as **Brain search
access**, not full Brain host support.

Current Brain limitations include release/plugin version lockstep
([brain #77](https://github.com/stuinfla/ruvnet-brain/issues/77)), Codex MCP warmup
causing `search_ruvnet` to disappear
([#78](https://github.com/stuinfla/ruvnet-brain/issues/78)), and a Claude
pre-tool hook that may resolve too late to block subagent dispatch
([#84](https://github.com/stuinfla/ruvnet-brain/issues/84)).

## Host-specific limitations

### Claude Code

Claude has the broadest native surface, but remote plugin sync can omit hooks
([claude-code #83643](https://github.com/anthropics/claude-code/issues/83643)),
project hooks can diverge in worktrees
([#83953](https://github.com/anthropics/claude-code/issues/83953)), and custom
status-line rendering can fail
([#83675](https://github.com/anthropics/claude-code/issues/83675)). Treat hooks as
observable execution behavior, not proof based only on a configured file.

### Codex

Codex lacks agentic-kit's command-backed status line. Current reports also cover
MCP tools being discovered but unavailable to Desktop threads
([codex #19425](https://github.com/openai/codex/issues/19425)), MCP child-process
leakage ([#30408](https://github.com/openai/codex/issues/30408)), and silent
`AGENTS.md` truncation above its configured limit
([#13386](https://github.com/openai/codex/issues/13386)). Restart sessions after
MCP/plugin changes and keep generated guidance concise.

### OpenCode

OpenCode remains non-primary, is never automatically routed, cannot be an AQE
provider, and has no native Brain plugin or managed status line. Operational risks
include local MCP servers dropping during `serve`
([opencode #38266](https://github.com/anomalyco/opencode/issues/38266)), nested
permission prompts hanging ([#13715](https://github.com/anomalyco/opencode/issues/13715)),
subagent permission rules being ignored
([#33223](https://github.com/anomalyco/opencode/issues/33223)), and global
`AGENTS.md` guidance being forgotten
([#40348](https://github.com/anomalyco/opencode/issues/40348)).

## External host adapters

An external adapter is data, not code: a hash-pinned manifest plus subprocess
hooks, admitted only behind `AK_EXPERIMENTAL_HOST_ADAPTERS=1` and only after
`ak host adapters trust <name>` discloses the full validated manifest and records
your consent. `contract: 1` is still experimental and **not frozen** — the freeze
waits on a real external adapter clearing the conformance kit and soaking.

`ak host adapters conformance <name>` reports each graduation tier honestly:

| Tier | Status today | Gates | Why |
| --- | --- | --- | --- |
| `admission` | Genuinely passes | — | Manifest validation and consent are built |
| `activity-routing` | Genuinely passes | — | Real supervised subprocess worker via `ak run` |
| `primary-eligible` | Genuinely passes | `canBePrimary` | Observes a real escalation |
| `session-driving` | **Gated** | — | Being a native Ruflo backend is upstream's to grant |
| `statusline` | **Gated** | `commandStatusline` | `ak` has no render surface for it yet |

The two gated tiers are honest ceilings, not failures — they report `gated` or
`skipped` and never `passed`, with `ak host adapters gate <name> <tier> <repo>#NNN`
recording the upstream issue each waits on.

What a maintainer grant (`ak host adapters grant`, alias `bless`) buys today, stated
narrowly: the capability goes live in the effective host registry from the next
flagged invocation, so the host's tier label reflects it and it joins
primary-eligibility. No path yet **selects** an external host as primary — `ak host
pick` stays built-in-scoped — and `commandStatusline` has no runtime reader, so a
granted `commandStatusline` is currently inert. Grants are withdrawable with
`revoke-grant`, and every tier result is stale-marked the moment the manifest
changes.

A graduated adapter ends in one of two places: a **blessed external adapter** that
stays out-of-tree holding exactly the capabilities its tiers earned, or a
**promoted built-in** whose descriptor a maintainer adopts as a first-party registry
entry — an ordinary pull request, not a command.

## Known contract discrepancies

These are intentionally visible rather than hidden behind an over-broad “supported”
label:

1. AQE upstream supports a `codex` subscription provider, while agentic-kit's
   direct `--aqe-provider` allow-list does not. Codex activity projection works;
   direct selection does not.
2. OpenCode transcript, token, observed-cost, and provider-id parsing exists in
   `usage-opencode.mjs`, while the integration registry still advertises
   `usage:false`. The dashboard analytics are real; the capability declaration is
   stale.
3. “OpenCode is outside AQE” means outside **AQE inference-provider routing**.
   It does not mean AQE lacks OpenCode platform agents, skills, or MCP support.

The governing decisions currently stand as follows: ADR-0017 and ADR-0018 are
**Accepted** and were amended on 2026-08-04 and 2026-07-30 respectively;
ADR-0020 is **Implemented** as of 2026-07-30; ADR-0021 is **Accepted** and was
updated 2026-08-03. See [ADR-0017](adr/0017-opencode-host.md),
[ADR-0018](adr/0018-generalized-host-worker-execution.md),
[ADR-0020](adr/0020-ga-stable-surfaces.md), and
[ADR-0021](adr/0021-inference-provider-provenance.md). For the external-adapter
section above, [ADR-0029](adr/0029-host-adapter-extension-point.md) is the
extension point and [ADR-0031](adr/0031-capability-graduation-and-upstream-requests.md)
amends it with capability graduation — replacing ADR-0029's permanent
capability caps with the earn-then-grant model, except for the permanent ban on
self-declaring them.

## Operational guidance

- Use `ak status` for installed/wired truth and `ak run --dry-run` for the exact
  worker plan.
- Use `ak models refresh` to capture host-scoped model evidence, then
  `ak models status|diff|explain|plan` for offline lifecycle and swap analysis. Claude, Codex,
  OpenCode, and Ollama have registry-selected explicit source adapters; an external host receives no
  inferred catalogue capability without an admitted descriptor and matching adapter.
- Use Claude or Codex as primary. Choose based on which should lead the mirrored
  activity defaults, not on MCP availability alone.
- Route OpenCode explicitly for bounded work whose `provider/model` and repository
  trust posture you have selected deliberately.
- Do not count two hosts as two inference vendors without observed or independently
  configured provider evidence.
- Run `ak sync` after Ruflo, AQE, Brain, or host upgrades, then restart host sessions
  so they reload MCP, hooks, plugins, and guidance.
- Read [Installation and scope](INSTALLATION.md) before deciding whether the
  `ak` binary itself should be global, project-local, or one-shot.
