# ruflo-machine-ref

A small, opinionated machine-setup kit that makes [ruflo](https://github.com/ruvnet/ruflo)
work **reliably and cheaply** with Claude Code — especially on modern Node (24/26),
where ruflo's default install silently falls back to a memory backend that can
**lose data**.

It packages everything learned from a deep debugging session into reusable
artifacts: shell helpers, a native-SQLite patch, a context-saving CLAUDE.md
reference, and an end-to-end test harness.

> Target: macOS / Linux, zsh or bash, ruflo 3.10.x, Node 20–26, Python 3.10+.

---

## Why this exists

Three problems bite ruflo users and are hard to diagnose:

1. **Context bloat.** Registering ruflo (and its cousins `claude-flow`,
   `ruv-swarm`, `flow-nexus`) as MCP servers costs ~84k tokens of tool
   definitions in *every* Claude Code session. `claude-flow` is literally the
   same package as `ruflo`; running both doubles the cost.

2. **Silent memory data loss on Node 24/26.** ruflo's deeper `agentdb`
   dependency pins `better-sqlite3@^11.8.1`, which has **no prebuilt for Node
   24/26 and won't compile** against Node 26's V8. npm skips the optional dep,
   ruflo falls back to the **sql.js (WASM)** backend, and `ruflo memory store`
   reports `[OK]` while **never persisting the row to disk**. (Upstream:
   [ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219).)

3. **Footguns in `ruflo init`.** It writes a `.mcp.json` containing
   `ruv-swarm`/`flow-nexus`, registers ruflo MCP at local scope, and does *not*
   create the memory DB — so the first `memory store` no-ops against a
   nonexistent file. It also emits a per-project `CLAUDE.md` full of legacy
   `npx @claude-flow/cli@latest` commands.

This kit fixes all three.

---

## What's in the box

```
ruflo-machine-ref/
├── install.sh                 # idempotent installer (backs up what it touches)
├── uninstall.sh               # clean reversal
├── bin/
│   ├── ruflo-patch-native     # swap agentdb's better-sqlite3 -> ^12 on Node >= 24
│   └── ruflo-parity-test      # 20-check end-to-end memory smoke test
├── shell/
│   └── ruflo-functions.sh     # ruflo-setup-project, ruflo-remove-mcp, etc. (bash+zsh)
├── claude/
│   └── ruflo-reference.md     # the machine-wide CLAUDE.md ruflo block (CLI-first, MCP-optional)
└── docs/
    ├── BACKGROUND.md          # the full root-cause story (Node/ABI/WASM/better-sqlite3)
    └── TROUBLESHOOTING.md     # diagnostic tables + fixes
```

---

## Quick start

```bash
git clone <this-repo> ruflo-machine-ref && cd ruflo-machine-ref
./install.sh                    # see --dry-run first if you like
exec $SHELL                     # load the helper functions

ruflo-patch-native --check      # is your Node on the buggy WASM path?
ruflo-patch-native              # fix it (no-op on Node <= 22)

cd ~/my-project
ruflo-setup-project             # clean init: no MCP cruft, native SQLite, verified writes
ruflo-parity-test               # prove store/retrieve work end-to-end
```

Prefer CLI-only (no MCP, ~84k tokens saved per session)? Skip
`ruflo-setup-machine`; the installed `~/.claude/CLAUDE.md` reference teaches
Claude Code to drive ruflo through Bash.

---

## The commands

| Command | What it does |
|---|---|
| `ruflo-setup-machine` | One-time: register ruflo MCP at **user** scope (all projects). Optional. |
| `ruflo-remove-mcp` | Remove ruflo MCP from **all** scopes (recover ~84k tokens/session). |
| `ruflo-setup-project` | Per repo: init + strip MCP cruft + pin absolute DB path + native patch + activate memory/swarm/daemon + **verify a write persists** + sanitize CLAUDE.md. |
| `ruflo-patch-native [--check]` | Make agentdb use native `better-sqlite3` on Node ≥24. Re-run after every ruflo upgrade. |
| `ruflo-memory-checkpoint [db]` | Force a WAL checkpoint to recover stale memory reads. |
| `ruflo-reference-refresh [--diff\|--regenerate]` | Inspect/rebuild the CLAUDE.md ruflo block from the template. |
| `ruflo-parity-test [--cleanup]` | 20-check end-to-end memory smoke test in an isolated dated `/tmp` dir. |

---

## Node version policy (important)

| Node | ABI | ruflo memory backend | Action |
|------|-----|----------------------|--------|
| ≤ 22 (LTS) | ≤ 127 | native better-sqlite3 | nothing — works out of the box |
| 24 | 137 | sql.js WASM (buggy) | run `ruflo-patch-native` |
| 26 | 147 | sql.js WASM (buggy) | run `ruflo-patch-native` |

`ruflo-patch-native` gates on Node's ABI (`process.versions.modules`): it patches
when ABI ≥ 137 and no-ops when ≤ 131. **Re-run it after `npm install -g ruflo`** —
upgrades re-resolve the `^11.8.1` pin and wipe the patch.

Alternative: run ruflo on **Node 22 LTS** and skip patching entirely.

---

## Upgrading ruflo

```bash
npm install -g ruflo@latest
ruflo-patch-native            # re-apply native SQLite on Node >= 24
ruflo-reference-refresh --diff  # check if the CLAUDE.md template needs a refresh
```

When ruflo bumps `agentdb`'s `better-sqlite3` to `^12` (see #2219), the patch
becomes a no-op and you can drop it.

---

## Uninstall

```bash
./uninstall.sh        # removes bin scripts, template, CLAUDE.md block, rc source line
```

Your ruflo install, memory DBs, and project files are left untouched.

---

## Further reading

- [docs/BACKGROUND.md](docs/BACKGROUND.md) — the full root-cause investigation
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → diagnosis → fix
- Upstream issue: [ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219)
