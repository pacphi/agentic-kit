import { createJsonlSummaryCapture, createSubprocessExecutionAdapter } from './subprocess.mjs';
import { HANDOFF_REQUEST_STRUCTURED, HANDOFF_SCHEMA_TEXT, parseHandoffText } from './handoff.mjs';

// Hermetic seat isolation (ADR-0034, opt-in via worker.hermetic): disable ALL
// hooks (plugin hooks included — the RuvNet Brain receipt mandate is a plugin
// hook), mount exactly one MCP server (ruflo, the coordination/evidence bus)
// ignoring every other registration, and self-carry the permission for it so
// the seat does not depend on this machine's settings allowlists. Deliberately
// NOT `--bare`: bare mode disables subscription OAuth (API-key only), which
// would silently change who pays. Settings sources still load (model default,
// trust); only their hooks are neutralized.
// Order is load-bearing: `--mcp-config <configs...>` and
// `--allowedTools <tools...>` are VARIADIC and would swallow a directly
// following prompt argument ("Input must be provided..." — observed live on
// the one seat with no flag after them). Every variadic flag is therefore
// followed by another flag token, and the block ends on single-value
// `--settings`, which consumes exactly one argument and so guards the prompt.
const HERMETIC_FLAGS = Object.freeze([
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{"ruflo":{"command":"ak","args":["x","ruflo-mcp"]}}}',
  '--allowedTools', 'mcp__ruflo',
  '--settings', '{"disableAllHooks":true}',
]);

/** Claude Code's documented print/json mode. No permission bypass is passed. */
/** @param {Omit<Parameters<typeof createSubprocessExecutionAdapter>[0], 'id'|'host'|'command'|'argumentsFor'|'summaryFor'|'summaryCaptureFor'|'handoffRequestFor'>} [options] */
export function createClaudeExecutionAdapter(options = {}) {
  return createSubprocessExecutionAdapter({
    id: 'claude-print-json', host: 'claude', command: 'claude',
    argumentsFor: (worker) => [
      '--print', '--output-format', 'stream-json', '--verbose',
      ...(worker.configuredModel ? ['--model', worker.configuredModel] : []),
      // Templates carry per-node turn caps (#88) — honored where the CLI has a
      // surface; codex exec and opencode serve have none (documented there).
      ...(Number.isInteger(worker.maxTurns) && worker.maxTurns > 0 ? ['--max-turns', String(worker.maxTurns)] : []),
      ...(worker.hermetic === true ? HERMETIC_FLAGS : []),
      // Schema-native handoff (ADR-0034): --json-schema makes the CLI enforce
      // the handoff shape and return it as `structured_output` on the result
      // event — the final-text SHAPE stops being load-bearing (#108).
      ...(worker.requiresHandoff === true ? ['--json-schema', HANDOFF_SCHEMA_TEXT] : []),
      worker.prompt,
    ],
    summaryCaptureFor: () => createJsonlSummaryCapture(
      (event) => {
        if (event?.type !== 'result' || event?.subtype !== 'success') return null;
        // --json-schema delivers the validated object in structured_output;
        // the text result remains the path for legacy tagged handoffs.
        if (event.structured_output !== undefined && event.structured_output !== null) {
          return JSON.stringify(event.structured_output);
        }
        return event.result;
      },
      'Claude',
    ),
    summaryFor: (_observation, finalText) => parseHandoffText(finalText),
    // Structured phrasing, not the bare-object demand: --json-schema derives
    // structured_output out of band, and a "final message must be the object"
    // instruction is a contradiction the model may obey by refusing the task.
    handoffRequestFor: () => HANDOFF_REQUEST_STRUCTURED,
    ...options,
  });
}

export const CLAUDE_EXECUTION_ADAPTER = createClaudeExecutionAdapter();
