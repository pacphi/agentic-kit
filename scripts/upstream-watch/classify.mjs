// Pure rules of the upstream watch: a registry entry plus the live GitHub and
// npm facts about its thread become report groups and ledger events. No I/O
// happens here, so every rule is exercised from recorded fixtures.

const DAY = 86_400_000;
// History events after which earlier upstream comments no longer need our reply:
// a status change, or `reviewed` (read, nothing asked of ak). Staleness ignores them.
const PROCESSED = new Set(['fixed-unreleased', 'released', 'dispatched', 'adopted', 'retired', 'reviewed']);
const FIXED_STATUSES = new Set(['fixed-unreleased', 'released', 'dispatched', 'adopted']);
const PENDING = new Set(['watching', 'fixed-unreleased']);

export const GROUPS = [
  ['needs-reply', 'Needs our reply'],
  ['released-actionable', 'Released and actionable'],
  ['release-unconfirmed', 'Released, fix not confirmed'],
  ['workaround-carried', 'Fixed upstream, ak still carries the workaround'],
  ['waiting-for-window', 'Released, waiting for the support window'],
  ['fixed-unreleased', 'Fixed upstream, not yet released'],
  ['reopened', 'Reopened upstream after ak recorded a fix'],
  ['waiting', 'Waiting on upstream'],
  ['stale', 'No upstream activity for the stale limit'],
  ['not-planned', 'Closed upstream as not planned'],
  ['ready-to-retire', 'Ready to retire'],
  ['constraints-due', 'Constraints past their retest date'],
  ['tracking', 'Our tracking issues'],
  ['unmapped', 'Unmapped (no ak change recorded)'],
  ['unchecked', 'Could not check'],
];

const day = (iso) => (iso ? iso.slice(0, 10) : null);
const endOfDay = (date) => `${date}T23:59:59Z`;
const latest = (values) => values.filter(Boolean).sort().at(-1) ?? null;

function parseVersion(version) {
  const dash = version.indexOf('-');
  const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map(Number);
  return { core, pre: dash < 0 ? null : version.slice(dash + 1).split('.') };
}

/** Semver precedence: -1, 0 or 1. Prerelease identifiers follow semver 2.0 ordering. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (p === q) continue;
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The highest version by semver of `npm view <pkg>@<range> version --json` (a string or an array). */
export function maxVersion(values) {
  const list = [].concat(values ?? []).filter((value) => typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value));
  return list.sort(compareVersions).at(-1) ?? null;
}

/** Normalize `npm view <pkg> time dist-tags --json` or a GitHub releases list. */
export function releaseFacts(channel, raw) {
  if (channel === 'npm') {
    const versions = Object.entries(raw?.time ?? {})
      .filter(([version]) => /^\d+\.\d+\.\d+/.test(version))
      .map(([version, publishedAt]) => ({ version, publishedAt }));
    return { versions, latest: raw?.['dist-tags']?.latest ?? null };
  }
  const versions = (Array.isArray(raw) ? raw : []).filter((release) => !release.draft)
    .map((release) => ({ version: String(release.tag_name).replace(/^v/, ''), publishedAt: release.published_at, prerelease: release.prerelease }))
    .filter((release) => /^\d+\.\d+\.\d+/.test(release.version));
  const stable = versions.filter((release) => !release.prerelease).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { versions, latest: stable[0]?.version ?? null };
}

/** Upstream state of a thread from the GitHub issues API (PRs included). */
export function upstreamOf(thread) {
  const issue = thread.issue;
  const isPr = Boolean(issue.pull_request);
  const mergedAt = issue.pull_request?.merged_at ?? null;
  const reason = issue.state === 'closed' && !isPr ? issue.state_reason ?? 'completed' : issue.state_reason ?? null;
  const fixed = isPr ? Boolean(mergedAt) : issue.state === 'closed' && reason === 'completed';
  return {
    state: issue.state, reason, isPr, mergedAt, closedAt: issue.closed_at ?? null,
    updatedAt: issue.updated_at, fixed, fixedAt: fixed ? mergedAt ?? issue.closed_at : null,
  };
}

// How many releases after a fix are checked, oldest first, before the newest.
const CONFIRM_LIMIT = 5;

