import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANGUAGE_BASELINE, LANGUAGE_ARTIFACTS } from '../../src/lib/footprint/language-coverage.mjs';
import { stackEntryById } from '../../src/lib/footprint/stack-registry.mjs';
import { projectLanguages } from '../../src/lib/maintenance/management/project-languages.mjs';
import { detectStack } from '../../src/lib/footprint/stack-detect.mjs';
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'ak-language-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
test('each of the 50 ranked entries has detection evidence and an icon; Caml shares one family', t => {
  const root=fixture(t);
  assert.equal(LANGUAGE_BASELINE.length,50);
  for (const row of LANGUAGE_BASELINE) {
    const entry=stackEntryById(row.id); assert.ok(entry,row.name); assert.ok(row.icon);
    const ext=entry.match.extensions[0] ?? Object.keys(LANGUAGE_ARTIFACTS).find(ext=>LANGUAGE_ARTIFACTS[ext]===row.id);
    if(ext)fs.writeFileSync(path.join(root,row.id+ext),row.id==='perl'?'use strict;\n':row.id==='d'?'module example;\n':row.id==='objective-c'?'@interface Example\n':'example\n');
  }
  fs.writeFileSync(path.join(root,'dynamics.xml'),'<AxClass><Source>class Example {}</Source></AxClass>');
  fs.writeFileSync(path.join(root,'plc.xml'),'<project xmlns="http://www.plcopen.org/xml/tc6_0201"><body><LD/></body></project>');
  const scan=detectStack(root);
  const detected=new Set([...scan.languages,...scan.languagePresence].map(row=>row.id));
  for(const row of LANGUAGE_BASELINE)assert.ok(detected.has(row.id),row.name);
  assert.ok(scan.languagePresence.every(row=>!Object.hasOwn(row,'lines')));
});
test('ambiguous suffixes require evidence and artifact formats never get fake source lines',t=>{
  const root=fixture(t);
  fs.writeFileSync(path.join(root,'unknown.m'),'x = 1;\n');
  fs.writeFileSync(path.join(root,'unknown.pl'),'example\n');
  fs.writeFileSync(path.join(root,'generated.d'),'main.o: main.c\n');
  fs.writeFileSync(path.join(root,'playlist.pls'),'[playlist]\nFile1=music.mp3\n');
  fs.writeFileSync(path.join(root,'geography.gml'),'<gml:FeatureCollection/>');
  fs.writeFileSync(path.join(root,'script.ld'),'SECTIONS {}\n');
  fs.writeFileSync(path.join(root,'model.m'),'function result = model(x)\nresult=x;\nend\n');
  fs.writeFileSync(path.join(root,'knowledge.pl'),':- module(example, []).\n');
  fs.writeFileSync(path.join(root,'project.sb3'),Buffer.from([0,1,2]));
  const scan=detectStack(root);
  assert.deepEqual(scan.languages.map(row=>row.id).sort(),['matlab','prolog']);
  assert.deepEqual(scan.languagePresence.map(row=>row.id),['scratch']);
  assert.ok(scan.unrecognized.extensions.some(row=>row.ext==='.m'));
});

test('project language badges retain stronger source evidence over container presence', () => {
 const rows=projectLanguages({loc:{languages:[{id:'matlab',name:'MATLAB'}]},stack:{languagePresence:[{id:'matlab',name:'MATLAB',evidence:'artifact'}]}});
 assert.equal(rows.length,1);assert.equal(rows[0].evidence,'source');
});

test('every registry language survives the full inventory privacy boundary, including slash labels', async () => {
 const { stackEntries } = await import('../../src/lib/footprint/stack-registry.mjs');
 const { assertManagementInventory } = await import('../../src/lib/maintenance/management/model.mjs');
 const { baseInventory } = await import('../fixtures/maintenance/management-fixtures.mjs');
 const inventory=structuredClone(baseInventory());
 inventory.placements[0].projectLanguages=projectLanguages({loc:{languages:stackEntries('language')}});
 assert.doesNotThrow(()=>assertManagementInventory(inventory));
 assert.ok(inventory.placements[0].projectLanguages.some(row=>row.id==='hcl'));
});
test('language presentation does not forward cached names or unknown identifiers', () => {
 const rows=projectLanguages({loc:{languages:[{id:'hcl',name:'/private/project'},{id:'../../private',name:'untrusted'}]}});
 assert.deepEqual(rows.map(row=>[row.id,row.name]),[['hcl','HCL · Terraform']]);
});
