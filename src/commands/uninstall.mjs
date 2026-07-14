// ruflo-kit uninstall — remove the kit's machine footprint (default), a
// project's patches (--this-project), and optionally the global packages
// (--remove-ruflo / --remove-aqe / --purge, each confirmed). Also cleans a
// LEGACY shell-kit install (rc source lines, ~/.local/bin/ruflo-*,
// ~/.config/ruflo shell files) — the migration path off the bash era.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { run as runCmd } from '../lib/exec.mjs';
import { stripBlock, BEGIN } from '../lib/blocks.mjs';
import { unregister } from '../lib/mcp.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import * as paths from '../lib/paths.mjs';
import { ok, warn, info } from '../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  'this-project': { type: 'boolean', default: false },
  'remove-ruflo': { type: 'boolean', default: false },
  'remove-aqe': { type: 'boolean', default: false },
  purge: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
};

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

  // 1. CLAUDE.md managed blocks (all ruflo-* slugs + any custom slugs from kit.json)
  const md = paths.claudeMdPath();
  if (fs.existsSync(md)) {
    let content = fs.readFileSync(md, 'utf8');
    const slugs = new Set([...content.matchAll(/<!-- BEGIN (ruflo-[\w-]+) -->/g)].map((m) => m[1]));
    for (const b of loadKitConfig().customBlocks) if (content.includes(BEGIN(b.slug))) slugs.add(b.slug);
    if (slugs.size) {
      act(`stripped ${slugs.size} managed block(s) from ~/.claude/CLAUDE.md (backup written)`, () => {
        fs.copyFileSync(md, `${md}.bak.${Date.now()}`);
        for (const s of slugs) content = stripBlock(content, s);
        fs.writeFileSync(md, content);
      });
    }
  }

  // 2. deployed skill + kit config
  const skill = path.join(paths.claudeSkillsDir(), 'ruflo-token-audit');
  if (fs.existsSync(skill)) act('removed skill ruflo-token-audit', () => fs.rmSync(skill, { recursive: true }));
  if (flags.purge && fs.existsSync(paths.kitConfigPath())) {
    act('removed kit.json', () => fs.rmSync(paths.kitConfigPath()));
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
    for (const f of fs.readdirSync(localBin).filter((f) => f.startsWith('ruflo-') && f !== 'ruflo-kit')) {
      act(`removed legacy ${path.join(localBin, f)}`, () => fs.rmSync(path.join(localBin, f)));
    }
  }
  const cfgDir = paths.configDir();
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

  ok('uninstall complete — project data (.swarm/.claude-flow/.agentic-qe) untouched');
  return 0;
}
