// Which Maintenance scope a hook placement has, from where its host reads it. The hook read model is
// path-free on purpose (tests/kit/hook-read-model.test.mjs), so each placement carries only the audit
// record's `sourceKind`; the project root, where there is one, comes from a server-private placement
// context (hook-evidence.mjs) and never reaches the browser.

const SYSTEM_KINDS = new Set(['managed']);
const PROJECT_KINDS = new Set(['project', 'project-inline', 'project-plugin']);

/** `system` for an administrator-managed source, `project` for one inside a repository, and `user` for
 *  everything else: the user's own settings, plugin caches, external adapter manifests, and a source
 *  kind that is missing or not recognized (the scope every hook had before it was mapped). */
export function hookScopeForKind(kind) {
  if (SYSTEM_KINDS.has(kind)) return 'system';
  if (PROJECT_KINDS.has(kind)) return 'project';
  return 'user';
}

/** @param {unknown} kind */
export const isProjectHookKind = (kind) => PROJECT_KINDS.has(/** @type {string} */ (kind));

/** The distinct project roots the context knows for a read model's project-kind placements, so the
 *  projection can register them before mapping. @param {any} hookReadModel
 *  @param {((occurrenceId: string) => { projectRoot: string } | null) | null | undefined} context */
export function hookProjectRoots(hookReadModel, context) {
  if (typeof context !== 'function') return [];
  const roots = new Set();
  for (const group of hookReadModel?.definitionGroups ?? []) {
    for (const placement of group.placements ?? []) {
      if (!isProjectHookKind(placement.source?.kind)) continue;
      const root = context(placement.occurrenceId)?.projectRoot;
      if (typeof root === 'string' && root) roots.add(root);
    }
  }
  return [...roots];
}
