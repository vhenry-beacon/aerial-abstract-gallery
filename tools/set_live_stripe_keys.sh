#!/bin/bash
# Switch the LIVE site to real Stripe payments: saves the live secret key (sk_live_ or rk_live_) and the live
# webhook's signing secret (whsec_). Typing is hidden; nothing is printed or written to disk.
# Afterwards run `npm run deploy:live` so the site picks them up. To go back to test mode, run it with the test values.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$HOME/bin:$PATH"
export NETLIFY_SITE_ID=1fd12ec1-914f-4f2c-aecf-e266faea0416  # aerial-abstract-gallery (the live site)
read -rsp "Paste the Stripe secret key (starts sk_live_ or rk_live_), then press Return: " key; echo
read -rsp "Paste the webhook signing secret (starts whsec_), then press Return: " wh; echo
case "$key" in sk_live_*|rk_live_*|sk_test_*|rk_test_*) ;; *) echo "That doesn't look like a Stripe secret key; nothing was saved."; exit 1;; esac
case "$wh" in whsec_*) ;; *) echo "That doesn't look like a webhook signing secret; nothing was saved."; exit 1;; esac
netlify env:set STRIPE_SECRET_KEY "$key" >/dev/null
netlify env:set STRIPE_WEBHOOK_SECRET "$wh" >/dev/null
case "$key" in *_live_*) echo "Saved LIVE Stripe keys to the live site. Tell Claude it's done (it needs a redeploy).";;
                *) echo "Saved TEST Stripe keys to the live site. Tell Claude it's done (it needs a redeploy).";; esac
