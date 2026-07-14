#!/usr/bin/env node
//
// ruflo-improvement-eval — prove (or honestly refute) that ruflo's route Q-learner self-improves.
//
// Runs IN ONE PROCESS against ruflo's real createQLearningRouter (the CLI `route feedback`
// path can't accumulate without ruflo-patch-route-learning — finding F2). Synthetic-reward
// environment: each task has a known-best agent; reward = match. Measures cold-baseline vs
// trained held-out accuracy (greedy, no updates) with a no-learning ablation control and N
// seeds, then computes an academically-grounded verdict (one-sided permutation test p +
// Cohen's d + above-chance). Writes .claude-flow/improvement.json and prints the result.
//
// Usage:
//   ruflo-improvement-eval                 # default: 300 episodes, 5 seeds
//   ruflo-improvement-eval --smoke         # fast: 120 episodes, 3 seeds (mechanism check)
//   ruflo-improvement-eval --episodes N --seeds M --checkpoints 0,25,50,...
//   ruflo-improvement-eval --json          # machine-readable result to stdout
//   ruflo-improvement-eval --check         # print last cached improvement.json, no run
//   ruflo-improvement-eval --cli-check     # verify CLI feedback persists (F2 fix applied?)
//   ruflo-improvement-eval --probe-states  # assert each task maps to a distinct Q-state
//   ruflo-improvement-eval --inspect-decision   # print one raw router decision (shape)
//   ruflo-improvement-eval --help
//
// Exit: 0 self-improvement demonstrated / 1 not demonstrated / 2 environment error
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (has('-h') || has('--help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 27).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[2m', cyan: '\x1b[1;36m', r: '\x1b[0m' }
  : { ok: '', warn: '', fail: '', dim: '', cyan: '', r: '' };
const ok = (s) => console.log(`${C.ok}✓${C.r} ${s}`);
const fail = (s) => console.log(`${C.fail}✗${C.r} ${s}`);

// ── Resolve ruflo's real Q-learning router from the global install ──────────
function resolveRouterIdx() {
  let groot;
  try { groot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
  const cliPkg = join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'package.json');
  if (!existsSync(cliPkg)) return null;
  try { return createRequire(cliPkg).resolve('./dist/src/ruvector/index.js'); } catch { return null; }
}

// ── --cli-check: does CLI `route feedback` persist? ─────────────────────────
// F2 (route feedback never saveModel()'d) is FIXED UPSTREAM in ruflo 3.10.6 (#2222):
// feedbackCommand now calls `await router.saveModel()`. So persistence holds on >=3.10.6
// regardless of autoSaveInterval. On <3.10.6 it holds only if the legacy stopgap
// (autoSaveInterval:1, via ruflo-patch-route-learning) has been applied.
if (has('--cli-check')) {
  let groot; try { groot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { groot = ''; }
  let ver = ''; try { ver = (execSync('ruflo --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/\d+\.\d+\.\d+/) || [''])[0]; } catch { /* unknown */ }
  const ge = (v, a, b, c) => { const [x, y, z] = (v || '0.0.0').split('.').map(Number); return x > a || (x === a && (y > b || (y === b && z >= c))); };
  const upstreamFixed = ver && ge(ver, 3, 10, 6);
  const route = join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'commands', 'route.js');
  const hasSaveModel = existsSync(route) && /feedbackCommand[\s\S]{0,2000}saveModel\(\)/.test(readFileSync(route, 'utf8'));
  const ql = join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'ruvector', 'q-learning-router.js');
  const legacyStopgap = existsSync(ql) && /autoSaveInterval: 1,/.test(readFileSync(ql, 'utf8'));
  const persists = upstreamFixed || hasSaveModel || legacyStopgap;
  if (upstreamFixed || hasSaveModel) {
    console.log(`${C.ok}✓${C.r} CLI 'route feedback' persists — fixed upstream in ruflo 3.10.6 (#2222), saveModel() after feedback (ruflo ${ver || '>=3.10.6'}). The kit's autoSaveInterval stopgap is retired.`);
  } else if (legacyStopgap) {
    console.log(`${C.ok}✓${C.r} CLI 'route feedback' persists via the legacy stopgap (autoSaveInterval:1) on ruflo ${ver || '<3.10.6'}. Upgrade to >=3.10.6 to retire it.`);
  } else {
    console.log(`${C.warn}⚠${C.r}  CLI 'route feedback' does NOT persist on ruflo ${ver || '<3.10.6'}. Upgrade to >=3.10.6 (recommended) or run ruflo-patch-route-learning (legacy stopgap).`);
  }
  process.exit(persists ? 0 : 1);
}

const routerIdx = resolveRouterIdx();
if (!routerIdx) { fail("Could not resolve ruflo's Q-learning router. Install ruflo globally (npm i -g ruflo)."); process.exit(2); }
const { createQLearningRouter } = await import(routerIdx);

// ── Synthetic-reward environment ────────────────────────────────────────────
// ruflo's state encoder (q-learning-router.js extractFeatures) keys on the FIRST 32
// FEATURE_KEYWORDS (6 clean categories: code/test/review/architect/research/optimize) plus
// length/word-count buckets. Debug/document keywords (index ≥32) are NOT encoded, so we use
// the 6 encodable categories. Each task uses distinct in-category keywords → a distinct
// Q-state; `evalq` is the same keyword-bag reordered (identical state, different surface
// string) — evaluated GREEDILY with no updates. This proves the router learns the optimal
// action per state and exploits it after training (vs a no-learning ablation), on a fixed
// task distribution. It does NOT claim generalization to unseen states (tabular Q — see spec F3).
// FINDING (verified): ruflo's encoder (featureVectorToKey) keys largely on length/word-count
// buckets — semantically-distinct keyword tasks collapse to ONE Q-state. So we engineer each
// task to occupy a DISTINCT Q-state (distinct word count → distinct bucket) with a fixed
// optimal agent. evalq = the same word-bag reversed (identical state, different surface
// string), evaluated greedily. The proof — the learner discovers the optimal action per state
// and exploits it (vs a no-learning ablation) — is valid regardless of what drives the state.
const AGENTS6 = ['tester', 'coder', 'reviewer', 'architect', 'researcher', 'optimizer'];
const ENV = AGENTS6.map((agent, i) => {
  const n = 4 + i * 5;                                   // 4,9,14,19,24,29 words → distinct buckets
  const words = Array.from({ length: n }, (_, j) => `t${i}w${j}`);
  return { agent, train: words.join(' '), evalq: words.slice().reverse().join(' ') };
});
const HIT = 1, MISS = -1;

// Extract the chosen agent id from a router decision (shape confirmed via --inspect-decision).
function decide(router, task, explore) {
  const d = router.route ? router.route(task, explore) : router.selectAction(task, explore);
  return (d && (d.agent || d.action || d.route || d.selectedAgent || d.recommendedAgent)) || (typeof d === 'string' ? d : null);
}
function newRouter() { const r = createQLearningRouter({ modelPath: '/tmp/.ruflo-eval-' + process.pid + '.json', autoSaveInterval: 1e9 }); return r; }

if (has('--inspect-decision')) {
  const r = newRouter(); await r.initialize();
  console.log('raw decision:', JSON.stringify(r.route ? r.route(ENV[0].train, false) : r.selectAction(ENV[0].train, false)));
  process.exit(0);
}
if (has('--probe-states')) {
  const r = newRouter(); await r.initialize(); if (r.reset) r.reset();
  for (const e of ENV) r.update(e.train, e.agent, HIT);
  const n = r.getStats().qTableSize;
  console.log(`distinct Q-states for ${ENV.length} train tasks: ${n}`);
  process.exit(n >= ENV.length ? 0 : 1);
}

// ── Protocol ────────────────────────────────────────────────────────────────
function evalAccuracy(router) { let h = 0; for (const e of ENV) if (decide(router, e.evalq, false) === e.agent) h++; return h / ENV.length; }
async function runOnce({ episodes, checkpoints, ablation }) {
  const router = newRouter(); await router.initialize(); if (router.reset) router.reset();
  const curve = [{ k: 0, acc: evalAccuracy(router) }];
  const cps = new Set(checkpoints);
  for (let k = 1; k <= episodes; k++) {
    const e = ENV[(k - 1) % ENV.length];
    const chosen = decide(router, e.train, true);
    if (!ablation) router.update(e.train, chosen, chosen === e.agent ? HIT : MISS);
    if (cps.has(k)) curve.push({ k, acc: evalAccuracy(router) });
  }
  if (!cps.has(episodes)) curve.push({ k: episodes, acc: evalAccuracy(router) });
  const s = router.getStats();
  return { curve, stats: { epsilon: s.epsilon, tdError: s.avgTDError, qSize: s.qTableSize, updates: s.updateCount } };
}

// ── Statistics (no external deps) ───────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ci95 = (a) => { if (a.length < 2) return 0; const m = mean(a), v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); return 1.96 * Math.sqrt(v / a.length); };
const spark = (xs) => { const b = '▁▂▃▄▅▆▇█'; return xs.map(x => b[Math.min(7, Math.max(0, Math.round(x * 7)))]).join(''); };
const sampVar = (a) => a.length < 2 ? 0 : a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1);
function cohensD(a, b) { const sp = Math.sqrt(((a.length - 1) * sampVar(a) + (b.length - 1) * sampVar(b)) / Math.max(1, a.length + b.length - 2)); return sp === 0 ? (mean(a) > mean(b) ? Infinity : 0) : (mean(a) - mean(b)) / sp; }
function* combos(arr, k, start = 0, acc = []) { if (acc.length === k) { yield acc; return; } for (let i = start; i < arr.length; i++) yield* combos(arr, k, i + 1, acc.concat(arr[i])); }
function permP(learn, abl) {
  const obs = mean(learn) - mean(abl), pool = learn.concat(abl), n = learn.length, idx = [...pool.keys()];
  let ge = 0, total = 0;
  if (pool.length <= 14) { for (const c of combos(idx, n)) { const set = new Set(c); const A = pool.filter((_, i) => set.has(i)), B = pool.filter((_, i) => !set.has(i)); if (mean(A) - mean(B) >= obs - 1e-12) ge++; total++; } }
  else { total = 10000; for (let s = 0; s < total; s++) { const sh = [...pool]; for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[sh[i], sh[j]] = [sh[j], sh[i]]; } if (mean(sh.slice(0, n)) - mean(sh.slice(n)) >= obs - 1e-12) ge++; } }
  return ge / total;
}
function spearman(curve) {
  const n = curve.length; if (n < 3) return 0;
  const rank = (xs) => { const s = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = Array(xs.length); s.forEach(([, i], j) => r[i] = j + 1); return r; };
  const rk = rank(curve.map(c => c.k)), ra = rank(curve.map(c => c.acc)), mr = (n + 1) / 2;
  let num = 0, dk = 0, da = 0; for (let i = 0; i < n; i++) { num += (rk[i] - mr) * (ra[i] - mr); dk += (rk[i] - mr) ** 2; da += (ra[i] - mr) ** 2; }
  return (dk && da) ? num / Math.sqrt(dk * da) : 0;
}

// ── --check: print last cached result ───────────────────────────────────────
if (has('--check')) {
  const p = join('.claude-flow', 'improvement.json');
  if (!existsSync(p)) { console.log('No .claude-flow/improvement.json — run ruflo-improvement-eval first.'); process.exit(2); }
  const r = JSON.parse(readFileSync(p, 'utf8'));
  console.log(`${r.verdict}  ${spark(r.curve.map(c => c.acc))}  cold ${Math.round(r.coldAcc * 100)}%→warm ${Math.round(r.warmAcc * 100)}%  Δ${r.deltaPP}pp  p${r.pValue < 0.001 ? '<.001' : '=' + r.pValue}  d=${r.cohensD}  ε→${r.epsilonF.toFixed(2)}  δ̄${r.tdError.toFixed(3)}  |Q|${r.qSize}`);
  process.exit(r.verdict === 'PASS' ? 0 : 1);
}

// ── Run the experiment ───────────────────────────────────────────────────────
// Note: with a one-sided permutation test the minimum achievable p is 1/C(2N,N), so N≥5
// seeds are needed to reach p<0.05 (N=5 → min p≈0.004). --smoke keeps 5 seeds, fewer episodes.
const EPISODES = has('--smoke') ? 90 : parseInt(val('--episodes', '300'), 10);
const SEEDS = parseInt(val('--seeds', '5'), 10);
const CHECKPOINTS = (val('--checkpoints', has('--smoke') ? '0,30,60,90' : '0,25,50,100,200,300')).split(',').map(n => parseInt(n, 10)).filter(n => n <= EPISODES);

const learnRuns = [], ablRuns = [];
for (let s = 0; s < SEEDS; s++) learnRuns.push(await runOnce({ episodes: EPISODES, checkpoints: CHECKPOINTS, ablation: false }));
for (let s = 0; s < SEEDS; s++) ablRuns.push(await runOnce({ episodes: EPISODES, checkpoints: CHECKPOINTS, ablation: true }));

const curveMean = learnRuns[0].curve.map((p, i) => ({ k: p.k, acc: mean(learnRuns.map(r => r.curve[i].acc)) }));
const warmSeeds = learnRuns.map(r => r.curve[r.curve.length - 1].acc);
const ablSeeds = ablRuns.map(r => r.curve[r.curve.length - 1].acc);
const coldAcc = curveMean[0].acc, warmAcc = mean(warmSeeds), warmCI = ci95(warmSeeds), ablAcc = mean(ablSeeds);
const chance = 1 / ENV.length, st = learnRuns[learnRuns.length - 1].stats, deltaPP = Math.round((warmAcc - coldAcc) * 100);
const pValue = permP(warmSeeds, ablSeeds), d = cohensD(warmSeeds, ablSeeds), rho = spearman(curveMean);
const aboveChance = (warmAcc - warmCI) > chance;

// Pre-registered, academically-grounded PASS: causal significance + effect size + above chance.
const ALPHA = 0.05, D_MIN = 0.8;
const verdict = (pValue < ALPHA && d >= D_MIN && aboveChance) ? 'PASS' : 'FAIL';

const result = {
  curve: curveMean, coldAcc, warmAcc, deltaPP, ci95: Math.round(warmCI * 100), ablationAcc: ablAcc, chance,
  pValue: +pValue.toFixed(4), cohensD: (d === Infinity ? 999 : +d.toFixed(2)), spearman: +rho.toFixed(2), aboveChance,
  alpha: ALPHA, dMin: D_MIN, epsilon0: 1.0, epsilonF: st.epsilon, tdError: st.tdError, qSize: st.qSize,
  episodes: EPISODES, seeds: SEEDS, verdict, ts: Math.floor(Date.now() / 1000),
};
mkdirSync('.claude-flow', { recursive: true });
writeFileSync(join('.claude-flow', 'improvement.json'), JSON.stringify(result, null, 2));

if (has('--json')) { console.log(JSON.stringify(result)); process.exit(verdict === 'PASS' ? 0 : 1); }

console.log('');
console.log(`${C.cyan}Self-improvement eval${C.r}  (route Q-learner · ${SEEDS} seeds × ${EPISODES} episodes · learning vs no-learning ablation)`);
console.log(`  learning curve  ${spark(curveMean.map(p => p.acc))}  ${curveMean.map(p => `${p.k}:${Math.round(p.acc * 100)}%`).join('  ')}`);
console.log(`  held-out acc    cold ${Math.round(coldAcc * 100)}% → warm ${Math.round(warmAcc * 100)}%   Δ${deltaPP >= 0 ? '+' : ''}${deltaPP}pp (95% CI ±${Math.round(warmCI * 100)})`);
console.log(`  ablation        ${Math.round(ablAcc * 100)}%   ·   chance ${Math.round(chance * 100)}%   ·   above-chance: ${aboveChance ? 'yes' : 'no'}`);
console.log(`  significance    permutation p ${pValue < 0.001 ? '<0.001' : '=' + pValue.toFixed(3)}   ·   Cohen's d ${d === Infinity ? '∞' : d.toFixed(2)}   ·   Spearman ρ(K,acc) ${rho.toFixed(2)}`);
console.log(`  convergence     ε ${result.epsilon0}→${st.epsilon.toFixed(2)}   δ̄ ${st.tdError.toFixed(3)}   |Q| ${st.qSize}`);
console.log('');
verdict === 'PASS'
  ? ok(`SELF-IMPROVEMENT DEMONSTRATED — learning beat the no-learning ablation (p<${ALPHA}, d=${d === Infinity ? '∞' : d.toFixed(2)}), held-out +${deltaPP}pp, above chance. → .claude-flow/improvement.json`)
  : fail(`NOT demonstrated — fails the pre-registered test (p=${pValue.toFixed(3)}, d=${d === Infinity ? '∞' : d.toFixed(2)}, above-chance=${aboveChance}). Honest negative result → .claude-flow/improvement.json`);
process.exit(verdict === 'PASS' ? 0 : 1);
