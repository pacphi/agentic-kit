# Background — the root-cause investigation

This documents *why* the kit exists, so future maintainers understand the
reasoning rather than cargo-culting the fixes.

## The presenting symptom

`ruflo memory store` prints `[OK] Data stored successfully`, but `ruflo memory
retrieve`, `list`, and `stats` all report **zero entries**. Data appears to
vanish on write.

## Layers peeled, in order

The symptom had **four** distinct causes stacked on top of each other. Each was
found by reproducing in isolation and cross-checking with native `sqlite3`.

### 1. Bash-subprocess cwd drift (Claude Code)

Claude Code's Bash tool spawns each invocation in a fresh subprocess whose cwd
may not match the user's terminal. ruflo's memory backend defaults to
`cwd/.swarm/memory.db`, so `store` and a later `retrieve` could hit **different
DB files**. → Fix: pin `CLAUDE_FLOW_DB_PATH`.

### 2. `${CLAUDE_PROJECT_DIR}` is not expanded

The obvious pin — `"CLAUDE_FLOW_DB_PATH": "${CLAUDE_PROJECT_DIR}/.swarm/memory.db"`
in `settings.local.json` — **does not work**. Claude Code (v2.1.x) passes the
literal string through to the subprocess. ruflo's WASM backend can't open a path
containing a literal `${CLAUDE_PROJECT_DIR}`, silently fails the disk write, and
**still reports `[OK]`**. → Fix: write a **resolved absolute path**.

### 3. `ruflo init` never creates the memory DB