/**
 * When the release walk starts: the merge of the fixing pull request, so an
 * issue closed after the release that shipped its fix still finds it. A
 * closing commit has no merge time; it closes the thread as it lands on the
 * default branch, so the close time (`fixedAt`) stands.
 */
export function confirmationStart(fixedAt, confirmation) {
  return confirmation?.changes?.[0]?.mergedAt ?? fixedAt;
}

/** Releases published after the fix, oldest first: stable only unless `latest` is a prerelease. */
export function candidateVersions(fixedAt, facts, limit = Infinity) {
  const prerelease = facts.latest?.includes('-');
  return facts.versions
    .filter((item) => item.publishedAt > fixedAt && (prerelease || !item.version.includes('-')))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(0, limit);
}

// The candidate ak would install: `latest` when it is one, else the highest
// version. A backport published after it on an older line is not it.
function newestCandidate(candidates, facts) {
  return candidates.find((item) => item.version === facts.latest)
    ?? candidates.reduce((best, item) => (!best || compareVersions(item.version, best.version) > 0 ? item : best), null);
}

/**
 * The next release whose tag to check, or null when the walk is done. The
 * first CONFIRM_LIMIT candidates go oldest first, stopping at any that is not
 * ruled out. If all of them lack the fix, the newest is checked; when it has
 * the fix, the releases between go oldest first, so the released version is
 * always the oldest containing one and a newer release never changes it.
 */
export function nextRelease(candidates, checks, facts, limit = CONFIRM_LIMIT) {
  const seen = new Map(checks.map((check) => [check.version, check.contained]));
  const step = (list) => {
    for (const item of list) {
      if (!seen.has(item.version)) return item;
      if (seen.get(item.version) !== false) return null;
    }
    return undefined;
  };
  const first = step(candidates.slice(0, limit));
  if (first !== undefined) return first;
  const newest = newestCandidate(candidates, facts);
  const at = candidates.indexOf(newest);
  if (!newest || at < limit) return null;
  if (!seen.has(newest.version)) return newest;
  if (seen.get(newest.version) !== true) return null;
  return step(candidates.slice(limit, at)) ?? null;
}

/** The tag names a release gate's version may carry upstream, in the order to try them. */
export function tagRefs(gate, version) {
  return gate.tagPattern ? [gate.tagPattern.replace('{version}', version)] : [`v${version}`, version];
}

const changeLabel = (change) => (change.pr ? `PR #${change.pr}` : `commit ${change.sha.slice(0, 7)}`);

/**
 * A package ak gets through another (AgentDB through Ruflo) is released only
 * when the newest carrier installs a fixed version. `base` is the package's
 * own release state; `bundle` is what the carrier resolves it to.
 */
function bundledState(gate, base, bundle) {
  const unresolved = `could not resolve the ${gate.name} that ${gate.bundledBy[0]} bundles`;
  // A failed resolution is "Could not check" whether or not the package's own release is confirmed.
  if (!bundle && (base.released === true || base.released === 'unconfirmed')) {
    return { released: null, basis: base.released === true ? unresolved : `${base.basis}; ${unresolved}`, version: null, date: null };
  }
  const carries = bundle ? `${bundle.carrier} ${bundle.carrierVersion} bundles ${gate.name} ${bundle.version ?? 'none'}` : null;
  if (base.released === 'unconfirmed') return { ...base, basis: `${base.basis}; ${carries}` };
  if (base.released !== true) return base;
  if (!bundle.version || compareVersions(bundle.version, base.version) < 0) {
    return { released: false, basis: `${carries}, before the fix in ${base.version}`, version: null, date: null };
  }
  // Version and date stay the fixed package's, so a new carrier release never changes the ledger line;
  // the carrier that bundles it is reported beside them.
  return { ...base, carrierVersion: bundle.carrierVersion, basis: `${base.basis}; ${carries}` };
}

/**
 * Whether the fix has shipped, per the entry's doneWhen.release gate. Without
 * a recorded first fixed version, a release counts only when it contains the
 * merged fixing change (`confirmation`, from the fetcher); a release ak cannot
 * prove is 'unconfirmed' and is never dispatched. A gate with `bundledBy`
 * also needs the newest carrier to install the fixed version (`bundle`).
 */
