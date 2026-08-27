// ruvnet-brain (offline KB + search_ruvnet MCP; not an npm package — detected
// on disk, drift via GitHub releases, TTL-cached like `self`)
import { drift as ruvnetBrainDrift, nightlyAgentPresent as rbNightlyPresent, NIGHTLY_LABEL as RB_NIGHTLY_LABEL } from '../../../lib/ruvnet-brain.mjs';
import { row } from '../row.mjs';

export default {
  id: 'ruvnet-brain',
  async collect({ cfg }) {
    const rows = [];
    if (!cfg.ruvnetBrain) return rows;
    try {
      const b = await ruvnetBrainDrift();
      if (!b.present) {
        rows.push(row('ruvnet-brain', 'warn', 'RuvNet Brain not installed', 'setup installs it (or `ak sync`)'));
      } else if (b.outdated) {
        const have = b.installedRelease ? `release v${b.installedRelease}` : 'present (unversioned install)';
        rows.push(row('ruvnet-brain', 'warn',
          `ruvnet-brain ${have}, release v${b.latest} available`, 'sync refreshes the KB'));
      } else {
        const shown = b.installedRelease ? `release v${b.installedRelease}${b.latest ? ' (latest)' : ''}` : 'present';
        rows.push(row('ruvnet-brain', 'ok', `ruvnet-brain ${shown}`));
      }
    } catch (e) {
      rows.push(row('ruvnet-brain', 'warn', `ruvnet-brain check unavailable: ${e.message}`));
    }
    // The installer's own nightly self-updater (macOS LaunchAgent, 03:47) bypasses
    // ak-managed updates: it rewrites the KB outside ak's release stamp, so status
    // and the statusline drift from disk. Own subsystem so sync's fix is "disable
    // the agent", never a needless force-reinstall of the brain itself.
    if (rbNightlyPresent()) {
      rows.push(row('ruvnet-brain-nightly', 'warn',
        `ruvnet-brain nightly self-updater active (${RB_NIGHTLY_LABEL}) — bypasses ak-managed updates`,
        'sync disables it (re-enable deliberately: `npx ruvnet-brain --enable-nightly`)'));
    }
    return rows;
  },
};
