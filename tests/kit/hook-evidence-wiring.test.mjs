// #309: every production path that builds the Maintenance inventory passes it hook evidence, and the
// default evidence source (the same read-only audit `ak audit hooks` runs) works end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rmrf, sandboxHome, sandboxProject } from './helpers/home-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The default audit reads the home and the census, so it runs in a throwaway home with the project as the
// working directory. paths.mjs snapshots the home when it loads, so everything below is imported after it.
const home = sandboxHome('ak-hook-wiring');
const project = sandboxProject('ak-hook-wiring');
const originalCwd = process.cwd();
after(() => { process.chdir(originalCwd); rmrf(home, project); });

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every `createManagementService(` call in production source, with the text of its argument list. */
function managementServiceCalls() {
  const calls = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(at); continue; }
      if (!entry.isFile() || !/\.mjs$/.test(entry.name)) continue;
      const relative = path.relative(ROOT, at).split(path.sep).join('/');
      if (relative === 'src/lib/maintenance/management/service.mjs') continue; // its definition
      const source = stripComments(fs.readFileSync(at, 'utf8'));
      for (const match of source.matchAll(/createManagementService\(/g)) {
        let depth = 0;
        let end = match.index + match[0].length - 1;
        for (; end < source.length; end++) {
          if (source[end] === '(') depth++;
          if (source[end] === ')' && --depth === 0) break;
        }
        calls.push({ file: relative, args: source.slice(match.index, end + 1) });
      }
    }
  };
  visit(path.join(ROOT, 'src'));
  return calls;
}

test('every production createManagementService call passes hook evidence', () => {
  const calls = managementServiceCalls();
  assert.deepEqual([...new Set(calls.map((call) => call.file))].sort(),
    ['src/commands/maintain.mjs', 'src/lib/dashboard-server.mjs', 'src/lib/refresh.mjs'],
    'the dashboard, refresh and maintain are the production callers; a new one must be added here on purpose');
  for (const call of calls) {
    assert.match(call.args, /hookEvidence/, `${call.file} builds the inventory without hook evidence:\n${call.args}`);
  }
});

test('the default hook evidence audits the working repository and names it as the project of its hooks', async () => {
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node project-stop.cjs', timeout: 3000 }] }] },
  }));
  process.chdir(project);
  const { collectHookEvidence } = await import('../../src/lib/maintenance/management/hook-evidence.mjs');
  const { hookReadModel, hookPlacementContext } = await collectHookEvidence();

  const projectHooks = hookReadModel.definitionGroups.flatMap((group) => group.placements)
    .filter((placement) => placement.source.kind === 'project');
  assert.equal(projectHooks.length, 1);
  assert.deepEqual(hookPlacementContext(projectHooks[0].occurrenceId), { projectRoot: fs.realpathSync(project) });
  assert.equal(JSON.stringify(hookReadModel).includes(fs.realpathSync(project)), false, 'the read model stays path-free');
});
