// Watched upstream threads: the registry's `watchPolicy` and `watch` list.
// This checks shape and the links into the rest of the registry. Which
// repositories count as upstream, and whether every source citation is
// registered, is maintainer tooling (scripts/upstream-watch/citations.mjs).

export const WATCH_RELATIONS = ['filed', 'commented', 'referenced', 'tracking'];
export const WATCH_STATUSES = ['watching', 'fixed-unreleased', 'released', 'dispatched', 'adopted', 'retired'];
// `reviewed`: the maintainer read every comment up to the end of that day and none needs a reply.
export const WATCH_HISTORY_EVENTS = ['filed', 'commented', 'closed', 'reopened', 'registered', 'reviewed', ...WATCH_STATUSES];
const KINDS = ['issue', 'pr'];
const DONE_STATES = ['closed-completed', 'merged'];
const RELEASE_CHANNELS = ['npm', 'github-release'];
const ENTRY_KEYS = new Set([
  'id', 'url', 'relation', 'kind', 'title', 'dependency', 'doneWhen', 'mapping', 'kitImpact',
  'adjustment', 'status', 'constraintIds', 'tracks', 'history', 'note',
]);
const ID = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_KEYS = new Set(['channel', 'name', 'minVersion', 'tagPattern', 'bundledBy']);
// Shared with the watch tooling (scripts/upstream-watch/); the schema spells them identically.
export const PACKAGE_NAME = /^[@A-Za-z0-9_][A-Za-z0-9_@./-]*$/;
export const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A tag spelling such as rust-v{version}; the watcher substitutes the version.
const TAG_PATTERN = /^[\w./-]*\{version\}[\w./-]*$/;
// A user or app login; apps comment as `<name>[bot]` (the workflow token as github-actions[bot]).
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
// A ledger branch name: no slashes, so it can never be a dispatch branch (`upstream/...`).
const LEDGER_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEDGER_KEYS = ['branch', 'sentinel'];
const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)$/;

const text = (value) => typeof value === 'string' && value.trim() !== '';
const texts = (value) => Array.isArray(value) && value.every(text);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validPattern(value) {
  try { new RegExp(value, 'u'); return true; } catch { return false; }
}

// The ledger names only a branch (no slash, so it can never collide with a
// dispatch branch) and an upper-case sentinel; nothing else.
function checkLedger(ledger, errors) {
  if (!isObject(ledger) || !LEDGER_BRANCH.test(ledger.branch ?? '') || String(ledger.branch).endsWith('.lock')
      || !/^[A-Z][A-Z-]+$/.test(ledger.sentinel ?? '') || Object.keys(ledger).some((key) => !LEDGER_KEYS.includes(key))) {
    errors.push('watchPolicy.ledger must name only a branch (no slash) and an upper-case sentinel');
  }
}

// The notice mentions one human GitHub login, never a bot.
function checkNotify(notify, errors) {
  if (!isObject(notify) || !GITHUB_LOGIN.test(notify.mention ?? '') || String(notify.mention).endsWith('[bot]')) {
    errors.push('watchPolicy.notify.mention must be the GitHub user a notice mentions');
  }
}

function checkPolicy(policy, errors) {
  if (!isObject(policy)) return errors.push('watchPolicy must be an object');
  if (!OWNER_REPO.test(policy.repo ?? '')) errors.push('watchPolicy.repo must name the home repository as owner/repo');
  if (!texts(policy.ours) || policy.ours.length === 0) errors.push('watchPolicy.ours must list our GitHub logins');
  if (!Number.isInteger(policy.staleAfterDays) || policy.staleAfterDays <= 0) errors.push('watchPolicy.staleAfterDays must be a positive integer');
  if (!texts(policy.automatedReplyPatterns) || !policy.automatedReplyPatterns.every(validPattern)) {
    errors.push('watchPolicy.automatedReplyPatterns must be valid regular expressions');
  }
  checkLedger(policy.ledger, errors);
  checkNotify(policy.notify, errors);
  const dispatch = policy.dispatch;
  if (!isObject(dispatch) || !/^[\w.-]+\/$/.test(dispatch.branchPrefix ?? '') || dispatch.pullRequest !== 'draft' || dispatch.merge !== 'never') {
    errors.push('watchPolicy.dispatch must use a branchPrefix, draft pull requests and merge never');
  }
  return errors;
}

