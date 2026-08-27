// ruvector — a global CLI users register as an MCP server BY HAND. ak manages
// its drift, never its presence or its registration. Unregistered → no row at
// all (same silence as codex-not-enabled): nudging a tool nobody opted into
// would be management by ambush. Registered but kit.json ruvector:false → an
// info row with NO fix, so sync never plans an upgrade the user turned off.
//
// Wording is deliberately "CLI": the registered command is typically
// `npx -y ruvector mcp start`, so upgrading the global package does not
// necessarily change what the MCP server executes. Claim only what is true.
import { ruvectorRegistered } from '../../../lib/mcp.mjs';
import { drift as ruvectorDrift } from '../../../lib/ruvector.mjs';
import { row } from '../row.mjs';

export default {
  id: 'ruvector',
  async collect({ cfg }) {
    const rows = [];
    if (!ruvectorRegistered()) return rows;
    if (cfg.ruvector === false) {
      rows.push(row('ruvector', 'info', 'ruvector MCP registered — CLI updates disabled (kit.json ruvector:false)'));
      return rows;
    }
    try {
      const rv = await ruvectorDrift();
      if (rv.present && rv.outdated) {
        rows.push(row('ruvector', 'warn',
          `ruvector CLI ${rv.installed} installed, ${rv.latest} available`, 'sync upgrades the ruvector CLI'));
      } else if (rv.present) {
        rows.push(row('ruvector', 'ok', `ruvector CLI ${rv.installed}${rv.latest ? ' (latest)' : ''} (MCP registered, user scope)`));
      } else {
        rows.push(row('ruvector', 'info', 'ruvector MCP registered but no global CLI installed (server runs via npx)'));
      }
    } catch (e) {
      rows.push(row('ruvector', 'warn', `ruvector check unavailable: ${e.message}`));
    }
    return rows;
  },
};
