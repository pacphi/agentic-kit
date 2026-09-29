// Dispatch of released upstream fixes (spec 2026-09-28): fire the claude.ai
// routine's API trigger for each released fix whose branch does not exist yet,
// at most MAX_FIRES times and not again within REFIRE_AFTER_DAYS, and record
// the draft pull request once the branch has one. A run fires at most
// MAX_FIRES_PER_RUN fixes, spaced apart, and stops at the first failed call;
// the rest stay eligible for later checks. A dry run lists what would fire
// instead of firing. Injectable exec, fetch and pause.
import { eventLine } from './classify.mjs';
import { run } from './fetch.mjs';
import { toRecord } from './ledger-branch.mjs';

export const FIRE_URL = (routine) => `https://api.anthropic.com/v1/claude_code/routines/${routine}/fire`;
export const FIRE_HEADERS = { 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
export const REFIRE_AFTER_DAYS = 3;
export const PR_OBSERVE_DAYS = 7;
export const MAX_FIRES = 2;
export const FIRE_TIMEOUT_MS = 30_000;
// Sessions start gradually: a few per run, spaced apart; later checks revisit the rest.
export const MAX_FIRES_PER_RUN = 3;
export const FIRE_SPACING_MS = 15_000;
// The endpoint documents retries for HTTP 500/503, but has no idempotency key.
// These bounded retries do not guarantee that only one server-side session exists.
export const FIRE_ATTEMPTS = 3;
export const FIRE_BACKOFF_MS = 2_000;
// `gh pr list --head` matches the branch name in any fork; only a pull request
// from this repository is the routine's.
export const SAME_REPO_PR = '[.[] | select(.isCrossRepository | not)][0].number // empty';
const ROUTINE = /^trig_[A-Za-z0-9]+$/;
const DISPATCH_BRANCH = /^upstream\/[a-z0-9._-]+$/;
const DAY = 86_400_000;

function diagnostic(value, token) {
  if (typeof value !== 'string') return '';
  // Redact before bounding, so truncation cannot expose the start of a token.
  return value.split(token).join('[REDACTED]').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200);
}

export function sessionList(sessions) {
  if (sessions.length < 3) return sessions.join(' and ');
  return `${sessions.slice(0, -1).join(', ')}, and ${sessions.at(-1)}`;
}

export function createDispatcher({ exec = run, fetchImpl = globalThis.fetch, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return {
    async branchExists(branch) {
      if (!DISPATCH_BRANCH.test(branch ?? '')) throw new Error(`not a dispatch branch: ${branch}`);
      const result = await exec('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
      if (result.status === 0) return true;
      if (result.status === 2) return false;
      throw new Error(`git ls-remote origin ${branch} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
    },
    async openPullRequest(repo, branch) {
      const args = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository', '--jq', SAME_REPO_PR];
      const result = await exec('gh', args);
      if (result.status !== 0) throw new Error(`gh pr list --head ${branch} failed: ${(result.stderr || result.error?.message || 'no output').trim()}`);
      const text = result.stdout.trim();
      return text ? Number(text) : null;
    },
    /** One trigger call; returns the session link. The token never appears in an error. */
    async fire(text) {
      const routine = env.UPSTREAM_DISPATCH_ROUTINE ?? '';
      const token = env.UPSTREAM_DISPATCH_TOKEN ?? '';
      if (!ROUTINE.test(routine)) throw new Error('UPSTREAM_DISPATCH_ROUTINE is not a routine id');
      if (!token) throw new Error('UPSTREAM_DISPATCH_TOKEN is not set');
      let failure = '';
      for (let attempt = 1; attempt <= FIRE_ATTEMPTS; attempt++) {
        if (attempt > 1) await sleep(FIRE_BACKOFF_MS * (attempt - 1));
        const response = await fetchImpl(FIRE_URL(routine), {
          method: 'POST', headers: { ...FIRE_HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => null);
        const session = body?.claude_code_session_url;
        if (response.status === 200 && typeof session === 'string') return session;
        const requestId = diagnostic(response.headers?.get?.('request-id'), token);
        const detail = diagnostic(body?.error?.message ?? (typeof body?.error === 'string' ? body.error : ''), token);
        failure = `the routine trigger answered HTTP ${response.status}${typeof session === 'string' ? '' : ' without a session'}`
          + `${requestId ? ` (request-id ${requestId})` : ''}${detail ? `: ${detail}` : ''}`;
        if (typeof session === 'string' || ![500, 503].includes(response.status)) break;
      }
      throw new Error(failure);
    },
  };
}

/** Fire (or, in a dry run, list in `wouldFire`) each released fix; the branch and pull request lookups only read. */
export async function dispatch({ released, records, dispatcher, repo, sentinel, now, recordedAt, dryRun = false, eligibleIds = null, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const out = [];
  const errors = [];
  const wouldFire = [];
  const deferred = [];
  let attempted = 0;
  let triggerFailed = false;
  const today = recordedAt.slice(0, 10);
  const recordsOf = (id, event) => records.filter((item) => item.id === id && item.event === event);
  for (const event of released) {
    const { branch, version } = event.fields;
    try {
      if (await dispatcher.branchExists(branch)) continue;
      const firings = recordsOf(event.id, 'fired');
      if (firings.length >= MAX_FIRES) {
        errors.push({ id: event.id, error: `dispatch did not complete after ${firings.length} firings; see ${sessionList(firings.map((item) => item.fields.session))}` });
        continue;
      }
      const newest = Math.max(...firings.map((item) => Date.parse(item.recordedAt)), 0);
      if (newest && now.getTime() - newest < REFIRE_AFTER_DAYS * DAY) continue;
      if (triggerFailed || attempted >= MAX_FIRES_PER_RUN) {
        deferred.push({ id: event.id, version, branch });
        continue;
      }
      if (dryRun) {
        attempted++;
        wouldFire.push({ id: event.id, version, branch });
        continue;
      }
      if (attempted++) await pause(FIRE_SPACING_MS);
      try {
        const session = await dispatcher.fire(`${event.id} ${version} ${branch}`);
        out.push(toRecord(eventLine(sentinel, event.id, 'fired', today, { branch, session }), recordedAt));
      } catch (error) {
        triggerFailed = true;
        throw error;
      }
    } catch (error) {
      errors.push({ id: event.id, error: error.message });
    }
  }
  for (const id of new Set(records.filter((item) => item.event === 'fired').map((item) => item.id))) {
    if (recordsOf(id, 'dispatch-pr').length) continue;
    if (eligibleIds && !eligibleIds.has(id)) continue;
    const latestFiring = Math.max(...recordsOf(id, 'fired').map((item) => Date.parse(item.recordedAt)));
    if (!Number.isFinite(latestFiring) || now.getTime() - latestFiring >= PR_OBSERVE_DAYS * DAY) continue;
    try {
      const branch = recordsOf(id, 'fired').at(-1).fields.branch;
      const pr = await dispatcher.openPullRequest(repo, branch);
      if (pr) out.push(toRecord(eventLine(sentinel, id, 'dispatch-pr', today, { branch, pr }), recordedAt));
    } catch (error) {
      errors.push({ id, error: error.message });
    }
  }
  return { records: out, errors, wouldFire, deferred };
}
