# Aerial Abstract Client Gallery

Private client galleries for Keri Henry's drone business (Aerial Abstract). Clients browse watermarked previews, pick the deliverables included in their package, pay through Stripe for extras and add-ons, and download full-quality files only after selection or payment.

The owner is Vernon Henry, who is non-technical about infrastructure. **Do the work yourself with the CLI tools rather than giving him dashboard instructions.** Ask only when a decision is genuinely his, and batch questions.

## Stack
- Static frontend in `public/`: gallery at `/g/<slug>` (`public/g/index.html` + `assets/gallery.js`), admin at `/admin`, review studio at `/admin/studio/` (`assets/studio.js`).
- `netlify/functions/api.mts`: all `/api/*` routes (login, gallery, select, checkout, confirm, stripe-webhook, admin/*).
- `netlify/edge-functions/download.ts`: `/dl/:slug/:id` checks the purchase, then redirects to a signed R2 URL (or streams from Netlify Blobs if R2 isn't configured).
- `lib/core.mjs`: auth (HMAC cookies), state in Netlify Blobs, server-side pricing (`quote`), order fulfillment, Stripe REST, R2 signing (aws4fetch).
- `clients/<slug>/client.json` + `manifest.json`: per-client config; `tools/build-registry.mjs` bundles them at build time (`npm run build`).
- `tools/*.py`: media pipeline (photos, scene clips, highlight reel, watermark, manifest) and `tools/studio.py`, which renders Keri's studio requests. Requires ffmpeg, Pillow, pillow-heif, numpy.
- Full procedure: `docs/SOP.md`.

## Where things stand (Nov 1, 2026)
- Live: https://aerial-abstract-gallery.netlify.app, deployed from this checkout with `netlify deploy --prod --build` (project linked). **Not yet auto-deploying from GitHub**: connecting needs a deploy key + webhook on the repo, which Vernon hasn't approved yet. Never deploy from the USB.
- R2 bucket `aerial-abstract-media` (Cloudflare account under vhenry@beaconmineral.com). CORS: PUT/GET/HEAD, header content-type, exposes ETag (needed for multipart uploads). Keys in R2: `full/<slug>/<id>` delivered files, `orig/<slug>/<id>` untouched originals (made on first edit), `raw/<project>/...` whole-shoot uploads.
- Netlify env set: `SESSION_SECRET`, `ADMIN_PASSWORD`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. `STRIPE_SECRET_KEY` is Keri's TEST key (set Nov 1, 2026; test checkout passed: paid order unlocked package picks + reel, then reset). Not set yet: `STRIPE_WEBHOOK_SECRET` (backup only; /api/confirm already fulfills on return from Checkout).
- First client `river-oaks` (ISGH River Oaks Islamic Center, Fall Festival, Oct 31, 2026): $650 Signature Aerial, 15 included, $25 extras, $200 reel. Access code is in the claude.ai doc `client-gallery-build-status.md` (only its SHA-256 is here). 11 vertical 4K clips + 19 photos, all 30 full-quality files in R2 and verified against the USB originals. Tested end to end ($900 cart, gated downloads), then reset. **Client not emailed yet**: Vernon and Keri are still reviewing, and more photos and horizontal files are coming.
- Review studio at `/admin/studio/` (`public/assets/studio.js`, `looks.js`): Keri approves/edits/removes items, arranges the reel, uploads raw shoots, and publishes. Galleries are unpublished until she publishes; clients then see approved items only. Claude applies her requests with `tools/studio.py` (see docs/SOP.md step 8b). Looks are defined twice and must stay in sync: `public/assets/looks.js` (CSS preview) and `tools/looks.py` (ffmpeg).
- The River Oaks reel plan in the studio was recovered by matching the sample reel's frames to the source edit: 9 pieces (clip-01 1.0-5.6, clip-07 0.2-3.7, clip-08 0.6-4.1, clip-04 1.4-4.9, clip-06 0.7-4.0, clip-10 1.37-4.87, clip-09 0.84-4.24, clip-02 1.01-4.31, clip-11 0.6-5.5). Still no music: Keri must supply a licensed track, then `studio.py render --reel --music <file>` delivers it.
- Admin home `/admin/` = Keri's projects (tiles; project page with quote, instructions, uploads, "Send to Claude"); stored in Netlify Blobs store `studio` at `project/<id>`, raw files at `raw/<id>/`. Old admin page is `/admin/orders/`. Claude's side: `tools/project.py` (docs/SOP.md step 0). River Oaks is project `river-oaks-fall-festival`, linked to gallery `river-oaks`.
- Auto-editor: `tools/studio.py auto` via LaunchAgent `com.aerialabstract.autorender` every 15 min (installer `tools/install_autorender.sh`). **Not installed yet as of Nov 1**: Claude's permission check blocked installing a LaunchAgent, so Vernon runs the installer himself. It renders queued look/speed/trim edits, deploys, commits locally. Written notes still need Claude (`studio.py status`, then `set`/`render`/`reply`).
- Python tools run from `.venv/` (Pillow, numpy, pillow-heif). This Mac's ffmpeg has no drawtext, so reel titles are drawn with Pillow (Didot + Avenir Next) and overlaid.
- Local testing: `netlify dev` doesn't support HTTP range requests, so video seeking doesn't work locally; check seeking on the live site.

## Owner preferences
- Don't leave project or media files cluttering his Mac. Keep code in GitHub and media in R2. Once uploads to R2 are verified, the USB and local copies aren't needed.
- Minimize the questions you ask him. Do the steps yourself and report the results.
