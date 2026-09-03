import { heading, info, warn, dim } from '../lib/output.mjs';
import { createMaintenanceService } from '../lib/maintenance/service.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  project: { type: 'string' },
  findings: { type: 'string' },
  'safety-class': { type: 'string' },
};

export const help = `ak maintain — read-only Maintenance findings and immutable plans

System measures; Maintenance explains what needs attention and prepares exact,
short-lived plans. This delivery does not enable apply or undo.

Usage:
  ak maintain scan [--deep] [--json]
  ak maintain plan [--findings ID,...] [--safety-class CLASS] [--project PATH] [--json]

Options:
  --deep                explicitly refresh the System deep scan before reading
  --findings ID,...     exact finding IDs to include (one safety class per plan)
  --safety-class CLASS  select findings from one safety class
  --project PATH        select findings for one reported project
  --json                emit the complete content-free DTO or plan

Apply and undo are not enabled in this read-only delivery.

Examples:
  ak maintain scan
  ak maintain scan --deep --json
  ak maintain plan --findings maintenance-finding-abc --json`;

const findingIds = (raw) => raw
  ? [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))].sort()
  : null;

function renderScan(model) {
  heading('Maintenance — read-only findings');
  info(`Evidence: ${model.freshness.status} · ${model.freshness.completeness}`);
  info(`${model.summary.updatesReady} updates ready · ${model.summary.safeCleanup} safe cleanup · `
    + `${model.summary.needsReview} needs review · ${model.summary.unsupportedOrBlocked} blocked`);
  for (const finding of model.findings) {
    info(`${finding.resource.name}: ${finding.state} · ${finding.nextAction.label}`);
  }
  if (!model.findings.length) info(dim('No maintenance findings in the measured evidence.'));
}

function renderPlan(plan) {
  heading('Maintenance plan — read-only');
  info(`${plan.planId} · ${plan.safetyClass} · ${plan.actions.length} action(s)`);
  info(`Expires ${plan.expiresAt}`);
  info(dim('Nothing was changed. Apply and undo are not enabled in this delivery.'));
}

/** CLI adapter over the shared Maintenance application service.
 * @param {{ flags: Record<string, any>, positionals: string[], deps?: { service?: any } }} input */
export async function run({ flags, positionals, deps = {} }) {
  const verb = positionals[0] ?? 'scan';
  if (positionals.length > 1 || !['scan', 'plan', 'apply', 'undo'].includes(verb)) {
    warn('usage: ak maintain scan|plan [--deep] [--json]');
    return 2;
  }
  if (verb === 'apply' || verb === 'undo') {
    warn(`Maintenance ${verb} is not enabled; this capability is read-only.`);
    return 2;
  }
  const service = deps.service ?? createMaintenanceService();
  try {
    const result = verb === 'scan'
      ? await service.scan({ deep: flags.deep === true })
      : await service.plan({
        deep: flags.deep === true,
        findingIds: findingIds(flags.findings),
        project: flags.project ?? null,
        ...(flags['safety-class'] ? { safetyClass: flags['safety-class'] } : {}),
      });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (verb === 'scan') renderScan(result);
    else renderPlan(result);
    return 0;
  } catch (error) {
    warn(error?.message ?? String(error));
    return 2;
  }
}
