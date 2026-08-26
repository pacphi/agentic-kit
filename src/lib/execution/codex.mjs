import { createJsonlSummaryCapture, createSubprocessExecutionAdapter } from './subprocess.mjs';
import { HANDOFF_REQUEST_JSON, HANDOFF_SCHEMA_PATH, parseHandoffText } from './handoff.mjs';

// Hermetic seat trims (ADR-0034, opt-in via worker.hermetic). Codex 0.149.x
// offers no per-invocation control of the MCP roster (plugins mount servers
// and instructions regardless — probed 2026-08-26), so isolation is bounded:
// no session persistence, right-sized reasoning effort, and no project docs.
// The machine-wide ~/.codex/AGENTS.md still loads; ak manages that content.
// Roster-independence comes from the schema-native transport below instead.
const HERMETIC_FLAGS = Object.freeze([
  '--ephemeral',
  '-c', 'model_reasoning_effort="medium"',
  '-c', 'project_doc_max_bytes=0',
]);

/** Codex's documented exec/json mode. Its configured sandbox policy is retained.
 *  worker.maxTurns is deliberately NOT forwarded: codex exec has no turn-cap
 *  flag (verified against its help) — the bound rides on the runner timeout. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'|'summaryCaptureFor'|'handoffRequestFor'>} [options] */
export function createCodexExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'codex-exec-json', host: 'codex', command: 'codex',
    argumentsFor: (worker, cwd) => [
      'exec', '--json', '--cd', cwd,
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      ...(worker.hermetic === true ? HERMETIC_FLAGS : []),
      // Schema-native handoff (ADR-0034): --output-schema constrains the final
      // agent message to the handoff shape, so trailing-instruction collisions
      // (#108's stochastic protocol_error) cannot malform it. Held 5/5 with
      // MCP servers active at codex 0.149.1 (openai/codex#15451 not
      // reproduced there — re-probe on codex upgrades).
      ...(worker.requiresHandoff === true ? ['--output-schema', HANDOFF_SCHEMA_PATH] : []),
      worker.prompt,
    ],
    summaryCaptureFor: () => createJsonlSummaryCapture(
      (event) => event?.type === 'item.completed' && event.item?.type === 'agent_message'
        ? event.item.text
        : null,
      'Codex',
    ),
    summaryFor: (_observation, finalText) => parseHandoffText(finalText),
    handoffRequestFor: () => HANDOFF_REQUEST_JSON,
    ...options,
  });
}

export const CODEX_EXECUTION_ADAPTER = createCodexExecutionAdapter();
