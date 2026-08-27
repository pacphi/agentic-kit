// The external AQE providers projection (admitted providers reflected into
// agentic-qe's own config) — isolated from the sibling providers-*
// sections (ADR-complexity-program #4). The projection state itself lives in
// src/lib/providers.mjs (providerExternalState) so this section never
// re-derives its own view (#129).
import { EXTERNAL_PROVIDERS_MIN_AQE, providerExternalState } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

export default {
  id: 'providers',
  async collect({ cfg, cwd }) {
    try {
      const { root, disk, state } = providerExternalState(cfg, cwd);
      if (!(root && state)) return [];
      if (!(state.desired.length || state.stale.length)) return [];
      const defaultDrift = state.desired.includes(cfg.providers?.aqeProvider)
        && disk.defaultProvider !== cfg.providers.aqeProvider;
      if (!state.supported) {
        return [row('providers', 'warn',
          `external AQE providers admitted but installed agentic-qe needs >=${EXTERNAL_PROVIDERS_MIN_AQE}`)];
      }
      if (!state.ok || defaultDrift) {
        const facts = [
          state.missing.length ? `missing ${state.missing.join(', ')}` : '',
          state.drifted.length ? `drifted/conflicting ${state.drifted.join(', ')}` : '',
          state.stale.length ? `stale owned ${state.stale.join(', ')}` : '',
          defaultDrift ? `default is not ${cfg.providers.aqeProvider}` : '',
        ].filter(Boolean).join('; ');
        return [row('providers', 'warn', `external AQE projection out of sync (${facts})`, 'sync reconciles only ak-owned entries')];
      }
      return [row('providers', 'ok',
        `external AQE providers projected: ${state.desired.join(', ')} (declared/admitted; served inference not yet proven)`)];
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
