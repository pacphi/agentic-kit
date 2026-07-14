# Troubleshooting

Everything starts with the dashboard:

```bash
ruflo-kit            # status + one suggested next action
ruflo-kit status     # the same, without the hint (--json for CI)
ruflo-kit sync --dry-run   # see exactly what sync WOULD do, with reasons
ruflo-kit sync       # apply it
```

The rule: **`status` to look, `sync` to fix.** Every ⚠/✗ row in `status` names the
fix; `sync` applies them in the right order and re-checks afterward.

## Common situations

| Symptom | What's happening | Fix |
|---|---|---|
| Just upgraded ruflo/agentic-qe (`npm i -g …`) and things feel off | Upgrades re-resolve dependencies: native SQLite bindings and the aidefence package get dropped, the statusline is regenerated without the footer | `ruflo-kit sync` (this is its main job) |
| `status` shows `natives … WASM fallback` | agentdb resolved a non-native better-sqlite3 — on this path **memory writes can silently vanish**. Root cause is npm ≥11.17 blocking install scripts during upgrades | `ruflo-kit sync` installs the native binding |
| `status` shows `aidefence missing` | ruflo ≥3.28 stopped shipping `@claude-flow/aidefence` but `ruflo security defend` still imports it — injection defense is silently non-functional ([ruvnet/ruflo#2670](https://github.com/ruvnet/ruflo/issues/2670)) | `ruflo-kit sync` reinstalls it; `ruflo-kit x verify security` proves defend works (exit 1=threat / 0=clean) |
| `status` shows corrupt/oversized RVF | An interrupted write left store bytes in a `.rvf.lock` (FLVR signature) or a runaway `.rvf`; agentic-qe drops off ruvector with `FsyncFailed` and does **not** self-heal this | `ruflo-kit sync` quarantines it — the store is a derived cache, rebuilt from `memory.db` |
| Statusline footer (🧠/🛡/🎓 lines) disappeared | `ruflo init`/upgrade regenerated `statusline.cjs` | `ruflo-kit sync` re-injects it |
| Too many `⚙` daemons / stale daemons | One daemon per active project is normal (local-only workers, $0). Stale = workspace deleted or past the 12h TTL | `ruflo-kit x daemon-gc --kill`; `sync` also reaps. AI workers only ever run with `RUFLO_DAEMON_AI_WORKERS=1`, capped by `ruflo daemon budget show` |
| Want to change which MCP tool families are callable | Exclusions are `permissions.deny` rules, persisted in kit.json | `ruflo-kit x mcp pick` (re-runnable); `x mcp status` shows the inventory; `x mcp off` unregisters |
| `ruflo memory store` says OK but reads return nothing | Absolute-DB-path pin missing, or WAL not checkpointed, or the WASM fallback above | `ruflo-kit setup` in the project re-pins + verifies a real write lands on disk |
| Suspicious token burn | Background automation vs interactive usage | ask Claude to run the **ruflo-token-audit** skill (deployed by `setup`) |

## Deep proofs (slow, spawn real CLIs)

```bash
ruflo-kit x verify learning    # trains a cycle in an isolated dir; asserts patterns persist to disk
ruflo-kit x verify security    # packages load + defend flags a real injection sample
ruflo-kit x verify aqe         # agentic-qe genuinely on ruvector (no FsyncFailed)
ruflo-kit x verify all
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
