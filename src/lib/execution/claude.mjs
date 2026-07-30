import { createSubprocessExecutionAdapter } from './subprocess.mjs';
import { extractHandoff } from './handoff.mjs';

/** Claude Code's documented print/json mode. No permission bypass is passed. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'>} [options] */
export function createClaudeExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'claude-print-json', host: 'claude', command: 'claude',
    argumentsFor: (worker) => [
      '--print', '--output-format', 'json',
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      // Templates carry per-node turn caps (#88) — honored where the CLI has a
      // surface; codex exec and opencode serve have none (documented there).
      ...(Number.isInteger(worker.maxTurns) && worker.maxTurns > 0 ? ['--max-turns', String(worker.maxTurns)] : []),
      worker.prompt,
    ],
    summaryFor: (observation) => {
      let payload;
      try { payload = JSON.parse(observation?.stdout ?? ''); } catch {
        throw new TypeError('Claude JSON output was malformed');
      }
      return extractHandoff(payload?.result);
    },
    ...options,
  });
}

export const CLAUDE_EXECUTION_ADAPTER = createClaudeExecutionAdapter();
