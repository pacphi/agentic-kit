# Maintenance

Maintenance answers one question about the agent-related footprint on this machine:

> Show me the verified agent-related resources on this environment, where each exact placement
> came from when that can be established, what consumes it, what has changed, and only the actions
> or decisions that Agentic Kit can ground.

System measures. Maintenance explains what is verified about every resource placement and offers
only bounded, exact operations. It is not a generic cleaner, installer, vulnerability scanner,
package manager, or root administration console.

Use **System > Maintenance** in the dashboard for browsing, guided work, and one-action changes.
Use `ak maintain` for JSON output, discovery configuration, and scripted flows. Every write is one
exact placement and one action, previewed first and confirmed explicitly, and it leaves a receipt.

## Four destinations

The dashboard workspace has four tabs. Each answers a different question.

| Destination | Question it answers |
|-------------|---------------------|
| **Inventory** | What exists? Browse scope, repository where applicable, type, family, then exact installation. Healthy resources remain included. |
| **Guidance** | What can I accomplish? Only outcomes Agentic Kit can ground, in five lanes. |
| **Discovery** | Where does Agentic Kit look? Automatic sources, your projects and collection roots, exclusions, and scan coverage. |
| **Activity** | What changed? Receipts, undo, interruption audits, dispositions, recipe changes, and scan records. |

Opening Maintenance reads the last complete inventory and opens **Inventory** across all scopes.
Nothing scans on open. A fresh installation has no inventory yet; the empty state reads **No
inventory has been built yet. Use Refresh evidence, above, to build it.** and every automatic source
reads **Not scanned yet**. Two actions sit side by side above the tabs, each with its own helper
text:

- **Refresh evidence** runs provider probes on the saved measurement and rebuilds the inventory.
  It takes seconds. The CLI equivalent is `ak maintain scan --refresh-inventory`.
- **Re-measure machine** walks the filesystem to re-measure installs, storage, projects, and every
  discovery source, then refreshes evidence. It takes minutes. The CLI equivalent is
  `ak maintain scan --deep --refresh-inventory`.

Refresh evidence is the only control that runs executable provider probes. While either action
runs, both buttons are disabled, the status line says what is running ("Refreshing evidence…" or
"Re-measuring the machine… this can take minutes."), and apply, undo, and record are refused. If
the work does not finish, the previous evidence is kept. The inventory build runs after the probes
settle and can take a few seconds on a large footprint; the empty state reads **Building the
inventory…** until the rows appear, and **The last inventory build did not complete** with a short
reason if it fails. The retired Catalog link (`#system/catalog`) redirects to Inventory.

## Inventory

The **Focus browser** described below was approved and implemented on 2026-09-08.
See [focused validation](archive/2026-09-08-validation-maintenance-focus.md); older builds may
still show expanded resource cards. The approved interaction does
not change the exact-operation, preview, confirmation, or receipt contracts in this guide.

### Find a resource one level at a time

**Across scopes** begins with four choices: **System**, **Machine**, **User**, and **Projects**.
Choose a scope, then a resource type, resource family, and exact installation. Projects adds a
repository step before resource type. The breadcrumb returns to any earlier level. The browser
shows only the current level, rather than thousands of installation cards at once.

Scope, project, and type filters skip levels you have already selected. For example, choosing
MCP registrations while inside User shows those resources in User, with User still in the context.
Removing a filter restores the corresponding navigation level. Other filters and search narrow
the same inventory. Singleton scope, project, type, and family choices appear in the breadcrumb
instead of repeated chips; other and multiselect refinements keep removable chips. Breadcrumb
backtracking or sidebar deselection removes navigation choices.

Projects offers repository choices by default. **Include worktrees**, below project search,
reveals worktree choices; selected worktrees stay reachable until deselected. There is no Project
type control. This preference changes browsing choices, not saved measurements, discovery sources,
or the exact installation targeted by an operation. Measured ordinary project folders retain
their distinct designation rather than being falsely labelled Git repositories.

### Exact installations

A family can contain multiple installations across scopes, hosts, and projects. Family identity
comes from recorded evidence, not matching display names. Selecting a family reveals exact rows:
one file, configuration entry, package, cache object, or model revision per installation. Location
appears first, followed by **Available to** consumer names and applicable measured version evidence.
Project locations are relative to the measured repository. Missing location evidence never creates
a guessed `.claude` or `.agents` directory.

A skill installed once and consumed by several hosts appears once with several consumer bindings.
A family may group measured versions for browsing while preserving each exact resource and placement
identity. Conflicting definitions remain evidence, not permission to remove a copy. Counts count
distinct installations once, even when a relationship links to one from another branch.

Resource kinds include Skill, MCP registration, Plugin, Hook, Instruction file, Agent, Command,
Host adapter, Executable, Runtime, Model, Provider configuration, Cache, Credential, and Storage.

### Views, facets, search, and sorting

- **Curated views** include All resources, Can apply here, Steps available, Decisions to make,
  Updates available, Dependencies, Conflicts and overlaps, Duplicated placements, Disabled
  resources, Credentials and providers, Models and runtimes, Storage and caches, Recently
  changed, and Inventory evidence only.
