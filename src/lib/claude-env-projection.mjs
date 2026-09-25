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

/** One target's finding: `keys` maps each managed key to the engine's per-key state
 *  ('converged' | 'write' | 'restore' | 'release' | 'foreign' | 'user-edited'), or to
 *  'blocked' for every key when the whole file cannot be touched (`fileError`). */
function reconcileTarget(target, desired, receiptSuffix, dryRun) {
  try {
    const plan = planOwnedEnv(target, desired, { receiptSuffix, format: 'multi', editorFor });
    if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'ruflo-components' });
    return { file: target.file, status: plan.status, changed: plan.changed, keys: plan.keys ?? {}, conflicts: plan.conflicts ?? [] };
  } catch (error) {
    const keys = Object.fromEntries(Object.keys(desired).map((k) => [k, 'blocked']));
    return { file: target.file, status: 'conflict', changed: false, reason: error.message, fileError: true, keys, conflicts: [] };
  }
}

/** `userScope: false` skips the user settings file, for a project-only release (uninstall,
 *  or governance turned off, across every receipted project).
 *  @param {{projectRoot?: string|null, rufloVersion?: string, userSettingsFile?: string, dryRun?: boolean, userScope?: boolean}} [options] */
export function reconcileClaudeComponentEnv(cfg, options = {}) {
  const {
    projectRoot = null, rufloVersion, userSettingsFile = paths.claudeSettingsPath(), dryRun = false, userScope = true,
  } = options;
  const enabled = cfg?.integrations?.hosts?.claude !== false;
  const findings = [];
  if (userScope) {
    findings.push(reconcileTarget(
      { file: userSettingsFile, boundary: path.dirname(userSettingsFile), enabled },
      asStates(MACHINE_KEYS, machineComponentEnv(cfg, rufloVersion)), CLAUDE_RC_RECEIPT, dryRun));
  }
  if (projectRoot) {
    const local = paths.projectSettingsLocal(projectRoot);
    const wanted = asStates([RC_KEYS.enforce], componentEnv(projectRoot, cfg, rufloVersion));
    if (wanted[RC_KEYS.enforce].present || fs.existsSync(`${local}${CLAUDE_RC_RECEIPT}`)) {
      findings.push(reconcileTarget({ file: local, boundary: projectRoot, enabled }, wanted, CLAUDE_RC_RECEIPT, dryRun));
    }
  }
  // A preserved per-key conflict is reported (user-managed), not a failure; only a file ak
  // could not touch at all is.
  const ok = findings.every((f) => !f.fileError);
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
    // The pin is a single key: a preserved foreign or user-edited value means it is not ak's pin.
    if (plan.conflicts?.length) return { ok: false, changed: plan.changed, status: 'conflict', reason: plan.conflicts[0].reason };
    return { ok: true, changed: plan.changed || legacy, status: plan.status };
  } catch (error) { return { ok: false, changed: false, status: 'conflict', reason: error.message }; }
}
