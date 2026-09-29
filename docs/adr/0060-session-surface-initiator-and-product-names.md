# ADR-0060 — Session surface, initiator and official product names

- **Status:** Accepted
- **Date:** 2026-09-26
- **Updated:** 2026-09-29 — delivered shared classification, usage/cache and census evidence,
  Runtime application attribution, and CLI/dashboard presentation. Dedicated Cowork storage remains
  an optional follow-up (#257); acceptance covers the bounded sources described below.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0050](0050-dashboard-project-identity-and-context-reporting.md) (session origin
  rule, superseded in part by this record),
  [ADR-0052](0052-codex-usage-attribution.md) (imported Codex rollouts excluded from usage),
  [ADR-0025](0025-machine-footprint-metrics.md) (Runtime census labels),
  [ADR-0027](0027-shared-project-census.md) (project census),
  [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md) (host management states), ADR-0057
  (dashboard taxonomy and role lenses; on its own branch, to be reconciled on merge), and the
  [issues 237–239 audit record](../plans/2026-09-26-issues-237-238-239-verification-and-decisions.md)
  (Addendum 3)

## Context

The maintainer asked whether ak can tell sessions started from Claude Desktop or the ChatGPT app
apart from Claude Code and Codex sessions, noting that the former leave residue in folders under the
home directory rather than in the user's own work folders. They asked that every name ak shows match
the product's official commercial name, with no duplicate or false categories.

Research on 2026-09-26 read only enumerated log fields and counts (no prompt or response content),
the vendors' current documentation, the openai/codex source at `7f6c0f9`, and the installed Claude
Code 2.1.283 and Claude Desktop 2.9939.2 builds. What that historical sample established (not a fresh census or current behavior):

1. **The logs declare where a session came from.** Claude Code transcripts carry `entrypoint`;
   Codex rollouts carry `session_meta.originator`, `source` and `thread_source`. Folder location is
   a useful explanation but not a classifier: ChatGPT Work runs mostly in
   `~/.codex/.chatgpt-projects/…` (145 of 209 local sessions) and `~/Documents/Codex/…` (34), but also
   in repositories (30), and imported copies carry the original project's folder.
2. **Today's rule discards most of that.** `src/lib/footprint/session-origin.mjs` recognizes only
   desktop values and maps everything else to `unknown`: all 823 local Claude transcript heads
   (`cli`, `sdk-py`, `sdk-cli`) and 564 Codex rollouts (`codex-tui`, `codex_exec`, `codex_cli_rs`).
   `claude-desktop` has zero local observations. The raw value is thrown away.
3. **The "Codex Desktop" category is mostly not Codex.** All 874 rollouts with originator
   `Codex Desktop` and source `vscode` are Claude Code transcripts that the ChatGPT desktop app copied
   in through **Import from another agent**: their ids join 874/874 with
   `~/.codex/external_agent_session_imports.json`, whose source paths all lie under
   `~/.claude/projects/`. Usage already excludes them (ADR-0052: 868 counted as `importedExcluded`,
   zero tokens, prompts or responses). Project discovery does not: `footprint/project-sources.mjs:304`
   records a sighting for every rollout, so **23 project folders carry a Desktop origin only because
   of imports**, 19 of them Claude Code projects. Genuine ChatGPT-app sessions name 17 folders.
4. **One category, two names, two modes.** `codex-desktop` is labelled "ChatGPT Desktop" in
   Intelligence and Maintenance but "Codex Desktop" in System → Projects and all docs, and it merges
   the app's Codex view with **ChatGPT Work**. The installed app is `ChatGPT.app` (bundle id
   `com.openai.codex`); OpenAI merged the Codex app into the ChatGPT desktop app on 2026-07-09.
   "Codex Desktop" is the app's internal client name, not a product name.
5. **Raw values mislead.** Codex `source="vscode"` is the app-server default for any client that
   does not override it (the desktop app, the Python SDK, daemons); it never means VS Code. Claude
   `sdk-cli` means any non-interactive `claude -p` run (scripts, `ak run` workers, other agents), not
   an SDK application; `sdk-py` means the Python Agent SDK, here overwhelmingly the official
   security-guidance plugin's review hook.
6. **Counts need rules.** Claude subagent transcripts carry their parent's `entrypoint` and
   `sessionId` (392 `cli` files are 53 sessions). One-line `bridge-session` files are not sessions.
   Codex subagents and the Auto-review reviewer inherit the parent's originator. `thread_source`
   values `guardian_review`, `chatgpt_handoff` and `agent_created_thread` are currently counted as
   person-driven "main" threads. Cowork transcripts live under
   `~/Library/Application Support/Claude/local-agent-mode-sessions/…`, outside the census.
7. **Names drift.** Claude Code has three ids (`claude`, `claude-code` in About, `claude-code` as an
   AQE provider); Codex has four display forms ("Codex", "OpenAI Codex", "OpenAI/Codex", "codex CLI");
   `unknown` has three labels; Hermes is a built-in host only inside Maintenance; the origin enum is
   copied in five files. The Runtime census counts `Claude.app` as the Claude Code host (basename
   match) while `ChatGPT.app` is invisible.

