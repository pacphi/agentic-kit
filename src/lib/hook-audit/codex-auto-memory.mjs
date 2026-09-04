const AUTO_MEMORY_PREFIX = 'sh -c \'D="${CLAUDE_PROJECT_DIR:-.}"; [ -f "$D/.claude/helpers/auto-memory-hook.mjs" ] || D="${HOME}"; exec node "$D/.claude/helpers/auto-memory-hook.mjs"';

const AUTO_MEMORY_SIGNATURES = Object.freeze([
  Object.freeze({
    event: 'SessionStart', matcherPresent: false, matcher: null,
    action: 'import', timeout: 8000, command: `${AUTO_MEMORY_PREFIX} import'`,
  }),
  Object.freeze({
    event: 'Stop', matcherPresent: false, matcher: null,
    action: 'sync', timeout: 10000, command: `${AUTO_MEMORY_PREFIX} sync'`,
  }),
]);

function declaredTimeout(hook) {
  return Object.hasOwn(hook, 'timeout') ? hook.timeout : null;
}

export function codexAutoMemoryHookSignature(event, matcher, hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return null;
  const keys = Object.keys(hook).sort();
  const expectedKeys = Object.hasOwn(hook, 'timeout')
    ? ['command', 'timeout', 'type'] : ['command', 'type'];
  if (hook.type !== 'command' || typeof hook.command !== 'string'
      || keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) return null;
  const matcherPresent = matcher !== undefined;
  return AUTO_MEMORY_SIGNATURES.find((signature) => (
    signature.event === event
    && signature.matcherPresent === matcherPresent
    && signature.matcher === (matcherPresent ? matcher : null)
    && signature.command === hook.command
    && signature.timeout === declaredTimeout(hook)
  )) ?? null;
}

export function hasAmbiguousCodexAutoMemoryHook(document) {
  for (const [event, groups] of Object.entries(document?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      const matcher = Object.hasOwn(group, 'matcher') ? group.matcher : undefined;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== 'string'
            || !hook.command.includes('.claude/helpers/auto-memory-hook.mjs')) continue;
        if (!codexAutoMemoryHookSignature(event, matcher, hook)) return true;
      }
    }
  }
  return false;
}

export function retireCodexAutoMemoryHooks(document) {
  const candidate = structuredClone(document);
  const removed = [];
  for (const [event, groups] of Object.entries(candidate.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const retainedGroups = [];
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        retainedGroups.push(group);
        return;
      }
      const matcher = Object.hasOwn(group, 'matcher') ? group.matcher : undefined;
      const retainedHooks = [];
      group.hooks.forEach((hook, hookIndex) => {
        const signature = codexAutoMemoryHookSignature(event, matcher, hook);
        if (signature) {
          removed.push({
            event, matcher, action: signature.action, groupIndex, hookIndex,
            pointer: `/hooks/${event}/${groupIndex}/hooks/${hookIndex}`,
          });
        } else {
          retainedHooks.push(hook);
        }
      });
      if (retainedHooks.length) retainedGroups.push({ ...group, hooks: retainedHooks });
      else if (Object.keys(group).some((key) => key !== 'hooks' && key !== 'matcher')) {
        retainedGroups.push({ ...group, hooks: [] });
      }
    });
    if (retainedGroups.length) candidate.hooks[event] = retainedGroups;
    else delete candidate.hooks[event];
  }
  return { document: candidate, removed };
}
