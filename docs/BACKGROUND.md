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

Even with 1–3 fixed, on **Node 26** writes still silently failed. The cause:

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
a fresh install the memory CLI uses **native** v12 and works. The buggy WASM path
remains for the deeper `agentdb` copies under `@claude-flow/cli`,
`@claude-flow/neural`, and `agentic-flow` (used by neural training, the
vector-unified mode, and swarm shared-memory). `ruflo-patch-native` brings those
to native v12 too.

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

All of the above are filed/summarized in
[ruvnet/ruflo#2219](https://github.com/ruvnet/ruflo/issues/2219).

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
   ran on WASM. `ruflo-patch-native` fixes it; it had simply been wiped by the
   upgrade to 3.10.5. This is the dominant lever.
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
which `ruflo-neural-train` does (writing `.claude-flow/neural/lora-delta.json`). The
footer shows `Δ` only when that cache exists.

### Self-improvement: route-learning persistence (F2) + the LoRA inference gap

A separate investigation asked whether ruflo is *self-improving*, not just self-learning.
We found the route Q-learner never persisted CLI feedback (`route feedback` never
`saveModel()`s; `autoSaveInterval:100`) — **this is now fixed upstream in ruflo 3.10.6
(#2222)** with an explicit `saveModel()` after feedback (@pacphi credited), so our
`ruflo-patch-route-learning` stopgap is **retired** (version-gated no-op on ≥3.10.6). A deeper
follow-up — `route feedback -r -1.0` parsed as +1.0, so negative feedback reinforced the bad
agent — was fixed in **3.10.7**. **Still open:** the trained LoRA/SONA is never consumed at
inference (no `predict`/`forward`; the matrix-LoRA `forward_array` has no decision-path
callers) — confirmed and deferred upstream in 3.10.9; and the state encoder collapses
keyword-distinct tasks (F3) — unaddressed upstream. `ruflo-improvement-eval` proves the route
learner self-improves significantly but modestly (held-out +16pp vs a no-learning ablation,
permutation p=0.004). Full writeup, the upstream reconciliation (3.10.6→3.10.9), and the
carry-forward scope:
[docs/upstream/ruflo-self-improvement-findings.md](upstream/ruflo-self-improvement-findings.md).

### Security surface

ruflo ships `@claude-flow/security` (3.0.0-alpha.8) and `@claude-flow/aidefence`
(3.0.3). `ruflo security defend` correctly **detects** prompt-injection (signals via
exit code: 1=threat, 0=clean) but has an upstream cosmetic crash after detection
(`Cannot read properties of undefined (reading 'color')`) — verdict/exit code are
still correct. `ruflo security cve --list` has **no CVE database configured**; use
`npm audit` for dependency CVEs. `ruflo-security-verify` checks all of this.
