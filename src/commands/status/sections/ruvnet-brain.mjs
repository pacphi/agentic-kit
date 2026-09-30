// ruvnet-brain (offline KB + search_ruvnet MCP; not an npm package — detected
// on disk, drift via GitHub releases, TTL-cached like `self`)
import {
  activeHeldRefresh, drift as ruvnetBrainDrift, nightlyAgentPresent as rbNightlyPresent,
  NIGHTLY_LABEL as RB_NIGHTLY_LABEL, legacySnapshotBytes,
} from '../../../lib/ruvnet-brain.mjs';
import { BRAIN_RECLAIM_STUCK } from '../../../lib/heal.mjs';
import { row } from '../row.mjs';
import { inspectClaudeBrainPlugin } from '../../../lib/ruvnet-brain-plugin.mjs';
import { releaseObservationLabel } from '../../../lib/versions.mjs';

/** ADR-0061: one sentence naming the legacy-snapshot cost of a reclaim-stuck
 *  hold, best-effort — never lets a formatting/fs edge case break the row. */
function legacySnapshotNote() {
  try {
    const s = legacySnapshotBytes();
    if (!s.count) return '';
    const gb = s.bytes != null ? ` (~${(s.bytes / 1024 ** 3).toFixed(1)}GB${s.exhausted ? '+' : ''})` : '';
    return ` and does not free ${s.count} legacy snapshot dir(s)${gb} still on disk`;
  } catch {
    return '';
  }
}

/** ADR-0061: preserve the historical workaround without promising that a
 * current installer bypasses its own snapshot-retention checks. */
function reclaimStuckFix() {
  return '`npx ruvnet-brain --uninstall` (removes only the KB bundle) then `ak sync` reinstalls fresh '
    + `when the installer permits it${legacySnapshotNote()}; the current installer may still refuse — `
    + 'preserve private snapshots and resolve its named cause; see upstream stuinfla/ruvnet-brain#335; '
    + 'or set "ruvnetBrain": false in kit.json to stop ak managing the Brain';
}

function retainedReleaseLabel(b, unversioned = 'the existing unversioned install') {
  if (b.kbState === 'missing') return 'KB missing (plugin cache remains)';
  return b.installedRelease ? `release v${b.installedRelease}` : unversioned;
}

// What a user can do about an unreviewed Brain hook change. ak cannot review a
// hook for them, so the options are a manual fix, never a sync one (P5, Branch 0
// real-machine pass: without a fix the row had no manual tag and no count).
// Only an ak release that reviews the change, or "ruvnetBrain": false, clears the
// warning; the static check reads the payload whether or not the plugin is enabled.
const HOOK_DELTA_NOTE = 'this warning stays until an ak release reviews the change '
  + '(the Brain maintainer is asked to make added hooks honor the off switch)';
const HOOK_DELTA_FIX = 'choose: keep the hooks; disable the whole Claude plugin with '
  + '`claude plugin disable ruvnet-brain@ruvnet-brain` (this also removes search_ruvnet from Claude); '
  + 'or set "ruvnetBrain": false in kit.json so ak stops managing and reporting the Brain '
  + '(the hooks stay installed)';

export function brainPluginRows(state) {
  const enabled = state.enabled === true ? 'enabled' : state.enabled === false ? 'disabled' : 'enablement unknown';
  const selected = state.payloadVersion ?? state.registryVersion ?? 'unknown';
  if (state.registration === 'absent') return [row('ruvnet-brain-plugin', 'info',
    'Claude user plugin registry has no Brain registration; KB and MCP health are separate')];
  const summary = `Claude user Brain plugin ${selected} (${enabled}; project overrides and runtime unverified)`;
  const detail = state.issues.length ? state.issues.join('; ') : 'selected payload passes static checks';
  return [row('ruvnet-brain-plugin', state.issues.length ? 'warn' : 'info',
    `${summary}; ${detail}${state.hookDelta ? `; ${HOOK_DELTA_NOTE}` : ''}`,
    state.hookDelta ? HOOK_DELTA_FIX : null, { repair: 'manual' })];
}

/** One status row for the installed/release state. A GitHub tag without the
 *  installer's required bundle asset is visible but deliberately non-actionable:
 *  giving it a fix would make `ak sync` prescribe a download known to 404. */
