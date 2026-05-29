# 🧰 ruflo-machine-ref

**A small, friendly setup kit that makes [ruflo](https://github.com/ruvnet/ruflo) actually work the way it promises — reliable memory, *active* self-learning, verified security, and an at-a-glance status line — especially on modern Node (24/26), where a stock install quietly breaks in ways that still look "green."**

> One-time setup per machine. One command to heal after upgrades. Nothing committed to your repos unless you mean it.

---

## 🤔 What is this, in plain words?

[**ruflo**](https://github.com/ruvnet/ruflo) is an AI orchestration toolkit for [Claude Code](https://claude.com/claude-code) — it gives your AI assistant a memory that survives across sessions, the ability to learn from what works, multi-agent coordination, and security scanning.

The catch: on the versions of Node.js most developers run today, ruflo **silently falls back to a degraded mode**. It still says "✅ OK", but underneath:

- 💾 the **memory** that's supposed to persist… doesn't (writes vanish),
- 🧠 the **self-learning** that's supposed to be on… stays asleep,
- 🎓 the optional **quality-engineering** add-on won't even finish installing,
- 📟 and you have no easy way to *see* which of these is actually working.

This kit closes all of those gaps with a few small, reversible helper scripts — and gives you a **status line** that shows, at a glance, exactly what's live.

> 🙂 **Not a developer?** You only need three commands: `./install.sh`, then `ruflo-setup-project` in a project, and `ruflo-resync` after any upgrade. The rest of this README explains the "why" for the curious.

---

## ⚡ The 30-second version

| You want… | Stock ruflo on Node 24/26 | With this kit |
|---|---|---|
| 💾 Memory that persists across sessions | Says "saved" but loses data | Saves for real, and **verifies** it landed on disk |
| 🧠 Self-learning that's actually on | Reports "Not loaded" | **Active & proven** (trains → patterns persist) |
| 🛡️ Security scanning | Ships but undocumented/unverified | **Verified**: scan, secrets, prompt-injection defense |
| 🎓 Agentic-QE quality fleet (optional) | `aqe init` fails on Node 24/26 | **Installs cleanly** (same bug, auto-fixed) |
| 📟 Knowing what's active | No indication | **Status-line footer** shows 🧠 / 🛡️ / 🎓 live |
| 🔁 Surviving an upgrade | Re-breaks silently every upgrade | **`ruflo-resync`** — one command re-heals everything |
| 💰 Token budget | ~84k tokens/session of MCP tool defs | MCP optional; CLI-first saves the tokens |

---

## 🧩 What's actually wrong (the short story)

Modern Node.js (24 and 26) changed its native-addon ABI. ruflo's deeper dependencies pin an **old `better-sqlite3`** that has no prebuilt binary for those Node versions and won't compile against them. npm treats it as optional and **skips it silently**, so ruflo drops to a pure-JavaScript SQLite fallback whose write path **loses data** — while still printing success.

That single root cause cascades:

1. 💾 **Memory loss** — the headline symptom.
2. 🧠 **Dormant self-learning** — the same missing binary keeps the ruvector engine (SONA, HNSW, ReasoningBank) asleep.
3. 🎓 **Agentic-QE won't initialize** — it's a *separate* package ([`agentic-qe`](https://github.com/proffesor-for-testing/agentic-qe)) with the *same* bug.

> 📎 **A note on prior art.** A colleague, **Ciprian Melian**, wrote an excellent project-scoped repair kit as a gist ([link](https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6)) that pairs ruflo with agentic-qe. This kit builds on those ideas but takes a **machine-wide, upgrade-safe** approach — and our investigation found that several of the gist's source patches are now **already upstream in ruflo 3.10.5** (the real remaining lever is the missing native binary, not the source patches). The full story is in [docs/BACKGROUND.md](docs/BACKGROUND.md).

The deep dive — ABI tables, the exact files, why "HNSW: Not loaded" is a cosmetic lie — lives in **[docs/BACKGROUND.md](docs/BACKGROUND.md)**.

---

## ✨ What this kit gives you

- 🩹 **Native SQLite, everywhere ruflo needs it** — `ruflo-patch-native` swaps the broken dependency for one that works on Node 24/26.
- 🧠 **Activated + *proven* self-learning** — `ruflo-enable-learning` turns ruvector on and asserts it (5 real capability probes, not the misleading status text); `ruflo-learning-verify` trains a cycle and confirms patterns persist to disk.
- 🛡️ **Verified security surface** — `ruflo-security-verify` confirms `@claude-flow/security` + `@claude-flow/aidefence` load, that prompt-injection defense actually fires, and flags the known CVE-database gap.
- 🎓 **Opt-in agentic-qe** — `ruflo-setup-aqe` fixes the same native-SQLite bug in agentic-qe, then initializes it (with half-init repair).
- 📟 **A status-line footer** that shows 🧠 self-learning, 🛡️ security, and 🎓 agentic-qe — each only when genuinely active.
- 🔁 **`ruflo-resync`** — one command to re-apply *everything* after a ruflo or agentic-qe upgrade.
- 🧹 **Clean repos & cheap sessions** — strips MCP cruft `ruflo init` would commit, pins an absolute memory path, and keeps MCP optional to save ~84k tokens/session.
- ↩️ **Reversible** — `uninstall.sh` backs up and removes the machine-level setup; `--this-project` also reverts a repo's statusline patches.

---

## 🚀 Quick start

```bash
# 1. Get the kit
git clone https://github.com/pacphi/ruflo-machine-ref.git && cd ruflo-machine-ref
./install.sh                    # idempotent; try --dry-run first if you like
exec $SHELL                     # load the helper functions

# 2. Make the global ruflo install healthy (once, and after each upgrade)
ruflo-resync                    # native SQLite + self-learning + statusline, all at once

# 3. In any project you work in
cd ~/my-project
ruflo-setup-project             # clean init: no MCP cruft, native SQLite, verified writes
ruflo-learning-verify           # prove self-learning actually persists
```

🪙 **Prefer CLI-only (no MCP, ~84k tokens saved per session)?** Skip `ruflo-setup-machine`; the installed `~/.claude/CLAUDE.md` reference teaches Claude Code to drive ruflo through plain Bash.

---

## 🛠️ The commands

| Command | What it does |
|---|---|
| 🔁 `ruflo-resync [--aqe]` | **The one you'll use most.** After any ruflo/agentic-qe upgrade, re-applies everything the upgrade wipes: native SQLite (ruflo + agentic-qe) + self-learning assert + statusline footer. `--aqe` also refreshes QE skills. |
| 🏗️ `ruflo-setup-project [--with-security]` | Per repo: clean init, strip MCP cruft, pin an absolute DB path, native patch, activate memory/swarm/daemon, **verify a write persists**, sanitize CLAUDE.md, heal the status line. `--with-security` adds a security pass. |
| 🩹 `ruflo-patch-native [--check]` | Make ruflo's agentdb use native `better-sqlite3` on Node ≥24. |
| 🧠 `ruflo-enable-learning [--check]` | Activate ruvector self-learning and assert it (5 capability probes). |
| ✅ `ruflo-learning-verify [--keep]` | Prove the learning loop: train in an isolated dir, assert patterns persist 0 → N on disk. |
| 🛡️ `ruflo-security-verify [--quick]` | Verify `@claude-flow/security` + `aidefence` load, injection defense fires, scan/secrets run; flag the CVE-DB gap. |
| 🎓 `ruflo-setup-aqe [--force]` | **Opt-in.** Fix agentic-qe's native-SQLite bug, then initialize it in a repo (with half-init repair). |
| 💾 `ruflo-memory-checkpoint [db]` | Force a WAL checkpoint to recover stale memory reads. |
| 🧽 `ruflo-remove-mcp` | Remove ruflo MCP from **all** scopes (recover ~84k tokens/session). |
| 📇 `ruflo-setup-machine` | One-time: register ruflo MCP at **user** scope (all projects). Optional. |
| 🔍 `ruflo-parity-test [--cleanup]` | 20-check end-to-end memory smoke test in an isolated `/tmp` dir. |
| 📝 `ruflo-reference-refresh [--diff\|--regenerate]` | Inspect/rebuild the machine-wide CLAUDE.md ruflo block from the template. |

---

## 📟 The status line

When set up with this kit, a two-line footer is appended **below** ruflo's own status line. It's append-only — it never rewrites ruflo's lines, so a ruflo update can't break it. Each piece appears **only when that feature is genuinely active**:

```
▊ RuFlo V3.10.5 ● you  │  ⏇ main  │  Opus 4.x        ┐
🏗️  DDD Domains … 🤖 Swarm … 🔧 Architecture …       ├ ruflo's own lines (unchanged)
📊 AgentDB …                                          ┘
────────────────────────────────────────────         ← the kit's appended footer ↓
🧠 SONA  50 patterns · 55 traj · ⚡ HNSW        🛡 aidefence on
🎓 Agentic QE  23 patterns · 16MB
```

*(The `⚡ HNSW` marker and the `🎓 Agentic QE` line appear only when a vector index / agentic-qe are actually present; the numbers above are illustrative.)*

- 🧠 **SONA** — pattern & trajectory counts from `.claude-flow/neural/stats.json`; `⚡ HNSW` shows only when a vector index exists.
- 🛡️ **aidefence on** — proactive prompt-injection/PII defense is loaded (ruflo's native line already shows the `CVE n/m` count, so this signals the *other* half).
- 🎓 **Agentic QE** — patterns / trajectories / vectors / size from `.agentic-qe/memory.db` (one cheap, guarded read).

---

## 🔁 Keeping it working after upgrades

Every `npm install -g ruflo@latest` (or `agentic-qe@latest`) re-resolves dependency pins, **drops the native binaries again**, and regenerates the status line — so self-learning goes dormant and the footer disappears. You don't have to remember the five things to redo:

```bash
npm install -g ruflo@latest     # or agentic-qe@latest
ruflo-resync                    # ✨ one command heals it all
ruflo-resync --aqe              # …and also refresh agentic-qe skills
```

---

## 🧬 Node version policy (important)

ruflo's memory & learning are healthy out of the box on **Node 22 LTS**, and need the patch on **Node 24/26**:

| Node | ABI | Stock backend | What to do |
|------|-----|---------------|------------|
| ≤ 22 (LTS) | ≤ 127 | ✅ native | nothing — `ruflo-resync` just confirms green |
| 24 | 137 | ⚠️ JS fallback (loses data) | `ruflo-resync` |
| 26 | 147 | ⚠️ JS fallback (loses data) | `ruflo-resync` |

The patch keys off Node's ABI, so it's safe to run on any version (it no-ops where unneeded). Prefer zero patching? Run ruflo on **Node 22 LTS**.

---

## 🙅 Why not just the ruflo one-liner?

The popular quickstart works for an afternoon in one repo:

```bash
ruflo init --full --start-all --force && claude mcp add ruflo -- ruflo mcp start && ruflo doctor
```

…but it bakes in choices that don't age well across many projects and modern Node:

| Concern | The one-liner | This kit |
|---|---|---|
| 🔭 **Mindset** | Per-project, repeated every repo | Configure the machine once, reuse everywhere |
| 📄 **`.mcp.json`** | Written with cloud-SaaS servers — easy to commit by accident | Stripped; nothing project-scoped committed unless you mean it |
| 💰 **Token cost** | MCP always on → ~84k tokens/session | MCP optional; CLI-first reference keeps sessions lean |
| 💾 **Memory on Node 24/26** | `doctor` says "healthy" while writes silently vanish | Native SQLite + a real store→disk verification |
| 🧠 **Self-learning** | Looks "Not loaded"; no way to tell if it works | Activated and **proven** via a train/persist test |
| ↩️ **Reversibility** | Manual cleanup | `uninstall.sh` reverses the setup with backups (`--this-project` also reverts a repo's statusline) |

It's not a replacement for ruflo — just a thin, reversible layer that picks safe defaults and closes the gaps.

---

## 📦 What's in the box

```
ruflo-machine-ref/
├── install.sh                 # idempotent installer (backs up what it touches)
├── uninstall.sh               # clean reversal
├── bin/
│   ├── ruflo-patch-native     # native better-sqlite3 on Node ≥24
│   ├── ruflo-parity-test      # 20-check end-to-end memory smoke test
│   ├── ruflo-enable-learning  # activate + assert ruvector self-learning
│   ├── ruflo-learning-verify  # prove the learning loop persists
│   └── ruflo-security-verify  # verify security scan/defend/secrets + aidefence
├── shell/
│   └── ruflo-functions.sh     # ruflo-resync, ruflo-setup-project, ruflo-setup-aqe, …
├── claude/
│   └── ruflo-reference.md     # the machine-wide CLAUDE.md ruflo block (CLI-first)
└── docs/
    ├── BACKGROUND.md          # the full root-cause story (memory + learning + aqe + security)
    ├── TROUBLESHOOTING.md     # symptom → diagnosis → fix
    └── superpowers/           # the design spec + implementation plan
```

---

## 🗑️ Uninstall

```bash
./uninstall.sh                  # removes bin scripts, template, CLAUDE.md block, rc source line
./uninstall.sh --this-project   # ALSO revert the kit's statusline patches in the current repo
./uninstall.sh --dry-run        # preview without changing anything
```

The plain `uninstall.sh` removes only machine-level setup; your ruflo install, memory
DBs, and **project files** (including any statusline a project already had) are left
untouched. Add `--this-project` from a repo root to revert that repo's statusline
patches too (it backs up first and leaves all ruflo/agentic-qe data alone — use
`ruflo cleanup --force` for per-project data).

---

## 📚 Further reading

- 📖 [docs/BACKGROUND.md](docs/BACKGROUND.md) — the full root-cause investigation (Node/ABI/WASM, why self-learning looked dormant, the agentic-qe variant, the security surface)
- 🔧 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → diagnosis → fix runbook
- 🧱 [docs/superpowers/](docs/superpowers/) — the design spec and implementation plan behind the self-learning work

---

## 🙏 Credits & citations

This kit stands on the shoulders of several projects and people:

- 🧠 **ruflo** (a.k.a. claude-flow) by ruvnet — the orchestration toolkit this kit configures: <https://github.com/ruvnet/ruflo>
- 🎓 **agentic-qe** by *proffesor-for-testing* — the standalone quality-engineering fleet: <https://github.com/proffesor-for-testing/agentic-qe>
- 📎 **Ciprian Melian's setup-and-repair gist** — prior art that paired ruflo with agentic-qe and inspired this kit's direction: <https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6>
- 🐞 **Upstream tracking issue** for the memory/Node bug family: [ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219)
- 🗄️ **better-sqlite3** — the native SQLite binding at the heart of the fix: <https://github.com/WiseLibs/better-sqlite3>
- 🤖 **Claude Code** by Anthropic — the agent this all runs inside: <https://claude.com/claude-code>

> Target: macOS / Linux · zsh or bash · ruflo 3.10.x · Node 20–26 · Python 3.10+.
> A thin, reversible layer — not a fork. PRs and issues welcome.
