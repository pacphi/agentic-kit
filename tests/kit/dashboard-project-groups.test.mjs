import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repositoryTree} from '../../src/lib/dashboard/project-groups.mjs';
const repo = {repositoryId:'/repo/.git',root:'/repo',kind:'git'};
const main = {path:'/repo',label:'repo',repository:repo,totalBytes:{status:'measured',value:1}};
const work = {path:'/work',label:'work',repository:{...repo,kind:'worktree'},sessionOrigins:[{origin:'codex-desktop',sessions:2}]};
const desktop={path:'/desktop',label:'g-p-opaque',repository:{kind:'unknown'}};
const agentWorktree={path:'/repo/.claude/worktrees/agent-1',label:'agent-1',repository:{kind:'unknown'}};

test('repositoryTree retains one repository parent and nests discovered worktrees beneath it',()=>{
 const tree=repositoryTree({projects:[main],discoveryProjects:[main,work,desktop,agentWorktree]});
 assert.equal(tree.repositories.length,1);
 assert.equal(tree.repositories[0].repository.path,'/repo');
 assert.deepEqual(tree.repositories[0].worktrees.map(r=>r.path),['/repo/.claude/worktrees/agent-1','/work']);
 assert.equal(tree.repositories[0].worktrees[0].totalBytes,undefined);
 assert.equal(tree.excludedDirectories,1);
});

test('repositoryTree creates an honest unmeasured parent for a verified worktree whose checkout was not scanned',()=>{
 const tree=repositoryTree({projects:[],discoveryProjects:[work]});
 assert.equal(tree.repositories.length,1);
 assert.equal(tree.repositories[0].repository.path,'/repo');
 assert.equal(tree.repositories[0].repository.loc,undefined);
 assert.equal(tree.repositories[0].worktrees[0].path,'/work');
});