- **Facets** are multiselect and show counts. Scope, environment, project, type, hosts/adapters,
  carrier, provenance, package manager, version, Guidance, dependency, conflict, credential,
  channel, evidence, and recent-change filters remain available. **Clear all** removes facets;
  narrow screens use a **Filters** sheet.
- **Search** matches displayed names, location breadcrumbs, and consumers. Exact private paths
  do not enter filter URLs.
- **Sort** applies within the current level: guidance first, name, recently changed, or kind.
  Guidance-first prioritizes Recovery to finish, Can apply here, Steps available, Decisions to
  make, Updates available, Inventory evidence only, then Healthy resources. This order is not a
  severity assessment and does not expand all branches.
- Bounded pages retain their inventory-generation identity. When a newer snapshot replaces the
  source, the browser reloads the current query instead of mixing generations or treating a
  partial page as the whole inventory.

A valid linked view takes precedence over privately remembered preferences. Navigation state uses
opaque identities; a displayed repository or location never becomes an action target string.

### Details and relationships

Selecting an exact installation opens details below the current list. They explain identity,
location, provenance, versions, consumers, changes, available outcomes, evidence, and history.
Closing details restores the originating row. Relationships use compact expandable cards; a
question with no supporting evidence is omitted or states what has not been established.

- **Provides / Provided by** links plugin contents only with manifest or recorded producer evidence.
  **Installed by** requires an installer receipt; an enclosing plugin directory is insufficient.
- **Available to** names recorded consumer bindings. It does not claim recent use.
- **Requires / Required by** links a verified dependency in either direction.
- **Overrides / Overridden in** requires that host's precedence and effective-configuration evidence.
  A project scope alone does not prove that it overrides user configuration.
- **Also installed** links other exact installations of the same established resource family.
  Equal names do not establish equivalence, and missing origin does not prove independent ownership.

Opening a related installation keeps your inventory location and filters unchanged. If the related
installation falls outside those filters, details say so explicitly. Back returns to the previous
related installation; closing details returns to the original list. These links neither change
resources nor recommend an operation. **Optional actions**, such as supported removal or
disablement, stay separate from Guidance and retain the same exact preview and confirmation flow.

Locations render as short breadcrumbs or measured relative project locations. Use **Reveal exact
path**, then **Copy exact path**, for the owner-private absolute path. Exact paths never enter
inventory links or global toasts; exported receipts remain sanitized unless you explicitly choose
to include local paths.

### Evidence grades in plain words

Every field the inspector shows carries one of three grades:

- **Verified**: Agentic Kit observed it directly. Only verified evidence supplies a label or the
  premise for an action.
- **Provider-declared**: a host or provider reported it. It renders with that authority named.
- **Technical details**: everything inferred. It never drives a label, a filter, or an action.

Missing evidence omits the field; the workspace never fills a gap with a placeholder value.

Credentials are shown by mechanism only (environment variable, keychain entry, credentials file, or
host login) and by readiness: Not configured, Configured but not checked, Ready, Check failed, or
Expired or renewal needed. Values, token metadata, account emails, private registry URLs, and raw
configuration never render.

### Conflicts say what they prove

Each conflict names what the evidence proves and what it does not: Duplicate placement, Shadowed
override, Same name but different definition, Equivalent MCP transport, Version requirement
divergence, Dependency resolution collision, and Shared artifact. A shared artifact is not a
duplicate and grants no removal authority.

## Guidance

Guidance has five lanes: **Can apply here**, **Steps available**, **Decisions to make**, **Updates
available**, and **Recovery to finish**. Each entry leads with the outcome, names the placement,
states the verified premises, and describes the impact and what is preserved.

### What admits a row

A placement enters Guidance only when all of these hold: it is one exact placement, its condition
is verified, the outcome is bounded, and the entry is grounded in one of a registered provider
operation, a signed procedure, a set of decision choices, an exact update candidate, or a receipt.

- **Can apply here** needs a registered provider whose current, complete detection matches the
  exact placement. A placement blocked by an unresolved receipt is not offered here.
- **Steps available** needs an active signed recipe compatible with the placement's condition
  (missing verified dependency or update candidate present).
- **Decisions to make** appears for a missing verified dependency. It always offers four choices:
  **Repair command path**, **Relink dependency**, **Reinstall dependency**, and **Remove
  registration**. A choice that cannot be grounded stays visible with the reason.
- **Updates available** can disclose host-reported availability from a verified candidate source
  while explicitly stating that compatibility is unverified. Other candidate entries require a
  verified installed version and compatibility. The word *recommended* appears only when a named authority is verified; otherwise
  the entry says a candidate is available. Prerelease and nightly candidates appear only for
  placements enrolled in that channel.
- **Recovery to finish** comes from unfinished receipts.

Anything else stays in Inventory, and its inspector says:

> No action is requested. Agentic Kit does not have a verified operation, procedure, or bounded
> decision to offer for this condition in the current environment.

That sentence is calm evidence, not a warning, and it never counts toward the Guidance badge.

### Action vocabulary

Actions use exact verbs: Update, Disable, Remove, Reinstall, Clean cache, Restore, Archive, Apply
project patch, Relink dependency, and Repair registration. An irreversible outcome carries a
warning and offers snooze as the containment choice. There is no catch-all verb and no batch button.

