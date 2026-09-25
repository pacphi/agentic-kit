# Agentic-kit v5 implementation evidence memo

Research date: 2026-09-25. Scope: current implementation, read-only inspection of repository commit `847486c61689f8499ada08f5b5684ecf26b22db8`; no installed configuration was changed, no branch switched, no application implementation edited. Links below pin this commit. One invalid-command reproduction was run against the checked-out source. Repository was clean at inspection start.

## Main conclusion

The useful v5 leap is to unify and enlarge an existing management platform. Agentic-kit already has a rich local observation dashboard, selected guarded writes shared with CLI services, explicit per-activity routing in the CLI, and a sanitized fleet snapshot contract. It does not yet provide a general settings editor, managed update scheduling, an authenticated enrolled fleet, or arbitrary many-to-many project/session labels. These distinctions matter when describing user pain: some requests address discoverability and partial coverage rather than absent underlying capability.

## 1. Dashboard launch and authorization

### Implemented

- `ak dashboard` is a first-class command today, aliased by `ak x dashboard`; no flags are required. [Dispatch and help](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/bin/agentic-kit.mjs#L25) (`bin/agentic-kit.mjs:25–41,68`).
- The command defaults to loopback port 7431, starts the server, prints the token-bearing URL and opens the browser unless `--no-open` is supplied. It remains foreground until SIGINT/SIGTERM. [Launch implementation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/dashboard.mjs#L68) (`src/commands/x/dashboard.mjs:68–121`).
- `--live-source 'ruflo|aqe=path'` is the only launch-time structured-source registration. Native Claude/Codex sources have automatic discovery; these flags are needed to add explicit Ruflo/AQE JSONL streams, not to start the dashboard. [Source parsing](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/dashboard.mjs#L54), [Native versus explicit sources](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/live/live-sessions-service.mjs#L167).
- The launch credential is a fresh per-server bearer token. The browser extracts it from the fragment, stores it in localStorage under `ak-dash-token`, and removes the fragment. A paste-token gate is available. [Browser bootstrap](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/client/bootstrap.mjs#L16) (`16–50`).
- Ordinary API requests accept a header or query credential; mutation routes require the header and an exact same-origin guard. This is **not** a one-time bootstrap exchange in current code. The CLI help explicitly calls the token reusable for the server session. [Token help](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/dashboard.mjs#L30), [API credential check](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1338), [Origin validation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/request-security.mjs#L9).

### Gaps / approaches

- Port conflict is a confirmed friction point in implementation: EADDRINUSE prints “try … --port 0” and exits; there is no existing-server discovery/reopen path here. [Conflict branch](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/dashboard.mjs#L93).
- Introduce a dashboard lifecycle service (`open`, `status`, optional `stop`) with a private instance record, ownership validation, existing-instance reuse and bounded fallback port selection. `ak dashboard` should simply reveal the current workspace; no credential copying or telemetry flags in the routine path. This is a proposal, not shipped behavior.
- Persist declared telemetry sources or discover them through producer-owned capability manifests, keeping exact sources and coverage visible in a Sources drawer. Avoid guessing that every installed Ruflo/AQE produces a particular stream.
- Meeting report “same Chrome profile worked again, Safari was blocked” is **not evidence of a token replay vulnerability**. Existing Chrome may possess localStorage while Safari does not. An explicitly chosen bearer token is reusable by design. Any new one-time launch-link/session-cookie design must be framed as a changed security/UX contract, and tested with a genuinely fresh browser profile before claiming a defect.

## 2. Existing UI writes: more than a read-only dashboard

### Implemented mutation surface

The exact route allowlist supports:

- discovery source preview/add/remove, automatic-source toggles, exclusions and exclusion removal;
- discovery scans (start/pause/resume through scan control);
- checklist and disposition changes;
- receipt export, interruption audit, reconciliation preview and reconciliation;
- executable plan creation, apply and undo;
- recipe refresh/accept/withdraw;
- Maintenance view/shell/retention preferences;
- explicit local host-health refresh and provider connection checks.

[Complete Maintenance v2 routes](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/maintenance-security.mjs#L24) (`24–55`); [Host-health POST routes](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard/host-health-api.mjs#L4); [Server allowlist enforcement](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1357).

“Preferences” currently means Maintenance last view, shell by environment and scan-history retention; it is **not** an editor for all kit or native host settings. [Preference scope](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/management/preferences.mjs#L15).

### Transaction machinery worth preserving

- Providers must supply detect, action derivation, preflight, apply and verification; rollback claims additionally require current-state inspection, undo and undo verification. [Provider validation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/provider-registry.mjs#L19).
- The CLI and dashboard consume the shared service; executable plans currently authorize exactly one exact action, not a bulk arbitrary command. [CLI contract](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/maintain.mjs#L125) (`125–167`).
- ADR-0044 is Implemented, updated 2026-09-09, and remains the transaction safety floor. ADR-0048 is Accepted with implementation delivered, updated 2026-09-20; human-evaluation and cross-platform gates remain open. [ADR-0044 status and relationship](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0044-receipt-aware-maintenance-control-plane.md#L3), [ADR-0048 status](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0048-inventory-led-maintenance-resource-management.md#L3).

### Recommendation

Make one typed command/application-service contract the source for UI actions, CLI commands, schedules and eventual remote requests. Expand it by resource-specific capability rather than adding an unrestricted “run command” browser endpoint. Add clear reversible/immediate actions for low-impact labels and view preferences; keep plan/diff, bounded target selection, state revalidation and receipts for configuration and update operations. A v5 “Update selected” experience can present one coordinated batch while retaining per-resource transaction/receipt boundaries, provided a new ADR explicitly defines partial failure, ordering, cancellation and rollback behavior.

## 3. Updates: broad CLI sync, selected native operations, no built-in scheduler

### Implemented

- `ak sync` offers whole-stack upgrade/heal/verify, `--dry-run`, `--no-upgrade`, `--yes`, `--json`. It has no user target selector or scheduling option in its command contract. [Sync options/help](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L91).
- Ordering is explicit: upgrades before heals; host installation/repair before dependent projections; final collection checks convergence. Enabled missing hosts may be installed, npm-owned broken hosts repaired; externally installed hosts are not silently taken over. [Step registry and ownership](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L117) (`117–169`).
- Fine-grained operations already exist: hook healing takes exact action IDs and a displayed plan digest with explicit apply/yes, supports undo/recovery, and defaults to a read-only plan. [Hook-healing CLI](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/heal.mjs#L29).
- Maintenance provider coverage is uneven by real capability. Claude plugins support disable/update/remove. Codex plugins support removal; update candidates are displayed with a statement that the adapter has no exact per-plugin update action. Codex MCP removal, Ruflo orphan termination, host realignment, owned cache cleanup, optional owned-skill archival/pruning, configured Git project patches, and Ollama model removal are provided. OpenCode MCP/plugin Maintenance adapters explicitly report unsupported. [Default provider composition and OpenCode boundary](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/provider-registry.mjs#L51), [Claude operations](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/providers/claude-plugin.mjs#L224), [Codex update boundary](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/maintenance/providers/codex-plugin.mjs#L48).
- No built-in update schedule is present in inspected dispatch/config/update services. ADR-0054 explicitly excludes a scheduler. Agentic-kit actually disables the Brain installer's nightly LaunchAgent under managed Brain ownership so updates stay under `ak sync` and release stamps. [Fleet exclusions](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md#L84), [Brain nightly ownership](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L243).

### Proposed v5 behavior

- One update planner accepts all managed resources, a component family, a host installation/profile, an exact component, or a saved label selection. Freeze the membership and discovered versions in the preview so a changing label does not silently widen an approved batch.
- A schedule stores **intent/policy**, not a stale executable plan. At execution time, collect fresh state, solve compatibility, materialize a new plan, enforce maintenance window and idle/session policy, then act within the preauthorized scope. Material changes outside that scope become review requests.
- Separate “check only”, “download/stage”, “apply compatible patches”, and “review all changes” modes. Expose channel/pin/dependency constraints, next run/timezone, last run/outcome, paused reasons, and per-resource exceptions in UI and CLI.
- Prefer a platform scheduling adapter initially (launchd, systemd/user timer, Windows Task Scheduler) that invokes the same bounded job runner. A long-lived orchestration daemon is an alternate if fleet delivery/offline queues demand it; either approach needs resume, duplicate-run suppression and portable capability disclosure.
- “All tools up to date” is too broad without package-source ownership and compatibility policy. AgentDB coherence deliberately targets Ruflo's bundled version rather than npm latest. [AgentDB coherence policy](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/agentdb.mjs#L9), [Install target](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L266).

## 4. Settings, per-activity routing and multiple host installations

### Implemented

- `kit.json` stores enablement, provider bindings, routing, context intent, model/provider preferences, component intent, statusline choices, version-check cache and Maintenance discovery. [Config defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/config.mjs#L24) (`24–79`).
- CLI per-activity routing is already available via `ak host pick --route 'activity:host[:model]'`, seeded when Claude+Codex are enabled, preserving user overrides across sync. Activities include specification, architecture, design, implementation, testing, review, security scan/analysis, documentation, debugging, packaging and release. [Host CLI](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/host.mjs#L129) (`129–145`). A UI editor can expose the existing policy rather than inventing another routing system.
- Routing schema has explicit primary host, route host/model/provenance, optional escalation arrays. [Routing schema validation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/routing-config.mjs#L57).
- Kit config uses XDG/APPDATA with a legacy fallback. Claude root honors `CLAUDE_CONFIG_DIR`; Hermes discovery honors `HERMES_HOME`; the central Codex root function is fixed to `~/.codex`; OpenCode central root uses XDG config. [Central paths](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/paths.mjs#L11) (`11–69`).
- Some newer features separately honor alternative roots: Codex context validation honors absolute `CODEX_HOME`; host readiness honors `CODEX_HOME`/`CLAUDE_CONFIG_DIR` and layered OpenCode config. [Codex context root](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/codex-context-config.mjs#L12), [Local host selections](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/host-readiness-local.mjs#L125).
- Native live transcript discovery still uses the central singleton Claude/Codex roots by default. [Live roots](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/live/live-sessions-service.mjs#L56).

### Proposed v5 model

Use `HostType → HostInstallation → Profile → effective project/session configuration`. An installation includes executable locator/version/source, config root, state/transcript root, and management authority. A profile includes provider/model/auth reference plus inherited overrides. A project/session references those identities rather than only `host: codex`. Show where each effective value came from and where Apply will write; do not copy secrets into the dashboard contract.

A schema catalogue should define each setting's type, scope, default, owner, read capability, write capability, restart/session effect, validation, export/redaction policy and CLI equivalent. The phrase “all component settings” should mean all **declared supported settings**, with unsupported/native-only settings linked to their owner, rather than a promise that every upstream setting can be safely rewritten generically.

## 5. Health, optionality and reported defects

### Confirmed actionable defect: invalid recommendation

`detectContextTax()` emits `command: 'ak x blocks audit'` at `src/lib/usage-insights.mjs:301`. The plumbing table does not register `blocks`; running `node bin/agentic-kit.mjs x blocks audit` from this exact checkout returned exit 2 and `unknown plumbing command: blocks`. No installed mutations were invoked.

[Recommendation source](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-insights.mjs#L278), [Dispatch table](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/bin/agentic-kit.mjs#L44).

Likely replacement is `ak audit context --host all` for startup-context evidence, with `ak x reference diff` for managed-block drift. Product decision: show the intended result (“Review startup context”) and generate its valid CLI counterpart from an action registry. [Context audit help](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/audit.mjs#L20), [Reference help](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/x/reference.mjs#L8).

### Installed host marked Unknown: not confirmed as erroneous

Current readiness separately assesses installation, configuration, provider/model, authentication and integration configuration. Any missing/unsupported check can yield overall Unknown even if executable launch passed. Disabled is a distinct state; explicit connected checks add short-lived provider-inference evidence. This is correct evidence qualification but can be confusing if the UI collapses it into one badge. [Readiness reduction](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/host-readiness.mjs#L22).

ADR-0053 is Implemented, dated/updated 2026-09-20. It explicitly defines Unknown as unsupported, ambiguous, inaccessible or timed-out evidence. Scope is the dashboard launch directory; it does not follow Intelligence project selection. Local checks cache for 60 seconds; confirmed inference evidence expires after 15 minutes and does not exercise optional MCP tool connections. [ADR-0053 states/scope](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0053-host-setup-evidence-and-usage-diagnostics.md#L20), [Connection result scope](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/host-readiness.mjs#L135).

Recommended presentation: installation (“Installed · v…”), configuration (“Ready / needs setup / unknown”), connection (“Not checked / checked 5m ago”), enabled state, and optional integration completeness as independent facts. Always name the failed/unknown check and offer its bounded next step.

### AgentDB refusal and Brain private-overlay refusal: unconfirmed report, preserve the guard

The code inspects standalone-versus-bundled AgentDB version coherence and propagates bounded npm error text on installation failure. It intentionally pins against the bundled store schema. That supports a compatibility dependency; it does not prove the exact meeting overwrite refusal originated in agentic-kit. Similarly no private-overlay refusal root cause was established from inspected kit source. Preserve these as “reported, reproduce with exact command/log/version/owner” rather than propose bypassing the guard. [AgentDB failure handling](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L271).

## 6. Observability and fleet/team management

### Existing local observability

The live service tails native Claude/Codex transcripts, reads Codex ledger state and surveys local host processes; explicit Ruflo/AQE streams can add structured orchestration evidence. OpenCode contributes process presence to live observability, not parity with native transcript adapters in this service. Collection is bounded (default 256 files, 2,000 replay events, 100 sessions, 1,000 nodes/session), with runtime scans every 2 seconds and reconciliation every 750ms. These are defaults in code, not performance guarantees. [Live service defaults](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/live/live-sessions-service.mjs#L56).

The event schema distinguishes presence, activity, operation, relationship, metadata, confidence and provider provenance. Safe unknown host IDs can pass through, but that does not add host collectors or exporters. [Live event vocabulary](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/live/event-schema.mjs#L1).

ADR-0012 is Implemented, updated 2026-09-20. It explicitly says the durable transcript archive design remains unimplemented: shipped replay is an in-process bounded array and workspace persistence stores metadata only. [ADR-0012 scope](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0012-observability.md#L87).

### Existing fleet contract

`ak telemetry export|validate|aggregate|schema|metrics` is real. Export collects without the dashboard, refreshes the local usage index, reads retained maintenance state, and creates a private installation identity on first explicit export. There is no upload, enrollment or maintenance scan. [Telemetry CLI](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/telemetry.mjs#L14).

Snapshot v1 includes installation identity, timestamps, source health, host-qualified session references, input/output/cache tokens, prompt/response/error/abort observations, separate observed and estimated USD, latency histogram buckets, resource/placement counts and retained receipt status. Its host enum is Claude/Codex/OpenCode. It has **no project ID, labels, person/team ID, host-installation/profile ID, session task identity or enrolled expected-machine roster**. Unknown fields are rejected by the closed schema. [Complete schema](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/telemetry/schema.mjs#L5).

Aggregation selects the newest whole snapshot per installation, replacing prior ones; it does not sum repeated rolling windows. It requires matching selection scope, rejects conflicting same-time snapshots and future data, retains missing values as null with measured/missing counts, and flags stale snapshots. [Reducer](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/telemetry/aggregate.mjs#L16).

ADR-0054 is Implemented, dated/updated 2026-09-20. It explicitly excludes remote control, autonomous upload, scheduler, machine enrollment, raw transcript export, financial billing reconciliation and a complete historical audit claim. Its local verification is on macOS arm64, with Windows/Linux execution unclaimed. [ADR-0054 limitations](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0054-fleet-evidence-export.md#L77).

### Proposed v5 progression

1. A local workspace explains all sessions, spend basis, active operations, installed resources and data coverage, with a shared filter scope.
2. Optional enrolled fleet adds authenticated device identity, expected roster/last seen, team/project association, authenticated delivery, store retention and aggregate drilldowns. Keep it an explicit deployment mode so local setup stays light.
3. Remote actions add authorization and local policy enforcement separately from observation. A reporting installation should not implicitly become remotely writable.
4. If longitudinal trends are needed, define a versioned event/delta or durable snapshot-history contract and explicit duplicate transcript/session semantics. Current rolling snapshots are not additive time series.

## 7. Labels, groups and dynamic spend

Current grouping is physical/evidenced repository grouping, not arbitrary user categorization. `buildUsageProjectGroups()` groups sessions under repository/evidence identity and sums cost, minutes, tokens and session counts. Verified worktrees group under the parent; independent clones are not merged merely by a shared remote. [Usage grouping](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/usage-project-groups.mjs#L22), [ADR-0050 identity rules](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0050-dashboard-project-identity-and-context-reporting.md#L21).

Proposed many-to-many labels should be a separate, user-owned organization layer over stable project/session identities. Preserve evidence identity while allowing labels such as client, product, team, experiment and initiative. Support inherited project labels and explicit session overrides with visible provenance. Saved groups should be named queries; labels should be editable memberships.

Metric rules needed for credible mockups:

- Union selected labels by unique normalized session/event identity before summing. A session labeled both `Client A` and `Experiment` counts once in the combined selection.
- Overlapping label breakdowns are non-additive; disclose overlap or support an explicit allocation rule for additive budget reports.
- Preserve observed/source-reported USD versus API-equivalent estimated USD. Neither establishes an invoice; current metric catalogue explicitly states that. [Metric semantics](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/telemetry/schema.mjs#L54).
- A subscription is not necessarily “free”; show plan fee/allocation separately from estimated API equivalence. Token burn, provider-reported spend and plan utilization answer different questions.
- Show source freshness and missing/unpriced contribution counts. Keep unknown distinct from measured zero.
- If changing labels should retroactively recalculate all history, state that policy; financial allocation may instead require time-bound label membership/versioned allocation. This is a product choice that should be explicit.

## 8. Concrete documentation drift to reconcile

ADR-0014 (Implemented; updated 2026-09-09) says the Maintenance-only POST extension is the exception and every other dashboard route retains non-GET rejection (`7–8`, reinforced by the current-boundary wording at `23–26`). Current code also admits `/api/host-health/local` and `/api/host-health/connection`; ADR-0053 documents that new separate allowlist. Thus ADR-0014’s “Maintenance only” statement is stale. This is a documentation consistency defect, not proof of an unsafe endpoint. [ADR-0014 claim](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0014-dashboard-auth-and-remediation.md#L3), [Contradicting runtime allowlist](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1357), [ADR-0053 authorization](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/docs/adr/0053-host-setup-evidence-and-usage-diagnostics.md#L94).

Additionally `dashboard-server.mjs:3` calls the server read-only even though its actual allowlist has writes. The command help has the more accurate “guarded Maintenance actions” wording. Reconcile these when the next settings/operations ADR is implemented; do not mark ADR-0048 Implemented until its stated remaining gates pass.

## 9. Suggested order, grounded in current seams

- Immediate quality patch: repair invalid generated commands; clarify Unknown/optional/installed status; reuse dashboard instance and improve launch failure handling. These reduce current pain without waiting for v5.
- Foundation: first-class installation/profile identities, shared setting/action schema, source provenance, migration contract, label/query domain, explicit cost-basis API.
- First compelling v5 slice: personae-oriented workspace + editable routing/components + label-driven project/session analytics + one scoped update plan with inspectable diff and receipts, all with CLI parity.
- Next slice: scheduled check/stage/apply policies, compatibility dependency resolution and bounded batch coordinator.
- Fleet slice: authenticated enrollment and aggregate reporting over a versioned export contract; remote writes as a separately scoped capability.

This memo does not claim live installed host verification, actual bill reconciliation, fresh browser exploit reproduction, automatic update execution, external host conformance, cross-platform acceptance, or end-to-end report/prototype validation. Root agent owns meeting citations, external product research, the taxonomy branch and final synthesis/mockups.

## 10. Follow-up: code verification of issue #237 report

The root researcher opened [issue #237](https://github.com/pacphi/agentic-kit/issues/237). The following independently inspected implementation evidence supports or narrows that report. The issue's runtime measurements/logs remain reported evidence unless explicitly reproduced below.

### Confirmed: status/nudge detector context diverges from sync

Status and the post-command nudge call `syncBlocks()` with only `dualMode` and `opencodeEnabled` flags. `reconcileGuidance()`, used by sync, adds persisted `claudeEnabled`, `codexEnabled`, AQE and Brain enablement first. The providers block's `codexEnabled` detector falls back to executable presence when no flag is supplied. Therefore a machine with Codex installed on PATH but intentionally disabled in kit settings can receive a drift recommendation for a block that sync correctly removes.

A read-only source-function reproduction on this machine used a synthetic config (`claude: true, codex: false`) and the real detector. Status/nudge context returned **true**; sync's enriched context returned **false**. No files were changed. This is a confirmed logic mismatch; the exact original user's runtime symptoms were not rerun.

[Status context](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/status/sections/blocks.mjs#L23), [Nudge context](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/nudge.mjs#L43), [Detector fallback](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/blocks.mjs#L130), [Enabled semantics](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/blocks.mjs#L181), [Sync context](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/blocks.mjs#L539).

Approach: one pure desired-state selector drives status, nudge, preview, apply and verification. Add a regression invariant: for identical observed facts and user intent, every surface produces the same desired block set.

### Confirmed: exact binary spellings limit legacy transport detection/repair

`isRufloMcpTransport` recognizes bare `ruflo`, `claude-flow`, `ak`, and certain `npx` argument forms; it rejects absolute paths. A pure-function reproduction returned true for `ruflo`/`ak` and false for `/opt/homebrew/bin/ruflo`, `/usr/local/bin/ruflo`, and `/opt/homebrew/bin/ak` with otherwise identical arguments. Thus some semantically equivalent installed transports can evade duplicate diagnostics.

Separately Claude's `canonicalRufloRegistration` requires exactly `command === 'ruflo'`. A user-scope legacy `ruflo` key with an absolute executable is reported as automatically migratable by **scope**, but the writer's `replaceableRufloRegistration` refuses it by **command shape**. The status remedy can therefore promise migration that the writer intentionally declines. Protecting uncertain ownership is appropriate; promising an action that cannot run is the defect.

[Transport recognizer](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruflo-mcp-transport.mjs#L1), [Status classifies scope](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/mcp.mjs#L95), [Writer requires exact shape](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/mcp.mjs#L121), [Migration writer](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/mcp.mjs#L493), [Misleading remedy](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/status/sections/mcp.mjs#L22).

Approach: separate transport equivalence/detection from mutation ownership. Resolve executable provenance for diagnostics, but ask the existing owner/provider to produce a scoped repair proposal. Status must use the same repair eligibility result as apply. Do not broaden removal permissions simply by taking `basename(command)`.

### Confirmed reporting seam: “converged” does not mean every warning resolved

Final sync failure calculation includes `level === 'fail'`, selected companion failure state and recorded failed actions. Ordinary warning rows do not prevent “converged — no failing subsystems.” That phrase is technically narrower than “all healthy,” but green success can coexist with unresolved legacy warnings. The early no-plan branch explicitly says “all subsystems healthy” based only on an empty actionable plan, so preserved/unactionable warnings can be mislabeled healthy there.

[Plan filtering and early success](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L557), [Final convergence logic](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/sync.mjs#L661).

Approach: report “Applied 3 changes; 2 need review; 1 intentionally unmanaged” with distinct execution, target-convergence and observation-completeness outcomes. A successful operation can coexist with incomplete coverage without claiming the entire environment healthy.

### Source-supported integration gap: AgentDB executable ownership collision

The AgentDB healer determines presence through the global package manifest and runs a normal global npm install. It does not preflight the existing `agentdb` executable owner or know an agentic-flow proxy from these inspected functions. Global install args contain no `--force`, which preserves npm's collision guard. The report's exact EEXIST/agentic-flow ownership is not reproduced here, but absence of an explicit collision preflight is supported.

[Presence source](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/agentdb.mjs#L26), [Healer](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L271), [Global install args](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/npm-global-install.mjs#L40).

Approach: preflight binary resolution, symlink target and provider package ownership; present compatibility/ownership choices, and never recommend `--force` as the default repair. Package present, executable usable and schema-compatible should be separate facts.

### Source-supported integration gap: Brain update invocation

The installer invocation uses `ruvnet-brain@latest` plus `--yes --no-stack --no-enhance --no-nightly-prompt --no-telemetry`, release version and optional `--force`; it does **not** add `--update`. This confirms the invoked mode in current kit code. Whether the current upstream installer requires `--update` to preserve private overlays is an upstream contract question supported by issue #237's report; this subtask did not run or inspect the current upstream installer, so it does not independently confirm the correct flag fix.

[Installer constants](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/ruvnet-brain.mjs#L23), [Invocation](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/heal.mjs#L184).

Approach: versioned lifecycle capability negotiation for install versus update versus repair, explicitly preserving user overlays and using the upstream supported operation. Concurrency should show “update already running” and attach to observable progress rather than attempt a second activation.

### AQE embedding: distinction exists; runtime persistence/UX needs investigation

Status already labels backend configuration as configured-unverified and says live model/corpus compatibility is unverified. `prepareAqeEmbedding()` performs a synthetic probe after optional selected Ollama provisioning, returning a passed/failed result; status does not reuse that result in this inspected path. A successful setup can consequently be followed by an “unverified” ordinary status, which is qualified truth about the current cheap check but poor continuity for the user.

[Cheap check](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/aqe-readiness.mjs#L7), [Status display](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/commands/status/sections/aqe.mjs#L14), [Live probe result](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/aqe-embedding-lifecycle.mjs#L56).

Approach: distinct Configured, Last verified, Runtime observed, Corpus compatible facts with timestamp/inputs/expiry; no stale check should imply a currently running service. Keep a past successful probe visible with clear freshness instead of making it disappear.

### `/api/system` payload: architecture supports concern; 22.9 MB not remeasured

The route reads the collector payload and serializes it in full. Its route has deep-refresh/trees controls but no view/page projection here, and shared `sendJson()` performs direct full JSON serialization. That supports adding summary/detail separation and pagination. The reported 22.9 MB size remains an issue measurement, not this audit's measurement.

[Whole System payload](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/dashboard-server.mjs#L1930), [Full serialization](https://github.com/pacphi/agentic-kit/blob/847486c61689f8499ada08f5b5684ecf26b22db8/src/lib/loopback-server.mjs#L51).

Approach: a cheap initial summary, separate cursor-paged resource collections, row/detail fetch on demand, server filtering and field selection, bounded update/delta responses, and measured budgets for initial bytes, interaction latency and scan work. Compression alone does not solve unnecessary parse/render work.
