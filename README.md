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

> 🙂 **Not a developer?** You only need three commands: `./install.sh` (once), then `ruflo-onboard` inside a project, and `ruflo-resync` after any upgrade. The rest of this README explains the "why" for the curious.

---

## ⚡ The 30-second version

| You want… | Stock ruflo on Node 24/26 | With this kit |
|---|---|---|
| 💾 Memory that persists across sessions | Lost data pre-3.10.6; native by default on ≥3.10.6 (never *verified*) | Saves for real, and **verifies** it landed on disk |
| 🧠 Self-learning that's actually on | Reports "Not loaded" | **Active & proven** (trains → patterns persist) |
| 🛡️ Security scanning | Ships but undocumented/unverified | **Verified**: scan, secrets, prompt-injection defense |
| 🎓 Agentic-QE quality fleet (optional) | `aqe init` fails on Node 24/26 | **Installs cleanly** (same bug, auto-fixed) |
| 📟 Knowing what's active | No indication | **Status-line footer** shows 🧠 / 🛡️ / 🎓 live |
| 🔁 Surviving an upgrade | Re-breaks silently every upgrade | **`ruflo-resync`** — one command re-heals everything |
| 💰 Token budget | ~84k tokens/session of MCP tool defs | MCP optional; CLI-first saves the tokens |

---

## 🧩 What's actually wrong (the short story)

Modern Node.js (24 and 26) changed its native-addon ABI. ruflo's deeper dependencies *declared* an **old `better-sqlite3`** with no prebuilt for those Node versions; npm skipped it silently and ruflo dropped to a pure-JavaScript SQLite fallback whose write path **lost data while printing success**. **ruflo v3.10.6 fixed this upstream** ([#2219](https://github.com/ruvnet/ruflo/issues/2219)) with an npm `overrides` entry that forces `better-sqlite3 ≥12.8.0` (Node 20–26 prebuilts), so on current ruflo the memory bug **no longer bites by default**.

What this kit still adds, because the override doesn't cover everything:

