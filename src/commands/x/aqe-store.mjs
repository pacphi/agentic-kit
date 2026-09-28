// ak x aqe-store — preview and merge stray AQE stores (decision B5-D2): its
// own command, not a sync step, because it moves learned data and refuses
// while any AQE writer is open. The work is in src/lib/aqe-store-merge.mjs.
import { mergeAqeStores, restoreSteps } from '../../lib/aqe-store-merge.mjs';
import { repoRoot } from '../../lib/paths.mjs';
import { ok, warn, fail, info } from '../../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x aqe-store — merge stray AQE stores into the project store

A stray store is a .agentic-qe folder below the project root. AQE made it when a
command, hook or MCP server started in that folder before ak pinned AQE to the
project root; the project's hosts never read it.

Usage: ak x aqe-store [status|merge] [options]

  status   preview: patterns and experiences per stray, how many the root
           already has, how many are AQE starter patterns, the root's counts
           after a merge, and which processes hold the stores. No store is
           opened in place, but it is not free: it copies the whole root
           store and every stray store into ak's state folder and runs
           aqe init --auto --minimal and aqe learning stats --json in a
           scratch folder there (the init runs npm exec ruflo --version),
           then removes the copies. It also reports a root that already fails
           its integrity or foreign-key check and an interrupted earlier merge.
           A nested repository or worktree keeps its own store (skipped).
  merge    the same preview (a dry run) unless --yes; with --yes:
           1. refuses while any process holds the root or a stray store, or
              when that cannot be checked (close the Claude Code, Codex and
              OpenCode sessions in this project first); there is no --force
           2. backs up the root store (VACUUM INTO)
           3. rehearses AQE's own brain export/import on copies and checks the
              counts, integrity and foreign keys
           4. stops if a store changed since its copy; records the run as
              applying, imports into the root store, checks the counts again
           5. moves each whole stray folder into the archive; one that
              changed during the import stays in place
           Audit-trail (witness_chain) rows are not imported; they stay in the
           archive. A folder without memory.db is skipped and reported.
           AQE's starter patterns the root lacks are not imported either: ak
           builds a fresh AQE store in its scratch folder (aqe init --minimal,
           then aqe learning stats, with the project's AQE embedder) and leaves
           out every stray pattern with the same name, domain and type, with
           the rows that point at it. A starter pattern the root holds is left
           to AQE, which keeps the root's and merges its usage. Without that
           set it refuses.

Options:
  --yes       apply the merge (merge only)
  --dry-run   preview only, even with --yes
  --json      one JSON object on stdout

Backup, archive and receipt.json go to
  <state>/agentic-kit/aqe-store-merge/<time>/{backup,archive,receipt.json}
(<state> = $XDG_STATE_HOME or ~/.local/state; %LOCALAPPDATA% on Windows), never
inside a .agentic-qe folder. ak keeps them until you delete them. A preview
removes its scratch copies when it finishes; a failed merge keeps them.
Restore steps: docs/TROUBLESHOOTING.md, "Restore an AQE store from the merge
archive". Needs agentic-qe 3.14.4 or later.

Examples:
  ak x aqe-store status              preview what a merge would do
  ak x aqe-store merge               the same preview (dry run)
  ak x aqe-store merge --yes         merge, then archive the stray folders
  ak x aqe-store status --json       the preview as one JSON object`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function strayLine(stray) {
  if (!stray.readable) return `${stray.path}: copy unreadable (${stray.error}); a live writer may have torn it`;
  const seeds = (stray.seedPatterns ? `, ${plural(stray.seedPatterns, 'AQE starter pattern')} left out` : '')
    + (stray.seedPatternsInRoot ? `, ${plural(stray.seedPatternsInRoot, 'starter pattern')} the root holds (usage merged onto it)` : '');
  return `${stray.path}: ${plural(stray.patterns, 'pattern')} (${stray.alreadyInRoot} already in the root${seeds}), `
    + `${plural(stray.experiences, 'experience')} (${stray.experiencesInRoot ?? 0} already in the root, skipped), `
    + `${plural(stray.witnessRows, 'audit-trail row')} (not imported)`;
}

function holdersLine(found) {
  if (!found) return null;
  const how = found.method === 'census' ? 'Windows session census' : found.method;
  if (found.error) return `holders: could not check (${found.error})`;
  if (!found.holders.length) return `holders: none found (${how}${found.complete ? '' : ', incomplete'})`;
  return `holders (${how}): ${found.holders.map((h) => `PID ${h.pid} ${h.command || '(unknown)'}`).join(', ')}`;
}

function printPreview(result) {
  info(`AQE ${result.aqeVersion ?? 'not installed'}; project store ${result.root}/.agentic-qe/memory.db: `
    + `${result.rootStore.readable ? `${plural(result.rootStore.patterns, 'pattern')}, ${plural(result.rootStore.experiences, 'experience')}` : `unreadable copy (${result.rootStore.error})`}`);
  if (result.seeds && !result.seeds.error) {
    console.log(`AQE starter set: ${plural(result.seeds.patterns, 'pattern')} from a fresh store (embedder from ${result.seeds.source}); a merge leaves them out`);
  }
  for (const stray of result.strays) console.log(`  ${strayLine(stray)}`);
  for (const skipped of result.skipped) console.log(`  ${skipped.path}: skipped (${skipped.reason})`);
  console.log(`after the merge the root would hold ${plural(result.expected.patterns, 'pattern')} and ${plural(result.expected.experiences, 'experience')}`);
  const holders = holdersLine(result.holders);
  if (holders) console.log(holders);
}

function printOutcome(result) {
  if (result.status === 'preview') {
    if (result.refusal) warn(`a merge now would refuse: ${result.refusal}`);
    else console.log('run: ak x aqe-store merge --yes');
    return 0;
  }
  if (result.status === 'merged') {
    ok(`merged ${plural(result.strays.length, 'stray store')} into ${result.root}/.agentic-qe/memory.db `
      + `(${plural(result.after.patterns, 'pattern')}, ${plural(result.after.experiences, 'experience')})`);
    for (const moved of result.archived) console.log(`  archived ${moved.path} → ${moved.to}`);
    for (const left of result.leftInPlace) {
      warn(left.reason.startsWith('partially moved')
        ? `${left.path}: ${left.reason}; close what holds it, then delete what is left of ${left.path} by hand`
        : `left in place: ${left.path} (${left.reason}); close what holds it and run ak x aqe-store merge --yes again`);
    }
    console.log(`backup: ${result.backup}`);
    console.log(`receipt: ${result.receipt}`);
    return result.leftInPlace.length ? 1 : 0;
  }
  if (result.status === 'refused') { warn(`refused: ${result.reason}`); return 1; }
  fail(`merge failed: ${result.reason}`);
  if (result.restore) console.log(`to restore the root store: ${result.restore}`);
  if (result.receipt) console.log(`receipt: ${result.receipt}`);
  return 1;
}

function printInterrupted(result) {
  for (const run of result.interrupted ?? []) {
    warn(`an earlier merge (${run.runId}) was interrupted during its import: the project store may hold part of its strays. `
      + `Running the merge again finishes it (AQE skips what the root already holds); `
      + `${run.backup ? `to undo it instead, ${restoreSteps(run.backup, result.root)}` : 'no backup was recorded for it, so it cannot be undone from the archive'}. Receipt: ${run.receipt}`);
  }
}

/** @param {{ flags?: any, positionals?: string[], cwd?: string, merge?: typeof mergeAqeStores }} options */
export async function run({ flags = {}, positionals = [], cwd = process.cwd(), merge = mergeAqeStores }) {
  const action = positionals[0] ?? 'status';
  if (!['status', 'merge'].includes(action) || positionals.length > 1) {
    fail('usage: ak x aqe-store [status|merge] [--yes] [--dry-run] [--json]');
    return 2;
  }
  const root = repoRoot(cwd);
  if (!root) {
    if (flags.json) console.log(JSON.stringify({ status: 'no-project', root: null }));
    else console.log(`not inside a repository (${cwd}): stray AQE stores are per project; run this from the project`);
    return 1;
  }
  const apply = action === 'merge' && flags.yes === true && flags['dry-run'] !== true;
  const result = await merge(root, { apply });
  if (flags.json) {
    console.log(JSON.stringify(result));
    return ['refused', 'failed'].includes(result.status) || result.leftInPlace?.length ? 1 : 0;
  }
  printInterrupted(result);
  if (result.status === 'nothing') {
    ok(`no stray AQE store below ${root}${result.skipped.length ? ` (${result.skipped.map((s) => `${s.path}: ${s.reason}`).join(', ')})` : ''}`);
    return 0;
  }
  if (result.strays?.length && result.expected) printPreview(result);
  return printOutcome(result);
}
