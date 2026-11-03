#!/usr/bin/env python3
"""Make the highlight reel add-ons for a gallery (formats in lib/core.mjs REEL_FORMATS).

  make_reels.py --slug river-oaks --plan reels.json [--only social-15,web-30] [--music track.mp3] [--no-deploy]

reels.json:
  {"title": "Fall Festival", "subtitle": "River Oaks Islamic Center",
   "stories": {"portrait": [["clip-11", 1.0], ["ground-09", 8.5], ...],     # gallery clip id, start second in that clip
               "landscape": [["wide-20", 2.0], ...]}}
Each reel takes evenly spaced moments from its story (always the first and the last), one per ~3.7 s, joined with
0.4 s crossfades so the reel lands on its exact length; the title card fades in over the first shot.
Vertical reels are 1080x1920 (the size social apps use), horizontal ones 3840x2160; shots of the other shape are
scaled to fill and center-cropped. Sources are the clips' delivered full-quality files (R2 full/<slug>/<id>).

Each reel becomes a gallery item reel-<format> (upsellOnly, `reel: <format>`) with its plan saved for the studio's
Highlight reel tab (review.reels[reel-<format>], where Keri can change shots, title and look; studio.py re-renders it),
arrives in the studio as not reviewed, and is offered to the client only once Keri approves it and prices it on the project page.
Without --music the reels are silent; the note on each one says so.
Written Nov 2, 2026.
"""
import argparse, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import studio  # noqa: E402
from studio import XF, text_card, run, log  # noqa: E402
from watermark import watermark_overlay  # noqa: E402
from add_to_project import deploy  # noqa: E402

FORMATS = {  # mirrors REEL_FORMATS in lib/core.mjs
    "web-30": ("Website & YouTube", "30 seconds", 30, "landscape"),
    "web-60": ("Website & YouTube", "1 minute", 60, "landscape"),
    "web-90": ("Website & YouTube", "1½ minutes", 90, "landscape"),
    "social-7": ("Social media", "7 seconds", 7, "portrait"),
    "social-15": ("Social media", "15 seconds", 15, "portrait"),
    "social-30": ("Social media", "30 seconds", 30, "portrait"),
    "social-60": ("Social media", "60 seconds", 60, "portrait"),
}
SHOT = 3.7  # target seconds per shot


def pick(story, n):
    """n evenly spaced moments, first and last always in."""
    if n >= len(story):
        return list(story)
    return [story[round(k * (len(story) - 1) / (n - 1))] for k in range(n)]


def plan_pieces(fmt, plan, items):
    """The reel's shots as studio reel pieces: [{clip, in, out, speed, look}] adding up to exactly its length."""
    group, label, T, shape = FORMATS[fmt]
    n = 3 if T <= 8 else max(4, round(T / SHOT))
    moments = pick(plan["stories"][shape], n)
    n = len(moments)
    L = (T + XF * (n - 1)) / n  # crossfades eat XF per join; this makes the total exactly T
    out = []
    for cid, start in moments:
        s = max(0.0, min(float(start), items[cid]["duration"] - L - 0.05))
        out.append({"clip": cid, "in": round(s, 2), "out": round(s + L, 2), "speed": 1, "look": None})
    return out


def studio_plan(fmt, plan, items):
    """What the studio's Highlight reel tab edits (review.reels[reel-<format>])."""
    return {"pieces": plan_pieces(fmt, plan, items), "look": None, "title": plan.get("title", ""),
            "subtitle": plan.get("subtitle", ""), "endcard": "", "transition": "fade", "music": ""}