export function releaseState(entry, fixedAt, facts, confirmation = null, bundle = null) {
  const own = ownReleaseState(entry.doneWhen.release, fixedAt, facts, confirmation);
  const gate = entry.doneWhen.release;
  return gate?.bundledBy ? bundledState(gate, own, bundle) : own;
}

function ownReleaseState(gate, fixedAt, facts, confirmation) {
  if (gate === null) return { released: true, basis: 'no release gate: closing is enough', version: null, date: day(fixedAt) };
  if (!facts) return { released: null, basis: `release facts for ${gate.name} unavailable`, version: null, date: null };
  if (confirmation?.error) return { released: null, basis: `could not confirm the ${gate.name} release: ${confirmation.error}`, version: null, date: null };
  if (gate.minVersion) {
    const published = facts.versions.find((item) => item.version === gate.minVersion)?.publishedAt ?? fixedAt;
    return facts.latest && compareVersions(facts.latest, gate.minVersion) >= 0
      ? { released: true, basis: 'first fixed version recorded in the registry', version: gate.minVersion, date: day(published) }
      : { released: false, basis: `${gate.name} ${facts.latest ?? 'has no release'} predates ${gate.minVersion}`, version: null, date: null };
  }
  const after = candidateVersions(confirmationStart(fixedAt, confirmation), facts);
  if (!after.length) return { released: false, basis: `no ${gate.name} release since the fix`, version: null, date: null };
  const change = confirmation?.changes?.[0] ?? null;
  const checks = confirmation?.checks ?? [];
  const found = new Map(checks.map((check) => [check.version, check]));
  const newest = newestCandidate(after, facts);
  if (change && found.get(newest.version)?.contained === false && checks.every((check) => check.contained === false)) {
    return { released: false, basis: `none of the ${checks.length} ${gate.name} release(s) checked after the fix, ${newest.version} included, contains ${changeLabel(change)}`, version: null, date: null };
  }
  // The oldest release not ruled out: released when its tag contains the change, else unconfirmed.
  const first = after.find((item) => found.get(item.version)?.contained !== false) ?? after[0];
  const hit = found.get(first.version);
  if (change && hit?.contained === true) {
    return {
      released: true, confirmed: true, version: first.version, date: day(first.publishedAt), change, ref: hit.ref,
      basis: `merged ${changeLabel(change)} is in ${hit.ref}`,
    };
  }
  return {
    released: 'unconfirmed', version: first.version, date: day(first.publishedAt),
    basis: change
      ? `no tag found to prove ${changeLabel(change)} is in ${gate.name} ${first.version}`
      : 'no merged pull request or commit closed the thread; confirm by hand and record minVersion',
  };
}

function commentFacts(entry, thread, policy) {
  const ours = new Set(policy.ours.map((login) => login.toLowerCase()));
  const patterns = policy.automatedReplyPatterns.map((pattern) => new RegExp(pattern, 'u'));
  const mine = (login) => ours.has(String(login).toLowerCase());
  const bot = (comment) => comment.user?.type === 'Bot' || /\[bot\]$/i.test(comment.user?.login ?? '') || Boolean(comment.performed_via_github_app);
  const lastOurWordAt = latest([
    mine(thread.issue.user?.login) ? thread.issue.created_at : null,
    ...thread.comments.filter((comment) => mine(comment.user?.login)).map((comment) => comment.created_at),
  ]);
  // A registry status change records that we acted on everything before it.
  const processed = latest(entry.history.filter((item) => PROCESSED.has(item.event)).map((item) => endOfDay(item.date)));
  const since = latest([lastOurWordAt, processed]);
  const others = since === null ? [] : thread.comments.filter((comment) => comment.created_at > since && !mine(comment.user?.login) && !bot(comment));
  const automated = (comment) => patterns.some((pattern) => pattern.test(comment.body ?? ''));
  const upstreamActivity = latest([
    mine(thread.issue.user?.login) ? null : thread.issue.created_at,
    ...thread.comments.filter((comment) => !mine(comment.user?.login) && !bot(comment)).map((comment) => comment.created_at),
  ]) ?? thread.issue.created_at;
  return {
    lastOurWordAt,
    replies: others.filter((comment) => !automated(comment)).map((comment) => ({ by: comment.user.login, at: comment.created_at })),
    acknowledgements: others.filter(automated).map((comment) => ({ by: comment.user.login, at: comment.created_at })),
    lastUpstreamActivityAt: upstreamActivity,
  };
}