### Dispositions

You can record a disposition for a Guidance entry from the entry itself (**Acknowledge**, **Snooze
until** a chosen date, or, for an update candidate, **Ignore this candidate**, each explained before
you press **Confirm**), with `ak maintain disposition`, or through the dispositions route. The
kinds are **Acknowledged**, **Snoozed** until a date at most 365 days ahead, and **Ignored exact
candidate**. The dashboard shows recorded dispositions in the inspector's history and under
Activity. Snoozed and ignored entries leave Guidance; acknowledged entries are recorded but stay
visible. A disposition never removes anything from
Inventory, and it is invalidated automatically by expiry, a candidate change, an installed-version
change, a dependency change, source drift, or a security-severity increase.

## Procedures

**Open procedure** on a Steps entry renders a copyable panel: the outcome, the source (authority,
publisher, recipe version), compatibility (OS and version range, architecture, host range, resource
kind, package manager range), privilege, network need, effect, what is preserved, the command for
your shell, a verification command, and a three-step checklist (review, run, verify) that is
remembered per entry.

- Shells: bash, zsh, PowerShell, cmd.exe, and a WSL shell. Your preferred shell is remembered per
  environment.
- **Copy command** copies text. Maintenance never runs a procedure for you.
- An elevated procedure is still copy-only. You run it in your own elevated terminal, and
  Maintenance never asks for a password.
- Package managers Maintenance can describe: Homebrew, MacPorts, apt, dnf, pacman, zypper, snap,
  npm, pnpm, yarn, bun, pip, pipx, uv, cargo, mise, asdf, winget, Chocolatey, and scoop. The matrix
  states what each can prove (provenance, dependencies, candidates); it never grants install
  authority. Support follows an N-3 policy: the current major plus three preceding majors for
  semantic-versioned managers, the current release family plus three preceding for OS-coupled
  managers, and a documented minimum tested version for rolling managers.

### Recipe trust

Procedures come from signed recipes. The built-in catalogue is signed with a bundled publisher key,
which is tamper evidence for the local store rather than a secret.

`recipes refresh` fetches a registry only when one is configured for the installation, and only
over HTTPS from an allowlisted host. Redirects are bounded to three and must stay in the allowlist,
the response must fit in 256 KiB, every recipe must match the expected publisher, and its digest and
signature chain are verified. Refresh produces a diff and a pending queue; each recipe is accepted by
id and version, and a withdrawn recipe creates no new Guidance. The stock CLI and dashboard have no
registry configured, so refresh reports that plainly and the built-in catalogue is what you get.

## Discovery

Discovery is where you tell Agentic Kit where to look. Configuration is user intent and lives in
`kit.json` under `maintenance.discovery`; scan state lives in owner-private storage.

### Sources

- **Automatic sources** are enabled on every installation and can be toggled: Claude user
  configuration, Codex user configuration, OpenCode user configuration, Hermes user configuration,
  Projects (every project a recorded host session has visited), Runtimes, Package managers, Ollama
  (over loopback only), and Providers. Each states what it inspects, never a path. Automatic
  sources have no per-source scan control: their coverage comes from **Re-measure machine**, and
  the non-filesystem ones (Runtimes, Package managers, Ollama, Providers) are covered by the
  provider check. Asking `ak maintain scans start` to walk one of those is refused with
  `SOURCE_NOT_SCANNABLE`.
- **Exact projects** and **collection roots** are folders you add. A collection root can carry a
  depth limit. Roots must be absolute, lexically normalized, not symlinks, and real directories.
  Network, removable, cloud-placeholder, and Windows-to-WSL boundaries are excluded by default and
  need an explicit per-root opt-in.
- **Exclusions** are exact or recursive paths that no source may enter.
- Every source reports one coverage state: **Not scanned yet**, complete, scanning, paused,
  stopped, or failed. A source that has never run reports no visited work at all.

### Preview before save

**Add a source** takes a path and a kind, and **Preview** shows what would happen: projects found
with breadcrumbs, exclusions that apply, depth, symlinks skipped, filesystem boundaries, an estimate
of entries, bytes, and time when measurable, permission denials, and the hard ceilings (depth 8,
20,000 entries). Nothing is saved until you press **Save source**, and a saved root starts scanning
at once. Removing a source or stopping its scan shows the affected resources first and asks
**Remove this source?** or **Stop this source?**.

### Work slices and safety ceilings

Scans are resumable and completion-oriented.

- A **work slice** (20,000 entries or 250 ms by default) checkpoints and yields. It never ends a
  valid scan; the source resumes from its checkpoint.
- A **safety ceiling** (depth, entries, file size, memory, output, process time, or response size)
  stops the source and names the ceiling that was hit.
- If a source changes during measurement, the smallest affected partition is invalidated and
  requeued, up to three restarts, after which the source reports that it changed.
- Roots you added carry the per-source controls: **Pause** and **Stop** while running, **Resume**
  and **Stop** while paused, **Retry scan** after a failure, and **Scan this root** if it has never
  run. A started root keeps running through its work slices until it completes, pauses, stops, or
  fails; you never have to resume it yourself. `ak maintain scans start --source ID` does the same
  from the CLI and waits for the final state. Automatic sources show instead whether they are
  measured by Re-measure machine or covered by the last measurement.

