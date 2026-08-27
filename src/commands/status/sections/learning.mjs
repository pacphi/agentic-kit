// learning (project-scope quick signals)
import path from 'node:path';
import * as paths from '../../../lib/paths.mjs';
import { readJson } from '../../../lib/settings.mjs';
import { row } from '../row.mjs';

export default {
  id: 'learning',
  async collect({ cwd }) {
    const stats = readJson(path.join(paths.projectClaudeFlowDir(cwd), 'neural', 'stats.json'));
    if (stats) {
      const pn = stats.patternsLearned ?? 0;
      return [row('learning', pn > 0 ? 'ok' : 'warn',
        pn > 0 ? `${pn} patterns learned, ${stats.trajectoriesRecorded ?? 0} trajectories (this project)`
               : 'learning initialized but no patterns yet (this project)')];
    }
    return [row('learning', 'info', 'no learning state in this project (run setup here to activate)')];
  },
};