// A `reviewed` line records reading, not a lifecycle change, so it never re-dates a ledger line.
const lastHistoryDate = (entry) => entry.history.filter((item) => item.event !== 'reviewed').at(-1)?.date ?? entry.history.at(-1).date;

function liveGroups(entry, up, facts, release, stale) {
  const groups = [];
  const mapped = entry.mapping === 'mapped';
  if (facts.replies.length) groups.push('needs-reply');
  if (up.state === 'open') {
    if (FIXED_STATUSES.has(entry.status)) groups.push('reopened');
    else if (stale) groups.push('stale');
    else if (!facts.replies.length) groups.push('waiting');
  }
  if (up.fixed && PENDING.has(entry.status) && mapped) {
    if (release?.released === true) groups.push('released-actionable');
    else if (release?.released === 'unconfirmed') groups.push('release-unconfirmed');
    else if (release?.released === false) groups.push('fixed-unreleased');
    else groups.push('unchecked');
  }
  if (up.state === 'closed' && up.reason === 'not_planned') groups.push('not-planned');
  if (up.state === 'closed' && (!mapped || entry.status === 'adopted' || entry.relation === 'tracking')) groups.push('ready-to-retire');
  return groups;
}

function registryGroups(entry) {
  const groups = [];
  if (entry.relation === 'tracking') groups.push('tracking');
  if (['released', 'dispatched'].includes(entry.status) && entry.mapping === 'mapped') groups.push('workaround-carried');
  if (entry.status === 'adopted') groups.push('ready-to-retire');
  if (entry.mapping === 'unmapped') groups.push('unmapped');
  return groups;
}

