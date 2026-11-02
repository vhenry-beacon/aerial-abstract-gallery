#!/bin/bash
# Deploy the site.
#   npm run deploy:test   -> https://aerial-abstract-staging.netlify.app (its own data, R2 bucket, admin password)
#   npm run deploy:live   -> https://aerial-abstract-gallery.netlify.app (Keri's real clients)
# New features go to the test site first; live only after Vernon (or Keri) has tried them there.
# Live refuses to deploy from anything but a clean main branch, so half-finished work never reaches clients.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$HOME/bin:$PATH"
STAGING_SITE_ID=a61362b4-0ff1-441d-9d18-1e819e744bbf

case "${1:-}" in
  test)
    export GALLERY_ENV=staging NETLIFY_SITE_ID=$STAGING_SITE_ID
    ;;
  live)
    unset GALLERY_ENV NETLIFY_SITE_ID
    branch=$(git rev-parse --abbrev-ref HEAD)
    [ "$branch" = main ] || { echo "Live deploys come from main (you're on $branch). Merge it into main first."; exit 1; }
    [ -z "$(git status --porcelain -- . ':!lib/registry.generated.mjs')" ] || { echo "Uncommitted changes; commit them before deploying live."; git status -s; exit 1; }
    ;;
  *) echo "usage: tools/deploy.sh test|live"; exit 1 ;;
esac

npm run build
netlify deploy --prod --build
# put the registry back to the live set, so a test deploy never leaves test galleries in the committed file
[ "${1}" = test ] && GALLERY_ENV= npm run build >/dev/null
echo "Deployed to ${1}."
