#!/usr/bin/env node
// Turns the "Blocked by:" lines that v4 program cards carry in their bodies into
// GitHub's native issue dependencies (the master plan's Decision 6). The card
// text is the source of truth; this script only mirrors it. Dry run by default.
//
//   node scripts/issue-dependencies.mjs            show the plan, change nothing
//   node scripts/issue-dependencies.mjs --apply    create the missing links
//   node scripts/issue-dependencies.mjs --apply --prune
//                                                  also remove native links the text no longer lists
//
// Requires the GitHub CLI signed in with write access to the repository.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ROUTING_LABELS = Object.freeze(['v4.0.0', 'v4.1.0', 'v5.0.0']);
export const EXCLUDED_LABEL = 'needs-review';
const DEFAULT_REPO = 'pacphi/agentic-kit';
const WRITE_PAUSE_MS = 1000;

/** The issue numbers on a card's "Blocked by:" line. Only same-repository
 *  `#123` references count; "None" or an absent line yields an empty list.
 *  @param {string|null|undefined} body @returns {number[]} */
export function parseBlockedBy(body) {
  const line = String(body ?? '').split(/\r?\n/u).find((text) => /^\s*(?:\*\*)?Blocked by:?(?:\*\*)?:?/iu.test(text));
  if (!line) return [];
  const rest = line.replace(/^\s*(?:\*\*)?Blocked by:?(?:\*\*)?:?/iu, '');
  const numbers = [...rest.matchAll(/(?<![\w/])#(\d+)\b/gu)].map((match) => Number(match[1]));
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** What to add and remove so each card's native links match its text.
 *  @param {{ cards: Array<{number:number, body:string, labels:string[]}>,
 *            existing: Map<number, number[]>, excluded: Set<number>, prune?: boolean }} input */
export function planChanges({ cards, existing, excluded, prune = false }) {
  const add = []; const remove = []; const ignored = []; const unpruned = [];
  for (const card of cards) {
    if (card.labels.includes(EXCLUDED_LABEL)) continue;
    const wanted = parseBlockedBy(card.body).filter((blocker) => {
      if (blocker === card.number || excluded.has(blocker)) { ignored.push({ issue: card.number, blocker }); return false; }
      return true;
    });
    const current = new Set(existing.get(card.number) ?? []);
    for (const blocker of wanted) if (!current.has(blocker)) add.push({ issue: card.number, blocker });
    for (const blocker of current) {
      if (wanted.includes(blocker)) continue;
      (prune ? remove : unpruned).push({ issue: card.number, blocker });
    }
  }
  return { add, remove, ignored, unpruned };
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args.join(' ')} failed: ${String(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const ghJson = async (args) => JSON.parse(await gh(['api', ...args]));
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function openCards(repo) {
  const byNumber = new Map();
  for (const label of ROUTING_LABELS) {
    const pages = await ghJson(['--paginate', '--slurp', `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`]);
    for (const issue of pages.flat()) {
      if (issue.pull_request) continue;
      byNumber.set(issue.number, { number: issue.number, body: issue.body ?? '', labels: issue.labels.map((l) => l.name) });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

async function excludedIssues(repo) {
  const pages = await ghJson(['--paginate', '--slurp', `repos/${repo}/issues?state=all&labels=${EXCLUDED_LABEL}&per_page=100`]);
  return new Set(pages.flat().map((issue) => issue.number));
}

async function nativeBlockers(repo, number) {
  const pages = await ghJson(['--paginate', '--slurp', `repos/${repo}/issues/${number}/dependencies/blocked_by?per_page=100`]);
  return pages.flat().map((issue) => issue.number);
}

async function applyChanges(repo, { add, remove }) {
  const ids = new Map();
  const idOf = async (number) => {
    if (!ids.has(number)) ids.set(number, (await ghJson([`repos/${repo}/issues/${number}`])).id);
    return ids.get(number);
  };
  for (const { issue, blocker } of add) {
    await gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue}/dependencies/blocked_by`, '-F', `issue_id=${await idOf(blocker)}`]);
    console.log(`added    #${issue} blocked by #${blocker}`);
    await pause(WRITE_PAUSE_MS);
  }
  for (const { issue, blocker } of remove) {
    await gh(['api', '--method', 'DELETE', `repos/${repo}/issues/${issue}/dependencies/blocked_by/${await idOf(blocker)}`]);
    console.log(`removed  #${issue} blocked by #${blocker}`);
    await pause(WRITE_PAUSE_MS);
  }
}

function report(plan, applying) {
  const verb = applying ? 'will' : 'would';
  for (const { issue, blocker } of plan.add) console.log(`${verb} add     #${issue} blocked by #${blocker}`);
  for (const { issue, blocker } of plan.remove) console.log(`${verb} remove  #${issue} blocked by #${blocker}`);
  for (const { issue, blocker } of plan.unpruned) console.log(`kept      #${issue} blocked by #${blocker} (native link not in the card text; --prune removes it)`);
  for (const { issue, blocker } of plan.ignored) console.log(`ignored   #${issue} lists #${blocker} (itself or labelled ${EXCLUDED_LABEL})`);
  console.log(`${plan.add.length} to add, ${plan.remove.length} to remove, ${plan.unpruned.length} kept, ${plan.ignored.length} ignored`);
}

/** @param {string[]} argv @returns {Promise<number>} exit code */
export async function main(argv) {
  const known = new Set(['--apply', '--prune', '--repo']);
  const repoIndex = argv.indexOf('--repo');
  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : DEFAULT_REPO;
  const unknown = argv.filter((arg, i) => arg.startsWith('--') ? !known.has(arg) : i !== repoIndex + 1 || repoIndex < 0);
  if (unknown.length || !/^[\w.-]+\/[\w.-]+$/u.test(repo ?? '')) {
    console.error('usage: node scripts/issue-dependencies.mjs [--apply] [--prune] [--repo owner/name]');
    return 2;
  }
  const applying = argv.includes('--apply');
  const [cards, excluded] = await Promise.all([openCards(repo), excludedIssues(repo)]);
  const existing = new Map();
  for (const card of cards) existing.set(card.number, await nativeBlockers(repo, card.number));
  const plan = planChanges({ cards, existing, excluded, prune: argv.includes('--prune') });
  console.log(`${cards.length} open cards on ${ROUTING_LABELS.join(', ')} in ${repo}`);
  report(plan, applying);
  if (!applying) {
    if (plan.add.length || plan.remove.length) console.log('Dry run: nothing changed. Re-run with --apply to make these changes.');
    return 0;
  }
  await applyChanges(repo, plan);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