## Decision

### 1. Separate dimensions from declared fields, bounded raw evidence

Every session record carries:

- **Session surface** — which product surface started it, from `entrypoint` (Claude) or
  `originator` with `source` (Codex), using the table below.
- **Initiator** — `person`, `automation`, `agent` (a subagent or reviewer spawned by another
  session) or `imported-copy`. Claude: person when interactive or the entrypoint is one Claude Code
  itself treats as attended (`claude-vscode`, `claude-desktop*`, `local-agent`, `remote*`,
  `ssh-remote`, Claude Tag values); automation for `sdk-py`, `sdk-ts`, `sdk-cli`, `mcp`, `claude-code-github-action`, and
  for `sessionKind` `bg`/`daemon`/`daemon-worker`. Codex: `thread_source` `user` and
  `chatgpt_handoff` are person, except that `codex exec` top-level threads are automation;
  `subagent`, `guardian_review` and `agent_created_thread` are agent; app feature values such as `automation` are
  automation.
- **Raw evidence** — bounded tokens from the named declaration fields, such as `entrypoint:cli` and
  `originator:codex_exec/source:exec`. Unfamiliar valid tokens remain available in local detail, with Other or Unknown
  classification and no inferred product or provider. Tokens must be at most 80 characters,
  begin with a letter and contain only letters, digits, underscores, dots or hyphens; the known
  `Codex Desktop` value is the sole space-containing exception. Malformed values are omitted.

Folder class (ChatGPT Projects folder, projectless Work folder, Cowork data, temporary folder) is an
explanatory attribute, never the classifier. The first eligible declaring record wins within each reader's bounded evidence window;
invalid values remain Unknown and do not authorize a search for a preferred later identity.
A later replayed parent declaration cannot replace the child's identity. Git scope, host,
surface, initiator and provider are separate fields and filters. Cloud choices appear only
when a covered record declares a cloud surface.

### 2. Official names

Claude (per code.claude.com and claude.com documentation):

| Raw value | Surface shown | Initiator |
|---|---|---|
| `cli` | Claude Code CLI (also JetBrains, whose plugin runs the CLI) | person; `sessionKind` bg → automation |
| `claude-vscode` | Claude Code for VS Code | person |
| `claude-desktop`, `claude-desktop-3p` | Claude Desktop (attribute "on 3P" for the second) | person |
| `local-agent`, `local_agent`, `remote_cowork` | Cowork | person |
| `remote`, `remote_desktop`, `remote_mobile`, `remote_projects` | Cloud session (attribute: started from Desktop, mobile, web or a project) | person |
| `remote_trigger`, `remote_cowork_trigger` | Cloud session | automation |
| `sdk-py`, `sdk-ts` | Claude Agent SDK | automation |
| `sdk-cli` | Non-interactive mode (`claude -p`) | automation |
| `claude-code-github-action` | GitHub Actions | automation |
| `claude_in_slack`, `claude-in-slack`, `claude-in-teams` | Claude Tag (Slack or Teams) | person |
| anything else (`mcp`, `bench`, `claude-security`, `ssh-remote`, `claude-coworker*`, …) | Other Claude surface (raw value shown) | per rule 1 |

`remote_desktop` is a cloud session, not a local Desktop run, so it sits under Cloud session with a
"started from Claude Desktop" attribute; Claude Code's own label ("Claude Desktop") is not followed
here because ak reports what ran on this machine.

OpenAI (per learn.chatgpt.com, which developers.openai.com/codex now redirects to):

| Raw value | Surface shown | Initiator |
|---|---|---|
| `Codex Desktop` (not imported) | ChatGPT desktop app · Codex | by `thread_source` |
| `codex_work_desktop` | ChatGPT desktop app · ChatGPT Work (local) | by `thread_source` |
| `codex-tui` | Codex CLI | person |
| `codex_exec` | Codex CLI · non-interactive (`codex exec`) | automation |
| `codex_vscode` | Codex IDE extension | person |
| `codex_sdk_ts`, `codex_python_sdk` | Codex SDK | automation |
| `codex_cli_rs` with source `mcp` | Codex MCP server (removed 2026-09-05) | agent |
| `codex_work_web`, `codex_work_mobile`, `codex_work_cca`, `chatgpt_cca` | ChatGPT Work (cloud) | by `thread_source` |
| any other | Other OpenAI client (raw value shown) | by `thread_source` |

Codex subagents and Auto-review with a verified, acyclic parent link in the observed record set
roll up under their parent surface ("Subagents", "Auto-review", OpenAI's
own labels) and are never separate products. `source="vscode"` never produces a "VS Code" label.

Hosts are named **Claude Code**, **Codex**, **OpenCode** (by Anomaly) and **Hermes Agent** (Nous
Research; an external adapter, not a built-in host). Desktop applications are named **Claude
Desktop** and **ChatGPT desktop app**; they are applications, not hosts.

