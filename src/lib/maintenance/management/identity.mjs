// ADR-0048 identity construction. Every id in the management projection is an
// opaque, installation-keyed HMAC over a bounded material tuple (model.mjs's
// `opaqueId`) — never a raw path, never a reversible encoding of the display
// name. This module owns WHAT goes into that tuple for each identity kind so
// every other slice derives ids the same way.
//
// The governing rule (ADR-0048 §3, domain-model.md "ManagedResource"): equal
// display names never establish equal identity. Kind, host namespace,
// producer, source selector, project, and a bounded definition digest
// participate only where independently verified; a human-friendly label never
// does.
import { ID_PREFIXES, opaqueId } from './model.mjs';

function idFactory(prefixKey) {
  const prefix = ID_PREFIXES[prefixKey];
  return (material, installationKey) => opaqueId(prefix, material, installationKey);
}

// Identities with no bespoke shaping: the material IS the caller's descriptor.
export const environmentIdentity = idFactory('environment');
export const sourceIdentity = idFactory('source');
export const scanIdentity = idFactory('scan');
export const recipeIdentity = idFactory('recipe');
export const dispositionIdentity = idFactory('disposition');
export const inventoryIdentity = idFactory('inventory');
export const previewIdentity = idFactory('preview');
export const exclusionIdentity = idFactory('exclusion');
export const evidenceIdentity = idFactory('evidence');
export const checklistIdentity = idFactory('checklist');
export const guidanceIdentity = idFactory('guidance');

/**
 * The logical resource a person recognizes. `sourceSelector` is the exact
 * name/capability the source uses (a catalog canonical id, a model id, a
 * package name) — never the rendered display name. `projectId` participates
 * directly: a project-owned resource (an instruction file, a project-scoped
 * skill) is its own logical thing per project, not a shared identity that
 * happens to repeat a filename. `definitionDigest` may be supplied only when
 * a bounded content digest has been independently verified; passing an
 * unverified digest here would silently upgrade inferred evidence to identity.
 */
export function resourceIdentity({
  kind, hostNamespace = null, producer = null, sourceSelector = null, projectId = null,
  definitionDigest = null,
}, installationKey) {
  if (!kind) throw new TypeError('resourceIdentity requires a kind');
  return opaqueId(ID_PREFIXES.resource, {
    kind, hostNamespace, producer, sourceSelector, projectId, definitionDigest,
  }, installationKey);
}

/**
 * The exact selectable/actionable row. Distinguished by its logical resource,
 * its environment, its administrative scope, and an exact carrier-location
 * selector — never by display name, and never by anything that changes released
 * ordering only (case, whitespace).
 */
export function placementIdentity({
  resourceId, environmentId, administrativeScope, projectId = null, locationSelector = null,
}, installationKey) {
  if (!resourceId || !environmentId || !administrativeScope) {
    throw new TypeError('placementIdentity requires resourceId, environmentId, and administrativeScope');
  }
  return opaqueId(ID_PREFIXES.placement, {
    resourceId, environmentId, administrativeScope, projectId, locationSelector,
  }, installationKey);
}

/** A measured carrier. `locator` is any bounded, stable descriptor of the
 *  exact carrier (a path+selector hash, an existing catalog artifact id) —
 *  never the raw path itself; the caller decides what identifies the carrier. */
export function artifactIdentity({ carrier, locator = null }, installationKey) {
  if (!carrier) throw new TypeError('artifactIdentity requires a carrier');
  return opaqueId(ID_PREFIXES.artifact, { carrier, locator }, installationKey);
}

export function bindingIdentity({
  placementId, artifactId = null, consumerKind, consumerLabel = null, mechanism = null,
}, installationKey) {
  if (!placementId || !consumerKind) {
    throw new TypeError('bindingIdentity requires placementId and consumerKind');
  }
  return opaqueId(ID_PREFIXES.binding, {
    placementId, artifactId, consumerKind, consumerLabel, mechanism,
  }, installationKey);
}

export function edgeIdentity({ fromPlacementId, toId, kind, requirement = null }, installationKey) {
  if (!fromPlacementId || !toId || !kind) {
    throw new TypeError('edgeIdentity requires fromPlacementId, toId, and kind');
  }
  return opaqueId(ID_PREFIXES.edge, { fromPlacementId, toId, kind, requirement }, installationKey);
}

/** Placement order never participates: `{a,b}` and `{b,a}` are one conflict.
 *  Every kind but `shared-artifact` needs 2+ placements; a shared-artifact
 *  set may name just one (J2: one placement, two bindings on one artifact is
 *  still a shared-artifact set), so `artifactIds` participates in its
 *  material too — otherwise two DIFFERENT artifacts that happen to both
 *  reach the same single placement would collide on one conflictId. */
export function conflictIdentity({ kind, placementIds, artifactIds = null }, installationKey) {
  if (!kind) throw new TypeError('conflictIdentity requires a kind');
  const minimum = kind === 'shared-artifact' ? 1 : 2;
  if (!Array.isArray(placementIds) || placementIds.length < minimum) {
    throw new TypeError(`conflictIdentity requires a kind and at least ${minimum} placement id(s)`);
  }
  return opaqueId(ID_PREFIXES.conflict, {
    kind, placementIds: [...placementIds].sort(),
    artifactIds: artifactIds ? [...artifactIds].sort() : null,
  }, installationKey);
}

/**
 * One exact project/worktree identity. A verified git remote plus the exact
 * worktree root distinguishes two worktrees of the same repository (which
 * share a remote but not a root). Absent a verified remote, the lexical root
 * is the fallback identity — still opaque; the raw path never leaves this
 * function un-hashed.
 */
export function projectIdentity({
  verifiedRemote = null, worktreeRoot = null, lexicalRoot = null,
}, installationKey) {
  if (!verifiedRemote && !worktreeRoot && !lexicalRoot) {
    throw new TypeError('projectIdentity requires a verified remote, worktree root, or lexical root');
  }
  return opaqueId(ID_PREFIXES.project, { verifiedRemote, worktreeRoot, lexicalRoot }, installationKey);
}
