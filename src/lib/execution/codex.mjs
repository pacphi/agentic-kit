import { createSubprocessExecutionAdapter } from './subprocess.mjs';

/** Codex's documented exec/json mode. Its configured sandbox policy is retained. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'>} [options] */
export function createCodexExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'codex-exec-json', host: 'codex', command: 'codex',
    argumentsFor: (worker, cwd) => [
      'exec', '--json', '--cd', cwd,
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      worker.prompt,
    ],
    ...options,
  });
}

export const CODEX_EXECUTION_ADAPTER = createCodexExecutionAdapter();
