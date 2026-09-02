// telemetry-records.mjs — decodes ONE raw transcript record's wire shape for
// BOTH the batch usage scanner (usage-index.mjs) and the live session
// adapters (src/lib/live/*-adapter.mjs). Decode only: aggregation (batch) and
// event emission (live) read genuinely different things out of a decoded
// record and stay separate here — this module answers only "what kind of
// record is this, and what does it say", never "what should happen because
// of it".
//
// Both vendors' wire formats have already drifted under this codebase's own
// consumers once — the live adapter recognized only the legacy Codex
// user_message/agent_message pair while the batch scanner had already grown
// support for the newer item_completed envelope, so a fresh Codex rollout
// looked dead in the live view while the batch scan counted it correctly.
// Decoding each vendor's records ONCE, here, is what keeps a future format
// shift from being fixed in one consumer and not the other.

/** Trailing path segment, used as a privacy-safe "which file" hint by the
 *  live adapters. Was defined verbatim in both codex-adapter.mjs and
 *  claude-adapter.mjs before this module existed. */
export function artifactName(value) {
  return typeof value === 'string'
    ? value.replaceAll('\\', '/').split('/').pop()?.slice(0, 256) ?? null : null;
}

/** Codex spells its inference provider `model_provider` in session_meta and
 *  turn_context payloads; a bare `provider` field is legacy-format tolerance
 *  only. One implementation of that lookup, usable both from a decoded
 *  record's own payload and from a caller's carried-forward meta object
 *  (the live adapter remembers the last session_meta payload across records,
 *  which decodeCodexRecord — operating on one record at a time — cannot see). */
export function resolveCodexProvider(payloadLike) {
  const value = payloadLike?.model_provider ?? payloadLike?.provider;
  return typeof value === 'string' && value ? value : null;
}

/** Flatten a Claude content array into display text, dropping binary payloads
 *  (a pasted screenshot is megabytes of base64 nobody wants to render). */
export function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'image') out.push('[image]');
    else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push(b.thinking);
    else if (b.type === 'tool_result') {
      const c = b.content;
      out.push(`[tool result] ${typeof c === 'string' ? c : claudeText(c)}`);
    } else if (b.type === 'tool_use') {
      out.push(`[tool: ${b.name}]`);
    }
  }
  return out.join('\n');
}

/** Newer Codex rollouts wrap messages in `item_completed` and use a different
 *  content-block discriminator per role (`Text` for agent output, `text` for
 *  user input). Kept at this one wire-decoding boundary so every consumer —
 *  batch aggregation and the live adapter alike — reads the same
 *  prompt/response model for both generations. */
