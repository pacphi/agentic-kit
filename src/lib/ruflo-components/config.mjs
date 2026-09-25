export const LEARNING_PROFILES = Object.freeze(['real-time', 'balanced', 'research', 'edge', 'batch']);
export const RUFLO_COMPONENT_DEFAULTS = Object.freeze({
  typesafePicker: true, minilmPicker: true, mcpGovernance: Object.freeze({ maxCallsPerMinute: 120 }),
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
});
const BOOLEAN_KEYS = ['typesafePicker', 'minilmPicker', 'turnCredit', 'memoryFix2887', 'funnel'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateRufloComponents(value) {
  if (value === undefined) return;
  if (!plain(value)) throw new TypeError('rufloComponents must be an object');
  for (const key of Object.keys(value)) {
    if (!(key in RUFLO_COMPONENT_DEFAULTS)) throw new TypeError(`rufloComponents.${key} is not a known component`);
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in value && typeof value[key] !== 'boolean') throw new TypeError(`rufloComponents.${key} must be true or false`);
  }
  if ('learningProfile' in value && value.learningProfile !== false && !LEARNING_PROFILES.includes(value.learningProfile)) {
    throw new TypeError(`rufloComponents.learningProfile must be false or one of ${LEARNING_PROFILES.join(', ')}`);
  }
  const gov = value.mcpGovernance;
  if (gov !== undefined && gov !== false) {
    if (!plain(gov) || !Number.isInteger(gov.maxCallsPerMinute) || gov.maxCallsPerMinute < 1 || gov.maxCallsPerMinute > 10_000) {
      throw new TypeError('rufloComponents.mcpGovernance must be false or { maxCallsPerMinute: 1..10000 }');
    }
  }
}

/** The managed intent for one component; false means "ak does not manage it". */
export function managedIntent(cfg, id) {
  const merged = { ...RUFLO_COMPONENT_DEFAULTS, ...(cfg?.rufloComponents ?? {}) };
  if (id === 'funnel') return merged.funnel === false ? 'off' : false;
  return merged[id] ?? false;
}
