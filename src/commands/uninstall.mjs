// ak uninstall — remove the kit's machine footprint (default), a
// project's patches (--this-project), and optionally the global packages
// (--remove-ruflo / --remove-aqe / --purge, each confirmed). Also cleans a
// LEGACY shell-kit install (rc source lines, ~/.local/bin/ruflo-*,
// ~/.config/ruflo shell files) — the migration path off the bash era.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { run as runCmd } from '../lib/exec.mjs';
import { stripBlock, BEGIN, BUILTIN_BLOCKS } from '../lib/blocks.mjs';
import { unregister } from '../lib/mcp.mjs';
import { loadKitConfig, saveKitConfig } from '../lib/config.mjs';
import { runLifecycle } from '../lib/adapters/lifecycle.mjs';
import { hostsWithLifecycle, lifecycleAdapterFor, lifecycleExecutionEnabled, isBuiltinHost } from '../lib/adapters/lifecycle-registry.mjs';
import { renderUndoReport } from '../lib/adapters/lifecycle-render.mjs';
import { present as rbPresent } from '../lib/ruvnet-brain.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, fail, info } from '../lib/output.mjs';
import { removeCodexStatusline } from '../lib/codex-statusline.mjs';

/** Prints one lifecycle-render.mjs report line at its own level — mirrors
 *  setup.mjs/sync.mjs's own printReportLine (N-2, Wave C security review
 *  follow-up): renderUndoReport only ever emits 'ok'/'warn' today, so this is
 *  latent, but the day an undo renderer adopts levelForResult (F5's mapping)
 *  a 'fail' line must reach fail(), not be silently downgraded to warn(). */
export function printReportLine(line) {
  if (line.level === 'ok') ok(line.text);
  else if (line.level === 'warn') warn(line.text);
  else if (line.level === 'fail') fail(line.text);
  else info(line.text);
}

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'this-project': { type: 'boolean', default: false },
  'remove-ruflo': { type: 'boolean', default: false },
  'remove-aqe': { type: 'boolean', default: false },
  purge: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
};

export const help = `ak uninstall — leave cleanly

By default removes only the kit's own machine footprint (CLAUDE.md managed
blocks, MCP registration) and cleans any legacy shell-kit install. The global
packages (ruflo, agentic-qe) stay unless you ask for them. Each removal is
confirmed unless --yes.

Usage: ak uninstall [options]

Options:
  --this-project   also remove this project's patches (settings, .claude-flow)
  --remove-ruflo   uninstall the global ruflo package (confirmed)
  --remove-aqe     uninstall the global agentic-qe package (confirmed)
  --purge          remove everything: kit footprint + both global packages
  --yes            skip confirmation prompts
  --dry-run        print what would be removed; change nothing

Examples:
  ak uninstall                    remove the kit's footprint only
  ak uninstall --this-project     also unpatch the current repo
  ak uninstall --purge --dry-run  preview a full teardown`;

const confirm = async (q, yes) => {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a.startsWith('y');
};

