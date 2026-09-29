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
const BEDROCK_MODEL = /^(?:(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\.)?anthropic\.claude-(?:(?:opus|sonnet|haiku|fable)-[1-9][0-9]?(?:-[1-9][0-9]?)?|[1-9][0-9]?(?:-[1-9][0-9]?)?-(?:opus|sonnet|haiku))(?:(?:-(20[0-9]{6})-v[1-9][0-9]*(?::[0-9]+)?)|(?:-v[1-9][0-9]*(?::[0-9]+)?))?$/u;
const VERTEX_MODEL = /^claude-(?:(?:opus|sonnet|haiku|fable)-[1-9][0-9]?(?:-[1-9][0-9]?)?|[1-9][0-9]?(?:-[1-9][0-9]?)?-(?:opus|sonnet|haiku))@(20[0-9]{6})$/u;

function validCalendarDate(value) {
  if (!value) return true;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function claudeProviderFromModelId(model) {
  if (typeof model !== 'string' || model.length > 100) return null;
  const bedrock = BEDROCK_MODEL.exec(model);
  if (bedrock) return validCalendarDate(bedrock[1]) ? 'amazon-bedrock' : null;
  const vertex = VERTEX_MODEL.exec(model);
  if (vertex) return validCalendarDate(vertex[1]) ? 'google-vertex-ai' : null;
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

/** Shared display table: classification remains declaration-owned. */
export const SESSION_SURFACE_LABELS = LABELS;
export const SESSION_HOST_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' });
export const SESSION_INITIATOR_LABELS = Object.freeze({ person: 'Person', automation: 'Automation', agent: 'Agent', 'imported-copy': 'Imported copy', unknown: 'Unknown' });
export const SESSION_PROVIDER_LABELS = Object.freeze({ 'amazon-bedrock': 'Amazon Bedrock', 'google-vertex-ai': 'Google Vertex AI',
  anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry', gateway: 'Custom gateway', ollama: 'Ollama', lmstudio: 'LM Studio', 'local-openai': 'Local OpenAI-compatible provider' });

/** Presentation accepts old snapshots without inventing a precise app mode. */
export function sessionPresentation(origin = {}) {
  const surface = Object.hasOwn(SESSION_SURFACE_LABELS, origin.surface) ? origin.surface
    : origin.surface == null && origin.origin === 'claude-desktop' ? 'claude-desktop' : 'unknown';
  const provider = origin.thirdPartyProviderBasis === 'assistant-model-id'
    && ['amazon-bedrock', 'google-vertex-ai'].includes(origin.thirdPartyProvider)
    ? SESSION_PROVIDER_LABELS[origin.thirdPartyProvider] : 'Unknown';
  return { surface, label: SESSION_SURFACE_LABELS[surface],
    initiator: Object.hasOwn(SESSION_INITIATOR_LABELS, origin.initiator) ? SESSION_INITIATOR_LABELS[origin.initiator] : 'Unknown', provider,
    providerBasis: provider === 'Unknown' ? 'not established' : 'assistant-model-id; not network attestation',
    note: !origin.surface && origin.origin === 'codex-desktop'
      ? 'ChatGPT desktop app observed; mode not recorded in this legacy snapshot'
      : !origin.surface && origin.origin === 'claude-desktop' ? 'Claude Desktop observed in this legacy snapshot' : '',
  };
}


/** A recorded provider ID is source evidence, not network attestation. */
export function sessionProviderPresentation(session = {}) {
  const surface = sessionPresentation(session.sessionOrigin ?? {});
  if (surface.provider !== 'Unknown') return { label: surface.provider, basis: surface.providerBasis };
  const provider = typeof session.provider === 'string' ? session.provider.toLowerCase() : '';
  return session.providerProvenance === 'observed' && Object.hasOwn(SESSION_PROVIDER_LABELS, provider)
    ? { label: SESSION_PROVIDER_LABELS[provider], basis: 'recorded provider ID; not network attestation' }
    : { label: 'Unknown', basis: 'not established' };
}
