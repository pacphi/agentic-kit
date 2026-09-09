// AQE owns its generated Codex guidance. Pass policy through its public CLI;
// never rewrite AQE's AGENTS.md sentinel directly.
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
