#!/usr/bin/env bash
# First-use entrypoint: install the kit → run setup → serve the dashboard
# (or exec whatever command was given, e.g. `bash` for an interactive shell).
# Every knob is an env var so `docker compose run -e ...` can retune a run
# without an image rebuild. See MAINTAINER-GUIDE.md for the full knob table.
set -euo pipefail

AK_DIST_TAG="${AK_DIST_TAG:-next}"
# Full install spec override — lets maintainers test an UNPUBLISHED build:
# npm pack the checkout, drop the tarball into ./artifacts, and set
# AK_INSTALL_SPEC=/artifacts/<name>.tgz (mounted read-write by compose).
AK_INSTALL_SPEC="${AK_INSTALL_SPEC:-@pacphi/agentic-kit@${AK_DIST_TAG}}"
AK_SETUP_FLAGS="${AK_SETUP_FLAGS:---codex --opencode --yes}"
AK_SKIP_SETUP="${AK_SKIP_SETUP:-0}"
AK_DASHBOARD_PORT="${AK_DASHBOARD_PORT:-7431}" # container-loopback (ak's default)
AK_BRIDGE_PORT="${AK_BRIDGE_PORT:-7432}"       # socat re-publish; the EXPOSEd port

# Sample project: ak is project-aware (statusline, settings.local.json, and the
# aqe router all anchor at a repo root), so first-use runs from a real git repo.
mkdir -p "$HOME/work/sandbox"
cd "$HOME/work/sandbox"
if [ ! -d .git ]; then
  git init -q
  git config user.email "tester@firstuse.invalid"
  git config user.name "First-Use Tester"
  echo "# sandbox — agentic-kit first-use project" > README.md
  git add README.md && git commit -qm "init sandbox"
fi

if ! command -v ak >/dev/null 2>&1; then
  echo "▶ installing ${AK_INSTALL_SPEC} (the real first-install path)"
  npm install -g "${AK_INSTALL_SPEC}"
fi
echo "▶ agentic-kit $(ak --version 2>/dev/null || echo '(version probe failed)')"

if [ "${AK_SKIP_SETUP}" != "1" ]; then
  echo "▶ ak setup ${AK_SETUP_FLAGS}"
  # shellcheck disable=SC2086 # flags are deliberately word-split
  ak setup ${AK_SETUP_FLAGS} \
    || echo "⚠ ak setup exited $? — continuing so the state stays inspectable"
fi

# Regression artifact: a machine-readable snapshot of what first-use produced.
if [ -d /artifacts ] && [ -w /artifacts ]; then
  ak status --json > /artifacts/first-use-status.json 2>/dev/null \
    && echo "▶ wrote /artifacts/first-use-status.json"
fi

case "${1:-dashboard}" in
  dashboard)
    # ak's dashboard binds 127.0.0.1 by design (loopback + per-session token;
    # docs/adr/0014-dashboard-auth-and-remediation.md). Docker port publishing
    # cannot reach a container-loopback listener, so socat re-publishes it on
    # the container interface; compose maps that back to HOST-loopback only —
    # same security envelope, one hop longer.
    socat "TCP-LISTEN:${AK_BRIDGE_PORT},fork,reuseaddr" \
          "TCP:127.0.0.1:${AK_DASHBOARD_PORT}" &
    echo "▶ copy the #token URL below into your HOST browser — it works verbatim"
    echo "  (host 127.0.0.1:${AK_DASHBOARD_PORT} → bridge :${AK_BRIDGE_PORT} → dashboard)"
    exec ak dashboard --no-open --port "${AK_DASHBOARD_PORT}"
    ;;
  *)
    exec "$@"
    ;;
esac
