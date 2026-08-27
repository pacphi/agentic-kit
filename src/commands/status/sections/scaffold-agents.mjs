// Scaffold agents (ADR-128 Phase 2 removals — ruflo#2985). Upstream never
// revisits an existing scaffold, so projects inited before ruflo 3.38.x are
// missing up to 9 plugin-canonical agents (coder, researcher, reviewer, …).
// The fix is upstream's `ruflo migrate fix --agents` (PR #2986): when the
// installed CLI ships it, the row carries a fix and sync delegates; until
// then it is advisory-only — a kit-side restore would fork plugin-canonical
// content. Spawn-free (dist probe + file walk), project-scoped: silent when
// the cwd has no .claude/agents tree.
import { removedAgentGaps, upstreamFixAvailable } from '../../../lib/scaffold.mjs';
import { row } from '../row.mjs';

export default {
  id: 'scaffold-agents',
  async collect({ cwd }) {
    const rows = [];
    try {
      const { relevant, gaps } = removedAgentGaps(cwd);
      if (relevant && gaps.length > 0) {
        const named = gaps.slice(0, 3).map((g) => g.basename.replace(/\.md$/, '')).join(', ');
        const suffix = gaps.length > 3 ? ', …' : '';
        if (upstreamFixAvailable()) {
          rows.push(row('scaffold-agents', 'warn',
            `${gaps.length} ADR-128-removed agent(s) missing from .claude/agents (${named}${suffix})`,
            'sync delegates to `ruflo migrate fix --agents`'));
        } else {
          rows.push(row('scaffold-agents', 'info',
            `${gaps.length} ADR-128-removed agent(s) missing (${named}${suffix}) — installed ruflo lacks \`migrate fix --agents\` (ruflo#2986 pending); upgrade ruflo or install the owning plugins`));
        }
      } else if (relevant) {
        rows.push(row('scaffold-agents', 'ok', 'ADR-128-removed agents present or plugin-covered'));
      }
    } catch (e) {
      rows.push(row('scaffold-agents', 'warn', `scaffold agent check unavailable: ${e.message}`));
    }
    return rows;
  },
};
