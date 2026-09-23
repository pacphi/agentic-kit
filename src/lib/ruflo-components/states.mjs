export const STATES = Object.freeze({
  active: { label: 'active', meaning: 'Applied and confirmed by ruflo\'s own evidence.', action: '' },
  'applied-unverified': { label: 'applied, not verified',
    meaning: 'Set, but not yet confirmed — usually the hosts have not restarted since the change.',
    action: 'Restart Claude Code, Codex and OpenCode.' },
  'needs-ruflo': { label: 'needs ruflo', meaning: 'The installed ruflo is too old for this component.',
    action: 'Run ak sync to upgrade ruflo.' },
  'not-applied': { label: 'not applied', meaning: 'ak has not applied the managed value yet.', action: 'Run ak sync.' },
  drifted: { label: 'drifted', meaning: 'Something changed a value ak set.',
    action: 'Run ak sync to restore it, or set the component to false in kit.json to keep your value.' },
  'user-managed': { label: 'user-managed',
    meaning: 'You set your own value or opted out; ak reports it and leaves it alone.', action: '' },
  partial: { label: 'partial', meaning: 'Applied for some hosts only.', action: 'See which hosts are missing.' },
  blocked: { label: 'blocked', meaning: 'Applying failed.', action: 'Follow the reason shown, then run ak sync.' },
  'not-managed-yet': { label: 'not yet managed',
    meaning: 'ak does not manage this yet; it is waiting on ADR-0059, so nothing here needs ak sync.', action: '' },
  unknown: { label: 'unknown', meaning: 'No current evidence, so ak does not claim this component is on.',
    action: 'Run ak status --refresh to collect evidence.' },
});

/**
 * @param {string} id
 * @param {Object} options
 * @param {string} [options.minRuflo]
 * @param {string[]} [options.hosts]
 * @param {string} [options.reason]
 * @returns {Object}
 */
export function describeState(id, { minRuflo, hosts, reason } = {}) {
  const base = STATES[id];
  if (!base) throw new TypeError(`unknown ruflo component state ${id}`);
  let { label, meaning } = base;
  const { action } = base;
  if (id === 'needs-ruflo' && minRuflo) label = `needs ruflo ≥ ${minRuflo}`;
  if (id === 'partial' && hosts?.length) meaning = `Applied for some hosts only; missing: ${hosts.join(', ')}.`;
  if ((id === 'blocked' || id === 'unknown' || id === 'drifted' || id === 'not-applied') && reason) meaning = `${meaning} ${reason}`;
  return { id, label, meaning, action };
}
