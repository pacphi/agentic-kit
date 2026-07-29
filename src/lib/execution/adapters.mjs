// Built-in execution adapters. Importing this registry has no side effects:
// processes are only created when the runner selects an adapter for a worker.
import { OPENCODE_EXECUTION_ADAPTER } from './opencode.mjs';

export const EXECUTION_ADAPTERS = Object.freeze(new Map([
  ['opencode', OPENCODE_EXECUTION_ADAPTER],
]));
