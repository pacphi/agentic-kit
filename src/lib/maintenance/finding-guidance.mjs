const resourceNoun = (kind) => ({
  agent: 'agent', command: 'command', skill: 'skill', plugin: 'plugin',
  mcpServer: 'MCP registration', 'mcp-server': 'MCP registration',
}[kind] ?? 'resource');

const STORAGE = Object.freeze({
  'stale-npx-env': Object.freeze({
    label: 'Remove this stale npx environment',
    headline: 'This npx environment contains superseded managed packages',
    impact: 'Deletes only this cached npx environment; npx downloads it again if it is needed.',
    steps: [
      'Use Preview change when it is available for this finding.',
      'Confirm the plan names only this stale npx environment, then remove it.',
      'Run a deep System rescan and confirm the finding is gone.',
    ],
    preserved: ['Other npx environments', 'Project files', 'Session history'],
    blockedReason: 'The exact npx environment could not be revalidated by the owned cleanup provider.',
  }),
  'regenerable-cache': Object.freeze({
    label: 'Clear this cache with its owning tool',
    headline: 'This cache contains reproducible downloads',
    impact: 'Deletes generated downloads in this cache; the owning tool downloads them again on demand.',
    steps: [
      'Open the owning tool named by this finding.',
      'Run that tool’s cache-clean command for this cache only.',
      'Run a deep System rescan and confirm the cache is no longer reported.',
    ],
    preserved: ['Installed tools and plugins', 'Project files', 'Session history'],
    blockedReason: 'Agentic Kit has no verified cleanup adapter for this tool’s cache.',
  }),
  'superseded-snapshots': Object.freeze({
    label: 'Remove this superseded snapshot',
    headline: 'A newer active snapshot makes this copy a cleanup candidate',
    impact: 'Deletes only the superseded snapshot; the active snapshot and current configuration remain.',
    steps: [
      'Confirm the current snapshot loads successfully.',
      'Remove only the superseded snapshot named by this finding.',
      'Run a deep System rescan and confirm the active snapshot remains healthy.',
    ],
    preserved: ['Active snapshot', 'Current configuration', 'Project files'],
    blockedReason: 'Agentic Kit has not proved an owner-specific delete and verification operation for this snapshot.',
  }),
  'installed-runtime-versions': Object.freeze({
    label: 'Uninstall this older runtime after checking project pins',
    headline: 'More than one runtime version is installed',
    impact: 'Removes one installed runtime version; a project pinned to it may stop working.',
    steps: [
      'Check project and shell configuration for an explicit pin to this version.',
      'Switch any remaining consumers to the retained version and run their tests.',
      'Uninstall this version with its runtime manager, then deep-rescan.',
    ],
    preserved: ['Retained runtime version', 'Project files', 'Runtime-manager configuration'],
    blockedReason: 'Installed state does not prove which version projects or shells currently select.',
  }),
  'superseded-browser-revisions': Object.freeze({
    label: 'Remove this browser build after checking tool pins',
    headline: 'A newer browser revision is installed alongside this build',
    impact: 'Removes one browser binary revision; pinned jobs may redownload it or fail until updated.',
    steps: [
      'Check Playwright, Puppeteer, Agent Browser, or Vibium configuration for this revision.',
      'Run the affected browser tests against the retained revision.',
      'Remove this revision with the owning installer, then deep-rescan.',
    ],
    preserved: ['Retained browser revisions', 'Browser configuration', 'Project files'],
    blockedReason: 'Filesystem presence does not prove that no browser job still pins this revision.',
  }),
  'aged-transcripts': Object.freeze({
    label: 'Archive old transcripts before removing them',
    headline: 'These transcripts are older than the retention threshold',
    impact: 'Removing them permanently deletes the recorded session history unless it is archived first.',
    steps: [
      'Open a sample and decide whether the session history is still useful.',
      'Export or archive anything you need to keep.',
      'Remove only the reviewed transcripts with the host’s history workflow, then deep-rescan.',
    ],
    preserved: ['Recent transcripts', 'Archived copies', 'Project files'],
    blockedReason: 'Age does not prove that retained session history is disposable.',
  }),
  'orphaned-transcripts': Object.freeze({
    label: 'Recover or archive orphaned transcripts before cleanup',
    headline: 'The project recorded by these transcripts is no longer present',
    impact: 'Removing them permanently deletes the remaining session history for the missing project.',
    steps: [
      'Confirm the project was intentionally removed or relocated.',
      'Restore the project reference or archive any session history you need.',
      'Remove only the reviewed orphaned transcripts, then deep-rescan.',
    ],
    preserved: ['Transcripts for existing projects', 'Archived copies', 'Current projects'],
    blockedReason: 'A missing project does not prove that its retained history is unwanted.',
  }),
});

