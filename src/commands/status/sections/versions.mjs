import { loadKitConfig } from '../../../lib/config.mjs';
import { rememberedSupportWindow, supportWindowPolicy } from '../../../lib/ruflo-support-window.mjs';
import { cmpVersions, driftReport, releaseObservationLabel } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

/** The Ruflo support-window row (ADR-0041 §7). Reads remembered release
 *  dates only: an unknown window names `ak sync` and is never "unsupported". */
function supportWindowRow(installed, cfg, now) {
  const window = rememberedSupportWindow(cfg, { now, policy: supportWindowPolicy() });
  if (!window) {
    return row('versions', 'info', "Ruflo support window not yet known: run ak sync to record Ruflo's release dates");
  }
  const range = `${window.floor} and newer; release dates observed ${new Date(window.observedAt).toISOString()}`;
  if (cmpVersions(installed, window.floor) < 0) {
    return row('versions', 'fail', `Ruflo ${installed} is unsupported: below the support window (${range})`,
      'sync upgrades Ruflo into the support window');
  }
  return row('versions', 'info', `Ruflo ${installed} is inside the support window (${range})`);
}

export default {
  id: 'versions',
  async collect({ drift = driftReport, loadConfig = loadKitConfig, now = Date.now, refresh = false } = {}) {
    const rows = [];
    try {
      for (const r of await drift({ force: refresh })) {
        if (!r.installed) {
          rows.push(row('versions', r.pkg === 'ruflo' ? 'fail' : 'warn',
            `${r.pkg} not installed globally`, 'setup installs it'));
        } else if (r.outdated) {
          rows.push(row('versions', 'warn',
            `${r.pkg} ${r.installed} installed, ${r.latest} available (${releaseObservationLabel(r)})`, 'sync upgrades + re-heals'));
        } else {
          rows.push(row('versions', r.latest ? 'ok' : 'info',
            `${r.pkg} ${r.installed}${r.latest ? ` (latest known; ${releaseObservationLabel(r)})` : ' (release metadata unavailable)'}`));
        }
        if (r.pkg === 'ruflo' && r.installed) rows.push(supportWindowRow(r.installed, loadConfig(), now()));
      }
    } catch (e) {
      rows.push(row('versions', 'warn', `version check unavailable: ${e.message}`));
    }
    return rows;
  },
};
