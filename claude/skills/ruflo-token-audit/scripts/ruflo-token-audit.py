#!/usr/bin/env python3
"""ruflo-token-audit — a comprehensive picture of your Claude Code usage.

Walks the local Claude Code session transcripts (~/.claude/projects/**/*.jsonl) —
which record per-message token usage, tool calls, and metadata — and produces a
full usage report over the last N days. NOT limited to "tokens ruflo burns": it
covers ALL Claude Code activity (interactive, subagents, hooks, MCP, web tools)
and distinguishes interactive work from runaway automation.

Sections:
  - Token totals + cost-weighted Opus-equivalent reference + cache efficiency
  - By day / by model / by project
  - Sessions per day, session-size distribution, busiest individual sessions
  - Per-session startup context tax
  - TOOL USAGE — which tools you actually invoke (Bash, Edit, Read, Task, …)
  - MCP USAGE — calls grouped by MCP server (mcp__<server>__<tool>)
  - SUBAGENT FAN-OUT — Task spawns + sidechain token share
  - WEB TOOLS — server-side web_search / web_fetch request counts
  - ACTIVITY BY HOUR — when you (or automation) are active
  - DAEMON CROSS-REFERENCE — running `ruflo daemon start` vs top-burn projects

Stdlib only; reads local transcripts and `ps`. No network. The cost weight is an
Opus-equivalent *reference* to compare line items — NOT your actual plan billing.

Usage:
  ruflo-token-audit                 # last 7 days, human report
  ruflo-token-audit --days 30       # widen the window
  ruflo-token-audit --json          # machine-readable (dashboards/CI)
  ruflo-token-audit --top 20        # show more projects/sessions/tools
  ruflo-token-audit --no-daemons    # skip the `ps` daemon cross-reference
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os
import subprocess
import sys

# Opus-equivalent reference pricing per 1M tokens (USD) — to weight line items
# against each other, NOT to estimate plan billing.
PRICE = {
    "opus":   {"in": 15.0, "out": 75.0, "cw5": 18.75, "cw1h": 30.0, "cr": 1.5},
    "sonnet": {"in": 3.0,  "out": 15.0, "cw5": 3.75,  "cw1h": 6.0,  "cr": 0.30},
    "haiku":  {"in": 1.0,  "out": 5.0,  "cw5": 1.25,  "cw1h": 2.0,  "cr": 0.10},
}


def family(model):
    if not model:
        return "other"
    m = model.lower()
    if "opus" in m or "fable" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    return "other"


def fmt(n):
    n = int(n)
    if n >= 1_000_000:
        return f"{n / 1e6:.1f}M"
    if n >= 1_000:
        return f"{n / 1e3:.0f}K"
    return str(n)


def project_label(path):
    base = os.path.basename(path)
    if "Development-active-" in base:
        return base.split("Development-active-")[-1][:42]
    return base[:42]


def session_label(jf):
    """A readable 'project / short-session-id' label for a transcript path."""
    proj = project_label(os.path.dirname(jf))
    sid = os.path.basename(jf).replace(".jsonl", "")[:8]
    return f"{proj}/{sid}"


def collect(root, days):
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(days=days)

    by_day = collections.defaultdict(collections.Counter)
    by_model = collections.defaultdict(collections.Counter)
    by_proj = collections.defaultdict(collections.Counter)
    by_proj_cost = collections.Counter()
    by_day_cost = collections.Counter()
    totals = collections.Counter()
    sess_day = collections.defaultdict(set)
    sess_proj = collections.defaultdict(set)
    sess_tokens = collections.Counter()
    startup_tax = []
    tools = collections.Counter()           # tool name -> call count
    mcp = collections.Counter()             # mcp server -> call count
    by_hour = collections.Counter()         # local hour -> assistant msgs
    web = collections.Counter()             # web_search / web_fetch counts
    subagent_tokens = 0                      # tokens on sidechain (subagent) messages
    subagent_spawns = 0                      # Task/Agent tool_use blocks
    total_cost = 0.0
    msg_count = 0
    active_sessions = set()

    for pdir in glob.glob(os.path.join(root, "*")):
        if not os.path.isdir(pdir):
            continue
        proj = project_label(pdir)
        for jf in glob.glob(os.path.join(pdir, "*.jsonl")):
            try:
                with open(jf, "r", errors="ignore") as fh:
                    seen_first = False
                    for line in fh:
                        if '"usage"' not in line:
                            continue
                        try:
                            d = json.loads(line)
                        except (ValueError, json.JSONDecodeError):
                            continue
                        if d.get("type") != "assistant":
                            continue
                        ts = d.get("timestamp")
                        if not ts:
                            continue
                        try:
                            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        except ValueError:
                            continue
                        if t < cutoff:
                            continue
                        msg = d.get("message", {}) or {}
                        u = msg.get("usage") or {}
                        if not u:
                            continue
                        fam = family(msg.get("model"))
                        inp = u.get("input_tokens", 0) or 0
                        out = u.get("output_tokens", 0) or 0
                        cr = u.get("cache_read_input_tokens", 0) or 0
                        cc = u.get("cache_creation_input_tokens", 0) or 0
                        creation = u.get("cache_creation") or {}
                        cw5 = creation.get("ephemeral_5m_input_tokens", 0) or 0
                        cw1h = creation.get("ephemeral_1h_input_tokens", 0) or 0
                        local = t.astimezone()
                        day = local.strftime("%Y-%m-%d")
                        p = PRICE.get(fam, PRICE["opus"])
                        cost = (inp * p["in"] + out * p["out"] + cr * p["cr"]
                                + cw5 * p["cw5"] + cw1h * p["cw1h"]) / 1e6
                        if cw5 == 0 and cw1h == 0 and cc > 0:
                            cost += cc * p["cw5"] / 1e6
                        tot = inp + out + cr + cc
                        for bucket in (by_day[day], by_model[fam], by_proj[proj]):
                            bucket["in"] += inp
                            bucket["out"] += out
                            bucket["cr"] += cr
                            bucket["cw"] += cc
                            bucket["total"] += tot
                        totals["in"] += inp
                        totals["out"] += out
                        totals["cr"] += cr
                        totals["cw"] += cc
                        totals["total"] += tot
                        by_proj_cost[proj] += cost
                        by_day_cost[day] += cost
                        total_cost += cost
                        msg_count += 1
                        active_sessions.add(jf)
                        sess_day[day].add(jf)
                        sess_proj[proj].add(jf)
                        sess_tokens[jf] += tot
                        by_hour[local.hour] += 1
                        if not seen_first:
                            seen_first = True
                            startup_tax.append(cr + cc + inp)
                        if d.get("isSidechain"):
                            subagent_tokens += tot
                        # server-side web tools (billed separately)
                        stu = u.get("server_tool_use") or {}
                        web["search"] += stu.get("web_search_requests", 0) or 0
                        web["fetch"] += stu.get("web_fetch_requests", 0) or 0
                        # tool calls in this assistant message
                        content = msg.get("content")
                        if isinstance(content, list):
                            for block in content:
                                if not isinstance(block, dict) or block.get("type") != "tool_use":
                                    continue
                                name = block.get("name") or "?"
                                tools[name] += 1
                                if name.startswith("mcp__"):
                                    parts = name.split("__")
                                    mcp[parts[1] if len(parts) > 1 else name] += 1
                                if name in ("Task", "Agent"):
                                    subagent_spawns += 1
            except OSError:
                continue

    return {
        "cutoff": cutoff, "by_day": by_day, "by_model": by_model, "by_proj": by_proj,
        "by_proj_cost": by_proj_cost, "by_day_cost": by_day_cost, "totals": totals,
        "total_cost": total_cost, "msg_count": msg_count, "active_sessions": active_sessions,
        "sess_day": sess_day, "sess_proj": sess_proj, "sess_tokens": sess_tokens,
        "startup_tax": startup_tax, "tools": tools, "mcp": mcp, "by_hour": by_hour,
        "web": web, "subagent_tokens": subagent_tokens, "subagent_spawns": subagent_spawns,
    }


def running_daemons():
    try:
        out = subprocess.run(
            ["ps", "axww", "-o", "pid=,etime=,args="],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    daemons = []
    for line in out.splitlines():
        if "daemon start" not in line or "cli.js" not in line or "--workspace " not in line:
            continue
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, etime, args = parts
        ws = args.split("--workspace ", 1)[1].split(" --")[0].strip()
        daemons.append((pid, etime, ws))
    return daemons


def human_report(data, top, show_daemons):
    t = data["totals"]
    out = []
    w = out.append
    cutoff_local = data["cutoff"].astimezone().strftime("%Y-%m-%d %H:%M")
    w(f"\n=== Claude Code USAGE AUDIT — since {cutoff_local} ===")
    w(f"Assistant API responses: {data['msg_count']:,}   Active sessions: {len(data['active_sessions']):,}")
    w(f"\nTOTAL TOKENS: {t['total'] / 1e6:.1f}M")
    w(f"  input(fresh) {fmt(t['in'])}  |  output {fmt(t['out'])}  |  "
      f"cache-read {fmt(t['cr'])}  |  cache-write {fmt(t['cw'])}")
    denom = t["cr"] + t["in"] + t["cw"]
    if denom:
        w(f"  cache efficiency: {100 * t['cr'] / denom:.0f}% of context tokens are cache-reads "
          f"(reused, cheap) vs fresh+write")
    w(f"Cost-weighted (Opus-equivalent reference $, NOT plan billing): ${data['total_cost']:,.2f}")

    w("\n--- BY DAY  (cost-weight $ | total tokens | output) ---")
    for day in sorted(data["by_day"]):
        b = data["by_day"][day]
        w(f"  {day}:  ${data['by_day_cost'][day]:8.2f}   {fmt(b['total']):>7}   out={fmt(b['out'])}")

    w("\n--- BY MODEL  (interactive work is usually Opus; high Haiku/Sonnet = automation) ---")
    for fam in sorted(data["by_model"], key=lambda x: -data["by_model"][x]["total"]):
        b = data["by_model"][fam]
        w(f"  {fam:8} total={fmt(b['total']):>7}  out={fmt(b['out']):>7}  cache-read={fmt(b['cr']):>7}")

    w("\n--- SESSIONS PER DAY  (>~100/day with little interactive Opus => automation) ---")
    for day in sorted(data["sess_day"]):
        w(f"  {day}:  {len(data['sess_day'][day]):>6,} sessions")

    st = sorted(data["startup_tax"])
    if st:
        n = len(st)
        w("\n--- STARTUP CONTEXT TAX  (tokens loaded before any work, per session) ---")
        w(f"  sessions: {n:,}   median: {fmt(st[n // 2])}   p90: {fmt(st[int(n * 0.9)])}   "
          f"max: {fmt(st[-1])}   sum: {fmt(sum(st))}")

    sv = sorted(data["sess_tokens"].values())
    if sv:
        n = len(sv)
        tiny = sum(1 for x in sv if x < 200_000)
        w("\n--- SESSION SIZE  (many tiny sessions = hooks/workers/subagents) ---")
        w(f"  total: {n:,}   tiny (<200K tok): {tiny:,} ({100 * tiny / n:.0f}%)   "
          f"median: {fmt(sv[n // 2])}   p90: {fmt(sv[int(n * 0.9)])}")

    # busiest individual sessions
    w(f"\n--- TOP {top} BUSIEST SESSIONS (a single runaway conversation shows here) ---")
    for jf, tok in data["sess_tokens"].most_common(top):
        w(f"  {fmt(tok):>7}  {session_label(jf)}")

    w(f"\n--- TOP {top} PROJECTS by cost-weight ---")
    for proj, _ in data["by_proj_cost"].most_common(top):
        b = data["by_proj"][proj]
        sessions = len(data["sess_proj"][proj])
        w(f"  ${data['by_proj_cost'][proj]:8.2f}  {fmt(b['total']):>7}  "
          f"out={fmt(b['out']):>6}  sess={sessions:>5}  {proj}")

    # TOOL USAGE
    if data["tools"]:
        total_calls = sum(data["tools"].values())
        w(f"\n--- TOOL USAGE  ({total_calls:,} tool calls — what you actually do) ---")
        for name, c in data["tools"].most_common(top):
            w(f"  {c:>7,}  {100 * c / total_calls:4.0f}%  {name}")

    # MCP USAGE
    if data["mcp"]:
        total_mcp = sum(data["mcp"].values())
        w(f"\n--- MCP USAGE  ({total_mcp:,} calls by server — MCP tool defs cost ~tokens/session) ---")
        for server, c in data["mcp"].most_common(top):
            w(f"  {c:>7,}  {server}")

    # SUBAGENT FAN-OUT
    sa_tok = data["subagent_tokens"]
    sa_share = (100 * sa_tok / t["total"]) if t["total"] else 0
    w("\n--- SUBAGENT FAN-OUT (delegated/parallel work) ---")
    w(f"  Task/Agent spawns: {data['subagent_spawns']:,}   "
      f"sidechain tokens: {fmt(sa_tok)} ({sa_share:.0f}% of total)")

    # WEB TOOLS
    if data["web"]["search"] or data["web"]["fetch"]:
        w("\n--- WEB TOOLS (server-side, billed) ---")
        w(f"  web_search: {data['web']['search']:,}   web_fetch: {data['web']['fetch']:,}")

    # ACTIVITY BY HOUR
    if data["by_hour"]:
        w("\n--- ACTIVITY BY HOUR (local; flat 24h spread = automation, not a human) ---")
        peak = max(data["by_hour"].values()) or 1
        for h in range(24):
            c = data["by_hour"].get(h, 0)
            bar = "█" * int(round(20 * c / peak))
            w(f"  {h:02d}h {bar:<20} {c:,}")

    if show_daemons:
        daemons = running_daemons()
        w("\n--- RUNNING ruflo/claude-flow DAEMONS (token-leak suspects) ---")
        if not daemons:
            w("  ✓ none running")
        else:
            top_projects = {p for p, _ in data["by_proj_cost"].most_common(top)}
            for pid, etime, ws in daemons:
                flag = "  <-- TOP BURN PROJECT" if project_label(ws) in top_projects else ""
                w(f"  pid={pid:>7}  uptime={etime:>12}  {ws}{flag}")
            w(f"\n  {len(daemons)} daemon(s) running. Inspect/stop: ruflo-daemon-gc [--kill]")
    return "\n".join(out)


def json_report(data, top, show_daemons):
    t = data["totals"]
    st = sorted(data["startup_tax"])
    sv = sorted(data["sess_tokens"].values())
    denom = t["cr"] + t["in"] + t["cw"]
    obj = {
        "since": data["cutoff"].astimezone().isoformat(),
        "responses": data["msg_count"],
        "active_sessions": len(data["active_sessions"]),
        "totals": dict(t),
        "cache_efficiency_pct": round(100 * t["cr"] / denom, 1) if denom else 0,
        "cost_weight_opus_equiv": round(data["total_cost"], 2),
        "by_day": {d: {"cost": round(data["by_day_cost"][d], 2), **dict(data["by_day"][d])}
                   for d in sorted(data["by_day"])},
        "by_model": {m: dict(data["by_model"][m]) for m in data["by_model"]},
        "sessions_per_day": {d: len(s) for d, s in sorted(data["sess_day"].items())},
        "startup_tax": {"median": st[len(st) // 2] if st else 0,
                        "p90": st[int(len(st) * 0.9)] if st else 0,
                        "max": st[-1] if st else 0, "sum": sum(st)},
        "session_size": {"count": len(sv), "tiny_lt_200k": sum(1 for x in sv if x < 200_000),
                         "median": sv[len(sv) // 2] if sv else 0},
        "busiest_sessions": [{"session": session_label(jf), "tokens": tok}
                             for jf, tok in data["sess_tokens"].most_common(top)],
        "top_projects": [{"project": p, "cost_weight": round(data["by_proj_cost"][p], 2),
                          "total_tokens": data["by_proj"][p]["total"],
                          "sessions": len(data["sess_proj"][p])}
                         for p, _ in data["by_proj_cost"].most_common(top)],
        "tool_usage": dict(data["tools"].most_common(top)),
        "mcp_usage": dict(data["mcp"].most_common(top)),
        "subagent": {"spawns": data["subagent_spawns"], "sidechain_tokens": data["subagent_tokens"]},
        "web_tools": dict(data["web"]),
        "activity_by_hour": {str(h): data["by_hour"].get(h, 0) for h in range(24)},
    }
    if show_daemons:
        obj["daemons"] = [{"pid": pid, "uptime": etime, "workspace": ws}
                          for pid, etime, ws in running_daemons()]
    return json.dumps(obj, indent=2)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Comprehensive audit of local Claude Code usage across sessions.")
    ap.add_argument("--days", type=int, default=7, help="lookback window (default 7)")
    ap.add_argument("--top", type=int, default=15, help="top-N rows per section (default 15)")
    ap.add_argument("--json", action="store_true", help="machine-readable JSON output")
    ap.add_argument("--no-daemons", action="store_true",
                    help="skip the running-daemon cross-reference (`ps`)")
    ap.add_argument("--projects-root", default=os.path.expanduser("~/.claude/projects"),
                    help="transcript root (default ~/.claude/projects)")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.projects_root):
        sys.stderr.write(f"error: no transcript dir at {args.projects_root}\n")
        return 2
    if args.days < 1:
        sys.stderr.write("error: --days must be >= 1\n")
        return 2

    data = collect(args.projects_root, args.days)
    show_daemons = not args.no_daemons
    print(json_report(data, args.top, show_daemons) if args.json
          else human_report(data, args.top, show_daemons))
    return 0


if __name__ == "__main__":
    sys.exit(main())
