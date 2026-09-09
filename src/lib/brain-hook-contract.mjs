import { isDeepStrictEqual } from 'node:util';

// Exact registration contract, not a runtime/safety certification.
// https://github.com/stuinfla/ruvnet-brain/blob/3f7c3b8cd894e30090825322a2de0ac1ab12d9d1/plugin/hooks/hooks.json
const handler = (matcher, action, timeout) => [{ matcher, hooks: [{
  type: 'command',
  command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action} || true`,
  timeout,
}] }];
const CONTINUITY = {
  SessionStart: handler('startup|resume|clear|compact|fork', 'session-start', 5),
  Stop: handler('*', 'continuation-gate', 10),
};

export function brainHookContract(version, hooks) {
  if (version === '4.3.17') return isDeepStrictEqual(hooks, CONTINUITY)
    ? { qualified: true, contract: '4.3.17-continuity' }
    : { qualified: false, issue: 'Automatic hook declarations differ from the exact 4.3.17 continuity contract' };
  if (['4.3.14', '4.3.15', '4.3.16'].includes(version)) return isDeepStrictEqual(hooks, {})
    ? { qualified: true, contract: '4.3.14-4.3.16-retirement' }
    : { qualified: false, issue: 'Selected payload declares automatic hooks outside the audited retirement baseline' };
  return { qualified: false, issue: `Automatic hook contract is unqualified for plugin version ${version ?? 'unknown'}` };
}
