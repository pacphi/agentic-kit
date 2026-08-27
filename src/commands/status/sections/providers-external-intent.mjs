// Warn when an admitted external AQE provider is referenced by kit.json
// intent (aqeProvider / aqeFallback / routing) but isn't actually live —
// isolated from the sibling providers-* sections (ADR-complexity-program #4).
// The intent/live comparison itself lives in src/lib/providers.mjs
// (providerExternalState) so this section never re-derives its own view (#129).
import { row } from '../row.mjs';
import { providerExternalState } from '../../../lib/providers.mjs';

export default {
  id: 'providers',
  async collect({ cfg, cwd }) {
    try {
      const { unavailableIntent } = providerExternalState(cfg, cwd);
      if (!unavailableIntent.length) return [];
      return [row('providers', 'warn',
        `external AQE intent is unavailable (${unavailableIntent.join(', ')}) — restore its admission/host/grant, or retire only its dependent intent with `
        + `\`ak host adapters revoke-grant ${unavailableIntent[0]} aqeProvider\``)];
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
