import { createSubprocessExecutionAdapter } from './subprocess.mjs';
import { extractHandoff } from './handoff.mjs';

/** Codex's documented exec/json mode. Its configured sandbox policy is retained.
 *  worker.maxTurns is deliberately NOT forwarded: codex exec has no turn-cap
 *  flag (verified against its help) — the bound rides on the runner timeout. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'>} [options] */
export function createCodexExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'codex-exec-json', host: 'codex', command: 'codex',
    argumentsFor: (worker, cwd) => [
      'exec', '--json', '--cd', cwd,
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      worker.prompt,
    ],
    summaryFor: (observation) => {
      let finalText = null;
      for (const line of String(observation?.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); } catch { throw new TypeError('Codex JSONL output was malformed'); }
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string') {
          finalText = event.item.text;
        }
      }
      return extractHandoff(finalText);
    },
    ...options,
  });
}

export const CODEX_EXECUTION_ADAPTER = createCodexExecutionAdapter();
