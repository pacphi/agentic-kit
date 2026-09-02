import { PRICES_AS_OF, priceFor } from '../../pricing.mjs';
import { modelRecord, sourceRecord } from './index.mjs';

export const ANTHROPIC_PUBLIC_CATALOG_AS_OF = '2026-09-02';
export const ANTHROPIC_MODELS_URL =
  'https://platform.claude.com/docs/en/about-claude/models/overview';
export const ANTHROPIC_LIFECYCLE_URL =
  'https://platform.claude.com/docs/en/about-claude/model-deprecations';
export const ANTHROPIC_PRICING_URL =
  'https://platform.claude.com/docs/en/about-claude/pricing';
export const ANTHROPIC_MODEL_IDS_URL =
  'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions';
export const ANTHROPIC_CONTEXT_URL =
  'https://platform.claude.com/docs/en/build-with-claude/context-windows';
const MAX_CATALOG_AGE_DAYS = 90;

/**
 * @typedef {object} AnthropicPublicModel
 * @property {string} id
 * @property {string} displayName
 * @property {string} lifecycle
 * @property {boolean} discoverable
 * @property {boolean} recommended
 * @property {string} availability
 * @property {string[]} [aliases]
 * @property {string} [replacement]
 * @property {string} [retiredAt]
 * @property {string} [retirementNotBefore]
 * @property {number} [contextLimit]
 * @property {number} [outputLimit]
 */

/** @param {string} id @param {string} displayName @param {Partial<AnthropicPublicModel>} [options]
 * @returns {AnthropicPublicModel} */
const active = (id, displayName, options = {}) => ({
  id, displayName, lifecycle: 'active', discoverable: true, recommended: true,
  availability: 'general', ...options,
});
/** @param {string} id @param {string} displayName @param {string} retiredAt
 * @param {string} replacement @param {string[]} [aliases] @returns {AnthropicPublicModel} */
const removed = (id, displayName, retiredAt, replacement, aliases = []) => ({
  id, displayName, lifecycle: 'removed', discoverable: false, recommended: false,
  availability: 'retired', retiredAt, replacement, aliases,
});

/**
 * Bundled, dated facts transcribed from Anthropic's Models overview and Model
 * deprecations tables. This is deliberately data, not model-id inference.
 * @type {readonly AnthropicPublicModel[]}
 */
export const ANTHROPIC_PUBLIC_MODELS = Object.freeze([
  active('claude-fable-5-1', 'Claude Fable 5.1', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-09-01',
  }),
  active('claude-mythos-5-1', 'Claude Mythos 5.1', {
    contextLimit: 1_000_000, outputLimit: 128_000, availability: 'limited',
  }),
  active('claude-fable-5', 'Claude Fable 5', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-06-09',
  }),
  active('claude-mythos-5', 'Claude Mythos 5', {
    contextLimit: 1_000_000, outputLimit: 128_000, availability: 'limited',
  }),
  {
    id: 'claude-mythos-preview', displayName: 'Claude Mythos Preview',
    lifecycle: 'deprecated', discoverable: true, recommended: false,
    availability: 'limited', replacement: 'claude-mythos-5',
    contextLimit: 1_000_000, outputLimit: 128_000,
  },
  active('claude-opus-5', 'Claude Opus 5', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-07-24',
  }),
  active('claude-opus-4-8', 'Claude Opus 4.8', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-05-28',
  }),
  active('claude-opus-4-7', 'Claude Opus 4.7', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-04-16',
  }),
  active('claude-opus-4-6', 'Claude Opus 4.6', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-02-05',
  }),
  active('claude-opus-4-5-20251101', 'Claude Opus 4.5 (2025-11-01)', {
    aliases: ['claude-opus-4-5'], contextLimit: 200_000, outputLimit: 64_000,
    retirementNotBefore: '2026-11-24',
  }),
  removed('claude-opus-4-1-20250805', 'Claude Opus 4.1 (2025-08-05)',
    '2026-08-05', 'claude-opus-4-8', ['claude-opus-4-1']),
  removed('claude-opus-4-20250514', 'Claude Opus 4 (2025-05-14)',
    '2026-06-15', 'claude-opus-4-8', ['claude-opus-4-0']),
  active('claude-sonnet-5', 'Claude Sonnet 5', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-06-30',
  }),
  active('claude-sonnet-4-6', 'Claude Sonnet 4.6', {
    contextLimit: 1_000_000, outputLimit: 128_000, retirementNotBefore: '2027-02-17',
  }),
  active('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 (2025-09-29)', {
    aliases: ['claude-sonnet-4-5'], contextLimit: 200_000, outputLimit: 64_000,
    retirementNotBefore: '2026-09-29',
  }),
  removed('claude-sonnet-4-20250514', 'Claude Sonnet 4 (2025-05-14)',
    '2026-06-15', 'claude-sonnet-4-6', ['claude-sonnet-4-0']),
  removed('claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7 (2025-02-19)',
    '2026-02-19', 'claude-sonnet-4-6'),
  active('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (2025-10-01)', {
    aliases: ['claude-haiku-4-5'], contextLimit: 200_000, outputLimit: 64_000,
    retirementNotBefore: '2026-10-15',
  }),
  removed('claude-3-5-haiku-20241022', 'Claude Haiku 3.5 (2024-10-22)',
    '2026-02-19', 'claude-haiku-4-5-20251001'),
  removed('claude-3-haiku-20240307', 'Claude Haiku 3 (2024-03-07)',
    '2026-04-20', 'claude-haiku-4-5-20251001'),
  removed('claude-3-5-sonnet-20240620', 'Claude Sonnet 3.5 (2024-06-20)',
    '2025-10-28', 'claude-sonnet-4-6'),
  removed('claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5 (2024-10-22)',
    '2025-10-28', 'claude-sonnet-4-6'),
  removed('claude-3-opus-20240229', 'Claude Opus 3 (2024-02-29)',
    '2026-01-05', 'claude-opus-4-8'),
  removed('claude-3-sonnet-20240229', 'Claude Sonnet 3 (2024-02-29)',
    '2025-07-21', 'claude-sonnet-4-6'),
  removed('claude-2.1', 'Claude 2.1', '2025-07-21', 'claude-opus-4-8'),
  removed('claude-2.0', 'Claude 2.0', '2025-07-21', 'claude-opus-4-8'),
  ...['claude-1.0', 'claude-1.1', 'claude-1.2', 'claude-1.3',
    'claude-instant-1.0', 'claude-instant-1.1', 'claude-instant-1.2']
    .map((id) => removed(id, id.replace('claude-', 'Claude ').replace('-', ' '),
      '2024-11-06', 'claude-haiku-4-5-20251001')),
]);

