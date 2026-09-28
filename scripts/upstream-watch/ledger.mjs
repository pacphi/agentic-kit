// The ledger comment on the watch's GitHub issue, built without a model: which
// comments count, where the next check starts, and the comment's exact text.
// Decision 14: the scheduled workflow posts this body as-is.

const CHECKED_AT = /^checked-at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/gm;
const WEEK = 7 * 86_400_000;
// GitHub rejects a comment body over 65,536 characters; stay well under it.
export const MAX_COMMENT = 60_000;
// Thread ids, pull request numbers and branches in code spans: a bare `#n`
// autolinks to this repository and `owner/repo#n` mentions the upstream thread.
const code = (value) => `\`${value}\``;

export const isoSeconds = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The ledger text and the next check's start, from the issue's comments. Only
 * comments by `authors` count: the issue is public, and a stranger's line would
 * suppress a real event or a later `checked-at` would skip a real reply.
 */
export function readLedger(comments, authors, now) {
  const allowed = new Set(authors.map((login) => login.toLowerCase()));
  const bodies = comments.filter((comment) => allowed.has(String(comment?.user?.login ?? '').toLowerCase()))
    .map((comment) => String(comment.body ?? '').replace(/\r\n/g, '\n'));
  const checked = bodies.flatMap((body) => [...body.matchAll(CHECKED_AT)].map((match) => match[1]))
    // A checked-at later than now (a typo) would silence every reply until that date.
    .filter((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime())
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    text: bodies.join('\n'),
    comments: bodies.length,
    since: checked.length ? isoSeconds(checked.at(-1)) : isoSeconds(now.getTime() - WEEK),
    sinceSource: checked.length ? 'ledger' : 'default',
  };
}

/** One plain sentence per ledger line. */
export function sentence(event) {
  const { date, fields } = event;
  const id = code(event.id);
  switch (event.event) {
    case 'reply':
      return `${fields.by} commented on ${id} on ${date} at ${fields.at}; check whether it needs our reply.`;
    case 'acknowledged':
      return `${fields.by} posted an automated acknowledgement on ${id} on ${date}.`;
    case 'closed':
      return `${id} was closed upstream on ${date}${fields.reason ? ` (${fields.reason})` : ''}.`;
    case 'merged':
      return `${id} was merged upstream on ${date}.`;
    case 'released': {
      const change = fields.pr ? ` (pull request ${code(`#${fields.pr}`)})` : fields.commit ? ` (commit ${code(fields.commit)})` : '';
      return fields.branch
        ? `The fix for ${id}${change} is released in ${fields.version} (${date}); ak dispatches it on branch ${code(fields.branch)}.`
        : `The fix for ${id}${change} is released in ${fields.version} (${date}); ak keeps its workaround until the oldest supported release has it.`;
    }
    case 'fired':
      return `Dispatch for ${id} fired on ${date} (branch ${code(fields.branch)}); session ${fields.session}.`;
    case 'dispatch-pr':
      // A bare #n links to ak's own pull request on purpose.
      return `Draft pull request #${fields.pr} for ${id} is ready for review (branch ${code(fields.branch)}).`;
    case 'reopened':
      return `${id} is open upstream again while the registry says ${fields.status}.`;
    case 'stale':
      return `${id} has had no upstream activity since ${date}.`;
    case 'retire-proposed':
      return `${id} can be retired: nothing in ak waits on it.`;
    case 'retest-due':
      return `Constraint ${id} was due for a retest on ${date}.`;
    case 'idle':
      return 'Every upstream thread is retired; nothing is left to watch.';
    default:
      return `${id}: ${event.event} on ${date}.`;
  }
}

/**
 * The comment body: the ledger lines in a text block that ends with the time
 * the next check starts from, then one sentence per line. When anything could
 * not be checked the block keeps the previous start, so the next run reads the
 * same window again (the lines already posted are dropped by the ledger).
 * Empty when there is nothing to post.
 */
export function renderComment({ events, fetchErrors, since, now }) {
  if (!events.length) return '';
  for (let count = events.length; count > 0; count--) {
    const body = commentBody(events.slice(0, count), events.length - count, fetchErrors, since, now);
    if (body.length <= MAX_COMMENT) return body;
  }
  return commentBody(events.slice(0, 1), events.length - 1, fetchErrors, since, now);
}

// Lines left out for length are like lines not checked: the block keeps the
// previous start, so the next run posts them (the ledger drops what landed).
function commentBody(events, left, fetchErrors, since, now) {
  const checkedAt = fetchErrors.length || left ? since : isoSeconds(now);
  const lines = [
    '```text',
    ...events.map((event) => event.line),
    `checked-at ${checkedAt}`,
    '```',
    '',
    ...events.map((event) => `- ${sentence(event)}`),
  ];
  if (left) lines.push('', `${left} more ${left === 1 ? 'line is' : 'lines are'} posted by the next run.`);
  if (fetchErrors.length) {
    lines.push('', `Could not check ${fetchErrors.map((item) => code(item.id)).join(', ')}; the next run checks again from ${since}.`);
  }
  return `${lines.join('\n')}\n`;
}

// GitHub rejects a comment body over 65,536 characters; stay well under it.
export const NOTICE_MAX = 60_000;
const ACTION = {
  reply: () => true,
  'dispatch-pr': () => true,
  reopened: () => true,
  'retest-due': () => true,
  idle: () => true,
  released: (record) => Boolean(record.fields?.branch),
  closed: (record) => record.fields?.reason === 'not_planned',
};

/** Whether a record needs the maintainer (spec 2026-09-28, "Notice"). */
export const isActionRecord = (record) => Boolean(ACTION[record.event]?.(record));

/**
 * The commit comment that notifies the maintainer: a mention, one sentence per
 * action record, and how to query the rest. Empty when nothing needs them.
 */
export function renderNotice({ records, mention, date }) {
  const items = records.filter(isActionRecord);
  if (!items.length) return '';
  const sessions = new Map(records.filter((item) => item.event === 'fired').map((item) => [item.id, item.fields.session]));
  const bullets = items.map((item) => `- ${sentence(item)}${item.event === 'released' && sessions.has(item.id) ? ` Routine session: ${sessions.get(item.id)}` : ''}`);
  const head = `@${mention} upstream watch: ${items.length} ${items.length === 1 ? 'item needs' : 'items need'} you (${date}).`;
  const foot = `The full record: \`node scripts/upstream-watch.mjs ledger --since ${date}\``;
  for (let count = bullets.length; count > 0; count--) {
    const more = bullets.length - count;
    const body = `${[head, '', ...bullets.slice(0, count), ...(more ? ['', `${more} more; see the ledger.`] : []), '', foot].join('\n')}\n`;
    if (body.length <= NOTICE_MAX) return body;
  }
  return `${[head, '', `${bullets.length} items; see the ledger.`, '', foot].join('\n')}\n`;
}
