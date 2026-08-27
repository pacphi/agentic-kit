// hosts (install-if-missing) — cheap: file read + `which`, no network.
// An enabled host that is entirely absent is installable by sync; an external
// install (mise/native/brew) is reported but never touched.
import { HOSTS, hostInstallState, hostAuthState } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

export default {
  id: 'hosts',
  async collect({ cfg, integrationFacts }) {
    const rows = [];
    try {
      // primary host absent = fail (nothing can drive); alternate absent = warn.
      const primaryHost = cfg.routing?.primaryHost ?? 'claude';
      for (const h of HOSTS) {
        if (!cfg.integrations.hosts[h.id]) continue;
        const detected = integrationFacts.hosts[h.id];
        if (detected?.present === false) {
          rows.push(row('hosts', h.id === primaryHost ? 'fail' : 'warn',
            `${h.id} enabled but not installed${h.id === primaryHost ? ' (primary)' : ''}`, `sync installs ${h.pkg}`));
          continue;
        }
        const st = await hostInstallState(h);
        if (st.method === 'absent') {
          rows.push(row('hosts', h.id === primaryHost ? 'fail' : 'warn',
            `${h.id} enabled but not installed${h.id === primaryHost ? ' (primary)' : ''}`, `sync installs ${h.pkg}`));
        } else {
          rows.push(row('hosts', 'ok', `${h.id} ${st.version ?? ''} (${st.method}${st.method === 'external' ? ' — self-managed' : ''})`));
          // auth mode (billing axis): oauth/subscription ($0) vs metered api-key.
          // A distinct row so `ak status --json` (and the dashboard) can badge it.
          const auth = hostAuthState(h.id, { present: true });
          const billing = auth.billing === 'subscription' ? 'subscription, $0'
            : auth.billing === 'metered' ? 'metered' : auth.billing;
          rows.push(row('hosts', auth.mode === 'none' ? 'warn' : 'ok',
            `${h.id} auth: ${auth.mode} (${billing})${auth.source ? ` · ${auth.source}` : ''}${auth.note ? ` — ${auth.note}` : ''}`,
            auth.mode === 'none' ? `${h.id} login` : null));
        }
      }
    } catch (e) {
      rows.push(row('hosts', 'warn', `host check unavailable: ${e.message}`));
    }
    return rows;
  },
};
