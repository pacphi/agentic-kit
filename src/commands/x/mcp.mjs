// x mcp — MCP registration + tool-family management.
//   status (default) : registration + deny-rule summary + family inventory
//   pick             : interactive family exclusion picker (re-runnable)
//   off              : unregister everything + clean deny rules
import readline from 'node:readline/promises';
import { toolFamilies, registrationStatus, register, unregister, applyExclusions } from '../../lib/mcp.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { ok, warn, fail, dim, bold } from '../../lib/output.mjs';

export const options = {
  all: { type: 'boolean', default: false },
  exclude: { type: 'string' },
  yes: { type: 'boolean', default: false },
};

export async function run({ flags, positionals }) {
  const sub = positionals[0] ?? 'status';
  const families = toolFamilies();

  if (sub === 'status') {
    const s = registrationStatus();
    (s.claudeFlow ? ok : warn)(`claude-flow registration: ${s.claudeFlow ? 'user scope' : 'absent'}`);
    if (s.legacyRuflo) warn("legacy 'ruflo' key also registered — `x mcp pick` migrates it");
    console.log(`${bold('families')} (${families.size}, ${[...families.values()].reduce((n, l) => n + l.length, 0)} tools) ${dim(`· ${s.denyCount} denied`)}`);
    for (const [fam, tools] of [...families].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${fam.padEnd(14)} ${String(tools.length).padStart(3)} tools`);
    }
    return 0;
  }

  if (sub === 'off') {
    const removed = await unregister();
    ok(`unregistered (deny rules cleaned: ${removed})`);
    return 0;
  }

  if (sub === 'pick') {
    let exclude = [];
    if (flags.exclude !== undefined) {
      exclude = flags.exclude.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (!flags.all) {
      console.log(`${families.size} tool families — schemas load on demand, so allowing all is cheap.`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Families to EXCLUDE (comma-separated, Enter for none): ');
      rl.close();
      exclude = answer.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!(await register())) { fail('claude mcp add failed — is the claude CLI on PATH?'); return 1; }
    ok('claude-flow registered at user scope');
    const { denied, unknown } = applyExclusions(exclude);
    if (unknown.length) warn(`unknown families ignored: ${unknown.join(', ')}`);
    ok(denied ? `${denied} tool(s) denied across ${exclude.length - unknown.length} family(ies)` : 'all families allowed');
    const cfg = loadKitConfig();
    cfg.mcp = { register: true, excludeFamilies: exclude.filter((f) => !unknown.includes(f)) };
    saveKitConfig(cfg);
    return 0;
  }

  fail(`unknown mcp subcommand: ${sub} (status|pick|off)`);
  return 2;
}