function checkDoneWhen(doneWhen, kind, where, errors) {
  if (!isObject(doneWhen) || !DONE_STATES.includes(doneWhen.state)) {
    errors.push(`${where}: doneWhen.state must be one of ${DONE_STATES.join(', ')}`);
  } else if ((doneWhen.state === 'merged') !== (kind === 'pr')) {
    errors.push(`${where}: doneWhen.state must be merged for a pr and closed-completed for an issue`);
  }
  const release = doneWhen?.release;
  if (release === null) return;
  if (!isObject(release) || !RELEASE_CHANNELS.includes(release.channel) || !text(release.name)
      || !(release.minVersion === null || SEMVER.test(release.minVersion ?? ''))) {
    errors.push(`${where}: doneWhen.release must be null or { channel: npm|github-release, name, minVersion: null|semver }`);
    return;
  }
  for (const key of Object.keys(release)) if (!RELEASE_KEYS.has(key)) errors.push(`${where}: doneWhen.release has unknown key ${key}`);
  if (release.tagPattern !== undefined && !(typeof release.tagPattern === 'string' && TAG_PATTERN.test(release.tagPattern))) {
    errors.push(`${where}: doneWhen.release.tagPattern must contain {version}`);
  }
  if (release.bundledBy !== undefined && !(Array.isArray(release.bundledBy) && release.bundledBy.length > 0
      && release.bundledBy.every((pkg) => typeof pkg === 'string' && PACKAGE_NAME.test(pkg)))) {
    errors.push(`${where}: doneWhen.release.bundledBy must list the carrier packages`);
  }
}

function checkImpact(entry, where, errors) {
  if (entry.mapping === 'unmapped') {
    if (entry.kitImpact !== null || entry.adjustment !== null) errors.push(`${where}: an unmapped entry has null kitImpact and adjustment`);
    return;
  }
  if (entry.mapping !== 'mapped') return errors.push(`${where}: mapping must be mapped or unmapped`);
  const impact = entry.kitImpact;
  if (!isObject(impact) || !texts(impact.refs) || !texts(impact.files) || impact.refs.length + impact.files.length === 0
      || Object.keys(impact).some((key) => key !== 'refs' && key !== 'files')) {
    errors.push(`${where}: kitImpact must list refs or files when mapped`);
  }
  if (!text(entry.adjustment)) errors.push(`${where}: adjustment must describe the ak change when mapped`);
}

function checkHistory(history, where, errors) {
  if (!Array.isArray(history) || history.length === 0) return errors.push(`${where}: history must be a non-empty array`);
  let previous = '';
  history.forEach((item, index) => {
    if (!validDate(item?.date)) errors.push(`${where}: history[${index}].date is not a valid date`);
    else if (item.date < previous) errors.push(`${where}: history[${index}] goes back in time`);
    else previous = item.date;
    if (!WATCH_HISTORY_EVENTS.includes(item?.event)) errors.push(`${where}: history[${index}].event is unknown`);
    if (Object.keys(item ?? {}).some((key) => !['date', 'event', 'note'].includes(key))) errors.push(`${where}: history[${index}] has an unknown key`);
  });
}

