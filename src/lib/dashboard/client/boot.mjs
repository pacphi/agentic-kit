// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
import { renderAbout, wireAboutNudge } from './about.mjs';
import { activeTab, initialLiveScope, setSystemView, setTab, syncHash, systemView } from './bootstrap.mjs';
import { tickClock, wireIntelPicker } from './intelligence.mjs';
import { pollStatus, schedulePoll, wirePoll, wireStripCollapse } from './poll.mjs';
import { renderSystemFreshness, wireCatalogFilters, wireSystem } from './system-projects.mjs';
import { wireUsage } from './usage-orchestrators.mjs';
import { loadUsage, setUsageView } from './usage.mjs';

  window.AKDashboardSyncHash=syncHash;
  if(window.AKLive&&window.AKLive.setScope)window.AKLive.setScope(initialLiveScope,false);
  setTab(activeTab);
  setUsageView(usageView);
  setSystemView(systemView,false,true);
  // About paints its editorial content immediately, with every chip reading
  // "state unknown" until the first /api/status response supplies the join.
  renderAbout(null);
  renderSystemFreshness();
  wirePoll();
  wireUsage();
  wireIntelPicker();
  wireAboutNudge();
  wireSystem();
  wireStripCollapse();
  wireCatalogFilters();
  schedulePoll();
  lastAttempt=Date.now(); inflight=true;
  Promise.all([pollStatus()].concat(activeTab==="usage"?[loadUsage()]:[]))
    .catch(function(){}).then(function(){inflight=false; tickClock();});
  setInterval(tickClock,1000);
