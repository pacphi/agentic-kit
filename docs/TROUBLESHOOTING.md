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
| Just upgraded ruflo/agentic-qe (`npm i -g …`) and things feel off | Upgrades re-resolve dependencies: native SQLite bindings and the aidefence package get dropped, and ruflo's helper auto-refresh regenerates the statusline without the footer | `ak sync` (this is its main job) |
| `status` shows `natives … WASM fallback` | agentdb resolved a non-native better-sqlite3 — on this path **memory writes can silently vanish**. Root cause is npm ≥11.17 blocking install scripts during upgrades | `ak sync` installs the native binding |
| `status` shows `aidefence missing` | ruflo ≥3.28 stopped shipping `@claude-flow/aidefence` but `ruflo security defend` still imports it — injection defense is silently non-functional ([ruvnet/ruflo#2670](https://github.com/ruvnet/ruflo/issues/2670)) | `ak sync` reinstalls it; `ak x verify security` proves defend works (exit 1=threat / 0=clean) |
| `status` shows oversized RVF store(s) | A runaway append after a hard exit grew a `.rvf` past the 2 GB cap (seen at ~277 GB once) | `ak sync` quarantines the oversized store; agentic-qe rebuilds it |
| Statusline footer (🧠/🛡/🎓 lines) disappeared | `@claude-flow/cli`'s version-stamped helper auto-refresh pristine-copies `statusline.cjs` on the **first ruflo command after an upgrade** — including the statusline render itself | `ak sync` — it now triggers that refresh *first*, then re-injects, so the footer survives; `ak status` flags an armed wipe before it fires |
| Too many `⚙` daemons / stale daemons | One daemon per active project is normal (local-only workers, $0). Stale = workspace deleted or past the 12h TTL | `ak x daemon-gc --kill`; `sync` also reaps (and verifies the pid really is a ruflo daemon before killing) |
| Want to change which MCP tool families are callable | Exclusions are `permissions.deny` rules, persisted in kit.json | `ak x mcp pick` (re-runnable); `x mcp status` shows the inventory; `x mcp off` unregisters |
| `ruflo memory store` says OK but reads return nothing | Absolute-DB-path pin missing, or WAL not checkpointed, or the WASM fallback above | `ak setup` in the project re-pins + verifies a real write lands on disk |
| Suspicious token burn | Background automation vs interactive usage | ask Claude to run the **ruflo-token-audit** skill (deployed by `setup`) |
| `status` shows `ruvnet-brain … not installed` | The RuvNet Brain (offline KB + `search_ruvnet` MCP) isn't on disk | `ak sync` (or `ak setup`) runs the installer; `npx ruvnet-brain --doctor` health-checks it |
| Don't want the RuvNet Brain (the ~2 GB KB download) | It's on by default | `ak setup --no-ruvnet-brain`, or set `ruvnetBrain: false` in `~/.config/agentic-kit/kit.json` |
| Don't want the security surface managed | Also on by default | `ak setup --no-security` (persists `security:false`; status shows an info row and sync stops healing it) |
| RuvNet Brain KB lives somewhere non-default | The installer + ak honor `$RUVNET_BRAIN_KB` (default `~/.cache/ruvnet-brain/kb`) | export `RUVNET_BRAIN_KB` so detection points at your KB |

> [!WARNING]
> The `natives … WASM fallback` row is the one that loses data: on the WASM path,
> memory writes print "OK" and silently vanish. Treat it as the highest-priority fix.

One entry above deserves its history spelled out:

> [!NOTE]
> **Historical:** earlier kit versions flagged any `.rvf.lock` starting with `FLVR`
> bytes as corruption and deleted the store beside it. That signal was measured
> unsound — `FLVR` is the *normal* lock magic (`SFVR` is the store's) — and
> agentic-qe ≥ 3.12.3 self-heals genuinely unusable stores non-destructively
> ([aqe #563](https://github.com/proffesor-for-testing/agentic-qe/issues/563)).
> The kit now guards only store *size*. If you see `brain.rvf.corrupt-<pid>`
> droppings from that era, they are safe to delete.

## Deep proofs (slow, spawn real CLIs)

```bash
ak x verify learning    # trains a cycle in an isolated dir; asserts patterns persist to disk
ak x verify security    # packages load + defend flags a real injection sample
ak x verify aqe         # agentic-qe genuinely on ruvector (no FsyncFailed)
ak x verify harvest     # end-to-end learning-write path against real CLIs
ak x verify all
```

## Known upstream gaps (not fixable by sync)

- `ruflo security cve --list` has no CVE database — use `npm audit` for dependency CVEs.
- ruflo's generated CLI examples say `npx @claude-flow/cli@latest …`; prefer the
  installed `ruflo` binary (no npm fetch per call).

## History

Why this kit exists, the original root-cause investigations (Node-ABI/WASM memory
loss, the F1–F6 self-improvement findings, the June-2026 token-burn incident), and
the shell-era docs are preserved verbatim in [docs/archive/](archive/) — see its
[index](archive/README.md).
