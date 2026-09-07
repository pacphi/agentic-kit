// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.
//
// ADR-0048 retires the single-list v1 Maintenance findings workbench this
// file used to render (see git history for that implementation) in favor of
// the four-destination workspace split across maintenance-workspace.mjs and
// maintenance-{inventory,inspector,guidance,discovery,activity}.mjs. This
// file is now only the thin compatibility surface bootstrap.mjs and boot.mjs
// already call by these two names.
import { MNT, loadMaintenanceWorkspace, wireMaintenanceWorkspace } from './maintenance-workspace.mjs';
import { wireMntInventory } from './maintenance-inventory.mjs';
import { wireMntInspector } from './maintenance-inspector.mjs';
import { wireMntGuidance } from './maintenance-guidance.mjs';
import { wireMntDiscovery } from './maintenance-discovery.mjs';
import { wireMntActivity } from './maintenance-activity.mjs';
import { wireMaintActions } from './system-maintenance-actions.mjs';

  // poll.mjs's refreshAll() single-flight-guards its background maintenance
  // refresh with `!maintenanceBusy` before ever calling loadMaintenance(true)
  // — the same shape the pre-ADR-0048 single-list workbench used. Keep the
  // export alive across the ADR-0048 rewrite: true for the duration of this
  // module's own load, and mirroring MNT.providersBusy the rest of the time
  // so a background poll never fires mid-Check-providers either.
  export var maintenanceBusy=false;

  export function loadMaintenance(force){
    maintenanceBusy=true;
    return loadMaintenanceWorkspace(force).then(function(result){
      maintenanceBusy=MNT.providersBusy;
      return result;
    },function(error){
      maintenanceBusy=MNT.providersBusy;
      throw error;
    });
  }

  export function wireMaintenance(){
    wireMntInventory();
    wireMntInspector();
    wireMntGuidance();
    wireMntDiscovery();
    wireMntActivity();
    wireMaintActions();
    wireMaintenanceWorkspace();
  }
