# v5 operator settings and lifecycle audit

Source: agentic-kit `847486c61689f8499ada08f5b5684ecf26b22db8`, accessed 2026-09-25. Read-only source audit; no installed-host commands, network probes, package operations, or repository edits were performed. Catalog artifacts are research inputs, not a runtime configuration schema or certification.

`settings.json` provides a practical field catalog plus exact raw CLI option declarations. `lifecycle.json` describes 21 component/lifecycle families, opt-out effects, current ownership rules and proposed onboarding. Each source-bound entry has an immutable repository URL and line. Proposed controls are explicitly marked `proposed`; their defaults are product choices, not current behavior.

## Completeness boundary

Every top-level family in `src/lib/config.mjs` DEFAULTS is covered: codexContext, aqeCodexGuidance, aqe, aqeEmbedding, agentBrowser, agentdb, ruvnetBrain, ruvector, security, harvest, rufloComponents, health, mcp, integrations, routing, providers, statusline, customBlocks, versionCheck, hostAdapters and maintenance. Dynamic array/map record shapes are expanded where useful. Twelve activity routes each expose host/model/escalation. Known receipt/cache/schema fields are read-only evidence, not user controls. Ownership maps and version caches can contain additional runtime-generated keys; these are not arbitrary settings to edit.

Every `export const options` declaration under `src/commands` was extracted from source into `declaredCliOptionSources`, and literal option records are included as advanced invocation controls. This covers declared command parameters without executing their modules. An absent literal default is explicitly unknown/contextual, never inferred from the parser. The semantic controls expose documented fallback defaults only when source establishes them. The raw declarations allow checking completeness; this is a source inventory rather than an AST/typecheck result. Command help and downstream validation remain authoritative for permitted combinations.

This does **not** claim every upstream native setting in every version of Ruflo, AQE, Claude, Codex, Hermes, OpenCode, Gemini or Grok is managed by kit. Native ecosystem options are open-ended and versioned; current kit projects selected fields and narrowly patches owned values. Full v5 coverage needs one adapter-declared schema catalog per component/version, preserving unknown keys and native scope/policy precedence. A generic YAML/TOML editor alone does not establish safe management.

Status meanings: `existing-managed` = current kit-persisted intent/projection or existing owner-private preference; not necessarily a current dashboard form. `existing-cli` = current command/environment input. `observational` = known read-only evidence/constant; never render as editable. `proposed` = v5 control not shipped. `unsupported` = explicitly unavailable. `default: null` needs `defaultState`: absence, inherited native value and a configured null are different.

Important controls with unusual semantics:

- `rufloComponents.funnel=false` actively disables promotions; true lets Ruflo decide and only reverses an ak-owned disable.
- `turnCredit` and `memoryFix2887` are reporting/check gates for bundled functionality, not independent feature installation toggles.
- `mcpGovernance` false releases management; its object and rate cap configure policy. Current tested Ruflo <=3.44.0 stdio enforcement is not established.
- `ruvector=true` reports drift; it does not install standalone RuVector.
- Absent `aqeEmbedding` preserves legacy unmanaged state. Fresh explicit setup selects local Ollama unless an endpoint is already provided.
- Codex statusline changes apply to new sessions. An open dashboard can remain available while it reports that required native restart.
- Root environment variables are not uniformly honored today: central Codex paths still use ~/.codex, while the context helper honors CODEX_HOME.
- `ak maintain` currently authorizes one placement/action. Generic batches, remote writes and schedules are new work.

## Onboarding: assess first, manage chosen resources by default

