import { heading, info, warn, dim } from '../lib/output.mjs';
import { createMaintenanceService } from '../lib/maintenance/service.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  project: { type: 'string' },
  findings: { type: 'string' },
  'safety-class': { type: 'string' },
  executable: { type: 'boolean', default: false },
  plan: { type: 'string' },
  digest: { type: 'string' },
  actions: { type: 'string' },
  receipt: { type: 'string' },
  yes: { type: 'boolean', default: false },
};

export const help = `ak maintain — evidence, immutable plans, and guarded provider actions

System measures; Maintenance explains what needs attention and prepares exact,
short-lived plans. Apply, undo, and recovery require explicit, exact confirmation.

Usage:
  ak maintain scan [--deep] [--json]
  ak maintain plan [--findings ID,...] [--safety-class CLASS] [--project PATH] [--executable] [--json]
  ak maintain apply --plan ID --digest SHA256 --actions ID,... --yes [--json]
  ak maintain undo --receipt ID --yes [--json]
  ak maintain recover --receipt ID --yes [--json]

Options:
  --deep                explicitly refresh the System deep scan before reading
  --findings ID,...     exact finding IDs to include (one safety class per plan)
  --safety-class CLASS  select findings from one safety class
  --project PATH        select findings for one reported project
  --executable          derive actions from fresh native provider evidence and persist the plan
  --plan ID             exact persisted executable plan ID
  --digest SHA256       exact executable plan digest shown at preview
  --actions ID,...      exact action IDs shown at preview
  --receipt ID          exact receipt ID to undo or reconcile
  --yes                 explicit confirmation for apply, undo, or recovery
  --json                emit the complete content-free DTO or plan

Examples:
  ak maintain scan
  ak maintain scan --deep --json
  ak maintain plan --findings maintenance-finding-abc --executable --json
  ak maintain apply --plan maintenance-plan-abc --digest SHA256 --actions maintenance-action-abc --yes
  ak maintain undo --receipt mnt-receipt --yes
  ak maintain recover --receipt mnt-receipt --yes`;

const findingIds = (raw) => raw
  ? [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))].sort()
  : null;
const actionIds = (raw) => raw
  ? raw.split(',').map((value) => value.trim()).filter(Boolean).sort()
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
  heading(`Maintenance plan — ${plan.mode}`);
  info(`${plan.planId} · ${plan.safetyClass} · ${plan.actions.length} action(s)`);
  info(`Expires ${plan.expiresAt}`);
  info(dim('Nothing was changed. Apply requires this exact plan ID, digest, action selection, and --yes.'));
}

function renderMutation(result, verb) {
  heading(`Maintenance ${verb}`);
  info(`${result.status}${result.receiptId ? ` · ${result.receiptId}` : ''}`);
  if (result.error) warn(result.error);
}

function inputError(verb, flags, positionals) {
  if (positionals.length > 1 || !['scan', 'plan', 'apply', 'undo', 'recover'].includes(verb)) {
    return 'usage: ak maintain scan|plan|apply|undo|recover [options]';
  }
  if (verb === 'apply' && (!flags.plan || !flags.digest || !flags.actions || flags.yes !== true)) {
    return 'Maintenance apply requires --plan, --digest, --actions, and --yes.';
  }
  if (verb === 'undo' && (!flags.receipt || flags.yes !== true)) {
    return 'Maintenance undo requires --receipt and --yes.';
  }
  if (verb === 'recover' && (!flags.receipt || flags.yes !== true)) {
    return 'Maintenance recovery requires --receipt and --yes.';
  }
  return null;
}

async function dispatch(service, verb, flags) {
  if (verb === 'scan') return service.scan({ deep: flags.deep === true });
  if (verb === 'plan') return service.plan({
    deep: flags.deep === true,
    findingIds: findingIds(flags.findings),
    project: flags.project ?? null,
    ...(flags['safety-class'] ? { safetyClass: flags['safety-class'] } : {}),
    ...(flags.executable === true ? { executable: true, persist: true } : {}),
  });
  if (verb === 'apply') return service.apply({
    planId: flags.plan,
    expectedPlanDigest: flags.digest,
    actionIds: actionIds(flags.actions),
    confirmed: true,
  });
  if (verb === 'undo') return service.undo({ receiptId: flags.receipt, confirmed: true });
  return service.recover({ receiptId: flags.receipt, confirmed: true });
}

function renderResult(result, verb, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (verb === 'scan') renderScan(result);
  else if (verb === 'plan') renderPlan(result);
  else renderMutation(result, verb);
}

/** CLI adapter over the shared Maintenance application service.
 * @param {{ flags: Record<string, any>, positionals: string[], deps?: { service?: any } }} input */
export async function run({ flags, positionals, deps = {} }) {
  const verb = positionals[0] ?? 'scan';
  const invalid = inputError(verb, flags, positionals);
  if (invalid) {
    warn(invalid);
    return 2;
  }
  const service = deps.service ?? createMaintenanceService();
  try {
    const result = await dispatch(service, verb, flags);
    renderResult(result, verb, flags.json);
    return result?.ok === false ? 2 : 0;
  } catch (error) {
    warn(error?.message ?? String(error));
    return 2;
  }
}
