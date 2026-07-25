// Session → category + confidence — the pure classification core (ADR-0009 §5).
//
// Three layers, in order:
//   1. provenance — an attributed skill/plugin IS the category. Exact, free, no
//      inference. Longest-prefix match, so `autopilot:run-phase` resolves to the
//      `autopilot` entry.
//   2. rules — weighted keywords over the session title, plus a tool-mix prior
//      that NUDGES the ranking but is never allowed to decide on its own.
//   3. floor — anything under CONFIDENCE_FLOOR stays `Unclassified`.
//
// `Unclassified` is a first-class outcome, not a failure mode: force-fitting a
// label to reach 100% coverage would make the categories untrustworthy
// everywhere, not just on the residue (ADR-0009 §5). This module is pure — no
// `fs`, no clock, no network — so every layer is unit-testable in isolation.

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The one category that means "we could not tell, and we say so". */
export const UNCLASSIFIED = 'Unclassified';

/** Closed vocabulary. Anything `classify` returns is drawn from this list. */
export const CATEGORIES = [
  'Security review',
  'Code review',
  'Dependency & maintenance',
  'Release & CI',
  'Test & QE',
  'Bug fix & debug',
  'Design & frontend',
  'Design & planning',
  'Docs & writing',
  'Refactor',
  'Feature build',
  'Research & exploration',
  'Tooling & config',
  'Content & data',
  'Orchestration',
  UNCLASSIFIED,
];

// ── Layer 1: provenance ──────────────────────────────────────────────────────
// `attributionSkill` / `attributionPlugin` on a transcript turn is a fact, not a
// guess — when present it outranks every inferred signal. Keys are matched as
// PREFIXES of the attributed id.
export const SKILL_CAT = {
  autopilot: 'Orchestration',
  'superpowers:brainstorming': 'Design & planning',
  'superpowers:subagent-driven-development': 'Orchestration',
  'superpowers:using-git-worktrees': 'Orchestration',
  'superpowers:test-driven-development': 'Test & QE',
  'superpowers:systematic-debugging': 'Bug fix & debug',
  'frontend-design': 'Design & frontend',
  'ui-ux-pro-max': 'Design & frontend',
  'pr-consolidation-rust-ts': 'Dependency & maintenance',
  'java-maintenance-workflow': 'Dependency & maintenance',
  'code-review': 'Code review',
  'security-review': 'Security review',
  'skill-creator': 'Tooling & config',
  browser: 'Research & exploration',
  'refresh-tub-library': 'Content & data',
  loop: 'Orchestration',
};

// Longest key first: a specific entry must never be shadowed by a shorter
// sibling that happens to be declared earlier.
const SKILL_KEYS = Object.keys(SKILL_CAT).sort((a, b) => b.length - a.length);

// ── Layer 2: title rules ─────────────────────────────────────────────────────
// `strong` keywords weigh 3, `weak` weigh 1. Matched as substrings of the
// lower-cased title, so stems ('vulnerabilit', 'analyz', 'consolidat') cover
// their inflections. Keywords must be specific enough not to fire on ordinary
// prose — 'agent' is deliberately absent, since half the corpus is agent work.
export const STRONG_WEIGHT = 3;
export const WEAK_WEIGHT = 1;

