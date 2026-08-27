// Project memory may legitimately have two stores: the compatibility/sql.js
// memory.db and the native bridge's plaintext agentdb-memory.db sibling.
// Presence is a quick signal only; `ak x verify memory` performs the write
// round-trip proof.
import { projectMemoryStatus } from '../../../lib/project-memory.mjs';
import { row } from '../row.mjs';

export default {
  id: 'memory',
  async collect({ cwd }) {
    const rows = [];
    try {
      const memory = projectMemoryStatus(cwd);
      if (!memory.active) {
        rows.push(row('memory', 'info', 'no project memory store yet (run setup here to initialize)'));
      } else if (!memory.active.readable) {
        rows.push(row('memory', 'warn',
          `active ${memory.active.kind} store is unreadable (${memory.active.file}) — run: ak x verify memory`));
      } else {
        const sibling = memory.secondary
          ? `; ${memory.secondary.kind} compatibility store also present`
          : '';
        rows.push(row('memory', 'ok',
          `${memory.active.kind} active writer: ${memory.active.entries} active entr${memory.active.entries === 1 ? 'y' : 'ies'}${sibling}`));
      }
    } catch (e) {
      rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