const evidenceFirst = (noun) => ({
  label: `Rescan before changing this ${noun}`,
  headline: 'Current evidence is incomplete or stale',
  impact: 'No resource changes until a complete current scan replaces this finding.',
  steps: [
    'Run Rescan in System.',
    'Return to this finding after the scan completes.',
    'Follow the replacement finding’s action only if its evidence is complete.',
  ],
  preserved: ['The current resource and every observed copy'],
  blockedReason: 'Current evidence is incomplete or stale.',
});

export function storageGuidance(kind, { usableEvidence, safe, basis = {} }) {
  if (!usableEvidence) return evidenceFirst('storage item');
  if (kind === 'stale-npx-env' && basis.versionStale !== true) {
    if (basis.idle !== true) return evidenceFirst('npx environment');
    const age = Number.isInteger(basis.idleDays) && basis.idleDays >= 0
      ? `${basis.idleDays}-day-idle` : 'idle';
    return {
      label: `Clear this ${age} npx environment only if you accept a later redownload`,
      headline: 'This npx environment is idle, not proven obsolete',
      impact: 'Clears a reproducible warm cache; the next matching npx run downloads its packages again.',
      steps: [
        'If you still use the named package, run it once and keep the refreshed cache.',
        'Otherwise remove only this named environment with your npm cache-management workflow.',
        'Run a deep System rescan and confirm only the intended environment is gone.',
      ],
      preserved: ['Other npx environments', 'Project files', 'Session history'],
      blockedReason: 'Idle age alone does not prove the package is unused, and no exact npm-owned removal action is available.',
    };
  }
  const specific = STORAGE[kind];
  if (specific) return specific;
  return safe ? {
    label: 'Clear this reproducible cache with its owning tool',
    headline: 'The measured data is reproducible',
    impact: 'Deletes only the named generated data; the owning tool recreates it on demand.',
    steps: ['Use the owning tool’s cleanup command for this item.', 'Confirm other data is excluded.', 'Run a deep System rescan.'],
    preserved: ['Other caches', 'Project files', 'Session history'],
    blockedReason: 'Agentic Kit has no verified cleanup adapter for this cache family.',
  } : {
    label: 'Keep this item until its owner and consumers are known',
    headline: 'Removal could affect unique or live data',
    impact: 'No change is recommended until the owning tool and current consumers are identified.',
    steps: ['Identify the owning tool.', 'Check whether it still consumes this item.', 'Use that tool’s removal workflow only after both checks pass.'],
    preserved: ['The current item and dependent data'],
    blockedReason: 'Ownership or current consumers are not known.',
  };
}