export const RULES = [
  {
    category: 'Security review',
    strong: ['security', 'vulnerabilit', 'cve', 'exploit', 'pentest', 'sast'],
    weak: ['audit', 'review', 'harden', 'secret', 'injection', 'auth'],
  },
  {
    category: 'Code review',
    strong: ['code review', 'pr review', 'review changes', 'review pr'],
    weak: ['review', 'diff', 'feedback', 'critique'],
  },
  {
    category: 'Dependency & maintenance',
    strong: ['dependabot', 'dependenc', 'upgrade', 'bump', 'consolidat'],
    weak: ['version', 'package.json', 'lockfile', 'maintenance', 'migrate', 'npm', 'pnpm'],
  },
  {
    category: 'Release & CI',
    strong: ['release', 'deploy', 'ci ', 'github action', 'workflow', 'publish'],
    weak: ['tag', 'semantic version', 'pipeline', 'build'],
  },
  {
    category: 'Test & QE',
    strong: ['test', 'coverage', 'flaky', 'mutation', 'e2e', 'regression'],
    weak: ['assert', 'spec', 'qa', 'verify', 'fixture'],
  },
  {
    category: 'Bug fix & debug',
    strong: ['bug', 'fix', 'debug', 'root cause', 'crash', 'broken', 'failure'],
    weak: ['error', 'issue', 'repro', 'wrong', 'incorrect'],
  },
  {
    category: 'Design & frontend',
    strong: ['design', 'ui', 'ux', 'layout', 'dashboard', 'mockup', 'css', 'styling'],
    weak: ['visual', 'theme', 'component', 'responsive', 'tab', 'panel'],
  },
  {
    category: 'Docs & writing',
    strong: ['documentation', 'readme', 'docs', 'changelog', 'adr', 'write-up'],
    weak: ['guide', 'explain', 'blog', 'spec', 'narrative'],
  },
  {
    category: 'Refactor',
    strong: ['refactor', 'restructure', 'extract', 'decompose', 'cleanup'],
    weak: ['rename', 'simplify', 'consolidate', 'reorganize'],
  },
  {
    category: 'Feature build',
    strong: ['add ', 'implement', 'build', 'create', 'introduce', 'feature', 'support for'],
    weak: ['new', 'enable', 'wire', 'integrate', 'scaffold'],
  },
  {
    category: 'Research & exploration',
    strong: ['investigate', 'research', 'explore', 'compare', 'evaluate', 'analyz'],
    weak: ['understand', 'survey', 'assess', 'look into', 'why'],
  },
  {
    category: 'Tooling & config',
    strong: ['config', 'setup', 'install', 'provision', 'settings', 'hook', 'mcp'],
    weak: ['env', 'flag', 'toggle', 'plugin', 'skill'],
  },
  {
    category: 'Content & data',
    strong: ['inventory', 'taxonomy', 'catalog', 'asset', 'library', 'dataset'],
    weak: ['tag', 'collection', 'index', 'metadata'],
  },
  {
    // Orchestration is otherwise reachable only via provenance or the Agent/Task
    // prior; without title rules a plainly-titled swarm session scored too low to
    // clear the floor.
    category: 'Orchestration',
    strong: ['orchestrat', 'swarm', 'subagent', 'sub-agent', 'hive-mind', 'worktree'],
    weak: ['parallel', 'coordinate', 'fan-out', 'delegate', 'worker', 'dispatch'],
  },
];

// ── Layer 2b: the tool-mix prior ─────────────────────────────────────────────
// Shape of the work, independent of what the title says. These thresholds are
// shares of the session's tool calls (ADR-0009 §5 / spec §3).
export const TOOL_PRIOR = {
  edit: { share: 0.30, weight: 1.5, categories: ['Feature build', 'Refactor', 'Bug fix & debug'] },
  read: { share: 0.45, editCeiling: 0.10, weight: 1.5, categories: ['Code review', 'Security review', 'Research & exploration'] },
  agent: { share: 0.12, weight: 2.5, categories: ['Orchestration'] },
};

const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const AGENT_TOOLS = ['Agent', 'Task'];

// ── Layer 3: the floor ───────────────────────────────────────────────────────

/** Below this, a session stays `Unclassified`. A requirement, not a tuning knob. */
export const CONFIDENCE_FLOOR = 0.28;

/** Rule score at which absolute strength saturates (≈ two strong keyword hits). */
const SATURATION = 7;

/** Confidence retained by a dead-even tie — the rest is earned by margin. */
const TIE_FLOOR = 0.35;

/** Ceiling on a rules-derived confidence, so 1.0 uniquely means provenance. */
const RULE_CONFIDENCE_CAP = 0.9;

