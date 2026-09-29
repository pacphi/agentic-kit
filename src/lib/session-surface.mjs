// ADR-0060 vocabulary. This pure classifier uses declarations, never a folder name.
// Keep labels here so later CLI and dashboard views can share one vocabulary.
const LABELS = Object.freeze({
  unknown: 'Unknown',
  'claude-code-cli': 'Claude Code CLI',
  'claude-code-vscode': 'Claude Code for VS Code',
  'claude-desktop': 'Claude Desktop',
  cowork: 'Cowork',
  'cloud-session': 'Cloud session',
  'claude-agent-sdk': 'Claude Agent SDK',
  'claude-noninteractive': 'Non-interactive mode (claude -p)',
  'github-actions': 'GitHub Actions',
  'claude-tag': 'Claude Tag',
  'other-claude': 'Other Claude surface',
  'chatgpt-desktop-codex': 'ChatGPT desktop app · Codex',
  'chatgpt-desktop-work': 'ChatGPT desktop app · ChatGPT Work (local)',
  'codex-cli': 'Codex CLI',
  'codex-cli-exec': 'Codex CLI · non-interactive (codex exec)',
  'codex-ide': 'Codex IDE extension',
  'codex-sdk': 'Codex SDK',
  'codex-mcp': 'Codex MCP server',
  'chatgpt-work-cloud': 'ChatGPT Work (cloud)',
  'other-openai': 'Other OpenAI client',
});

const CLAUDE = new Map([
  ['cli', ['claude-code-cli', 'person']],
  ['claude-vscode', ['claude-code-vscode', 'person']],
  ['claude-desktop', ['claude-desktop', 'person']],
  ['claude-desktop-3p', ['claude-desktop', 'person']],
  ['local-agent', ['cowork', 'person']], ['local_agent', ['cowork', 'person']],
  ['remote_cowork', ['cowork', 'person']],
  ['remote', ['cloud-session', 'person']], ['remote_desktop', ['cloud-session', 'person']],
  ['remote_mobile', ['cloud-session', 'person']], ['remote_projects', ['cloud-session', 'person']],
  ['remote_trigger', ['cloud-session', 'automation']],
  ['remote_cowork_trigger', ['cloud-session', 'automation']],
  ['sdk-py', ['claude-agent-sdk', 'automation']], ['sdk-ts', ['claude-agent-sdk', 'automation']],
  ['sdk-cli', ['claude-noninteractive', 'automation']],
  ['claude-code-github-action', ['github-actions', 'automation']],
  ['claude_in_slack', ['claude-tag', 'person']],
  ['claude-in-slack', ['claude-tag', 'person']], ['claude-in-teams', ['claude-tag', 'person']],
  ['mcp', ['other-claude', 'automation']], ['ssh-remote', ['other-claude', 'person']],
]);

const CODEX = new Map([
  ['Codex Desktop', ['chatgpt-desktop-codex', 'person']],
  ['codex_work_desktop', ['chatgpt-desktop-work', 'person']],
  ['codex-tui', ['codex-cli', 'person']],
  ['codex_exec', ['codex-cli-exec', 'automation']],
  ['codex_vscode', ['codex-ide', 'person']],
  ['codex_sdk_ts', ['codex-sdk', 'automation']],
  ['codex_python_sdk', ['codex-sdk', 'automation']],
  ['codex_work_web', ['chatgpt-work-cloud', 'person']],
  ['codex_work_mobile', ['chatgpt-work-cloud', 'person']],
  ['codex_work_cca', ['chatgpt-work-cloud', 'person']],
  ['chatgpt_cca', ['chatgpt-work-cloud', 'person']],
]);
const CLAUDE_ATTRIBUTES = new Map([
  ['claude-desktop-3p', 'on 3P'], ['remote_desktop', 'started from Claude Desktop'],
  ['remote_mobile', 'started from mobile'], ['remote_projects', 'started from a project'],
  ['remote', 'started from web'],
]);
// Declared origin fields are internal enum-like tokens. Retain unfamiliar tokens
// for local detail, but drop malformed or oversized prompt-like content.
function bounded(value) {
  return typeof value === 'string' && value.length <= 80
    && (value === 'Codex Desktop' || /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value)) ? value : null;
}