`ruflo init` (without `--start-all`) writes the scaffold but **not**
`.swarm/memory.db`. The first `memory store` then hits "unable to open database
file" — swallowed and reported as success. `--start-all` *does* run `memory
init`, but `--minimal` overrides it away. → Fix: explicitly run `ruflo memory
init` (and `swarm init`, `daemon start`) **after** pinning the DB path.

### 4. (ROOT) Node 24/26 + better-sqlite3@^11.8.1 → buggy WASM fallback

> **Status: resolved upstream in ruflo v3.10.6** ([#2219](https://github.com/ruvnet/ruflo/issues/2219)).
> ruflo added an npm `overrides` entry forcing `better-sqlite3 ≥12.8.0` across the agentdb
> copies (with a CI guard), so the WASM fallback below no longer happens by default on
> ruflo ≥3.10.6 — and because the override is in ruflo's own `package.json`, upgrades keep
> it. The investigation below is retained as the root-cause record; `ruflo-patch-native` is
> now a safety net (still relevant for ruflo <3.10.6 and for the separate **agentic-qe**
> package — see below).

Even with 1–3 fixed, on **Node 26** writes still silently failed (pre-3.10.6). The cause:

- ruflo prefers native `better-sqlite3`; sql.js (WASM) is a *fallback*.
- The deeper `agentdb` packages pin **`better-sqlite3@^11.8.1`**.
- v11.x ships prebuilt binaries only up to `NODE_MODULE_VERSION` **131** (Node
  22). Node 24 is ABI **137**, Node 26 is ABI **147** — no prebuilt.
- v11.8.1's native source **does not compile** against Node 26's V8 (removed the
  deprecated `v8::Value()` API): `make: *** Error 1`.
- Because it's an `optionalDependency`, npm **silently skips it**.
- ruflo falls back to sql.js WASM, whose write path is where the data-loss lives.

Proven in a clean `node:26` Docker container: store says `✅ Using sql.js (WASM
SQLite...)`, retrieve returns "Key not found", native `sqlite3` count is 0.

## The ABI / prebuilt matrix

| Node | ABI (`process.versions.modules`) | better-sqlite3 v11.8.1 | better-sqlite3 v12.x |
|------|-----|------------------------|----------------------|
| 20 | 115 | ✅ prebuilt | ✅ prebuilt |
| 22 (LTS) | 127 | ✅ prebuilt | ✅ prebuilt |
| 24 | 137 | ❌ none + compile fails | ✅ prebuilt |
| 26 | 147 | ❌ none + compile fails | ✅ prebuilt |

**Python version is a red herring.** node-gyp ran fine with Python 3.10 +
distutils; the failure is a C++/V8 incompatibility, not a build-tool gap.
(Python 3.12+ removed `distutils`, which *can* break node-gyp separately — but
that's a different axis.)

## Why the memory CLI mostly works anyway

`@claude-flow/memory` already pins `better-sqlite3@^12.9.0` (has Node 24/26
prebuilts), and the `ruflo memory` CLI resolves better-sqlite3 from there — so on
a fresh install the memory CLI uses **native** v12 and works. Pre-3.10.6 the buggy
WASM path remained for the deeper `agentdb` copies under `@claude-flow/cli`,
`@claude-flow/neural`, and `agentic-flow` (neural training, vector-unified mode,
swarm shared-memory); `ruflo-patch-native` brought those to native v12. **On ruflo
≥3.10.6 the upstream `overrides` already do this** — those copies resolve to native
v12 by default (verified on 3.10.40: `better-sqlite3 v12.10.0`, native binary
present), so the patch is now only a fallback.

## The fix is API-safe

Swapping `better-sqlite3@^11.8.1 → ^12.10.0` across all agentdb copies on Node 26
was verified: native binary loads, store persists, retrieve works, `ruflo`
runs cleanly. better-sqlite3 is very API-stable across majors, and agentdb's
usage is the common subset. No code changes required.

## Related ruflo footguns this kit also neutralizes

- `ruflo init` writes a `.mcp.json` with `ruv-swarm` + `flow-nexus` (auth-gated
  cloud SaaS) that would get committed to the repo.
- `ruflo init --start-all` registers ruflo MCP at **local** scope in
  `~/.claude.json` — so a plain `claude mcp remove ruflo -s user` leaves it
  behind for that project.
- The generated per-project `CLAUDE.md` uses legacy `npx @claude-flow/cli@latest`
  and a `claude mcp add claude-flow` line (claude-flow == ruflo).
- `claude-flow`, `ruv-swarm`, `flow-nexus` as MCP servers cost ~84k tokens of
  tool defs per session; `claude-flow` is a duplicate of `ruflo`.
- `ruflo memory delete` reports success but does **not** remove on-disk rows on
  the WASM backend (so cleanup uses native `sqlite3`).
- The sql.js reader can't replay an uncheckpointed `.swarm/memory.db-wal`,
  producing stale 0-row reads until `PRAGMA wal_checkpoint(TRUNCATE)`.

All of the above were filed/summarized in
[ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219), **resolved in ruflo
v3.10.6** (the `better-sqlite3 ≥12.8.0` override). The MCP-cruft and WASM-delete/WAL
footguns that aren't strictly the Node-ABI bug are still neutralized by the kit's
`ruflo-setup-project` sanitization.

## Self-learning activation (the second investigation)

A follow-up question — "is the ruvector self-learning stack actually *on*?" — led
to a second round of diagnosis on ruflo **3.10.5** / Node **26**. Findings:

> **Prior art / credit.** This round built on a project-scoped setup-and-repair kit
> by Ciprian Melian:
> <https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6>, which
> wires ruflo together with the standalone **agentic-qe** fleet
> (<https://github.com/proffesor-for-testing/agentic-qe>). The analysis below
> documents where that gist's fixes are now redundant (already upstream in 3.10.5)
> versus still needed (the native-SQLite binary, and the previously-undocumented
> agentic-qe variant of the same bug).

### The gist's controller-registry patches are already upstream

A colleague's project-scoped kit (written against ruflo ~3.6) patched
`@claude-flow/memory/dist/controller-registry.js` three ways: ESM `require`→dynamic
import, forcing agentdb ≥3.x, and adding a missing `embedder` to ReasoningBank. On
3.10.5 **all three are already in the shipped code**: `agentdb` resolves to
`3.0.0-alpha.14`, the ESM fix is at `controller-registry.js:313-315`, and
ReasoningBank is constructed with an embedder at `:655`. Porting those patches
verbatim would be redundant. The kit instead keeps a **guarded** compat check
(`ruflo-enable-learning`) that only warns/patches if a *regression* appears
(agentdb < 3.0, or a missing embedder).

### The real reason self-learning looked dormant

`ruflo neural status` reported `Using sql.js (WASM)`, HNSW "Not loaded —
@ruvector/core not available", ReasoningBank "Empty". Two distinct things:

1. **Same root cause as the memory bug**: the agentdb `better-sqlite3` *binary*
   was missing (`native:false` though the version was already `^12`), so agentdb
   ran on WASM. `ruflo-patch-native` fixes it; on 3.10.5 it had simply been wiped by
   the upgrade. This was the dominant lever **at the time** — on ruflo ≥3.10.6 the
   [#2219](https://github.com/ruvnet/ruflo/issues/2219) override keeps that binary
   native across upgrades, so it is now handled by default and the patch only re-asserts.
2. **A cosmetic lazy-status artifact**: `getHNSWStatus()`
   (`@claude-flow/cli/.../memory-initializer.js:663`) returns `available:true`
   only if a lazy `_bridge`/`hnswIndex` singleton was initialized *in that
   process*. The `neural status` command never triggers it, so it prints "Not
   loaded" even though `@ruvector/core` loads fine and exposes `VectorDb` (on
   `.default`). It is **not** real dormancy.

So `ruflo-enable-learning` asserts **real capability** (native bsq3 + `@ruvector/core`→`VectorDb`,
`@ruvector/sona`→`SonaEngine`, `@ruvector/gnn`→`RuvectorLayer`, agentdb v3), not the
lazy display strings. `ruflo-learning-verify` proves the loop persists by training
in an isolated dir and confirming `.claude-flow/neural/patterns.json` goes 0→N.

### agentic-qe has the *same* Node-26 native-SQLite bug

`aqe init --auto` failed at "Initialize persistence database" on Node 26.
agentic-qe depends on `better-sqlite3@^12` **directly** (not via agentdb) and also
ships without the prebuilt `.node` → `native:false`. `ruflo-setup-aqe` installs the
native binary into the global `agentic-qe` before running `aqe init`. The gist did
not cover this (it assumed `aqe init` just works).

### The status-line footer, and the `Δ LoRA` source finding

The kit appends a two-line footer **below** ruflo's native status line (never rewriting
ruflo's lines — chosen over the gist's in-place relabel for upgrade-safety). Most fields
are cheap reads: SONA `patterns`/`traj` from `.claude-flow/neural/stats.json`, the
agentic-qe metrics from a few guarded `sqlite3` reads of `.agentic-qe/memory.db` (the
`vec` count reads `qe_pattern_embeddings`, falling back to `vectors`/`embeddings` —
they vary by aqe version).

One field — `Δ LoRA` (the MicroLoRA delta norm Ciprian's status line shows) — required
digging into ruflo source. In `@claude-flow/cli/.../services/ruvector-training.js`,
`JsMicroLoRA._deltaNorm` is computed as `sqrt(Σ delta²)` over the **last adaptation
step only** (`adapt_array`/`adapt_with_reward`), and is partly stochastic
(`adapt_with_reward` uses `Math.random()`). It is **not persisted** to `stats.json`, and
it **cannot be recovered** from the `lora-checkpoint-*.json` (which stores the
accumulated `{A, B, scaling}` matrices, not the last step's delta). So the only faithful
way to surface it is to **capture it from `ruflo neural train` output and cache it** —
which `ruflo-neural-train` did (writing `.claude-flow/neural/lora-delta.json`).

> **Update (2026-06-01, ruflo 3.10.31).** The `Δ LoRA` field was **removed** from the
> footer: the matrix-LoRA path was still **inert** — `processInstantLearning` was a no-op
> stub and `deltaNorm` stayed 0. In its place the footer carries a **`📈 RL`** route-Q line
> (ε/δ̄/|Q|/upd from `.swarm/q-learning-model.json`), unblocked by the encoder fix (ruflo
> #2239 / F3, fixed in 3.10.11). See `docs/upstream/ruflo-self-improvement-findings.md`.
>
> **Update (2026-06-11).** [ruvnet/RuVector#519](https://github.com/ruvnet/RuVector/issues/519)
> was closed without a published fix; live follow-up was ruvnet/RuVector#553.
> `processInstantLearning` was still a no-op stub in `@ruvector/ruvllm` 2.5.5 (ruflo
> 3.10.40–3.10.42), so `deltaNorm` stayed `0` and the field remained omitted.
>
> **Update (2026-06-15, ruflo 3.10.46 / `@ruvector/ruvllm@2.5.6`).** F4 is **fixed**.
> `processInstantLearning` now does real gradient descent — `LoraAdapter.backward()`
> updates both `loraA` and `loraB`; empirically verified: `deltaNorm` moves
> `0.000000 → 0.001205` after 2 signals. Issue
> [pacphi/ruflo-machine-ref#8](https://github.com/pacphi/ruflo-machine-ref/issues/8)
> is closed.
>
> **Update (2026-06-15b — live `Δ‖W‖` tracker, replacing the capability flag).** A first
> cut showed `Δ LoRA ✓` (a version flag) — academically vacuous (asserts the code path is
> wired, not that learning is meaningful). Investigation then surfaced the real
> architecture: ruflo's micro-LoRA is **per-process scratch** (`intelligence.js:732`:
> `source: 'sonaCoordinator (in-memory, resets per process)'`) — every hook reinitialises
> it (random `A`, `B=0`), applies that call's signals, then **discards the weights**; the
> saved `lora-checkpoint-*.json` has `B=0` so its norm is always 0, and `ruflo neural
> train` reports `deltaNorm 0` because it records *trajectories*, not *signals*. A naïve
> probe over the patterns was also **41%-CV noisy** because `loraA` is Kaiming-random
> per construction. So the kit now **persists what ruflo discards**: a single cumulative
> micro-LoRA in `.claude-flow/neural/lora-live.json`, advanced inline by the statusline
> (mtime+TTL gated) by feeding each **new** distilled pattern through the genuine ruvllm
> 2.5.6 gradient path, **weighted by ruflo's own per-pattern confidence**, with a **seeded
> init** and **restored weights** each tick → deterministic and cumulative. The statusline
> shows `Δ‖W‖<cum> +<session>▲ n<count>` — the model *actually adapting from your work,
> live*. Honest scope: a kit-persisted mirror of ruflo's discarded adapter; not the
> amplification factor (no frozen base `W`) or a live reward curve (not persisted).

### Security surface

ruflo ships `@claude-flow/security` (3.0.0-alpha.10) and `@claude-flow/aidefence`
(3.0.3) (versions as of ruflo 3.10.40). `ruflo security defend` correctly **detects** prompt-injection (signals via
exit code: 1=threat, 0=clean) but has an upstream cosmetic crash after detection
(`Cannot read properties of undefined (reading 'color')`) — verdict/exit code are
still correct. `ruflo security cve --list` has **no CVE database configured**; use
`npm audit` for dependency CVEs. `ruflo-security-verify` checks all of this.
