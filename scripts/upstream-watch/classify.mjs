// Pure rules of the upstream watch: a registry entry plus the live GitHub and
// npm facts about its thread become report groups and ledger events. No I/O
// happens here, so every rule is exercised from recorded fixtures.

const DAY = 86_400_000;
const PROCESSED = new Set(['fixed-unreleased', 'released', 'dispatched', 'adopted', 'retired']);
const FIXED_STATUSES = new Set(['fixed-unreleased', 'released', 'dispatched', 'adopted']);
const PENDING = new Set(['watching', 'fixed-unreleased']);

export const GROUPS = [
  ['needs-reply', 'Needs our reply'],
  ['released-actionable', 'Released and actionable'],
  ['workaround-carried', 'Fixed upstream, ak still carries the workaround'],
  ['fixed-unreleased', 'Fixed upstream, not yet released'],
  ['reopened', 'Reopened upstream after ak recorded a fix'],
  ['waiting', 'Waiting on upstream'],
  ['stale', 'No upstream activity for the stale limit'],
  ['not-planned', 'Closed upstream as not planned'],
  ['ready-to-retire', 'Ready to retire'],
  ['constraints-due', 'Constraints past their retest date'],
  ['tracking', 'Tracking issues to migrate'],
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

/** Whether the fix has shipped, per the entry's doneWhen.release gate. */
export function releaseState(entry, fixedAt, facts) {
  const gate = entry.doneWhen.release;
  if (gate === null) return { released: true, basis: 'no release gate: closing is enough', version: null, date: day(fixedAt) };
  if (!facts) return { released: null, basis: `release facts for ${gate.name} unavailable`, version: null, date: null };
  if (gate.minVersion) {
    const published = facts.versions.find((item) => item.version === gate.minVersion)?.publishedAt ?? fixedAt;
    return facts.latest && compareVersions(facts.latest, gate.minVersion) >= 0
      ? { released: true, basis: 'first fixed version recorded in the registry', version: gate.minVersion, date: day(published) }
      : { released: false, basis: `${gate.name} ${facts.latest ?? 'has no release'} predates ${gate.minVersion}`, version: null, date: null };
  }
  const prerelease = facts.latest?.includes('-');
  const after = facts.versions
    .filter((item) => item.publishedAt > fixedAt && (prerelease || !item.version.includes('-')))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return after.length
    ? { released: true, candidate: true, basis: 'first version published after the fix; confirm it contains the fix', version: after[0].version, date: day(after[0].publishedAt) }
    : { released: false, basis: `no ${gate.name} release since the fix`, version: null, date: null };
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

const lastHistoryDate = (entry) => entry.history.at(-1).date;

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

/** Classify one non-retired entry; `live` is null when offline or the fetch failed. */
export function classifyEntry(entry, live, { policy, dependencyPolicies, now }) {
  const base = {
    id: entry.id, url: entry.url, title: entry.title, relation: entry.relation, status: entry.status,
    mapping: entry.mapping, adjustment: entry.adjustment, tracks: entry.tracks ?? null,
  };
  const fromRegistry = registryGroups(entry);
  if (!live || live.error) {
    const groups = live?.error ? ['unchecked', ...fromRegistry] : fromRegistry;
    return { ...base, groups: [...new Set(groups)], error: live?.error ?? null, upstream: null, dispatch: groups.includes('workaround-carried') ? dispatchFor(entry, policy, dependencyPolicies) : null };
  }
  const up = upstreamOf(live.thread);
  const facts = commentFacts(entry, live.thread, policy);
  const release = up.fixed && PENDING.has(entry.status) ? releaseState(entry, up.fixedAt, live.release) : null;
  const stale = up.state === 'open' && now.getTime() - Date.parse(facts.lastUpstreamActivityAt) >= policy.staleAfterDays * DAY;
  const groups = [...new Set([...liveGroups(entry, up, facts, release, stale), ...fromRegistry])];
  if (entry.relation === 'tracking') {
    for (const drop of ['waiting', 'stale']) if (groups.includes(drop)) groups.splice(groups.indexOf(drop), 1);
  }
  const actionable = groups.includes('released-actionable') || groups.includes('workaround-carried');
  return {
    ...base, groups, upstream: up, release, stale, ...facts,
    lastHistoryDate: lastHistoryDate(entry),
    dispatch: actionable ? dispatchFor(entry, policy, dependencyPolicies) : null,
  };
}

/** Assemble the report from the registry and whatever live facts were collected. */
export function buildReport(registry, liveById, { now, offline = null, fetchErrors = [] }) {
  const context = { policy: registry.watchPolicy, dependencyPolicies: registry.dependencyPolicies, now };
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
    registry: { status: registry.registryStatus, errors: registry.errors ?? [], lastVerifiedAt: registry.lastVerifiedAt, statuses },
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
    if (entry.groups.includes('released-actionable')) {
      events.push(eventLine(sentinel, entry.id, 'released', entry.release.date, {
        version: entry.release.version, candidate: entry.release.candidate ? 'yes' : null, branch: entry.dispatch.branch,
      }));
    }
    if (entry.groups.includes('reopened')) events.push(eventLine(sentinel, entry.id, 'reopened', entry.lastHistoryDate, { status: entry.status }));
    if (entry.groups.includes('stale')) events.push(eventLine(sentinel, entry.id, 'stale', day(entry.lastUpstreamActivityAt)));
    if (entry.groups.includes('ready-to-retire') && up) events.push(eventLine(sentinel, entry.id, 'retire-proposed', entry.lastHistoryDate ?? day(up.closedAt)));
  }
  for (const constraint of report.groups.find((group) => group.key === 'constraints-due').items) {
    events.push(eventLine(sentinel, constraint.id, 'retest-due', constraint.nextRetestAt));
  }
  if (report.nothingToWatch) events.push(eventLine(sentinel, 'registry', 'idle', registry.lastVerifiedAt));
  return events;
}

/** Drop events whose exact line already appears in the ledger text. */
export function withoutRecorded(events, ledgerText) {
  const recorded = new Set(String(ledgerText ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return events.filter((event) => !recorded.has(event.line));
}
