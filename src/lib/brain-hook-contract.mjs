import { isDeepStrictEqual } from 'node:util';

// Exact registration contract, not a runtime/safety certification.
// https://github.com/stuinfla/ruvnet-brain/blob/3f7c3b8cd894e30090825322a2de0ac1ab12d9d1/plugin/hooks/hooks.json
const shim = (action, timeout, tail = ' || true') => ({
  type: 'command',
  command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action}${tail}`,
  timeout,
});
const handler = (matcher, ...hooks) => [{ matcher, hooks }];
const START = handler('startup|resume|clear|compact|fork', shim('session-start', 5));
const CONTINUITY = {
  SessionStart: START,
  Stop: handler('*', shim('continuation-gate', 10)),
};
// Reviewed 4.3.26 lifecycle plane. It adds a write gate (PreToolUse decision-gate may
// refuse Write/Edit) and a Stop grounding gate; 4.3.17's two-event contract no longer matches.
const LIFECYCLE = {
  SessionStart: START,
  UserPromptSubmit: handler('*', shim('unprompted-speech UserPromptSubmit', 3, ''),
    shim('ground-ruvnet', 10), shim('grounding-turn-mark', 5)),
  PreToolUse: handler('^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$', shim('decision-gate write', 5, '')),
  PostToolUse: handler('^(?:.*__)?search_ruvnet$', shim('grounding-stamp', 5)),
  Stop: handler('*', shim('continuation-gate', 10), shim('session-snapshot Stop', 10), shim('grounding-turn-gate', 10)),
  PreCompact: handler('*', shim('session-snapshot PreCompact', 10)),
  SessionEnd: handler('*', shim('session-snapshot SessionEnd', 10)),
};

export function brainHookContract(version, hooks) {
  if (isDeepStrictEqual(hooks, CONTINUITY)) return { qualified: true, contract: '4.3.17-continuity' };
  if (isDeepStrictEqual(hooks, LIFECYCLE)) return { qualified: true, contract: '4.3.26-lifecycle' };
  if (['4.3.14', '4.3.15', '4.3.16'].includes(version)) return isDeepStrictEqual(hooks, {})
    ? { qualified: true, contract: '4.3.14-4.3.16-retirement' }
    : { qualified: false, issue: 'Selected payload declares automatic hooks outside the audited retirement baseline' };
  return { qualified: false, issue: `Automatic hook declarations differ from the exact reviewed 4.3.17/4.3.26 contracts for plugin version ${version ?? 'unknown'}` };
}
