# Troubleshooting

Everything starts with the dashboard:

```bash
ak                  # status + one suggested next action (alias of `agentic-kit`)
ak status           # the same, without the hint (--json for CI)
ak sync --dry-run   # see exactly what sync WOULD do, with reasons
ak sync             # apply it
```

> [!TIP]
> The rule for managed configuration is **`status` to look, `sync` to fix**. Maintenance findings
> use their own scan → short-lived plan → explicit apply/undo/recover workflow; `sync` never selects
> or executes them.

## Common situations

| Symptom | What's happening | Fix |
| --- | --- | --- |
| `npm install @pacphi/agentic-kit` succeeded but `ak` is not found | A local install links the binary into the package root's `node_modules/.bin`, not the general shell `PATH` | run `npm exec -- ak status`, add an npm script, or use the recommended global install; see [Installation](INSTALLATION.md) |
| A global install exists but this shell cannot find it | The active Node/npm prefix changed, or its binary directory is not on `PATH` | compare `npm prefix -g`, `npm root -g`, and `command -v ak` (`where ak` on Windows); activate the intended Node toolchain before reinstalling |
| A one-shot/local `ak setup` changed global tools or project files | npm package scope does not constrain an `ak` command's operational scope | review [Installation scope](INSTALLATION.md#the-two-independent-scope-decisions) and [Setup scope](SETUP.md); use `--dry-run` before setup/sync/uninstall |
| Maintenance shows a finding but no action | The live service has no provider for that owner/operation, or evidence is incomplete, ambiguous, modified, unreceipted, or unsupported | Read the finding's evidence gap and provider limitation. Refresh with `ak maintain --refresh=machine`; if it remains blocked, use the named upstream workflow or preserve it. Do not delete a cache or skill tree based only on age, name, or entrypoint digest. See [Maintenance](MAINTENANCE.md). |
| `ak maintain apply` says the plan expired or evidence changed | Executable plans last five minutes and are bound to an exact source fingerprint | Run `ak maintain --refresh`, create a new `ak maintain plan --findings ID --executable`, review the new digest/action IDs, and confirm that plan. Do not reuse the old authorization. |
| Maintenance says a provider is unavailable or changed | The provider was absent, its version changed, or current probing no longer advertises the recorded operation | Restore/update the owning host through its supported lifecycle, rescan, and create a new plan. Unsupported OpenCode plugin/MCP and Codex per-plugin update findings are intentionally report-only. |
| Maintenance says another mutation is busy | A live transaction owns the serial lock, or the old lock cannot be proven safe to reclaim | Let the live action finish. Automatic reclaim requires a sealed same-machine/current-numeric-UID owner and a PID proven dead twice; remote, tampered, unknown-UID, and liveness-unknown locks stay busy. Do not remove the lock manually. |
| Undo is unavailable or refuses current state | The receipt is irreversible, its provider/version is missing, or the target no longer matches the recorded postimage | Preserve the current state and inspect the receipt. Undo is deliberately unavailable when it could overwrite later changes; use the provider's documented manual workflow if one exists. |
| An owned skill remains report-only | Catalog identity is weaker than removal authority; the tree lacks a complete current `agentic-kit.skill-tree-ownership/v1` receipt or contains drift, symlinks, special files, or a plugin-cache path | Preserve it. Only a complete recursive manifest, exact allowed root/current owner, and exact current shape/digest can authorize archive. Never promote an issue #198 entrypoint digest into tree ownership. |
| Maintenance reports `partial-recovery-required` and blocks new changes | A provider effect may have happened, but the durable receipt cannot yet prove wholly preimage or wholly verified postimage | Run `ak maintain recover --receipt RECEIPT_ID --yes`. Recovery only inspects and reconciles; it never retries or rolls back. If state is mixed/drifted, a provider is missing, or refresh fails, repair that evidence problem and retry recovery. |
| `ak sync` misses a newly published kit release | Older versions could plan from the kit's separate 24-hour self-update cache | Normal sync now refreshes the kit's own release channels before planning. Prerelease installs check `latest` and `next`; stable installs check `latest` only. `--dry-run` makes the same lookups and records nothing; `--no-upgrade` skips them. When every lookup fails, ak keeps the recorded versions and waits one version-check window (24 hours by default) before looking them up again; a real `ak sync` and `ak status --refresh` look them up regardless. |
| `ak sync` ends with `unresolved: [subsystem] fix — …` and exits 1 | Sync ran its plan, but a row it planned to fix is still there with the same fix, or no sync step performs that fix. The step may have succeeded without reaching its goal | Run `ak status` and read that row: its message says what still stands. Fix the cause it names, or follow a `→ manual:` step, then run `ak sync` again. A `no sync step performs this repair` line is an agentic-kit defect; please report it |
| `ak sync` launched from a checkout/local dependency created a global `ak` | The self-update step deliberately installs the resolved replacement globally and runs last | use `ak sync --no-upgrade` when the checkout or lockfile must remain authoritative |
| Different users or Node versions see different global stacks | npm `-g` means the active prefix, which can be per-user and per-Node-version | standardize the Node manager/prefix per user; do not repair this with `sudo ak setup` |
| `status` shows a deja-vu schema or capability warning | The CLI is older than 0.19.0, doctor JSON is missing/malformed/newer than schema 2, or an explicit enabled-host target is absent | update the owned installation with `ak sync`; update an external installation with its owner. Agentic Kit fails closed instead of guessing; see the [deja-vu runbook](DEJA-VU.md) |
| deja-vu index is `missing`, `stale`, or `stale-readonly` | Histories have not been indexed, changed since the last build, or the derived index cannot be rewritten | use `ak sync --dry-run`, then `ak sync`; for `stale-readonly`, repair the data-directory ownership/permissions first. The v0.19 command is `deja index`, not “warmup” |
| Codex receives automatic deja-vu recall while Agentic Kit says MCP mode | A user-owned Codex deja-vu plugin can contribute session/per-prompt/precompaction hooks independently of Agentic Kit's mode | disable/remove that plugin through Codex if MCP-only behavior is required. `ak sync` preserves external plugins and reports the effective auto surface without claiming a fix |
| `--purge-deja-vu-data` refuses the index path | The observed path is broad, relative, outside an approved data root, overlaps config/transcript sources, or crosses a symlink | move/reconfigure the derived index safely, run `deja doctor --offline`, then retry. Never bypass the guard by deleting a host transcript root |
| Just upgraded ruflo/agentic-qe (`npm i -g …`) and things feel off | Upgrades re-resolve dependencies: native SQLite bindings and the aidefence package get dropped, and ruflo's helper auto-refresh regenerates the statusline without the footer | `ak sync` (this is its main job) |
| `status` says `Ruflo … is unsupported: below the support window` | ak supports the newest six Ruflo minors, never fewer than those released in the last 30 days. Workarounds for Ruflo defects fixed before the window's floor have been removed, so an older Ruflo may misbehave | `ak sync` upgrades Ruflo. See [Ruflo support window](UPGRADING.md#2026-09-27-ruflo-support-window) |
| `status` says `Ruflo support window not yet known` | ak has not read Ruflo's release dates yet; `ak status` never looks them up itself | Run `ak sync` (not `--dry-run` or `--no-upgrade`): it reads and remembers them |
| `status` shows a host `installed but not executable` | npm exits 0 even when an optional dependency fails, so a package can be recorded without its platform binary. Codex ships its binary as per-platform versions (for example `@openai/codex-darwin-arm64`) published minutes after the main version, so an upgrade in that window can leave `codex` unable to start | `ak sync` reinstalls an npm-owned host and verifies it starts; upgrades and installs already retry once with `--prefer-online`. An external (mise/native/brew) install is reinstalled with its own tool |
| `status` shows `natives … WASM fallback` | agentdb resolved a non-native better-sqlite3 — on this path **memory writes can silently vanish**. Common causes are npm ≥11.17 blocking install scripts during upgrades, or a stale better-sqlite3 ≤12.9 pin on Node 26 | `ak sync` selects a Node-compatible release and installs the native binding |
| `status` says `ak applied Ruflo's native SQLite pin (ruvnet/ruflo#2219)` | To install a native better-sqlite3 where a bundled package could not find one, `ak sync` changed that package's own better-sqlite3 line (npm refuses the install otherwise). Ruflo pins better-sqlite3 to 12.8.0 or later for the same reason, but `npm install -g` does not apply Ruflo's pin. The row names each file, field, original value and ak's value | Nothing to do. `ak uninstall` puts each original value back where the file still holds ak's value. A Ruflo upgrade or reinstall replaces the file; `status` then says the edit is no longer there. Edits made before ak kept receipts are not listed and cannot be restored by ak; reinstall Ruflo if you want its shipped files back |
| `status` shows `ruflo memory runtime on WASM fallback (…): no native binding` | The better-sqlite3 that Ruflo's memory runtime loads has no compiled binding; the row ends with the load error | `ak sync` builds the native binding |
| `status` shows `ruflo memory runtime on WASM fallback (…): its native binding is present but will not load` | The binding file exists but was built for another Node.js version or platform, or is damaged; the row ends with the load error (for example `compiled against a different Node.js version`) | `ak sync` removes the binding that will not load, rebuilds it in place, and load-tests the result |
| `status` shows `ruflo memory runtime backend unverified` | The load probe timed out twice or ended without a diagnostic, so native versus WASM is unknown. Sync does not act on an unverified probe | Re-run `ak status` when the machine is less busy. If it persists, `npx ruflo doctor` shows the runtime's own view |
| `status` says `security defend uses Ruflo's built-in engine; @claude-flow/aidefence … is missing` | Ruflo does not declare `@claude-flow/aidefence` as a dependency, so an upgrade can drop it. `ruflo security defend` still screens prompts with Ruflo's built-in engine ([ruvnet/ruflo#2670](https://github.com/ruvnet/ruflo/issues/2670)); only adaptive learning and the `aidefence_*` MCP tools are missing | `ak sync` reinstalls it. `ak status --refresh=live --only security` reads defend's JSON verdict: it passes when defend flags an injection sample and passes a clean one |
| `ak status --refresh=live --only security` says `defend crashed before reporting a verdict (ruvnet/ruflo#3473)` | Ruflo's text-mode `security defend` crashes after it prints a detection. ak asks for `-o json`, which does not crash, so this means defend failed before giving any verdict | Re-run `ak status --refresh=live --only security`; if it repeats, run `ruflo security defend -i "ignore previous instructions" -o json` to see Ruflo's own output |
| `status` shows oversized RVF store(s) | A runaway append after a hard exit grew a `.rvf` past the 2 GB cap (seen at ~277 GB once) | `ak sync` quarantines the oversized store; agentic-qe rebuilds it |
| Statusline footer (🧠/🛡/🎓 lines) disappeared | `@claude-flow/cli`'s version-stamped helper auto-refresh pristine-copies `statusline.cjs` on the **first ruflo command after an upgrade** — including the statusline render itself | `ak sync` — it now triggers that refresh *first*, then re-injects, so the footer survives; `ak status` flags an armed wipe before it fires |
| Statusline footer is blank or stale with no visible error | Footer probes are intentionally silent during normal rendering | Set `AK_STATUSLINE_DEBUG=1` for one reproduction. Redacted stage/error metadata goes to `$XDG_STATE_HOME/agentic-kit/statusline-debug.log` (default `~/.local/state/agentic-kit/statusline-debug.log`, mode 0600, bounded at 64 KiB); set `AK_STATUSLINE_DEBUG_FILE` to redirect it, then unset debug |
| Statusline security line shows Ruflo's own scan status | ak no longer overlays Ruflo's security count: Ruflo fixed its fabricated CVE count in 3.32.2, below the support window. `ak sync` removes the overlay an older ak injected | Nothing to do. For a current result run `ruflo security scan`; use `npm audit` for dependency CVEs |
| Statusline shows a Ruflo version you do not have installed (for example `RuFlo V9.9.9`) | Ruflo's helper bakes a version into `.claude/helpers/statusline.cjs` as a floor and shows the highest version it finds. A baked value above every install never corrects itself. `ak status` flags it on the `statusline` row | `ak sync`: it clears the helper stamp so Ruflo's own refresh regenerates the helper, then re-injects the footer. `ak` never writes the version. If Ruflo's refresh cannot run (`.claude/helpers/.LOCKED` or `RUFLO_HELPERS_LOCKED`), edit `let ver` in that file to the installed version or lower. A version newer than `ak status` can also come from a newer Ruflo copy the helper finds, such as the Claude plugin marketplace checkout. That is Ruflo's own choice and `ak` leaves it alone |
| Codex's native status line did not change | Codex reads the user-wide setting when a session starts; an existing TUI may not hot-reload it | Exit and start a new Codex session; inspect ownership with `ak x statusline status` and drift with `ak status` |
| The right side of Codex's status line is missing | Codex has one width-constrained native line | Widen the terminal or choose the compact preset with `ak x statusline codex native` |
| Want the rich Ruflo/SONA/AQE display inside Codex | Codex currently accepts built-in status-line fields only, not a command-backed renderer | Keep the rich footer in Claude Code; see [Managed Codex status line](CODEX-STATUSLINE.md) for the current boundary |
| Too many `⚙` daemons / stale daemons | One daemon per active project is normal (local-only workers, $0). Stale = workspace deleted or past the 12h TTL | `ak x daemon-gc --kill`; `sync` also reaps (and verifies the pid really is a ruflo daemon before killing) |
| `status` warns that the memory backup is old, or `daemons` says none runs for this project | Ruflo backs up and distills project memory only inside the project's daemon, which ends itself after 12 hours. Ruflo starts it again on the next `ruflo` command unless start-on-use is off (`claudeFlow.daemon.autoStart: false` in `.claude/settings.json`, which `ruflo init` writes) | `ak sync` turns start-on-use on unless `kit.json` has `rufloDaemon.autoStart: false`. Otherwise run `ruflo daemon start` in the project root, or `ruflo memory backup` for a one-off copy; see [Memory backup and distillation](#memory-backup-and-distillation) |
| `daemons` warns that the daemon is running but deferred distillation or backup | The daemon skips a job while CPU load or free memory is past its threshold. On macOS it undercounts free memory ([ruvnet/ruflo#2935](https://github.com/ruvnet/ruflo/issues/2935)) | On macOS in a Ruflo repository, `ak sync` sets the threshold in `.claude-flow/config.json` and restarts the daemon. When that file is unreadable or holds your own value, or on other systems, the row is a manual step: set the flat key it names in that file, then run `ruflo daemon stop` and `ruflo daemon start` |
| `daemons` warns that ak-managed daemon settings differ | The installed Ruflo needs different keys in `.claude-flow/config.json` (after an upgrade, or on a new project), or `ruflo init` turned start-on-use off again | `ak sync` |
| `status` warns that `claude-flow.config.json` (or `.claude-flow/config.json`) points Ruflo memory away from the entries in `.swarm` | A command that saves Ruflo settings (`ruflo providers configure`, `ruflo config set`) created that file from Ruflo's defaults, whose `memory.persistPath` is `./data/memory` ([ruvnet/ruflo#3193](https://github.com/ruvnet/ruflo/issues/3193)). The MCP store and any `ruflo` command without ak's pin now look there | Set `memory.persistPath` to `".swarm"` in the file `status` names, or remove the key. `ak` does not edit a Ruflo configuration it did not write. `ak setup` and `ak sync` pin `.swarm` before registering providers, so they do not cause this |
| Want to change which MCP tool families are callable | Exclusions are `permissions.deny` rules, persisted in kit.json | `ak x mcp pick` (re-runnable); `x mcp status` shows the inventory; `x mcp off` unregisters |
| `status` says a legacy `ruflo`-keyed MCP registration is preserved | The entry is not the `ruflo mcp start` registration agentic-kit wrote (another path, `ruflo mcp`, a custom env key, or a project/local scope), so `ak sync` leaves it alone. With `claude-flow` also registered, Claude loads the Ruflo tools twice | Inspect it with `claude mcp get ruflo`, then run the command `status` prints (for example `claude mcp remove ruflo -s user`) if you don't need it |
| opencode: Ruflo/AQE are not connected, compact `ak_*` tools are missing, or `ak-specialist` is unavailable after `ak setup --opencode` / `ak sync` | opencode loads config, plugins, MCP servers, and agents **once at startup** — a running session never sees new wiring | quit and restart opencode; `ak status` shows MCP connectivity, compact gateway, lifecycle plugin, skill, and specialist state separately |
| opencode: `status` says `opencode.json is not plain JSON` | opencode legally allows JSONC comments; ak refuses to rewrite a file it can't parse rather than normalize (and silently drop) your comments | hand-merge the ak entries (`mcp`, `skills.paths`, `permission`) per `docs/adr/0017-opencode-host.md`, or remove the comments and run `ak sync` |
| opencode: `status` reports a later `opencode.jsonc` override | stock OpenCode loads that file after `opencode.json`, so it can shadow the exact MCP/permission values ak receipts; ak cannot verify JSONC without rewriting user comments | merge the Agentic Kit entries into the later file and remove the duplicate override, or keep the override and use direct user-managed wiring; ak preserves both files and does not deploy its gateway against ambiguous effective config |
| opencode: an agent/skill/plugin file you created yourself keeps ak's version away | deploys are no-clobber: only exact receipt-matching bytes are repairable; an unreceipted or edited destination is user-owned and preserved (`status` reports it as `foreign`) | rename yours (or remove it and run `ak sync` to get ak's managed copy) |
| opencode: `status` says `no ruflo catalog source` | the agent/skill catalog resolves override → `$RUFLO_REPO` → claude marketplace clone → `@claude-flow/cli` (direct, then nested under ruflo) — all missing | install ruflo (`ak setup` does), or point `integrations.ownership.opencode.catalogDir` / `$RUFLO_REPO` at a ruflo checkout |
| `ruflo memory store` says OK but reads return nothing | Missing project pin, wrong working directory, or CLI and MCP selecting different files when both `.swarm/memory.db` and `.swarm/agentdb-memory.db` exist | `ak sync` can repair owned registration drift. `ak status --refresh=live --only memory-routes` observes CLI↔MCP routing in an isolated directory only; it cannot show access to an existing corpus, so follow the routing section below |
| `status` shows a `codex-plugins` warning | A plugin is enabled in the wrong host, its newest cached hooks or skills fail a known Codex compatibility check, or `config.toml` cannot be inspected safely. The exact `codex@openai-codex` identity is a Claude Code companion and must not be enabled inside Codex | For a valid, regular `config.toml` and verified companion 1.0.6, preview the approval-required repair with `ak heal hooks --host codex`; it changes only that Codex entry, never Claude Code or the cache. Repair malformed TOML or merge symlink-managed config manually. For other plugin findings, open Codex `/plugins`, refresh or disable the named plugin, then start a new session. Setup and sync never rewrite Codex-owned plugin state |
| `status` says an external `agent-browser` is outside Ruflo's range | You installed a newer `agent-browser` yourself. ak never replaces a user-managed install, so `sync` cannot clear this, and Ruflo's browser tools may not work with that version | Install a Ruflo-compatible `agent-browser` 0.27.x yourself, or set `agentBrowser: false` in `~/.config/agentic-kit/kit.json` to stop ak managing the executor (Ruflo MCP then no longer gets ak's trusted browser config or readiness checks) |
| `status` lists a stray memory store | A tool wrote a store where this project's hosts do not read it, usually because it ran in another folder. ak only reports it | Nothing breaks. To keep its rows, inspect it read-only first; see [Stray memory stores](#stray-memory-stores) |
| `status` shows a `memory-pin` warning | `CLAUDE_FLOW_DB_PATH` is pinned to a dead or foreign path, so every memory op targets the wrong DB ("Database not initialized" beside a healthy in-repo DB). The pin may be deliberate, so `sync` never touches it | repoint (or remove) the pin in `.claude/settings.local.json` `env` |
| `status` shows an `aqe-pin` warning | AQE is not pinned to this project's root yet, a pin names another checkout's root (a copied `.claude/settings.local.json`), a file holds an `AQE_PROJECT_ROOT`, `AQE_MEMORY_PATH` or `AQE_STORAGE_PATH` value ak did not write, or git tracks `.mcp.json` or `.codex/config.toml` (ak never writes a machine path into a committed file). Without the pin, a command, hook or MCP server started in a subfolder creates its own `.agentic-qe` there | Not pinned: `ak sync`. Another root or a value you set: edit the named file by hand (remove the three keys), then run `ak sync` in this checkout. A tracked file: untrack it (`git rm --cached`, then `.gitignore`) and run `ak sync`, or start sessions from the project root; see [UPGRADING](UPGRADING.md#2026-09-27-aqe-is-pinned-to-the-project-root) |
| MCP tool governance stays `unknown` | No Ruflo MCP tool call was audited in the last 24 hours. Ruflo below 3.46.0 does not route stdio MCP tool calls through its policy enforcer, so no audit records are written there even though ak wrote the policy file and set `RUFLO_MCP_ENFORCE_POLICY=1` | Use a Ruflo MCP tool in the project; on Ruflo below 3.46.0 run `ak sync` to upgrade. A project whose `.harness/mcp-policy.json` is invalid shows `mcpGovernance: blocked` instead: restore a valid, ak-written file and run `ak sync`, which also removes the enforcement variable for that project until the file is fixed |
| A [ruflo component](MANAGED-TOOLS.md#managed-ruflo-components) stays `applied, not verified` | Claude Code, Codex, and OpenCode read their environment only at process start-up, so a change setup or sync just made has not reached a running session yet | Restart Claude Code, Codex, and OpenCode, then run `ak status --refresh` to re-collect evidence with the new environment in effect |
| Want to run `ak sync` but Claude/Codex/OpenCode sessions are open in other terminals | Upgrade-bearing syncs stop **all** ruflo daemons machine-wide and swap the global npm trees live sessions execute hooks/statusline/MCP calls from; even a no-upgrade sync can repair configuration or missing dependencies | `ak sync --dry-run` first; a `versions` row means idle the other sessions or use `ak sync --no-upgrade` (or `ak sync --skip versions` to hold back only the package upgrades); see [Running `ak sync` while sessions are live](UPGRADING.md#running-ak-sync-while-sessions-are-live) |
| Suspicious token burn | Background automation vs interactive usage | ask Claude to run the **ruflo-token-audit** skill (deployed by `setup`) |
| Observability is empty or has no ruflo/AQE nodes | Live mode tails Claude/Codex records by default, while ruflo/AQE stores are not auto-discovered | open Observability before producing activity; switch to History for retained sessions; register a trusted JSONL file with repeatable `--live-source 'surface=path'`; see [Observability](https://github.com/pacphi/agentic-kit/blob/main/docs/OBSERVABILITY.md) |
| Observability → Sources says `awaiting file`, `no events yet`, or shows rejected records for a `--live-source` | The registered file does not exist yet, exists but is empty, or holds records without a session ID, actor ID, and action. `--live-source` only reads a file something else writes | check the path and that its producer is running; a file that appears later is read from its first line. See [Source health](https://github.com/pacphi/agentic-kit/blob/main/docs/OBSERVABILITY.md#source-health) |
| Observability → Live shows a running session with 0 operations | Live draws operations written after it started watching (the map says when); earlier operations are only in the transcript | select the session and read its session stream, or open History for the retained session. See [Observability](https://github.com/pacphi/agentic-kit/blob/main/docs/OBSERVABILITY.md#troubleshooting) |
| A Claude Code or Codex session in a non-Git folder shows in System → Runtime but not in Observability → Live | Outside a Git repository, Live links a process to a session only when both name exactly the same folder; a session that has not written its transcript yet has nothing to link | send the session a prompt so its transcript exists; it then appears in Live while the process runs. See [Observability](https://github.com/pacphi/agentic-kit/blob/main/docs/OBSERVABILITY.md#troubleshooting) |
| `status` shows `ruvnet-brain … not installed` | The RuvNet Brain (offline KB + `search_ruvnet` MCP) isn't on disk | `ak sync` (or `ak setup`) runs the installer; `npx ruvnet-brain --doctor` health-checks it |
| `status` shows `ruvnet-brain-plugin … Automatic hooks differ from the reviewed … contract` | ak compares the Brain plugin's automatic hooks with the exact hook sets it has reviewed, and the installed Brain adds, removes or changes one. The row names each change. Brain 4.3.28 adds `capacity-aware-parallel-work`, which keeps running when the Brain is switched off; ak has not accepted it and has asked the Brain maintainer to change that | `ak sync` cannot review a hook, so the warning has no sync action. Keep it until an ak release reviews the change; or disable the whole Claude plugin with `claude plugin disable ruvnet-brain@ruvnet-brain` (this also removes `search_ruvnet` from Claude); or set `ruvnetBrain: false` in `kit.json` to stop ak managing and reporting the Brain (the hooks stay installed) |
| `status` shows `ruvnet-brain … retained; the refresh to v… was refused` (most causes) | The Brain's installer or its own updater refused the refresh (for example a private-overlay preflight), or ran without changing the installed release. The cause is on the Brain side, so `ak sync` stops retrying | Fix the named cause, then run `npx ruvnet-brain --update` yourself. `ak sync` tries again on its own once either the installed or the latest release changes. To stop ak managing the Brain, set `ruvnetBrain: false` in `kit.json` |
| `status` shows `ruvnet-brain … retained; the refresh to v… was refused ([forge-update] ERROR: unresolved rollback state exists…)` | forge-update's legacy-backup reclaim (upstream issue #35) is refusing to create another full-KB rollback copy while old `kb.bak-*`/`kb.install-preserved-*` snapshots from a prior update remain on disk — verified (ADR-0061) that `--update` can never clear this on its own, because it never touches those snapshots | `npx ruvnet-brain --uninstall` (removes only the KB bundle, not the legacy snapshots), then `ak sync` reinstalls fresh — this clears the version block but does **not** free the disk the legacy snapshots use; see [stuinfla/ruvnet-brain#335](https://github.com/stuinfla/ruvnet-brain/issues/335) for reclaiming that. Or set `ruvnetBrain: false` in `kit.json` |
| A heal says `degraded` while the tool is still usable | The native repair failed and a fallback or older artifact remains available; exit status is authoritative | Use the reported repair command/error. The operation will not render green or advance a version stamp until a later repair exits successfully |
| Usage suddenly shows no data for one host, or a lower total than expected | Any of the four local sources (Claude/Codex transcript roots, OpenCode's SQLite store, the Codex thread ledger) can go absent, busy, corrupt, or query-incompatible; none of these are collapsed into an ordinary empty result | Inspect the branded host-icon pills in the dashboard's tabbar (top of every view, right-aligned — or `sourceHealth` in usage-index JSON) — one pill per host; the Codex pill folds its transcript-root and thread-ledger statuses together (worse status leads, both shown in the status side's tooltip). A degraded OpenCode scan retains in-window last-good cached sessions; repair the named source before treating zero as observed truth |
| The OpenCode pill's tooltip warns `usage-not-reported:N`, or a local-model session reads $0 with unpriced messages | A local model server (LM Studio, Ollama, llama.cpp) finished N responses without reporting token counts or a cost. The responses are counted, their usage is unknown, and no price is invented for a local model | Expected for servers that do not report usage; `costEvidence.unpricedMessages` on the session names the unpriced messages. Turn on usage reporting in the server if it offers it |
| The Codex pill warns `unparsed-rollouts` or `oversized-lines-clipped` | A rollout could not be read or parsed and contributes nothing, or a single line over 16 MiB was clipped to its identifying head instead of parsed. Rollouts over 128 MiB stream through a bounded-memory reader, so size alone no longer drops a file | `sourceHealth.codex.diagnostics` names the count and, for unparsed files, the reason (`read-error`: permissions or a vanished file; `parse-error`). Fix the file's permissions or report a parse error; a clipped line still counts as one event |
| Codex sessions, prompts or responses are far lower than the Codex app lists | Sessions Codex imported from Claude Code transcripts (turn ids `external-import-turn-N`) are not Codex activity and are excluded from every Codex figure; their real usage is under Claude | `sourceHealth.codex.diagnostics.importedExcluded` is the count. No action needed |
| A Codex thread's tokens exceed the thread ledger's `tokens_used`, or a Codex subagent's are far below it | The ledger keeps only the last cumulative snapshot, so it omits everything before the host's counter restarted (the scorecard sums each segment). A forked subagent's rollout also replays its parent's history, which the ledger includes and the scorecard does not count | Expected; the scorecard is the more accurate figure in both directions |
| Usage → Context says Input only, Partial coverage, Not recorded, or No sessions | The retained session has input evidence but no compatible runtime window. OpenCode records none, so its pressure is not measured. Claude transcripts record none either: Claude pressure needs the window the kit's statusline saw, written to `~/.config/agentic-kit/claude-context-windows/<session_id>.json` | For Claude, run `ak sync` so the updated statusline template is projected, then use Claude Code normally; new main sessions record their window and pair on the next dashboard refresh. On Windows the ledger lives under `%APPDATA%\agentic-kit` (the footer resolves the kit config dir exactly as `ak` does). The statusline writes the Claude rate-limits tee to that same `%APPDATA%\agentic-kit` location, so Windows Limits data appears after `ak sync`. Headless `claude -p` runs, subagent sessions and sessions from before the update stay Input only — nothing is backfilled or guessed. Let the current-schema one-time reparse complete; missing values render as an em dash. Do not substitute a published model maximum. Codex pressure appears only when its rollout recorded paired input/window evidence |
| Usage → Limits says no Claude limit data and names a custom (or no) user-level statusLine | Claude Code sends limits only to the statusLine a session runs, and only the kit footer in a Ruflo helper writes them for ak. A project's own statusLine takes precedence over `~/.claude/settings.json`, so sessions in a project set up by ak still report; sessions anywhere else run your user-level script. The RuvNet Brain installer does not replace an existing user statusLine | Use Claude Code in a project set up with `ak setup --project` (run `ak sync` there if the footer is missing), on a Pro/Max plan; limits appear after the session's first response. Nothing needs to change in your user-level statusLine |
| Usage → Limits says no Codex limit data, or a Codex note ends "last refresh failed" | The dashboard asks `codex app-server` for `account/rateLimits/read` and shows which step failed: codex not found on the dashboard's PATH, could not start, exited early (an outdated CLI can reject the read-only flags; the exit code is shown), timed out, refused the request (RPC error code shown), or answered without a plan window | Follow the check the panel names: the Codex host row in `ak status`, `codex --version`, or `codex login status`. Plan windows apply to a ChatGPT-plan sign-in; API-key use is billed at API rates |
| A Context card says Not installed, Source unreadable, or No sessions for OpenCode, Codex or Claude | Not installed: the host's store was not found. Source unreadable: it exists but could not be read (the card shows the reason, e.g. `schema`), so an empty list does not mean no sessions ran. No sessions: readable, but nothing ran in the selected window | Not installed: nothing to do. Unreadable: repair the store or permission named in the reason (`ak status` shows the same source health). No sessions: widen the Usage window |
| Inspect source says the Hook source changed | The audited file digest no longer matches the short-lived source reference | Close the dialog, refresh/reopen Hooks, and inspect the newly audited reference. Do not reuse an old path or assume the earlier finding still applies |
| Usage → Hooks says runtime outcomes are unknown | The default read-only audit inspects configuration; native Claude/Codex/OpenCode executions do not feed the supervised-adapter receipt stream | Treat Stop diagnostics as configuration evidence only. Reproduce a failure from the host/upstream logs; do not read unknown as zero failures or run generated hooks from the dashboard |
| Stop reports AQE `ETIMEDOUT`, or the Hooks view flags AQE npx/timeout codes | Agentic-QE 3.14.0 generated Stop paths can fall back to npx and use millisecond-shaped values in Claude's seconds timeout field | Upgrade Agentic-QE (3.14.1 and later generate `node` hooks with seconds timeouts; [AQE #654](https://github.com/proffesor-for-testing/agentic-qe/issues/654) is fixed) and regenerate the project integration, or accept ak's backed-up repair for an exact reviewed copy. Agentic-kit detects the 3.14.0 files but does not patch the generated cache |
| Codex reports `hook returned invalid stop hook JSON output`, and Hooks shows **Stop output is not host-compatible** | Ruflo 3.38.20's signed AutoMemory helper writes human-readable sync status to stdout while Codex 0.152.1 expects empty success output or event-valid JSON | Do not edit the generated `.codex/hooks.json` or signed helper. Track [Ruflo #3163](https://github.com/ruvnet/ruflo/issues/3163), upgrade after a released fix passes Codex Stop conformance, regenerate the project integration, and start a fresh Codex process |
| `ak setup --project` appears to duplicate or replace guidance | Current setup owns only complete agentic-kit sentinel spans; an exact old lean stub is migrated, AGENTS-only repos get a one-line `@AGENTS.md`, and upstream AQE sentinels remain separate | Upgrade Agentic Kit and rerun setup. Review [Setup guidance precedence](SETUP.md#guidance-precedence-and-repeatability); preserve/report incomplete sentinels or edited near-matches instead of deleting them |
| `ak status` says there is no model inventory | No explicit model refresh has completed on this machine | Run `ak models refresh`, then inspect `ak models status` or Dashboard **Usage → Models** |
| A model vanished but `ak models diff` does not call it removed | The source is partial/stale, the scope changed, or this is only the first complete absence | Repair the named source and refresh again in the same scope. Two consecutive complete absences are required unless a first-party source declares removal |
| One source says `unsupported-schema` | Its native cache/config/protocol no longer matches the bounded adapter contract | Upgrade Agentic Kit first; retain the degraded snapshot for evidence and do not treat the source as an empty catalogue |
| OpenCode inventory says `partial` | Resolved config was unavailable, Models.dev identity proof failed during online refresh, output exceeded its line/diagnostic bounds, or OpenCode emitted a malformed selector/metadata block | Upgrade Agentic Kit and run `ak models refresh` again; use `--online` when human OpenCode catalogue identity is needed. Current `~` and bounded custom selectors are supported. Inspect the diagnostic code in `ak models status --json`; never treat the partial list as a complete removal baseline |
| Public Claude rows still lack lifecycle, context, or capabilities | The installed Agentic Kit predates the bundled Anthropic record, the record is over 90 days old, or no Claude refresh has rebuilt the snapshot | Upgrade Agentic Kit, then run `ak models refresh --host claude`. Repeating refresh on an old install cannot update bundled facts. Anthropic-operated lifecycle dates do not establish Bedrock, Vertex, OpenRouter, Claude Code plan, or account-specific availability |
| `ak models plan` refuses a target that appears in a catalogue | Discovery alone does not prove entitlement, policy allowance, routability, or required capabilities | Run `ak models explain HOST:MODEL`; establish the named missing evidence or make the canonical route change manually with `ak host pick` after review |
| Models shows `unknown` instead of yes/no | No accepted source established that independent fact; public catalogues prove publication, not local access | Expand the cell or Details for its field-specific reason and next step. To establish local routability, configure the exact host/provider/model path, authenticate that serving provider, complete one successful invocation, then run `ak models refresh`. Do not infer OpenRouter or account access from Anthropic publication, successful use from configuration, serving provider from a model name, or quality from lifecycle metadata |
| Dashboard Models returns `model dashboard privacy key unavailable` | A cache exists but its private scope key is absent or invalid | Run an explicit `ak models refresh` to create or repair owner-only model state. Dashboard reads fail closed and never create the key |
| Observability does not show a live host process | POSIX runtime discovery uses the current numeric UID; Windows uses its process survey and bounded cwd probe. Account/permissions, a private container PID namespace, missing probes, or restricted process access change visibility | Run `ak dashboard` as the same ordinary OS account as the host CLI. Do not use `sudo`; inspect OS/container process permissions when runtime presence is degraded. If the UID matches and none of the above applies, set `AK_RUNTIME_DEBUG=1` for one reproduction — stage-level evidence (survey row count, host classification per PID, nested-child exclusions, cwd resolution) goes to `$XDG_STATE_HOME/agentic-kit/runtime-debug.log` (mode 0600, bounded at 64 KiB; `AK_RUNTIME_DEBUG_FILE` to redirect it), then unset debug |
| Don't want the RuvNet Brain (the ~2 GB KB download) | It's on by default | `ak setup --no-ruvnet-brain`, or set `ruvnetBrain: false` in `~/.config/agentic-kit/kit.json` |
| Don't want deja-vu transcript indexing | It is already disabled by default, or a prior opt-in is still recorded | record disabled intent with `ak setup --minimal --no-deja-vu`; use `ak uninstall --dry-run` before removing owned wiring/package/index scopes described in the [runbook](DEJA-VU.md#disable-and-remove-it) |
| Don't want the security surface managed | Also on by default | `ak setup --no-security` (persists `security:false`; status shows an info row and sync stops healing it) |
| RuvNet Brain KB lives somewhere non-default | The installer + ak honor `$RUVNET_BRAIN_KB` (default `~/.cache/ruvnet-brain/kb`) | export `RUVNET_BRAIN_KB` so detection points at your KB |

> [!WARNING]
> The `natives … WASM fallback` row is the one that loses data: on the WASM path,
> memory writes print "OK" and silently vanish. Treat it as the highest-priority fix.

## Existing memory corpus routing

Ruflo's CLI and MCP tools can read different stores. A passing
`ak status --refresh=live --only memory-routes` does not establish access to pre-existing
records. `ak status` reports both files;
see [Ruflo memory stores and routing](#ruflo-memory-stores-and-routing).

A snapshot test retrieved a known native-store record only when the CLI received
the explicit native file path. For a record independently confirmed in that store,
use an absolute path:

```sh
ruflo memory retrieve --namespace YOUR_NAMESPACE --key YOUR_KEY \
  --path /absolute/project/.swarm/agentdb-memory.db --value-only
```

Keep the shared MCP path until its routing contract is qualified. Do not rename,
merge, or delete either database to hide the discrepancy. CLI retrieval can update
access counters and schema, so use SQLite backup snapshots for read-only diagnostic
experiments; copying a live database without its WAL is not a consistent snapshot.
This workaround addresses explicit retrieval, not cross-host writer convergence or
Windows split-store behavior.

## Deep proofs (slow, spawn real CLIs)

`ak status --refresh=live` runs the quick, free checks (including `security` and
`deja-vu`) in parallel. The slow proofs below run only when named with `--only`,
up to six minutes each:

```bash
ak status --refresh=live --only learning        # trains a cycle in an isolated dir; asserts patterns persist to disk
ak status --refresh=live --only aqe             # agentic-qe genuinely on ruvector (no FsyncFailed)
ak status --refresh=live --only harvest         # Ruflo's learning-write path (post-task + distill) in an isolated store
ak status --refresh=live --only memory-routes   # CLI/MCP routing observation, remembered as the memory check
ak status --refresh=live --only learning,harvest,aqe,memory-routes,security,deja-vu,providers,mcp,aqe-embedding
```

If `ak status --refresh=live --only aqe` warns that RVF is held by another live process, another AQE
process (usually the AQE MCP server in an open Claude Code session) owns the store.
That is contention, not a storage failure, even though agentic-qe 3.14.3 also prints
`FsyncFailed` in this case ([#240](https://github.com/pacphi/agentic-kit/issues/240)).
A `FsyncFailed` without the live-owner lines still fails verification.

## Known upstream gaps (not fixable by sync)

The host-by-host issue snapshot and limitations are maintained in
[Host support](HOST-SUPPORT.md). The items below are stack-wide operational gaps.

- `ruflo security cve --list` has no CVE database — use `npm audit` for dependency CVEs.
- ruflo's generated CLI examples say `npx @claude-flow/cli@latest …`; prefer the
  installed `ruflo` binary (no npm fetch per call).

## Appendix — history

**The FLVR false-corruption signal.** Earlier kit versions flagged any
`.rvf.lock` starting with `FLVR` bytes as corruption and deleted the store
beside it. That signal was measured unsound — `FLVR` is the *normal* lock
magic (`SFVR` is the store's) — and agentic-qe ≥ 3.12.3 self-heals genuinely
unusable stores non-destructively
([aqe #563](https://github.com/proffesor-for-testing/agentic-qe/issues/563)).
The kit now guards only store *size*. If you see `brain.rvf.corrupt-<pid>`
artifacts from that era, preserve them until you have checked their contents and
confirmed they contain no unique memory. Their filename alone is not deletion evidence.

Why this kit exists, the original root-cause investigations (Node-ABI/WASM memory
loss, the F1–F6 self-improvement findings, the June-2026 token-burn incident), and
the shell-era docs are preserved verbatim in [docs/archive/](https://github.com/pacphi/agentic-kit/tree/main/docs/archive) — see its
[index](https://github.com/pacphi/agentic-kit/blob/main/docs/archive/README.md).

## Ruflo `policy_evaluate`: `invalid-policy-request`

This error is request validation, before a policy decision. The installed Ruflo
MCP schema may expose `request` as an unrestricted object even though the engine
requires `identity.id`, `identity.type`, and `action.type`. `identity.agentId` is
not a substitute for `identity.id`.

Use the installed contract, for example:

```json
{
  "request": {
    "identity": { "id": "codex-worker", "type": "agent" },
    "action": {
      "type": "workspace.edit",
      "resource": "project:scoped-task",
      "environment": "development",
      "destructive": false,
      "network": false
    },
    "context": {
      "metadata": { "authorization": "User requested this scoped change" }
    }
  }
}
```

Evidence belongs in `context.evidence` as an array of provenance-bearing records;
freeform annotations belong in `context.metadata`. An annotation is not a grant of
permission. Inspect `policy_status` for the actual mode and ledger integrity.
An `allowed` result in `legacy` mode means compatibility default-allow, not that
an enforcement policy or signed approval was established. Do not change policy
mode to work around malformed requests or denied actions.

Verified on 2026-09-09 against installed `@claude-flow/security`'s
`policy/types.d.ts` and `PolicyEngine.validateRequest`, and the CLI's
`mcp-tools/policy-tools.js`. A corrected live call returned `allowed` with a
receipt. The weak nested MCP schema is upstream-owned; agentic-kit does not
implement this tool and does not patch installed packages during sync.

## Codex plugin skill-name false positives

Older agentic-kit checks incorrectly required each skill's frontmatter name to
match its folder and use lowercase kebab-case. Codex 0.153.4's own `skills/list`
loaded `spreadsheets:Spreadsheets` and `presentations:Presentations` with no errors.
The four reported issues were two naming complaints per skill, not four broken
plugins. Update agentic-kit and restart the dashboard process; do not rename or
disable those bundled skills to satisfy the old check.

The corrected compatibility check accepts display names up to 64 Unicode
characters and still reports missing required frontmatter. This is a loader
compatibility check, not a claim of compliance with every cross-host authoring
convention. [Official skill documentation](https://learn.chatgpt.com/docs/build-skills)
requires `name` and `description` and describes host skill discovery.

## Ruflo memory stores and routing

Two files can contain different project corpora:

- `.swarm/memory.db` is read and written by `ruflo memory ...`. The CLI picks its
  file from `--path`, then `CLAUDE_FLOW_DB_PATH`, then the memory root.
- `.swarm/agentdb-memory.db` is used by the MCP `memory_*` tools through the
  native bridge. It is derived from the memory root (`CLAUDE_FLOW_MEMORY_PATH`,
  else `<cwd>/.swarm`), and `CLAUDE_FLOW_DB_PATH` is not consulted. Ruflo derives
  it separately so an encrypted `memory.db` never reaches native SQLite.

`ruflo memory init` may also sync a copy to `.claude/memory.db`; treat it as a third
file when inventorying a project. File presence alone does not prove lost data or
correct cross-client routing.

Agentic-kit pins the project cwd and a `CLAUDE_FLOW_DB_PATH` inside `<root>/.swarm`,
so both interfaces land in the same directory. A pin anywhere else moves only the CLI:
the MCP tools ignore it, and when `<cwd>/.swarm` is not initialized they fail with
"Database not initialized" (seen on 3.42.4 and 3.45.0).

The routing below is observed, not documented by Ruflo, and it changes between
releases: on 3.39.2 a CLI write was not visible to MCP at all
([results](audits/ruflo-memory-route-results.jsonl)). `ak status` therefore states it
only for the exact `@claude-flow/cli` release and platform it was observed on,
currently 3.42.4 and 3.45.0 on macOS, and keeps routing unverified everywhere else:

- An MCP write is not visible to a CLI read. A CLI write is also written to
  `agentdb-memory.db`, so MCP can read it.
- Without the native bridge (the default on Windows, or after a bridge init failure)
  MCP falls back to `memory.db` and the two interfaces can appear aligned.
  `ak status --refresh=live --only memory-routes` prints the MCP backend it saw.
- CLI `retrieve`, `search` and `list` name the sibling store they did not read when
  they can open it. A bare count still describes one file.
- Neither interface reads both stores, so keys only in `memory.db` are invisible to
  MCP and the reverse.

A newer release is not evidence of a fix until `ak status --refresh=live --only memory-routes` shows it.
Maintainers can run `pnpm run test:ruflo-memory-live` to check the claim against the
installed Ruflo.

`ak setup` proves a memory write in the real project with a `_setup/verify-*` row and
deletes that row from both files. If a store cannot be cleaned (for example, a live
writer holds it), setup names the store and the key to remove by hand.

`ak status --refresh=live --only memory-routes` runs in a throwaway project with its own
memory root. After its CLI store, retrieve and purge proof, it writes one key
through the CLI and one through MCP, then reports which interface can read which
and the MCP backend it saw. A split is a warning and an MCP server it cannot use
is "not observed"; neither fails the suite. A default `ruflo memory purge` clears
`memory.db` only and still reports success, so the suite clears the sibling of its
own throwaway project with `--path`; do not do that to a live corpus without a
backup and quiesced writers. None of this establishes access to an existing corpus.
A plain `ak status --refresh=live` (its quick `memory` check) runs only the CLI store, retrieve
and purge proof — no MCP tool calls, no routing observation.

For an intentional CLI lookup, choose the file explicitly after checking your
installed `ruflo memory retrieve --help`:

```bash
ruflo memory retrieve --path /absolute/project/.swarm/agentdb-memory.db --namespace your-namespace --key your-key
ruflo memory retrieve --path /absolute/project/.swarm/memory.db --namespace your-namespace --key your-key
```

These are operational lookups, not forensic read-only probes: Ruflo retrieval
can update access metadata, and initialization can migrate schemas. For a strict
read-only inspection, open SQLite read-only, enable `PRAGMA query_only=ON`, and
inspect counts, schemas, and key presence without printing stored values.

Preserve both files and their live WAL state. Do not delete the smaller file,
globally repin the environment, or merge automatically: it may have unique keys,
and writers may still be active. Migration needs a separate, reviewed backup,
conflict-resolution, and writer-quiescence procedure. Upstream tracking:
[ruvnet/ruflo#3196](https://github.com/ruvnet/ruflo/issues/3196) and
[pacphi/agentic-kit#213](https://github.com/pacphi/agentic-kit/issues/213).

[Local investigation and upstream boundary](audits/plugin-memory-status-followup.md)
records the source evidence and counts observed on 2026-09-09.

### What `ak status` reports about memory

`ak status` names the canonical store: `<root>/.swarm`, where `<root>` is the
repository root (or the folder, outside a repository). Every host's Ruflo memory is
pointed there, so a run from a subfolder reports the same store. For each file it
shows the active entry count, the file and live WAL size, the largest namespace with
its share, and whether its rows are set to expire. A namespace that grows without
expiry (for example `commands`, written by Ruflo's `hooks post-command`) is the usual
reason a store gets large. A file with no memory table yet is reported as empty.

Some folders never get a store: the filesystem root, your home folder itself, a
temporary root such as `/tmp`, and folders that belong to a tool (`~/.codex`,
`~/.claude`, `~/.config`, `~/.local`, `~/.cache`, `~/Library/Application Support`,
`%APPDATA%`). Codex often starts in one of these. The Ruflo launcher that Claude Code
and Codex both start (`ak x ruflo-mcp`) then uses one user-level store,
`~/.claude-flow/memory`. Run from such a folder, `ak status` names that store instead
of a project store. From anywhere, it reports the user-level store once it exists.

### Old setup probe rows

Earlier `ak setup` runs could leave rows with keys like `_setup/verify-12345-1700000000000`
(namespace `_setup`, content `setup-verify`) in a store. Ruflo copies each write into
`agentdb-memory.db` as well, and its own `memory delete` leaves that copy
([ruvnet/ruflo#3450](https://github.com/ruvnet/ruflo/issues/3450)). `ak status` warns
with the count per store, for the current project and the user-level store. `ak sync`
backs up each affected file under `~/.local/state/agentic-kit/memory-probe-cleanup/backups/`
(`%LOCALAPPDATA%\agentic-kit\memory-probe-cleanup\backups\` on Windows; with `VACUUM INTO`), deletes exactly those rows from both files, writes a receipt beside
the backups, and records the store in `kit.json` so it never cleans it twice.
`ak sync --dry-run` shows the counts first. Rows in other projects are cleaned when you
run `ak sync` there.

### Stray memory stores

A stray store is a memory file this project's hosts do not read. `ak status` lists
each one by owner, for information only. ak never moves, merges or deletes them, with
one exception: a stray AQE store with a `memory.db` is a hand fix, and
`ak x aqe-store merge` merges it into the project store and archives it (below).

| Stray | Usual owner |
|---|---|
| A `memory.db` or `agentdb-memory.db` under `.swarm/` other than the canonical pair (for example `.swarm/.swarm/agentdb-memory.db`), or in a subfolder's `.swarm/` | A Ruflo command that ran with that folder as its working directory. Ruflo derives the store path from the working directory |
| `./agentdb.db` | The AgentDB CLI's default file |
| `./agentdb.rvf` | AgentDB's RVF backend, which defaults to the working directory |
| `./ruvector.db` | RuVector's default store (`ruvector mcp start`; `ruflo memory init` also creates one) |
| A `.agentic-qe/` below the project root | An AQE command, hook or MCP server that started in that folder before ak pinned AQE to the project root. AQE resolves its memory and storage paths against the working directory |
| `~/.swarm`, or `.swarm` folders under `~/.codex/.chatgpt-projects/` (reported from any project) | Ruflo ran with your home folder or a Codex ChatGPT project folder as its working directory, before ak's launcher used the user-level store there |

Ruflo's rotated backups in `.swarm/backups/` are not strays. The search skips
`node_modules`, `.git` and the contents of dot folders such as `.claude/worktrees`,
and says so when it stops early. Before you delete a stray, inspect it read-only
as described above. It may hold rows that exist nowhere else.

### Merge stray AQE stores

`ak x aqe-store status` shows, for each stray AQE store, its patterns and captured experiences,
how many patterns and experiences the project store already has (AQE skips those), how many are
AQE's starter patterns (imported only when the project store holds them already, so their usage
is kept), and which processes hold a store. Building the preview copies every store into ak's
state folder and starts AQE there twice. Close every Claude Code, Codex and OpenCode session
in the project (their AQE MCP servers and hooks write the store), then run
`ak x aqe-store merge --yes`.

| The merge says | Why | Fix |
|---|---|---|
| `refused: N process(es) hold the AQE stores: PID …` | A session's AQE MCP server or hook has a store open. AQE takes no lock a merge could wait on | Close the named processes' sessions and run it again. There is no `--force` |
| `could not check which processes hold the AQE stores` | `lsof` is missing, failed, or timed out (macOS, Linux) | Install `lsof`, or run it again when the machine is less busy |
| `refused: … changed since …` | A store was written after the merge copied it: a hook, a manual `aqe` run or a session in a subfolder | Close that writer and run the merge again |
| `the project store … already fails integrity_check` or `foreign_key_check` | The project store was damaged before any merge; nothing was written | Repair the store with AQE first, or restore an earlier backup |
| `an earlier merge (…) was interrupted during its import` | A merge stopped between its imports; its receipt still says `applying` | Run the merge again to finish it, or restore that run's backup (steps below) |
| `…: partially moved: …` | Across filesystems the archive copy is complete, but removing the stray failed part-way | Close what holds it, then delete what is left of the stray by hand |
| `could not build AQE's starter pattern set` | The fresh AQE store the merge builds in its scratch folder holds no patterns, usually because the project's AQE embedder is unreachable | Start the embedder (for Ollama, `ollama serve`) and run it again |
| `merge failed: … count mismatch …` | The project store changed during the merge, or AQE imported fewer rows than the rehearsal | The strays stay in place. Restore the project store from the backup the message names (steps below) if you want the state before the merge |
| `left in place: … EBUSY` (Windows) | A process still held that folder | Close it and run the merge again |
| `left in place: … changed since it was copied` | The stray was written during the import; its data may be newer than the copy | Run the merge again to merge what it gained |

#### Restore an AQE store from the merge archive

Each merge keeps `<state>/agentic-kit/aqe-store-merge/<time>/` until you delete it (`<state>` is
`$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows). It contains:

- `backup/root-memory.db`: the project store before the merge;
- `archive/<folder>/.agentic-qe`: each merged stray folder, whole;
- `receipt.json`: where each came from and the counts.

With every Claude Code, Codex and OpenCode session in the project closed:

1. **Undo the merge.** Delete `memory.db-wal` and `memory.db-shm` in `<project>/.agentic-qe/`,
   then copy `backup/root-memory.db` over `<project>/.agentic-qe/memory.db`, with nothing opening
   the store in between. This discards every write made to the project store after the backup,
   not only the merge's.
2. **Put a stray back.** Move `archive/<folder>/.agentic-qe` back to the path `receipt.json` lists
   for it (for example `archive/docs--research--v5/.agentic-qe` to `docs/research/v5/.agentic-qe`).
   The project pin keeps AQE from writing to it again.
3. **Delete the archive** once you no longer need it. ak never deletes it.

### Memory backup and distillation

Ruflo, not ak, backs up and distills project memory. Both jobs are workers inside
the project's Ruflo daemon. The backup worker writes a snapshot to `.swarm/backups/`
(the last seven are kept) about 10 minutes after the daemon starts, then at most once
a day. Distillation runs every 30 minutes. `ak status` shows when each last ran,
from the files Ruflo writes in `.claude-flow/metrics/` and the newest snapshot in
`.swarm/backups/`:

- A backup older than 48 hours, or none at all, is a warning only when no daemon
  runs for the project. A failed attempt is always a warning.
- An old distillation is information only. A failed or corrupt run is a warning.
- The `daemons` row is information, not ok, when the project has memory and no
  daemon. It says Ruflo starts one on the next `ruflo` command, or names the
  setting that stops it.
- The `daemons` row warns when a running daemon deferred backup or distillation
  and has not run it since.

The daemon ends itself after 12 hours. Ruflo starts a new one on the next `ruflo`
command in the project unless start-on-use is off. `ruflo init` turns it off
(`claudeFlow.daemon.autoStart: false` in `.claude/settings.json`); `ak setup` and
`ak sync` turn it back on and keep the old value for `ak uninstall`. They also
write the flat keys Ruflo's daemon needs in `.claude-flow/config.json`: a free-memory
floor of 0 on macOS, where Ruflo undercounts free memory
([ruvnet/ruflo#2935](https://github.com/ruvnet/ruflo/issues/2935)), and
`daemon.idleSecs: 0` on Ruflo older than 3.46.0, whose daemon ended itself early
([ruvnet/ruflo#3194](https://github.com/ruvnet/ruflo/issues/3194)). ak never uses
`ruflo config set` for these. A file that is not a JSON object, or a key that holds your
own value, is left alone, and `ak status` names the key to set yourself. ak writes these keys
only in a repository Ruflo already treats as a project (it has `.swarm/memory.db`, a Ruflo
config file, a `claudeFlow` block in `.claude/settings.json`, or a Ruflo server in `.mcp.json`),
never in one that has just an empty `.claude-flow/` folder, since the file would make Ruflo
start a daemon there.

To leave start-on-use as Ruflo set it, add `"rufloDaemon": { "autoStart": false }`
to `kit.json` and run `ak sync`; it puts back a value it changed. You can always
start the daemon or take a backup yourself:

```bash
ruflo daemon start          # in the project root; runs both workers until it ends
ruflo memory backup         # a one-off snapshot of .swarm/memory.db
```

Both jobs cover `.swarm/memory.db` only. Nothing in Ruflo backs up or distills
`.swarm/agentdb-memory.db`, the store the MCP tools write. Back it up into its own
folder, because rotation keeps only the newest snapshots in the destination:

```bash
ruflo memory backup --db .swarm/agentdb-memory.db --dir .swarm/backups/agentdb
```

This takes a consistent snapshot, WAL included, and leaves `memory.db`'s snapshots
alone (checked on Ruflo 3.45.0). `ak status` shows the age of the newest one.

## AQE embedding backend unavailable or provenance unverified

Run `ak x aqe-embedding status` to inspect the selected backend and projection
conflicts, then `ak x aqe-embedding verify` for a synthetic backend proof. A local
model can be restored with `ak x aqe-embedding prepare --yes` after selecting local
Ollama. If sync or verify says Ollama is installed but not running, open the Ollama
app or run `ollama serve`, then retry.
A different fingerprint or unknown corpus provenance requires separate
migration planning; do not delete RVF locks or relabel vectors.
See [AQE embeddings](AQE-EMBEDDINGS.md) for the full recovery and environment guide.

`ak status` does not contact the embedding service. Its `aqe-embedding` row shows the
last live check from `ak sync`, `ak status --refresh=live --only aqe`, or a plain
`ak status --refresh=live` with its age and
reason. After you fix the service, run `ak status --refresh=live` (quick) or
`ak status --refresh=live --only aqe` to replace an old failure.
