// Built-in execution adapters. Importing this registry has no side effects:
// processes are only created when the runner selects an adapter for a worker.
import { OPENCODE_EXECUTION_ADAPTER } from './opencode.mjs';
import { CLAUDE_EXECUTION_ADAPTER } from './claude.mjs';
import { CODEX_EXECUTION_ADAPTER } from './codex.mjs';

export const EXECUTION_ADAPTERS = Object.freeze(new Map([
  ['claude', CLAUDE_EXECUTION_ADAPTER],
  ['codex', CODEX_EXECUTION_ADAPTER],
  ['opencode', OPENCODE_EXECUTION_ADAPTER],
]));
