// ADR-0058 §1: `ak uninstall` undoes every receipted ruflo component change — the Claude
// user env, and in EVERY project ak holds a receipt for (not only the cwd project) the
// policy file, project env key and memory pin — then the funnel toggle and, under
// --purge, the typesafe package. Returns report lines rather than printing, so the
// uninstall command keeps its own output style.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../exec.mjs';
import { reconcileClaudeComponentEnv, reconcileMemoryPin } from '../claude-env-projection.mjs';
import { reconcilePolicy } from './policy.mjs';
import { releaseFunnel, removeTypesafePackage, rufloProjectRoot, receiptedProjectRoots } from './apply.mjs';

const OFF = Object.freeze({
  typesafePicker: false, minilmPicker: false, mcpGovernance: false,
  learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
});

/** Released means nothing ak owns is left behind: no file-level failure and no receipt
 *  retained for a value the user edited after ak wrote it. */
const released = (env) => env.ok && env.findings.every((f) => !f.conflicts?.some((c) => /user-edited/.test(c.reason)));

function releaseProject(cfg, off, root, rufloVersion, lines) {
  const rc = cfg.integrations.ownership.rufloComponents;
  let ok = true;
  if (!fs.existsSync(root)) {
    lines.push({ level: 'info', text: `ruflo project ${root}: gone; its receipts are dropped` });
  } else {
    if (rc.policies?.[root]) {
      try {
        lines.push({ level: 'info', text: `policy ${root}: ${reconcilePolicy(root, false, rc.policies).status}` });
      } catch (error) {
        ok = false;
        lines.push({ level: 'warn', text: `policy ${root}: could not be removed — ${error.message}` });
      }
    }
    const env = reconcileClaudeComponentEnv(off, { projectRoot: root, rufloVersion, userScope: false });
    const pin = reconcileMemoryPin(root, { enabled: false });
    if (env.changed) lines.push({ level: 'ok', text: `ruflo component env removed in ${root}` });
    if (pin.changed) lines.push({ level: 'ok', text: `CLAUDE_FLOW_DB_PATH pin removed in ${root}` });
    if (!released(env) || !pin.ok) {
      ok = false;
      lines.push({ level: 'warn', text: `ruflo project ${root}: not fully released (${[...env.findings.map((f) => f.reason), pin.reason].filter(Boolean).join('; ') || 'user-edited value kept'})` });
    }
  }
  if (ok) {
    delete rc.policies?.[root];
    delete rc.projects?.[root];
  }
  return ok;
}

/** @param {{cwd?: string, purge?: boolean, rufloVersion?: (string|null), runner?: typeof run, userSettingsFile?: string}} [options] */
export async function releaseRufloComponents(cfg, options = {}) {
  const { cwd = process.cwd(), purge = false, rufloVersion = null, runner = run, userSettingsFile } = options;
  const off = { ...cfg, rufloComponents: OFF };
  const lines = [];
  cfg.integrations ??= {};
  cfg.integrations.ownership ??= {};
  cfg.integrations.ownership.rufloComponents ??= {};
  const user = reconcileClaudeComponentEnv(off, { rufloVersion, userSettingsFile });
  let ok = released(user);
  lines.push({ level: ok ? 'ok' : 'warn', text: `ruflo component env: ${user.changed ? 'removed' : 'nothing owned'}${ok ? '' : ' (a value ak set was edited or the file is unreadable; kept)'}` });
  const here = rufloProjectRoot(cwd);
  const roots = new Set(receiptedProjectRoots(cfg));
  if (here) roots.add(path.resolve(here));
  for (const root of roots) ok = releaseProject(cfg, off, root, rufloVersion, lines) && ok;
  if ((await releaseFunnel(cfg, { runner })).ok) lines.push({ level: 'info', text: 'funnel returned to ruflo\'s default' });
  if (purge) {
    const pkg = await removeTypesafePackage(cfg, { runner });
    lines.push({ level: pkg.ok ? 'ok' : 'warn', text: `typesafe: ${pkg.detail}` });
    // kit.json holds the only record that ak installed the package; --purge must keep it.
    if (!pkg.ok) ok = false;
  }
  return { ok, lines };
}
