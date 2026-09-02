// Explicit hook remediation. Planning stays read-only; mutation requires exact
// action ids, a content-bound plan digest, and interactive or --yes approval.
import { buildHookAudit, detectedVersion } from './audit.mjs';
import readline from 'node:readline/promises';
import { loadKitConfig } from '../lib/config.mjs';
import { hookTransactionsDir } from '../lib/paths.mjs';
import {
  applyHookHealingPlan, previewHookHealingUndo, undoHookHealing,
} from '../lib/hook-remediation/engine.mjs';
import { buildHookHealingPlan, publicHookHealingPlan } from '../lib/hook-remediation/planner.mjs';
import { unfinishedHookReceipts } from '../lib/hook-remediation/store.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  project: { type: 'string', multiple: true },
  host: { type: 'string', multiple: true },
  'all-projects': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  action: { type: 'string', multiple: true },
  'expect-plan': { type: 'string' },
  yes: { type: 'boolean', default: false },
  last: { type: 'boolean', default: false },
  receipt: { type: 'string' },
};

export const help = `ak hooks — inspect and explicitly remediate host hook configuration

Usage:
  ak hooks doctor [audit options]
  ak hooks heal --dry-run [audit options]
  ak hooks heal --action ID --expect-plan SHA256 --yes [audit options]
  ak hooks undo (--last | --receipt ID) [--dry-run] [--yes]

Options:
  --project PATH      add an explicit project (repeatable)
  --host HOST         select codex, claude, opencode, external, or all
  --all-projects      include bounded Git-project census
  --dry-run           show the exact plan or undo without writing
  --action ID         authorize exactly one planned action (repeatable)
  --expect-plan HASH  require this exact content-bound plan digest
  --receipt ID        select an exact transaction receipt for undo
  --last              select the newest valid receipt for undo
  --yes               confirm the explicitly selected actions in non-interactive use
  --json              emit one machine-readable object

Examples:
  ak hooks doctor --host all
  ak hooks heal --dry-run --json
  ak hooks heal --action hook-heal-EXACT_ID --expect-plan EXACT_SHA256 --yes
  ak hooks undo --last --dry-run

The current executable recipe is intentionally narrow: exact Codex 0.151.0,
user-owned global hooks.json, SessionEnd timeout normalization only. Other host,
project, generated, plugin-cache, and external-adapter actions remain review-only.`;

function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
}

function failure(error, json, status = 'refused') {
  const result = { ok: false, status, error: error?.message ?? String(error) };
  if (json) emit(result, true);
  else console.error(`hook operation refused: ${result.error}`);
  return 2;
}

function auditFrom(flags, dependencies) {
  if (dependencies.auditFn) return dependencies.auditFn();
  return buildHookAudit({
    flags,
    detectVersionFn: dependencies.detectVersionFn ?? detectedVersion,
    loadConfigFn: dependencies.loadConfigFn ?? loadKitConfig,
  });
}

function printPlan(plan) {
  console.log(`ak hooks heal (${plan.summary.executable} executable action(s))`);
  console.log(`  plan: ${plan.planDigest}`);
  for (const action of plan.actions) {
    console.log(`  - ${action.id} [${action.classification}] ${action.canonicalTarget?.file ?? action.target}`);
  }
  console.log('  no files changed; authorize exact ids with --action, bind the plan with --expect-plan, then confirm with --yes');
}

