// hosts (install-if-missing) — cheap: file read + `which`, no network.
// An enabled host that is entirely absent is installable by sync; an external
// install (mise/native/brew) is reported but never touched. An npm install is
// also launched once (`--version`): its package.json can outlive the binary.
import { HOSTS, hostInstallState, hostAuthState, hostExecutable } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

const DEFAULT_DEPS = { installState: hostInstallState, executable: hostExecutable, authState: hostAuthState };

// Install row + auth row for a host that is on disk.
async function installedHostRows(h, st, primary, deps) {
  const label = `${h.id} ${st.version ?? ''} (${st.method}${st.method === 'external' ? ' — self-managed' : ''})`;
  const launch = st.method === 'npm' ? await deps.executable(h) : { ok: true, detail: null };
  const install = launch.ok ? row('hosts', 'ok', label)
    : row('hosts', primary ? 'fail' : 'warn', `${label} installed but not executable: ${launch.detail}`,
      `reinstall: npm install -g ${h.pkg}@latest`);
  // auth mode (billing axis): oauth/subscription ($0) vs metered api-key.
  // A distinct row so `ak status --json` (and the dashboard) can badge it.
  const auth = deps.authState(h.id, { present: true });
  const billing = auth.billing === 'subscription' ? 'subscription, $0'
    : auth.billing === 'metered' ? 'metered' : auth.billing;
  return [install, row('hosts', auth.mode === 'none' ? 'warn' : 'ok',
    `${h.id} auth: ${auth.mode} (${billing})${auth.source ? ` · ${auth.source}` : ''}${auth.note ? ` — ${auth.note}` : ''}`,
    auth.mode === 'none' ? `${h.id} login` : null)];
}

export default {
  id: 'hosts',
  /** @param {{ cfg: any, integrationFacts: any, hostDeps?: Partial<typeof DEFAULT_DEPS> }} ctx */
  async collect({ cfg, integrationFacts, hostDeps = {} }) {
    const deps = { ...DEFAULT_DEPS, ...hostDeps };
    const rows = [];
    try {
      // primary host absent = fail (nothing can drive); alternate absent = warn.
      const primaryHost = cfg.routing?.primaryHost ?? 'claude';
      for (const h of HOSTS) {
        if (!cfg.integrations.hosts[h.id]) continue;
        const primary = h.id === primaryHost;
        const st = integrationFacts.hosts[h.id]?.present === false
          ? { method: 'absent', version: null } : await deps.installState(h);
        if (st.method === 'absent') {
          rows.push(row('hosts', primary ? 'fail' : 'warn',
            `${h.id} enabled but not installed${primary ? ' (primary)' : ''}`, `sync installs ${h.pkg}`));
        } else {
          rows.push(...await installedHostRows(h, st, primary, deps));
        }
      }
    } catch (e) {
      rows.push(row('hosts', 'warn', `host check unavailable: ${e.message}`));
    }
    return rows;
  },
};