Progress is factual: "Scanned N entries. X of Y sources are complete. N sources have not been
scanned yet." Counts are visited work, never totals.

### Incomplete sources never overclaim

The last complete snapshot stays authoritative; a partial or failed run never replaces it. A
placement whose source is still scanning carries the condition **Source scan incomplete** in its
technical details. Inventory shows a one-sentence banner, such as "4 sources have not been scanned
yet." or "2 sources stopped at a limit (entries).", with at most one button: **Re-measure machine**
when sources have never been scanned, **Open Discovery** when sources are paused, stopped, or
failed, and none while sources are still scanning. The banner never lists every source; per-source
detail stays under **What proves this?** in the inspector. The non-filesystem automatic sources
(Runtimes, Package managers, Ollama, Providers) never appear in it, because their evidence comes
from the provider check.
While a source is incomplete, Maintenance makes no claim of absence, totals, uniqueness, complete
conflicts, complete reverse dependencies, or reclaimable totals, and offers no action that depends
on completeness.

### Retention

Checkpoints are bounded to 256 KiB, expire after 7 days, and are rejected if the source, environment,
exclusions, or policy drifted. Scan history keeps at most 10 summaries per source per environment for at most
90 days; you may lower either figure, never below one. Receipts, dispositions, and recipe acceptance
records are never cleared by history retention.

## Activity

Activity has six groups: **Recovery to finish**, **In progress**, **Change receipts**,
**Dispositions**, **Recipe changes**, and **Scan records**. A committed reversible receipt offers
**Undo**; every receipt offers **Export**.

An export is sanitized by default: secrets, credentials, tokens, private registry URLs, raw
configuration, and rollback material are omitted, and absolute paths are redacted. Ticking
**Include local paths** warns you and requires **Export again**. The CLI needs both
`--include-local-paths` and `--acknowledge-warning`.

## Audit an interruption, then record an outcome

If an apply or undo was interrupted after dispatch but before verification, the receipt appears
under Recovery to finish with one button: **Audit interruption**.

The audit is read-only. Before it inspects anything it discloses what it will check (receipt
integrity, last durable phase, recorded provider version, current state) and its policies:
read-only provider inspectors only, and no network unless the recorded provider's inspector needs
it. It never retries, replays, undoes, or completes the action, and it can audit several receipts at
once.

Each audit ends in one of seven results. Three are conclusive and enable exactly one **Record**
button:

| Audit result | Record button it enables |
|--------------|--------------------------|
| No action started | Record no change |
| Matches recorded before state | Record no change after an interrupted apply; Record restored after an interrupted undo |
| Matches verified after state | Record completed |

The other four (Differs from both recorded states, Matching inspection provider is not present,
Receipt integrity check failed, Affected catalog refresh did not complete) say **No corrective
action is offered.** Resolve the named evidence problem and audit again.

Recording is a separate, single-receipt write. The dashboard asks you to type `RECORD`; the server
reruns the audit under the mutation lock and refuses with `RECONCILE_OUTCOME_NOT_ENABLED` if the
audit no longer enables that outcome. From the CLI:

```bash
ak maintain audit --receipts mnt-receipt-a,mnt-receipt-b
ak maintain reconcile --receipt mnt-receipt-a --outcome record-completed --yes
```

`ak maintain recover --receipt ID` is now a read-only alias for the audit. It records nothing.

An unresolved receipt blocks writes to its own placement, environment, and dependents; unrelated
environments stay writable. A receipt that fails its integrity check blocks all writes until you
resolve it.

## One action per write

Every write plan carries exactly one action for one placement, in the dashboard, the API, and the
CLI. Selecting a second candidate is refused before any effect with `ONE_ACTION_PER_PLAN`. The
CLI refuses more than one id in `--actions`, and more than one id in `--findings` when
`--executable` is set, before the request reaches the service. Reads (scans, queries, previews,
audits) may batch.

## Plan, apply, undo

A read-only plan can list several findings:

```bash
ak maintain plan --findings FINDING_ID_1,FINDING_ID_2
```

An executable plan derives one action from fresh evidence and persists it for five minutes:

```bash
ak maintain plan --placement plc_ID --guidance gid_ID --executable --json
ak maintain plan --findings FINDING_ID --executable --json
```

Keep the plan id, its SHA-256 digest, and the action id together. The plan id identifies evidence;
it does not authorize anything. Apply requires every binding and explicit confirmation:

```bash
ak maintain apply --plan PLAN_ID --digest PLAN_SHA256 --actions ACTION_ID --yes
```

Before the first effect, Maintenance reloads the provider, replans, compares source state, and
preflights the action. Evidence drift, expiry, a changed provider, or an unfinished earlier receipt
stops the transaction. After dispatch, the provider verifies its postcondition and Maintenance
refreshes the deep System snapshot. The receipt records the outcome.

In the dashboard, a Can apply here entry previews the exact operation and its consequences. An
approval-required or irreversible action asks you to type `APPLY 1`.

Only an eligible committed receipt can be undone:

```bash
ak maintain undo --receipt RECEIPT_ID --yes
```

