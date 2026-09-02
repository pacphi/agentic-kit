// usage-prompt-semantics.mjs — bounded semantic facets for prompt telemetry.
//
// Prompt text exists only during parsing. This module reduces it to at most two
// controlled enum codes: an intent (`i`) and a topic (`d`). Matched words,
// proper nouns, paths, identifiers, and excerpts are never returned or stored.
// The vocabulary is deliberately small and precision-first: no match is better
// than a persuasive but unsupported label.

export const PROMPT_INTENTS = Object.freeze([
  'approve', 'continue', 'select', 'fix', 'review', 'verify', 'release',
  'document', 'plan', 'optimize', 'update', 'implement', 'explain', 'monitor', 'git',
]);

export const PROMPT_TOPICS = Object.freeze([
  'ci', 'security', 'context', 'hooks', 'prompts', 'sessions', 'agents', 'memory',
  'models', 'dependencies', 'database', 'api', 'ui', 'documentation', 'git',
  'release', 'tests', 'performance', 'build',
]);

export const INTENT_LABELS = Object.freeze({
  approve: 'Approval', continue: 'Continue', select: 'Selection', fix: 'Fix',
  review: 'Review', verify: 'Verify', release: 'Release', document: 'Document',
  plan: 'Plan', optimize: 'Optimize', update: 'Update', implement: 'Implement',
  explain: 'Explain', monitor: 'Progress check', git: 'Git operation',
});

export const TOPIC_LABELS = Object.freeze({
  ci: 'CI', security: 'Security', context: 'Context usage', hooks: 'Hooks',
  prompts: 'Prompts', sessions: 'Sessions', agents: 'Agents', memory: 'Memory',
  models: 'Models', dependencies: 'Dependencies', database: 'Database', api: 'API',
  ui: 'Dashboard UI', documentation: 'Documentation', git: 'Git changes',
  release: 'Releases', tests: 'Tests', performance: 'Performance', build: 'Builds',
});

function withoutControls(text) {
  return [...String(text ?? '')].map((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x200b && code <= 0x200f)
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069) ? ' ' : character;
  }).join('');
}

