// agentdb (data-plane CLI `ak x harvest` drives). Pinned to ruflo's BUNDLED
// agentdb so the shared cognitive store never skews on the core version.
import { coherence as adbCoherence } from '../../../lib/agentdb.mjs';
import { row } from '../row.mjs';

export default {
  id: 'agentdb',
  async collect({ cfg }) {
    if (cfg.agentdb === false) {
      return [row('agentdb', 'info', 'agentdb management disabled in kit.json')];
    }
    const c = adbCoherence();
    if (!c.present) {
      return [row('agentdb', 'warn', 'agentdb CLI not installed (harvest write path unavailable)',
        "setup/sync installs it (pinned to ruflo's bundled agentdb)")];
    }
    if (c.skew === 'core') {
      return [row('agentdb', 'warn',
        `agentdb ${c.global} skewed from ruflo-bundled ${c.bundled} — shared-store corruption risk`,
        "sync repins agentdb to ruflo's bundled version")];
    }
    return [row('agentdb', 'ok',
      `agentdb ${c.global}${c.bundled ? ` (coherent with ruflo${c.skew === 'prerelease' ? ' — prerelease diff' : ''})` : ''}`)];
  },
};