const round2 = (n) => Math.round(n * 100) / 100;

const shareOf = (tools, names, total) =>
  names.reduce((sum, name) => sum + (tools[name] || 0), 0) / total;

/**
 * Classify one session. Pure: inputs are never mutated and nothing is read from
 * disk or the clock.
 *
 * @param {object} [session]
 * @param {string} [session.title]    Session title (Claude's `ai-title`).
 * @param {string} [session.skill]    Attributed skill id, e.g. `autopilot:run-phase`.
 * @param {string} [session.plugin]   Attributed plugin id.
 * @param {Record<string, number>} [session.tools]  Tool name → call count.
 * @param {number} [session.prompts]    Accepted for contract completeness; neither
 * @param {number} [session.responses]  carries rule weight today (ADR-0009 §5).
 * @returns {{ category: string, confidence: number, basis: string }}
 *   `confidence` is 0..1 and rounded to 2dp; `basis` is one of
 *   `skill:<id>` | `plugin:<id>` | `title+tools` | `weak signal` | `no signal`.
 */
export function classify(session = {}) {
  const { title, skill, plugin, tools } = session;

  // ── Layer 1: provenance wins outright ─────────────────────────────────────
  for (const [id, kind] of [[skill, 'skill'], [plugin, 'plugin']]) {
    if (!id) continue;
    const key = SKILL_KEYS.find((k) => id.startsWith(k));
    if (key) return { category: SKILL_CAT[key], confidence: 1, basis: `${kind}:${id}` };
  }

  // ── Layer 2: weighted keywords over the title ─────────────────────────────
  const text = String(title || '').toLowerCase();
  const titleScores = new Map();
  for (const { category, strong, weak } of RULES) {
    let score = 0;
    for (const kw of strong) if (text.includes(kw)) score += STRONG_WEIGHT;
    for (const kw of weak) if (text.includes(kw)) score += WEAK_WEIGHT;
    if (score) titleScores.set(category, score);
  }

  // ── Layer 2b: the tool prior nudges the ranking ───────────────────────────
  const scores = new Map(titleScores);
  const calls = tools ? Object.values(tools).reduce((a, b) => a + b, 0) : 0;
  if (calls > 0) {
    const edit = shareOf(tools, EDIT_TOOLS, calls);
    const read = shareOf(tools, READ_TOOLS, calls);
    const agent = shareOf(tools, AGENT_TOOLS, calls);
    const bump = ({ weight, categories }) => {
      for (const c of categories) scores.set(c, (scores.get(c) || 0) + weight);
    };
    if (edit > TOOL_PRIOR.edit.share) bump(TOOL_PRIOR.edit);
    if (read > TOOL_PRIOR.read.share && edit < TOOL_PRIOR.read.editCeiling) bump(TOOL_PRIOR.read);
    if (agent > TOOL_PRIOR.agent.share) bump(TOOL_PRIOR.agent);
  }

  if (scores.size === 0) return { category: UNCLASSIFIED, confidence: 0, basis: 'no signal' };

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;

  // Confidence = absolute strength × margin over the runner-up. A tie keeps only
  // TIE_FLOOR of its strength, so two equally-matching categories can never
  // produce a confident arbitrary pick.
  const strength = Math.min(1, topScore / SATURATION);
  const margin = 1 - Math.min(runnerUp / topScore, 1);
  // Grounding: the prior may reinforce or reorder, but a category that wins with
  // NO title evidence has not been classified — it has been guessed.
  const grounded = (titleScores.get(top) || 0) > 0 ? 1 : 0;
  const confidence = round2(
    Math.min(RULE_CONFIDENCE_CAP, strength * (TIE_FLOOR + (1 - TIE_FLOOR) * margin)) * grounded,
  );

  if (confidence < CONFIDENCE_FLOOR) return { category: UNCLASSIFIED, confidence, basis: 'weak signal' };
  return { category: top, confidence, basis: 'title+tools' };
}
