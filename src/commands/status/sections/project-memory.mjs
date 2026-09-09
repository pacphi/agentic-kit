// Project memory may legitimately have two stores: the compatibility/sql.js
// memory.db and the native bridge's plaintext agentdb-memory.db sibling.
// Presence cannot establish the active writer or CLI/MCP routing. The isolated
// `ak x verify memory` canary does not prove access to an existing corpus.
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
      } else {
        for (const store of memory.stores.filter((candidate) => candidate.present)) {
          rows.push(row('memory', store.readable ? 'info' : 'warn', store.readable
            ? `${store.kind}: ${store.entries} active entr${store.entries === 1 ? 'y' : 'ies'} observed; writer and existing-corpus routing unverified`
            : `${store.kind} store is unreadable (${store.file}); existing-corpus access unverified`));
        }
        if (memory.secondary) rows.push(row('memory', 'warn',
          'two project memory stores coexist; CLI and MCP may select different files — an isolated canary does not verify existing-corpus routing'));
      }
    } catch (e) {
      rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
