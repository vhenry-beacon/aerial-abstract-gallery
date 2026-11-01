# Aerial Abstract Client Gallery

Private client galleries for Keri Henry's drone business (Aerial Abstract). Clients browse watermarked previews, pick the deliverables included in their package, pay through Stripe for extras and add-ons, and download full-quality files only after selection or payment.

The owner is Vernon Henry, who is non-technical about infrastructure. **Do the work yourself with the CLI tools rather than giving him dashboard instructions.** Ask only when a decision is genuinely his, and batch questions.

## Stack
- Static frontend in `public/`: gallery at `/g/<slug>` (`public/g/index.html` + `assets/gallery.js`), admin at `/admin`.
- `netlify/functions/api.mts`: all `/api/*` routes (login, gallery, select, checkout, confirm, stripe-webhook, admin/*).
- `netlify/edge-functions/download.ts`: `/dl/:slug/:id` checks the purchase, then redirects to a signed R2 URL (or streams from Netlify Blobs if R2 isn't configured).
- `lib/core.mjs`: auth (HMAC cookies), state in Netlify Blobs, server-side pricing (`quote`), order fulfillment, Stripe REST, R2 signing (aws4fetch).
- `clients/<slug>/client.json` + `manifest.json`: per-client config; `tools/build-registry.mjs` bundles them at build time (`npm run build`).
- `tools/*.py`: media pipeline (photos, scene clips, highlight reel, watermark, manifest). Requires ffmpeg, Pillow, pillow-heif, numpy.
- Full procedure: `docs/SOP.md`.

## Where things stand (Nov 1, 2026)
- Netlify project `aerial-abstract-gallery` (site ID `1fd12ec1-914f-4f2c-aecf-e266faea0416`, team `vhenry`), visitor access Public. **No successful deploy yet.** The first manual deploy, from the exFAT USB, failed with build exit 2, almost certainly from macOS `._*` AppleDouble files. Never deploy from the USB.
- Env vars already set in Netlify: `SESSION_SECRET`, `ADMIN_PASSWORD`. Not yet set: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- GitHub repo `vhenry-beacon/aerial-abstract-gallery` (this repo) is not yet linked to the Netlify project.
- First client: `river-oaks` (ISGH River Oaks Islamic Center, Fall Festival, Oct 31, 2026). $650 Signature Aerial with 15 included picks, $25 extras, $200 highlight reel. The client access code is in the claude.ai project doc `client-gallery-build-status.md` (ask Vernon; only its SHA-256 is in the repo). 11 vertical 4K clips (one per scene; the source edit is only 79s) and 19 enhanced photos. Previews are committed in `public/media/river-oaks/`.
- Full-quality River Oaks files are on the USB: `/Volumes/USB DISK/RiveOaksISLAMICCENTER/Gallery-FullQuality/`. Clips over ~25 MB are split as `clip-NN.mp4.001`, `.002`, …; rejoin with `cat clip-NN.mp4.0* > clip-NN.mp4` (verified frame-identical to the originals).
- Sample reel `public/media/river-oaks/reel-sample.mp4` has titles but no music (the source export is silent). Keri needs to supply a licensed track; re-render with `tools/make_reel.py --music`.

## To finish V1 (do these with the CLIs)
1. `npm i -g netlify-cli wrangler` → `netlify login` and `wrangler login` (one browser approval each; Vernon is signed in).
2. `netlify link --id 1fd12ec1-914f-4f2c-aecf-e266faea0416`, then connect the repo for continuous deployment (`netlify init` or the API) so pushes to `main` deploy. Verify a production deploy succeeds.
3. Create the R2 bucket `aerial-abstract-media` (`wrangler r2 bucket create`) and set its CORS to allow PUT/GET/HEAD from `https://aerial-abstract-gallery.netlify.app` with header `content-type`. Create an R2 API token (Object Read & Write on that bucket); Vernon may need to do this one in the Cloudflare dashboard. Set the four `R2_*` env vars with `netlify env:set` (do not echo secrets), then redeploy.
4. Upload the full-quality River Oaks files to R2 at key `full/river-oaks/<id>` (for example, `wrangler r2 object put aerial-abstract-media/full/river-oaks/clip-01 --file clip-01.mp4 --content-type video/mp4 --remote`). Then record each file's metadata so the gallery marks it ready: call `POST /api/admin/upload-done?slug=river-oaks` with `{id, name, type}` while signed in as admin, or just use the `/admin` page drop zone, which uploads straight to R2.
5. Test end to end on the live site: client login, picking, cart math, admin "mark cart paid", and download redirect. Use Stripe test mode once Keri adds `STRIPE_SECRET_KEY` (test card 4242 4242 4242 4242).
6. Send the client link: `https://aerial-abstract-gallery.netlify.app/g/river-oaks` with the access code.

## Owner preferences
- Don't leave project or media files cluttering his Mac. Keep code in GitHub and media in R2. Once uploads to R2 are verified, the USB and local copies aren't needed.
- Minimize the questions you ask him. Do the steps yourself and report the results.
