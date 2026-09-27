// agentdb — the copy Ruflo bundles, reported, never installed.
//
// agentdb ships inside Ruflo's tree (ruflo/node_modules/agentdb), CLI included,
// and Ruflo's memory bridge, MCP tools and hooks are its only writers. ak once
// installed a SECOND, standalone global `agentdb` for `ak x harvest` to drive.
// That copy was retired (decision A in docs/audits/2026-09-26-issues-237-238-239-
// verification-and-decisions.md): it could lag the
// bundled version indefinitely, ran on the WebAssembly fallback where the bundled
// copy runs native, wrote a different store (./agentdb.db), and its install ran
// on every sync while harvest stayed off by default (#237 §3). ak no longer
// installs, repins, monitors or uninstalls a standalone global; a `kit.json`
// `agentdb` key is tolerated and ignored. Native bindings for the bundled copy
// stay under the natives heal (natives.mjs `agentdbLocations`).
import fs from 'node:fs';
import path from 'node:path';
import { rufloNodeModules } from './paths.mjs';

/** The agentdb version Ruflo bundles, or null when Ruflo (or its copy) is absent. */
export function bundledVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(rufloNodeModules(), 'agentdb', 'package.json'), 'utf8'),
    ).version ?? null;
  } catch {
    return null;
  }
}
