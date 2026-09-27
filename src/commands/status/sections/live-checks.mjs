// live-checks — what the last live checks found (decision 9b). `ak sync`,
// `ak x verify` and `ak status --live` record results; this section only
// reads them and shows each with its age, so plain status and the dashboard
// stay free of probes. The AQE embedding request is shown on its own
// aqe-embedding row. No evidence yet means no row.
import {
  LIVE_CHECK_IDS, readLiveCheck, liveCheckInputsKey, describeLiveCheck, liveCheckLevel,
} from '../../../lib/live-check-evidence.mjs';
import { row } from '../row.mjs';

export default {
  id: 'live-checks',
  async collect({ cfg = /** @type {any} */ ({}), cwd }) {
    const rows = [];
    for (const id of LIVE_CHECK_IDS.filter((candidate) => candidate !== 'aqe-embedding')) {
      const evidence = readLiveCheck(id, { inputsKey: liveCheckInputsKey(id, { cfg, cwd }) });
      if (evidence) {
        rows.push(row('live-checks', liveCheckLevel(evidence),
          `${id}: ${describeLiveCheck(evidence, { recheck: 'ak status --live' })}`));
      }
    }
    return rows;
  },
};