export function brainReleaseRow(b, { retry = false } = {}) {
  const releaseBlocked = !!b.latest && b.releaseAssetAvailable === false;
  const releaseUnverified = !!b.latest && b.releaseAssetAvailable == null;
  if (b.kbState === 'unknown') {
    return row('ruvnet-brain', 'warn', 'RuvNet Brain KB entrypoint unavailable; installation state unverified',
      'resolve KB access or the unusable entrypoint, then run `ak sync`', { repair: 'manual' });
  }
  if (!b.present) {
    if (releaseBlocked) {
      return row('ruvnet-brain', 'warn',
        `RuvNet Brain not installed; release v${b.latest} is missing ruvnet-brain.zip — automatic install blocked upstream`);
    }
    if (releaseUnverified) {
      return row('ruvnet-brain', 'info',
        `RuvNet Brain not installed; release v${b.latest} bundle availability awaits a live sync check`);
    }
    return row('ruvnet-brain', 'warn', 'RuvNet Brain not installed', 'setup installs it (or `ak sync`)');
  }
  if (b.kbState === 'missing' && !b.latest) {
    return row('ruvnet-brain', 'warn', 'RuvNet Brain KB missing; plugin cache remains; release metadata unavailable');
  }
  if (b.outdated && releaseBlocked) {
    const have = retainedReleaseLabel(b);
    return row('ruvnet-brain', 'info',
      `ruvnet-brain ${have} retained; release v${b.latest} is missing ruvnet-brain.zip — update deferred upstream`);
  }
  if (b.outdated && releaseUnverified) {
    const have = retainedReleaseLabel(b);
    return row('ruvnet-brain', 'info',
      `ruvnet-brain ${have} retained; release v${b.latest} bundle availability awaits a live sync check`);
  }
  const held = b.outdated && !retry ? activeHeldRefresh(b) : null;
  if (held) {
    // The installer or the bundle's updater refused this exact pair (or ran
    // without landing anything). Re-running it on every sync cannot succeed and
    // re-downloads the bundle, so sync waits for this fresh hold's TTL or a
    // release change; manual recovery remains the user's choice.
    const have = retainedReleaseLabel(b);
    const fix = BRAIN_RECLAIM_STUCK.test(held.detail)
      ? reclaimStuckFix()
      : 'fix the cause, then run `npx ruvnet-brain --update`; or set "ruvnetBrain": false in kit.json '
        + 'to stop ak managing the Brain';
    return row('ruvnet-brain', 'warn',
      `ruvnet-brain ${have} retained; the refresh to v${b.latest} was refused (${held.detail}). `
      + 'ak sync waits for the hold to expire or either release to change before retrying',
      fix, { repair: 'manual' });
  }
  if (b.outdated) {
    const have = retainedReleaseLabel(b, 'present (unversioned install)');
    return row('ruvnet-brain', 'warn',
      `ruvnet-brain ${have}, release v${b.latest} available (${releaseObservationLabel(b)})`, 'sync refreshes the KB');
  }
  const shown = b.installedRelease ? `release v${b.installedRelease}${b.latest ? ` (latest known; ${releaseObservationLabel(b)})` : ' (release metadata unavailable)'}` : 'present';
  return row('ruvnet-brain', 'ok', `ruvnet-brain ${shown}`);
}

export default {
  id: 'ruvnet-brain',
  // A Brain drift the caller already holds (versionEvidence: what ak sync
  // looked up or read from the cache, ADR-0063) is used as given.
  async collect({ cfg, refresh = false, versionEvidence, retryBrain = false }) {
    const rows = [];
    if (!cfg.ruvnetBrain) return rows;
    try {
      const b = versionEvidence?.brain ?? await ruvnetBrainDrift({ force: refresh });
      rows.push(brainReleaseRow(b, { retry: retryBrain }));
    } catch (e) {
      rows.push(row('ruvnet-brain', 'warn', `ruvnet-brain check unavailable: ${e.message}`));
    }
    rows.push(...brainPluginRows(inspectClaudeBrainPlugin()));
    // The installer's own nightly self-updater (macOS LaunchAgent, 03:47) bypasses
    // ak-managed updates: it rewrites the KB outside ak's release stamp, so status
    // and the statusline drift from disk. Own subsystem so sync's fix is "disable
    // the agent", never a needless force-reinstall of the brain itself.
    if (rbNightlyPresent()) {
      rows.push(row('ruvnet-brain-nightly', 'warn',
        `ruvnet-brain nightly self-updater active (${RB_NIGHTLY_LABEL}) — bypasses ak-managed updates`,
        'sync disables it (re-enable deliberately: `npx ruvnet-brain --enable-nightly`)'));
    }
    return rows;
  },
};
