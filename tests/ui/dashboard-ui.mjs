#!/usr/bin/env node
//
// dashboard-ui.mjs — end-to-end VISUAL verification of the dashboard.
//
// The unit and route suites prove the server returns correct JSON and that the
// served HTML contains the right element ids. Neither proves the page RENDERS
// that data correctly, and every bug that reached the browser during the
// usage-scorecard build was of exactly that kind:
//
//   · projectTree[].categories was an array, the renderer did Object.keys() on
//     it, and every project chip read "0 [object Object]"
//   · byProject[].minutes was never emitted, so every project row read "0m"
//   · byCategory[].confidence was never emitted, so every category read "0.00"
//   · readSession().meta had no cost, so every transcript header read "$0.00"
//
// All four passed their own tests. None is visible without rendering the page.
// Hence the central assertion here: **no rendering artifact may appear in
// visible text** — `undefined`, `NaN`, `[object Object]`, `Invalid Date`, a
// bare `null`. That single net catches this whole class.
//
// Drives the SYSTEM Chrome (playwright `channel: 'chrome'`) so nothing is
// downloaded; CI runners ship Chrome already.
//
//   node tests/ui/dashboard-ui.mjs            # deterministic fixture corpus
//   node tests/ui/dashboard-ui.mjs --real     # YOUR live transcripts
//   node tests/ui/dashboard-ui.mjs --headed   # watch it drive
//
// Screenshots land in .ui-artifacts/ (gitignored) for human review.
// Exit 0 = pass.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { readIndex, readSession, maskSecrets } from '../../src/lib/usage-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHOTS = path.join(ROOT, '.ui-artifacts');

const REAL = process.argv.includes('--real');
const HEADED = process.argv.includes('--headed');

let passed = 0;
const failures = [];
const ok = (name) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, why) => { failures.push({ name, why }); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

// ── the artifact net ─────────────────────────────────────────────────────────
// Deliberately matched against VISIBLE text (innerText), not HTML: an id or a
// data-attribute may legitimately contain these tokens, but a human must never
// read them. `$0.00`/`0m` are NOT here — zero is a legitimate value; those get
// targeted assertions below instead, where we know a non-zero was expected.
const ARTIFACTS = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\[object [A-Z]\w+\]/,
  /\bInvalid Date\b/,
  /\$NaN/,
  /\bnull\b/,
];

async function visibleText(page, selector) {
  return page.$eval(selector, (el) => el.innerText).catch(() => '');
}

function artifactsIn(text) {
  return ARTIFACTS.filter((re) => re.test(text)).map((re) => String(re));
}

async function shoot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// ── views under test ─────────────────────────────────────────────────────────
const TABS = [
  ['overview', '#panel-overview'],
  ['hosts', '#panel-hosts'],
  ['providers', '#panel-providers'],
  ['runtime', '#panel-runtime'],
  ['intel', '#panel-intel'],
  ['usage', '#panel-usage'],
];
const USAGE_VIEWS = [
  ['score', '#v-score'],
  ['findings', '#v-findings'],
  ['sessions', '#v-sessions'],
  ['transcript', '#v-transcript'],
];

