// usage-local-provider.mjs — is an inference provider one that runs on the
// user's own machine? The usage scorecard uses it for exactly one decision: a
// message with no recorded cost, served locally, must not be priced.
//
// The pricing table prices hosted APIs. A model id it does not know falls back
// to a Sonnet-class rate (pricing.FALLBACK_PRICE) so an unknown HOSTED model is
// never silently free — but that rule invents a bill for a local model that
// costs nothing to call. So a local row with no recorded cost is left unpriced
// and reported as coverage (`unpricedMessages`), neither a fabricated rate nor
// a silent $0.
//
// Two sources, both by provider id (an OpenCode transcript records the id, not
// the endpoint — the base URL lives in a config file the usage reader never
// opens):
//   - the adapter registry's own `billing: 'local'` providers (ollama,
//     local-openai), so a provider the kit already classifies as local is
//     classified the same way here;
//   - the local model servers OpenCode users name themselves that the registry
//     folds under `local-openai` (LM Studio, llama.cpp).
// A custom-named local provider cannot be recognised from its id and keeps the
// existing fallback pricing.
import { providerIds } from './adapters/registries.mjs';

/** Provider ids compare without case, spaces, dots, dashes or underscores, so
 *  `llama.cpp`, `llama-cpp` and `llamacpp` (and `LM Studio` / `lmstudio`) agree. */
const normalize = (id) => String(id).toLowerCase().replace(/[\s._-]+/g, '');

const LOCAL_IDS = new Set([
  ...providerIds((provider) => provider.billing === 'local'),
  'lmstudio', 'llama.cpp',
].map(normalize));

/** @param {unknown} providerId the assistant message's providerID
 *  @returns {boolean} */
export function isLocalInferenceProvider(providerId) {
  return typeof providerId === 'string' && providerId !== '' && LOCAL_IDS.has(normalize(providerId));
}