Undo needs the recorded provider and version, a reversible or compensating operation, and an exact
current postimage. If anything changed after apply, undo refuses instead of overwriting the new
state. If no inventory has been built yet, plan and apply refuse with `SCAN_REQUIRED`; choose
**Refresh evidence** or run `ak maintain scan --refresh-inventory` first. If a placement cannot be
bound to an exact executable finding, they refuse with `PLACEMENT_FINDING_UNRESOLVED`.

Rollback classes are separate from safety: **reversible** (the provider restores and verifies the
recorded preimage), **compensating** (a new operation moves toward the prior state), and
**irreversible** (no automated recovery). Read the restart and rollback lines before confirming.

## What can act today

| Resource owner | Actions | Important limits |
|----------------|---------|------------------|
| Claude plugin CLI | Disable, update, and remove with data preserved; disable can be undone with native enable | Update needs one exact reported candidate. Prune is not offered. Update and remove are irreversible. Restart required. |
| Codex plugin CLI | Remove an exact removal candidate | No per-plugin update or disable. Ambiguous version candidates stay report-only. Restart required. |
| Codex MCP CLI | Remove an exact user-scope registration | Project-scope registrations stay report-only. No claim about server health or authorization. Irreversible; restart required. |
| Claude MCP | None | No provider is registered; registrations stay report-only. |
| OpenCode plugin/MCP | None | No verified native adapter; placements stay report-only. |
| Agentic-kit-owned skill | Conditional adapter: archive/prune; its own projected finding offers archive only | The stock CLI and dashboard do not supply a receipt/root resolver, so they do not register this adapter. Plugin caches, changed trees, symlinks, special files, and unreceipted trees are preserved. |
| Agentic-kit-owned stale npx environment | Clean the one exact collector candidate | Other caches and transcripts are excluded. Irreversible. |
| Ruflo MCP orphan | Terminate an exact same-user, PPID-1 orphan after an identity recheck | Requires a numeric UID and is unavailable on Windows. Not a generic daemon kill. |
| Git project patch | Apply one exact server-authored file replacement inside a configured project root | Registered only when a composition supplies configured project roots; the stock CLI and dashboard do not. Refuses a target outside those roots, a symlink or submodule in the path, index or worktree drift on the affected path, or a preimage digest mismatch; unrelated dirty files are fine. Never runs stash, commit, branch, checkout, push, or merge. Content is bounded to 256 KiB and validated as JSON, TOML, or YAML when declared, plus up to five declared checks; a failed check restores the original bytes. The preview shows up to 100 changed lines per side. Reversible; no restart. |
| Ollama model | Remove exactly one local Ollama model | Registered by default; Remove model appears only when Ollama is reachable and every premise is verified. Detection reads `/api/tags` and `/api/ps` over loopback only and reports the daemon unavailable when it cannot, so an absent Ollama yields no action; apply runs `ollama rm` with the exact name. Refuses when the tag or process list is incomplete, the model is currently loaded, its digest differs from the expected one, any route consumer is missing from the complete consumer list, or shared-blob accounting is unavailable. Physically reclaimed bytes are zero when the content is shared with another model. Irreversible; a redownload is required to use the model again. No elevation, no restart. Names containing a slash stay report-only. |

The service registers only providers it can execute. Npx actions depend on current collector
evidence. The absence of a button can be the correct result.

## Skill ownership is stricter than inventory identity

Direct MCP registrations and plugin-provided registrations retain separate identities: a
plugin prefix identifies the provider, even when its server has the same name. Inspect
**Provided by** to follow that relationship. Nested Codex tool settings are part of their
server registration and are not separate MCP installations.

Measured user instruction files retain their resolved configuration location through
**Reveal exact path**. Their paths remain private in ordinary inventory responses.
Refresh evidence after upgrading to populate locations missing from an older snapshot.

Inventory can relate a standalone skill and a plugin-contributed skill by exact name, bounded
entrypoint digest, or bounded full-definition digest. Full-definition equality includes the
observed regular files in the bounded skill tree; it still does not prove which copy the host uses,
or that either tree is owned, unused, or safely removable.

An owned skill action requires an <code>agentic-kit.skill-tree-ownership/v1</code> receipt that
binds the complete recursive regular-file manifest, including <code>SKILL.md</code>, and matches
the current shape and digest. The target must be a non-symlink direct child of the exact allowed
root under the current owner. Plugin-cache children are never direct skill targets. Legacy,
partial, modified, unreadable, ambiguous, or unreceipted trees stay report-only.

One skill tree may be discovered by several hosts. Inventory counts that tree once and records one
consumer binding per host; those hosts appear under **Who uses it?** and in the preview's blast
radius. Removing one project copy is never described as removing several copies merely because
Claude, Codex, or OpenCode can all discover it.

Discovery rules differ by host. Claude applies personal/project precedence and namespaces plugin
skills; Codex discovers repository and user `.agents/skills`; OpenCode also discovers compatible
`.claude/skills` and `.agents/skills` roots unless that compatibility is disabled. A shared
`SKILL.md` format does not prove identical precedence, permissions, advertisement, or runtime use.

## Mutation lock recovery

Maintenance serializes effects with an owner-private, integrity-sealed lock. It reclaims an
abandoned lock only when all of these are proven:

1. the lock and owner record are private, regular, non-symlinked files;
2. the seal is valid;
3. the recorded machine is this machine;
4. the recorded UID is numeric and equals the current UID;
5. the recorded PID is provably dead; and
6. a second identity check under an exclusive reclaim marker agrees.

A live, remote, tampered, malformed, wrong-owner, unknown-UID, or liveness-unknown lock stays busy.
Lock recovery permits a new coordinator to start; it does not reconcile an interrupted receipt.
Use the audit and `ak maintain reconcile` for the receipt.

## The `ak maintain` verbs

Add `--json` to any verb for the complete DTO. Verbs that write require `--yes`.

| Verb | What it does |
|------|--------------|
| `scan [--deep] [--refresh-inventory]` | Runs the provider check on the saved System inventory; `--refresh-inventory` rebuilds the Inventory afterwards (the dashboard's **Refresh evidence**). With `--deep` it re-measures System first and walks every discovery source to completion before rebuilding (the dashboard's **Re-measure machine**). |
| `inventory [--scope S] [--view V] [--facet name=value ...] [--search TEXT] [--sort ORDER] [--cursor TOKEN] [--limit N]` | Queries placements. |
| `show --placement ID [--reveal]` | Prints the inspector; `--reveal` prints the exact, owner-only path. |
| `guidance [--lane LANE]` | Lists admitted Guidance entries and per-lane counts. |
| `procedure --guidance ID [--shell SHELL]` | Renders a copyable procedure. |
| `discovery` | Prints configured sources, coverage, progress, and history. This verb prints the roots you configured. |
| `sources add --kind exact-project\|collection-root --root PATH [--yes]` | Previews a source; `--yes` saves it. |
| `sources remove --source ID [--yes]` | Shows the affected resources; `--yes` removes the source. |
| `sources enable\|disable --source ID` | Toggles an automatic source. |
| `sources exclude --path PATH [--recursive]` | Adds an exclusion. |
| `sources unexclude --exclusion ID` | Removes an exclusion. |
| `scans` | Prints scan progress. |
| `scans start [--source ID,...] [--deep]` | Starts scans for the named roots, or every filesystem source, and waits for their final state. A non-filesystem automatic source is refused with `SOURCE_NOT_SCANNABLE`. |
| `scans pause\|resume --source ID` | Pauses or resumes one source. |
| `scans stop --source ID [--yes]` | Shows the affected resources; `--yes` stops the source. |
| `activity` | Prints the six Activity groups. |
| `receipt --receipt ID [--export [--include-local-paths --acknowledge-warning]]` | Prints or exports one receipt. |
| `audit --receipts ID,...` | Read-only interruption audit; may batch. |
| `reconcile --receipt ID --outcome record-no-change\|record-completed\|record-restored --yes` | Records one audited outcome. |
| `disposition --guidance ID --kind acknowledged\|snoozed\|ignored-exact-candidate [--until ISO] --yes` | Records a disposition. |
| `plan [--findings ID,...] [--safety-class CLASS] [--project PATH] [--executable]` | Read-only plan, or one executable action with `--executable`. |
| `plan --placement ID [--guidance ID] --executable` | One executable action for one placement. |
| `apply --plan ID --digest SHA256 --actions ID --yes` | Applies exactly one action. |
| `undo --receipt ID --yes` | Undoes one eligible receipt. |
| `recover --receipt ID` | Read-only alias for `audit`. |
| `recipes list\|refresh\|accept\|withdraw [--recipe ID --version V --yes]` | Manages the recipe catalogue. |
| `preferences [--set key=value ...]` | Reads or saves owner-private preferences. |

Two sentinel flows, end to end:

```bash
# A dangling MCP registration: find it, inspect it, read the steps.
ak maintain inventory --search lightpanda --json
ak maintain show --placement plc_lightpanda --json
ak maintain guidance --lane steps
ak maintain procedure --guidance gid_lightpanda_steps --shell zsh

# An interrupted cache cleanup: audit, then record the one enabled outcome.
ak maintain audit --receipts mnt-receipt-a,mnt-receipt-b
ak maintain reconcile --receipt mnt-receipt-a --outcome record-completed --yes

# A new collection root: preview, then save.
ak maintain sources add --kind collection-root --root /path/to/projects
ak maintain sources add --kind collection-root --root /path/to/projects --yes
```

Human output never prints a path except for `show --reveal` and `discovery`.

## State and privacy

Discovery intent lives in your kit configuration:

- POSIX: `~/.config/agentic-kit/kit.json` (or `$XDG_CONFIG_HOME/agentic-kit/kit.json`), and
- Windows: `%APPDATA%\agentic-kit\kit.json`,

under the `maintenance` key:

```json
{
  "maintenance": {
    "discovery": {
      "automaticSources": { "hermes-user": false },
      "exactProjects": [{ "root": "/absolute/project" }],
      "collectionRoots": [{ "root": "/absolute/projects", "maxDepth": 4, "includeNetwork": false }],
      "exclusions": [{ "path": "/absolute/projects/archive", "recursive": true }]
    },
    "retention": { "maxSummaries": 16, "maxAgeDays": 30 }
  }
}
```

Everything else is owner-private state under the current user's agentic-kit state directory:

