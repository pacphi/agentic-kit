// Project memory may legitimately have two stores: the compatibility/sql.js
// memory.db and the native bridge's plaintext agentdb-memory.db sibling.
// Presence cannot establish the active writer or CLI/MCP routing. The isolated
// `ak x verify memory` canary does not prove access to an existing corpus.
import path from 'node:path';
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
            ? `${path.basename(store.file)}: ${store.entries} active entr${store.entries === 1 ? 'y' : 'ies'} observed; backend, writer and existing-corpus routing unverified`
            : `${path.basename(store.file)} store is unreadable (${store.file}); existing-corpus access unverified`));
        }
        if (memory.secondary) rows.push(row('memory', 'warn',
          'two project memory stores coexist; preserve both. CLI --path selects a store; MCP routing needs separate verification. See Troubleshooting: Ruflo memory stores and routing'));
      }
    } catch (e) {
      rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
