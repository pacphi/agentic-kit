// Warn when an admitted external AQE provider is referenced by kit.json
// intent (aqeProvider / aqeFallback / routing) but isn't actually live —
// isolated from the sibling providers-* sections (ADR-complexity-program #4).
import { row } from '../row.mjs';
import { computeProviderExternalState } from './_providers-external.mjs';

export default {
  id: 'providers',
  async collect({ cfg, cwd }) {
    try {
      const { unavailableExternalIntent } = computeProviderExternalState(cfg, cwd);
      if (!unavailableExternalIntent.length) return [];
      return [row('providers', 'warn',
        `external AQE intent is unavailable (${unavailableExternalIntent.join(', ')}) — restore its admission/host/grant, or retire only its dependent intent with `
        + `\`ak host adapters revoke-grant ${unavailableExternalIntent[0]} aqeProvider\``)];
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
