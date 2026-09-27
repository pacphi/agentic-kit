# ADR-0060 — Session surface, initiator and official product names

- **Status:** Proposed; §3 implemented for project discovery (2026-09-27), the rest staged follow-on
- **Date:** 2026-09-26
- **Updated:** 2026-09-27 — §3 implemented for project discovery and the System projects note:
  imported copies give no project, host or origin and are counted. The ledger-derived source labels
  (Cursor, Cowork) and the other views remain proposed.
- **Deciders:** agentic-kit maintainers
- **Related:** [ADR-0050](0050-dashboard-project-identity-and-context-reporting.md) (session origin
  rule, superseded in part by this record once accepted),
  [ADR-0052](0052-codex-usage-attribution.md) (imported Codex rollouts excluded from usage),
  [ADR-0025](0025-machine-footprint-metrics.md) (Runtime census labels),
  [ADR-0027](0027-shared-project-census.md) (project census),
  [ADR-0053](0053-host-setup-evidence-and-usage-diagnostics.md) (host management states), ADR-0057
  (dashboard taxonomy and role lenses; on its own branch, to be reconciled on merge), and the
  [issues 237–239 audit record](../audits/2026-09-26-issues-237-238-239-verification-and-decisions.md)
  (Addendum 3)

## Context

The maintainer asked whether ak can tell sessions started from Claude Desktop or the ChatGPT app
apart from Claude Code and Codex sessions, noting that the former leave residue in folders under the
home directory rather than in the user's own work folders. They asked that every name ak shows match
the product's official commercial name, with no duplicate or false categories.

Research on 2026-09-26 read only enumerated log fields and counts (no prompt or response content),
the vendors' current documentation, the openai/codex source at `7f6c0f9`, and the installed Claude
Code 2.1.283 and Claude Desktop 2.9939.2 builds. What it established:

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

## Decision (proposed)

### 1. Two dimensions from declared fields, raw value always kept

Every session record carries:

- **Session surface** — which product surface started it, from `entrypoint` (Claude) or
  `originator` with `source` (Codex), using the table below.
- **Initiator** — `person`, `automation`, `agent` (a subagent or reviewer spawned by another
  session) or `imported-copy`. Claude: person when interactive or the entrypoint is one Claude Code
  itself treats as attended (`claude-vscode`, `claude-desktop*`, `local-agent`, `remote*`,
  `ssh-remote`, Claude Tag values); automation for `sdk-*`, `mcp`, `claude-code-github-action`, and
  for `sessionKind` `bg`/`daemon`/`daemon-worker`. Codex: `thread_source` `user` and
  `chatgpt_handoff` are person, except that `codex exec` top-level threads are automation;
  `subagent` and `guardian_review` are agent; app feature values such as `automation` are
  automation.
- **Raw evidence** — the exact declared values (`entrypoint:cli`,
  `originator:codex_exec/source:exec`). An unrecognized value is shown as "Other" with its raw value,
  never merged into a larger bucket.

Folder class (ChatGPT Projects folder, projectless Work folder, Cowork data, temporary folder) is an
explanatory attribute, never the classifier. The first record that declares a value wins, and
the rule is stated in code and tests.

### 2. Official names

Claude (per code.claude.com and claude.com documentation):

| Raw value | Surface shown | Initiator |
|---|---|---|
| `cli` | Claude Code CLI (also JetBrains, whose plugin runs the CLI) | person; `sessionKind` bg → automation |
| `claude-vscode` | Claude Code for VS Code | person |
| `claude-desktop`, `claude-desktop-3p` | Claude Desktop (attribute "on 3P" for the second) | person |
| `local-agent`, `local_agent`, `remote_cowork` | Cowork | person |
| `remote`, `remote_desktop`, `remote_mobile`, `remote_projects` | Cloud session (attribute: started from Desktop, mobile, web or a project) | person |
| `remote_trigger`, `remote_cowork_trigger` | Cloud session (routine) | automation |
| `sdk-py`, `sdk-ts` | Claude Agent SDK (attribute: Python or TypeScript; "plugin hook" when evidenced) | automation |
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

Subagents and Auto-review roll up under their parent surface ("Subagents", "Auto-review", OpenAI's
own labels) and are never separate products. `source="vscode"` never produces a "VS Code" label.

Hosts are named **Claude Code**, **Codex**, **OpenCode** (by Anomaly) and **Hermes Agent** (Nous
Research; an external adapter, not a built-in host). Desktop applications are named **Claude
Desktop** and **ChatGPT desktop app**; they are applications, not hosts.

### 3. Imported copies are excluded everywhere, and counted

ADR-0052's rule extends to project discovery and every origin view: a rollout stamped
`external-import-turn-*` (or listed in the imports ledger when present) contributes no project
sighting, origin, facet count or Runtime attribution. Each view reports how many it excluded, labelled
"Imported from Claude Code" (or Cursor, or Cowork, from the ledger's source path).

### 4. One vocabulary module and one label table

A single module owns the raw-value → surface → initiator mapping and the display labels; CLI and
dashboard consume it, and the five hard-coded copies of the origin enum go. `unknown` has one label.
Labels are tested once; views test that they use the shared table.

### 5. Census and sources

- The Runtime census treats `Claude.app` and `ChatGPT.app` symmetrically as desktop applications,
  neither as a host; their bundled CLIs are attributed to the hosted session (lane D's Claude rule
  extended to the Codex bundle).
- Cowork transcripts become an optional discovery source; until then views say Cowork is not
  covered.

### 6. Counting rules

Claude sessions are counted by `sessionId`, excluding `subagents/` transcripts and non-conversation
records; Codex subagent and reviewer rollouts roll up to their parent; `thread_source` is classified
in full.

## Consequences

- Usage, System → Projects, Maintenance facets, Intelligence designation (which today mixes Git
  scope, origin and host in one enum) and the Runtime table change labels and counts. On this
  machine 32 project folders lost a false Desktop origin when discovery began setting imports aside
  (re-measured 2026-09-27; 23 on 2026-09-26).
- The usage cache schema changes (new session fields); a rebuild is expected.
- Tests that pin current names change together (inventory in the audit record, Addendum 3).
- `CLAUDE_CODE_ENTRYPOINT` and the transcript format are internal to Claude Code and may change;
  keeping the raw value and an "Other" fallback bounds that risk.
- Privacy is unchanged: only enumerated values and counts are read.

## Open questions for acceptance

- Whether "Cloud session" should appear at all in local views, given none was observed locally.
- Whether the "on 3P" attribute is worth showing.
- How ADR-0057's role lenses consume surface and initiator.

## Verification (when implemented)

Fixtures per raw value; an import-ledger join fixture; a census reproduction of the 2026-09-26 counts
from enumerated values; one-label-per-value UI assertions across views; no prompt content in any
fixture.

## Implementation status

§3 is implemented for project discovery and the System projects note (2026-09-27): an imported copy
gives no project, host or origin, and discovery counts it in `importedExcluded`. The per-source
labels from the imports ledger, Runtime attribution and §1, §2 and §4–§6 remain follow-on work
(the audit record's Addendum 3).
