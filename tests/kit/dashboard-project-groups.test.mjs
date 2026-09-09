import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectView} from '../../src/lib/dashboard/project-groups.mjs';
const repo = {repositoryId:'/repo/.git',root:'/repo',kind:'git'};
const main = {path:'/repo',label:'repo',repository:repo,sessionOrigins:[{origin:'claude-desktop',sessions:1},{origin:'unknown',sessions:1}]};
const work = {path:'/work',label:'work',repository:{...repo,kind:'worktree'},sessionOrigins:[{origin:'codex-desktop',sessions:2}]};
test('repository and worktree share one group without counting the measured copy twice',()=>{
 const view=projectView({projects:[main],discoveryProjects:[main,work]},'all','all');
 assert.equal(view.length,1); assert.deepEqual(view[0].rows.map(r=>r.path),['/repo','/work']);
});
test('desktop origin filters intersect repository grouping and preserve unknown membership',()=>{
 assert.equal(projectView({projects:[main,work]},'measured','codex-desktop')[0].rows[0].path,'/work');
 assert.equal(projectView({projects:[main,work]},'measured','unknown')[0].rows[0].path,'/repo');
});
test('unclassified older snapshots survive unknown filtering',()=>{
 assert.equal(projectView({projects:[{path:'/old',label:'old'}]},'measured','unknown')[0].rows.length,1);
});

test('legacy rows without paths retain independent identity',()=>{
 assert.equal(projectView({projects:[{label:'first'},{label:'second'}]})[0].rows.length,2);
});
