#!/usr/bin/env bash
# Installs the PUBLISHED @pacphi/agentic-kit — not this checkout — and preps a
# scratch git repo outside the mounted workspace so `ak setup` (project scope)
# never touches the agentic-kit repo you're browsing in the editor.
set -euo pipefail

AK_DIST_TAG="${AK_DIST_TAG:-next}"
echo "installing @pacphi/agentic-kit@${AK_DIST_TAG} (published release)"
npm install -g "@pacphi/agentic-kit@${AK_DIST_TAG}"
ak --version

SANDBOX="$HOME/sandbox"
mkdir -p "$SANDBOX"
cd "$SANDBOX"
if [ ! -d .git ]; then
  git init -q
  git config user.email "tester@codespace.invalid"
  git config user.name "Codespace Tester"
  echo "# sandbox — try agentic-kit here" > README.md
  git add README.md
  git commit -qm "init sandbox"
fi

cat <<EOF

Ready. In the integrated terminal:
  cd ~/sandbox
  ak setup --yes                        # drop --yes to see the interactive prompts
  ak status
  ak dashboard --no-open --port 7431    # open the printed #token URL via the Ports tab

Pin a specific release instead of next: rebuild with AK_DIST_TAG set in this
devcontainer.json's "remoteEnv", or inside the container:
  npm install -g @pacphi/agentic-kit@4.0.0-alpha.41 && ak sync
EOF