- POSIX: `$XDG_STATE_HOME/agentic-kit/maintenance`, or `~/.local/state/agentic-kit/maintenance`;
- Windows: `%LOCALAPPDATA%\agentic-kit\maintenance`.

Inside it: `latest-scan.json` (the provider report), `plans/`, `transactions/` (one `receipt.json`
per receipt), and `management/` with the last complete inventory, exact locators, the last-good
discovery snapshot, scan history, checkpoints, dispositions, preferences, recipes, and procedure
checklists. Directories use owner-only mode 0700 and files 0600 where the platform supports POSIX
modes. Records are bounded and integrity-sealed. Nothing in the inventory, a URL, a notification,
or an export contains a local path unless you reveal or export it deliberately.

## Dashboard security boundary

Maintenance is the only dashboard mutation surface. The v1 routes remain as compatibility:

```text
GET  /api/maintenance            (?refresh=scan runs the provider check, then rebuilds the Inventory)
POST /api/maintenance/plans
POST /api/maintenance/apply
POST /api/maintenance/undo
```

The v2 routes are exact. Path parameters must be opaque ids (`plc_`, `gid_`) or receipt ids
(`mnt-`):

```text
GET  /api/maintenance/v2/inventory?scope&view&sort&search&cursor&limit&facet.<name>=value
GET  /api/maintenance/v2/placements/{placementId}
POST /api/maintenance/v2/placements/reveal
GET  /api/maintenance/v2/guidance?lane
GET  /api/maintenance/v2/procedures/{guidanceId}?shell
POST /api/maintenance/v2/procedures/checklist
GET  /api/maintenance/v2/discovery
POST /api/maintenance/v2/discovery/preview
POST /api/maintenance/v2/discovery/sources
POST /api/maintenance/v2/discovery/sources/remove
POST /api/maintenance/v2/discovery/automatic
POST /api/maintenance/v2/discovery/exclusions
POST /api/maintenance/v2/discovery/exclusions/remove
GET  /api/maintenance/v2/scans
POST /api/maintenance/v2/scans
GET  /api/maintenance/v2/activity
GET  /api/maintenance/v2/receipts/{receiptId}
POST /api/maintenance/v2/receipts/export
POST /api/maintenance/v2/dispositions
POST /api/maintenance/v2/audit
POST /api/maintenance/v2/reconcile/preview
POST /api/maintenance/v2/reconcile
POST /api/maintenance/v2/plans
POST /api/maintenance/v2/apply
POST /api/maintenance/v2/undo
POST /api/maintenance/v2/recipes/refresh
POST /api/maintenance/v2/recipes/accept
POST /api/maintenance/v2/recipes/withdraw
GET  /api/maintenance/v2/preferences
POST /api/maintenance/v2/preferences
```

Every route sits behind the loopback bind and per-session token. GET queries reject unknown or
duplicate parameters, bound `limit` to 1..200 and `search` to 200 path-free characters, allow at
most 32 distinct values per facet, and refuse any value shaped like a local path. POST requires the
token in its header form, same-origin Host/Origin/Sec-Fetch-Site evidence, `application/json`, an
exact schema, and at most 64 KiB. Apply, undo, and reconcile consume a verb-bound, one-use
capability that expires after five minutes and is consumed before provider work starts. The browser
never sends a command, provider id, or action definition; the two Discovery routes that accept a
path carry the root you typed, validated as an absolute traversal-free path and stored as intent.

The accepted request bodies are exact; surplus keys are rejected:

| Route | JSON body |
|-------|-----------|
| v1 plans | `{"findingIds":["ID"]}`, 1..100 unique public ids |
| v1 and v2 apply | `{"capability":"TOKEN","confirm":true,"typedPhrase":"SERVER_PHRASE"}`; omit `typedPhrase` only when the preview did not require one |
| v1 and v2 undo preview | `{"receiptId":"ID","preview":true}` |
| v1 and v2 undo | `{"capability":"TOKEN","confirm":true,"typedPhrase":"UNDO"}` |
| v2 plans | `{"placementId":"plc_…","guidanceId":"gid_…"}` |
| placements/reveal | `{"placementId":"plc_…"}` |
| procedures/checklist | `{"guidanceId":"gid_…","stepId":"review","done":true}` |
| discovery/preview | `{"kind":"exact-project"\|"collection-root","root":"/absolute/path"}` |
| discovery/sources | `{"previewId":"prv_…","confirm":true}` |
| discovery/sources/remove | `{"sourceId":"src_…","confirm":false\|true}`; `false` returns the affected preview |
| discovery/automatic | `{"sourceId":"claude-user","enabled":false}` |
| discovery/exclusions | `{"path":"/absolute/path","recursive":true}` |
| discovery/exclusions/remove | `{"exclusionId":"exc_…"}` |
| scans | `{"action":"start"\|"pause"\|"resume"\|"stop","sourceId":"…","confirm":true}`; `sourceId` is required except for `start`, and `confirm` is accepted only with `stop` |
| receipts/export | `{"receiptId":"mnt-…","includeLocalPaths":false}`; including paths also requires `"acknowledgedWarning":true` |
| dispositions | `{"guidanceId":"gid_…","kind":"acknowledged"\|"snoozed"\|"ignored-exact-candidate","until":"ISO","confirm":true}`; `until` accompanies `snoozed` only and must be within 365 days |
| audit | `{"receiptIds":["mnt-…"]}`, 1..20 unique ids |
| reconcile/preview | `{"receiptId":"mnt-…","outcome":"record-no-change"\|"record-completed"\|"record-restored"}` |
| reconcile | `{"capability":"TOKEN","confirm":true,"typedPhrase":"RECORD"}` |
| recipes/refresh | `{"confirm":true}` |
| recipes/accept | `{"recipeId":"ID","recipeVersion":"V","confirm":true}` |
| recipes/withdraw | `{"recipeId":"ID","recipeVersion":"V","confirm":true}`; `recipeVersion` is optional |
| preferences | `{"lastView":{…},"preferredShellByEnvironment":{"env_…":"zsh"},"retention":{…}}`; at least one key |