function retain(rawEvidence, field, value) {
  if (value !== null) rawEvidence[field] = value;
}

export function sessionSurfaceLabel(surface) {
  return Object.hasOwn(LABELS, surface) ? LABELS[surface] : LABELS.unknown;
}

// Only provider-specific IDs recorded by this session qualify. Plain Claude
// IDs occur across hosts; an OpenAI-compatible gateway may reuse any model
// name. Never retain the raw ID here (it may contain account or route data).
// https://code.claude.com/docs/en/amazon-bedrock#pin-model-versions
// https://code.claude.com/docs/en/google-vertex-ai#pin-model-versions
export function claudeProviderFromModelId(model) {
  if (typeof model !== 'string' || model.length > 100) return null;
  if (/^(?:(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\.)?anthropic\.claude-(?:opus|sonnet|haiku)-[0-9][a-z0-9-]*(?:-v[0-9]+:[0-9]+)?$/u.test(model)) {
    return 'amazon-bedrock';
  }
  if (/^claude-(?:opus|sonnet|haiku)-[0-9][a-z0-9-]*@20[0-9]{6}$/u.test(model)) {
    return 'google-vertex-ai';
  }
  return null;
}

/** @returns {[string, string, string[]]} */
function claudeClassification(entrypoint, sessionKind) {
  if (entrypoint === null) return ['unknown', 'unknown', []];
  const [surface, defaultInitiator] = CLAUDE.get(entrypoint) ?? ['other-claude', 'unknown'];
  const initiator = ['bg', 'daemon', 'daemon-worker'].includes(sessionKind) ? 'automation' : defaultInitiator;
  const attribute = CLAUDE_ATTRIBUTES.get(entrypoint);
  return [surface, initiator, attribute ? [attribute] : []];
}

/** @returns {[string, string, string[]]} */
function codexClassification(originator, source, threadSource, rejectedThreadSource) {
  let [surface, initiator] = originator === null ? ['unknown', 'unknown']
    : CODEX.get(originator) ?? ['other-openai', 'unknown'];
  if (originator === 'codex_cli_rs' && source === 'mcp') [surface, initiator] = ['codex-mcp', 'agent'];
  if (surface === 'codex-mcp' || ['subagent', 'guardian_review', 'agent_created_thread'].includes(threadSource)) initiator = 'agent';
  else if (['codex-cli-exec', 'codex-sdk'].includes(surface) || threadSource === 'automation') initiator = 'automation';
  else if (['user', 'chatgpt_handoff'].includes(threadSource)) initiator = 'person';
  else if (threadSource !== null || rejectedThreadSource) initiator = 'unknown';
  return [surface, initiator, []];
}

/** @param {{host?:string,entrypoint?:unknown,originator?:unknown,source?:unknown,
 * threadSource?:unknown,sessionKind?:unknown,importedCopy?:boolean}} declaration */
export function classifySessionSurface(declaration = {}) {
  const { host } = declaration;
  const entrypoint = bounded(declaration.entrypoint);
  const originator = bounded(declaration.originator);
  const source = bounded(declaration.source);
  const threadSource = bounded(declaration.threadSource);
  // Absence does not contradict a known surface's default initiator. A value
  // that was declared but rejected by the bounded token parser does.
  const rejectedThreadSource = declaration.threadSource != null && threadSource === null;
  const sessionKind = bounded(declaration.sessionKind);
  const rawEvidence = {};
  let surface = 'unknown', initiator = 'unknown', attributes = [];

  if (host === 'claude') {
    retain(rawEvidence, 'entrypoint', entrypoint);
    retain(rawEvidence, 'sessionKind', sessionKind);
    [surface, initiator, attributes] = claudeClassification(entrypoint, sessionKind);
  } else if (host === 'codex') {
    retain(rawEvidence, 'originator', originator);
    retain(rawEvidence, 'source', source);
    retain(rawEvidence, 'threadSource', threadSource);
    [surface, initiator, attributes] = codexClassification(originator, source, threadSource, rejectedThreadSource);
  }
  if (declaration.importedCopy === true) initiator = 'imported-copy';
  return { surface, initiator, label: sessionSurfaceLabel(surface), rawEvidence, attributes,
    thirdPartyProvider: null };
}