export function catalogGuidance({ kind, operation, update, partial, stale, recommendedVersion }) {
  const noun = resourceNoun(kind);
  if (partial || stale) return evidenceFirst(noun);
  if (update) return {
    label: recommendedVersion ? `Upgrade this ${noun} to ${recommendedVersion}` : `Upgrade this ${noun} to the reported candidate`,
    headline: 'The owning host reports an upgrade candidate',
    impact: `Changes this ${noun} and the capabilities it contributes.`,
    steps: ['Preview the host-owned upgrade.', 'Check the affected capabilities and rollback limit.', 'Apply the upgrade, restart if required, then deep-rescan.'],
    preserved: ['Unrelated resources', 'Project files'],
    blockedReason: 'The owning host has not authorized an exact upgrade operation.',
  };
  if (operation === 'disable') return {
    label: `Disable this ${noun}`,
    headline: `The owning host marked this ${noun} as a disable candidate`,
    impact: `Stops this ${noun} from contributing capabilities until it is enabled again.`,
    steps: ['Preview the disable operation.', 'Check the affected capabilities.', 'Disable it, restart if required, then deep-rescan.'],
    preserved: [`Installed ${noun} data`, 'Unrelated resources'],
    blockedReason: 'The owning host has not authorized an exact disable operation.',
  };
  if (operation === 'remove') return {
    label: `Uninstall this ${noun}`,
    headline: `The owning host marked this ${noun} as a removal candidate`,
    impact: `Removes this ${noun} and its contributed capabilities.`,
    steps: ['Preview the uninstall operation.', 'Check the affected capabilities and data-preservation rule.', 'Uninstall it, restart if required, then deep-rescan.'],
    preserved: ['Unrelated resources', 'Project files'],
    blockedReason: 'The owning host has not authorized an exact uninstall operation.',
  };
  const variants = {
    skill: ['Choose one skill definition; update or rename the other copies', 'Different skill definitions share this name'],
    agent: ['Choose one agent definition; update or rename the other copies', 'Different agent definitions share this name'],
    command: ['Choose one command definition; update or rename the other copies', 'Different command definitions share this name'],
    mcpServer: ['Keep one MCP configuration; remove or rename the conflicting registrations', 'Different MCP configurations share this name'],
    plugin: ['Choose one plugin version; uninstall the superseded copy', 'Different plugin revisions share this identity'],
  }[kind] ?? [`Choose one authoritative ${noun}; update or rename the other copies`, `Different ${noun} definitions share this name`];
  return {
    label: variants[0], headline: variants[1],
    impact: `Aligning the copies changes only the ${noun} definitions you explicitly update, rename, or remove.`,
    steps: [
      `Compare the observed ${noun} definitions and identify their consumers.`,
      `Choose the authoritative ${noun}; keep both only when their names and purpose are distinct.`,
      'Update, rename, or remove the other copies with their owning workflow, then deep-rescan.',
    ],
    preserved: ['The selected authoritative copy', 'Unrelated resources'],
    blockedReason: 'Different observed definitions require a human choice of source of truth.',
  };
}

export function incompleteEvidenceGuidance() {
  return evidenceFirst('resource');
}

export const relationshipGuidance = Object.freeze({
  'redundant-project-override': Object.freeze({
    label: 'Remove the duplicate project copy',
    headline: 'Project and shared definitions are identical',
    explanation: 'The complete observed definitions match. Confirm the host selects the shared copy before removing the project copy.',
    impact: 'Removes only the project-local copy; the shared source, other projects, and repository history remain.',
    steps: ['Confirm this host exposes the shared copy to the project.', 'Back up or commit the project copy.', 'Remove only the project copy, then deep-rescan.'],
    preserved: ['Shared source', 'Other projects', 'Repository history'],
    blockedReason: 'Definition equality does not prove which copy the host selects.',
  }),
  'same-name-different-definition': Object.freeze({
    label: 'Choose one definition, or rename the project copy',
    headline: 'Project and shared definitions differ',
    explanation: 'The resources share a name but implement different behavior. Choose a source of truth before changing either copy.',
    impact: 'Changes only the project copy you explicitly update, rename, or remove; shared sources remain.',
    steps: ['Compare the project copy with each shared source.', 'Choose the intended source of truth.', 'Update, rename, or remove the project copy, then deep-rescan.'],
    preserved: ['Shared sources', 'Other projects', 'Repository history'],
    blockedReason: 'Agentic Kit cannot infer which behavior you intend to keep.',
  }),
  'tracked-source-copy': Object.freeze({
    label: 'Remove the tracked duplicate in a pull request',
    headline: 'An identical project copy is tracked by Git',
    explanation: 'The project definition matches a shared source, but removing tracked source is a repository change.',
    impact: 'Removes only the tracked project copy; shared sources, other projects, and Git history remain.',
    steps: ['Confirm contributors and automation can use the shared source.', 'Delete only the tracked project copy on a branch.', 'Run project tests and deep-rescan before merging the pull request.'],
    preserved: ['Shared source', 'Other projects', 'Git history'],
    blockedReason: 'Tracked source requires project review and cannot be removed as cache cleanup.',
  }),
  'legacy-equivalent-transport': Object.freeze({
    label: 'Remove the legacy MCP registration',
    headline: 'Canonical and legacy registrations have identical transport configuration',
    explanation: 'Both registrations reach the same observed transport. Verify the canonical registration before removing the legacy name.',
    impact: 'Removes only the legacy registration at this scope; the canonical registration and other scopes remain.',
    steps: ['Verify the canonical registration is healthy at an equal or broader scope.', 'Use the host MCP manager to remove only the legacy registration.', 'Restart the host if required, then deep-rescan.'],
    preserved: ['Canonical registration', 'Other scopes', 'Server configuration'],
    blockedReason: 'Transport equality does not prove canonical health or scoped removal authority.',
  }),
});
