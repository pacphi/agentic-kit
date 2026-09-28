// AQE owns its generated Codex guidance. Pass policy through its public CLI;
// never rewrite AQE's AGENTS.md sentinel directly.
import fs from 'node:fs';
import path from 'node:path';
import { cmpVersions, isValidSemver } from './versions.mjs';

export const DEFAULT_AQE_CODEX_GUIDANCE = 'compact';
export const AQE_CODEX_GUIDANCE_MIN_VERSION = '3.14.1';
const MODES = new Set(['full', 'compact', 'none']);

export function validateAqeCodexGuidance(mode = DEFAULT_AQE_CODEX_GUIDANCE) {
  if (!MODES.has(mode)) {
    throw new TypeError('aqeCodexGuidance must be full, compact, or none');
  }
  return mode;
}

/** Unknown/old versions retain the supported legacy initializer arguments. */
export function aqeInitArguments(cfg, version) {
  const mode = validateAqeCodexGuidance(cfg.aqeCodexGuidance);
  const args = ['init', '--auto'];
  if (!cfg.integrations?.hosts?.codex || !isValidSemver(version)) return args;
  const release = version.split('+')[0];
  if (cmpVersions(release, '3.13.1') < 0) return args;
  args.push('--with-codex');
  if (cmpVersions(release, AQE_CODEX_GUIDANCE_MIN_VERSION) >= 0) {
    args.push('--codex-guidance', mode);
  }
  return args;
}

/** The repo-scoped Codex skills `aqe init --with-codex` installs without Ruflo
 *  (AQE 3.14.4 .agents/skills, codex-installer.js installCodexSkills). */
export const AQE_CODEX_SKILLS = Object.freeze(['aqe-plan-quality', 'aqe-plan-work', 'aqe-research', 'aqe-review-quality', 'aqe-test-change']);

/** Whether AQE's Codex hooks (.codex/hooks.json naming aqe-codex-hook.cjs) and skills
 *  (.agents/skills/<name>) exist in `root`. */
function codexInstall(root) {
  let hooks = false;
  try { hooks = fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8').includes('aqe-codex-hook.cjs'); } catch { /* absent */ }
  const missing = AQE_CODEX_SKILLS.filter((name) => !fs.existsSync(path.join(root, '.agents', 'skills', name)));
  return { hooks, missing };
}

/** What `ak setup` says after `aqe init`: Codex hooks and skills only when they exist.
 *  AQE 3.14.4 run through its `aqe` command installs neither: its Codex installer finds
 *  its packaged files only when started as `node dist/cli/bundle.js`
 *  (codex-installer.js resolvePackageRoot; agentic-qe#755).
 *  @param {{ code: number, withCodex: boolean, root: string, version?: string|null }} run */
export function aqeInitReport({ code, withCodex, root, version }) {
  const level = code === 0 ? 'ok' : 'warn';
  if (!withCodex) return { level, text: 'agentic-qe initialized' };
  const { hooks, missing } = codexInstall(root);
  if (hooks && !missing.length) return { level, text: `agentic-qe initialized (+ Codex hooks and ${AQE_CODEX_SKILLS.length} skills)` };
  const gaps = [...(hooks ? [] : ['hooks (.codex/hooks.json)']), ...(missing.length ? [`skills (missing: ${missing.join(', ')})`] : [])];
  const none = !hooks && missing.length === AQE_CODEX_SKILLS.length;
  return { level: 'warn', text: `agentic-qe initialized, but AQE ${version ?? '(unknown version)'} did not install `
    + `${none ? 'its Codex hooks or skills' : `all its Codex ${gaps.join(' and ')}`}: run through the aqe command, AQE's Codex installer `
    + `cannot find its own packaged files (an AQE defect, agentic-qe#755)${none ? ` (missing: ${AQE_CODEX_SKILLS.join(', ')})` : ''}` };
}