def build(fmt, plan, items, sources, out, music=None):
    group, label, T, shape = FORMATS[fmt]
    W, H = (1080, 1920) if shape == "portrait" else (3840, 2160)
    pieces = plan_pieces(fmt, plan, items)
    n = len(pieces)
    L = pieces[0]["out"] - pieces[0]["in"]
    inputs, chains = [], []
    for k, p in enumerate(pieces):
        inputs += ["-ss", f"{p['in']:.3f}", "-t", f"{L:.3f}", "-i", sources[p["clip"]]]
        chains.append(f"[{k}:v]scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},setsar=1,"
                      f"fps=30,format=yuv420p,setpts=PTS-STARTPTS[v{k}]")
    last, off = "v0", L
    for k in range(1, n):
        off -= XF
        chains.append(f"[{last}][v{k}]xfade=transition=fade:duration={XF}:offset={off:.3f}[x{k}]")
        last, off = f"x{k}", off + L
    with tempfile.TemporaryDirectory() as td:
        title_png = os.path.join(td, "title.png")
        text_card(W, H, plan.get("title", ""), plan.get("subtitle", ""), 0.40 if shape == "portrait" else 0.36).save(title_png)
        hold = min(3.6, T * 0.4)  # the title fades out before the 7-second reel is half over
        inputs += ["-loop", "1", "-t", f"{T:.2f}", "-i", title_png]
        chains.append(f"[{n}:v]format=rgba,fade=t=in:st=0:d=0.4:alpha=1,fade=t=out:st={hold:.2f}:d=0.6:alpha=1[t]")
        chains.append(f"[{last}][t]overlay=0:0:enable='lt(t,{hold + 0.6:.2f})',fade=t=in:st=0:d=0.3,fade=t=out:st={T - 0.6:.2f}:d=0.6[vout]")
        cmd = ["ffmpeg", "-y", *inputs]
        maps = ["-map", "[vout]"]
        if music:
            cmd += ["-i", music]
            chains.append(f"[{n + 1}:a]atrim=0:{T:.2f},afade=t=in:d=0.5,afade=t=out:st={T - 1.5:.2f}:d=1.5[aout]")
            maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        run(cmd + ["-filter_complex", ";".join(chains), *maps, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{T:.2f}", out])
    return {"W": W, "H": H, "shots": n, "moments": [p["clip"] for p in pieces]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--music")
    ap.add_argument("--no-deploy", action="store_true")
    a = ap.parse_args()
    plan = json.load(open(a.plan))
    fmts = [f for f in FORMATS if not a.only or f in a.only.split(",")]
    man_path = studio.manifest_path(a.slug)
    man = json.load(open(man_path))
    items = {i["id"]: i for i in man["items"]}
    media = os.path.join(ROOT, "public", "media", a.slug)
    site, r2 = studio.Site(a.slug, by="Claude"), studio.R2()
    made = []
    with tempfile.TemporaryDirectory() as td:
        needed = {cid for f in fmts for cid, _ in plan["stories"][FORMATS[f][3]]}
        missing = needed - set(items)
        if missing:
            sys.exit(f"not in the gallery: {', '.join(sorted(missing))}")
        sources = {}
        for cid in sorted(needed):
            sources[cid] = os.path.join(td, f"{cid}.mp4")
            r2.get(f"full/{a.slug}/{cid}", sources[cid])
        log(f"downloaded {len(sources)} clips")
        for f in fmts:
            group, label, T, shape = FORMATS[f]
            rid = f"reel-{f}"
            full = os.path.join(td, f"{rid}.mp4")
            info = build(f, plan, items, sources, full, a.music)
            pw, ph = (540, 960) if shape == "portrait" else (960, 540)
            wm = os.path.join(td, "wm.png")
            watermark_overlay(pw, ph).save(wm)
            prev, poster = os.path.join(media, f"{rid}.mp4"), os.path.join(media, f"{rid}.jpg")
            run(["ffmpeg", "-y", "-i", full, "-i", wm, "-filter_complex", f"[0:v]scale={pw}:{ph}[v];[v][1:v]overlay=0:0",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                 *(["-c:a", "aac", "-b:a", "96k"] if a.music else ["-an"]), prev])
            run(["ffmpeg", "-y", "-ss", f"{min(T / 2, 5)}", "-i", prev, "-frames:v", "1", "-q:v", "4", poster])
            v = (items.get(rid, {}).get("version") or 0) + 1
            items[rid] = {"id": rid, "type": "video", "title": f"{group} reel · {label}", "reel": f, "upsellOnly": True,
                          "duration": float(T), "orientation": shape, "width": info["W"], "height": info["H"],
                          "source": "highlight reel", "shots": info["moments"], "version": v, "fullFile": f"{rid}.mp4",
                          "preview": f"/media/{a.slug}/{rid}.mp4?v={v}", "poster": f"/media/{a.slug}/{rid}.jpg?v={v}"}
            made.append((rid, full, info, T))
            log(f"   {rid}: {T}s, {info['shots']} shots, {os.path.getsize(full) / 1e6:.0f} MB")
        # reels go at the end of the manifest, in format order; everything else is untouched
        others = [i for i in man["items"] if not i.get("reel")]
        man["items"] = others + [items[f"reel-{f}"] for f in FORMATS if f"reel-{f}" in items]
        json.dump(man, open(man_path, "w"), indent=2)
        if a.no_deploy:
            log("--no-deploy: manifest and previews written; nothing uploaded")
            return
        deploy()
        for rid, full, info, T in made:
            r2.put(f"full/{a.slug}/{rid}", full, "video/mp4")
            site.call("POST", "/api/admin/upload-done", {"id": rid, "name": f"{a.slug}-{rid}.mp4", "type": "video/mp4"})
            note = (f"New reel, {T} seconds, {info['shots']} shots"
                    + (", with music." if a.music else ". No music yet: it's silent until a licensed track is added (tell Claude which one).")
                    + " Approve it and set its price on the project page to offer it to the client.")
            site.post({"id": rid, "status": "new", "note": {"text": note}})
            sp = studio_plan(rid[len("reel-"):], plan, items)  # Keri can now rearrange it in the Highlight reel tab
            site.post({"reelId": rid, "reel": sp, "reelRendered": sp, "reelVersion": items[rid]["version"]})
    subprocess.run(["git", "add", "clients", "public/media", "lib/registry.generated.mjs"], cwd=ROOT)
    subprocess.run(["git", "commit", "-q", "-m", f"{a.slug}: highlight reels {', '.join(r for r, *_ in made)}"], cwd=ROOT)
    log("done")


if __name__ == "__main__":
    main()
