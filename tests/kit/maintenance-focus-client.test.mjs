import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
function load(name,deps,exports){
 const source=fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs',import.meta.url),'utf8').replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'').replace(/\bexport (?=(?:function|var)\b)/g,'');
 return new Function(...Object.keys(deps),source+'\nreturn {'+exports.join(',')+'};')(...Object.values(deps));
}
function focus(state){return load('maintenance-focus',{MNT:state,esc,MNT_SCOPE_LABELS:{user:'User',across:'All scopes',project:'Projects'},mntKindLabel:s=>s,mntFacetValueLabel:(_,v)=>v,mntIcon:()=>'',mntAvailableTo:()=>''},['mntFocusChoose','mntFocusBack','mntFocusCrumbs','renderMntFocusResults']);}
test('navigation turns User and resource type into explicit filters while retaining host refinements',()=>{
 const state={scope:'across',facets:{consumer:['claude']}};const api=focus(state);
 api.mntFocusChoose('scope','user');api.mntFocusChoose('kind','mcp-registration');api.mntFocusChoose('resource','res_1');
 assert.deepEqual(state,{scope:'user',facets:{consumer:['claude'],kind:['mcp-registration'],family:['res_1']}});
 assert.deepEqual(api.mntFocusCrumbs().map(c=>c.level),['root','scope','kind','family']);
 api.mntFocusBack('kind');assert.equal(state.facets.family,undefined);assert.deepEqual(state.facets.kind,['mcp-registration']);
 api.mntFocusBack('root');assert.equal(state.scope,'across');assert.deepEqual(state.facets,{consumer:['claude']});
});
test('choosing a scope preserves explicit type and resource filters and drops an inapplicable project',()=>{
 const state={scope:'project',facets:{project:['prj_1'],kind:['skill'],family:['res_1'],consumer:['codex']}};const api=focus(state);
 api.mntFocusChoose('scope','user');assert.deepEqual(state.facets,{kind:['skill'],family:['res_1'],consumer:['codex']});
});
test('navigation renders only aggregate nodes, escapes labels, and has one tab entry',()=>{
 const state={facets:{},query:{navigation:{level:'scope',nodes:[{value:'user',label:'<User>',count:4000},{value:'project',label:'Projects',count:8000}]},groups:[]}};
 const html=focus(state).renderMntFocusResults(false);
 assert.match(html,/&lt;User>/);assert.match(html,/4000 installations/);assert.doesNotMatch(html,/data-mnt-plc/);
 assert.equal((html.match(/tabindex="0"/g)||[]).length,1);
});
test('relationship links use opaque exact placements and describe evidence limitations',()=>{
 const api=load('maintenance-relationships',{esc,MNT:{scope:'user',facets:{}},mntKindLabel:s=>s,MNT_SCOPE_LABELS:{user:'User'}},['mntRenderRelationships']);
 const html=api.mntRenderRelationships({providedBy:[{placementId:'plc_1',displayName:'<plugin>',scope:'user',consumerHosts:['claude']}],consumers:[{label:'Claude',enabled:true}],dependencies:[{requirement:'node',satisfied:false}],originStatus:'recorded'});
 assert.match(html,/data-mnt-related="plc_1"/);assert.match(html,/&lt;plugin>/);assert.match(html,/Inclusion does not prove who performed/);assert.match(html,/node · Missing/);
 assert.match(html,/Recorded consumer bindings do not establish recent use/);
});
test('resource cards separate source from name and escape declared descriptions',()=>{
 const state={facets:{kind:['mcp-registration']},query:{navigation:{level:'resource',nodes:[{value:'res_1',label:'brain',installationSource:'Provided by brain',description:'<script>text</script>',descriptionSource:'Plugin manifest',count:2}]},groups:[]}};
 const html=focus(state).renderMntFocusResults(false);
 assert.match(html,/Provided by brain/);assert.match(html,/&lt;script>text&lt;\/script>/);assert.match(html,/title="Plugin manifest"/);
});
test('polyglot project cards show three labelled icons and expand the remaining languages',()=>{
 const languages=['Java','TypeScript','SQL','Python'].map((name,i)=>({id:String(i),name,icon:name.slice(0,2),evidence:'source'}));
 const state={facets:{},query:{navigation:{level:'project',nodes:[{value:'prj_1',label:'Polyglot',count:2,projectKind:'git',languages}]},groups:[]}};
 const html=focus(state).renderMntFocusResults(false);
 assert.match(html,/mnt-language-icon/);assert.match(html,/aria-hidden="true">Ja/);
 assert.match(html,/<details class="mnt-language-more"><summary>\+1 more languages/);
 assert.match(html,/Python/);assert.doesNotMatch(html,/<button[^>]*>[^]*<details[^]*<\/button>/);
});