export async function run({ flags }) {
  const dry = flags['dry-run'];
  const act = (msg, fn) => { if (dry) info(`[dry-run] ${msg}`); else { fn(); ok(msg); } };
  // Ownership markers are read ONCE up front: the purge path removes kit.json
  // below, and teardown decisions (opencode undo) must still see what ak owned
  // (codex-review — purge ordering must not strand managed opencode.json keys).
  const cfg = loadKitConfig();
  const kitCfg = cfg;
  let ownershipTeardownOk = true;

  // 0. User-scoped Codex line: only values recorded as ours are candidates.
  if (kitCfg.statusline?.codex) {
    if (dry) info('[dry-run] release managed Codex status line (preserving user-modified keys)');
    else {
      let r;
      try { r = removeCodexStatusline(kitCfg.statusline.codex.lastProjection); }
      catch (error) {
        warn(`Codex config was not changed; status-line ownership retained: ${error.message}`);
        r = null;
      }
      if (r) {
        kitCfg.statusline.codex = null;
        if (!flags.purge) saveKitConfig(kitCfg);
        ok(`Codex status-line ownership released${r.changed ? ' (unchanged managed keys removed)' : ' (user-modified keys preserved)'}`);
      }
    }
  }

  // 1. CLAUDE.md managed blocks: every built-in slug (registry-driven, so
  // non-ruflo blocks like ruvnet-brain-reference are covered), the legacy
  // ruflo-* pattern as a catch-all, plus any custom slugs from kit.json.
  const md = paths.claudeMdPath();
  if (fs.existsSync(md)) {
    let content = fs.readFileSync(md, 'utf8');
    const slugs = new Set([...content.matchAll(/<!-- BEGIN (ruflo-[\w-]+) -->/g)].map((m) => m[1]));
    for (const b of BUILTIN_BLOCKS) if (content.includes(BEGIN(b.slug))) slugs.add(b.slug);
    for (const b of kitCfg.customBlocks) if (content.includes(BEGIN(b.slug))) slugs.add(b.slug);
    if (slugs.size) {
      act(`stripped ${slugs.size} managed block(s) from ~/.claude/CLAUDE.md (backup written)`, () => {
        fs.copyFileSync(md, `${md}.bak.${Date.now()}`);
        for (const s of slugs) content = stripBlock(content, s);
        fs.writeFileSync(md, content);
      });
    }
  }

  // 2. deployed skill. kit.json is purged only after all receipt-dependent
  // teardown succeeds; otherwise it remains the recovery proof.
  const skill = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
  if (fs.existsSync(skill)) act('removed skill ruflo-token-audit', () => fs.rmSync(skill, { recursive: true }));

  // 2b. opencode host footprint (when ak managed it): strip the guidance blocks
  // from opencode's AGENTS.md, the opencode.json wiring, and deployed artifacts.
  const ocMd = paths.opencodeAgentsMdPath();
  if (fs.existsSync(ocMd)) {
    let content = fs.readFileSync(ocMd, 'utf8');
    const slugs = new Set([...content.matchAll(/<!-- BEGIN (ruflo-[\w-]+|ruvnet-[\w-]+) -->/g)].map((m) => m[1]));
    if (slugs.size) {
      act(`stripped ${slugs.size} managed block(s) from opencode AGENTS.md (backup written)`, () => {
        fs.copyFileSync(ocMd, `${ocMd}.bak.${Date.now()}`);
        for (const s of slugs) content = stripBlock(content, s);
        fs.writeFileSync(ocMd, content);
      });
    }
  }
  // Registry-driven host lifecycle teardown — reached by id, never by name
  // (mirrors x/host.mjs's off(), which does its undo the same way). cfg comes
  // from the top of run() (read before any purge of kit.json); --purge
  // removes kit.json below, so persisting cfg here would recreate it. Each
  // adapter's own undo() already honors ownership/receipts (opencode's
  // undoOpencode no-ops when it never held mcp:'ak', and marker-gates
  // artifact removal independent of that), so a BUILT-IN's call is
  // unconditional per host, same as before ADR-0031 P3 — the only kit-side
  // gate is "did anything actually happen", to avoid a no-op teardown line
  // (and a needless kit.json rewrite) on a host that was never enabled. An
  // ADMITTED external host is different: there is no "always safe, always
  // idempotent" guarantee for an arbitrary third-party hook the way there is
  // for opencode's own undo, so an admitted host's teardown is gated by
  // lifecycleExecutionEnabled (cfg enablement AND the experimental flag) —
  // an admitted host that was never enabled/consented for this run is never
  // invoked. hostsWithLifecycle() (built-ins + admitted, ADR-0031 P3) is safe
  // to loop unconditionally now: lifecycle-render.mjs's renderUndoReport
  // dispatches on the runLifecycle result's own shape, so this loop body
  // never destructures a host-specific result directly.
  for (const hostId of hostsWithLifecycle()) {
    if (!isBuiltinHost(hostId) && !lifecycleExecutionEnabled(hostId, cfg)) continue;
    const adapter = lifecycleAdapterFor(hostId);
    if (dry) {
      info(isBuiltinHost(hostId)
        ? `[dry-run] stripped ak-managed ${hostId} wiring + artifacts (opencode.json, plugin, agents, skill)`
        : `[dry-run] stripped ak-managed ${hostId} wiring + artifacts (hook-declared undo)`);
      continue;
    }
    const retired = await runLifecycle({ adapter, action: 'undo', cfg });
    const undoReport = renderUndoReport(hostId, retired);
    ownershipTeardownOk = ownershipTeardownOk && undoReport.ok;
    // Persist markers unconditionally, exactly like x/host.mjs's off()/pick():
    // undo() mutates cfg's ownership markers in memory even when it rewrote
    // no file (`undo.changed` measures the FILE, not cfg), so gating the save
    // on `changed` would strand a stale mcp:'ak' receipt forever on the
    // quiet-success path. Only the human-facing line stays gated on "did
    // anything observable happen".
    if (!flags.purge) saveKitConfig(cfg);
    for (const line of undoReport.lines) printReportLine(line);
  }
  if (flags.purge && fs.existsSync(paths.kitConfigPath())) {
    if (ownershipTeardownOk) act('removed kit.json', () => fs.rmSync(paths.kitConfigPath()));
    else warn('kit.json retained because OpenCode teardown is incomplete; it contains the recovery ownership receipt');
  }

  // 3. MCP registration + deny rules
  if (dry) info('[dry-run] unregister claude-flow/ruflo MCP + clean deny rules');
  else { const removed = await unregister(); ok(`MCP unregistered (deny rules cleaned: ${removed})`); }

  // 4. legacy shell-kit remnants
  for (const rc of ['.zshrc', '.bashrc'].map((f) => path.join(paths.home, f))) {
    if (!fs.existsSync(rc)) continue;
    const txt = fs.readFileSync(rc, 'utf8');
    if (txt.includes('ruflo-functions.sh')) {
      act(`removed shell-kit source line from ${rc}`, () => {
        fs.copyFileSync(rc, `${rc}.bak`);
        fs.writeFileSync(rc, txt.split('\n').filter((l) => !l.includes('ruflo-functions.sh')).join('\n'));
      });
    }
  }
  const localBin = path.join(paths.home, '.local', 'bin');
  if (fs.existsSync(localBin)) {
    // every ruflo-* here is shell-kit era (the npm kit's bins live in npm's global bin)
    for (const f of fs.readdirSync(localBin).filter((f) => f.startsWith('ruflo-'))) {
      act(`removed legacy ${path.join(localBin, f)}`, () => fs.rmSync(path.join(localBin, f)));
    }
  }
  const cfgDir = paths.legacyConfigDir(); // shell-kit files lived in ~/.config/ruflo
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir).filter((f) => f.endsWith('.sh') || f.endsWith('-template.md') || f === 'ruflo-reference-full.md')) {
      act(`removed legacy ${path.join(cfgDir, f)}`, () => fs.rmSync(path.join(cfgDir, f)));
    }
  }

  // 5. per-project revert
  if (flags['this-project']) {
    const sl = paths.projectStatusline(process.cwd());
    if (fs.existsSync(sl)) {
      act('reverted statusline footer in this project', () => {
        fs.copyFileSync(sl, `${sl}.bak`);
        let s = fs.readFileSync(sl, 'utf8');
        s = s.replace(/\/\* ruflo-seg:BEGIN \*\/[\s\S]*?\/\* ruflo-seg:END \*\/\n?/, '');
        s = s.replace(/ \+ rufloActivationSegments\(process\.cwd\(\)\)/g, '');
        fs.writeFileSync(sl, s);
      });
    }
  }

  // 6. global packages (machine-wide — confirmed individually)
  const removals = [];
  if (flags['remove-ruflo'] || flags.purge) removals.push('ruflo');
  if (flags['remove-aqe'] || flags.purge) removals.push('agentic-qe');
  for (const pkg of removals) {
    if (dry) { info(`[dry-run] npm uninstall -g ${pkg}`); continue; }
    if (await confirm(`Remove global ${pkg} for ALL projects on this machine?`, flags.yes)) {
      if (pkg === 'ruflo') await runCmd('ruflo', ['daemon', 'stop', '--all'], { timeout: 60_000 });
      const r = await runCmd('npm', ['uninstall', '-g', pkg], { timeout: 300_000 });
      (r.code === 0 ? ok : warn)(`${pkg}: ${r.code === 0 ? 'removed' : 'could not remove'}`);
    } else info(`kept ${pkg}`);
  }

  // RuvNet Brain: a user-scope plugin + a large (~512 MB) KB cache — left in
  // place (like ruflo/aqe) rather than force-deleted. Point at the manual path.
  if (rbPresent()) {
    info('RuvNet Brain left installed — remove manually: `claude plugin uninstall ruvnet-brain@ruvnet-brain` + `rm -rf ~/.cache/ruvnet-brain`');
  }

  ok('uninstall complete — project data (.swarm/.claude-flow/.agentic-qe) untouched');
  return ownershipTeardownOk ? 0 : 1;
}
