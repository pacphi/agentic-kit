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
// Nearest-contract order: on a tie the newer reviewed plane wins.
const REVIEWED = [['4.3.26-lifecycle', LIFECYCLE], ['4.3.17-continuity', CONTINUITY]];

// Reviewed facts about hooks a newer Brain added, stated with their source so a
// warning can say why the hook matters. Static on purpose: ak never loads or
// parses plugin code to learn this. Decision 4 of the 2026-09-26 audit holds
// 4.3.28 unreviewed for the first entry and asks upstream for offBehavior "silence".
const HOOK_NOTES = Object.freeze({
  'capacity-aware-parallel-work': 'declared offBehavior "run": it keeps running when the Brain is '
    + 'switched off and can tell the model to "launch actual workers now" (plugin 4.3.28 '
    + 'scripts/hook-shim.mjs:89, scripts/capacity-aware-parallel-work.mjs)',
});

const SHIM_ACTION = /hook-shim\.mjs"\s+(.+?)(?:\s*\|\|\s*true)?\s*$/;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** One comparable entry per declared hook: a readable label (event + shim
 *  action) and an exact key covering the matcher group and the hook itself. */
function flatten(hooks) {
  const out = [];
  for (const [event, groups] of Object.entries(plain(hooks) ? hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const { hooks: list, ...rest } = plain(group) ? group : {};
      for (const hook of Array.isArray(list) ? list : []) {
        const command = String(hook?.command ?? '');
        const action = command.match(SHIM_ACTION)?.[1] ?? command.slice(0, 60);
        out.push({ label: `${event} ${action}`, action, key: JSON.stringify([event, rest, hook]) });
      }
    }
  }
  return out;
}

/** Multiset difference by exact key, then pair same-label add/remove as a change. */
function deltaFrom(actual, reviewed) {
  const remaining = [...reviewed];
  const added = [];
  for (const entry of actual) {
    const i = remaining.findIndex((r) => r.key === entry.key);
    if (i >= 0) remaining.splice(i, 1); else added.push(entry);
  }
  const removedLabels = remaining.map((r) => r.label);
  const changed = added.filter((a) => removedLabels.includes(a.label)).map((a) => a.label);
  return {
    size: added.length + remaining.length,
    added: added.filter((a) => !changed.includes(a.label)),
    removed: removedLabels.filter((l) => !changed.includes(l)),
    changed,
  };
}

/** What differs from the nearest reviewed contract, named hook by hook. */
export function brainHookDelta(hooks) {
  const actual = flatten(hooks);
  let best = null;
  for (const [contract, reviewed] of REVIEWED) {
    const d = deltaFrom(actual, flatten(reviewed));
    if (!best || d.size < best.size) best = { contract, ...d };
  }
  const describe = (entry) => (HOOK_NOTES[entry.action] ? `${entry.label} (${HOOK_NOTES[entry.action]})` : entry.label);
  const parts = [
    ...best.added.map((a) => `adds ${describe(a)}`),
    ...best.removed.map((l) => `removes ${l}`),
    ...best.changed.map((l) => `changes ${l}`),
  ];
  return {
    contract: best.contract,
    added: best.added.map((a) => a.label),
    removed: best.removed,
    changed: best.changed,
    summary: parts.join('; '),
  };
}

export function brainHookContract(version, hooks) {
  if (isDeepStrictEqual(hooks, CONTINUITY)) return { qualified: true, contract: '4.3.17-continuity' };
  if (isDeepStrictEqual(hooks, LIFECYCLE)) return { qualified: true, contract: '4.3.26-lifecycle' };
  if (['4.3.14', '4.3.15', '4.3.16'].includes(version)) return isDeepStrictEqual(hooks, {})
    ? { qualified: true, contract: '4.3.14-4.3.16-retirement' }
    : { qualified: false, delta: null, issue: 'Selected payload declares automatic hooks outside the audited retirement baseline' };
  const delta = brainHookDelta(hooks);
  return {
    qualified: false,
    delta,
    issue: `Automatic hooks differ from the reviewed ${delta.contract} contract for plugin version ${version ?? 'unknown'}`
      + (delta.summary ? `: ${delta.summary}` : ''),
  };
}
