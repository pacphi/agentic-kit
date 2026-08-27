import { classifyToolName } from './tool-classify.mjs';
import { decodeCodexRecord } from '../telemetry-records.mjs';

const iso = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const valueText = (value) => typeof value === 'string' && value ? value : null;
const details = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

function textBlocks(content) {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    if (['text', 'input_text', 'output_text', 'summary_text'].includes(block.type)) {
      return valueText(block.text) ? [block.text] : [];
    }
    return [];
  });
}

function base(context, record, role) {
  return {
    sessionId: context.sessionId,
    at: iso(record?.timestamp) ?? context.observedAt ?? new Date().toISOString(),
    actor: {
      id: valueText(context.actorId) ?? context.sessionId,
      role,
      label: valueText(context.actorLabel),
      parentId: valueText(context.parentActorId),
    },
  };
}

/**
 * Convert one Claude transcript record into content-plane candidates. No raw
 * record or tool payload is spread into the result.
 */
export function adaptClaudeTranscriptRecord(record, context = {}) {
  if (!record || typeof record !== 'object' || !valueText(context.sessionId)) return [];
  const out = [];
  if (record.type === 'user') {
    const blocks = record.message?.content;
    const toolResults = Array.isArray(blocks)
      ? blocks.filter((block) => block?.type === 'tool_result') : [];
    for (const block of toolResults) {
      out.push({
        ...base(context, record, 'tool'), kind: 'tool-result',
        key: valueText(block.tool_use_id) ? `claude:tool-result:${block.tool_use_id}` : null,
        tool: {
          callId: valueText(block.tool_use_id),
          name: null, category: 'tool', status: block.is_error ? 'failed' : 'completed',
        },
        details: details(block.content),
      });
    }
    if (toolResults.length) {
      for (const text of textBlocks(blocks)) {
        out.push({
          ...base(context, record, 'tool'), kind: 'status', text,
          key: valueText(record.uuid) ? `claude:tool-context:${record.uuid}:${out.length}` : null,
        });
      }
      return out;
    }
    if (record.isMeta === true) return [];
    for (const text of textBlocks(blocks)) {
      out.push({
        ...base(context, record, 'user'), kind: 'message', text,
        key: valueText(record.uuid) ? `claude:message:${record.uuid}` : null,
      });
    }
    return out;
  }
  if (record.type === 'system') {
    const label = valueText(record.subtype) ?? valueText(record.level);
    return label ? [{
      ...base(context, record, 'system'), kind: 'status', text: label,
      key: valueText(record.uuid) ? `claude:system:${record.uuid}` : null,
    }] : [];
  }
  if (record.type !== 'assistant') return [];
  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  for (const block of blocks) {
    if (block?.type === 'text' && valueText(block.text)) {
      out.push({
        ...base(context, record, 'assistant'), kind: 'message', text: block.text,
        key: valueText(record.uuid) ? `claude:message:${record.uuid}:${out.length}` : null,
      });
    } else if (block?.type === 'thinking' && valueText(block.thinking)) {
      out.push({
        ...base(context, record, 'assistant'), kind: 'reasoning', text: block.thinking,
        key: valueText(record.uuid) ? `claude:reasoning:${record.uuid}:${out.length}` : null,
      });
    } else if (block?.type === 'tool_use' && valueText(block.id)) {
      const typed = classifyToolName(block.name);
      out.push({
        ...base(context, record, 'assistant'), kind: 'tool-call',
        key: `claude:tool-call:${block.id}`,
        tool: {
          callId: block.id, name: valueText(block.name),
          category: typed.category, status: 'running',
        },
        details: details(block.input),
      });
    }
  }
  return out;
}

function codexMessageText(payload) {
  if (typeof payload?.message === 'string') return [payload.message];
  return textBlocks(payload?.content);
}

