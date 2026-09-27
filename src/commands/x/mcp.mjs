// x mcp — MCP registration + tool-family management.
//   status (default) : registration + deny-rule summary + family inventory
//   pick             : interactive family exclusion picker (re-runnable)
//   off              : unregister everything + clean deny rules
import readline from 'node:readline/promises';
import {
  toolFamilies, registrationStatus, register, unregister, applyExclusions, legacyRufloRemovalCommands,
} from '../../lib/mcp.mjs';
import { loadKitConfig, saveKitConfig } from '../../lib/config.mjs';
import { ok, warn, fail, dim, bold } from '../../lib/output.mjs';

export const options = {
  all: { type: 'boolean', default: false },
  exclude: { type: 'string' },
  yes: { type: 'boolean', default: false },
};

export const help = `ak x mcp — MCP registration + tool-family management

Subcommands:
  status   (default) registration + deny-rule summary + family inventory
  pick     interactive family-exclusion picker (re-runnable)
  off      unregister everything + clean deny rules

Options (pick):
  --exclude a,b,c   families to exclude, non-interactive
  --all             allow every family (skip the prompt)
  --yes             accept defaults without prompting

Examples:
  ak x mcp                       show families + what's denied
  ak x mcp pick --exclude wasm,browser
  ak x mcp off`;

export async function run({ flags, positionals }) {
  const sub = positionals[0] ?? 'status';
  const families = toolFamilies();

  if (sub === 'status') {
    const s = registrationStatus({ cwd: process.cwd() });
    (s.claudeFlow ? ok : warn)(`claude-flow registration: ${s.claudeFlow ? `${s.claudeFlowScopes.join(', ')} scope` : 'absent'}`);
    if (s.autoMigratableLegacyScopes.length) {
      warn("legacy 'ruflo' key registered at user scope — `x mcp pick` migrates that owned scope");
    }
    if (s.preservedLegacyScopes.length) {
      warn(`legacy 'ruflo' key also registered at ${s.preservedLegacyScopes.join(', ')} scope — preserved because agentic-kit did not write it; if unwanted, remove it: ${legacyRufloRemovalCommands(s.preservedLegacyScopes)}`);
    }
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
    const reg = await register();
    if (reg.reason === 'ak-not-on-path') { fail('`ak` is not on PATH; the registration starts `ak x ruflo-mcp --host claude`'); return 1; }
    if (reg.reason === 'ak-launcher-outdated') { fail('the `ak` on PATH predates `ak x ruflo-mcp --host claude`, which the registration starts; update it first'); return 1; }
    if (!reg.ok) { fail('claude mcp add failed — is the claude CLI on PATH?'); return 1; }
    ok('claude-flow registered at user scope (starts through ak x ruflo-mcp)');
    const scoped = registrationStatus({ cwd: process.cwd() });
    if (scoped.preservedLegacyScopes.length) {
      warn(`legacy 'ruflo' registration remains at ${scoped.preservedLegacyScopes.join(', ')} scope; inspect with \`claude mcp get ruflo\`, then remove it explicitly if unwanted: ${legacyRufloRemovalCommands(scoped.preservedLegacyScopes)}`);
    }
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
