# Self-Improvement Eval + RL Status-Line Telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SCOPE REVISED after the Tier-2 spike (see spec "Revised scope"):** Tier-2 (LoRA
> consumption) is infeasible as a patch → upstream issue only. This branch now ships
> **(1) the F2 fix** (route Q-learner CLI persistence — validated), **(2) a minimal
> in-process proof eval**, and **(3) docs + an upstream issue**. The `📈 RL` status-line
> telemetry is **dropped** (Task 5 below is replaced; there is no statusline change).

**Goal:** Fix F2 so ruflo's route Q-learner actually learns from real CLI feedback across invocations; prove the route Q-learner self-improves with a minimal in-process held-out/ablated experiment; and document the findings + file an upstream issue (F2 + the Tier-2 inference-seam gap).

**Architecture:** `bin/ruflo-patch-route-learning` idempotently patches the global ruflo dist (`q-learning-router.js` `autoSaveInterval: 100 → 1`) so single-update CLI `route feedback` calls persist (validated: 6 calls → updateCount 6, ε decayed). `bin/ruflo-improvement-eval` drives ruflo's *real* `createQLearningRouter` in **one process** over a synthetic-reward environment (task → known-best agent), measures cold→trained held-out accuracy with a no-learning ablation and academic stats (permutation p, Cohen's d), and separately verifies CLI feedback accumulates post-patch. No status-line changes.

