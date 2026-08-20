# Troubleshooting

Everything starts with the dashboard:

```bash
ak                  # status + one suggested next action (alias of `agentic-kit`)
ak status           # the same, without the hint (--json for CI)
ak sync --dry-run   # see exactly what sync WOULD do, with reasons
ak sync             # apply it
```

> [!TIP]
> The rule: **`status` to look, `sync` to fix.** Every ⚠/✗ row in `status` names the
> fix; `sync` applies them in the right order and re-checks afterward.

## Common situations

| Symptom | What's happening | Fix |
| --- | --- | --- |
| `npm install @pacphi/agentic-kit` succeeded but `ak` is not found | A local install links the binary into the package root's `node_modules/.bin`, not the general shell `PATH` | run `npm exec -- ak status`, add an npm script, or use the recommended global install; see [Installation](INSTALLATION.md) |
| A global install exists but this shell cannot find it | The active Node/npm prefix changed, or its binary directory is not on `PATH` | compare `npm prefix -g`, `npm root -g`, and `command -v ak` (`where ak` on Windows); activate the intended Node toolchain before reinstalling |
| A one-shot/local `ak setup` changed global tools or project files | npm package scope does not constrain an `ak` command's operational scope | review [Installation scope](INSTALLATION.md#the-two-independent-scope-decisions) and [Setup scope](SETUP.md); use `--dry-run` before setup/sync/uninstall |
| `ak sync` launched from a checkout/local dependency created a global `ak` | The self-update step deliberately installs the resolved replacement globally and runs last | use `ak sync --no-upgrade` when the checkout or lockfile must remain authoritative |
| Different users or Node versions see different global stacks | npm `-g` means the active prefix, which can be per-user and per-Node-version | standardize the Node manager/prefix per user; do not repair this with `sudo ak setup` |
| Just upgraded ruflo/agentic-qe (`npm i -g …`) and things feel off | Upgrades re-resolve dependencies: native SQLite bindings and the aidefence package get dropped, and ruflo's helper auto-refresh regenerates the statusline without the footer | `ak sync` (this is its main job) |
| `status` shows `natives … WASM fallback` | agentdb resolved a non-native better-sqlite3 — on this path **memory writes can silently vanish**. Common causes are npm ≥11.17 blocking install scripts during upgrades, or a stale better-sqlite3 ≤12.9 pin on Node 26 | `ak sync` selects a Node-compatible release and installs the native binding |
| `status` shows `aidefence missing` | ruflo ≥3.28 stopped shipping `@claude-flow/aidefence` but `ruflo security defend` still imports it — injection defense is silently non-functional ([ruvnet/ruflo#2670](https://github.com/ruvnet/ruflo/issues/2670)) | `ak sync` reinstalls it; `ak x verify security` proves defend works (exit 1=threat / 0=clean) |
| `status` shows oversized RVF store(s) | A runaway append after a hard exit grew a `.rvf` past the 2 GB cap (seen at ~277 GB once) | `ak sync` quarantines the oversized store; agentic-qe rebuilds it |
| Statusline footer (🧠/🛡/🎓 lines) disappeared | `@claude-flow/cli`'s version-stamped helper auto-refresh pristine-copies `statusline.cjs` on the **first ruflo command after an upgrade** — including the statusline render itself | `ak sync` — it now triggers that refresh *first*, then re-injects, so the footer survives; `ak status` flags an armed wipe before it fires |
| Statusline footer is blank or stale with no visible error | Footer probes are intentionally silent during normal rendering | Set `AK_STATUSLINE_DEBUG=1` for one reproduction. Redacted stage/error metadata goes to `$XDG_STATE_HOME/agentic-kit/statusline-debug.log` (default `~/.local/state/agentic-kit/statusline-debug.log`, mode 0600, bounded at 64 KiB); set `AK_STATUSLINE_DEBUG_FILE` to redirect it, then unset debug |
| Codex's native status line did not change | Codex reads the user-wide setting when a session starts; an existing TUI may not hot-reload it | Exit and start a new Codex session; inspect ownership with `ak x statusline status` and drift with `ak status` |
| The right side of Codex's status line is missing | Codex has one width-constrained native line | Widen the terminal or choose the compact preset with `ak x statusline codex native` |
| Want the rich Ruflo/SONA/AQE display inside Codex | Codex currently accepts built-in status-line fields only, not a command-backed renderer | Keep the rich footer in Claude Code; see [Managed Codex status line](CODEX-STATUSLINE.md) for the current boundary |
| Too many `⚙` daemons / stale daemons | One daemon per active project is normal (local-only workers, $0). Stale = workspace deleted or past the 12h TTL | `ak x daemon-gc --kill`; `sync` also reaps (and verifies the pid really is a ruflo daemon before killing) |
| Want to change which MCP tool families are callable | Exclusions are `permissions.deny` rules, persisted in kit.json | `ak x mcp pick` (re-runnable); `x mcp status` shows the inventory; `x mcp off` unregisters |
| opencode: Ruflo/AQE are not connected, compact `ak_*` tools are missing, or `ak-specialist` is unavailable after `ak setup --opencode` / `ak sync` | opencode loads config, plugins, MCP servers, and agents **once at startup** — a running session never sees new wiring | quit and restart opencode; `ak status` shows MCP connectivity, compact gateway, lifecycle plugin, skill, and specialist state separately |
| opencode: `status` says `opencode.json is not plain JSON` | opencode legally allows JSONC comments; ak refuses to rewrite a file it can't parse rather than normalize (and silently drop) your comments | hand-merge the ak entries (`mcp`, `skills.paths`, `permission`) per `docs/adr/0017-opencode-host.md`, or remove the comments and run `ak sync` |
| opencode: `status` reports a later `opencode.jsonc` override | stock OpenCode loads that file after `opencode.json`, so it can shadow the exact MCP/permission values ak receipts; ak cannot verify JSONC without rewriting user comments | merge the Agentic Kit entries into the later file and remove the duplicate override, or keep the override and use direct user-managed wiring; ak preserves both files and does not deploy its gateway against ambiguous effective config |
| opencode: an agent/skill/plugin file you created yourself keeps ak's version away | deploys are no-clobber: only exact receipt-matching bytes are repairable; an unreceipted or edited destination is user-owned and preserved (`status` reports it as `foreign`) | rename yours (or remove it and run `ak sync` to get ak's managed copy) |
| opencode: `status` says `no ruflo catalog source` | the agent/skill catalog resolves override → `$RUFLO_REPO` → claude marketplace clone → `@claude-flow/cli` (direct, then nested under ruflo) — all missing | install ruflo (`ak setup` does), or point `integrations.ownership.opencode.catalogDir` / `$RUFLO_REPO` at a ruflo checkout |
| `ruflo memory store` says OK but reads return nothing | Absolute-DB-path pin missing, or an older check looked only at `.swarm/memory.db` while the native bridge selected `.swarm/agentdb-memory.db` | Run `ak x verify memory` for an isolated store/retrieve/on-disk/purge proof; `ak setup` re-pins and verifies the runtime-selected store |
| `status` shows a `codex-plugins` warning | An enabled plugin's newest cached hooks or skills fail a known Codex compatibility check. Examples include Claude-only hook metadata, a `SKILL.md` without YAML frontmatter, and `security-guidance` 2.0.7 emitting a Stop result Codex rejects | Open Codex `/plugins`, refresh or disable the named plugin, then start a new session. `ak setup` and `ak sync` never install, enable, refresh, or rewrite Codex-owned plugins |
| `status` shows a `memory-pin` warning | `CLAUDE_FLOW_DB_PATH` is pinned to a dead or foreign path, so every memory op targets the wrong DB ("Database not initialized" beside a healthy in-repo DB). The pin may be deliberate, so `sync` never touches it | repoint (or remove) the pin in `.claude/settings.local.json` `env` |
| Want to run `ak sync` but Claude/Codex/OpenCode sessions are open in other terminals | Upgrade-bearing syncs stop **all** ruflo daemons machine-wide and swap the global npm trees live sessions execute hooks/statusline/MCP calls from; converged syncs touch nothing | `ak sync --dry-run` first; a `versions` row means idle the other sessions or use `ak sync --no-upgrade`; see [Running `ak sync` while sessions are live](UPGRADING.md#running-ak-sync-while-sessions-are-live) |
| Suspicious token burn | Background automation vs interactive usage | ask Claude to run the **ruflo-token-audit** skill (deployed by `setup`) |
| Observability is empty or has no ruflo/AQE nodes | Live mode tails Claude/Codex records by default, while ruflo/AQE stores are not auto-discovered | open Observability before producing activity; switch to History for retained sessions; register a trusted JSONL file with repeatable `--live-source 'surface=path'`; see [Observability](OBSERVABILITY.md) |
| `status` shows `ruvnet-brain … not installed` | The RuvNet Brain (offline KB + `search_ruvnet` MCP) isn't on disk | `ak sync` (or `ak setup`) runs the installer; `npx ruvnet-brain --doctor` health-checks it |
| A heal says `degraded` while the tool is still usable | The native repair failed and a fallback or older artifact remains available; exit status is authoritative | Use the reported repair command/error. The operation will not render green or advance a version stamp until a later repair exits successfully |
| Usage suddenly shows no data for one host, or a lower total than expected | Any of the four local sources (Claude/Codex transcript roots, OpenCode's SQLite store, the Codex thread ledger) can go absent, busy, corrupt, or query-incompatible; none of these are collapsed into an ordinary empty result | Inspect the branded host-icon pills in the dashboard's tabbar (top of every view, right-aligned — or `sourceHealth` in usage-index JSON) — one pill per host; the Codex pill folds its transcript-root and thread-ledger statuses together (worse status leads, both shown in the status side's tooltip). A degraded OpenCode scan retains in-window last-good cached sessions; repair the named source before treating zero as observed truth |
| Observability does not show a live host process | Runtime discovery uses the numeric UID running the dashboard and is macOS/Linux-only; `sudo`, a service account, Windows, a private container PID namespace, missing `ps`/`lsof`, or restricted `/proc` changes what is visible | Run `ak dashboard` as the same ordinary OS account as the host CLI. Do not use `sudo`; use retained History on Windows and inspect OS/container process permissions when runtime presence is degraded. If the UID matches and none of the above applies, set `AK_RUNTIME_DEBUG=1` for one reproduction — stage-level evidence (survey row count, host classification per PID, nested-child exclusions, cwd resolution) goes to `$XDG_STATE_HOME/agentic-kit/runtime-debug.log` (mode 0600, bounded at 64 KiB; `AK_RUNTIME_DEBUG_FILE` to redirect it), then unset debug |
| Don't want the RuvNet Brain (the ~2 GB KB download) | It's on by default | `ak setup --no-ruvnet-brain`, or set `ruvnetBrain: false` in `~/.config/agentic-kit/kit.json` |
| Don't want the security surface managed | Also on by default | `ak setup --no-security` (persists `security:false`; status shows an info row and sync stops healing it) |
| RuvNet Brain KB lives somewhere non-default | The installer + ak honor `$RUVNET_BRAIN_KB` (default `~/.cache/ruvnet-brain/kb`) | export `RUVNET_BRAIN_KB` so detection points at your KB |

> [!WARNING]
> The `natives … WASM fallback` row is the one that loses data: on the WASM path,
> memory writes print "OK" and silently vanish. Treat it as the highest-priority fix.

## Deep proofs (slow, spawn real CLIs)

```bash
ak x verify learning    # trains a cycle in an isolated dir; asserts patterns persist to disk
ak x verify security    # packages load + defend flags a real injection sample
ak x verify aqe         # agentic-qe genuinely on ruvector (no FsyncFailed)
ak x verify harvest     # end-to-end learning-write path against real CLIs
ak x verify all
```

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
droppings from that era, they are safe to delete.

Why this kit exists, the original root-cause investigations (Node-ABI/WASM memory
loss, the F1–F6 self-improvement findings, the June-2026 token-burn incident), and
the shell-era docs are preserved verbatim in [docs/archive/](archive/) — see its
[index](archive/README.md).