async function main() {
  // The usage API is injected rather than reaching for the real stores, so the
  // default run is deterministic AND cannot touch the user's live index cache.
  const roots = REAL ? undefined : {
    claude: path.join(ROOT, 'tests', 'fixtures', 'usage', 'claude'),
    codex: path.join(ROOT, 'tests', 'fixtures', 'usage', 'codex'),
  };
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ui-')), 'usage-index.json');
  const usage = {
    readIndex: (o = {}) => readIndex({ ...o, ...(roots ? { roots } : {}), cachePath }),
    readSession: (id, o = {}) => readSession(id, { ...o, ...(roots ? { roots } : {}), cachePath }),
    maskSecrets,
  };
  console.log(`\ncorpus: ${REAL ? 'REAL (~/.claude, ~/.codex)' : 'fixtures (deterministic)'}`);
  console.log(`cache : ${cachePath} (temp — your real index is untouched)\n`);

  const srv = await startDashboard({
    port: 0,
    // Status is stubbed so the panel never shells out or hits the network; the
    // point of this harness is the RENDERING, not the status collector.
    fetchStatus: async () => ({
      overall: 'warn',
      rows: [
        { subsystem: 'versions', level: 'ok', message: 'ruflo 4.0.0 (latest)', fix: null },
        { subsystem: 'natives', level: 'fail', message: 'WASM fallback', fix: 'ak sync' },
        { subsystem: 'learning', level: 'warn', message: 'no patterns yet', fix: null },
      ],
      drift: [],
    }),
    usage,
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Anything the page logs as an error, or any request it fails, is a defect —
  // collected globally so a failure in one view is not silently swallowed.
  const consoleErrors = [];
  const failedRequests = [];
  // Capture the LOCATION too. A bare "Failed to load resource" is
  // undiagnosable, and a console listener that records only the message makes
  // the harness's own failures impossible to act on.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    const where = loc?.url ? ` @ ${loc.url}` : '';
    consoleErrors.push(`${m.text()}${where}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));

  try {
    await page.goto(srv.url, { waitUntil: 'networkidle' });

    // ── every top-level tab renders, is non-empty, and is artifact-free ──
    for (const [tab, sel] of TABS) {
      await page.click(`[data-tab="${tab}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      if (tab === 'usage') await page.waitForTimeout(1200); // lazy fetch
      const text = await visibleText(page, sel);
      await shoot(page, `tab-${tab}`);

      check(`tab "${tab}" renders non-empty`, text.trim().length > 20,
        `panel had ${text.trim().length} chars of visible text`);
      const arts = artifactsIn(text);
      check(`tab "${tab}" is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} in visible text`);
    }

    // ── every Usage sub-view ──
    await page.click('[data-tab="usage"]');
    await page.waitForTimeout(800);
    for (const [view, sel] of USAGE_VIEWS) {
      await page.click(`[data-view="${view}"]`).catch(() => {});
      await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const text = await visibleText(page, sel);
      await shoot(page, `usage-${view}`);

      check(`usage/${view} renders`, text.trim().length > 10, 'view was effectively empty');
      const arts = artifactsIn(text);
      check(`usage/${view} is free of rendering artifacts`, arts.length === 0,
        `found ${arts.join(', ')} — this is the class of bug unit tests cannot see`);
    }

    // ── the specific zeros that were silently wrong ──
    await page.click('[data-view="sessions"]');
    await page.waitForTimeout(600);
    const treeText = await visibleText(page, '#u-tree');
    check('project rows show a real duration, not "0m" for every project',
      !/^\s*0m\s*$/m.test(treeText) || !/\d+\s*sess/.test(treeText),
      'every project row read 0m — byProject[].minutes is not reaching the renderer');

    // groups must start COLLAPSED
    const openGroups = await page.$$eval('.pgroup[data-open]', (n) => n.length).catch(() => 0);
    check('project groups start collapsed', openGroups === 0,
      `${openGroups} group(s) auto-expanded`);

    // expand one and confirm sessions appear
    const firstHead = await page.$('.phead');
    if (firstHead) {
      await firstHead.click();
      await page.waitForTimeout(400);
      const rows = await page.$$eval('.pgroup[data-open] .srow', (n) => n.length).catch(() => 0);
      check('expanding a project reveals its sessions', rows > 0, 'no .srow appeared after expand');
      await shoot(page, 'usage-sessions-expanded');
    }

    // ── scroll containment: each list scrolls in place, footer stays reachable ──
    for (const [label, sel] of [['findings', '#u-insights'], ['transcript', '#u-turns']]) {
      // The callback below is serialised and executed in the BROWSER, not here,
      // so `getComputedStyle` is legitimately in scope there. Declared for
      // eslint, which lints this file as Node and cannot see the boundary.
      /* global getComputedStyle */
      const box = await page.$eval(sel, (el) => ({
        max: getComputedStyle(el).maxHeight,
        overflow: getComputedStyle(el).overflowY,
        contain: getComputedStyle(el).overscrollBehaviorY,
      })).catch(() => null);
      check(`${label} scrolls in place, not the window`,
        !!box && box.overflow === 'auto' && box.max !== 'none',
        `computed style was ${JSON.stringify(box)}`);
      check(`${label} contains its overscroll`, !!box && box.contain === 'contain',
        `overscroll-behavior-y was ${box?.contain}`);
    }

    // ── the poll control actually governs polling ──
    const pollDefault = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ak-dash-poll') || '{}'); } catch { return {}; }
    });
    check('poll control persists a 30s default', (pollDefault.intervalMs ?? 30000) === 30000,
      `persisted intervalMs was ${pollDefault.intervalMs}`);

    // ── theme toggle survives a round trip ──
    const before = await page.getAttribute('html', 'data-theme');
    await page.click('#theme-toggle').catch(() => {});
    await page.waitForTimeout(250);
    const after = await page.getAttribute('html', 'data-theme');
    check('theme toggle flips the theme', before !== after, `stayed on ${before}`);
    await shoot(page, 'theme-light');
    await page.click('#theme-toggle').catch(() => {});

    // ── nothing errored anywhere along the way ──
    // A 404 from /api/session/<id> is CORRECT behaviour for a session that does
    // not exist — the route was changed to stop answering 200-with-a-null-body.
    // Everything else is a defect.
    const realErrors = consoleErrors.filter((e) => !/\/api\/session\//.test(e));
    check('no console errors across the whole run', realErrors.length === 0,
      realErrors.slice(0, 3).join(' | '));
    if (realErrors.length !== consoleErrors.length) {
      console.log(`      (ignored ${consoleErrors.length - realErrors.length} expected /api/session 404s)`);
    }
    check('no failed network requests', failedRequests.length === 0,
      failedRequests.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await srv.close();
  }

  console.log(`\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failures.length} failed\x1b[0m`);
  console.log(`screenshots: ${path.relative(ROOT, SHOTS)}/\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
