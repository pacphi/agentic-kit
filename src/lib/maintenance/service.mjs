import { createSystemCollector } from '../footprint/index.mjs';
import { projectReference } from './evidence.mjs';
import { buildMaintenancePlan } from './planner.mjs';
import { buildMaintenanceReadModel } from './read-model.mjs';

const disabled = (operation) => new Error(
  `Maintenance ${operation} is not enabled; this capability is read-only.`,
);

/** Application service shared by CLI and future dashboard adapters. */
export function createMaintenanceService({ collector = createSystemCollector(), now = Date.now } = {}) {
  async function scan({ deep = false } = {}) {
    if (deep) await collector.refreshDeep();
    const footprint = await collector.read();
    return buildMaintenanceReadModel({ footprint, now });
  }

  async function plan({ findingIds = null, safetyClass = null, project = null, deep = false } = {}) {
    const model = await scan({ deep });
    const requested = findingIds ? new Set(findingIds) : null;
    const selectedProject = projectReference(project);
    const findings = model.findings.filter((finding) => (
      (!requested || requested.has(finding.id))
      && (!safetyClass || finding.safetyClass === safetyClass)
      && (!selectedProject || finding.resource.projectRef === selectedProject)
    ));
    if (requested) {
      const missing = [...requested].filter((id) => !findings.some((finding) => finding.id === id));
      if (missing.length) throw new Error(`Maintenance findings are absent or drifted: ${missing.join(', ')}`);
    }
    return buildMaintenancePlan({
      findings,
      sourceFingerprint: model.sourceFingerprint,
      now,
    });
  }

  return Object.freeze({
    scan,
    plan,
    async apply() { throw disabled('apply'); },
    async undo() { throw disabled('undo'); },
  });
}
