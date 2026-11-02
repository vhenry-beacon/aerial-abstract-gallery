#!/bin/bash
# Save the test site's own R2 key (made in Cloudflare for the aerial-abstract-media-staging bucket only).
# Typing is hidden; nothing is printed or written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$HOME/bin:$PATH"
export NETLIFY_SITE_ID=a61362b4-0ff1-441d-9d18-1e819e744bbf
read -rsp "Paste the Access Key ID, then press Return: " kid; echo
read -rsp "Paste the Secret Access Key, then press Return: " sec; echo
[ -n "$kid" ] && [ -n "$sec" ] || { echo "Both are needed; nothing was saved."; exit 1; }
netlify env:set R2_ACCESS_KEY_ID "$kid" >/dev/null
netlify env:set R2_SECRET_ACCESS_KEY "$sec" >/dev/null
echo "Saved to the test site. Tell Claude it's done."
