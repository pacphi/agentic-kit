// Additive read model over precisely the sessions the usage window admitted.
// Legacy label-keyed aggregates and session navigation stay unchanged.
const round = (value) => Math.round(value * 1e6) / 1e6;
const originValues = (session) => ['claude-desktop', 'codex-desktop'].includes(session.sessionOrigin?.origin)
  && session.sessionOrigin.origin === `${session.host}-desktop`
  ? [session.sessionOrigin.origin] : [];
function empty(key, label, kind) {
  return { key, label, kind, cost: 0, sessions: 0, minutes: 0, tokens: 0, origins: new Set() };
}
function add(row, session) {
  row.cost += Number(session.cost) || 0;
  row.sessions++;
  row.minutes += Number(session.minutes) || 0;
  row.tokens += Number(session.tokens) || 0;
  for (const origin of originValues(session)) row.origins.add(origin);
}
function finish(row) {
  return { ...row, cost: round(row.cost), minutes: round(row.minutes), origins: [...row.origins].sort() };
}
const ranked = (a, b) => b.cost - a.cost || a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

function groupDescriptor(session) {
  const evidence = session.projectEvidence, repo = evidence?.repositoryId;
  return empty(repo ?? evidence?.key ?? 'unclassified',
    repo ? evidence.repositoryLabel ?? 'Repository' : evidence?.label ?? 'Unclassified',
    repo ? 'repository' : evidence?.kind ?? 'unknown');
}
function memberDescriptor(session) {
  const evidence = session.projectEvidence;
  return { ...empty(evidence?.key ?? `${session.host ?? 'unknown'}:${session.id}`,
    evidence?.label ?? session.project ?? 'Unclassified', evidence?.kind ?? 'unknown'),
  reportedLabels: new Set(), sessionRefs: [], evidence: evidence?.evidence ?? 'unclassified',
  observedAt: evidence?.observedAt ?? null, observationBasis: evidence?.observationBasis ?? null };
}

export function buildUsageProjectGroups(sessions) {
  const groups = new Map();
  for (const session of sessions ?? []) {
    const descriptor = groupDescriptor(session);
    if (!groups.has(descriptor.key)) groups.set(descriptor.key, { ...descriptor, members: new Map() });
    const group = groups.get(descriptor.key);
    add(group, session);
    const memberInfo = memberDescriptor(session);
    if (!group.members.has(memberInfo.key)) group.members.set(memberInfo.key, memberInfo);
    const member = group.members.get(memberInfo.key);
    add(member, session);
    if (session.project) member.reportedLabels.add(session.project);
    member.sessionRefs.push({ id: session.id, host: session.host ?? 'unknown', cost: session.cost, start: session.start ?? null });
  }
  return [...groups.values()].map((group) => ({ ...finish(group), members: [...group.members.values()]
    .map((member) => ({ ...finish(member), reportedLabels: [...member.reportedLabels].sort() })).sort(ranked) })).sort(ranked);
}

/** Ranking population: existing Git projects only, with verified worktrees
 * charged to their real parent. Unknown/legacy/user-level observations remain
 * in overall usage totals, but cannot become a Git-ranking candidate. */
export function buildUsageGitProjects(sessions) {
  const repositories = new Map();
  for (const session of sessions ?? []) {
    const evidence = session.projectEvidence;
    if (!evidence || evidence.parentRootExists !== true || evidence.userLevel !== false
      || !/^repository:[a-f0-9]{20}$/u.test(evidence.repositoryId ?? '')
      || !(evidence.kind === 'git' && ['git-directory', 'git-pointer'].includes(evidence.evidence)
        || evidence.kind === 'worktree' && evidence.evidence === 'git-common-directory-and-backlink')) continue;
    const key = evidence.repositoryId;
    if (!repositories.has(key)) repositories.set(key, {
      key, label: evidence.repositoryLabel ?? 'Repository', cost: 0, sessions: 0, minutes: 0, tokens: 0,
    });
    const row = repositories.get(key);
    row.sessions++;
    for (const field of ['cost', 'minutes', 'tokens']) row[field] += Number(session[field]) || 0;
  }
  return [...repositories.values()].map((row) => ({ ...row, cost: round(row.cost), minutes: round(row.minutes) })).sort(ranked);
}
