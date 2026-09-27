// Plain-text rendering of the upstream watch report and ledger events:
// counts first, then each non-empty group with links and the next action.

const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown');

function detail(key, item) {
  switch (key) {
    case 'needs-reply': {
      const last = item.replies.at(-1);
      return [`${last.by} replied ${day(last.at)} (${item.replies.length} comment(s) since our last word)`];
    }
    case 'released-actionable':
      return [
        `released in ${item.release.version ?? 'a release'} (${item.release.date ?? 'date unknown'}); ${item.release.basis ?? 'first fixed version recorded in the registry'}`,
        `dispatch: branch ${item.dispatch.branch}, ${item.dispatch.pullRequest} pull request, merge ${item.dispatch.merge}`,
        `change: ${item.adjustment}`,
        `removal proof: ${item.dispatch.removalProof ?? 'none recorded for this dependency'}`,
      ];
    case 'release-unconfirmed':
      return [
        `${item.release.version} (${item.release.date}) is the first release after the fix not ruled out; ${item.release.basis}`,
        `change once confirmed: ${item.adjustment}`,
      ];
    case 'waiting-for-window':
      return [
        item.window.floorBundles
          ? `fixed in ${item.window.needs}; the oldest supported Ruflo, ${item.window.floor}, bundles ${item.window.floorBundles}, so ak keeps the workaround until the support window's floor bundles the fix`
          : `fixed in ${item.window.needs}; the oldest supported Ruflo is ${item.window.floor}, so ak keeps the workaround until the support window's floor reaches ${item.window.needs}`,
        `change: ${item.adjustment}`,
      ];
    case 'workaround-carried':
      return [`status ${item.status}; branch ${item.dispatch?.branch ?? 'n/a'}`, `change: ${item.adjustment}`];
    case 'fixed-unreleased':
      return [`fixed upstream ${day(item.upstream.fixedAt)}; ${item.release.basis}`];
    case 'reopened':
      return [`open upstream, but the registry says ${item.status}`];
    case 'stale':
      return [`no upstream activity since ${day(item.lastUpstreamActivityAt)}`];
    case 'not-planned':
      return [`closed as not planned ${day(item.upstream.closedAt)}`];
    case 'ready-to-retire':
      return [item.status === 'adopted' ? 'adopted: ak relies on the upstream resolution; nothing left to watch' : `closed upstream (${item.upstream?.reason ?? 'unknown'}); nothing in ak waits on it`];
    case 'tracking':
      return [`tracks ${item.tracks.join(', ')}`];
    case 'unchecked':
      return [`could not check: ${item.error ?? item.release?.basis ?? 'unknown'}`];
    case 'waiting':
      return [`open; last upstream activity ${day(item.lastUpstreamActivityAt)}`];
    default:
      return [`status ${item.status}`];
  }
}

function renderItem(key, item) {
  if (key === 'constraints-due') {
    return [`  ${item.id} (${item.dependency}): retest was due ${item.nextRetestAt}`, ...(item.issue ? [`    ${item.issue}`] : [])];
  }
  const lines = [`  ${item.id}: ${item.title}`, ...detail(key, item).map((line) => `    ${line}`)];
  const ack = item.acknowledgements?.at(-1);
  if (ack) lines.push(`    acknowledged by ${ack.by} ${day(ack.at)} (automated)`);
  lines.push(`    ${item.url}`);
  return lines;
}

export function renderReport(report) {
  const { statuses } = report.registry;
  const watched = Object.entries(statuses).filter(([status]) => status !== 'retired').reduce((sum, [, count]) => sum + count, 0);
  const lines = [
    `Upstream watch · ${report.generatedAt.slice(0, 10)} · ${report.mode}${report.offlineReason ? ` (${report.offlineReason})` : ''}`,
    `  registry ${report.registry.status}, last checked ${report.registry.lastCheckedAt}, last verified ${report.registry.lastVerifiedAt}; ${watched} watched, ${statuses.retired} retired`,
  ];
  if (report.mode === 'offline') lines.push('  offline: only what the registry records; replies, closures and releases were not checked');
  for (const error of report.registry.errors) lines.push(`  registry error: ${error}`);
  if (report.nothingToWatch) lines.push('  nothing left to watch: every upstream thread is retired');
  const width = Math.max(...report.groups.map((group) => group.label.length));
  lines.push('', 'Counts');
  for (const group of report.groups) lines.push(`  ${group.label.padEnd(width)}  ${group.items.length}`);
  for (const group of report.groups.filter((item) => item.items.length)) {
    lines.push('', group.label);
    for (const item of group.items) lines.push(...renderItem(group.key, item));
  }
  if (report.fetchErrors.length) {
    lines.push('', 'Fetch errors');
    for (const failure of report.fetchErrors) lines.push(`  ${failure.id}: ${failure.error}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderEvents(events) {
  return events.length ? `${events.map((event) => event.line).join('\n')}\n` : 'No new upstream events.\n';
}
