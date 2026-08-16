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

// The ONLY two capabilities a grant may ever flip true (ADR-0031 §1: the
// permanent self-declaration ban — canBePrimary/commandStatusline can never
// come from the manifest itself, see manifest.mjs's cap-can-be-primary /
// cap-command-statusline refusals — so the sole other path to `true` is an
// explicit maintainer grant, applied here). Kept local to this module (not
// imported from grants.mjs's TIER_GRANTS) so this file's own guarantee does
// not depend on grants.mjs staying correct — belt-and-suspenders, per the
// keystone security review.
const GRANTABLE_CAPABILITIES = Object.freeze(['canBePrimary', 'commandStatusline']);

/**
 * Overlay ONE validated, admitted host entry with its earned capability
 * grants. `granted` is the caller-supplied {capability: true, ...} map for
 * THIS host — bootstrapHostAdapters (admission.mjs) is the sole production
 * caller, and it sources `granted` exclusively from grants.mjs's
 * grantedCapabilitiesFor() (hash-pinned to the CURRENT manifest, already
 * intersected with TIER_GRANTS at read time — see that module's header
 * invariant). This function does not simply trust that upstream filtering:
 * it re-intersects with its own local GRANTABLE_CAPABILITIES allow-list
 * below, so even a caller that got it wrong (or a future misuse of
 * applyAdmitted) can never smuggle a capability other than
 * canBePrimary/commandStatusline into the overlay — e.g. aqeProvider, or
 * flipping canRouteActivities, can NEVER reach an entry this way, no matter
 * what `granted` contains.
 *
 * Grants may only flip a capped capability TRUE, never back to false: the
 * validated manifest capabilities are the floor. With no grant (or a grant
 * that changes nothing — every relevant flag already true, or absent), the
 * SAME `entry` reference is returned unchanged, so the byte-identity
 * guarantee (no grants ⇒ effectiveHostRegistry() entries equal the validated
 * manifest entries) holds without a caller having to special-case it.
 * @param {any} entry — an already-validated, already-frozen host entry
 * @param {Record<string, boolean>|undefined} granted
 */
function withGrantedCapabilities(entry, granted) {
  if (!granted) return entry;
  let changed = false;
  const capabilities = { ...entry.capabilities };
  for (const capability of GRANTABLE_CAPABILITIES) {
    if (granted[capability] === true && capabilities[capability] !== true) {
      capabilities[capability] = true;
      changed = true;
    }
  }
  if (!changed) return entry;
  return Object.freeze({ ...entry, capabilities: Object.freeze(capabilities) });
}

/**
 * Set the admitted overlay. Accepts either raw host entries or admission
 * results ({name, admitted, entry, manifest}) — whichever admitAdapters
 * handed back — validates + deep-freezes the host entry from each (throws on
 * a non-conforming entry), and stores the result. A second call replaces the
 * overlay outright (useful for tests via resetAdmitted()); production calls
 * this at most once per process since the env flag gates it.
 *
 * `grantsByName` (optional) is a `{ [hostId]: { canBePrimary?: true,
 * commandStatusline?: true } }` lookup — the keystone that makes an earned
 * capability grant LIVE (ADR-0031 §1). Omitted (or a host absent from it),
 * the stored entry is exactly the validated manifest entry — the flag-off /
 * nothing-granted byte-identity this module has always guaranteed.
 * @param {ReadonlyArray<any>} entries
 * @param {{ grantsByName?: Record<string, Record<string, boolean>> }} [options]
 */
export function applyAdmitted(entries, { grantsByName } = {}) {
  admittedEntries = Object.freeze((entries ?? []).map((item) => {
    const entry = conformOne(item);
    // Object.hasOwn, never bare `grantsByName[entry.id]`/`in` (F-6):
    // entry.id is a consented-but-still-adapter-supplied string, so an id
    // like 'constructor' must never resolve via the prototype chain to
    // Object.prototype.constructor and be misread as a truthy grant record.
    // Belt-and-suspenders alongside admission.mjs building grantsByName as
    // Object.create(null) — this holds even for a caller (a test, a future
    // refactor) that passes a plain object literal instead.
    const granted = grantsByName && Object.hasOwn(grantsByName, entry.id) ? grantsByName[entry.id] : undefined;
    return withGrantedCapabilities(entry, granted);
  }));
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

/** Built-ins ∪ admitted hosts whose manifest declares
 *  capabilities.canRouteActivities — the LAZY set every routing VALIDATION
 *  path (routing.mjs's isRoutableHost, validateRoute, materializeRunPlan)
 *  must consult (P2, ADR-0031). routing.mjs's `HOSTS` constant stays frozen
 *  at import time and built-ins-only — it is display strings only now, never
 *  a validation source. Fresh on every call, like admittedHostIds() above. */
export function effectiveRoutableHostIds() {
  return effectiveHostRegistry()
    .filter((host) => host.capabilities.canRouteActivities === true)
    .map((host) => host.id);
}

/** Built-ins ∪ admitted hosts whose EFFECTIVE capabilities (validated
 *  manifest floor + any live grant overlay from applyAdmitted) include
 *  canBePrimary — the primary-eligibility sibling to effectiveRoutableHostIds
 *  above (ADR-0031 §1 keystone: this is what makes a granted canBePrimary
 *  actually count somewhere). hosts.mjs's drivingHost() consults this for its
 *  eligibility check — the primitive is live, though no production path
 *  currently drives kit.json's routing.primaryHost to an admitted external
 *  id (the picker that writes it stays built-in-only), so today this has no
 *  live privileged caller.
 *
 *  Deliberately NOT wired into routing.mjs's PRIMARY_HOSTS constant, which
 *  stays frozen at import time and built-ins-only: PRIMARY_HOSTS backs the
 *  primary-host SELECTION UX (`ak setup --primary-host`, `ak host pick`),
 *  and extending that picker to external hosts is out of scope this wave
 *  (deferred, same as HOSTS staying display-only in routing.mjs) — an
 *  eligibility reader and a selection-menu source are different concerns
 *  even though both currently trace back to the same capability.
 *
 *  Homed here (next to effectiveHostRegistry/effectiveRoutableHostIds), not
 *  in registries.mjs where the built-in-only primaryHostIds() lives: this
 *  file already imports registries.mjs for HOST_REGISTRY, so an
 *  effective-registry-aware selector living in registries.mjs would need the
 *  reverse import and create a real module cycle; lifecycle-registry.mjs's
 *  own effectiveHostRegistry import mirrors this same choice. Fresh on every
 *  call, like effectiveRoutableHostIds() above. */
export function effectivePrimaryHostIds() {
  return effectiveHostRegistry()
    .filter((host) => host.capabilities.canBePrimary === true)
    .map((host) => host.id);
}
