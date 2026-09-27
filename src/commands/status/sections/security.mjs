// security surface — honors kit.json security:false (`ak setup
// --no-security`): an info row with NO fix, so sync never plans (or heals)
// the surface a user turned off. Previously the flag was write-only.
import { aidefencePresent, rufloBuiltinDefence, securityPresent } from '../../../lib/natives.mjs';
import { row } from '../row.mjs';

export default {
  id: 'security',
  async collect({ cfg }) {
    if (cfg.security === false) {
      return [row('security', 'info', 'security checks disabled (kit.json security:false)')];
    }
    if (securityPresent()) {
      if (aidefencePresent()) {
        return [row('security', 'ok', '@claude-flow/security + aidefence present (defend functional)')];
      }
      // Ruflo 3.32.2+ falls back to a built-in engine (ruvnet/ruflo#2670): defend
      // still works; only the adaptive learning and the aidefence_* MCP tools are
      // lost, and healAidefence restores those.
      return [rufloBuiltinDefence()
        ? row('security', 'warn',
          "security defend uses Ruflo's built-in engine; @claude-flow/aidefence (adaptive learning and the aidefence_* MCP tools) is missing",
          'sync reinstalls @claude-flow/aidefence')
        : row('security', 'fail',
          'aidefence missing — `security defend` silently non-functional (ruvnet/ruflo#2670)',
          'sync reinstalls @claude-flow/aidefence')];
    }
    return [row('security', 'warn', '@claude-flow/security not found under global ruflo')];
  },
};
