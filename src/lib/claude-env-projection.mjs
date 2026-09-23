// ADR-0058 §3 (Claude): machine keys in the user settings env; project enforcement and the
// memory pin in the project's settings.local.json env. Receipted by the shared engine.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { planOwnedEnv, applyOwnedEnv, jsonTopLevelEnvEditor, readRegularConfig } from './owned-env-projection.mjs';
import { machineComponentEnv, componentEnv, RC_KEYS } from './ruflo-components/env.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

export const CLAUDE_RC_RECEIPT = '.agentic-kit-ruflo-components.json';
export const MEMORY_PIN_RECEIPT = '.agentic-kit-memory-pin.json';
const MACHINE_KEYS = [RC_KEYS.typesafe, RC_KEYS.embedder, RC_KEYS.mode];
const editorFor = (source) => jsonTopLevelEnvEditor(source);
const asStates = (keys, env) => Object.fromEntries(keys.map((k) => [k, k in env ? { present: true, value: env[k] } : { present: false }]));

/** The shared engine never deletes a config file it emptied out (it only ever
 *  rewrites in place). Once the last owned key is removed and nothing else was
 *  in the file, an empty `{}` envelope has no reason to linger — prune it so a
 *  fully-reverted reconcile leaves no trace. Best-effort: any surprise (file
 *  gone already, not JSON, a symlink) just leaves the file alone. */
function pruneIfEmptyEnvelope(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc && typeof doc === 'object' && !Array.isArray(doc) && Object.keys(doc).length === 0) {
      fs.unlinkSync(file);
    }
  } catch { /* leave the file exactly as the engine wrote it */ }
}

function reconcileTarget(target, desired, receiptSuffix, dryRun) {
  try {
    const plan = planOwnedEnv(target, desired, { receiptSuffix, format: 'multi', editorFor });
    if (plan.changed && !dryRun) {
      applyOwnedEnv(plan, { backupTag: 'ruflo-components' });
      pruneIfEmptyEnvelope(target.file);
    }
    return { file: target.file, status: plan.status, changed: plan.changed };
  } catch (error) { return { file: target.file, status: 'conflict', changed: false, reason: error.message }; }
}

/** @param {{projectRoot?: string|null, rufloVersion?: string, userSettingsFile?: string, dryRun?: boolean}} [options] */
export function reconcileClaudeComponentEnv(cfg, options = {}) {
  const {
    projectRoot = null, rufloVersion, userSettingsFile = paths.claudeSettingsPath(), dryRun = false,
  } = options;
  const enabled = cfg?.integrations?.hosts?.claude !== false;
  const findings = [reconcileTarget(
    { file: userSettingsFile, boundary: path.dirname(userSettingsFile), enabled },
    asStates(MACHINE_KEYS, machineComponentEnv(cfg, rufloVersion)), CLAUDE_RC_RECEIPT, dryRun)];
  if (projectRoot) {
    const local = paths.projectSettingsLocal(projectRoot);
    const wanted = asStates([RC_KEYS.enforce], componentEnv(projectRoot, cfg, rufloVersion));
    if (wanted[RC_KEYS.enforce].present || fs.existsSync(`${local}${CLAUDE_RC_RECEIPT}`)) {
      findings.push(reconcileTarget({ file: local, boundary: projectRoot, enabled }, wanted, CLAUDE_RC_RECEIPT, dryRun));
    }
  }
  const ok = findings.every((f) => f.status !== 'conflict');
  return { ok, changed: findings.some((f) => f.changed), findings };
}

/** ADR-0016 drift fix: the memory pin gains a receipt. A legacy unreceipted pin equal to the
 *  value ak itself computes was written by earlier ak versions and is adopted once. */
export function reconcileMemoryPin(projectRoot, { enabled = true, dryRun = false } = {}) {
  const local = paths.projectSettingsLocal(projectRoot);
  const receiptFile = `${local}${MEMORY_PIN_RECEIPT}`;
  const pin = paths.projectMemoryDb(fs.realpathSync(projectRoot));
  const target = { file: local, boundary: projectRoot, enabled };
  const desired = { CLAUDE_FLOW_DB_PATH: { present: true, value: pin } };
  let legacy;
  try {
    const source = readRegularConfig(local);
    legacy = source !== null && readRegularConfig(receiptFile) === null
      && jsonTopLevelEnvEditor(source).get('CLAUDE_FLOW_DB_PATH').value === pin;
  } catch (error) { return { ok: false, changed: false, status: 'conflict', reason: error.message }; }
  if (legacy) {
    if (!dryRun) {
      writePrivateFileAtomic(receiptFile, JSON.stringify({ version: 2, pending: false,
        keys: { CLAUDE_FLOW_DB_PATH: { before: { present: false }, after: { present: true, value: pin } } } }) + '\n');
    }
    if (enabled) return { ok: true, changed: !dryRun, status: 'adopted' };
  }
  try {
    const plan = planOwnedEnv(target, desired, { receiptSuffix: MEMORY_PIN_RECEIPT, format: 'multi', editorFor });
    if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'memory-pin' });
    return { ok: true, changed: plan.changed || legacy, status: plan.status };
  } catch (error) { return { ok: false, changed: false, status: 'conflict', reason: error.message }; }
}