Plan, undo-preview, and reconcile-preview responses mint different verb-bound capabilities. They
cannot be moved between sessions, verbs, plans, or receipts.

If a Maintenance read fails, the panel keeps the failure visible and offers **Retry** rather than
rendering an empty workspace. The fragment token is also retained in page memory when browser
storage is blocked, so authenticated panels can still finish bootstrap.

## What Maintenance does not claim

- Available is not latest or recommended.
- Installed is not enabled, effective, or loaded into model context.
- Registered is not configured, reachable, healthy, authenticated, or authorized.
- Missing usage does not prove unused.
- Age or cache location does not prove stale or reproducible.
- Equal definitions prove equality of the bounded observed files only, never host selection,
  ownership, usage, or safe deletion.
- A shared artifact is not a duplicate and grants no removal authority.
- An incomplete source supports no claim of absence, totals, uniqueness, or reclaimable space.
- A receipt makes non-atomic provider effects visible; it does not make them atomic.
- An interruption audit observes provable current state; recording an outcome does not finish an
  interrupted operation.

For architecture and invariants, see [the Maintenance domain](ddd/maintenance.md),
[ADR-0048](adr/0048-inventory-led-maintenance-resource-management.md), the
[acceptance criteria and open gates](MAINTENANCE-ACCEPTANCE.md), and
[ADR-0044](adr/0044-receipt-aware-maintenance-control-plane.md) for the transaction engine.

### Resource descriptions and installation sources

Focus cards show the capability name with **Direct configuration** or **Provided by
<plugin>** where applicable. These labels do not merge installation identities.
The scanner retains declared skill, agent, and command description frontmatter and
installed plugin manifest descriptions. Cards show at most two lines; absent metadata
adds no placeholder. Descriptions are author declarations, not verified behavior.
Different descriptions within a family are shown on individual installation rows.

Metadata sources for further coverage:

| Resource | Source | Collection status |
| --- | --- | --- |
| Skills | `SKILL.md` description frontmatter | Local scan |
| Agents and commands | Markdown description frontmatter | Local scan |
| Plugins | Host plugin manifest `description` | Local scan |
| Projects | Package manifest description, e.g. `package.json` or `pyproject.toml` | Not yet collected |
| MCP servers | Initialization `serverInfo.description` | Requires runtime evidence; not yet collected |
| MCP tools | `tools/list` description | Requires runtime evidence; not yet collected |

The local scan does not launch MCP servers for descriptions or substitute a parent
plugin description for its components. Reads are bounded and displayed as plain text;
path-bearing descriptions are omitted from public Maintenance data. Refresh the
machine measurement after upgrading to capture new catalog metadata.

Project coverage is designed around build ecosystems rather than one manifest format.
See the [proposed project metadata adapter design](PROJECT-METADATA-ADAPTERS.md)
for the 25-language target, polyglot attribution, and unsupported-metadata behavior.

Project cards show up to three measured language badges, with an expandable remainder
for polyglot repositories. Artifact-only detections do not imply source line counts.
See the [dated top-50 coverage list](LANGUAGE-COVERAGE.md).

### Scan history dates

Activity presents scan history as a table grouped by the browser’s local calendar date,
newest first. Each date has a chevron toggle to expand or collapse its source rows; groups
start collapsed and retain their state while the dashboard stays open. Source rows show completion time and timezone, source, status, and entry count.
Discovery focuses on source configuration and current coverage; historical scans appear only
in Activity. Groups represent dates, not inferred shared scan runs. Missing dates remain explicitly unknown.
Version measurements, update checks, and snooze deadlines also use local date/time formatting.

Scan history retains the latest 10 completed records per source and environment, within the
90-day retention limit. Each new record replaces the oldest retained record for that source.

Activity places recovery, work in progress, receipts, dispositions, and recipe changes in a
responsive card grid above the full-width scan history. Narrow screens use a single column.

Scan history scrolls within a bounded panel sized for a date heading and about four source
rows. Column headers stay pinned while dates and records scroll.

Executable installations expose their measured launcher through **Reveal exact path**.
Detection checks PATH (including Windows PATHEXT), resolves symlinks, and reads bounded npm
`bin` metadata when a launcher is not on PATH. When only the installation root was measured,
that root remains revealable. Paths stay out of the public inventory. Re-measure machine
to collect new launcher evidence; discovery covers the environment running the scan.
