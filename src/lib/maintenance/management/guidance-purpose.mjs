// Supported management operations do not, by themselves, justify a change.
// Keep their identities for explicit inspector actions without promoting them
// into recommendations, including snapshots written before this distinction.
import { INVENTORY_GROUP_ORDER } from './model.mjs';

const OPTIONAL_VERBS = Object.freeze({
  'claude-plugin': 'disable', 'codex-plugin': 'remove', 'codex-mcp': 'remove',
  'agentic-kit-owned-skill': 'archive', 'ollama-model': 'remove',
});
const normalized = new WeakMap();

export function isOptionalManagement(entry) {
  if (entry.purpose) return entry.purpose === 'optional-management';
  const [provider, , operation] = (entry.providerCapabilityId ?? '').split(':');
  return entry.lane === 'apply' && OPTIONAL_VERBS[provider] != null && OPTIONAL_VERBS[provider] === (entry.verb ?? operation);
}

export function recommendationEntries(entries = []) {
  return entries.filter((entry) => !isOptionalManagement(entry));
}

export function normalizeGuidanceInventory(inventory) {
  if (!inventory) return inventory;
  if (normalized.has(inventory)) return normalized.get(inventory);
  const optionalIds = new Set();
  const entries = (inventory.guidanceEntries ?? []).map((entry) => {
    if (!isOptionalManagement(entry)) return entry;
    optionalIds.add(entry.placementId);
    return { ...entry, purpose: 'optional-management' };
  });
  if (!optionalIds.size) { normalized.set(inventory, inventory); return inventory; }
  const lanes = new Map();
  for (const entry of recommendationEntries(entries)) {
    const previous = lanes.get(entry.placementId);
    if (!previous || INVENTORY_GROUP_ORDER.indexOf(entry.lane) < INVENTORY_GROUP_ORDER.indexOf(previous)) lanes.set(entry.placementId, entry.lane);
  }
  const result = { ...inventory, guidanceEntries: entries, placements: inventory.placements.map((placement) => optionalIds.has(placement.placementId)
    ? { ...placement, guidanceLane: lanes.get(placement.placementId) ?? null } : placement) };
  normalized.set(inventory, result);normalized.set(result, result);
  return result;
}