1. 💾 **Verifies memory actually persists** — a real store→disk check, instead of trusting `doctor`'s "healthy". (The data-loss bug itself is now fixed upstream on ruflo ≥3.10.6.)
2. 🧠 **Activates & proves self-learning** — puts the native binary in place where needed and *asserts* the ruvector engine (SONA, HNSW, ReasoningBank) is genuinely on, not just reported on.
3. 🎓 **Agentic-QE won't initialize** — it's a *separate* package ([`agentic-qe`](https://github.com/proffesor-for-testing/agentic-qe)) **not** covered by ruflo's override, so it still hits the same Node-ABI wall; `ruflo-setup-aqe` fixes it.
4. 🧹 **MCP-cruft, token, and daemon hygiene** — strips committed `.mcp.json`, keeps sessions CLI-lean, and (as of the [token-consumption work](docs/usage/token-consumption-findings-and-mitigation-2026-06.md)) makes the background daemon opt-in + self-reaping.

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

## ✅ Prerequisites

This kit *configures and heals* ruflo — it doesn't bundle it. You need a few
things on your machine first. `install.sh` checks for these and can install the
npm packages for you (interactively, or via flags).

**Required (install.sh aborts if missing):**

| Tool | Why | Get it |
|---|---|---|
| Node.js (20–26 supported) | runtime for ruflo & the helpers | <https://nodejs.org> |
| npm | installs the global packages | ships with Node.js |
| `ruflo` | the orchestration toolkit this kit configures | `npm i -g ruflo` (install.sh can do this) |

**Recommended (install.sh warns, then continues):**

| Tool | Why |
|---|---|
| `claude` (Claude Code) | the agent this all runs inside |
| `sqlite3` | the status line + memory verifications read the DBs |
| `git` | to clone/update this kit |

**Optional (only for the QE fleet):**

| Tool | Why | Get it |
|---|---|---|
| `agentic-qe` (`aqe`) | the standalone quality-engineering fleet (🎓 segment) | `npm i -g agentic-qe` (install.sh `--with-aqe`) |

> 🔑 **"Security" and "learning" are not separate installs.** `@claude-flow/security`,
> `@claude-flow/aidefence`, and the ruvector self-learning engine all ship *inside*
> ruflo — this kit *activates and verifies* them. So the "full boat" is just two
> npm packages (`ruflo` + `agentic-qe`); the kit lights up the rest.

---

## 🚀 Quick start

The fastest path — install the kit, prereqs, and heal in one go:

```bash
# 1. Get the kit
git clone https://github.com/pacphi/ruflo-machine-ref.git && cd ruflo-machine-ref

# 2. Bootstrap the machine (pick your level)
./install.sh                 # friendly interactive onboard (asks per step)
./install.sh --full --yes    # "full boat": ruflo + agentic-qe + heal, no prompts
./install.sh --ruflo-only    # just ruflo + heal
./install.sh --minimal       # only lay down the kit files (you have the prereqs)
exec $SHELL                  # load the helper functions

# 3. In any project you work in
cd ~/my-project
ruflo-onboard                # clean setup + prove self-learning persists, in one step
ruflo-onboard --aqe          # …and also initialize the agentic-qe fleet here
```

Try `./install.sh --dry-run` first to preview exactly what it will do.

> **Key distinction:** `install.sh` runs **once on the machine** and never inside a project repo — it deploys the shell functions and heals global packages. `ruflo-onboard` runs **once per project** and never touches global state. If you're unsure which to use, see [Which command do I run?](#-which-command-do-i-run).

🪙 **Prefer CLI-only (no MCP, ~84k tokens saved per session)?** The Quick Start above gives you CLI-only by default — `ruflo-setup-machine` is a separate, optional step that registers the ruflo MCP server. Skip it (the default) and Claude Code drives ruflo through plain Bash using the installed `~/.claude/CLAUDE.md` reference. Run it only if you specifically want the MCP tool schema available in-session.

---

## 🛠️ The commands

| Command | What it does |
|---|---|
| 🔁 `ruflo-resync [--aqe]` | **The one you'll use most.** After any ruflo/agentic-qe upgrade, re-applies everything the upgrade wipes: native SQLite (ruflo + agentic-qe) + self-learning assert + statusline footer. `--aqe` also refreshes QE skills. |
| 📂 `ruflo-onboard [--with-security] [--aqe]` | **Per-repo, run from inside it.** One command: clean `setup-project` → prove learning persists → (`--aqe`) initialize agentic-qe. Prints what's active + what's next. |
| 🏗️ `ruflo-setup-project [--with-security]` | Per repo: clean init, strip MCP cruft, pin an absolute DB path, native patch, activate memory/swarm/daemon, **verify a write persists**, sanitize CLAUDE.md, heal the status line. `--with-security` adds a security pass. |
| 🩹 `ruflo-patch-native [--check]` | Make ruflo's agentdb use native `better-sqlite3` on Node ≥24. |
| 🧠 `ruflo-enable-learning [--check]` | Activate ruvector self-learning and assert it (5 capability probes). |
| ✅ `ruflo-learning-verify [--keep]` | Prove the learning loop: train in an isolated dir, assert patterns persist 0 → N on disk. |
| 🎚️ `ruflo-neural-train [args…]` | Thin passthrough to `ruflo neural train` in the current project (args pass through), then advances the live micro-LoRA tracker. |
| 📈 `ruflo-lora-track` | Advance the live micro-LoRA adaptation tracker now (`Δ‖W‖` on the SONA line). Otherwise auto-refreshes on each statusline render as ruflo learns new patterns from your work. |
| 🛡️ `ruflo-security-verify [--quick]` | Verify `@claude-flow/security` + `aidefence` load, injection defense fires, scan/secrets run; flag the CVE-DB gap. |
| 🎓 `ruflo-setup-aqe [--force]` | **Opt-in.** Fix agentic-qe's native-SQLite bug, then initialize it in a repo (with half-init repair). |
| 💾 `ruflo-memory-checkpoint [db]` | Force a WAL checkpoint to recover stale memory reads. |
| 🧽 `ruflo-remove-mcp` | Remove ruflo MCP from **all** scopes (recover ~84k tokens/session). |
| 📇 `ruflo-setup-machine` | One-time: register ruflo MCP at **user** scope (all projects). Optional. |
| 🔍 `ruflo-parity-test [--cleanup]` | 20-check end-to-end memory smoke test in an isolated `/tmp` dir. |
| 📝 `ruflo-reference-refresh [--diff\|--regenerate]` | Inspect/rebuild the machine-wide CLAUDE.md ruflo block from the template. |
| 📊 `ruflo-token-audit [--days N] [--json]` | **Where's my usage going?** Comprehensive Claude Code usage report across N days (default 7): tokens by day/model/project, **tool & MCP usage**, **subagent fan-out**, **web-tool calls**, **cache efficiency**, **busiest sessions**, **hourly activity**, and a cross-reference of running `ruflo` daemons vs your top-burn projects. The engine is bundled inside the skill (works standalone) and also installed here on PATH. |

> 💡 **Token-audit skill.** The kit also installs a user-scope Claude skill,
> `ruflo-token-audit`, available in every project. Just ask Claude in plain language —
> e.g. *"Audit my Claude Code token usage for the last 7 days — what's burning my
> tokens?"* — and it runs the audit, checks for runaway daemons, and recommends fixes.
> Background: [docs/usage/token-consumption-findings-and-mitigation-2026-06.md](docs/usage/token-consumption-findings-and-mitigation-2026-06.md).

---

## 🧭 Which command do I run?

**`install.sh` is the front door you walk through once; the functions are how you live in the house.**

| | `install.sh` | The functions |
|---|---|---|
| **Nature** | a script run *from the kit repo* | commands on your `PATH`, available everywhere after install |
| **Frequency** | once per machine (+ rarely, to re-lay the kit) | ongoing, day-to-day |
| **Scope** | machine-level bootstrap | machine-recurring **and** per-project |

On first run the functions aren't sourced yet, so `install.sh` sources them
in-process and calls the *same* `ruflo-patch-native` / `ruflo-enable-learning`
to heal — one source of truth, no drift. After that you never need `install.sh`
for healing again.

| Situation | Run this | Why not the other |
|---|---|---|
| 🆕 Brand-new machine | **`install.sh`** | nothing's on PATH yet — only the script can bootstrap |
| 🔁 Re-cloned kit / new shell / wiped `~/.local/bin` | **`install.sh`** | re-lays the kit files (idempotent, backs up) |
| 📥 After `git pull` on this kit repo | **`install.sh --minimal`** | redeploys updated shell functions + CLAUDE.md template; `ruflo-resync` doesn't touch kit files |
| ⬆️ After `npm i -g ruflo@latest` (or aqe) | **`ruflo-resync`** | the upgrade only wiped native binaries — re-running install.sh is the heavier wrong tool |
| 📂 Starting in a new repo | **`ruflo-onboard`** | per-project; install.sh is machine-level and won't touch your repo |
| 🔍 Routine checks | **functions** (`ruflo-parity-test`, `ruflo-learning-verify`) | no reason to re-bootstrap |

**Rule of thumb:**
- *"I'm setting up"* → `install.sh` (once).
- *"I upgraded ruflo/aqe"* → `ruflo-resync`.
- *"I'm starting work in a repo"* → `ruflo-onboard`.

---

## 📟 The status line

When set up with this kit, a footer is appended **below** ruflo's own status line. It's append-only — it never rewrites ruflo's lines, so a ruflo update can't break it. Each ruflo feature renders on **its own line** (so the live metrics are individually scannable), and each piece appears **only when that feature is genuinely active**:

```
▊ RuFlo V3.10.46 ● you  │  ⏇ main  │  Opus 4.x       ┐
🏗️  DDD Domains … 🤖 Swarm … 🔧 Architecture …       │ ruflo's own lines + the kit's
📊 AgentDB …                                          │ per-feature lines (all ruflo)
🧠 SONA  [●●●●●]  70 patterns · 132 traj · ⚡ HNSW · Δ‖W‖0.0039 +0.0021▲ n70  │
📈 RL  ε1.00↓ · δ̄0.779↓ · |Q|6 · upd9                │ live route Q-learner metrics
🛡 aidefence on                                       ┘
─────────────────────────────────────────────────────  ← divider (matches ruflo's header rule)
🎓 Agentic QE V3.10.7  🎓 23 patterns · 🧭 114 traj · 🧬 543 vec⚡ · 💾 16MB
```

Every field renders only when its data is actually present (numbers above are illustrative):
- 🧠 **SONA** — `[bar]` is a volume gauge (~10 patterns/dot); `patterns`/`traj` from `.claude-flow/neural/stats.json` (these now persist across restarts, ruflo #2245); `⚡ HNSW` only when a vector index exists.
- 📈 **RL** — **live** route Q-learner metrics, shown only once the learner has actually run (`updateCount > 0`): `ε`↓ (exploration), `δ̄`↓ (mean TD error), `|Q|` (distinct task-states — a real count since the encoder fix F3, ruflo #2239, **fixed in 3.10.11, confirmed still correct in 3.10.46**: 6 tasks → 6 distinct Q-states), `upd` (updates). Read fs-only from `.swarm/q-learning-model.json` — which persists across `ruflo route feedback` calls (saveModel, ruflo 3.10.6+); never the broken `route stats` CLI.
- ◷ **proof** (alarm-only) — the most recent `ruflo-improvement-eval` verdict (`.claude-flow/improvement.json`), a *synthetic* proof-of-mechanism (its own reward env: permutation `p` + Cohen's `d` + above-chance vs a no-learning ablation), **not** a live measure of real routing. A `PASS` (expected) renders **nothing**; only a regression surfaces as `◷ proof FAIL  Δpp · CI · p · d · <age>` (the age keeps a stale FAIL honest). Never fabricated.
- 🛡️ **aidefence on** — proactive prompt-injection/PII defense is loaded (ruflo's native line already shows the `CVE n/m` count, so this signals the *other* half).
- **`Δ‖W‖` — live micro-LoRA adaptation, showing the model *actually adapting from your work*.** `Δ‖W‖0.0039` is the Frobenius norm of the micro-LoRA weight delta `‖scaling·(A·B)‖_F` (federated-LoRA's standard adaptation-magnitude monitor); `+0.0021▲` is the growth *this session* (the live signal); `n70` is the count of distinct patterns adapted. **Why a kit-maintained adapter:** ruflo's own micro-LoRA is per-process scratch — the code literally says `source: 'sonaCoordinator (in-memory, resets per process)'`, so every hook reinitialises it (random `A`, `B=0`), applies that call's signals, then **discards the weights**; only `patterns.json`/`stats.json` persist. The kit therefore persists what ruflo throws away: a single cumulative micro-LoRA in `.claude-flow/neural/lora-live.json`, advanced inline by the statusline (mtime+TTL gated) by feeding each **new** pattern ruflo distils from your work through the genuine `@ruvector/ruvllm 2.5.6` gradient path (real since F4 fixed), **weighted by ruflo's own per-pattern confidence** (no fabricated reward). The init RNG is **seeded** and weights are **restored** each tick, so the value is **deterministic** (no random-init noise) and **cumulative** — it climbs as you work. Honest scope: a kit-persisted *mirror* of ruflo's discarded adapter, fed ruflo's real confidence-weighted patterns. Not shown: the LoRA *amplification factor* (needs a frozen base `W`; the micro-LoRA is a standalone residual adapter with none) or a live reward curve (`ruflo neural train`'s WASM path records trajectories, not signals → `0`). Refreshed automatically on render and by `ruflo-lora-track` / `ruflo-neural-train` / `ruflo-resync`.
- 🎓 **Agentic QE** — `V<version>` is the installed `agentic-qe` package version (read from its `package.json`, mirroring `RuFlo V<x>` in ruflo's header); `🎓 patterns` / `🧭 traj` / `🧬 vec` / `💾 size` from a few guarded `sqlite3` reads of `.agentic-qe/memory.db` (the `vec` count comes from `qe_pattern_embeddings`, falling back to `vectors`/`embeddings` across aqe versions). The branch is already in ruflo's header line, so it's not repeated here.

---

## 🔁 Keeping it working after upgrades

Every `npm install -g ruflo@latest` (or `agentic-qe@latest`) re-resolves dependency pins, **drops the native binaries again**, and regenerates the status line — so self-learning goes dormant and the footer disappears. You don't have to remember everything an upgrade wipes:

```bash
npm install -g ruflo@latest     # or agentic-qe@latest
ruflo-resync                    # ✨ one command heals it all
ruflo-resync --aqe              # …and also refresh agentic-qe skills
```

> ⚠️ **On npm ≥ 11.17, `ruflo-resync` is now *more* necessary, not less.** npm 11.17
> introduced **`allow-scripts`**, which blocks packages' install/postinstall scripts by
> default — including `better-sqlite3`'s `prebuild-install` and `node-gyp`. So an upgrade
> (even `npm update -g`) **silently skips the native addon build**, and ruflo falls back to
> buggy WASM (you'll see `npm warn allow-scripts …` during the upgrade, and
> `ruflo-patch-native --check` will report "needs patch" afterward). `ruflo-resync` heals
> it — its `ruflo-patch-native` step installs the native binary *even under `allow-scripts`*
> (verified on npm 11.17). **Always run `ruflo-resync` after a global upgrade on npm ≥ 11.17.**

**After `git pull` on this kit itself:** Run `./install.sh --minimal` to copy the updated shell functions and CLAUDE.md template to `~/.config/ruflo/`. It is idempotent and won't reinstall npm packages. This is the right step whenever you pull a new version of this repo — `ruflo-resync` only heals native binaries and self-learning; it does not redeploy the kit files.

---

## 🧬 Node version policy

**As of ruflo v3.10.6 this is largely handled upstream** ([#2219](https://github.com/ruvnet/ruflo/issues/2219)):
ruflo now forces `better-sqlite3 ≥12.8.0` (Node 20–26 prebuilts) via an npm `overrides`
entry, so the agentdb copies resolve to native v12 even on Node 24/26 — no more silent JS
fallback by default, and the override survives upgrades.

| Node | ABI | Stock backend (ruflo ≥3.10.6) | What to do |
|------|-----|-------------------------------|------------|
| ≤ 22 (LTS) | ≤ 127 | ✅ native | nothing |
| 24 | 137 | ✅ native (v12 via override) | nothing — `ruflo-resync` re-asserts if ever needed |
| 26 | 147 | ✅ native (v12 via override) | nothing — `ruflo-resync` re-asserts if ever needed |

`ruflo-patch-native` is now a **safety net** rather than a requirement. It still matters in
two cases: **ruflo < 3.10.6** on Node ≥24 (no override yet → WASM fallback), and
**agentic-qe** (a separate package with its own native-SQLite init — `ruflo-setup-aqe`
repairs it). It keys off Node's ABI and no-ops where unneeded, so it's always safe to run.
Prefer to sidestep the whole topic? Run ruflo on **Node 22 LTS**.

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
| 💾 **Memory on Node 24/26** | healthy on ruflo ≥3.10.6 (upstream override); the one-liner never *verifies* it landed | Native SQLite **plus** a real store→disk verification — and catches the `<3.10.6` / agentic-qe gaps the override misses |
| 🧠 **Self-learning** | Looks "Not loaded"; no way to tell if it works | Activated and **proven** via a train/persist test |
| ↩️ **Reversibility** | Manual cleanup | `uninstall.sh` reverses the setup with backups (`--this-project` also reverts a repo's statusline) |

It's not a replacement for ruflo — just a thin, reversible layer that picks safe defaults and closes the gaps.

---

## 📦 What's in the box

```
ruflo-machine-ref/
├── install.sh                 # machine bootstrap: prereqs + kit + heal (profiles, interactive)
├── uninstall.sh               # clean reversal (opt-in --purge for global npm packages)
├── bin/
│   ├── ruflo-patch-native       # native better-sqlite3 (safety net; see Node policy)
│   ├── ruflo-parity-test        # 20-check end-to-end memory smoke test
│   ├── ruflo-enable-learning    # activate + assert ruvector self-learning
│   ├── ruflo-learning-verify    # prove the learning loop persists
│   ├── ruflo-improvement-eval   # causal self-improvement eval (route Q-learner)
│   ├── ruflo-patch-route-learning # retired no-op on ruflo ≥3.10.6 (kept for older installs)
│   └── ruflo-security-verify    # verify security scan/defend/secrets + aidefence
│                                #   (ruflo-token-audit lives in the skill below; install.sh also puts it on PATH)
├── shell/
│   ├── ruflo-functions.sh     # ruflo-resync, ruflo-onboard, ruflo-setup-project, ruflo-daemon-gc, …
│   └── ruflo-lib.sh           # shared helpers (deployed to ~/.config/ruflo for the bin scripts)
├── claude/
│   ├── ruflo-preamble.md          # always-on operating rules (top of the CLAUDE.md block)
│   ├── ruflo-reference.md         # compact CLI-first CLAUDE.md block (always on)
│   ├── ruflo-reference-full.md    # full reference, deployed on-demand (not auto-loaded)
│   ├── aqe-reference.md           # conditional block — present only when agentic-qe is installed
│   ├── superpowers-reference.md   # conditional block — house rules so superpowers + ruflo coexist
│   └── skills/
│       └── ruflo-token-audit/      # user-scope skill; bundles its own engine (scripts/) → works standalone
└── docs/
    ├── BACKGROUND.md          # the full root-cause story (memory + learning + aqe + security)
    ├── TROUBLESHOOTING.md     # symptom → diagnosis → fix
    ├── CONDITIONAL-BLOCKS.md  # how the per-tool CLAUDE.md blocks work + how to add one
    ├── usage/                 # token-consumption findings & mitigation
    ├── upstream/              # upstream bug findings filed against ruflo / ruvector
    └── superpowers/           # the design specs + implementation plans
```

---

## 🗑️ Uninstall

```bash
./uninstall.sh                  # kit footprint only: bin scripts, template, CLAUDE.md block, rc line
./uninstall.sh --this-project   # ALSO revert the kit's per-project patches (statusline + local MCP config) in the current repo
./uninstall.sh --remove-ruflo   # ALSO npm-uninstall global ruflo (machine-wide; asks first)
./uninstall.sh --remove-aqe     # ALSO npm-uninstall global agentic-qe (machine-wide; asks first)
./uninstall.sh --purge          # --remove-ruflo + --remove-aqe
./uninstall.sh --dry-run        # preview without changing anything
```

The plain `uninstall.sh` removes only machine-level kit setup; your ruflo
install, memory DBs, and **project files** are left untouched. The
`--remove-ruflo` / `--remove-aqe` / `--purge` flags reach the *global npm
packages* — they affect every project on the machine, so each one prompts to
confirm (pass `--yes` to skip in scripts). Add `--this-project` from a repo root to revert that repo's per-project
patches (statusline and any local-scope MCP config — these are repo-level, not
machine-level). It backs up first and leaves all ruflo/agentic-qe data alone —
use `ruflo cleanup --force` for per-project data.

---

## 📚 Further reading

- 📖 [docs/BACKGROUND.md](docs/BACKGROUND.md) — the full root-cause investigation (Node/ABI/WASM, why self-learning looked dormant, the agentic-qe variant, the security surface)
- 🔧 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom → diagnosis → fix runbook
- 🧩 [docs/CONDITIONAL-BLOCKS.md](docs/CONDITIONAL-BLOCKS.md) — how the per-tool CLAUDE.md blocks work (agentic-qe, superpowers), why superpowers needs "house rules," and how to add support for a new tool
- 🧱 [docs/superpowers/](docs/superpowers/) — the design spec and implementation plan behind the self-learning work

---

## 🙏 Credits & citations

This kit stands on the shoulders of several projects and people:

- 🧠 **ruflo** (a.k.a. claude-flow) by ruvnet — the orchestration toolkit this kit configures: <https://github.com/ruvnet/ruflo>
- 🎓 **agentic-qe** by *proffesor-for-testing* — the standalone quality-engineering fleet: <https://github.com/proffesor-for-testing/agentic-qe>
- 📎 **Ciprian Melian's setup-and-repair gist** — prior art that paired ruflo with agentic-qe and inspired this kit's direction: <https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6>
- 🐞 **Upstream issue** for the memory/Node bug family, [ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219) — **resolved in ruflo v3.10.6** (an npm override pins `better-sqlite3 ≥12.8.0` across the agentdb copies); the kit's native patch is now a safety net rather than a requirement
- 🗄️ **better-sqlite3** — the native SQLite binding at the heart of the fix: <https://github.com/WiseLibs/better-sqlite3>
- 🤖 **Claude Code** by Anthropic — the agent this all runs inside: <https://claude.com/claude-code>

> Target: macOS / Linux · zsh or bash · ruflo 3.10.x · Node 20–26 · Python 3.10+.
> A thin, reversible layer — not a fork. PRs and issues welcome.
