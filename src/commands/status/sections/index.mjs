// The ordered registries `collect()` walks. Each section exports
// `{ id, collect: async (ctx) => Row[] }` — ctx is `{ cfg, cwd, pkgRoot,
// integrationFacts }`. Splitting collect() into two registries (rather than
// one) only reflects that two calls in between (renderHostDetailRows,
// admittedLifecycleFallbackRows) already have their own bespoke signatures
// and error contracts and are called directly by collect() instead of going
// through this generic dispatch.
import models from './models.mjs';
import codexContext from './codex-context.mjs';
import context from './context.mjs';
import versions from './versions.mjs';
import ruvnetBrain from './ruvnet-brain.mjs';
import ruvector from './ruvector.mjs';
import rufloComponents from './ruflo-components.mjs';
import self from './self.mjs';
import natives from './natives.mjs';
import memoryPin from './memory-pin.mjs';
import projectMemory from './project-memory.mjs';
import userMemory from './user-memory.mjs';
import scaffoldAgents from './scaffold-agents.mjs';
import npx from './npx.mjs';
import security from './security.mjs';
import learning from './learning.mjs';
import aqe from './aqe.mjs';
import agentBrowser from './agent-browser.mjs';
import mcp from './mcp.mjs';
import codexMcp from './codex-mcp.mjs';
import codexPlugins from './codex-plugins.mjs';
import hostAlignment from './host-alignment.mjs';

import hosts from './hosts.mjs';
import providersStatus from './providers-status.mjs';
import providersRufloModels from './providers-ruflo-models.mjs';
import providersLocalBindings from './providers-local-bindings.mjs';
import routing from './routing.mjs';
import daemons from './daemons.mjs';
import blocks from './blocks.mjs';
import statusline from './statusline.mjs';
import qeCourt from './qe-court.mjs';
import liveChecks from './live-checks.mjs';

// Everything up to and including codex-plugins — before the host-detail /
// admitted-lifecycle calls that collect() makes directly.
export const SECTIONS_BEFORE_HOST_DETAIL = [
  models, versions, ruvnetBrain, ruvector, rufloComponents, self, natives, memoryPin,
  projectMemory, userMemory, scaffoldAgents, npx, security, learning, aqe, agentBrowser, mcp,
  codexMcp, codexPlugins, hostAlignment,
];

// Everything from `hosts` onward — after those direct calls.
export const SECTIONS_AFTER_HOST_DETAIL = [
  hosts, providersStatus,
  providersRufloModels, providersLocalBindings, routing, daemons, blocks,
  statusline, codexContext, context, qeCourt, liveChecks,
];
