import { createJsonlSummaryCapture, createSubprocessExecutionAdapter } from './subprocess.mjs';
import { extractHandoff } from './handoff.mjs';

/** Codex's documented exec/json mode. Its configured sandbox policy is retained.
 *  worker.maxTurns is deliberately NOT forwarded: codex exec has no turn-cap
 *  flag (verified against its help) — the bound rides on the runner timeout. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'|'summaryCaptureFor'>} [options] */
export function createCodexExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'codex-exec-json', host: 'codex', command: 'codex',
    argumentsFor: (worker, cwd) => [
      'exec', '--json', '--cd', cwd,
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      worker.prompt,
    ],
    summaryCaptureFor: () => createJsonlSummaryCapture(
      (event) => event?.type === 'item.completed' && event.item?.type === 'agent_message'
        ? event.item.text
        : null,
      'Codex',
    ),
    summaryFor: (_observation, finalText) => extractHandoff(finalText),
    ...options,
  });
}

export const CODEX_EXECUTION_ADAPTER = createCodexExecutionAdapter();