const normalize = (text) => withoutControls(text).toLowerCase()
  .replace(/[^\p{L}\p{N}+#./'-]+/gu, ' ').replace(/\s+/g, ' ').trim();

const exact = (s, values) => values.includes(s);
const has = (s, re) => re.test(s);

function intentOf(s) {
  if (exact(s, ['yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'approved', 'approve', 'agreed', 'lgtm', 'sounds good'])) return 'approve';
  if (exact(s, ['continue', 'proceed', 'go ahead', 'keep going', "let's go", 'lets go'])) return 'continue';
  if (/^(?:option\s+)?[a-z0-9]$/i.test(s)) return 'select';
  if (has(s, /\b(?:fix|debug|troubleshoot|repair|failing|failure|failures|failed|broken|errors?|bugs?)\b/)) return 'fix';
  if (has(s, /\b(?:review|audit|analy[sz]e|inspect|scan|assess)\b/)) return 'review';
  if (has(s, /\b(?:tests?|testing|verify|verification|validate|validation|check|coverage|qe)\b/)) return 'verify';
  if (has(s, /\b(?:release|deploy|publish|version|tag)\b/)) return 'release';
  if (has(s, /\b(?:document|documentation|docs|readme)\b/) || has(s, /\bwrite\b.*\b(?:guide|docs?|readme)\b/)) return 'document';
  if (has(s, /\b(?:plan|design|architect|strategize|strategy)\b/)) return 'plan';
  if (has(s, /\b(?:optimi[sz]e|improve|reduce|faster|efficient|efficiency)\b/)) return 'optimize';
  if (has(s, /\b(?:update|upgrade|migrate|migration|bump|patch)\b/)) return 'update';
  if (has(s, /^(?:please\s+)?(?:implement|add|create|build|develop)\b/) || has(s, /\b(?:implementation)\b/)) return 'implement';
  if (has(s, /^(?:why|how|what|explain)\b/) || has(s, /\b(?:explain|understand)\b/)) return 'explain';
  if (has(s, /\b(?:status|progress|monitor|watch|done|doing)\b/)) return 'monitor';
  if (has(s, /\b(?:commit|push|merge|rebase|cherry-pick)\b/)) return 'git';
  return null;
}

function topicOf(s) {
  if (has(s, /\b(?:github actions?|ci|pipelines?|workflows?)\b/)) return 'ci';
  if (has(s, /\b(?:security|vulnerabilit(?:y|ies)|authentication|authorization|auth|secrets?|cve|xss|csrf)\b/)) return 'security';
  if (has(s, /\b(?:context window|context usage|context budget|tokens?|compaction|compact)\b/)) return 'context';
  if (has(s, /\bhooks?\b/)) return 'hooks';
  if (has(s, /\bprompts?\b/)) return 'prompts';
  if (has(s, /\bsessions?|transcripts?|conversations?\b/)) return 'sessions';
  if (has(s, /\b(?:agents?|subagents?|swarms?|workers?)\b/)) return 'agents';
  if (has(s, /\b(?:memory|agentdb|vector|embeddings?)\b/)) return 'memory';
  if (has(s, /\b(?:models?|providers?|inference)\b/)) return 'models';
  if (has(s, /\b(?:dependencies|dependency|packages?|lockfiles?|npm|pnpm|yarn)\b/)) return 'dependencies';
  if (has(s, /\b(?:database|databases|sql|schema|migration)\b/)) return 'database';
  if (has(s, /\b(?:api|endpoint|openapi|graphql|rest)\b/)) return 'api';
  if (has(s, /\b(?:dashboard|frontend|ui|ux|accessibility|a11y|css|html)\b/)) return 'ui';
  if (has(s, /\b(?:documentation|docs|readme|guide|adr)\b/)) return 'documentation';
  if (has(s, /\b(?:git|commit|push|pull request|merge|branch|rebase)\b/)) return 'git';
  if (has(s, /\b(?:release|deploy|publish|version|tag)\b/)) return 'release';
  if (has(s, /\b(?:tests?|testing|verification|coverage|specs?|qe|full check)\b/)) return 'tests';
  if (has(s, /\b(?:performance|latency|throughput|memory usage|speed)\b/)) return 'performance';
  if (has(s, /\b(?:build|compile|compiler|bundl(?:e|er|ing))\b/)) return 'build';
  return null;
}

/** Reduce transient prompt text to controlled codes only. */
export function promptSemantics(text) {
  const s = normalize(text);
  if (!s) return {};
  const i = intentOf(s), d = topicOf(s);
  return { ...(i ? { i } : {}), ...(d ? { d } : {}) };
}

const PAIR_NAMES = Object.freeze({
  'fix:ci': 'Fix CI failures',
  'fix:build': 'Investigate build failures',
  'review:security': 'Review security',
  'verify:tests': 'Run tests',
  'release:release': 'Release and deploy',
  'git:git': 'Commit and push',
  'optimize:context': 'Reduce context usage',
  'plan:ui': 'Design dashboard UI',
  'implement:ui': 'Build dashboard UI',
  'review:git': 'Review pull requests',
});

const INTENT_NAMES = Object.freeze({
  approve: 'Approval', continue: 'Continue work', select: 'Selection', fix: 'Fix recurring failures',
  review: 'Review requests', verify: 'Verification requests', release: 'Release and deploy',
  document: 'Documentation updates', plan: 'Planning requests', optimize: 'Optimization requests',
  update: 'Update requests', implement: 'Implementation requests', explain: 'Explanation requests',
  monitor: 'Progress check-in', git: 'Git operations',
});

/** Compose a display name entirely from controlled vocabulary. */
export function semanticName(intent, topic, cls = 'unknown') {
  if (intent && topic && PAIR_NAMES[`${intent}:${topic}`]) return PAIR_NAMES[`${intent}:${topic}`];
  if (intent && topic && INTENT_LABELS[intent] && TOPIC_LABELS[topic]) {
    const verb = INTENT_LABELS[intent].replace(/ (?:check|operation)$/, '');
    return `${verb} ${TOPIC_LABELS[topic].toLowerCase()}`;
  }
  if (intent && INTENT_NAMES[intent]) return INTENT_NAMES[intent];
  if (topic && TOPIC_LABELS[topic]) {
    return cls === 'question' ? `Questions about ${TOPIC_LABELS[topic].toLowerCase()}`
      : `${TOPIC_LABELS[topic]} prompts`;
  }
  return null;
}

export const intentLabel = (id) => INTENT_LABELS[id] ?? null;
export const topicLabel = (id) => TOPIC_LABELS[id] ?? null;