async function requireApproval(flags, message, approvalFn) {
  if (flags.yes) return;
  if (approvalFn) {
    if (!await approvalFn(message)) throw new Error('hook operation was not approved');
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('non-interactive healing requires --yes');
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${message}\nType "yes" to continue: `);
    if (answer.trim().toLowerCase() !== 'yes') throw new Error('hook operation was not approved');
  } finally {
    prompt.close();
  }
}

function validateUndoSelector(flags) {
  if (Boolean(flags.last) === Boolean(flags.receipt)) {
    throw new Error('select exactly one receipt with --last or --receipt ID');
  }
}

/** @param {any} options */
export async function run({
  flags,
  positionals,
  detectVersionFn = detectedVersion,
  loadConfigFn = loadKitConfig,
  auditFn,
  approvalFn,
  transactionsRoot = hookTransactionsDir(),
} = {}) {
  const subcommand = positionals[0];
  if (positionals.length !== 1 || !['doctor', 'heal', 'undo'].includes(subcommand)) {
    return failure(new Error('expected doctor, heal, or undo'), flags.json, 'usage');
  }
  const dependencies = { detectVersionFn, loadConfigFn, auditFn };
  if (subcommand === 'doctor') {
    try {
      const report = auditFrom(flags, dependencies);
      if (flags.json) emit(report, true);
      else {
        console.log(`ak hooks doctor (read-only: ${report.hosts.join(', ')})`);
        console.log(`  sources: ${report.summary.sources} (${report.summary.invalidSources} invalid)`);
        console.log(`  findings: ${report.summary.configurationIssues} configuration issue(s)`);
        console.log('  trust and hook files: unchanged');
        const unfinished = unfinishedHookReceipts(transactionsRoot);
        if (unfinished.length) console.log(`  recovery: ${unfinished.length} unfinished transaction(s); inspect with ak hooks undo --last --dry-run`);
      }
      return report.summary.invalidSources || report.summary.configurationIssues ? 1 : 0;
    } catch (error) { return failure(error, flags.json); }
  }

  if (subcommand === 'undo') {
    try {
      validateUndoSelector(flags);
      if (flags['dry-run']) {
        const preview = previewHookHealingUndo({
          transactionsRoot, receiptId: flags.receipt, last: flags.last,
        });
        if (flags.json) emit(preview, true);
        else console.log(preview.ok
          ? `undo ${preview.receiptId}: ${preview.actions.filter((action) => action.status === 'ready').length} action(s) ready`
          : `undo refused: ${preview.error}`);
        return preview.ok ? 0 : 2;
      }
      const preview = previewHookHealingUndo({
        transactionsRoot, receiptId: flags.receipt, last: flags.last,
      });
      if (!preview.ok) {
        if (flags.json) emit(preview, true);
        else console.error(`undo refused: ${preview.error}`);
        return 2;
      }
      await requireApproval(
        flags,
        `Restore ${preview.actions.filter((action) => action.status === 'ready').length} action(s) from receipt ${preview.receiptId}?`,
        approvalFn,
      );
      const result = undoHookHealing({
        transactionsRoot, receiptId: preview.receiptId, last: false,
      });
      if (flags.json) emit(result, true);
      else console.log(result.ok ? `hook transaction ${result.receiptId}: ${result.status}` : `undo refused: ${result.error}`);
      return result.ok ? 0 : 2;
    } catch (error) { return failure(error, flags.json); }
  }

  try {
    const report = auditFrom(flags, dependencies);
    const plan = buildHookHealingPlan({ report });
    if (flags['dry-run']) {
      const publicPlan = publicHookHealingPlan(plan);
      if (flags.json) emit(publicPlan, true);
      else printPlan(publicPlan);
      return 0;
    }
    const selected = [...new Set(flags.action ?? [])].sort();
    await requireApproval(
      flags,
      `Apply ${selected.length} exact hook action(s) from plan ${plan.planDigest}: ${selected.join(', ') || '(none)'}?`,
      approvalFn,
    );
    const result = applyHookHealingPlan({
      plan,
      actionIds: flags.action,
      expectedPlanDigest: flags['expect-plan'],
      transactionsRoot,
      auditFn: () => auditFrom(flags, dependencies),
      replanFn: (nextReport) => buildHookHealingPlan({ report: nextReport }),
    });
    if (flags.json) emit(result, true);
    else console.log(result.ok
      ? `hook transaction ${result.receiptId}: ${result.status}`
      : `hook healing refused: ${result.error}`);
    return result.ok ? 0 : 2;
  } catch (error) { return failure(error, flags.json); }
}
