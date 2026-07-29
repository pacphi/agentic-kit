import { createSubprocessExecutionAdapter } from './subprocess.mjs';

/** Claude Code's documented print/json mode. No permission bypass is passed. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'>} [options] */
export function createClaudeExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'claude-print-json', host: 'claude', command: 'claude',
    argumentsFor: (worker) => [
      '--print', '--output-format', 'json',
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      worker.prompt,
    ],
    ...options,
  });
}

export const CLAUDE_EXECUTION_ADAPTER = createClaudeExecutionAdapter();
