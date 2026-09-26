// Overview → Hosts & Routing: the host participation strip (ADR-0053,
// 2026-09-26). Which hosts ak manages, and so routes work to. The client
// (client/host-readiness.mjs renderHostParticipation) fills the list from the
// host-health report and keeps the strip hidden without one, so it never
// claims participation it has not observed. Kept beside page.mjs, like
// live-view.mjs's LIVE_HTML, so the page shell stays within its size budget.
export const HOST_PARTICIPATION_HTML = `
    <section class="strip" id="host-participation" hidden>
      <div class="strip-head">
        <button class="strip-toggle" type="button" aria-expanded="true" aria-controls="host-participation-body">
          <span class="chev" aria-hidden="true">&rsaquo;</span>
          <h2 class="strip-title">host participation</h2>
        </button>
        <span class="mono strip-note" id="host-participation-note" role="status" aria-live="polite"></span>
      </div>
      <div class="strip-body" id="host-participation-body">
        <div class="note"><span class="i">&#8505;</span><span>ak routes work only to hosts it <b>manages</b>:
          its per-activity routing policy (dual-host routes, the AQE agent routes it projects, and
          <b>ak run</b> pipelines). A host that is found but not managed is still health-checked, as
          information. The AQE provider chain, qe-court configuration and Ruflo's own dual-mode skills
          are separate and may still call an installed host directly; see <b>Providers</b>.</span></div>
        <ul class="hp-list" id="host-participation-list"></ul>
      </div>
    </section>`;
