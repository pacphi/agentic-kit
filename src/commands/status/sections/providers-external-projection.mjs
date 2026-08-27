// The external AQE providers projection (admitted providers reflected into
// agentic-qe's own config) — isolated from the sibling providers-*
// sections (ADR-complexity-program #4).
import { EXTERNAL_PROVIDERS_MIN_AQE } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';
import { computeProviderExternalState } from './_providers-external.mjs';

export default {
  id: 'providers',
  async collect({ cfg, cwd }) {
    try {
      const { externalRoot, externalDisk, external } = computeProviderExternalState(cfg, cwd);
      if (!(externalRoot && external)) return [];
      if (!(external.desired.length || external.stale.length)) return [];
      const defaultDrift = external.desired.includes(cfg.providers?.aqeProvider)
        && externalDisk.defaultProvider !== cfg.providers.aqeProvider;
      if (!external.supported) {
        return [row('providers', 'warn',
          `external AQE providers admitted but installed agentic-qe needs >=${EXTERNAL_PROVIDERS_MIN_AQE}`)];
      }
      if (!external.ok || defaultDrift) {
        const facts = [
          external.missing.length ? `missing ${external.missing.join(', ')}` : '',
          external.drifted.length ? `drifted/conflicting ${external.drifted.join(', ')}` : '',
          external.stale.length ? `stale owned ${external.stale.join(', ')}` : '',
          defaultDrift ? `default is not ${cfg.providers.aqeProvider}` : '',
        ].filter(Boolean).join('; ');
        return [row('providers', 'warn', `external AQE projection out of sync (${facts})`, 'sync reconciles only ak-owned entries')];
      }
      return [row('providers', 'ok',
        `external AQE providers projected: ${external.desired.join(', ')} (declared/admitted; served inference not yet proven)`)];
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
