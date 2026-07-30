import { createJsonlSummaryCapture, createSubprocessExecutionAdapter } from './subprocess.mjs';
import { extractHandoff } from './handoff.mjs';

/** Claude Code's documented print/json mode. No permission bypass is passed. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'|'summaryCaptureFor'>} [options] */
export function createClaudeExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'claude-print-json', host: 'claude', command: 'claude',
    argumentsFor: (worker) => [
      '--print', '--output-format', 'stream-json', '--verbose',
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      // Templates carry per-node turn caps (#88) — honored where the CLI has a
      // surface; codex exec and opencode serve have none (documented there).
      ...(Number.isInteger(worker.maxTurns) && worker.maxTurns > 0 ? ['--max-turns', String(worker.maxTurns)] : []),
      worker.prompt,
    ],
    summaryCaptureFor: () => createJsonlSummaryCapture(
      (event) => event?.type === 'result' && event?.subtype === 'success' ? event.result : null,
      'Claude',
    ),
    summaryFor: (_observation, finalText) => extractHandoff(finalText),
    ...options,
  });
}

export const CLAUDE_EXECUTION_ADAPTER = createClaudeExecutionAdapter();