function codexItemText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.message === 'string') return item.message;
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .filter((block) => (block?.type === 'Text' || block?.type === 'text') && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** Decode one `event_msg` payload into `{role, text, generation}`, or `null`
 *  when it is not a recognized message shape. Handles BOTH Codex generations:
 *  legacy `user_message`/`agent_message` events, and the newer
 *  `item_completed` envelope wrapping a `UserMessage`/`AgentMessage` item.
 *  `generation` tells a caller that tracks parse diagnostics (the batch
 *  scanner's legacyEvents/itemCompletedEvents counters) which wire shape this
 *  was, without forcing every consumer to re-derive it. An `item_completed`
 *  whose item type is unrecognized returns `{ role: null, unknownItemType }`
 *  so that same caller still learns the item type it could not classify. */
function decodeCodexMessage(payload) {
  if (payload?.type === 'user_message') {
    return { role: 'user', text: typeof payload.message === 'string' ? payload.message : '', generation: 'legacy' };
  }
  if (payload?.type === 'agent_message') {
    return { role: 'assistant', text: typeof payload.message === 'string' ? payload.message : '', generation: 'legacy' };
  }
  if (payload?.type !== 'item_completed') return null;
  const item = payload.item;
  if (item?.type === 'UserMessage') return { role: 'user', text: codexItemText(item), generation: 'item' };
  if (item?.type === 'AgentMessage') return { role: 'assistant', text: codexItemText(item), generation: 'item' };
  return {
    role: null, generation: 'item',
    unknownItemType: typeof item?.type === 'string' ? item.type : '<unknown>',
  };
}

/** `session_meta` → the authoritative session id, cwd, and thread_source (a
 *  `"subagent"` value marks a thread_spawn replay whose tokens the batch
 *  parser excludes from aggregation). */
function decodeSessionMeta(payload) {
  return {
    type: 'meta',
    sessionId: payload.id,
    cwd: payload.cwd,
    threadSource: payload.thread_source,
    provider: resolveCodexProvider(payload),
    model: payload.model,
  };
}

/** `turn_context` → the model id in effect from this point on. */
function decodeTurnContext(payload) {
  return {
    type: 'turnContext',
    cwd: payload.cwd,
    provider: resolveCodexProvider(payload),
    model: payload.model,
  };
}

/** `event_msg` → `token_count`: a CUMULATIVE usage snapshot, so only the last
 *  one a caller sees should be kept. */
function decodeTokenCount(payload) {
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  return {
    type: 'tokenCount',
    usage: {
      total: info.total_token_usage && typeof info.total_token_usage === 'object'
        ? info.total_token_usage : null,
      // Unlike total_token_usage, this is one turn's prompt snapshot. Codex
      // reports input_tokens as the gross model input (cached_input_tokens is
      // its subset), so callers must not add the two fields together.
      last: info.last_token_usage && typeof info.last_token_usage === 'object'
        ? info.last_token_usage : null,
      // Keep the window from the SAME token-count envelope as `last`; a
      // task_started window remains a compatibility fallback for older hosts.
      contextWindow: Number.isFinite(Number(info.model_context_window))
        ? Number(info.model_context_window) : null,
      rateLimits: payload.rate_limits && typeof payload.rate_limits === 'object'
        ? payload.rate_limits : null,
    },
  };
}

/** `event_msg` → everything but `token_count`: a message (legacy or
 *  item_completed), a lifecycle event, or unrecognized. */
function decodeEventMsg(payload) {
  if (payload.type === 'token_count') return decodeTokenCount(payload);
  const message = decodeCodexMessage(payload);
  if (message) {
    return message.role
      ? { type: 'message', role: message.role, text: message.text, generation: message.generation }
      : { type: null, generation: message.generation, unknownItemType: message.unknownItemType };
  }
  if (['task_complete', 'turn_aborted'].includes(payload.type)) {
    return { type: 'lifecycle', status: payload.type === 'turn_aborted' ? 'cancelled' : 'completed' };
  }
  return { type: null };
}

/** `response_item` → a tool call or its result. */
function decodeResponseItem(payload) {
  if (['function_call', 'custom_tool_call'].includes(payload.type)) {
    return { type: 'toolCall', callId: payload.call_id ?? payload.id, toolName: payload.name };
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    return { type: 'toolResult', callId: payload.call_id ?? payload.id };
  }
  return { type: null };
}

const CODEX_RECORD_DECODERS = {
  session_meta: decodeSessionMeta,
  turn_context: decodeTurnContext,
  event_msg: decodeEventMsg,
  response_item: decodeResponseItem,
};

/**
 * Decode one raw Codex rollout JSONL record (`{type, payload, timestamp}`)
 * into a normalized description of what it is. Fields are raw pass-throughs
 * of the underlying payload wherever the two consumers currently apply their
 * own validation on top (e.g. batch requires a tool call's `name`; live
 * requires its `callId`) — decode centralizes the WALK, not every downstream
 * validation nuance, so neither consumer's existing behavior shifts.
 *
 * Returns `{type, sessionId?, cwd?, threadSource?, provider?, model?, role?,
 * text?, generation?, usage?, callId?, toolName?, status?, unknownItemType?}`
 * — `type` is one of `'meta'|'turnContext'|'message'|'tokenCount'|'toolCall'|
 * 'toolResult'|'lifecycle'|null`. Deliberately untyped beyond that: the raw
 * wire payload's shape varies per `type`, and this module is JS, not TS.
 */
export function decodeCodexRecord(record) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const decoder = CODEX_RECORD_DECODERS[record?.type];
  return decoder ? decoder(payload) : { type: null };
}

/** Partition a Claude content-block array into its tool_use/tool_result
 *  blocks — the two block kinds any consumer here treats as structured
 *  rather than display text. */
function splitClaudeBlocks(blocks) {
  const toolUses = [];
  const toolResults = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name });
    else if (block.type === 'tool_result') toolResults.push({ id: block.tool_use_id, isError: block.is_error === true });
  }
  return { toolUses, toolResults };
}

/** `user`/`assistant`/`null` — any other `record.type` (tool results, meta
 *  rows) is not a message role this module normalizes. */
function claudeRole(record) {
  if (record?.type === 'user') return 'user';
  if (record?.type === 'assistant') return 'assistant';
  return null;
}

/** Claude's four token-usage fields, normalized to zero rather than NaN.
 *  `cache_read_input_tokens`/`cache_creation_input_tokens` are separate
 *  fields the API already reports, kept apart rather than folded into
 *  `input_tokens` (which would double them into gross input). */
function claudeUsage(record) {
  const usage = record?.message?.usage ?? {};
  return {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
  };
}

/**
 * Decode one raw Claude transcript JSONL record into a normalized
 * description of what it is. As with decodeCodexRecord, fields are raw
 * pass-throughs where the two consumers apply different validation on top
 * (batch requires a tool_use block's `name`; live requires its `id`).
 *
 * Returns `{role, sessionId, agentId, isSidechain, model, isApiError, text,
 * toolUses, toolResults, usage}` — `role` is `'user'|'assistant'|null`.
 * Deliberately untyped beyond that, for the same reason as decodeCodexRecord.
 */
export function decodeClaudeRecord(record) {
  const content = record?.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const { toolUses, toolResults } = splitClaudeBlocks(blocks);
  return {
    role: claudeRole(record),
    sessionId: record?.sessionId,
    agentId: record?.agentId,
    isSidechain: record?.isSidechain === true,
    model: record?.message?.model,
    isApiError: record?.isApiErrorMessage === true || record?.message?.model === '<synthetic>',
    text: claudeText(content),
    toolUses,
    toolResults,
    usage: claudeUsage(record),
  };
}
