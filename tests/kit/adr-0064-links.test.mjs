import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'adr');
const NEW_ADR = '0064-project-scoped-management.md';
const SUPERSEDED = ['0008', '0015', '0017', '0058'];
const RETIRED = '0035';
const AMENDED = ['0025', '0027', '0048', '0014'];
const WITHDRAWN = ['0029', '0031'];

const adrFile = (number) => fs.readdirSync(ADR_DIR).find((name) => name.startsWith(`${number}-`));
const read = (name) => fs.readFileSync(path.join(ADR_DIR, name), 'utf8');
const header = (text) => text.split(/^## /m)[0];
const block = (head, label) => head.match(new RegExp(`^- \\*\\*${label}:\\*\\*[\\s\\S]*?(?=^- \\*\\*|$(?![\\s\\S]))`, 'm'))?.[0] ?? '';

test('ADR-0064 exists, is Accepted, and says it is not yet implemented', () => {
  assert.ok(fs.existsSync(path.join(ADR_DIR, NEW_ADR)), `${NEW_ADR} is missing`);
  const head = header(read(NEW_ADR));
  assert.match(head, /^- \*\*Status:\*\* Accepted/m);
  assert.match(head, /not yet implemented/);
});

test('ADR-0064 lists every superseded and amended ADR, and none of the withdrawn ones', () => {
  const head = header(read(NEW_ADR));
  const supersedes = block(head, 'Supersedes');
  const amends = block(head, 'Amends');
  for (const n of [RETIRED, ...SUPERSEDED]) assert.match(supersedes, new RegExp(`ADR-${n}`), `Supersedes omits ADR-${n}`);
  for (const n of AMENDED) assert.match(amends, new RegExp(`ADR-${n}`), `Amends omits ADR-${n}`);
  for (const n of WITHDRAWN) assert.doesNotMatch(supersedes + amends, new RegExp(`ADR-${n}`), `ADR-${n} is withdrawn, not superseded`);
});

test('the ADR index has a row for 0064', () => {
  const index = read('README.md');
  assert.match(index, new RegExp(`^\\| \\[0064\\]\\(${NEW_ADR}\\) \\|`, 'm'));
});

test('ADR-0035 is marked Retired in place, links to 0064, and is not archived', () => {
  const head = header(read(adrFile(RETIRED)));
  assert.match(head, /^- \*\*Status:\*\* Retired/m);
  assert.ok(head.includes(NEW_ADR), `ADR-${RETIRED} header does not link to ${NEW_ADR}`);
  assert.ok(!fs.existsSync(path.join(ADR_DIR, '..', 'archive', adrFile(RETIRED))), 'ADR-0035 must not be archived');
});

test('every superseded ADR links to 0064 and says superseded in its header', () => {
  for (const n of SUPERSEDED) {
    const head = header(read(adrFile(n)));
    assert.ok(head.includes(NEW_ADR), `ADR-${n} header does not link to ${NEW_ADR}`);
    assert.match(head, /^- \*\*Status:\*\*[^\n]*[Ss]uperseded/m, `ADR-${n} status does not say superseded`);
  }
});

test('every amended ADR links to 0064 from an Updated line', () => {
  for (const n of AMENDED) {
    const head = header(read(adrFile(n)));
    assert.match(head, new RegExp(`^- \\*\\*Updated:\\*\\* 2026-10-03[\\s\\S]*?${NEW_ADR.replace('.', '\\.')}`, 'm'), `ADR-${n} has no 2026-10-03 Updated line linking ${NEW_ADR}`);
  }
});
