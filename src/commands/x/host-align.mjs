import readline from 'node:readline/promises';
import os from 'node:os';
import { projectRoots } from '../audit.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { inspectHostAlignment, publicHostAlignment, applyHostAlignment, configuredHostProjects } from '../../lib/host-alignment.mjs';

const key = finding => JSON.stringify(['retired-codex-bare-v1', finding.host, finding.file, finding.scope, finding.project ?? null, finding.name]);

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

/** @param {{flags?:any,roots?:string[],cfg?:any,confirm?:(question:string)=>Promise<boolean>,save?:typeof saveKitConfig,inspect?:typeof inspectHostAlignment,apply?:typeof applyHostAlignment}} [options] */
export async function alignHosts({
  flags = {}, roots, cfg = loadKitConfig(), confirm = ask, save = saveKitConfig,
  inspect = inspectHostAlignment, apply = applyHostAlignment,
} = {}) {
  const selected = roots ?? projectRoots(flags);
  if (flags['all-projects']) for (const root of configuredHostProjects()) {
    if (!selected.includes(root)) selected.push(root);
  }
  if (flags['all-projects'] && !selected.includes(os.homedir())) selected.push(os.homedir());
  const report = inspect({ projectRoots: selected });
  if (!flags.json) {
    console.log(`Host alignment: ${report.policy.id}; user scope + ${selected.length} project location(s)`);
    for (const finding of report.findings) {
      console.log(`  [${finding.level}] ${finding.host}/${finding.scope}: ${finding.file} → ${finding.name ?? finding.code}`);
      console.log(`    ${finding.message}${finding.repairable ? ' — backed-up correction available' : ''}`);
      if (!finding.repairable && finding.remedy) console.log(`    ${finding.remedy}`);
    }
  }
  if (!flags.apply || flags['dry-run']) {
    if (flags.json) console.log(JSON.stringify(publicHostAlignment(report), null, 2));
    else if (!report.aligned) console.log('Preview only. Run ak host align with the same scope and --apply to approve realignment.');
    else console.log('Host transports aligned. Ruflo/AQE provider routing is preserved.');
    return report.aligned ? 0 : 1;
  }
  const repairable = report.findings.filter(f => f.repairable);
  if (!repairable.length) {
    if (flags.json) console.log(JSON.stringify(publicHostAlignment(report), null, 2));
    return report.aligned ? 0 : 1;
  }
  const consent = cfg.integrations?.hostAlignment;
  const prior = consent?.policy === report.policy.id && Array.isArray(consent.corrections) ? consent.corrections : [];
  const remembered = repairable.every(f => prior.includes(key(f)));
  const question = 'Remove the listed retired transports with backups and remember these exact file/scope/name corrections for future alignment?';
  if (!flags.json) console.log(remembered ? 'Using previously approved transport realignment.' : question);
  if (!remembered && !flags.yes && !await confirm(question)) {
    if (flags.json) console.log(JSON.stringify({ status: 'approval-required', alignment: publicHostAlignment(report) }));
    else console.log('No configuration changed; realignment needs explicit approval (--yes for noninteractive use).');
    return 1;
  }
  const result = await apply(report, { confirmed: true });
  if (result.ok) {
    cfg.integrations ??= {};
    cfg.integrations.hostAlignment = { policy: report.policy.id,
      corrections: [...new Set([...prior, ...repairable.map(key)])] };
    save(cfg);
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.ok ? 'Host alignment verified.' : `Host alignment incomplete: ${result.reason ?? 'some entries need manual review'}`);
    for (const backup of result.backups) console.log(`  recovery copy: ${backup}`);
  }
  return result.ok ? 0 : 1;
}

export async function run({ flags }) { return alignHosts({ flags }); }
