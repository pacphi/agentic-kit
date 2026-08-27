// A kit.json provider/model entry is registration intent. Ruflo >=3.38.8
// can honor explicit OpenRouter/Ollama provider+model selection, but the
// registry does not retarget every agent and it is not execution evidence.
// Keep that distinction in the status rows the dashboard consumes. Isolated
// from the sibling providers-* sections (ADR-complexity-program #4).
import { installedVersion, cmpVersions } from '../../../lib/versions.mjs';
import { MIN_RUFLO_PERSISTED_PROVIDER_VERSION } from '../../../lib/providers.mjs';
import { row } from '../row.mjs';

export default {
  id: 'providers',
  async collect({ cfg, integrationFacts }) {
    try {
      const rufloModels = cfg.providers?.models ?? [];
      if (!rufloModels.length) return [];
      const intent = rufloModels
        .filter((entry) => entry?.id)
        .map((entry) => `${entry.id}${entry.model ? `:${entry.model}` : ''}`)
        .join(', ');
      const rufloVersion = installedVersion('ruflo');
      const affected = !!rufloVersion
        && cmpVersions(rufloVersion, MIN_RUFLO_PERSISTED_PROVIDER_VERSION) < 0;
      const missingOpenRouterKey = rufloModels.some((entry) => entry?.id === 'openrouter')
        && !integrationFacts.providers?.openrouter?.credentialPresent;
      const directIds = new Set(['ollama', 'openrouter']);
      const registryOnly = [...new Set(rufloModels
        .map((entry) => entry?.id)
        .filter((id) => id && !directIds.has(id)))];
      if (affected) {
        return [row('providers', 'warn',
          `ruflo provider intent: ${intent} — ruflo ${rufloVersion} cannot honor persisted provider/model execution; needs >=${MIN_RUFLO_PERSISTED_PROVIDER_VERSION}`)];
      }
      if (missingOpenRouterKey) {
        return [row('providers', 'warn',
          `ruflo provider intent: ${intent} — direct agents must select provider + model; openrouter needs OPENROUTER_API_KEY in the Ruflo/MCP process`)];
      }
      const unsupported = registryOnly.length
        ? `; no direct-agent execution branch for ${registryOnly.join(', ')}`
        : '';
      return [row('providers', 'info',
        `ruflo provider intent: ${intent} — direct agents must select provider + model; Usage proves served execution${unsupported}`)];
    } catch (e) {
      return [row('providers', 'warn', `provider check unavailable: ${e.message}`)];
    }
  },
};
