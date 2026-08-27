// ADR-0028 F-29: local-openai is a local ($0) provider deliberately NOT
// projected to 'aqe' (unlike ollama, which is) — surface that asymmetry
// plainly so it reads as a fact, not a bug. Registry-driven (billing +
// projections), not an id check, so any future provider of the same shape
// gets the same treatment for free. Isolated from the sibling providers-*
// sections (ADR-complexity-program #4).
import { PROVIDER_REGISTRY } from '../../../lib/adapters/index.mjs';
import { row } from '../row.mjs';

export default {
  id: 'providers',
  async collect({ cfg }) {
    try {
      const rows = [];
      const providerById = Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p]));
      for (const binding of cfg.integrations?.bindings ?? []) {
        const provider = providerById[binding.provider];
        if (!provider || provider.billing !== 'local' || provider.projections.includes('aqe')) continue;
        const endpoint = binding.endpoint ? ` @ ${binding.endpoint}` : '';
        rows.push(row('providers', 'info',
          `local binding: ${binding.provider} via ${binding.host}${endpoint} (${provider.billing} $0; not an AQE provider type)`));
      }
      return rows;
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