export const ANTHROPIC_OFFICIAL_MODEL_IDS = Object.freeze(ANTHROPIC_PUBLIC_MODELS
  .flatMap(({ id, aliases = [] }) => [id, ...aliases]));

function freshness(capturedAt) {
  const captured = Date.parse(capturedAt ?? '');
  const verified = Date.parse(`${ANTHROPIC_PUBLIC_CATALOG_AS_OF}T00:00:00.000Z`);
  return Number.isFinite(captured) && captured - verified > MAX_CATALOG_AGE_DAYS * 86_400_000
    ? 'stale' : 'current';
}

function publicCapabilities(entry) {
  if (!entry.contextLimit && !entry.outputLimit) return {};
  return {
    tools: true, reasoning: true,
    input: { text: true, image: true }, output: { text: true },
    ...(entry.contextLimit ? { contextLimit: entry.contextLimit } : {}),
    ...(entry.outputLimit ? { outputLimit: entry.outputLimit } : {}),
  };
}

function publicPricing(modelId) {
  const published = priceFor(modelId, 'anthropic', PRICES_AS_OF);
  return published.matched ? {
    basis: 'per-million-tokens', input: published.in, output: published.out,
    currency: 'USD', effectiveAt: null,
  } : null;
}

function claimRefs(field, entry) {
  if (field === 'lifecycle' || field === 'dimensions.recommended'
    || field === 'variant.lifecycleScope' || field === 'variant.retirementNotBefore'
    || field === 'variant.retiredAt') return [ANTHROPIC_LIFECYCLE_URL];
  if (field === 'pricing') return [ANTHROPIC_PRICING_URL];
  if (field.startsWith('aliases.')) return [ANTHROPIC_MODEL_IDS_URL];
  if (field === 'variant.contextWindow' || field === 'capabilities.contextLimit'
    || field === 'capabilities.outputLimit') return [ANTHROPIC_CONTEXT_URL];
  if (field === 'dimensions.discoverable' && entry.discoverable === false) {
    return [ANTHROPIC_LIFECYCLE_URL];
  }
  return [ANTHROPIC_MODELS_URL];
}

export function discoverAnthropicPublicCatalog({
  capturedAt, scope = {}, scopeKey,
} = /** @type {any} */ ({})) {
  const source = sourceRecord({
    id: 'anthropic-docs', owner: 'anthropic', ownerType: 'provider', transport: 'index',
    network: 'never', scope, scopeKey, capturedAt, complete: true,
    schema: 'anthropic-public-models-v1', sourceVersion: ANTHROPIC_PUBLIC_CATALOG_AS_OF,
    freshness: freshness(capturedAt ?? new Date().toISOString()), evidenceClass: 'first-party',
    refs: [
      ANTHROPIC_MODELS_URL, ANTHROPIC_LIFECYCLE_URL,
      ANTHROPIC_PRICING_URL, ANTHROPIC_MODEL_IDS_URL, ANTHROPIC_CONTEXT_URL,
    ],
  });
  const models = ANTHROPIC_PUBLIC_MODELS.map((entry) => {
    const model = modelRecord({
      host: 'claude', provider: null, modelId: entry.id, scopeId: source.scopeId,
      displayName: entry.displayName,
      aliases: (entry.aliases ?? []).map((name) => ({
        name, resolvesTo: entry.id, provenance: 'first-party', observedAt: source.capturedAt,
      })),
      variant: {
        catalog: {
          source: 'anthropic-docs', public: true, servingProvider: 'anthropic',
          publisher: 'Anthropic', family: entry.id.split('-').slice(0, 2).join('-'),
          selector: entry.id, links: { documentation: ANTHROPIC_MODELS_URL },
        },
        lifecycleScope: 'Anthropic-operated platforms', availability: entry.availability,
        ...(entry.contextLimit ? { contextWindow: entry.contextLimit } : {}),
        ...(entry.retirementNotBefore ? { retirementNotBefore: entry.retirementNotBefore } : {}),
        ...(entry.retiredAt ? { retiredAt: entry.retiredAt } : {}),
      },
      lifecycle: {
        state: entry.lifecycle, replacement: entry.replacement ?? null,
        notice: ANTHROPIC_LIFECYCLE_URL,
        effectiveAt: entry.retiredAt ? `${entry.retiredAt}T00:00:00.000Z` : null,
      },
      states: {
        discoverable: entry.discoverable, recommended: entry.recommended,
        entitled: 'unknown', policyAllowed: 'unknown', routable: 'unknown',
      },
      capabilities: publicCapabilities(entry), pricing: publicPricing(entry.id), source,
    });
    return {
      ...model,
      evidence: model.evidence.map((evidence) => ({
        ...evidence, refs: claimRefs(evidence.field, entry),
      })),
    };
  });
  return { source, models };
}