/** Convert one Codex rollout record without encrypted reasoning or tool bodies. */
export function adaptCodexTranscriptRecord(record, context = {}) {
  if (!record || typeof record !== 'object' || !valueText(context.sessionId)) return [];
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const common = (role) => base(context, record, role);
  if (record.type === 'event_msg') {
    if (['user_message', 'agent_message'].includes(payload.type)) {
      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      return codexMessageText(payload).map((text, index) => ({
        ...common(role), kind: 'message', text,
        key: valueText(payload.id) ? `codex:message:${payload.id}:${index}` : null,
      }));
    }
    // Newer Codex rollouts wrap messages in `item_completed` instead of the
    // legacy user_message/agent_message pair above — the exact generation
    // gap codex-adapter.mjs's item_completed fix addressed for the status
    // plane. decodeCodexRecord is the one place that wire shape is decoded
    // (including the newer item's Text/text content-block discriminator), so
    // this content-plane adapter reuses it rather than re-deriving the
    // UserMessage/AgentMessage dispatch locally. Its `text` is already
    // joined into one string, so this yields at most one message here where
    // the legacy branch above can yield several (one per content block) —
    // codexMessageText's block-splitting is preserved for the legacy shape,
    // which is unaffected by this addition.
    if (payload.type === 'item_completed') {
      const decoded = decodeCodexRecord(record);
      if (decoded.type !== 'message' || !decoded.text) return [];
      return [{
        ...common(decoded.role), kind: 'message', text: decoded.text,
        key: valueText(payload.id) ? `codex:message:${payload.id}:0` : null,
      }];
    }
    if (['task_started', 'task_complete', 'turn_aborted', 'context_compacted',
      'sub_agent_activity', 'patch_apply_end', 'mcp_tool_call_end',
      'web_search_end'].includes(payload.type)) {
      const evidence = {};
      for (const field of [
        'message', 'status', 'error', 'result', 'output', 'stdout', 'stderr',
        'changes', 'patch', 'query', 'url', 'call_id', 'name', 'duration_ms',
        'exit_code', 'agent_id', 'agent_name', 'activity', 'activities', 'details',
      ]) {
        if (payload[field] !== undefined) evidence[field] = payload[field];
      }
      const target = payload.type === 'sub_agent_activity' && valueText(payload.agent_id)
        ? {
            id: payload.agent_id,
            role: 'subagent',
            label: valueText(payload.agent_name),
          }
        : null;
      return [{
        ...common('system'), kind: 'status', text: payload.type.replaceAll('_', ' '),
        details: Object.keys(evidence).length ? details(evidence) : null,
        target,
        relation: target ? 'delegates' : null,
        key: valueText(payload.id) ? `codex:status:${payload.id}` : null,
      }];
    }
    return [];
  }
  if (record.type !== 'response_item') return [];
  if (payload.type === 'message' || payload.type === 'agent_message') {
    const role = payload.role === 'user' ? 'user' : 'assistant';
    return codexMessageText(payload).map((text, index) => ({
      ...common(role), kind: 'message', text,
      key: valueText(payload.id) ? `codex:message:${payload.id}:${index}` : null,
    }));
  }
  if (payload.type === 'reasoning') {
    return textBlocks(payload.summary).map((text, index) => ({
      ...common('assistant'), kind: 'reasoning', text,
      key: valueText(payload.id) ? `codex:reasoning:${payload.id}:${index}` : null,
    }));
  }
  if (['function_call', 'custom_tool_call'].includes(payload.type)) {
    const callId = valueText(payload.call_id) ?? valueText(payload.id);
    if (!callId) return [];
    const typed = classifyToolName(payload.name);
    return [{
      ...common('assistant'), kind: 'tool-call', key: `codex:tool-call:${callId}`,
      tool: {
        callId, name: valueText(payload.name), category: typed.category,
        status: valueText(payload.status) ?? 'running',
      },
      details: details(payload.arguments ?? payload.input),
    }];
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    const callId = valueText(payload.call_id) ?? valueText(payload.id);
    if (!callId) return [];
    return [{
      ...common('tool'), kind: 'tool-result', key: `codex:tool-result:${callId}`,
      tool: { callId, name: null, category: 'tool', status: 'completed' },
      details: details(payload.output ?? payload.result ?? payload.error),
    }];
  }
  return [];
}
