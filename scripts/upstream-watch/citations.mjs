// Upstream citations in agentic-kit's own source: which repositories count as
// upstream, how a citation is spelled, and which tracked files cite what. The
// registry guard test and scripts/upstream-watch.mjs share this module, so
// "a citation" has one definition.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE } from '../../src/lib/hook-audit/upstream.mjs';

// Tracked paths whose upstream citations must be registered in `watch`.
export const CITATION_DIRS = ['src', 'bin', 'claude', 'tests'];

// User-facing documentation whose upstream citations must be registered too:
// README.md and the top-level docs/*.md guides. CLI help lives in src/, which
// CITATION_DIRS already covers. ADRs, audits, plans and research sit in
// subfolders and are history, never scanned; these top-level files are
// history too, so they are exempt by name.
export const USER_DOC_EXEMPT = new Map([
  ['docs/MODEL-PRICING-AUDIT.md', 'dated audit'],
  ['docs/METAHARNESS-COMPANION-PROPOSAL.md', 'proposal'],
  ['docs/USAGE-SCORECARD-METRICS.md', 'research reference'],
]);

/** README.md plus every top-level docs/*.md guide, minus the named exemptions. */
export function userFacingDocs(root) {
  const guides = fs.readdirSync(path.join(root, 'docs'), { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.md'))
    .map((item) => `docs/${item.name}`)
    .filter((file) => !USER_DOC_EXEMPT.has(file));
  return ['README.md', ...guides.sort()];
}

// Watched owners; `null` watches every repository of that owner.
const WATCHED = {
  ruvnet: null,
  'proffesor-for-testing': ['agentic-qe'],
  stuinfla: ['ruvnet-brain'],
  openai: ['codex'],
  anthropics: ['claude-code'],
  anomalyco: ['opencode'],
  nousresearch: ['hermes-agent'],
  'vercel-labs': ['agent-browser'],
};
const RENAMED = { 'ruvnet/claude-flow': 'ruvnet/ruflo', 'sst/opencode': 'anomalyco/opencode' };
// GitHub's own spelling where it is not all lower case.
const DISPLAY = { 'ruvnet/ruvector': 'ruvnet/RuVector', 'nousresearch/hermes-agent': 'NousResearch/hermes-agent' };
// Short names used in prose and comments ("ruflo#2670", "AQE #654").
const ALIASES = {
  ruflo: 'ruvnet/ruflo',
  'claude-flow': 'ruvnet/ruflo',
  'agentic-qe': 'proffesor-for-testing/agentic-qe',
  aqe: 'proffesor-for-testing/agentic-qe',
  agentdb: 'ruvnet/agentdb',
  ruvector: 'ruvnet/RuVector',
  'agentic-flow': 'ruvnet/agentic-flow',
  'ruvnet-brain': 'stuinfla/ruvnet-brain',
  codex: 'openai/codex',
  'claude-code': 'anthropics/claude-code',
  opencode: 'anomalyco/opencode',
  'hermes-agent': 'NousResearch/hermes-agent',
  'agent-browser': 'vercel-labs/agent-browser',
};

/** Canonical `owner/repo` for a watched repository, or null when it is not watched. */
export function canonicalRepo(owner, repo) {
  let key = `${owner}/${repo}`.toLowerCase();
  key = RENAMED[key] ?? key;
  const [o, r] = key.split('/');
  if (!(o in WATCHED)) return null;
  if (WATCHED[o] && !WATCHED[o].includes(r)) return null;
  return DISPLAY[key] ?? key;
}

const NUM = '[1-9]\\d*';
// "#617 → #620", "#16921/#17827", "#3415–#3419" continue the named repository.
// A comma does not: "ruflo#3196, #213" names another repository's #213.
const CONT = `(?:\\s*(?:/|→|->|–)\\s*#${NUM}\\b)*`;
const ALIAS_NAMES = Object.keys(ALIASES).sort((a, b) => b.length - a.length).map((a) => a.replace(/[.-]/g, '\\$&')).join('|');
const CITATION_RE = new RegExp([
  `(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/(?<uo>[\\w.-]+)\\/(?<ur>[\\w.-]+)\\/(?<ukind>issues|pull)\\/(?<un>${NUM})\\b`,
  `(?<![\\w/.@-])(?<qo>[\\w.-]+)\\/(?<qr>[\\w.-]+) ?#(?<qn>${NUM})\\b(?<qc>${CONT})`,
  `(?<![\\w/.@-])(?<alias>${ALIAS_NAMES})(?: (?:issue|pr))? ?#(?<an>${NUM})\\b(?<ac>${CONT})`,
].join('|'), 'gi');
const CONT_RE = new RegExp(`(/|→|->|–)\\s*#(${NUM})`, 'g');
const MAX_RANGE = 50;

function withContinuation(repo, first, cont) {
  const numbers = [first];
  for (const [, sep, n] of (cont ?? '').matchAll(CONT_RE)) {
    const next = Number(n);
    const prev = numbers.at(-1);
    if (sep === '–' && next > prev && next - prev <= MAX_RANGE) {
      for (let i = prev + 1; i <= next; i++) numbers.push(i);
    } else {
      numbers.push(next);
    }
  }
  return numbers.map((n) => `${repo}#${n}`);
}

/** Every watched-repository citation in `text`, in order of appearance. */
export function findCitations(text) {
  const out = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const g = match.groups;
    if (g.un) {
      const repo = canonicalRepo(g.uo, g.ur);
      if (repo) out.push({ id: `${repo}#${Number(g.un)}`, kind: g.ukind.toLowerCase() === 'pull' ? 'pr' : 'issue' });
      continue;
    }
    const repo = g.qn ? canonicalRepo(g.qo, g.qr) : ALIASES[g.alias.toLowerCase()];
    if (!repo) continue;
    for (const id of withContinuation(repo, Number(g.qn ?? g.an), g.qc ?? g.ac)) out.push({ id, kind: null });
  }
  return out;
}

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|sqlite|db|rvf)$/i;

function gitFiles(root, dirs) {
  const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 << 20,
  });
  if (out.status !== 0) throw new Error(`git ls-files failed (exit ${out.status}): ${out.stderr || out.error}`);
  return out.stdout.split('\n').filter(Boolean);
}

/** Map of citation id → sorted files citing it, over tracked and untracked-unignored files. */
export function scanCitations({ root, dirs = CITATION_DIRS, listFiles = gitFiles, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  // The registry is the list itself, not a citation of it.
  const registry = path.relative(root, UPSTREAM_REGISTRY_FILE).split(path.sep).join('/');
  const found = new Map();
  for (const file of listFiles(root, dirs)) {
    if (file === registry || BINARY.test(file)) continue;
    let text;
    try { text = readFile(path.join(root, file)); } catch { continue; }
    for (const { id } of findCitations(text)) {
      if (!found.has(id)) found.set(id, new Set());
      found.get(id).add(file);
    }
  }
  return new Map([...found].map(([id, files]) => [id, [...files].sort()]));
}

/** Citations the watch list does not register, minus file-scoped synthetic fixtures. */
export function unregisteredCitations(watchIds, citations, synthetic = new Map()) {
  const known = new Set([...watchIds].map((id) => id.toLowerCase()));
  const missing = [];
  for (const [id, files] of citations) {
    if (known.has(id.toLowerCase())) continue;
    const allowed = synthetic.get(id) ?? [];
    const rest = files.filter((file) => !allowed.includes(file));
    if (rest.length) missing.push({ id, files: rest });
  }
  return missing;
}