### 3. Imported copies are excluded everywhere, and counted

ADR-0052's rule extends to project discovery and origin views **per turn**. The portable
signal is `payload.turn_id` beginning `external-import-turn`; an import map is not required.
Copied turns contribute no usage or project/origin sighting. A later proven native turn can
establish the first declared app surface and a genuine project; unknown or conflicting turn
boundaries remain excluded with diagnostics. A Desktop declaration is not inferred for
other declared products. First session identity and parent replay exclusion remain intact.

Pure imports remain unknown/imported-copy. Mixed usage rows retain import-exclusion counts.
Discovery distinguishes confirmed exclusions (`importedExcluded`), proven mixed observations
(`importedMixed`) and bounded observations that cannot settle ownership (`importedUnresolved`).
The latter make coverage incomplete, without inventing a project from an encoded directory.
See ADR-0052 §3 for exact byte/record budgets and cumulative-counter rules. Intelligence,
System Projects and `ak system` disclose these populations and source incompleteness.
Optional ledger source labels remain follow-on work.

### 4. One vocabulary module and one label table

A single module owns the raw-value → surface → initiator mapping and the display labels; CLI and
dashboard consume it, and the five hard-coded copies of the origin enum go. `unknown` has one label.
Labels are tested once; views test that they use the shared table.

### 5. Census and sources

- The Runtime census treats `Claude.app` and `ChatGPT.app` symmetrically as desktop applications,
  neither as a host; their bundled CLIs are attributed to the hosted session (lane D's Claude rule
  extended to the Codex bundle).
- Dedicated Cowork storage remains uncovered (#257), and views disclose that limit. Covered
  Claude transcript records may still declare the Cowork surface; that does not prove coverage
  of the separate store.

### 6. Counting rules and compatibility

Claude project census sessions use declared `sessionId`, excluding subagent and bridge-only
transcripts. Rows expose `countBasis`: declared-session IDs, transcript files, database sessions,
recovered-project sightings or mixed observations. Encoded-directory recovery can establish a
project sighting with zero session weight; missing identity and bounded reads keep completeness
visible. Census session observations are distinct from billed Usage sessions.

Project `sessionSurfaces` is additive: legacy `sessionOrigins` remains for compatibility. Raw
project detail unions retain at most 16 sorted values per named field per classification group;
`rawEvidenceComplete: false` discloses truncation. The raw-token policy was explicitly approved
by the maintainer for local detail; it does not authorize publishing private tokens.

Old coarse `codex-desktop` snapshots render Unknown surface with a ChatGPT desktop app family
note because their mode was not recorded. Old `claude-desktop` snapshots retain Claude Desktop;
initiator and provider remain Unknown. Saved legacy origin filters preserve their membership
and use explicit legacy labels. Missing newer fields are not evidence of a precise mode.

### 7. Provider evidence is independent

Claude provider-specific assistant model IDs may establish Amazon Bedrock or Google Vertex AI
metadata (`assistant-model-id`); ordinary or conflicting IDs leave Unknown. Codex and OpenCode
may provide a recorded provider ID. Both are observed source metadata, not network attestation.
Current environment, routing configuration, application identity and price-table identity cannot
establish a historical serving provider. The `on 3P` attribute remains visible independently of
provider Unknown. Codex Auto-review tokens remain unpriced when no supported price exists.

## Consequences

- Shared vocabulary in `src/lib/session-surface.mjs` supplies Usage, project details, Maintenance,
  Intelligence and Runtime labels. Desktop applications have no host identity; bundled CLIs need
  observed session attribution, and a Codex app-server process is a service.
- Usage cache schema changes exactly **25 → 26**; old entries require rebuilding. Footprint
  snapshot schema remains **8**, with additive evidence and explicit legacy presentation.
- First-declaration, parent-link, import-ownership and source bounds prevent these observations
  from establishing whole-corpus coverage. Historical research counts above are not release metrics.
- Internal host fields can change. Unknown, bounded raw evidence and source-health diagnostics
  preserve uncertainty without deriving products from directories or `source="vscode"`.

## Verification and remaining limits

Synthetic fixtures cover shared vocabulary, first declaring records, parent/reviewer attribution,
legacy filters, raw-token caps, provider evidence, import ownership, session-count bases and
Runtime application/service distinctions. CLI/dashboard consumer assertions cover the shared
labels and disclosures. The implementation is bound to the accepted V6 source units; final
integration gates and publication are separate decisions.

Dedicated Cowork storage (#257), optional import-ledger source labels, missing parent evidence
and records outside bounded readers remain uncovered. No new live corpus, provider, performance
or billing measurement is claimed by this documentation update. See
[Usage metrics](../usage-scorecard-metrics.md#current-accounting-and-cache-contracts) for the
bounded accounting, source selection and cache contracts delivered alongside this vocabulary.