function checkRelation(entry, repo, where, context, errors) {
  if (!WATCH_RELATIONS.includes(entry.relation)) return errors.push(`${where}: relation must be one of ${WATCH_RELATIONS.join(', ')}`);
  if (entry.relation === 'tracking') {
    if (repo !== context.homeRepo) errors.push(`${where}: a tracking entry must live in the home repository (watchPolicy.repo)`);
    if (!texts(entry.tracks) || entry.tracks.length === 0) errors.push(`${where}: a tracking entry must list the threads it tracks`);
    if (entry.dependency !== null) errors.push(`${where}: a tracking entry has no dependency`);
    return;
  }
  if (entry.tracks !== undefined) errors.push(`${where}: only a tracking entry has tracks`);
  if (!context.policyNames.has(entry.dependency)) errors.push(`${where}: dependency ${entry.dependency} has no dependency policy`);
}

function checkEntry(entry, context, errors) {
  const where = text(entry?.id) ? entry.id : '(watch entry without id)';
  if (!isObject(entry)) return errors.push(`${where}: must be an object`);
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`${where}: unknown key ${key}`);
  const match = ID.exec(entry.id ?? '');
  if (!match) return errors.push(`${where}: id must be owner/repo#number`);
  const [, owner, repo, number] = match;
  if (!KINDS.includes(entry.kind)) errors.push(`${where}: kind must be issue or pr`);
  const url = `https://github.com/${owner}/${repo}/${entry.kind === 'pr' ? 'pull' : 'issues'}/${number}`;
  if (entry.url !== url) errors.push(`${where}: url must be ${url}`);
  if (!text(entry.title)) errors.push(`${where}: title is required`);
  if (!WATCH_STATUSES.includes(entry.status)) errors.push(`${where}: status must be one of ${WATCH_STATUSES.join(', ')}`);
  if (entry.note !== undefined && !text(entry.note)) errors.push(`${where}: note must be text`);
  if (!Array.isArray(entry.constraintIds)) errors.push(`${where}: constraintIds must be an array`);
  for (const id of entry.constraintIds ?? []) if (!context.constraintIds.has(id)) errors.push(`${where}: unknown constraint ${id}`);
  checkRelation(entry, `${owner}/${repo}`, where, context, errors);
  checkDoneWhen(entry.doneWhen, entry.kind, where, errors);
  checkImpact(entry, where, errors);
  checkHistory(entry.history, where, errors);
}

function checkLinks(watch, constraints, errors) {
  const byId = new Map(watch.map((entry) => [String(entry?.id).toLowerCase(), entry]));
  for (const entry of watch) {
    for (const tracked of entry?.relation === 'tracking' && Array.isArray(entry.tracks) ? entry.tracks : []) {
      if (!byId.has(String(tracked).toLowerCase())) errors.push(`${entry.id}: tracks unregistered ${tracked}`);
    }
  }
  for (const constraint of constraints) {
    const match = ISSUE_URL.exec(constraint?.issue ?? '');
    if (!match) continue;
    const id = `${match[1]}#${match[2]}`;
    const entry = byId.get(id.toLowerCase());
    if (!entry || !(entry.constraintIds ?? []).includes(constraint.id)) {
      errors.push(`constraint ${constraint.id} needs watch entry ${id} listing it in constraintIds`);
    }
  }
}

/** Validate the watch policy and list; returns the entries and every problem found. */
export function validateWatch(document, { policyNames, constraintIds, constraints }) {
  const errors = [];
  checkPolicy(document?.watchPolicy, errors);
  if (!Array.isArray(document?.watch)) return { watchPolicy: null, watch: [], errors: [...errors, 'watch must be an array'] };
  const context = { policyNames, constraintIds, homeRepo: document.watchPolicy?.repo };
  const seen = new Set();
  for (const entry of document.watch) {
    const key = String(entry?.id).toLowerCase();
    if (seen.has(key)) errors.push(`${entry?.id}: duplicate watch entry`);
    seen.add(key);
    checkEntry(entry, context, errors);
  }
  checkLinks(document.watch, constraints, errors);
  return { watchPolicy: document.watchPolicy ?? null, watch: document.watch, errors };
}