**Tech Stack:** Node 20–26 (ESM), ruflo 3.10.5 (`@claude-flow/cli` → `dist/src/ruvector/index.js`), bash 3.2 (statusline patcher), `sqlite3` (existing footer reads). No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-28-self-improvement-eval-design.md`

**Conventions (match the kit):**
- Color/`ok()/warn()/fail()` helpers with TTY guard; `--help` via the `sed -n` idiom; exit codes `0` ok / `1` not-proven / `2` env error.
- **No `Co-Authored-By`** trailer (kit rule; `.claude/settings.json` has no `attribution.commit`).
- Resolve the router from the **global** install via `createRequire(npm root -g/...)`.
- Statusline edits go in the existing `ruflo-fix-statusline-version` heredoc (marker-guarded, upgrade-safe, shebang-safe insertion) — never rewrite ruflo's native lines.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `bin/ruflo-patch-route-learning` | Idempotent global-dist patch for F2 (`autoSaveInterval → 1`); verify CLI feedback accumulates | Create |
| `bin/ruflo-improvement-eval` | Node ESM harness: synthetic env + protocol + academic stats + writes `improvement.json`; `--cli-check` verifies F2 accumulation | Create |
| `shell/ruflo-functions.sh` | Wire `ruflo-patch-route-learning` into `ruflo-resync` (no statusline change) | Modify (`ruflo-resync`) |
| `install.sh` / `uninstall.sh` | Already derive bins from `bin/*` — **no change needed** (auto-picks up the new bins) | none |
| `docs/upstream/ruflo-self-improvement-findings.md` | Findings writeup + ready-to-file upstream issue (F2 + Tier-2 inference-seam gap) | Create |
| `claude/ruflo-reference.md` | Document `ruflo-improvement-eval` + `ruflo-patch-route-learning` + route-stats/F2 note | Modify |
| `README.md` | Add commands + the plain-language "three learning systems" primer | Modify |
| `docs/BACKGROUND.md` | Add the primer + finding F2 + the Tier-2 inference-seam finding | Modify |
| `docs/TROUBLESHOOTING.md` | "route stats stuck at 0 → ruflo-patch-route-learning" entry | Modify |

---

## Task 0: F2 fix — `bin/ruflo-patch-route-learning` (do this first)

**Files:** Create `bin/ruflo-patch-route-learning`

- [ ] **Step 1: Write the patch bin** (idempotent; sets `autoSaveInterval: 1` in the global router dist so CLI `route feedback` persists; verifies accumulation):

```bash
#!/usr/bin/env bash
# ruflo-patch-route-learning — make ruflo's route Q-learner persist CLI feedback.
# BUG (F2): route.js feedbackCommand calls update() but never saveModel(), and
# q-learning-router.js defaults autoSaveInterval:100 — so single-update CLI processes
# exit without saving and `route stats` is permanently 0/ε1.0. Setting autoSaveInterval:1
# makes every update persist (validated: 6 CLI feedback calls → updateCount 6, ε decayed).
# Idempotent; RE-RUN AFTER EVERY `npm install -g ruflo` upgrade (the upgrade restores 100).
#   ruflo-patch-route-learning [--check]
# Exit: 0 patched/already / 1 verify failed / 2 env error
set -u
MODE="apply"; [ "${1:-}" = "--check" ] && MODE="check"
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { sed -n '2,12p' "$0" | sed 's|^# \{0,1\}||'; exit 0; }
if [[ -t 1 ]]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'; C_R=$'\033[0m'; else C_OK=""; C_WARN=""; C_FAIL=""; C_R=""; fi
ok(){ printf '%s✓%s %s\n' "$C_OK" "$C_R" "$*"; }; warn(){ printf '%s⚠%s  %s\n' "$C_WARN" "$C_R" "$*"; }; fail(){ printf '%s✗%s %s\n' "$C_FAIL" "$C_R" "$*"; }
command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { fail "npm/node not on PATH"; exit 2; }
QL="$(npm root -g)/ruflo/node_modules/@claude-flow/cli/dist/src/ruvector/q-learning-router.js"
[ -f "$QL" ] || { fail "router not found: $QL"; exit 2; }
if grep -qE "autoSaveInterval: 1," "$QL"; then ok "route learner already persists every update (autoSaveInterval:1)"; exit 0; fi
if ! grep -qE "autoSaveInterval: 100," "$QL"; then warn "unexpected autoSaveInterval in $QL — review manually"; exit 1; fi
if [ "$MODE" = "check" ]; then warn "F2 present: autoSaveInterval:100 — CLI route feedback will not persist. Run without --check to fix."; exit 1; fi
node -e "const fs=require('fs');let s=fs.readFileSync('$QL','utf8');s=s.replace(/autoSaveInterval: 100,/,'autoSaveInterval: 1,');fs.writeFileSync('$QL',s);" \
  && ok "patched autoSaveInterval → 1 ($QL)" || { fail "patch failed"; exit 1; }
# verify accumulation across separate CLI processes
T=$(mktemp -d); ( cd "$T"; export CLAUDE_FLOW_DB_PATH="$T/.swarm/memory.db"; ruflo init --minimal --force >/dev/null 2>&1
  for i in 1 2 3; do ruflo route feedback -t "implement feature $i" -a coder -r 0.9 >/dev/null 2>&1; done )
uc=$( cd "$T"; CLAUDE_FLOW_DB_PATH="$T/.swarm/memory.db" ruflo route stats 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -iE "Update Count" | grep -oE '[0-9]+' | head -1 )
rm -rf "$T"
if [ "${uc:-0}" -ge 1 ] 2>/dev/null; then ok "verified: CLI route feedback now accumulates (Update Count=$uc). Re-run after every ruflo upgrade."; exit 0
else fail "patch applied but CLI feedback still not accumulating (Update Count=${uc:-0})"; exit 1; fi
```

- [ ] **Step 2: Make executable, check, apply, confirm idempotent**

```bash
chmod +x bin/ruflo-patch-route-learning
./bin/ruflo-patch-route-learning --check   # reports F2 (or already-fixed)
./bin/ruflo-patch-route-learning           # patches + verifies accumulation
./bin/ruflo-patch-route-learning           # second run: "already persists" (idempotent)
```
Expected: applies the patch, verifies Update Count ≥ 1 across CLI calls; second run is a no-op.

- [ ] **Step 3: Commit**

```bash
git add bin/ruflo-patch-route-learning
git commit -m "feat: ruflo-patch-route-learning — fix F2 so route Q-learner persists CLI feedback (autoSaveInterval:1)"
```

---

## Task 1: Harness skeleton — resolve ruflo's router, fail loudly if absent

**Files:**
- Create: `bin/ruflo-improvement-eval`

- [ ] **Step 1: Write the skeleton with router resolution + `--help`**

```javascript
#!/usr/bin/env node
//
// ruflo-improvement-eval — prove (or refute) that ruflo's route Q-learner self-improves.
//
// Runs IN ONE PROCESS against ruflo's real createQLearningRouter. (The CLI `route feedback`
// path cannot accumulate: autoSaveInterval=100 and feedback never calls saveModel — see
// docs/BACKGROUND.md.) Synthetic-reward env: each task has a known-best agent; reward = match.
// Measures cold-baseline vs trained held-out accuracy (greedy), with a no-update ablation and
// N seeds + CI. Writes .claude-flow/improvement.json and prints an ASCII learning curve.
//
// Usage:
//   ruflo-improvement-eval                 # default: 300 episodes, 5 seeds
//   ruflo-improvement-eval --episodes 300 --seeds 5 --checkpoints 0,25,50,100,200,300
//   ruflo-improvement-eval --smoke         # fast: 60 episodes, 3 seeds (mechanism check)
//   ruflo-improvement-eval --json          # machine-readable result to stdout
//   ruflo-improvement-eval --check         # print last cached improvement.json, no run
//   ruflo-improvement-eval --help
//
// Exit: 0 self-improvement demonstrated / 1 not demonstrated / 2 environment error
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };

if (has('-h') || has('--help')) {
  const src = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(2, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const C = process.stdout.isTTY
  ? { ok:'\x1b[32m', warn:'\x1b[33m', fail:'\x1b[31m', dim:'\x1b[2m', cyan:'\x1b[1;36m', r:'\x1b[0m' }
  : { ok:'', warn:'', fail:'', dim:'', cyan:'', r:'' };
const ok = (s) => console.log(`${C.ok}✓${C.r} ${s}`);
const fail = (s) => console.log(`${C.fail}✗${C.r} ${s}`);

function resolveRouterFactory() {
  let groot;
  try { groot = execSync('npm root -g', {stdio:['ignore','pipe','ignore']}).toString().trim(); }
  catch { return null; }
  const cliPkg = join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'package.json');
  if (!existsSync(cliPkg)) return null;
  try {
    const req = createRequire(cliPkg);
    return req.resolve('./dist/src/ruvector/index.js');
  } catch { return null; }
}

const routerIdx = resolveRouterFactory();
if (!routerIdx) {
  fail('Could not resolve ruflo\'s Q-learning router (@claude-flow/cli/dist/src/ruvector/index.js).');
  console.log('  Ensure ruflo is installed globally (npm i -g ruflo) and run from any directory.');
  process.exit(2);
}

const { createQLearningRouter } = await import(routerIdx);
ok(`router module resolved: ${routerIdx.replace(/.*node_modules\//, 'node_modules/')}`);
// (env + protocol added in later tasks)
```

- [ ] **Step 2: Make executable and verify resolution + failure path**

```bash
chmod +x bin/ruflo-improvement-eval
./bin/ruflo-improvement-eval --help          # prints usage block, exit 0
./bin/ruflo-improvement-eval                 # should print "router module resolved: ..."; exit 0 for now
echo "exit=$?"
```
Expected: `--help` shows usage; bare run prints the resolved module path. (If ruflo absent, exit 2 with guidance.)

- [ ] **Step 3: Commit**

```bash
git add bin/ruflo-improvement-eval
git commit -m "feat(eval): harness skeleton — resolve ruflo's Q-learning router in-process"
```

---

## Task 2: Synthetic environment + verify distinct states

**Files:**
- Modify: `bin/ruflo-improvement-eval` (append the environment + a state-distinctness check)

- [ ] **Step 1: Add the env and a `--probe-states` mode**

Append before the `// (env + protocol ...)` comment:

```javascript
// ── Synthetic-reward environment ───────────────────────────────────────────
// Each entry: a task phrasing + its known-best agent (must be one of ruflo's ROUTE_NAMES:
// coder, tester, reviewer, architect, researcher, optimizer, debugger, documenter).
// TRAIN and EVAL phrasings are DISJOINT strings that map to the SAME keyword-states, so a
// pass proves the router learned the state→agent mapping, not memorized exact strings.
const ENV = [
  { agent: 'tester',     train: 'write unit tests for the payment module',     evalq: 'create integration test coverage for billing' },
  { agent: 'coder',      train: 'implement the user authentication feature',   evalq: 'build the login signup code path' },
  { agent: 'reviewer',   train: 'review this pull request for issues',         evalq: 'audit and inspect the merge request' },
  { agent: 'architect',  train: 'design the system architecture and structure',evalq: 'plan the service design patterns' },
  { agent: 'debugger',   train: 'debug the failing error in checkout',         evalq: 'fix the bug causing the crash' },
  { agent: 'optimizer',  train: 'optimize the slow query performance',         evalq: 'improve memory and speed bottlenecks' },
  { agent: 'documenter', train: 'document the public API in the readme',       evalq: 'write docs and comments explaining usage' },
  { agent: 'researcher', train: 'research and investigate the best approach',  evalq: 'explore and find prior patterns' },
];
const REWARD_HIT = 1, REWARD_MISS = -1;

function probeStates() {
  const router = createQLearningRouter({ modelPath: '/tmp/.ruflo-eval-probe.json', autoSaveInterval: 1e9 });
  return router.initialize().then(() => {
    const states = new Set();
    for (const e of ENV) {
      // route returns the decision; we only need that distinct tasks → distinct internal states.
      // Train each once so a Q-entry is created, then read qTableSize growth per insert.
      const before = router.getStats().qTableSize;
      router.update(e.train, e.agent, REWARD_HIT);
      states.add(router.getStats().qTableSize);
    }
    return router.getStats().qTableSize;
  });
}

if (has('--probe-states')) {
  const n = await probeStates();
  console.log(`distinct Q-states for ${ENV.length} train tasks: ${n}`);
  process.exit(n >= ENV.length ? 0 : 1);
}
```

- [ ] **Step 2: Run the state probe — confirm each task is a distinct state (Q1 risk)**

```bash
./bin/ruflo-improvement-eval --probe-states
echo "exit=$?"
```
Expected: `distinct Q-states for 8 train tasks: 8` (exit 0). **If fewer than 8** (keyword collisions, spec Q1), edit the `train`/`evalq` phrasings to use more distinct `FEATURE_KEYWORDS` (see spec F3 list: implement/test/review/design/research/optimize/debug/document) until each task occupies its own state, then re-run. Do not proceed until this passes.

- [ ] **Step 3: Commit**

```bash
git add bin/ruflo-improvement-eval
git commit -m "feat(eval): synthetic-reward environment (task→known-best agent) + state-distinctness probe"
```

---

## Task 3: Core protocol — cold baseline, train, greedy held-out eval, ablation

**Files:**
- Modify: `bin/ruflo-improvement-eval`

- [ ] **Step 1: Add the experiment functions**

Append:

```javascript
// ── Decision helper: pick the router's greedy action for a task ─────────────
// route() returns a decision object; we extract the chosen agent id robustly across shapes.
function decide(router, task, explore) {
  const d = router.route ? router.route(task, explore) : router.selectAction(task, explore);
  return (d && (d.agent || d.action || d.route || d.selectedAgent)) || (typeof d === 'string' ? d : null);
}

// Greedy held-out accuracy: exploration OFF, NO updates. Returns fraction matching known-best.
function evalAccuracy(router) {
  let hit = 0;
  for (const e of ENV) if (decide(router, e.evalq, false) === e.agent) hit++;
  return hit / ENV.length;
}

// One training+measurement run for a given mode. Returns { curve:[{k,acc}], stats }.
async function runOnce({ episodes, checkpoints, ablation }) {
  const router = createQLearningRouter({ modelPath: '/tmp/.ruflo-eval-run.json', autoSaveInterval: 1e9 });
  await router.initialize();
  if (router.reset) router.reset();             // ensure cold start (ε=1, |Q|=0)
  const curve = [{ k: 0, acc: evalAccuracy(router) }];
  const cps = new Set(checkpoints);
  for (let k = 1; k <= episodes; k++) {
    const e = ENV[(k - 1) % ENV.length];
    const chosen = decide(router, e.train, true);          // explore during training
    if (!ablation) {                                       // ablation = decisions but NO learning
      const reward = chosen === e.agent ? REWARD_HIT : REWARD_MISS;
      router.update(e.train, chosen, reward);
    }
    if (cps.has(k)) curve.push({ k, acc: evalAccuracy(router) });
  }
  if (!cps.has(episodes)) curve.push({ k: episodes, acc: evalAccuracy(router) });
  const s = router.getStats();
  return { curve, stats: { epsilon: s.epsilon, tdError: s.avgTDError, qSize: s.qTableSize, updates: s.updateCount } };
}
```

> Note on `decide()`: the exact return shape of `router.route()` is confirmed during implementation — Step 2 prints one decision so you can adjust the property extraction if needed (the spec only guarantees a chosen agent is returned).

- [ ] **Step 2: Add a `--smoke` single-seed run and inspect a decision shape**

Append:

```javascript
const EPISODES = has('--smoke') ? 60 : parseInt(val('--episodes', '300'), 10);
const SEEDS = has('--smoke') ? 3 : parseInt(val('--seeds', '5'), 10);
const CHECKPOINTS = (val('--checkpoints', has('--smoke') ? '0,20,40,60' : '0,25,50,100,200,300'))
  .split(',').map(n => parseInt(n, 10)).filter(n => n <= EPISODES);

if (has('--inspect-decision')) {
  const r = createQLearningRouter({ modelPath: '/tmp/.ruflo-eval-x.json', autoSaveInterval: 1e9 });
  await r.initialize();
  console.log('raw decision:', JSON.stringify(r.route ? r.route(ENV[0].train, false) : r.selectAction(ENV[0].train, false)));
  process.exit(0);
}
```

```bash
./bin/ruflo-improvement-eval --inspect-decision
```
Expected: prints the router's raw decision object. **Confirm `decide()` extracts the agent id from this shape**; if the agent is under a different key, fix `decide()` accordingly, then continue.

- [ ] **Step 3: Commit**

```bash
git add bin/ruflo-improvement-eval
git commit -m "feat(eval): protocol — cold baseline, exploratory training, greedy held-out eval, ablation"
```

---

## Task 4: Multi-seed aggregation, CI, verdict, ASCII curve, result file

**Files:**
- Modify: `bin/ruflo-improvement-eval`

- [ ] **Step 1: Add aggregation + report + `improvement.json` writer**

Append:

```javascript
// ── Aggregate N seeds (router uses unseedable Math.random → average + 95% CI) ─
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function ci95(a) {                                  // half-width of 95% CI of the mean
  if (a.length < 2) return 0;
  const m = mean(a), v = mean(a.map(x => (x - m) ** 2)) * a.length / (a.length - 1);
  return 1.96 * Math.sqrt(v / a.length);
}
const spark = (xs) => { const b='▁▂▃▄▅▆▇█'; return xs.map(x => b[Math.min(7, Math.max(0, Math.round(x*7)))]).join(''); };

// ── Academically-grounded statistics (no external deps) ─────────────────────
function sampVar(a){ if(a.length<2) return 0; const m=mean(a); return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1); }
function cohensD(a, b){                                  // standardized mean difference (pooled SD), Cohen 1988
  const sp = Math.sqrt(((a.length-1)*sampVar(a) + (b.length-1)*sampVar(b)) / Math.max(1, a.length+b.length-2));
  return sp === 0 ? (mean(a) > mean(b) ? Infinity : 0) : (mean(a) - mean(b)) / sp;
}
function* combos(arr, k, start=0, acc=[]){ if(acc.length===k){ yield acc; return; } for(let i=start;i<arr.length;i++) yield* combos(arr,k,i+1,acc.concat(arr[i])); }
function permP(learn, abl){                              // one-sided permutation test: H0 = learning ≤ ablation
  const obs = mean(learn) - mean(abl), pool = learn.concat(abl), n = learn.length, idx=[...pool.keys()];
  let ge = 0, total = 0;
  if (pool.length <= 14) {                              // exact enumeration (≤3432 splits)
    for (const c of combos(idx, n)) { const set=new Set(c);
      const A=pool.filter((_,i)=>set.has(i)), B=pool.filter((_,i)=>!set.has(i));
      if (mean(A)-mean(B) >= obs - 1e-12) ge++; total++; }
  } else {                                              // Monte-Carlo (10k shuffles)
    total = 10000;
    for (let s=0;s<total;s++){ const sh=[...pool]; for(let i=sh.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[sh[i],sh[j]]=[sh[j],sh[i]];}
      if (mean(sh.slice(0,n))-mean(sh.slice(n)) >= obs - 1e-12) ge++; }
  }
  return ge/total;
}
function spearman(curve){                               // monotone-trend corroboration ρ(K, acc)
  const n=curve.length; if(n<3) return 0;
  const rank=(xs)=>{const s=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]); const r=Array(xs.length); s.forEach(([,i],j)=>r[i]=j+1); return r;};
  const rk=rank(curve.map(c=>c.k)), ra=rank(curve.map(c=>c.acc)), mr=(n+1)/2;
  let num=0,dk=0,da=0; for(let i=0;i<n;i++){num+=(rk[i]-mr)*(ra[i]-mr); dk+=(rk[i]-mr)**2; da+=(ra[i]-mr)**2;}
  return (dk&&da) ? num/Math.sqrt(dk*da) : 0;
}

if (!has('--check')) {
  const learnRuns = [], ablRuns = [];
  for (let s = 0; s < SEEDS; s++) learnRuns.push(await runOnce({ episodes: EPISODES, checkpoints: CHECKPOINTS, ablation: false }));
  for (let s = 0; s < SEEDS; s++) ablRuns.push(await runOnce({ episodes: EPISODES, checkpoints: CHECKPOINTS, ablation: true }));

  const ks = learnRuns[0].curve.map(p => p.k);
  const curveMean = ks.map((k, i) => ({ k, acc: mean(learnRuns.map(r => r.curve[i].acc)) }));
  const warmSeeds = learnRuns.map(r => r.curve[r.curve.length - 1].acc);
  const ablSeeds  = ablRuns.map(r => r.curve[r.curve.length - 1].acc);
  const coldAcc = curveMean[0].acc;
  const warmAcc = mean(warmSeeds);
  const warmCI  = ci95(warmSeeds);
  const ablAcc  = mean(ablSeeds);
  const chance  = 1 / ENV.length;
  const st = learnRuns[learnRuns.length - 1].stats;
  const deltaPP = Math.round((warmAcc - coldAcc) * 100);

  // ── Pre-registered, academically-grounded PASS criteria (this is an A/B experiment) ──
  //   1. Causal significance:  one-sided permutation test, learning vs no-learning ablation, p < 0.05
  //   2. Effect size:          Cohen's d ≥ 0.8 ("large", Cohen 1988)
  //   3. Above chance:         warm 95%-CI lower bound > 1/numActions
  //   Corroboration (reported, NOT gating): ε↓, δ̄↓, Spearman ρ(K,acc) > 0.
  const pValue = permP(warmSeeds, ablSeeds);
  const d = cohensD(warmSeeds, ablSeeds);
  const rho = spearman(curveMean);
  const aboveChance = (warmAcc - warmCI) > chance;
  const ALPHA = 0.05, D_MIN = 0.8;
  const verdict = (pValue < ALPHA && d >= D_MIN && aboveChance) ? 'PASS' : 'FAIL';

  const result = {
    curve: curveMean, coldAcc, warmAcc, deltaPP, ci95: Math.round(warmCI * 100),
    ablationAcc: ablAcc, chance, pValue: +pValue.toFixed(4), cohensD: (d===Infinity?999:+d.toFixed(2)),
    spearman: +rho.toFixed(2), aboveChance, alpha: ALPHA, dMin: D_MIN,
    epsilon0: 1.0, epsilonF: st.epsilon, tdError: st.tdError, qSize: st.qSize,
    episodes: EPISODES, seeds: SEEDS, verdict, ts: Math.floor(Date.now() / 1000),
  };

  mkdirSync('.claude-flow', { recursive: true });
  writeFileSync(join('.claude-flow', 'improvement.json'), JSON.stringify(result, null, 2));

  if (has('--json')) { console.log(JSON.stringify(result)); process.exit(verdict === 'PASS' ? 0 : 1); }

  console.log('');
  console.log(`${C.cyan}Self-improvement eval${C.r}  (route Q-learner · ${SEEDS} seeds × ${EPISODES} episodes · learning vs no-learning ablation)`);
  console.log(`  learning curve  ${spark(curveMean.map(p => p.acc))}  ${curveMean.map(p => `${p.k}:${Math.round(p.acc*100)}%`).join('  ')}`);
  console.log(`  held-out acc    cold ${Math.round(coldAcc*100)}% → warm ${Math.round(warmAcc*100)}%   Δ${deltaPP>=0?'+':''}${deltaPP}pp (95% CI ±${Math.round(warmCI*100)})`);
  console.log(`  ablation        ${Math.round(ablAcc*100)}%   ·   chance ${Math.round(chance*100)}%   ·   above-chance: ${aboveChance ? 'yes' : 'no'}`);
  console.log(`  significance    permutation p ${pValue < 0.001 ? '<0.001' : '='+pValue.toFixed(3)}   ·   Cohen's d ${d===Infinity?'∞':d.toFixed(2)}   ·   Spearman ρ(K,acc) ${rho.toFixed(2)}`);
  console.log(`  convergence     ε ${result.epsilon0}→${st.epsilon.toFixed(2)}   δ̄ ${st.tdError.toFixed(3)}   |Q| ${st.qSize}`);
  console.log('');
  verdict === 'PASS'
    ? ok(`SELF-IMPROVEMENT DEMONSTRATED — learning beat the no-learning ablation (p<${ALPHA}, d=${d===Infinity?'∞':d.toFixed(2)}), held-out +${deltaPP}pp, above chance. → .claude-flow/improvement.json`)
    : fail(`NOT demonstrated — fails the pre-registered test (p=${pValue.toFixed(3)}, d=${d===Infinity?'∞':d.toFixed(2)}, above-chance=${aboveChance}). Honest negative result → .claude-flow/improvement.json`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

// --check: print the last cached result
const p = join('.claude-flow', 'improvement.json');
if (!existsSync(p)) { console.log('No .claude-flow/improvement.json — run ruflo-improvement-eval first.'); process.exit(2); }
const r = JSON.parse(readFileSync(p, 'utf8'));
console.log(`${r.verdict}  ${spark(r.curve.map(c => c.acc))}  cold ${Math.round(r.coldAcc*100)}%→warm ${Math.round(r.warmAcc*100)}%  Δ${r.deltaPP}pp  p${r.pValue<0.001?'<.001':'='+r.pValue}  d=${r.cohensD}  ε→${r.epsilonF.toFixed(2)}  δ̄${r.tdError.toFixed(3)}  |Q|${r.qSize}`);
process.exit(r.verdict === 'PASS' ? 0 : 1);
```

- [ ] **Step 2: Run the smoke experiment end-to-end**

```bash
cd /tmp && rm -rf si-eval && mkdir si-eval && cd si-eval
"$OLDPWD/bin/ruflo-improvement-eval" --smoke ; echo "exit=$?"
cat .claude-flow/improvement.json | head -40
cd "$OLDPWD"
```
Expected: a printed learning curve, cold→warm accuracy, ablation %, convergence stats, a PASS/FAIL verdict, and a written `improvement.json`. If the curve does not rise (e.g., ε decays too slowly at K=60), bump `--episodes` and re-run; record the working smoke parameters. A FAIL with an honest negative result is an acceptable Step outcome — the mechanism (curve + ablation + file) must work, even if 60-episode smoke doesn't clear the PASS bar.

- [ ] **Step 3: Run the fuller experiment to get a real PASS (if smoke was short)**

```bash
cd /tmp/si-eval && "$OLDPWD/bin/ruflo-improvement-eval" --episodes 600 --seeds 5 ; echo "exit=$?" ; cd "$OLDPWD"
```
Expected: with enough episodes the warm held-out accuracy clears the PASS bar and beats the ablation. Capture the numbers for the docs. (If even 600 episodes can't clear +20pp/0.60, lower nothing silently — instead record the achieved delta honestly and note it in the docs; the proof is the *gap vs ablation*, not a fixed threshold.)

- [ ] **Step 4: Commit**

```bash
git add bin/ruflo-improvement-eval
git commit -m "feat(eval): multi-seed aggregation + CI + verdict + ASCII learning curve + improvement.json"
```

---

## Task 5: Status-line `📈 RL` telemetry segment

**Files:**
- Modify: `shell/ruflo-functions.sh` (the `rufloActivationSegments` helper inside the `ruflo-fix-statusline-version` heredoc)

- [ ] **Step 1: Add the RL line to the footer helper**

In `shell/ruflo-functions.sh`, inside the heredoc helper (after the agentic-qe `qe` block, before the `// ── assemble` block), insert a new segment that reads `improvement.json`:

```javascript
    // ── self-improvement (📈 RL): rendered from .claude-flow/improvement.json (written by
    // ruflo-improvement-eval). NEVER sourced from `route stats` (CLI persistence is broken).
    var rl = "";
    try {
      var ip = path.join(cwd, ".claude-flow", "improvement.json");
      if (fs.existsSync(ip)) {
        var m = JSON.parse(fs.readFileSync(ip, "utf8"));
        var spk = (m.curve || []).map(function(c){ var b="▁▂▃▄▅▆▇█"; return b[Math.min(7, Math.max(0, Math.round((c.acc||0)*7)))]; }).join("");
        var tag = m.verdict === "PASS" ? (G + "📈 RL" + R) : (DIM + "◷ RL" + R);
        var parts = [];
        if (spk) parts.push(spk);
        if (typeof m.coldAcc === "number") parts.push("acc " + Math.round(m.coldAcc*100) + "%→" + Math.round(m.warmAcc*100) + "%");
        if (typeof m.deltaPP === "number") parts.push("Δ" + (m.deltaPP>=0?"+":"") + m.deltaPP + "pp" + (typeof m.ci95==="number" ? " (CI±" + m.ci95 + ")" : ""));
        if (typeof m.pValue === "number") parts.push("p" + (m.pValue<0.001 ? "<.001" : "=" + m.pValue));
        if (typeof m.cohensD === "number") parts.push("d=" + (m.cohensD>=999?"∞":m.cohensD));
        if (typeof m.epsilonF === "number") parts.push("ε" + m.epsilonF.toFixed(2) + "↓");
        if (typeof m.tdError === "number") parts.push("δ̄" + m.tdError.toFixed(2) + "↓");
        if (typeof m.qSize === "number") parts.push("|Q|" + m.qSize);
        rl = tag + "  " + parts.join(DIM + " · " + R);
      }
    } catch(e){}
```

Then in the `// ── assemble` block, add `rl` as its own line. Change the assembly to:

```javascript
    var l1 = []; if (learn) l1.push(learn); if (sec) l1.push(sec);
    var out = [];
    if (l1.length) out.push(l1.join("      "));
    if (qe) out.push(qe);
    if (rl) out.push(rl);
    if (!out.length) return "";
    return "\n" + DIM + "─".repeat(44) + R + "\n" + out.join("\n");
```

- [ ] **Step 2: Verify the RL line renders from a synthetic result file**

```bash
cd /tmp && rm -rf rl-sl && mkdir -p rl-sl/.claude-flow rl-sl/.claude/helpers && cd rl-sl
cat > .claude-flow/improvement.json <<'JSON'
{"curve":[{"k":0,"acc":0.12},{"k":50,"acc":0.4},{"k":100,"acc":0.62},{"k":300,"acc":0.78}],
 "coldAcc":0.12,"warmAcc":0.78,"deltaPP":66,"ci95":7,"pValue":0.0009,"cohensD":2.1,
 "epsilonF":0.12,"tdError":0.01,"qSize":8,"verdict":"PASS"}
JSON
cp "$OLDPWD/.claude/helpers/statusline.cjs" .claude/helpers/ 2>/dev/null || ruflo init --minimal --force >/dev/null 2>&1
source "$OLDPWD/shell/ruflo-functions.sh"
ruflo-fix-statusline-version .claude/helpers/statusline.cjs >/dev/null 2>&1
node .claude/helpers/statusline.cjs <<<'{}' 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | tail -3
cd "$OLDPWD" && rm -rf /tmp/rl-sl
```
Expected last line resembles: `📈 RL  ▁▃▅▇  acc 12%→78%  Δ+66pp (CI±7) · p<.001 · d=2.1 · ε0.12↓ · δ̄0.01↓ · |Q|8` (add `"pValue":0.0009,"cohensD":2.1` to the synthetic JSON to see `p`/`d`). With no `improvement.json`, the line must be absent (verify by removing the file and re-rendering).

- [ ] **Step 3: Verify idempotency (re-apply twice, one block)**

```bash
cd /tmp && rm -rf rl-idem && mkdir -p rl-idem/.claude/helpers && cd rl-idem
ruflo init --minimal --force >/dev/null 2>&1
source "$OLDPWD/shell/ruflo-functions.sh"
ruflo-fix-statusline-version .claude/helpers/statusline.cjs >/dev/null 2>&1
ruflo-fix-statusline-version .claude/helpers/statusline.cjs >/dev/null 2>&1
echo "seg blocks: $(grep -c 'ruflo-seg:BEGIN' .claude/helpers/statusline.cjs)  wraps: $(grep -c 'rufloActivationSegments(process.cwd())' .claude/helpers/statusline.cjs)"
cd "$OLDPWD" && rm -rf /tmp/rl-idem
```
Expected: `seg blocks: 1  wraps: 1`.

- [ ] **Step 4: Apply to this session's live statusline + run the real eval here**

```bash
cd /Users/cphillipson/Development/active/ai/ruflo-machine-ref
source shell/ruflo-functions.sh
./bin/ruflo-improvement-eval --smoke         # writes ./.claude-flow/improvement.json for THIS repo
ruflo-fix-statusline-version .claude/helpers/statusline.cjs >/dev/null 2>&1
node .claude/helpers/statusline.cjs <<<'{}' 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | tail -4
```
Expected: the live footer now includes the `📈 RL` (or `◷ RL` if smoke didn't clear the bar) line.

- [ ] **Step 5: Commit**

```bash
git add shell/ruflo-functions.sh
git commit -m "feat(statusline): 📈 RL telemetry line — learning-curve sparkline + held-out acc + Δpp/CI + ε/δ̄/|Q| from improvement.json"
```

---

## Task 6: Documentation — primer, command, finding F2, Tier-2, troubleshooting

**Files:**
- Modify: `README.md`, `claude/ruflo-reference.md`, `docs/BACKGROUND.md`, `docs/TROUBLESHOOTING.md`

- [ ] **Step 1: README — add the command, the `📈 RL` mockup, and the plain-language primer**

In the commands table add:
```
| 📈 `ruflo-improvement-eval [--smoke\|--json\|--check]` | In-process held-out/ablated/multi-seed proof that the route Q-learner self-improves; writes `.claude-flow/improvement.json` and drives the status line's `📈 RL` line. |
```
Add a new section `## 🧠 Is it actually learning *and* improving?` containing the plain-language primer copied from the spec's §0 (the delivery-company analogy, the three systems with ε/TD/|Q|/Δ-LoRA, the two-loops table, and the "why it's worth it without Tier-2" paragraph). Add the `📈 RL` line to the status-line mockup.

- [ ] **Step 2: BACKGROUND.md — add the primer + finding F2 + Tier-2**

Append a section `## Proving self-improvement (and what it doesn't cover)` that: (a) includes the §0 primer; (b) documents **F2** — the CLI `route feedback` non-persistence bug (`q-learning-router.js` `autoSaveInterval:100`; `route.js` `feedbackCommand` never calls `saveModel()`), with the one-line fix (call `saveModel()` after `update()` or set `autoSaveInterval:1`), and that this is why `route stats` reads `0/ε1.0` and why the eval runs in-process; (c) states Tier-2 (consume the LoRA `B` at inference) is required to prove the SONA/LoRA path and is an upstream change.

- [ ] **Step 3: ruflo-reference.md — command + route-stats correction**

In the self-learning section, add `ruflo-improvement-eval` to the workflow and the decision tree (`Prove self-improvement → ruflo-improvement-eval`). Add one line: "The status line's `📈 RL` data comes from the in-process eval, **not** `route stats` (its CLI path can't persist — always shows `0/ε1.0`)."

- [ ] **Step 4: TROUBLESHOOTING.md — two entries**

Add:
```
### `📈 RL` line missing or shows `◷ RL unproven`
The eval hasn't run, or didn't clear the PASS bar. Run `ruflo-improvement-eval` (or
`--smoke`); it writes `.claude-flow/improvement.json` which the footer renders. A `◷`
verdict is an honest negative result, not a bug.

### `ruflo route stats` is stuck at `Update Count 0 / Epsilon 1.0`
Known ruflo bug: `route feedback` applies one update per process but never persists it
(`autoSaveInterval:100`, no `saveModel()`), so CLI-driven route learning can't accumulate.
This is why the kit measures self-improvement in-process (`ruflo-improvement-eval`) and
never sources status-line signals from `route stats`.
```

- [ ] **Step 5: Commit**

```bash
git add README.md claude/ruflo-reference.md docs/BACKGROUND.md docs/TROUBLESHOOTING.md
git commit -m "docs: self-improvement primer, ruflo-improvement-eval, finding F2 (route feedback bug), Tier-2 + 📈 RL"
```

---

## Self-Review (completed during planning)

**Spec coverage:** R1–R8 (harness) → Tasks 1–4; R9–R10 (📈 RL line) → Task 5; R11 (no route-stats source) → Task 5 Step 1 comment + Task 6 Steps 3–4; R12 (scope honesty) → Task 6 primer/Tier-2; R13 (F2 bug) → Task 6 Step 2 + TROUBLESHOOTING; R14 (bash 3.2 / graceful Node failure) → Task 1 exit-2 path + Task 5 fs-only segment; G4 (academic telemetry) → Task 4 report + Task 5 line. §0 primer → Task 6. No uncovered requirement.

**Placeholder scan:** No "TBD"/"handle edge cases". The two `--inspect-decision`/`--probe-states` steps are concrete de-risking probes with explicit pass conditions and fix instructions, not deferrals. The one genuine runtime unknown — `router.route()`'s exact return shape — is handled by a defensive `decide()` extractor plus an inspection step that prints the real shape before relying on it.

**Type/name consistency:** `createQLearningRouter`, `router.initialize()/route()/update()/getStats()/reset()`, stat fields (`epsilon`, `avgTDError`, `qTableSize`, `updateCount`), and `improvement.json` keys (`curve`, `coldAcc`, `warmAcc`, `deltaPP`, `ci95`, `epsilonF`, `tdError`, `qSize`, `verdict`) are used identically across the harness (Tasks 1–4) and the statusline renderer (Task 5). `--smoke/--episodes/--seeds/--checkpoints/--json/--check` flags consistent.

**Known runtime risks (flagged in-task, not placeholders):** (Q1) state collisions → Task 2 Step 2 gate; (Q2) slow ε decay needing more episodes → Task 4 Steps 2–3; decision-shape → Task 3 Step 2 inspection.