Proposed flow: Assess → Select goals/hosts/resources → Review ownership and effects → Install/configure/adopt → Verify → Show inventory. The first assessment is observational and distinguishes absent, detected external, detected kit-owned, configured, credential-ready, connected and runtime-verified. Unknown is not absent. `ak about` already provides shared CLI/dashboard editorial descriptions with independent state chips; extend this inventory model, rather than encoding prose as runtime truth. [About source](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/about.mjs#L1).

For resources selected during onboarding, configuration management and lifecycle management can default on, with precise opt-outs. They are independent axes: a Homebrew Claude install can permit kit-owned configuration while Homebrew remains binary owner. Offer keep observing, configure existing, install and manage, adopt configuration only, or manage via verified native updater. A proposed adoption plan lists exact owned keys/files, existing values, package owner, verification, recovery and restart impact. Changing the package owner is a distinct explicit migration, not an implicit consequence of choosing Managed.

Current setup defaults are a core bundle plus **Claude only**: AQE, agent-browser, standalone AgentDB, Brain, security verification are on; RuVector drift reporting is on; harvest and Deja Vu are off; Codex/OpenCode are opt-in. There is no global `ruflo=false` kit setting. Hermes appears in discovery but lacks built-in management/execution parity. Gemini/Grok are proposed adapters. Manage all *chosen* resources must never become “install all six hosts,” silently adopt unrelated software, or override a native package manager. [Defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L24), [host ownership](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/providers.mjs#L236).

The UI opt-out copy should state the actual loss:

| Choice | Precise consequence |
|---|---|
| Omit core Ruflo integration (proposed) | Kit orchestration/routing/learning integration is not provisioned; native host usage can remain available. |
| Disable AQE management | Kit does not install/configure/converge QE-specific provider/embedding surfaces. Existing external QE may still work. |
| Disable Brain management | Kit does not install/update the offline knowledge grounding/search integration; a separately installed Brain can remain. |
| Disable standalone AgentDB management | Kit does not keep the harvest CLI coherent with the bundled library; bundled Ruflo AgentDB is independent. |
| Disable managed browser executor | Kit does not provision the executor/config used by Ruflo browser MCP; host-native browser tools are separate. |
| Omit a host | Kit does not install/manage that host; other selected hosts continue. Existing native sessions/config remain owned by the user. |
| Disable a hook integration (proposed per-integration control) | Its lifecycle/learning/observation automation stops; affected evidence coverage is reported. Native host work is not universally disabled. |
| Disable a discovery source | Its resources are not scanned; coverage becomes incomplete for that source. No uninstall is implied. |
| Decline telemetry export/sharing | No selected snapshot is shared; local observation can continue. Present export is manual/offline, with no uploader. |

These effects are tied to the lifecycle catalog citations. Avoid “unsafe,” “unhealthy,” or “broken” as generic opt-out labels. A held external install can be functional and deliberately unmanaged.

## On-demand operation and staying in the UI

Each component panel should show installed/running version, owning manager, selected configuration/lifecycle modes, effective settings, observed drift, last verification and eligible actions. Use the existing maintenance pattern: inspect → preview exact change → apply → verify → receipt, with undo only where a provider supports it. Source changes refresh the relevant panel/query, preserving workspace and unsaved drafts. Server-side operations must re-read current state and reject stale plans. New wrappers over setup/sync must emit structured progress rather than send the user into a blocking terminal.

“No UI restart” means the management page remains open while jobs complete and state refreshes. It cannot mean live replacement of every host/MCP process or agentic-kit executable: current self-update activates on the next invocation and some host settings only affect newly started sessions. Show “configured; 2 sessions still use prior settings,” “restart required,” and explicit restart scope. A future background job service can hand off server upgrades independently; that is proposed architecture.

## Optional scheduler — OFF

Keep all scheduling disabled by default, including scheduled checks. The ordinary operation flow is complete without a schedule. After a successful on-demand plan, offer Save as optional policy, with target identity/cohort, component set, check/stage/apply mode, allowed version range, timezone/window, idle behavior, missed-run policy, retry/timeout, notification and authority expiration. Do not silently widen a one-time approval to future versions or newly labeled machines.

A scheduler stores intent and bounded standing authority; each run creates a fresh plan and receipt after checking live ownership and versions. Only the proven native owner updates its package. Respect shared installations, dependency compatibility and active processes. Fleet operations require enrollment, authenticated delivery, local enforcement, revocation and per-machine result states; present fleet JSON export supplies none of that authority. Display applied/held/failed/restart-pending per target. No universal rollback promise.
