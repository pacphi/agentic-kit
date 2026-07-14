/* ruflo-seg:BEGIN */
function rufloActivationSegments(cwd){
  try {
    var fs = require("fs"), path = require("path"), cp = require("child_process");
    var DIM = "[2m", G = "[1;32m", Y = "[1;33m", C = "[1;36m", R = "[0m";
    // execFileSync (no shell) — db path / sql are passed as argv, never interpolated into a command line.
    function q(db, sql){ try { return cp.execFileSync("sqlite3", [db, sql], {stdio:["ignore","pipe","ignore"], timeout:1500}).toString().trim(); } catch(e){ return ""; } }
    function bar(n, max){ n = Math.max(0, Math.min(max, n)); return "[" + "●".repeat(n) + "○".repeat(max - n) + "]"; }
    // ── self-learning (SONA): own line with a volume bar (patterns/traj/HNSW) plus a
    // LIVE micro-LoRA adaptation field (Δ‖W‖, appended further below). The Δ‖W‖ tracker
    // is maintained inline in this same function — see the "micro-LoRA LIVE adaptation"
    // block after the route-Q segment.
    var learn = "";
    try {
      var sp = path.join(cwd, ".claude-flow", "neural", "stats.json");
      if (fs.existsSync(sp)) {
        var s = JSON.parse(fs.readFileSync(sp, "utf8"));
        var pn = s.patternsLearned || 0, tj = s.trajectoriesRecorded || 0, parts = [];
        if (pn > 0 || tj > 0) {
          if (pn > 0) parts.push(pn + " patterns");
          if (tj > 0) parts.push(tj + " traj");
          if (fs.existsSync(path.join(cwd, ".swarm", "hnsw.index"))) parts.push(G + "⚡ HNSW" + R);
          var dots = Math.max(0, Math.min(5, Math.round(pn / 10)));   // volume gauge: ~10 patterns per dot
          learn = C + "🧠 SONA" + R + "  " + DIM + bar(dots, 5) + R + "  " + parts.join(DIM + " · " + R);
        }
      }
    } catch(e){}
    // ── micro-LoRA LIVE adaptation: Δ‖W‖<cum> +<session> <trend> n<count> ──
    // Shows the model ACTUALLY ADAPTING FROM YOUR WORK, live. ruflo's own micro-LoRA is
    // per-process scratch ("resets per process", intelligence.js) — every hook reinits it
    // (random A, B=0), applies that call's signals, then DISCARDS the weights; only
    // patterns.json / stats.json persist. So the kit persists what ruflo throws away: a
    // single cumulative micro-LoRA in lora-live.json, advanced HERE (inline, mtime+TTL
    // gated) by feeding each NEW distilled pattern ruflo has learned from your work
    // (.claude-flow/neural/patterns.json) through the genuine @ruvector/ruvllm 2.5.6
    // gradient path (real since F4 fixed), weighted by ruflo's OWN per-pattern confidence
    // (no fabricated reward). The init RNG is seeded and weights are restored each tick, so
    // the result is DETERMINISTIC (no 41%-CV random-init noise) and cumulative.
    //   Δ‖W‖ = ‖scaling·(A·B)‖_F  (federated-LoRA's standard adaptation-magnitude monitor)
    //   +<session> = growth since this session began (the live "from your work" signal)
    //   n = distinct patterns fed (REINFORCE updates).  Gate: cum norm > 0.
    // Honest scope: a kit-persisted MIRROR of ruflo's discarded adapter, fed ruflo's real
    // confidence-weighted patterns. NOT shown: amplification factor (no frozen base W) and
    // a live reward curve (neural-train's WASM path records trajectories, not signals → 0).
    try {
      var nd = path.join(cwd, ".claude-flow", "neural");
      var pPath = path.join(nd, "patterns.json"), sPath = path.join(nd, "lora-live.json");
      if (fs.existsSync(pPath)) {
        var st = null; try { st = JSON.parse(fs.readFileSync(sPath, "utf8")); } catch(e){}
        var nowS = Math.floor(Date.now() / 1000);
        var pMtimeMs = fs.statSync(pPath).mtimeMs;   // ms precision: same-second writes still detected
        var TTL = Number(process.env.RUFLO_LORA_TTL_S || 60);
        // Session boundary: prefer Claude Code's real session_id (piped on stdin) so the
        // +<session> delta resets exactly when YOU start a new session — not on a clock.
        // getStdinData() is the host statusline's cached single-read of that JSON; guard the
        // call so the segment still works on a template that lacks it, or run standalone.
        var sid = "";
        try { if (typeof getStdinData === "function") { var _sd = getStdinData(); sid = (_sd && (_sd.session_id || _sd.sessionId)) || ""; } } catch(e){}
        // Refresh when: no state yet, the session changed (reset the +session baseline even
        // with no new patterns), or patterns changed and the TTL has elapsed.
        var sidChanged = !!(sid && st && (st.sessionId || "") !== sid);
        var stale = !st || sidChanged || (pMtimeMs > (st.pms || 0) && (nowS - (st.ts || 0)) >= TTL);
        if (stale) {
          // Resolve the installed ruvllm SonaCoordinator (same global layout as the version probe).
          var SC = null;
          try {
            var sj = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo",
                               "node_modules", "@ruvector", "ruvllm", "dist", "cjs", "sona.js");
            if (fs.existsSync(sj)) SC = require(sj).SonaCoordinator;
          } catch(e){}
          if (SC) {
            var pats = JSON.parse(fs.readFileSync(pPath, "utf8"));
            // Seed Math.random so the first-ever loraA init is deterministic; restore after ctor.
            var seed = 0x9e3779b9, orig = Math.random;
            Math.random = function(){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
            var coord = new SC({ backgroundLoopEnabled: false });
            Math.random = orig;
            var applied = new Set((st && st.appliedIds) || []);
            var n = (st && st.n) || 0;
            if (st && st.loraA) { try { coord.microLora.setWeights({ loraA: st.loraA, loraB: st.loraB, scaling: st.scaling }); } catch(e){} }
            var prevSid = st ? (st.sessionId || "") : "";
            var newSession;
            if (sid) {
              newSession = !st || prevSid !== sid;          // real per-session boundary
            } else {
              newSession = !st || (nowS - (st.ts || 0) > 1800);  // no id (manual run): idle fallback
              sid = prevSid;                                // preserve the session we're in
            }
            var sessionBase = newSession ? (st ? (st.deltaNorm || 0) : 0) : (st.sessionBase || 0);
            var sessionTs = newSession ? nowS : (st.sessionTs || nowS);
            for (var i = 0; i < (Array.isArray(pats) ? pats.length : 0); i++) {
              var p = pats[i], id = String(p.id || i);
              if (applied.has(id)) continue;
              var conf = (typeof p.confidence === "number") ? p.confidence : Number(p.confidence);
              coord.recordSignal({ requestId: id, type: p.type || "pattern",
                                   quality: (conf >= 0 && conf <= 1) ? conf : 0.7, correction: String(p.content || id) });
              applied.add(id); n++;
            }
            var w = coord.microLora.getWeights(), nm = coord.stats().microLora.deltaNorm;
            var rec = { loraA: w.loraA, loraB: w.loraB, scaling: w.scaling, appliedIds: Array.from(applied),
                        n: n, deltaNorm: nm, sessionBase: sessionBase, sessionTs: sessionTs, sessionId: sid,
                        pms: pMtimeMs, ts: nowS };
            try { var tmp = sPath + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, sPath); } catch(e){}
            st = rec;
          }
        }
        if (st && typeof st.deltaNorm === "number" && st.deltaNorm > 0) {
          var sess = st.deltaNorm - (st.sessionBase || 0);
          var trend = "";
          if (Math.abs(sess) / st.deltaNorm < 0.005) trend = DIM + "→" + R;
          else trend = sess > 0 ? (G + "▲" + R) : (Y + "▼" + R);
          var sessStr = (Math.abs(sess) / st.deltaNorm >= 0.005)
            ? (" " + (sess > 0 ? G : Y) + (sess > 0 ? "+" : "") + sess.toFixed(4) + R) : "";
          var dseg = C + "Δ‖W‖" + st.deltaNorm.toFixed(4) + R + sessStr + trend + DIM + " n" + st.n + R;
          if (learn) { learn += DIM + " · " + R + dseg; }
          else { learn = C + "🧠 Δ LoRA" + R + "  " + dseg; }
        }
      }
    } catch(e){}
    // ── route Q-learner (📈 RL): live agent-routing metrics, fs-only, honesty-gated ──
    // F3 (ruvnet/ruflo#2239) is fixed in ruflo 3.10.11 (FNV-1a lossless fold) — the
    // state encoder no longer collapses keyword-distinct tasks, so |Q| is a
    // real task-diversity count. Source the persisted Q-model directly; never the broken
    // `route stats` CLI. Gate hard: render ONLY when the learner has actually run
    // (updateCount>0), else emit nothing — no zero-state noise.
    var route = "";
    try {
      var qp = path.join(cwd, ".swarm", "q-learning-model.json");
      if (fs.existsSync(qp)) {
        var qm = JSON.parse(fs.readFileSync(qp, "utf8"));
        var st = qm.stats || {};
        var upd = st.updateCount || 0;
        if (upd > 0) {
          var eps = typeof st.epsilon === "number" ? st.epsilon : null;
          var td = typeof st.avgTDError === "number" ? st.avgTDError : null;
          var qn = qm.qTable && typeof qm.qTable === "object" ? Object.keys(qm.qTable).length : 0;
          var rp = [];
          if (eps !== null) rp.push("ε" + eps.toFixed(2) + DIM + "↓" + R);
          if (td !== null) rp.push("δ̄" + td.toFixed(3) + DIM + "↓" + R);
          if (qn > 0) rp.push("|Q|" + qn);
          rp.push("upd" + upd);
          route = C + "📈 RL" + R + "  " + rp.join(DIM + " · " + R);
        }
      } else {
        // Fallback: ruflo's metrics surface (no broken route-stats CLI). Only when it
        // reflects real routing decisions.
        var lp = path.join(cwd, ".claude-flow", "metrics", "learning.json");
        if (fs.existsSync(lp)) {
          var lj = JSON.parse(fs.readFileSync(lp, "utf8"));
          var rt = lj.routing || {};
          if ((rt.decisions || 0) > 0) {
            var rp2 = [];
            if (typeof rt.accuracy === "number") rp2.push("acc" + Math.round(rt.accuracy * 100) + "%");
            rp2.push("dec" + rt.decisions);
            route = C + "📈 RL" + R + "  " + rp2.join(DIM + " · " + R);
          }
        }
      }
    } catch(e){}
    // ── proof verdict (self-improvement eval): ALARM-ONLY, fs-only ──
    // Sources the most recent ruflo-improvement-eval run (.claude-flow/improvement.json):
    // a pre-registered causal test (one-sided permutation p + Cohen's d + above-chance)
    // that the route Q-learner self-improves vs a no-learning ablation. It is a SYNTHETIC
    // proof-of-mechanism (its own reward env), NOT a live measure of real routing — that
    // is what the 📈 RL line above is. So PASS is the expected state and is rendered
    // SILENTLY; only a FAIL (a real regression worth a look) surfaces, as ◷ proof FAIL.
    // The run age (im.ts) is appended so a stale FAIL reads honestly. Never a fabricated
    // source. Fields per #8: Δpp · CI · p · d · age. (#8 — alarm-only per user decision.)
    var proof = "";
    try {
      var ip = path.join(cwd, ".claude-flow", "improvement.json");
      if (fs.existsSync(ip)) {
        var im = JSON.parse(fs.readFileSync(ip, "utf8"));
        if (im && im.verdict === "FAIL") {
          var pp = [];
          if (typeof im.deltaPP === "number") pp.push("Δ" + (im.deltaPP >= 0 ? "+" : "") + im.deltaPP + "pp");
          if (typeof im.ci95 === "number") pp.push("CI±" + im.ci95);
          if (typeof im.pValue === "number") pp.push("p" + (im.pValue < 0.001 ? "<.001" : "=" + im.pValue.toFixed(3)));
          if (typeof im.cohensD === "number") pp.push("d" + (im.cohensD >= 999 ? "∞" : im.cohensD));
          if (typeof im.ts === "number") {
            var ageSec = Math.floor(Date.now() / 1000) - im.ts;
            if (ageSec >= 86400) pp.push(Math.floor(ageSec / 86400) + "d ago");
            else if (ageSec >= 3600) pp.push(Math.floor(ageSec / 3600) + "h ago");
          }
          proof = Y + "◷ proof FAIL" + R + (pp.length ? "  " + DIM + pp.join(" · ") + R : "");
        }
      }
    } catch(e){}
    // ── security: 🛡 renders ONLY when @claude-flow/aidefence (the actual runtime
    // defense engine behind `security defend`) is resolvable. ruflo 3.28 dropped it
    // from the dependency tree while the command still imports it (ruvnet/ruflo#2670),
    // so a bare 3.28 install has NO working injection defense — the segment honestly
    // disappears until ruflo-resync reinstalls the package (@claude-flow/security is
    // auth/validation primitives, not detection; probing it would overstate).
    var sec = "";
    try {
      var nmBase = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "ruflo", "node_modules", "@claude-flow");
      if (fs.existsSync(path.join(nmBase, "aidefence", "package.json"))) sec = G + "🛡 aidefence on" + R;
    } catch(e){}
    // ── daemon visibility (⚙): GLOBAL count of running ruflo daemons, so no daemon
    // is ever invisible (token-burn incident lesson). Machine-global, not per-project,
    // so it is cached in tmpdir and shared across every project's statusline — one
    // pgrep per TTL window, not per render. Daemons are default-on (local-only
    // workers, budget-governed AI workers) since the 3.28 baseline, so one per active
    // project is the EXPECTED steady state: dim up to 3, YELLOW at >=4 (more daemons
    // than you're plausibly working projects — ruflo-daemon-gc to inspect; upstream
    // TTL + kit auto-reap will also converge it). Opt out: RUFLO_DAEMON_STATUSLINE=0.
    var daemon = "";
    try {
      if (process.env.RUFLO_DAEMON_STATUSLINE !== "0") {
        var os = require("os");
        var dCache = path.join(os.tmpdir(), "ruflo-daemon-count.json");
        var dTtl = Number(process.env.RUFLO_DAEMON_STATUSLINE_TTL_MS || 30000);
        var dCount = null;
        try { var dc = JSON.parse(fs.readFileSync(dCache, "utf8")); if (dc && typeof dc.n === "number" && dTtl > 0 && (Date.now() - dc.ts) < dTtl) dCount = dc.n; } catch(e){}
        if (dCount === null) {
          try {
            var pg = cp.execFileSync("pgrep", ["-f", "cli.js daemon start"], {stdio:["ignore","pipe","ignore"], timeout:1500}).toString().trim();
            dCount = pg ? pg.split("\n").filter(Boolean).length : 0;
          } catch(e){ dCount = 0; }   // pgrep exits 1 (=> throws) when nothing matches
          try { fs.writeFileSync(dCache, JSON.stringify({ts: Date.now(), n: dCount})); } catch(e){}
        }
        if (dCount > 0) {
          var dCol = dCount >= 4 ? Y : DIM;
          daemon = dCol + "⚙ " + dCount + " ruflo daemon" + (dCount === 1 ? "" : "s") + R
                 + (dCount >= 4 ? DIM + " — ruflo-daemon-gc to inspect" + R : "");
        }
      }
    } catch(e){}
    // ── agentic-qe — TTL-cached; one sqlite3 spawn only on a cache miss (issue #3) ──
    var qe = "";
    try {
      var db = path.join(cwd, ".agentic-qe", "memory.db");
      if (fs.existsSync(db)) {
        var cacheDir = path.join(cwd, ".claude-flow", "cache");
        var cacheFile = path.join(cacheDir, "qe-statusline.json");
        var ttl = Number(process.env.RUFLO_QE_STATUSLINE_TTL_MS || 60000);
        var cachedLine = null;
        try {
          var cc = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          if (cc && typeof cc.line === "string" && ttl > 0 && (Date.now() - cc.ts) < ttl) cachedLine = cc.line;
        } catch(e){}
        if (cachedLine !== null) {
          qe = cachedLine;                   // hit: zero sqlite3 spawns
        } else {
          // miss: ONE sqlite3 call. SQL on stdin + ".bail off" so a missing vector
          // table (name varies by aqe version) doesn't abort the batch. sqlite3 still
          // exits non-zero on the error, so execFileSync throws — recover e.stdout.
          var sql = ".bail off\n"
            + "SELECT 'pat',COUNT(*) FROM qe_patterns;\n"
            + "SELECT 'vec',COUNT(*) FROM qe_pattern_embeddings;\n"
            + "SELECT 'vec',COUNT(*) FROM vectors;\n"
            + "SELECT 'vec',COUNT(*) FROM embeddings;\n"
            + "SELECT 'traj',COUNT(*) FROM qe_trajectories;\n";
          var raw = "";
          try { raw = cp.execFileSync("sqlite3", [db], {input: sql, stdio:["pipe","pipe","ignore"], timeout:1500}).toString(); }
          catch(e){ raw = (e && e.stdout) ? e.stdout.toString() : ""; }
          var pat = 0, qtj = 0, qv = 0;
          raw.split("\n").forEach(function(ln){
            var i = ln.indexOf("|"); if (i < 0) return;
            var k = ln.slice(0, i), v = Number(ln.slice(i + 1)) || 0;
            if (k === "pat") pat = v; else if (k === "traj") qtj = v; else if (k === "vec" && qv === 0) qv = v;
          });
          var qp = [];
          if (pat > 0) qp.push("🎓 " + pat + " patterns");
          if (qtj > 0) qp.push("🧭 " + qtj + " traj");
          if (qv > 0) qp.push("🧬 " + qv + " vec" + G + "⚡" + R);
          try { var kb = Math.round(fs.statSync(db).size / 1024); qp.push("💾 " + (kb >= 1024 ? (kb/1024).toFixed(1) + "MB" : kb + "KB")); } catch(e){}
          // Installed agentic-qe version — shown next to the label, mirroring "RuFlo V<x>"
          // in ruflo's native header. Prefer the global install (matches the aidefence
          // probe above); fall back to a project-local node_modules copy.
          var qver = "";
          try {
            var qpkg = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "agentic-qe", "package.json");
            if (!fs.existsSync(qpkg)) qpkg = path.join(cwd, "node_modules", "agentic-qe", "package.json");
            var qv2 = JSON.parse(fs.readFileSync(qpkg, "utf8")).version;
            if (qv2) qver = " V" + qv2;
          } catch(e){}
          qe = Y + "🎓 Agentic QE" + qver + R + "  " + (qp.length ? qp.join(DIM + " · " + R) : "on");
          try { fs.mkdirSync(cacheDir, {recursive:true}); fs.writeFileSync(cacheFile, JSON.stringify({ts: Date.now(), line: qe})); } catch(e){}
        }
      }
    } catch(e){}
    // ── assemble: one ruflo feature per line (SONA, 📈 RL, ◷ proof FAIL alarm,
    // aidefence), then a divider, then the agentic-qe line. Each segment renders on its
    // OWN line so the live route metrics and the security state are individually scannable
    // and don't wrap. No rule above the SONA line — these are ruflo features and sit flush
    // under ruflo's native lines. The divider matches ruflo's native header width
    // ('─'.repeat(53) in statusline.cjs) so the two rules line up.
    var out = [];
    if (learn) out.push(learn);
    if (route) out.push(route);
    if (proof) out.push(proof);
    if (sec) out.push(sec);
    if (daemon) out.push(daemon);
    if (out.length && qe) out.push(DIM + "─".repeat(53) + R);
    if (qe) out.push(qe);
    if (!out.length) return "";
    return "\n" + out.join("\n");
  } catch(e){ return ""; }
}
/* ruflo-seg:END */
