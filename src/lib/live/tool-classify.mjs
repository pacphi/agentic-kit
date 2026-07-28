/** Classify only explicit public tool names; arguments are never inspected. */
export function classifyToolName(name) {
  if (typeof name !== 'string' || !name) return { kind: 'tool', category: null };
  const lower = name.toLowerCase();
  if (lower.startsWith('mcp__')) return { kind: 'mcp', category: name.slice(0, 96) };
  if (lower === 'skill' || lower.startsWith('skill:') || lower.startsWith('skill__')) {
    return { kind: 'skill', category: name.slice(0, 96) };
  }
  if (lower.startsWith('plugin:') || lower.startsWith('plugin__')) {
    return { kind: 'plugin', category: name.slice(0, 96) };
  }
  return { kind: 'tool', category: name.slice(0, 96) };
}
