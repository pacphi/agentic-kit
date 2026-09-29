// The ledger's words, built without a model: one plain sentence per record,
// and the notice that mentions the maintainer when a record needs them.

// Thread ids, pull request numbers and branches in code spans: a bare `#n`
// autolinks to this repository and `owner/repo#n` mentions the upstream thread.
const code = (value) => `\`${value}\``;

export const isoSeconds = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A sentence for a ledger commit message. A commit message is plain text, and
 * GitHub turns `owner/repo#n` or `#n` there into a "referenced" entry on that
 * thread, code span or not, so ids are written `owner/repo no. n` and `no. n`.
 */
export const commitSafe = (text) => String(text).replace(/([\w.-]+\/[\w.-]+)#(\d+)/g, '$1 no. $2').replace(/#(\d+)/g, 'no. $1');

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
 * action record, and how to query every record of the run (`recordedAt`, its
 * time). Empty when nothing needs them.
 */
export function renderNotice({ records, mention, date, recordedAt }) {
  const items = records.filter(isActionRecord);
  if (!items.length) return '';
  const sessions = new Map(records.filter((item) => item.event === 'fired').map((item) => [item.id, item.fields.session]));
  const bullets = items.map((item) => `- ${sentence(item)}${item.event === 'released' && sessions.has(item.id) ? ` Routine session: ${sessions.get(item.id)}` : ''}`);
  const head = `@${mention} upstream watch: ${items.length} ${items.length === 1 ? 'item needs' : 'items need'} you (${date}).`;
  const foot = `The full record: \`node scripts/upstream-watch.mjs ledger --recorded-since ${recordedAt}\``;
  const lengths = [0];
  for (const bullet of bullets) lengths.push(lengths.at(-1) + bullet.length);
  for (let count = bullets.length; count > 0; count--) {
    const more = bullets.length - count;
    const suffix = more ? `${more} more; see the ledger.` : '';
    const length = head.length + foot.length + lengths[count] + suffix.length + count + 4 + (more ? 2 : 0);
    if (length <= NOTICE_MAX) return `${[head, '', ...bullets.slice(0, count), ...(more ? ['', suffix] : []), '', foot].join('\n')}\n`;
  }
  return `${[head, '', `${bullets.length} items; see the ledger.`, '', foot].join('\n')}\n`;
}
