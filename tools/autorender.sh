#!/bin/bash
# Auto-editor: renders Keri's queued look/speed/trim requests and publishes them.
# Run by launchd every 15 minutes (see tools/install_autorender.sh). Log: ~/Library/Logs/aerial-abstract-autorender.log
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.." || exit 1
echo "--- $(date '+%Y-%m-%d %H:%M:%S')"
exec .venv/bin/python tools/studio.py auto
