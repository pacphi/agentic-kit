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

## Why not just the one-liner?

The ruflo quickstart most people run is:

```bash
ruflo init --full --start-all --force && claude mcp add ruflo -- ruflo mcp start && ruflo doctor
```

It works, and for a quick try it's fine. But it bakes in choices that don't age
well across many projects:

| Concern | `ruflo init … && claude mcp add … && ruflo doctor` | This kit (`ruflo-setup-project`) |
|---|---|---|
| **Scope mentality** | **Per-project, repeated.** You re-run the whole chain in every repo, and `claude mcp add` (no `-s`) registers ruflo at **local** scope — private to *that* project. New repo → do it all again. | **Set once per machine, reuse everywhere.** Register the MCP at **user** scope once (or skip it); the CLAUDE.md reference is machine-wide. Per repo you run one idempotent command. |
| **`.mcp.json`** | Written with `ruv-swarm` + `flow-nexus` (auth-gated cloud SaaS) — easy to commit and force on teammates. | Stripped. Nothing project-scoped gets committed unless you mean it. |
| **MCP scope hygiene** | `--start-all` *also* registers ruflo at local scope in `~/.claude.json`, so a later `claude mcp remove ruflo -s user` leaves a copy behind. | Local-scope leftovers removed; `ruflo-remove-mcp` clears all scopes. |
| **Context cost** | MCP always on → ~84k tokens of tool defs every session, every project. | MCP optional. The machine-wide CLAUDE.md teaches Claude Code to drive ruflo via Bash — CLI-only saves ~84k tokens/session. |
| **Memory on Node 24/26** | `ruflo doctor` reports "healthy" while the deeper agentdb runs on the sql.js WASM backend that **silently loses writes**. Green check, lost data. | `ruflo-patch-native` puts agentdb on native better-sqlite3; setup **verifies a store lands an on-disk row** before declaring success. |
| **Memory DB creation** | `--start-all` initializes it — but `--minimal` (or any flags without `--start-all`) doesn't, and the first store no-ops. | Memory/swarm/daemon activated explicitly, in order, **after** pinning an absolute DB path. |
| **`CLAUDE_FLOW_DB_PATH`** | Not set. Subject to Claude Code's Bash-subprocess cwd drift (store and retrieve hit different DBs). | Pinned to a resolved absolute path; `${CLAUDE_PROJECT_DIR}` literal trap avoided. |
| **Generated CLAUDE.md** | Legacy `npx @claude-flow/cli@latest` commands; duplicated into every repo (drift inevitable). | Single machine-wide reference; per-project file sanitized and pointed at it. |
| **Verification** | `ruflo doctor` checks the install, not whether memory actually round-trips. | `ruflo-parity-test` does a 20-check end-to-end store→retrieve→native-sqlite cross-check. |
| **Reversibility** | Manual cleanup. | `uninstall.sh` reverses everything with backups. |

**Rule of thumb:**

- Trying ruflo in one repo for an afternoon? The one-liner is fine.
- Running ruflo across many repos, on Node 24/26, and/or watching your token
  budget? This kit encodes "configure the machine once, keep each repo clean,
  and prove memory actually works."

It's not a replacement for ruflo — it's a thin, reversible layer that picks
safe defaults and closes the gaps the quickstart leaves open.

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
git clone https://github.com/pacphi/ruflo-machine-ref.git && cd ruflo-machine-ref
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
