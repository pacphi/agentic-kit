// opencode.mjs — the third host adapter's I/O half (public entry point).
//
// why: opencode (opencode.ai) consumes the same rUv stack as claude/codex but
// through different surfaces. This module family owns every ak-managed byte
// on those surfaces, backup-first + merge-not-clobber + ownership-marked,
// mirroring the claude (settings.mjs / mcp.mjs) and codex (providers.mjs
// Ruflo integration) contracts:
//
//   ~/.config/opencode/opencode.json   mcp.claude-flow + mcp.agentic-qe +
//                                      mcp.ruvnet-brain,
//                                      skills.paths, permission patterns
//   ~/.config/opencode/AGENTS.md       guidance blocks (blocks.mjs target
//                                      'agents-opencode' — NOT here)
//   ~/.config/opencode/plugins/ruflo-hooks.js   lifecycle bridge (opencode has
//                                      no settings-hooks surface; its plugin
//                                      events are the hook spine)
//   ~/.config/opencode/plugins/ruflo-gateway.js lazy bridges to the complete
//                                      live Ruflo and Agentic QE catalogues
//   ~/.config/opencode/agents/ak-specialist.md
//                                      one stock subagent; receipt-owned rUv
//                                      profiles stay embedded and load lazily
//   ~/.config/opencode/skills/ruflo/   the platform SKILL.md
//
// This file is the STABLE PUBLIC ENTRY POINT every consumer already imports
// ('./opencode.mjs' / '../lib/opencode.mjs' / etc.) — it re-exports the
// public surface of four implementation modules (ADR-0037's file-size gate
// split this file, which had grown past 1,700 lines, along its natural
// seams):
//
//   opencode-core.mjs       config-wiring: applyOpencode/undoOpencode,
//                           opencodeConverged/opencodeMcpStatus, the receipt
//                           ledger (opencodeArtifactReceiptState), mcp entry
//                           resolution (mcpEntriesFor).
//   opencode-agents.mjs     ruflo catalog resolution (catalogSource,
//                           skillPathsFor) + the Claude Code agent .md →
//                           OpenCode subagent .md conversion/sync/status
//                           pipeline (convertAgents/syncAgents/agentsStatus).
//   opencode-artifacts.mjs  the plugin (lifecycle bridge + lazy rUv gateway)
//                           and platform-skill deployment/status, plus the
//                           shared teardown (removeArtifacts).
//   opencode-lifecycle.mjs  the shared enable/retire stack composition
//                           (opencodeStack/retireOpencode) and the ADR-0016
//                           lifecycle adapter (createOpencodeLifecycleAdapter).
//
// Grounded:
//   - opencode.json schema (https://opencode.ai/config.json): mcp local
//     servers {type,command[],environment,enabled,timeout}, skills.paths[],
//     permission as wildcard tool-name patterns (MCP tools surface as
//     `<server>_<tool>`, hence the claude-flow_*/agentic-qe_*/ruvnet-brain_* patterns).
//   - ruflo's own init/mcp-generator.ts env block (CLAUDE_FLOW_* in
//     opencode-core.mjs).
//   - `claude-flow-mcp` (the dedicated stdio bin of @claude-flow/cli) answers
//     initialize directly; `ruflo mcp start` is the fallback (what ak already
//     registers for claude/codex) when that bin is absent.
//   - ruvnet-brain's stable-spine shim (~/.claude/ruvnet-brain/mcp/server.mjs)
//     hot-swaps brain versions — the registration never needs rewriting.
//   - opencode.json may legally contain JSONC comments ($schema allowComments):
//     a file we cannot parse is REFUSED, never clobbered.
export {
  RUFLO_MCP_ENV, AQE_MCP_ENV, brainShimPath, nestedMcpServerPath, mcpCommandFor, mcpEntriesFor,
  opencodeMcpStatus, opencodeConverged, opencodeArtifactReceiptState, managedGatewayMcp,
  applyOpencode, undoOpencode,
} from './opencode-core.mjs';
export {
  catalogSource, skillPathsFor, rewriteAgentGatewayReferences, convertAgents, syncAgents, agentsStatus,
} from './opencode-agents.mjs';
export {
  PLUGIN_NAME, GATEWAY_PLUGIN_NAME, deployPlugin, deployGatewayPlugin, retireGatewayPlugin,
  pluginStatus, gatewayPluginStatus, deploySkill, skillStatus, removeArtifacts,
} from './opencode-artifacts.mjs';
export {
  opencodeStack, retireOpencode, createOpencodeLifecycleAdapter, OPENCODE_LIFECYCLE_ADAPTER,
  reconcileOpencodeGuidance,
} from './opencode-lifecycle.mjs';
