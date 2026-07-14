# Design: Self-learning activation, agentic-qe opt-in, and security enablement for the ruflo machine kit

- **Status:** Draft (awaiting user review)
- **Branch:** `explore/ruvector-self-learning-aqe`
- **Date:** 2026-05-28
- **Author:** Chris Phillipson (with Claude)

## 1. Problem

`ruflo-machine-ref` is a machine-wide kit that fixes ruflo's **memory persistence**
on modern Node (the better-sqlite3 / WASM / WAL family of bugs). It does **not**
yet enable or verify ruflo's **self-learning** stack (ruvector: SONA, ReasoningBank,
HNSW, GNN), it does not integrate the separately-installed `agentic-qe`, and it
treats ruflo's built-in **security** surface as undocumented and unverified.

A colleague's gist by Ciprian Melian
(<https://gist.github.com/ciprianmelian/eb7e8ff7d24018141ca34bb8a7e216a6>,
project-scoped, written against ruflo ~3.6) documents a 5-script kit that patches
`controller-registry.js`, integrates agentic-qe
(<https://github.com/proffesor-for-testing/agentic-qe>), and verifies ruvector
binaries. This design absorbs the *still-relevant* ideas from that gist
into this kit's **global-install-once** philosophy, while explicitly rejecting the
parts that are now obsolete.

### 1.1 Confirmed diagnosis (ruflo 3.10.5, Node 26.2.0 / ABI 147, darwin-arm64)

Verified live on this machine:

| Observation | Evidence | Meaning |
|---|---|---|
| agentdb resolves to **v3.0.0-alpha.14** | `require.resolve('agentdb', …)` from `@claude-flow/memory` | The gist's "force ≥3.x" patch is **already upstream**; not needed. |
| `#1492` ESM `require`→`import('node:path')` fix present | `controller-registry.js:313-315` | Gist's ESM-path patch is **already upstream**; not needed. |
| ReasoningBank already receives an `embedder` | `controller-registry.js:655-656` | Gist's "missing embedder arg" patch is **already upstream**; not needed. |
| **`better-sqlite3` is v12.10.0 but `native: false`** in **all 6** agentdb dirs | `ruflo-patch-native --check` | **Active root cause.** Prebuilt `.node` never fetched → agentdb falls back to sql.js WASM. |
| `ruflo neural status`: "Using sql.js (WASM)", HNSW "Not loaded — @ruvector/core not available", ReasoningBank "Empty", SONA/RuVector "Not loaded" | `ruflo neural status` | Self-learning is **dormant**, downstream of the WASM fallback. |
| `@ruvector/core`, `/sona`, `/gnn`, `/rvf-node` all **resolve** from their proper module paths; native `.node` binaries for darwin-arm64 **present on disk** | `require.resolve` + `find … *.node` | Ruvector is **installed correctly**; "not available" is suspected to be a *downstream* symptom of the WASM fallback, to be re-verified empirically after the patch. |
| `ruflo security cve --list` → "No CVE database configured" | CLI output | Real upstream gap to **document**, not fix. |

**Core insight:** The gist's `controller-registry.js` patches are largely obsolete on
3.10.5. The dominant live bug is the **missing native better-sqlite3 binary**, which
this kit's existing `ruflo-patch-native` already fixes — but it was not applied to
this install (the upgrade to 3.10.5 wiped it, exactly as the script header warns).
The work is therefore: **make the global fix stick, verify self-learning truly
activates, then add the genuinely-missing pieces.**

## 2. Goals / Non-goals

**Goals**
- G1. Make ruvector self-learning (SONA, ReasoningBank, HNSW) measurably *active* on a
  global ruflo install, at the machine layer, surviving upgrades via a documented
  re-run step.
- G2. Add a verification helper that proves the learning loop works end-to-end
  (train/store → pattern count > 0), not merely that modules report "Active".
- G3. Add an **opt-in** agentic-qe setup helper with half-init repair.
- G4. Verify, activate, and document ruflo's built-in security surface
  (`security scan/defend/audit/secrets/threats/cve`, `@claude-flow/aidefence`),
  including the proactive (prompt-injection/PII) defense path and the CVE-source gap.
- G5. Keep all docs / the machine-wide CLAUDE.md reference truthful to the corrected
  diagnosis.
- G6. Surface live activation state in the Claude Code **status line**: when
  self-learning, security, and agentic-qe are each active, show a corresponding
  indicator (with counts where meaningful), so a glance confirms what's enabled.
- G7. Make re-application after a ruflo / agentic-qe upgrade a **single command**
  (`ruflo-resync`), since upgrades wipe the native binaries and regenerate the
  statusline. Re-applying must never be a multi-step chore.

**Non-goals**
- N1. Do **not** re-port the gist's obsolete `controller-registry.js` patches.
- N2. Do **not** fold agentic-qe into the default project setup.
- N3. Do **not** build a CVE database / NVD integration (document the gap only).
- N4. No changes to ruflo's published source; only user-scope node_modules patching
  (as `ruflo-patch-native` already does) and kit-local scripts/docs.

## 3. Architecture

The kit keeps its two existing layers and adds verification + opt-in modules. All new
logic lives in `shell/ruflo-functions.sh` (shell helpers) and `bin/` (standalone
executables), consistent with the current structure.

```
Machine layer  (once per machine / per ruflo upgrade)
  ├─ ruflo-patch-native           [EXISTING] native better-sqlite3 in 6 agentdb dirs
  ├─ ruflo-enable-learning        [NEW] patch-native → activate → assert ruvector live
  ├─ ruflo-resync                 [NEW] one command: re-apply ALL of the above + statusline
  │                                  after a ruflo / agentic-qe upgrade (--aqe refreshes skills)
  └─ ruflo-setup-machine          [EXISTING] register MCP at user scope

Verification layer  (read-mostly, idempotent)
  ├─ ruflo-parity-test            [EXISTING] memory persistence smoke test
  ├─ ruflo-learning-verify        [NEW] train/store cycle → assert patterns > 0
  └─ ruflo-security-verify        [NEW] scan/defend/aidefence load + run; report gaps

Project layer  (per repo)
  ├─ ruflo-setup-project          [EXISTING] init + pin DB + activate + verify
  │                                  + optional --with-security pass [NEW]
  └─ ruflo-setup-aqe              [NEW, opt-in] aqe init --auto + half-init repair

Presentation layer  (status line, all projects)
  └─ ruflo-fix-statusline         [EXTENDED] heal version [EXISTING] +
                                    activation indicators for self-learning,
                                    security, agentic-qe [NEW]
```

### 3.1 Component contracts

Each new unit has one purpose, a defined interface, and stated dependencies.

**`ruflo-enable-learning`** (new bin or function)
- *Does:* Run `ruflo-patch-native`; then probe `ruflo neural status` and
  `ruflo hooks intelligence --status`; assert the previously-dormant controllers
  (native bsq3, HNSW, SONA, ReasoningBank backend) are now loaded. If still dormant,
  invoke the diagnose-then-fix path (R6).
- *Input:* none (operates on the global install). `--check` for report-only.
- *Output:* green/red activation table; exit 0 all-green, 1 otherwise.
- *Depends on:* `ruflo-patch-native`, `ruflo`, `node`.

**`ruflo-learning-verify`** (new)
- *Does:* In an isolated `/tmp` dir (like `ruflo-parity-test`), run a minimal real
  learning cycle — `ruflo neural train` and/or a ReasoningBank/SONA write — then
  assert pattern/trajectory count transitions from 0 → >0 and persists on disk.
- *Input:* none; `--keep` to retain the temp dir for inspection.
- *Output:* PASS/FAIL with the observed counts.
- *Depends on:* native backend active (run after `ruflo-enable-learning`).

**`ruflo-setup-aqe`** (new, opt-in)
- *Does:* `aqe init --auto`; verify **both** `.agentic-qe/memory.db` **and** the
  `.claude/skills/agentic-quality-engineering` marker exist; if marker missing,
  re-run `aqe init --auto --upgrade` (half-init repair from the gist).
- *Input:* runs in cwd (the target repo); `--force` to reinitialize.
- *Output:* skills/agents/commands installed count; verification result.
- *Depends on:* global `aqe` binary (fallback `npx -y agentic-qe@latest`).

**`ruflo-fix-statusline`** (extends existing `ruflo-fix-statusline-version`)
- *Does:* Keeps the existing live-version heal, and adds activation segments to the
  generated `statusline.cjs`: a self-learning indicator (e.g. `🧠 N patterns` when
  ReasoningBank/SONA active, dimmed/absent when dormant), a security indicator
  (e.g. `🛡 on` when aidefence/security loaded), and an agentic-qe indicator
  (e.g. `🎓 N patterns` reading `.agentic-qe/memory.db` when present). Each segment
  renders only when its feature is actually active — the status line is the
  at-a-glance proof of activation.
- *Input:* optional statusline path; runs inside `ruflo-setup-project`.
- *Output:* patched `statusline.cjs`; a one-line preview of the rendered status.
- *Depends on:* `node`, `sqlite3` (for reading the two memory DBs), `ruflo`.
- *Idempotent:* guarded by markers; re-applied on every setup so each ruflo upgrade
  self-heals (same pattern as the current version-heal).

**`ruflo-security-verify`** (new)
- *Does:* Confirm `@claude-flow/security` + `@claude-flow/aidefence` load; run
  `ruflo security scan` (code+deps), `ruflo security defend -i "<injection sample>"`
  (proactive defense), `ruflo security secrets`; surface the `cve --list`
  "no database" gap and recommend `npm audit` as the dependency-CVE source.
- *Input:* runs in cwd; `--quick` to skip the full scan.
- *Output:* per-capability OK/GAP table.
- *Depends on:* `ruflo`, `npm` (for the audit fallback).

### 3.2 Data flow (self-learning activation)

```
upgrade ruflo ──► binaries present, bsq3 .node MISSING ──► agentdb=WASM ──► learning dormant
                                   │
                ruflo-enable-learning
                                   ▼
        ruflo-patch-native (install bsq3@^12 → fetch prebuilt .node ×6)
                                   ▼
            agentdb = native better-sqlite3
                                   ▼
   probe neural status ── all green? ──► done
                          │
                          └─ still dormant ──► R6 diagnose-then-fix
                                                 (instrument native load path,
                                                  find dlopen/ABI/guard cause,
                                                  add targeted fix in-branch)
                                   ▼
            ruflo-learning-verify (train/store → patterns >0)  ──► PASS
```

## 4. Requirements

### Self-learning
- **R1.** `ruflo-enable-learning` MUST run `ruflo-patch-native` and then assert, by
  parsing `ruflo neural status`, that the native SQLite backend is in use (no
  "Using sql.js (WASM)") and that HNSW, SONA, and ReasoningBank are loaded.
- **R2.** `ruflo-enable-learning --check` MUST report current activation state and
  change nothing.
- **R3.** `ruflo-learning-verify` MUST perform a real train/store cycle and assert a
  pattern/trajectory count transition from 0 to >0, persisted to disk (native query,
  not CLI self-report), mirroring how `ruflo-setup-project` verifies memory writes.
- **R4.** Both helpers MUST be idempotent and safe to re-run.
- **R5.** Docs MUST state the re-run-after-upgrade requirement (patch is wiped by
  `npm install -g ruflo@latest`), reusing the existing convention.
- **R6.** If, after `ruflo-patch-native`, ruvector HNSW/SONA remain dormant, the branch
  MUST include an empirical diagnose-then-fix step: instrument the native module load
  path, identify the real failure (resolution path vs. dlopen/ABI vs. internal guard),
  and add a targeted, idempotent corrective patch at the global layer. The fix MUST be
  guarded so it no-ops once upstream resolves it.

### agentic-qe
- **R7.** `ruflo-setup-aqe` MUST be opt-in (never invoked by `ruflo-setup-project`
  by default).
- **R8.** It MUST detect and repair the half-init state (SDK DB present, project
  marker absent) by re-running `aqe init --auto --upgrade`.
- **R9.** It MUST prefer a global `aqe` binary and fall back to `npx -y agentic-qe@latest`.

### Security
- **R10.** `ruflo-security-verify` MUST confirm `@claude-flow/security` and
  `@claude-flow/aidefence` load and that `security scan`, `security defend`, and
  `security secrets` run.
- **R11.** It MUST exercise the **proactive** defense path (`security defend` on a
  prompt-injection sample) and report a detection verdict.
- **R12.** It MUST document the `cve --list` "no database configured" gap and present
  `npm audit` as the supported dependency-CVE source.
- **R13.** `ruflo-setup-project --with-security` MUST run a security pass during setup;
  without the flag, setup behavior is unchanged.

### Status line
> **Decision (revised after review):** the status line uses an **append-only** design
> — a footer added *below* ruflo's native render — NOT an in-place rewrite of ruflo's
> own lines. This was chosen over a faithful gist-style rewrite for upgrade-robustness:
> appending cannot break when ruflo changes its statusline template. The footer is two
> labeled lines (richer than the initial single-line minimal form).

- **R16.** The generated `statusline.cjs` MUST append a self-learning line when SONA is
  active, showing real counts read from `.claude-flow/neural/stats.json`
  (`🧠 SONA [bar] <patterns> · <traj>`), a `[bar]` volume gauge (~10 patterns/dot), and an
  `⚡ HNSW` marker only when a vector index (`.swarm/hnsw.index`) exists. Omitted
  entirely when no learning has occurred. The agentic-qe line MUST be icon-tagged
  (`🎓 patterns · 🧭 traj · 🧬 vec⚡ · 💾 size`). It MUST NOT repeat the git branch —
  ruflo's native header line already shows it.
- **R16a.** (Superseded 2026-06-01.) The footer MUST NOT show a `Δ LoRA` field while the
  matrix-LoRA path is inert upstream (ruvnet/RuVector#519: `processInstantLearning` is a
  no-op stub, the trained delta is never consumed in a decision, `deltaNorm` stays 0). A
  value that changes no decision is not an improvement signal. The earlier requirement —
  a `ruflo-neural-train` wrapper capturing the transient delta — is withdrawn; re-introduce
  both the field and the capture only after #519 closes and the delta provably moves.
  (Tracked in issue #8 / F4.)
- **R16b.** The footer MUST append a route Q-learner line (`📈 RL ε↓ · δ̄↓ · |Q| · upd`)
  when the learner has actually run, read fs-only from `.swarm/q-learning-model.json`
  (fallback `.claude-flow/metrics/learning.json` `routing.{accuracy,decisions}`), never the
  broken `route stats` CLI. Honesty-gated: rendered only when `updateCount > 0` (or
  `decisions > 0`), omitted otherwise. `|Q|` is a real task-state count since the encoder
  fix (ruflo #2239 / F3).
- **R17.** It MUST append a security segment (`🛡 aidefence on`) when
  `@claude-flow/aidefence` is loaded, and a separate agentic-qe line
  (`🎓 Agentic QE <patterns>[· traj][· vec] · <size>`, a few guarded `sqlite3` reads of
  `.agentic-qe/memory.db`; the `vec` count reads `qe_pattern_embeddings` and falls back
  to `vectors`/`embeddings` across aqe versions) when AQE is initialized in the project. The security segment
  is purely additive — ruflo's native render already shows `CVE n/m`, so `🛡` signals
  the distinct fact that proactive defense is loaded.
- **R18.** Status-line patching MUST be append-only (never rewrite ruflo's native
  lines), idempotent, and **upgrade-safe**: the injector MUST strip any prior block
  (legacy single-line marker or the `ruflo-seg:BEGIN/END` block) and the prior
  `console.log` wrap, then re-inject — so re-running after a ruflo upgrade replaces a
  stale helper rather than duplicating or skipping it. Each segment renders only when
  its feature is genuinely active (no false positives). Self-learning + security are
  `fs`-only; the agentic-qe line's single `sqlite3` call is gated behind a file-exists
  check so it costs nothing when AQE is absent.

### Re-apply after upgrade
- **R19.** A single command (`ruflo-resync`) MUST re-apply everything that a
  `npm install -g ruflo@latest` or `agentic-qe@latest` upgrade wipes — native
  better-sqlite3 for ruflo's agentdb (via `ruflo-enable-learning`), native
  better-sqlite3 for the global agentic-qe (shared `_ruflo_aqe_ensure_native` helper),
  and the statusline version-pin + activation footer for the current project. An opt-in
  `--aqe` flag MAY additionally refresh agentic-qe skills (`aqe init --auto --upgrade`).
  It MUST be idempotent and documented as THE post-upgrade step.

### Compatibility / safety
- **R14.** The kit MUST NOT apply the gist's `controller-registry.js` patches on a
  ruflo version where they are already upstream (≥3.10.x verified). A guarded
  compatibility check MAY apply a corrective patch only if it detects a regression
  (agentdb resolving <3.0, or ReasoningBank constructed without an embedder).
- **R15.** All new scripts MUST be bash 3.2-compatible (macOS `/bin/bash`) and degrade
  gracefully when `sqlite3`/`claude`/`aqe` are absent, matching existing helpers.

## 5. Behavioral scenarios

- **S1 (happy path):** Fresh 3.10.5 install, learning dormant. `ruflo-enable-learning`
  → patch-native fetches 6 native binaries → `neural status` shows native + HNSW/SONA
  loaded → `ruflo-learning-verify` trains and asserts patterns 0→N. All green.
- **S2 (already patched):** Re-running `ruflo-enable-learning` finds all 6 native,
  asserts green, no-ops the install step.
- **S3 (post-upgrade regression):** After `npm install -g ruflo@latest`,
  `ruflo-enable-learning --check` reports WASM fallback returned; full run re-patches.
- **S4 (ruvector still dormant):** patch-native completes but HNSW still
  "core not available" → R6 path triggers; branch gains a targeted fix; verify re-runs.
- **S5 (aqe half-init):** `.agentic-qe/memory.db` exists but marker missing →
  `ruflo-setup-aqe` re-runs with `--upgrade`; marker appears; skills installed.
- **S6 (security):** `ruflo-security-verify` → scan OK, defend flags an injection
  sample, secrets OK, `cve` reported as GAP with `npm audit` guidance.
- **S8 (status line reflects activation):** Before enablement the status line shows
  no learning/security/AQE segments. After `ruflo-enable-learning` + `--with-security`
  + `ruflo-setup-aqe`, the status line shows `🧠 N patterns  🛡 on  🎓 M patterns`
  alongside the live version — a glance confirms all three are active.
- **S7 (old ruflo):** On a hypothetical <3.10 install where agentdb resolves <3.0, the
  guarded compatibility check (R14) applies the corrective patch; on 3.10.5 it no-ops.

## 6. Testing

- Extend the existing isolated-temp-dir pattern from `ruflo-parity-test`.
- `ruflo-learning-verify` is itself the self-learning test (R3).
- `ruflo-security-verify` is the security test (R10–R12).
- Manual acceptance on this machine: before/after `ruflo neural status` diff captured
  in the branch (the "lights up" proof the user asked to see is deferred to
  implementation, since this phase is design-only).

## 7. Open questions / risks

- **Q1.** Root cause of "@ruvector/core not available" if it survives patch-native is
  unknown until tested (R6 covers it). Risk: could be an upstream load bug needing a
  heavier fix than a one-line patch — may extend branch scope (user accepted this).
- **Q2.** `aqe init --auto` mutates the target repo's `CLAUDE.md` and adds 100+ skills;
  keeping it opt-in contains blast radius (R7).
- **Q3.** `security defend` sample text must be benign-but-detectable; choose a
  well-known injection string to avoid false "clean" results.

## 8. Out of scope (tracked for later)

- NVD/CVE database integration.
- Folding agentic-qe into default setup.
