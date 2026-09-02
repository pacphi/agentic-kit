import path from 'node:path';

import { collectHookAudit } from './audit.mjs';
import {
  buildHookHealingPlan, publicHookHealingPlan,
} from '../lib/hook-remediation/planner.mjs';
import {
  applyHookHealingPlan, previewHookHealingRecovery, previewHookHealingUndo,
  recoverHookHealing, undoHookHealing,
} from '../lib/hook-remediation/engine.mjs';
import { hookHealingTransactionsDir } from '../lib/paths.mjs';
import { unfinishedHookReceipts } from '../lib/hook-remediation/store.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  project: { type: 'string', multiple: true },
  host: { type: 'string', multiple: true },
  'all-projects': { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  action: { type: 'string', multiple: true },
  'plan-digest': { type: 'string' },
  undo: { type: 'string' },
  recover: { type: 'string' },
  'transactions-root': { type: 'string' },
};

export const help = `ak heal hooks — preview, explicitly apply, verify, or undo bounded hook repairs

The default is a read-only deterministic plan. Applying requires every exact action ID,
the displayed plan digest, --apply, and --yes. Trust, consent, grants, plugin caches,
generated runtime copies, OpenCode modules, and unsupported host schemas are never changed.

Usage:
  ak heal hooks [--host HOST] [--project PATH] [--json]
  ak heal hooks --action ID... --plan-digest SHA --apply --yes
  ak heal hooks --undo RECEIPT_ID [--apply --yes]
  ak heal hooks --recover RECEIPT_ID [--apply --yes]

Options:
  --host HOST            codex, claude, opencode, external, or all (repeatable)
  --project PATH         add an explicit project (repeatable)
  --all-projects         include bounded project census roots
  --action ID            select an exact executable action (repeatable)
  --plan-digest SHA      bind apply to the exact previewed plan
  --apply --yes          explicitly perform the selected apply or undo
  --undo RECEIPT_ID      preview rollback; add --apply --yes to perform it
  --recover RECEIPT_ID   preview guarded recovery of an unfinished transaction
  --transactions-root P override the private transaction store (testing/recovery)
  --dry-run              assert preview-only behavior (also the default)
  --json                 emit machine-readable output

Examples:
  ak heal hooks --host all --json
  ak heal hooks --action <ID> --plan-digest <SHA> --apply --yes
  ak heal hooks --undo <RECEIPT_ID>
  ak heal hooks --undo <RECEIPT_ID> --apply --yes
  ak heal hooks --recover <RECEIPT_ID> --apply --yes`;

function transactionRoot(flags) {
  return path.resolve(flags['transactions-root'] ?? hookHealingTransactionsDir());
}

function printPlan(plan) {
  console.log(`ak heal hooks (dry-run: ${plan.hosts.join(', ')})`);
  console.log(`  audit: ${plan.auditId}`);
  console.log(`  plan digest: ${plan.planDigest}`);
  console.log(`  actions: ${plan.summary.total} (${plan.summary.executable} executable)`);
  for (const transaction of plan.unfinishedTransactions ?? []) {
    console.log(`  recovery required: ${transaction.id} [${transaction.status}]`);
  }
  for (const action of plan.actions) {
    const target = action.canonicalTarget?.file ?? action.target;
    console.log(`  - ${action.id} [${action.classification}] ${action.host}: ${target}`);
    console.log(`    owner: ${action.canonicalOwnership?.status ?? 'unproven'}; executable: ${action.executable ? 'yes' : 'no'}`);
    if (action.reason) console.log(`    why: ${action.reason}`);
    if (action.behaviorImpact) console.log(`    behavior: ${action.behaviorImpact}`);
    if (action.trustImpact) console.log(`    trust: ${action.trustImpact}`);
    if (action.diff) console.log(action.diff.split('\n').map((line) => `    ${line}`).join('\n'));
    if (action.rollback) console.log(`    rollback: ${action.rollback}`);
  }
  console.log('  no files changed; apply requires exact --action IDs, --plan-digest, --apply, and --yes');
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`ak heal hooks: ${result.status}`);
    if (result.receiptId) console.log(`  receipt: ${result.receiptId}`);
    if (result.error) console.error(`  ${result.error}`);
  }
  return result.ok ? 0 : 1;
}

function validateMode(flags) {
  if (flags.apply && flags['dry-run']) throw new TypeError('--apply and --dry-run are mutually exclusive');
  if (flags.yes && !flags.apply) throw new TypeError('--yes requires --apply');
  if (flags.apply && !flags.yes) throw new TypeError('--apply requires --yes');
}

export async function run({ flags, positionals, detectVersionFn, loadConfigFn }) {
  if (positionals.length !== 1 || positionals[0] !== 'hooks') {
    console.error('ak heal requires the hooks subcommand');
    console.log(help);
    return 2;
  }
  try { validateMode(flags); } catch (error) {
    console.error(`hook healing refused: ${error.message}`);
    return 2;
  }
  const transactionsRoot = transactionRoot(flags);
  if (flags.undo && flags.recover) {
    console.error('hook healing refused: --undo and --recover are mutually exclusive');
    return 2;
  }
  if (flags.undo || flags.recover) {
    if ((flags.action?.length ?? 0) || flags['plan-digest']) {
      console.error('hook healing refused: rollback/recovery cannot be combined with plan action flags');
      return 2;
    }
    const result = flags.recover
      ? (flags.apply
        ? recoverHookHealing({ transactionsRoot, receiptId: flags.recover })
        : previewHookHealingRecovery({ transactionsRoot, receiptId: flags.recover }))
      : (flags.apply
        ? undoHookHealing({ transactionsRoot, receiptId: flags.undo })
        : previewHookHealingUndo({ transactionsRoot, receiptId: flags.undo }));
    return printResult(result, flags.json);
  }

  let audit;
  let plan;
  try {
    const collect = () => collectHookAudit({ flags, detectVersionFn, loadConfigFn });
    audit = collect();
    plan = buildHookHealingPlan({ report: audit });
    const unfinishedTransactions = unfinishedHookReceipts(transactionsRoot).map((receipt) => ({
      id: receipt.id, status: receipt.status, createdAt: receipt.createdAt,
    }));
    if (!flags.apply) {
      const publicPlan = { ...publicHookHealingPlan(plan), unfinishedTransactions };
      if (flags.json) console.log(JSON.stringify(publicPlan, null, 2));
      else printPlan(publicPlan);
      return audit.summary.invalidSources || audit.summary.configurationIssues ? 1 : 0;
    }
    if (!flags.action?.length || !flags['plan-digest']) {
      console.error('hook healing refused: apply requires --action and --plan-digest from a preview');
      return 2;
    }
    if (unfinishedTransactions.length) {
      throw new Error(`unfinished hook transaction(s) require --recover first: ${unfinishedTransactions.map((item) => item.id).join(', ')}`);
    }
    const result = applyHookHealingPlan({
      plan,
      actionIds: flags.action,
      expectedPlanDigest: flags['plan-digest'],
      transactionsRoot,
      auditFn: collect,
    });
    return printResult(result, flags.json);
  } catch (error) {
    console.error(`hook healing failed: ${error.message}`);
    return 2;
  }
}