function dispatchFor(entry, policy, dependencyPolicies) {
  const slug = entry.id.toLowerCase().replace(/[/#]/g, '-');
  const removalProof = dependencyPolicies.find((item) => item.dependency === entry.dependency)?.removalProof ?? null;
  return { branch: `${policy.dispatch.branchPrefix}${slug}`, pullRequest: policy.dispatch.pullRequest, merge: policy.dispatch.merge, removalProof, adjustment: entry.adjustment };
}

const ACT_NOW = new Set(['released-actionable', 'workaround-carried']);

/**
 * ADR-0041 §7: a Ruflo workaround comes out only once the oldest supported
 * Ruflo (the support-window floor) contains the fix. Returns the hold, or
 * null when there is no window, the fix version is unknown, or it is in. A
 * floor that could not be read (`floorUnknown`) holds every Ruflo-carried fix:
 * dispatch runs without a human, so an unread floor never releases one.
 */
function windowHold(entry, release, supportFloor, floorBundle = null, floorUnknown = false) {
  const gate = entry.doneWhen?.release;
  if (!gate) return null;
  if (!supportFloor) {
    const carried = gate.bundledBy?.[0] === 'ruflo' || (entry.dependency === 'ruflo' && gate.name === 'ruflo');
    const needs = gate.minVersion ?? release?.version ?? null;
    return floorUnknown && carried && needs ? { floor: null, needs: gate.bundledBy ? `${gate.name} ${needs}` : needs } : null;
  }
  if (gate.bundledBy?.[0] === 'ruflo') return bundledHold(gate, release, supportFloor, floorBundle);
  if (entry.dependency !== 'ruflo' || gate.name !== 'ruflo') return null;
  const needs = gate.minVersion ?? release?.version ?? null;
  return needs && compareVersions(needs, supportFloor) > 0 ? { floor: supportFloor, needs } : null;
}

/**
 * Decision B3-D5: a fix delivered through Ruflo (AgentDB) waits until the
 * oldest supported Ruflo bundles a fixed version (`floorBundle`, resolved
 * like the newest carrier's). An unresolved floor never releases it.
 */
function bundledHold(gate, release, floor, floorBundle) {
  const needs = release?.version ?? gate.minVersion ?? null;
  if (!needs) return null;
  const has = floorBundle ? floorBundle.version ?? 'none' : 'unknown';
  if (floorBundle?.version && compareVersions(floorBundle.version, needs) >= 0) return null;
  return { floor, needs: `${gate.name} ${needs}`, floorBundles: `${gate.name} ${has}` };
}

/** A newest-carrier release whose floor bundle could not be resolved is "Could not check", as the newest one is. */
function floorChecked(gate, release, supportFloor, floorBundle) {
  if (!supportFloor || gate?.bundledBy?.[0] !== 'ruflo' || release?.released !== true || floorBundle) return release;
  return { released: null, basis: `could not resolve the ${gate.name} that ${gate.bundledBy[0]} ${supportFloor} bundles`, version: null, date: null };
}

/** Swap the act-now groups for `waiting-for-window` on a held entry. */
function applyHold(groups, hold) {
  if (!hold || !groups.some((group) => ACT_NOW.has(group))) return { groups, hold: null };
  return { groups: [...groups.filter((group) => !ACT_NOW.has(group)), 'waiting-for-window'], hold };
}

/** Classify one non-retired entry; `live` is null when offline or the fetch failed. */
export function classifyEntry(entry, live, { policy, dependencyPolicies, now, supportFloor = null, floorUnknown = false }) {
  const base = {
    id: entry.id, url: entry.url, title: entry.title, relation: entry.relation, status: entry.status,
    mapping: entry.mapping, adjustment: entry.adjustment, tracks: entry.tracks ?? null,
  };
  const fromRegistry = registryGroups(entry);
  if (!live || live.error) {
    const held = applyHold([...new Set(live?.error ? ['unchecked', ...fromRegistry] : fromRegistry)], windowHold(entry, null, supportFloor, null, floorUnknown));
    return {
      ...base, groups: held.groups, error: live?.error ?? null, upstream: null, ...(held.hold ? { window: held.hold } : {}),
      dispatch: held.groups.includes('workaround-carried') ? dispatchFor(entry, policy, dependencyPolicies) : null,
    };
  }
  const up = upstreamOf(live.thread);
  const facts = commentFacts(entry, live.thread, policy);
  const release = up.fixed && PENDING.has(entry.status)
    ? floorChecked(entry.doneWhen.release, releaseState(entry, up.fixedAt, live.release, live.confirmation ?? null, live.bundle ?? null), supportFloor, live.floorBundle ?? null)
    : null;
  const stale = up.state === 'open' && now.getTime() - Date.parse(facts.lastUpstreamActivityAt) >= policy.staleAfterDays * DAY;
  const found = [...new Set([...liveGroups(entry, up, facts, release, stale), ...fromRegistry])];
  if (entry.relation === 'tracking') {
    for (const drop of ['waiting', 'stale']) if (found.includes(drop)) found.splice(found.indexOf(drop), 1);
  }
  const { groups, hold } = applyHold(found, windowHold(entry, release, supportFloor, live.floorBundle ?? null, floorUnknown));
  const actionable = groups.includes('released-actionable') || groups.includes('workaround-carried');
  return {
    ...base, groups, upstream: up, release, stale, ...facts, ...(hold ? { window: hold } : {}),
    lastHistoryDate: lastHistoryDate(entry),
    dispatch: actionable ? dispatchFor(entry, policy, dependencyPolicies) : null,
  };
}

/** Assemble the report from the registry and whatever live facts were collected. */
export function buildReport(registry, liveById, { now, offline = null, fetchErrors = [], supportFloor = null, floorUnknown = false }) {
  const context = { policy: registry.watchPolicy, dependencyPolicies: registry.dependencyPolicies, now, supportFloor, floorUnknown };
  const active = registry.watch.filter((entry) => entry.status !== 'retired');
  const entries = active.map((entry) => classifyEntry(entry, offline ? null : liveById.get(entry.id) ?? null, context));
  const today = now.toISOString().slice(0, 10);
  const constraintsDue = registry.constraints.filter((constraint) => constraint.nextRetestAt < today)
    .map((constraint) => ({ id: constraint.id, dependency: constraint.dependency, nextRetestAt: constraint.nextRetestAt, issue: constraint.issue ?? constraint.releaseUrl ?? null }));
  const groups = GROUPS.map(([key, label]) => ({
    key,
    label: key === 'stale' ? `No upstream activity for ${registry.watchPolicy.staleAfterDays}+ days` : label,
    items: key === 'constraints-due' ? constraintsDue : entries.filter((entry) => entry.groups.includes(key)),
  }));
  const statuses = Object.fromEntries(['watching', 'fixed-unreleased', 'released', 'dispatched', 'adopted', 'retired']
    .map((status) => [status, registry.watch.filter((entry) => entry.status === status).length]));
  return {
    generatedAt: now.toISOString(),
    mode: offline ? 'offline' : 'live',
    offlineReason: offline,
    supportWindow: { floor: supportFloor, ...(floorUnknown ? { unknown: true } : {}) },
    registry: { status: registry.registryStatus, errors: registry.errors ?? [], lastVerifiedAt: registry.lastVerifiedAt, lastCheckedAt: registry.lastCheckedAt, statuses },
    counts: Object.fromEntries(groups.map((group) => [group.key, group.items.length])),
    groups,
    entries,
    fetchErrors,
    nothingToWatch: active.filter((entry) => entry.relation !== 'tracking').length === 0,
  };
}

function eventLine(sentinel, id, event, date, fields = {}) {
  const extra = Object.entries(fields).filter(([, value]) => value != null).map(([key, value]) => `${key}=${value}`);
  return { id, event, date, fields, line: [sentinel, id, event, date, ...extra].join(' ') };
}

/**
 * Ledger events. Upstream activity (replies, acknowledgements, closes, merges)
 * is limited to `since`; state events (released, reopened, stale, retirement,
 * retests, idle) carry a stable date and repeat until the registry changes,
 * so the ledger's existing lines are what suppress repeats.
 */
export function ledgerEvents(report, registry, { since }) {
  const sentinel = registry.watchPolicy.ledger.sentinel;
  const events = [];
  for (const entry of report.entries) {
    // `at` keeps each comment its own line, even two by one person on one day.
    for (const reply of entry.replies ?? []) {
      if (reply.at > since) events.push(eventLine(sentinel, entry.id, 'reply', day(reply.at), { by: reply.by, at: reply.at.slice(11) }));
    }
    for (const ack of entry.acknowledgements ?? []) {
      if (ack.at > since) events.push(eventLine(sentinel, entry.id, 'acknowledged', day(ack.at), { by: ack.by, at: ack.at.slice(11) }));
    }
    const up = entry.upstream;
    if (up?.isPr && up.mergedAt && up.mergedAt > since) events.push(eventLine(sentinel, entry.id, 'merged', day(up.mergedAt)));
    else if (up?.state === 'closed' && up.closedAt > since) events.push(eventLine(sentinel, entry.id, 'closed', day(up.closedAt), { reason: up.reason }));
    // A release held for the support window is still a release: the line
    // carries no dispatch branch until the floor contains the fix.
    if (entry.groups.includes('released-actionable') || (entry.window && entry.release?.released === true)) {
      events.push(eventLine(sentinel, entry.id, 'released', entry.release.date, {
        version: entry.release.version,
        pr: entry.release.change?.pr ?? null,
        commit: entry.release.change && !entry.release.change.pr ? entry.release.change.sha.slice(0, 7) : null,
        branch: entry.dispatch?.branch,
      }));
    }
    if (entry.groups.includes('reopened')) events.push(eventLine(sentinel, entry.id, 'reopened', entry.lastHistoryDate, { status: entry.status }));
    if (entry.groups.includes('stale')) events.push(eventLine(sentinel, entry.id, 'stale', day(entry.lastUpstreamActivityAt)));
    if (entry.groups.includes('ready-to-retire') && up) events.push(eventLine(sentinel, entry.id, 'retire-proposed', entry.lastHistoryDate ?? day(up.closedAt)));
  }
  for (const constraint of report.groups.find((group) => group.key === 'constraints-due').items) {
    events.push(eventLine(sentinel, constraint.id, 'retest-due', constraint.nextRetestAt));
  }
  if (report.nothingToWatch) events.push(eventLine(sentinel, 'registry', 'idle', registry.lastCheckedAt));
  return events;
}

/** Drop events whose exact line already appears in the ledger text. */
export function withoutRecorded(events, ledgerText) {
  const recorded = new Set(String(ledgerText ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return events.filter((event) => !recorded.has(event.line));
}
