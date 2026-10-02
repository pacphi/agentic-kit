// The hook evidence a Maintenance inventory refresh reads: the sanitized hook read model plus the
// server-private placement context that says which repository a project hook belongs to. Both come from
// one run of the same read-only audit `ak audit hooks` uses. The context holds the project roots the
// public read model deliberately leaves out; it is consumed by the projection and never serialized.
import path from 'node:path';
import { buildHookDashboardReadModel } from '../../hook-read-model.mjs';
import { isProjectHookKind } from './hook-scope.mjs';

/** Every host, and every git repository the project census knows (the repositories Maintenance's
 *  inventory already lists), not only the working directory. */
const INVENTORY_FLAGS = Object.freeze({ host: ['all'], project: [], 'all-projects': true });

/** `(occurrenceId) => { projectRoot } | null`, from the raw audit records of project-kind sources. A
 *  record without an absolute project root is left out, so its placement falls back to user scope with
 *  a visible condition instead of landing in a guessed repository. @param {any} audit */
export function buildHookPlacementContext(audit) {
  const roots = new Map();
  for (const report of Object.values(audit?.reports ?? {})) {
    for (const record of /** @type {any} */ (report)?.records ?? []) {
      if (!isProjectHookKind(record?.source?.sourceKind) || typeof record.occurrenceId !== 'string') continue;
      const root = record.scope?.projectPath ?? record.source?.baseDir;
      if (typeof root === 'string' && path.isAbsolute(root)) roots.set(record.occurrenceId, { projectRoot: root });
    }
  }
  return (occurrenceId) => roots.get(occurrenceId) ?? null;
}

/**
 * Run the hook audit once and return what the inventory projection takes.
 * @param {{ audit?: () => any, flags?: object }} [options] `audit` replaces the real audit (tests)
 * @returns {Promise<{ hookReadModel: object, hookPlacementContext: (occurrenceId: string) => { projectRoot: string } | null }>}
 */
export async function collectHookEvidence({ audit, flags = INVENTORY_FLAGS } = {}) {
  const report = audit ? audit() : (await import('../../../commands/audit.mjs')).collectHookAudit({ flags });
  return {
    hookReadModel: buildHookDashboardReadModel({ audit: report, receipts: [], healingPlan: null }),
    hookPlacementContext: buildHookPlacementContext(report),
  };
}
