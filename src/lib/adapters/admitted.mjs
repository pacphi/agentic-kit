// Overlay holding admitted external host entries — set once per process by
// bootstrapHostAdapters (admission.mjs) after admitAdapters has already
// refused any entry that would collide with a built-in id. This module does
// NOT re-check the built-in-shadow invariant; it trusts admission's output
// for that. It DOES, however, re-run every stored entry through
// validateHostAdapter (registries.mjs) before accepting it — see
// conformOne below.
import { HOST_REGISTRY, validateHostAdapter } from './registries.mjs';

let admittedEntries = Object.freeze([]);
let applied = false;

/**
 * Minimal shape gate + deep-freeze for one overlay entry, by re-running it
 * through validateHostAdapter with no projections/observability maps
 * injected (so only structural shape — not registry cross-references — is
 * re-verified). In the real bootstrapHostAdapters path this is always a
 * no-op pass-through: admitAdapters already produced `entry` by calling
 * validateHostAdapter once, inside validateAdapterManifest, so re-running it
 * here just re-derives an equally-valid, equally-frozen clone. It exists so
 * a caller that bypasses admission entirely — a bug, a future refactor, or a
 * raw object handed to applyAdmitted directly — gets a loud construction-time
 * TypeError instead of an unvalidated, possibly-privileged-looking entry
 * (e.g. `{id, capabilities:{canBePrimary:true}}`) silently joining
 * effectiveHostRegistry(). applyAdmitted only accepts genuine admission
 * output; anything else is rejected, never silently coerced.
 * @param {any} item — a raw host entry, or an admission result `{entry}`
 */
function conformOne(item) {
  return validateHostAdapter(item?.entry ?? item);
}

/**
 * Set the admitted overlay. Accepts either raw host entries or admission
 * results ({name, admitted, entry, manifest}) — whichever admitAdapters
 * handed back — validates + deep-freezes the host entry from each (throws on
 * a non-conforming entry), and stores the result. A second call replaces the
 * overlay outright (useful for tests via resetAdmitted()); production calls
 * this at most once per process since the env flag gates it.
 * @param {ReadonlyArray<any>} entries
 */
export function applyAdmitted(entries) {
  admittedEntries = Object.freeze((entries ?? []).map(conformOne));
  applied = true;
  return admittedEntries;
}

/** Test-only reset back to the unapplied, builtins-only state. */
export function resetAdmitted() {
  admittedEntries = Object.freeze([]);
  applied = false;
}

export function admittedHostIds() {
  return admittedEntries.map((entry) => entry.id);
}

/** Built-ins + admitted externals, both frozen. Returns HOST_REGISTRY itself
 *  (same reference) when nothing has been admitted, so callers that never
 *  opt into the experimental flag see byte-identical behavior. */
export function effectiveHostRegistry() {
  if (!applied || admittedEntries.length === 0) return HOST_REGISTRY;
  return Object.freeze([...HOST_REGISTRY, ...admittedEntries]);
}
