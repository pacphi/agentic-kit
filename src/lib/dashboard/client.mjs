import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAT, RANK, PREF, esc, catOf, groupRows, rowLine, groupCard, gridHtml, noticeHtml } from './groups.mjs';
import { directoryEntries } from './about-directory.mjs';

// client.mjs is the COLLECTOR for the dashboard's browser bundle: it reads the
// real, individually lintable modules under ./client/ (split out of what used
// to be this file's own 4,066-line template literal — 2026-08 complexity
// audit, Finding 2), strips their cross-file `import`/`export` lines (real
// only for node --check/eslint's benefit — concatenation collapses the module
// graph into one flat classic-script scope, same as the pre-split bundle
// already was), splices in the handful of Node-computed values each carries
// (see `inject` below), and concatenates them back into the exact same single
// IIFE this export has always produced. The SERVING CONTRACT is unchanged:
// page.mjs still does `import { JS } from './client.mjs'` and embeds it as
// `<script>${JS}</script>` — one HTML response, no new routes.
//
// The classification/grouping/card/notice logic lives in ./groups.mjs (pure —
// unit-testable in node without a DOM). Those exact function sources and
// JSON-serialized tables are interpolated into the served bundle, so the
// tested code and the shipped code can never drift. Tables are emitted with
// identifier keys unquoted — byte-stable with the pre-extraction bundle (the
// served-source contract tests pin those literals).
const ident = (k) => /^[A-Za-z_$][\w$]*$/.test(k);
const objLiteral = (o) => `{${Object.entries(o).map(([k, v]) => `${ident(k) ? k : JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
const CAT_JS = objLiteral(CAT);
const RANK_JS = objLiteral(RANK);
const PREF_JS = JSON.stringify(PREF);
// The About area's authored directory, serialized into the bundle rather than
// fetched: it is release-versioned editorial content, not machine state, so it
// ships with the page and needs no endpoint of its own (ADR-0026). Runtime
// facts arrive from the /api/status payload the dashboard already polls and are
// joined in the browser.
const ABOUT_JS = JSON.stringify(directoryEntries());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(HERE, 'client');

/** Read one split browser module's source and strip its cross-file `import`
 *  lines — never really resolved (nothing loads these files as real ES
 *  modules; client.mjs reads them as text), kept on disk purely so
 *  node --check/eslint can verify the actual cross-file dependency graph —
 *  and its `export ` prefixes, so the concatenated result is plain
 *  classic-script-safe JS (mirrors admin-server.mjs's stripModelImport, plus
 *  export-stripping since the dashboard bundle is a classic `<script>`, not a
 *  `<script type="module">`). */
function readSplit(name) {
  let src = fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8');
  // node --check/eslint/tsc all run on THIS source, on disk — strip only the
  // bits that exist purely for their benefit: the `@ts-nocheck` banner (these
  // files are never node-imported, so nothing in them should be typechecked
  // against node's lib) and the cross-file `import`/`export` machinery.
  src = src.replace(/^\/\/ @ts-nocheck.*\n(\/\/ .*\n)*/, '');
  // \r?\n: a CRLF checkout (git on Windows without eol pinning) must strip the
  // same lines, or a surviving `import` breaks the served classic-script bundle
  // (mirrors admin-server.mjs's stripModelImport, whose `\s*$` already tolerates \r).
  src = src.replace(/^import \{[^}]*\} from '\.\/[^']+\.mjs';\r?\n/gm, '');
  src = src.replace(/^(\s*)export (?=(function|var)\b)/gm, '$1');
  return src;
}

/** Splice a Node-computed value into a split file's source at its one
 *  declared placeholder (a plain, valid, lint-clean statement on disk — see
 *  that file's own `// PLACEHOLDER:<name>` comment). Throws if the exact
 *  placeholder text is missing, so a placeholder edited out from under this
 *  collector fails loudly instead of silently shipping a stub. */
function inject(src, placeholder, replacement) {
  if (!src.includes(placeholder)) throw new Error(`client bundle: injection point missing: ${placeholder}`);
  return src.replace(placeholder, replacement);
}

let bootstrapSrc = readSplit('bootstrap.mjs');
bootstrapSrc = inject(bootstrapSrc, "function esc(s) { return String(s); } // PLACEHOLDER:esc", esc.toString());
bootstrapSrc = inject(bootstrapSrc, 'var CAT = {}; // PLACEHOLDER:CAT_JS', `var CAT=${CAT_JS};`);
bootstrapSrc = inject(bootstrapSrc, "function catOf(s) { return CAT[s] || 'runtime'; } // PLACEHOLDER:catOf", catOf.toString());
bootstrapSrc = inject(bootstrapSrc, 'var RANK = {}; // PLACEHOLDER:RANK_JS', `var RANK=${RANK_JS};`);
bootstrapSrc = inject(bootstrapSrc, 'var PREF = []; // PLACEHOLDER:PREF_JS', `var PREF=${PREF_JS};`);
bootstrapSrc = inject(bootstrapSrc, 'function groupRows(rows) { return RANK && PREF && rows; } // PLACEHOLDER:groupRows', groupRows.toString());
bootstrapSrc = inject(bootstrapSrc, "function rowLine(r) { return String(r); } // PLACEHOLDER:rowLine", rowLine.toString());
bootstrapSrc = inject(bootstrapSrc, 'function groupCard(g) { return rowLine(g); } // PLACEHOLDER:groupCard', groupCard.toString());
bootstrapSrc = inject(bootstrapSrc, 'function gridHtml(groups) { return groupCard(groups); } // PLACEHOLDER:gridHtml', gridHtml.toString());

let overviewSrc = readSplit('overview.mjs');
overviewSrc = inject(overviewSrc, "function noticeHtml(drift) { return String(drift); } // PLACEHOLDER:noticeHtml", noticeHtml.toString());

let aboutSrc = readSplit('about.mjs');
aboutSrc = inject(aboutSrc, 'var ABOUT = []; // PLACEHOLDER:ABOUT_JS', `var ABOUT=${ABOUT_JS};`);

const intelligenceSrc = readSplit('intelligence.mjs');
const pollSrc = readSplit('poll.mjs');
const usageSrc = readSplit('usage.mjs');
const modelLifecycleSrc = readSplit('model-lifecycle.mjs');
const usageOrchestratorsSrc = readSplit('usage-orchestrators.mjs');
const systemReadoutSrc = readSplit('system-readout.mjs');
const systemProjectsSrc = readSplit('system-projects.mjs');
const bootSrc = readSplit('boot.mjs');

// Concatenation order matches the pre-split file's own top-to-bottom
// execution order exactly — hoisting makes forward references between these
// pieces safe regardless of order, but preserving the original sequence keeps
// every side-effecting statement (DOM queries, event wiring, the boot
// sequence) running in the same relative order it always has.
export const JS = `
(function(){
${bootstrapSrc}${overviewSrc}${intelligenceSrc}${pollSrc}${usageSrc}${modelLifecycleSrc}${usageOrchestratorsSrc}${aboutSrc}${systemReadoutSrc}${systemProjectsSrc}${bootSrc}})();
`;
