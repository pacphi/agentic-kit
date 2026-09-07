// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 Discovery destination (MNT-DSC-003/016/018). Automatic sources,
// exact projects, collection roots, exclusions, coverage, and scan history.
// The root/path text inputs here are the ONLY place a user types a path in
// this workspace, and they are sent only to the preview and exclusion routes
// — never echoed into a filter URL, notification, or the inventory itself.
import { esc } from './bootstrap.mjs';
import { MNT, mntAge, MNT_SOURCE_COVERAGE_LABELS, mntGet, mntPost, mntRegisterDestination } from './maintenance-workspace.mjs';

  var mntDiscoveryWired=false,mntDiscoveryBusy=false,mntDiscoveryError=null;
  var mntPreview=null,mntPendingRemoval=null,mntScanPollTimer=null;
  // A Discovery-OWN generation counter, distinct from the shared MNT.seq: the
  // recurring scan-poll chain below must survive unrelated app activity
  // (opening a placement, switching to Inventory) — those legitimately bump
  // MNT.seq constantly while a scan keeps running in the background — but
  // must still die the instant a NEWER Discovery load supersedes it, so a
  // slow /v2/scans response from an earlier generation can never clobber a
  // fresher renderMntDiscovery() with stale coverage (this is exactly the
  // "only the Ollama row" failure mode: a poll from a superseded Discovery
  // load overwriting the correct one).
  var mntDiscoveryGen=0;

  export function loadMntDiscovery(force){
    if(mntDiscoveryBusy&&!force)return Promise.resolve();
    mntDiscoveryBusy=true;mntDiscoveryError=null;renderMntDiscovery();
    // MNT.seq guards against a slow, superseded request (e.g. rapid
    // destination-switch clicks) clobbering a fresher render — the same
    // discipline mntRunInventoryQuery/mntOpenInspector already use.
    var gen=++mntDiscoveryGen;
    return mntGet("/api/maintenance/v2/discovery").then(function(data){
      if(gen!==mntDiscoveryGen)return;
      MNT.discovery=data;mntDiscoveryBusy=false;renderMntDiscovery();mntScheduleScanPoll(gen);
    }).catch(function(error){
      if(gen!==mntDiscoveryGen)return;
      mntDiscoveryBusy=false;mntDiscoveryError=error;renderMntDiscovery();
    });
  }

  function mntScanning(){
    return (MNT.discovery&&MNT.discovery.coverage||[]).some(function(c){return c.state==="scanning"||c.state==="queued";});
  }
  function mntScheduleScanPoll(gen){
    if(mntScanPollTimer)clearTimeout(mntScanPollTimer);
    if(gen!==mntDiscoveryGen)return;
    if(!mntScanning())return;
    mntScanPollTimer=setTimeout(function(){
      // GET /v2/scans -> { coverage: SourceCoverage[], progress: PROGRESS[],
      // narrative: string, forbiddenClaims[] }. `narrative` is the one
      // factual progress SENTENCE (MNT-DSC-016); `progress`, like
      // `coverage`, is a per-source ARRAY — never render either as text.
      mntGet("/api/maintenance/v2/scans").then(function(response){
        if(gen!==mntDiscoveryGen)return;
        if(MNT.discovery){
          MNT.discovery.coverage=(response&&response.coverage)||[];
          if(response&&response.narrative)MNT.discovery.narrative=response.narrative;
          renderMntCoverage();
        }
        mntScheduleScanPoll(gen);
      }).catch(function(){if(gen===mntDiscoveryGen)mntScheduleScanPoll(gen);});
    },2500);
  }

  // ── Automatic sources ────────────────────────────────────────────────────
  function renderMntAutomaticSources(){
    var el=document.getElementById("mnt-automatic-sources");if(!el)return;
    var sources=(MNT.discovery&&MNT.discovery.automaticSources)||[];
    el.innerHTML="<h3>Automatic sources</h3><ul>"+sources.map(function(source){
      return '<li><label><input type="checkbox" data-mnt-source-toggle="'+esc(source.id)+'"'
        +(source.enabled!==false?" checked":"")+"> "+esc(source.label)+"</label><p>"+esc(source.inspects)+"</p></li>";
    }).join("")+"</ul>";
  }

  // ── Exact projects / collection roots / exclusions. Discovery is the ONLY
  // read in this workspace that shows configured roots/paths — owner-only,
  // never echoed into a filter URL or the inventory itself. ──
  function renderMntSourceList(id,heading,list,emptyText){
    var el=document.getElementById(id);if(!el)return;
    if(!list||!list.length){el.innerHTML="<h3>"+esc(heading)+"</h3><p>"+esc(emptyText)+"</p>";return;}
    el.innerHTML="<h3>"+esc(heading)+"</h3><ul>"+list.map(function(entry){
      var detail=entry.maxDepth!=null?" (depth "+esc(entry.maxDepth)+(entry.includeNetwork?", network included":"")+")":"";
      return '<li><code>'+esc(entry.root)+"</code>"+detail
        +'<button type="button" class="mt-action" data-mnt-source-remove="'+esc(entry.sourceId)+'">Remove</button></li>';
    }).join("")+"</ul>";
  }
  function renderMntExclusions(){
    var el=document.getElementById("mnt-exclusions");if(!el)return;
    var list=(MNT.discovery&&MNT.discovery.exclusions)||[];
    el.innerHTML="<h3>Exclusions</h3>"
      +(list.length?"<ul>"+list.map(function(entry){
        return "<li>"+(entry.recursive?"<b>Recursive</b> ":"")+"<code>"+esc(entry.path)+"</code>"
          +'<button type="button" class="mt-action" data-mnt-exclusion-remove="'+esc(entry.exclusionId)+'">Remove</button></li>';
      }).join("")+"</ul>":"<p>No exclusions configured.</p>")
      +'<label class="sr-only" for="mnt-exclusion-path">Exclude an exact folder path</label>'
      +'<input type="text" id="mnt-exclusion-path" placeholder="Exact folder path to exclude" autocomplete="off">'
      +'<label><input type="checkbox" id="mnt-exclusion-recursive"> Recursive</label>'
      +'<button type="button" class="mt-action" id="mnt-exclusion-add">Add exclusion</button>';
  }

  // ── Add source / preview ─────────────────────────────────────────────────
  function renderMntPreview(){
    var el=document.getElementById("mnt-add-preview-body");if(!el)return;
    if(!mntPreview){el.hidden=true;el.innerHTML="";return;}
    var p=mntPreview;
    el.hidden=false;
    var estimate=p.estimate?esc(p.estimate.entries)+" entries estimated":esc(p.estimateReason||"estimate incomplete");
    el.innerHTML="<p>"+esc((p.projectsFound||[]).length)+" project"+((p.projectsFound||[]).length===1?"":"s")+" found.</p>"
      +"<p>Depth "+esc(p.depth)+" · Symlinks skipped "+esc(p.symlinksSkipped)+"</p>"
      +"<p>"+estimate+"</p>"
      +(p.boundaries&&p.boundaries.length?"<p>Boundary: "+p.boundaries.map(esc).join(", ")+"</p>":"")
      +"<p>Permissions denied: "+esc(p.permissions&&p.permissions.denied||0)+"</p>"
      +(p.valid?'<button type="button" class="mt-action primary" id="mnt-add-save" data-mnt-preview-id="'
        +esc(p.previewId)+'">Save source</button>':"<p>"+esc(p.reason||"This root cannot be added.")+"</p>");
  }
  function mntBeginPreview(){
    var input=document.getElementById("mnt-add-root");
    var kind=document.getElementById("mnt-add-kind");
    var root=input?input.value.trim():"";
    if(!root)return;
    return mntPost("/api/maintenance/v2/discovery/preview",{kind:kind?kind.value:"collection-root",root:root})
      .then(function(preview){mntPreview=preview;renderMntPreview();}).catch(function(){});
  }
  function mntSaveSource(previewId){
    return mntPost("/api/maintenance/v2/discovery/sources",{previewId:previewId,confirm:true}).then(function(){
      mntPreview=null;
      var input=document.getElementById("mnt-add-root");if(input)input.value="";
      return loadMntDiscovery(true);
    }).catch(function(){});
  }

  // ── Coverage / scan controls ─────────────────────────────────────────────
  function renderMntCoverage(){
    var el=document.getElementById("mnt-scan-progress");if(!el)return;
    var allCoverage=(MNT.discovery&&MNT.discovery.coverage)||[];
    var coverage=allCoverage.filter(function(entry){return entry.filesystem!==false;});
    // `narrative` is the one factual progress SENTENCE (MNT-DSC-016) and is
    // always present. `MNT.discovery.progress`, when present at all, is
    // optional structured per-source detail, not text — this workspace has
    // no use for it beyond what `coverage` already gives, so it stays unread.
    var narrative=(MNT.discovery&&(MNT.discovery.narrative||MNT.discovery.progress))||"";
    // Automatic sources are covered by Re-measure machine (System Full scan)
    // and carry no per-source controls; only roots the user added expose
    // Pause/Stop while running, Resume/Stop while paused, and Retry after a
    // failure. A user root starts scanning when it is saved (no "scan now").
    var userRoots={};
    ((MNT.discovery&&MNT.discovery.exactProjects)||[]).concat((MNT.discovery&&MNT.discovery.collectionRoots)||[])
      .forEach(function(entry){if(entry&&entry.sourceId)userRoots[entry.sourceId]=true;});
    el.innerHTML='<section class="mnt-scan-section"><h3>Filesystem coverage</h3>'
      +(narrative?"<p>"+esc(narrative)+"</p>":"")
      +'<table class="mnt-coverage-table"><thead><tr><th>Source</th><th>Outcome</th></tr></thead><tbody>'+coverage.map(function(entry){
        var controls="";
        var userRoot=!!userRoots[entry.sourceId];
        if(userRoot&&entry.state==="scanning"){
          controls='<button type="button" class="mt-action" data-mnt-scan-pause="'+esc(entry.sourceId)+'">Pause</button>'
            +'<button type="button" class="mt-action" data-mnt-scan-stop="'+esc(entry.sourceId)+'">Stop</button>';
        }else if(userRoot&&entry.state==="paused"){
          controls='<button type="button" class="mt-action" data-mnt-scan-resume="'+esc(entry.sourceId)+'">Resume</button>'
            +'<button type="button" class="mt-action" data-mnt-scan-stop="'+esc(entry.sourceId)+'">Stop</button>';
        }else if(userRoot&&(entry.state==="failed"||entry.state==="not-scanned")){
          controls='<button type="button" class="mt-action primary" data-mnt-scan-start="'+esc(entry.sourceId)+'">'+(entry.state==="failed"?"Retry scan":"Scan this root")+'</button>';
        }
        return '<tr><td>'+esc(entry.label)+'</td><td>'+esc(MNT_SOURCE_COVERAGE_LABELS[entry.state]||entry.state)
          +(entry.limitingReason?'<small>'+esc(entry.limitingReason)+'</small>':'')
          +(entry.lastCompletedAt?'<small>'+esc(mntAge(entry.lastCompletedAt))+'</small>':'')+' '+controls+'</td></tr>';
      }).join('')+'</tbody></table></section>'
      +'<section class="mnt-scan-section"><h3>Evidence checks</h3><p>Runtimes, package managers, Ollama, and providers are checked by Refresh evidence, separately from filesystem coverage. The toolbar reports the latest operation outcome.</p></section>'
      +'<section class="mnt-scan-section"><h3>Project coverage</h3><p>'+esc(MNT.discovery&&MNT.discovery.projectCoverageNote||'Configured project roots contribute to filesystem coverage. Machine-discovered projects appear in Inventory.')+'</p></section>';
  }
  function renderMntScanHistory(){
    var el=document.getElementById("mnt-scan-history");if(!el)return;
    var history=(MNT.discovery&&MNT.discovery.history)||[];
    if(!history.length){el.innerHTML="<h3>Scan history</h3><p>No scans have completed yet.</p>";return;}
    el.innerHTML="<h3>Scan history</h3><ul>"+history.map(function(entry){
      return '<li>'+esc(entry.label||'Source no longer configured')+' — '+esc(entry.state==='published'?'Complete':entry.state)
        +(entry.completedAt?' · '+esc(mntAge(entry.completedAt)):'')
        +(Number.isFinite(entry.visited)?' · '+entry.visited.toLocaleString()+' entries':'')+'</li>';
    }).join("")+"</ul>";
  }

  export function renderMntDiscovery(){
    if(mntDiscoveryError){
      var el=document.getElementById("mnt-automatic-sources");
      if(el)el.innerHTML="<p>Discovery could not be read.</p>";
      return;
    }
    renderMntAutomaticSources();
    renderMntSourceList("mnt-exact-projects","Exact projects",MNT.discovery&&MNT.discovery.exactProjects,"No exact projects configured.");
    renderMntSourceList("mnt-collection-roots","Collection roots",MNT.discovery&&MNT.discovery.collectionRoots,"No collection roots configured.");
    renderMntExclusions();
    renderMntPreview();
    renderMntCoverage();
    renderMntScanHistory();
  }

  // ── Stop-source preview dialog ───────────────────────────────────────────
  function mntStopDialogEl(){return document.getElementById("mnt-stop-dialog");}
  /** Summarize one configured-discovery block by counts only (never by
   *  content — MNT-PRV-004 keeps a path out of anywhere but Discovery's own
   *  root/exclusion lists, and a removal preview is not one of those). */
  function mntDescribeDiscoveryBlock(block){
    if(!block||typeof block!=="object")return "unknown configuration";
    var automatic=block.automaticSources?Object.keys(block.automaticSources).filter(function(id){return block.automaticSources[id];}).length:0;
    var exact=(block.exactProjects||[]).length;
    var roots=(block.collectionRoots||[]).length;
    var exclusions=(block.exclusions||[]).length;
    return automatic+" automatic source"+(automatic===1?"":"s")+", "+exact+" exact project"+(exact===1?"":"s")
      +", "+roots+" collection root"+(roots===1?"":"s")+", "+exclusions+" exclusion"+(exclusions===1?"":"s");
  }
  function mntOpenStopDialog(sourceId,preview,kind){
    var dialog=mntStopDialogEl();if(!dialog)return;
    mntPendingRemoval={kind:kind||"scan-stop",sourceId:sourceId};
    var title=document.getElementById("mnt-stop-title");
    var confirmBtn=document.getElementById("mnt-stop-confirm");
    var body=document.getElementById("mnt-stop-body");
    if(kind==="source-remove"){
      // { before, after }: the kit.json discovery block, compared by count
      // only — this dialog never names a path.
      if(title)title.textContent="Remove this source?";
      if(confirmBtn)confirmBtn.textContent="Remove source";
      if(body)body.innerHTML="<p>Configured sources will change from "+esc(mntDescribeDiscoveryBlock(preview&&preview.before))
        +" to "+esc(mntDescribeDiscoveryBlock(preview&&preview.after))
        +". Active resources from this source leave Inventory; bounded scan history and receipts remain.</p>";
    }else{
      // { sourceId, label, visited, completedPartitions }
      var visited=preview&&preview.visited;
      if(title)title.textContent="Stop this source?";
      if(confirmBtn)confirmBtn.textContent="Stop source";
      if(body)body.innerHTML="<p>Stopping "+esc((preview&&preview.label)||"this source")
        +(Number.isFinite(visited)?" after "+esc(visited)+" entries visited":"")
        +" removes its active resources from Inventory. Bounded scan history and receipts remain.</p>";
    }
    if(typeof dialog.showModal==="function"&&!dialog.open)dialog.showModal();
  }
  function mntCloseStopDialog(){
    var dialog=mntStopDialogEl();if(dialog&&dialog.open&&typeof dialog.close==="function")dialog.close();
    mntPendingRemoval=null;
  }

  function mntWireAddSource(){
    var preview=document.getElementById("mnt-add-preview");
    if(preview)preview.addEventListener("click",mntBeginPreview);
    var body=document.getElementById("mnt-add-preview-body");
    if(body)body.addEventListener("click",function(event){
      var save=event.target.closest?event.target.closest("#mnt-add-save"):null;
      if(save)mntSaveSource(save.getAttribute("data-mnt-preview-id"));
    });
  }
  function mntWireSourceRemoval(){
    var panel=document.getElementById("mnt-panel-discovery");
    if(!panel)return;
    panel.addEventListener("click",function(event){
      var toggle=event.target.closest?event.target.closest("[data-mnt-source-toggle]"):null;
      if(toggle){
        mntPost("/api/maintenance/v2/discovery/automatic",{
          sourceId:toggle.getAttribute("data-mnt-source-toggle"),enabled:toggle.checked,
        }).catch(function(){});
        return;
      }
      var remove=event.target.closest?event.target.closest("[data-mnt-source-remove]"):null;
      if(remove){
        var sourceId=remove.getAttribute("data-mnt-source-remove");
        mntPost("/api/maintenance/v2/discovery/sources/remove",{sourceId:sourceId,confirm:false}).then(function(response){
          mntOpenStopDialog(sourceId,response&&response.preview,"source-remove");
        }).catch(function(){});
        return;
      }
      var excAdd=event.target.closest?event.target.closest("#mnt-exclusion-add"):null;
      if(excAdd){
        var pathInput=document.getElementById("mnt-exclusion-path");
        var recursive=document.getElementById("mnt-exclusion-recursive");
        var value=pathInput?pathInput.value.trim():"";
        if(!value)return;
        mntPost("/api/maintenance/v2/discovery/exclusions",{path:value,recursive:!!(recursive&&recursive.checked)})
          .then(function(){return loadMntDiscovery(true);}).catch(function(){});
        return;
      }
      var excRemove=event.target.closest?event.target.closest("[data-mnt-exclusion-remove]"):null;
      if(excRemove){
        mntPost("/api/maintenance/v2/discovery/exclusions/remove",{exclusionId:excRemove.getAttribute("data-mnt-exclusion-remove")})
          .then(function(){return loadMntDiscovery(true);}).catch(function(){});
      }
    });
  }
  function mntWireScanControls(){
    var progress=document.getElementById("mnt-scan-progress");
    if(progress)progress.addEventListener("click",function(event){
      var start=event.target.closest?event.target.closest("[data-mnt-scan-start]"):null;
      if(start){mntPost("/api/maintenance/v2/scans",{action:"start",sourceId:start.getAttribute("data-mnt-scan-start")}).then(function(){return loadMntDiscovery(true);}).catch(function(){});return;}
      var pause=event.target.closest?event.target.closest("[data-mnt-scan-pause]"):null;
      if(pause){mntPost("/api/maintenance/v2/scans",{action:"pause",sourceId:pause.getAttribute("data-mnt-scan-pause")}).then(function(){return loadMntDiscovery(true);}).catch(function(){});return;}
      var resume=event.target.closest?event.target.closest("[data-mnt-scan-resume]"):null;
      if(resume){mntPost("/api/maintenance/v2/scans",{action:"resume",sourceId:resume.getAttribute("data-mnt-scan-resume")}).then(function(){return loadMntDiscovery(true);}).catch(function(){});return;}
      var stop=event.target.closest?event.target.closest("[data-mnt-scan-stop]"):null;
      if(stop){
        var sourceId=stop.getAttribute("data-mnt-scan-stop");
        mntPost("/api/maintenance/v2/scans",{action:"stop",sourceId:sourceId,confirm:false}).then(function(response){
          mntOpenStopDialog(sourceId,response&&response.preview);
        }).catch(function(){});
      }
    });
    var dialog=mntStopDialogEl();
    if(dialog){
      var close=document.getElementById("mnt-stop-close");
      var cancel=document.getElementById("mnt-stop-cancel");
      var confirmBtn=document.getElementById("mnt-stop-confirm");
      if(close)close.addEventListener("click",mntCloseStopDialog);
      if(cancel)cancel.addEventListener("click",mntCloseStopDialog);
      if(confirmBtn)confirmBtn.addEventListener("click",function(){
        var pending=mntPendingRemoval;
        mntCloseStopDialog();
        if(!pending)return;
        var request=pending.kind==="source-remove"
          ?mntPost("/api/maintenance/v2/discovery/sources/remove",{sourceId:pending.sourceId,confirm:true})
          :mntPost("/api/maintenance/v2/scans",{action:"stop",sourceId:pending.sourceId,confirm:true});
        request.then(function(){return loadMntDiscovery(true);}).catch(function(){});
      });
    }
  }

  export function wireMntDiscovery(){
    if(mntDiscoveryWired)return;mntDiscoveryWired=true;
    mntWireAddSource();mntWireSourceRemoval();mntWireScanControls();
  }

  // See maintenance-inventory.mjs's matching comment: registered immediately
  // so a lazy load can fire before boot.mjs's explicit wireMaintenance() runs.
  mntRegisterDestination("discovery",loadMntDiscovery,renderMntDiscovery);
