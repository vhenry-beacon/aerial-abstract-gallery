#!/usr/bin/env python3
"""Add newly uploaded files to a gallery that's already built, without touching what's there.

  add_to_project.py plan --id PROJECT [--slug S]        # what's new in raw/<project>/ and what would be made
  add_to_project.py run  --id PROJECT [--slug S] [options]

Only raw files no gallery item came from are used (items record "rawKey"; older ones only "source", the file
name). Existing items keep their ids, approvals, edits, notes and purchases. New items continue the numbering:
  vertical drone video  -> clip-NN   "Clip 12"         horizontal drone video -> wide-NN   "Wide clip 3"
  ground (Osmo) video   -> ground-NN "Ground clip 2"   photos -> photo-NN "Aerial photo 18" / "Ground photo 4"
Ground vs drone: a folder or file name containing "osmo" or "ground" means ground; "drone"/"aerial" means drone.
Photos without a hint use process_photos.classify (DJI 4:3 = aerial); videos without a hint are ground when the
camera labels itself an Osmo, otherwise drone footage.

House look: the color look Keri applied most in the studio (per videos / photos, at least twice) is applied to
the new items as a normal studio edit, so she can still change it or go back to the original. --look / --photo-look
set it by hand (a preset name, or "none").

run options:
  --only TEXT         use only new files whose path contains TEXT (e.g. a folder name)
  --skip TEXT         leave out new files whose path contains TEXT; they're remembered and not offered again
  --pick "FILE=a-b,c-d"  hand-picked clip ranges (seconds) for one video instead of the automatic scene cuts;
                      repeat for more videos. Use it for long unedited footage (plan warns about those).
  --ground TEXT       treat new videos whose path contains TEXT as ground footage (no folder hint or camera label)
  --min/--max         automatic clip length range in seconds (default 10-15)
  --raw-dir DIR       reuse raw files already downloaded to DIR (same name and size) instead of downloading again
  --no-deploy         stop after making the files (for testing); otherwise deploys, uploads, applies the look,
                      deploys again and commits locally, updating the status card on Keri's project page.
Written Nov 2, 2026.
"""
import argparse, collections, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import studio  # noqa: E402
from process_clips import probe, scene_cuts, plan_segments, cut_clip  # noqa: E402
from process_photos import classify, make_photo  # noqa: E402

PHOTO_EXT = (".jpg", ".jpeg", ".heic", ".png")
VIDEO_EXT = (".mp4", ".mov", ".m4v")
OUR_OUTPUT = re.compile(r"^(clip|wide|ground|photo|mashup|highlight-reel)-?\d*\.(mp4|jpg)$", re.I)  # files we delivered
SPLIT_PART = re.compile(r"\.\d{3}$")  # pieces of a split file (clip-01.mp4.001)
LONG_VIDEO = 120  # seconds; longer unedited footage should be hand-picked


def hint(path):
    p = path.lower()
    if "osmo" in p or "ground" in p:
        return "ground"
    if "drone" in p or "aerial" in p:
        return "aerial"
    return None


def camera_hint(src):
    """The camera's own label: Osmo Pocket files say encoder "DJI OsmoPocket3", so they're ground footage."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=encoder", "-of", "default=nw=1:nk=1", src],
                         capture_output=True, text=True).stdout
    return "ground" if "osmo" in out.lower() else None


def new_raw_files(r2, pid, man):
    used_keys = {i.get("rawKey") for i in man["items"]} | set(man.get("rawSkipped", []))
    used_names = {i.get("source") for i in man["items"] if not i.get("rawKey")}
    out, ignored = [], []
    for f in r2.list(f"raw/{pid}/"):
        rel = f["key"][len(f"raw/{pid}/"):]
        name = os.path.basename(rel)
        if rel in used_keys or name in used_names:
            continue
        low = name.lower()
        if name.startswith("._") or SPLIT_PART.search(name) or OUR_OUTPUT.match(name):
            ignored.append(rel)
        elif low.endswith(PHOTO_EXT):
            out.append({"rel": rel, "key": f["key"], "size": f["size"], "type": "photo"})
        elif low.endswith(VIDEO_EXT):
            out.append({"rel": rel, "key": f["key"], "size": f["size"], "type": "video"})
        else:
            ignored.append(rel)
    return out, ignored


def next_number(man, prefix):
    nums = [int(m.group(1)) for i in man["items"] if (m := re.match(rf"^{prefix}-(\d+)$", i["id"]))]
    return max(nums, default=0) + 1


def title_count(man, word):
    return sum(1 for i in man["items"] if i["type"] == "photo" and i.get("category", "aerial") == word)


def house_look(review, man, kind):
    types = {i["id"]: i["type"] for i in man["items"]}
    looks = collections.Counter(((r.get("edit") or {}).get("look") or {}).get("preset") for iid, r in review["items"].items()
                                if types.get(iid) == kind)
    looks.pop(None, None)
    looks.pop("original", None)
    best = looks.most_common(1)
    return best[0][0] if best and best[0][1] >= 2 else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["plan", "run"])
    ap.add_argument("--id", required=True)
    ap.add_argument("--slug")
    ap.add_argument("--only", default="")
    ap.add_argument("--skip", action="append", default=[])
    ap.add_argument("--pick", action="append", default=[])
    ap.add_argument("--min", type=float, default=10)
    ap.add_argument("--max", type=float, default=15)
    ap.add_argument("--look")
    ap.add_argument("--photo-look")
    ap.add_argument("--ground", action="append", default=[])
    ap.add_argument("--raw-dir")
    ap.add_argument("--no-deploy", action="store_true")
    a = ap.parse_args()

    psite = studio.Site("", by="Claude")
    proj = psite.call("GET", f"/api/admin/project?id={a.id}", slug=False)["project"]
    slug = a.slug or proj.get("gallerySlug")
    if not slug:
        sys.exit(f"{a.id} has no gallery yet; build it first (docs/SOP.md), then add to it")
    def fetch(f, dest):
        local = os.path.join(a.raw_dir, os.path.basename(f["rel"])) if a.raw_dir else None
        if local and os.path.exists(local) and os.path.getsize(local) == f["size"]:
            os.symlink(local, dest)
        else:
            r2.get(f["key"], dest)

    status = lambda state, text="": psite.call("POST", "/api/admin/project", {"id": a.id, "claude": True, "state": state, "stateText": text}, slug=False)
    man_path = studio.manifest_path(slug)
    man = json.load(open(man_path))
    site, r2 = studio.Site(slug, by="Claude"), studio.R2()
    review = site.review()["review"]

    files, ignored = new_raw_files(r2, a.id, man)
    skipped = [f["rel"] for f in files if any(s.lower() in f["rel"].lower() for s in a.skip)]
    files = [f for f in files if f["rel"] not in skipped and a.only.lower() in f["rel"].lower()]
    vlook = a.look if a.look else house_look(review, man, "video")
    plook = a.photo_look if a.photo_look else house_look(review, man, "photo")
    vlook, plook = (None if x == "none" else x for x in (vlook, plook))
    picks = {}
    for p in a.pick:
        name, ranges = p.split("=", 1)
        picks[name] = [tuple(map(float, r.split("-"))) for r in ranges.split(",")]

    studio.log(f"{a.id} -> gallery {slug}: {len(man['items'])} items now; {len(files)} new file(s)"
               f"{f', {len(ignored)} ignored (split pieces, our own deliveries, other files)' if ignored else ''}")
    for f in files:
        studio.log(f"   {f['type']:5s} {f['size'] / 1e6:8.1f} MB  {f['rel']}  [{hint(f['rel']) or 'no folder hint'}]")
    studio.log(f"   house look: videos {vlook or 'none'}, photos {plook or 'none'}")
    if a.cmd == "plan" or not files:
        if not files:
            studio.log("Nothing new to add.")
        return

    status("working", f"Adding {len(files)} new file(s) to the gallery")
    media = os.path.join(ROOT, "public", "media", slug)
    new_items = []
    with tempfile.TemporaryDirectory() as td:
        full_dir = os.path.join(td, "full")
        os.makedirs(full_dir)
        photos = [f for f in files if f["type"] == "photo"]
        videos = [f for f in files if f["type"] == "video"]
        # ---- photos: aerials first, then ground, each in upload order; numbering continues
        if photos:
            status("working", f"Editing {len(photos)} new photo(s)")
            from PIL import Image, ImageOps
            loaded = []
            for f in photos:
                src = os.path.join(td, "raw", f["rel"])
                os.makedirs(os.path.dirname(src), exist_ok=True)
                fetch(f, src)
                im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
                loaded.append((hint(f["rel"]) or classify(src, im), f, src, im))
            loaded.sort(key=lambda t: (t[0] != "aerial", t[1]["rel"]))
            n = next_number(man, "photo")
            counts = {k: title_count(man, k) for k in ("aerial", "ground")}
            for kind, f, src, im in loaded:
                counts[kind] += 1
                it = make_photo(src, im, f"photo-{n:02d}", kind, counts[kind], full_dir, media)
                it.update(rawKey=f["rel"], preview=f"/media/{slug}/{it['id']}.jpg")
                new_items.append(it)
                studio.log(f"   {it['id']}: {it['title']} <- {f['rel']}")
                n += 1
                os.remove(src)
        # ---- videos: automatic scene clips (or hand-picked ranges), frame-exact
        for f in videos:
            src = os.path.join(td, "raw", f["rel"])
            os.makedirs(os.path.dirname(src), exist_ok=True)
            status("working", f"Cutting clips from {os.path.basename(f['rel'])}")
            fetch(f, src)
            info = probe(src)
            portrait = info["h"] > info["w"]
            kind = ("ground" if any(g.lower() in f["rel"].lower() for g in a.ground) else None) or hint(f["rel"]) or camera_hint(src) or "aerial"
            prefix, word = ("ground", "Ground clip") if kind == "ground" else ("clip", "Clip") if portrait else ("wide", "Wide clip")
            name = os.path.basename(f["rel"])
            segs = picks.get(name) or plan_segments(scene_cuts(src, 0.30), info["dur"], a.min, a.max)
            if name not in picks and info["dur"] > LONG_VIDEO:
                studio.log(f"   note: {name} is {info['dur'] / 60:.0f} min long; consider --pick for the best moments")
            n = next_number(man | {"items": man["items"] + new_items}, prefix)
            for s, e in segs:
                fa, fb = round(s * info["fps"]), round(e * info["fps"])
                cid = f"{prefix}-{n:02d}"
                out = os.path.join(full_dir, f"{cid}.mp4")
                cut_clip(src, fa, fb, info["fps"], out)
                cinfo = studio.probe(out)
                studio.video_preview(out, cinfo, os.path.join(media, f"{cid}.mp4"), os.path.join(media, f"{cid}.jpg"))
                new_items.append({
                    "id": cid, "type": "video", "title": f"{word} {n:02d}" if prefix == "clip" else f"{word} {n}",
                    "category": kind, "duration": round(cinfo["dur"], 2), "orientation": "portrait" if portrait else "landscape",
                    "width": info["w"], "height": info["h"], "source": name, "rawKey": f["rel"],
                    "sourceStart": round(fa / info["fps"], 3), "sourceEnd": round(fb / info["fps"], 3), "sourceFrames": [fa, fb],
                    "fullFile": f"{cid}.mp4", "preview": f"/media/{slug}/{cid}.mp4", "poster": f"/media/{slug}/{cid}.jpg",
                })
                studio.log(f"   {cid}: {s:.1f}-{e:.1f}s of {name}")
                n += 1
            os.remove(src)

        # ---- merge: new items go after the existing ones (the gallery groups them by kind)
        keep = [i for i in man["items"] if not i.get("upsellOnly")]
        extras = [i for i in man["items"] if i.get("upsellOnly")]
        man["items"] = keep + new_items + extras
        man["rawSkipped"] = sorted(set(man.get("rawSkipped", [])) | set(skipped))
        json.dump(man, open(man_path, "w"), indent=2)
        studio.log(f"manifest: {len(keep)} kept + {len(new_items)} new")
        if a.no_deploy:
            studio.log(f"--no-deploy: full files left in {full_dir} are discarded; nothing uploaded")
            return

        status("working", "Publishing the new items")
        deploy()
        status("working", f"Uploading {len(new_items)} full-quality file(s)")
        for it in new_items:
            ctype = "video/mp4" if it["type"] == "video" else "image/jpeg"
            r2.put(f"full/{slug}/{it['id']}", os.path.join(full_dir, it["fullFile"]), ctype)
            site.call("POST", "/api/admin/upload-done", {"id": it["id"], "name": it["fullFile"], "type": ctype})

    # ---- house look, as a normal studio edit (Keri can change it or go back to the original)
    looked = []
    for it in new_items:
        preset = vlook if it["type"] == "video" else plook
        if preset:
            site.post({"id": it["id"], "edit": {"look": {"preset": preset}, "speed": 1, "trim": None}})
            looked.append(it["id"])
    if looked:
        status("working", f"Applying the {vlook or plook} look to the new items")
        with tempfile.TemporaryDirectory() as td:
            studio.render_items(site, r2, site.review(), looked, {"_dir": td}, announce=False)
        deploy()
    subprocess.run(["git", "add", "clients", "public/media", "lib/registry.generated.mjs"], cwd=ROOT)
    subprocess.run(["git", "commit", "-q", "-m", f"Add {len(new_items)} items to {slug} from {a.id}"], cwd=ROOT)
    kinds = collections.Counter(i["title"].rsplit(" ", 1)[0].lower() for i in new_items)
    summary = ", ".join(f"{n} {k}{'s' if n > 1 else ''}" for k, n in kinds.items())
    text = (f"Added {summary} from your new uploads"
            + (f", with the {vlook or plook} look" + ("" if a.look or a.photo_look else " you've been using") if looked else "")
            + ". They're in the review studio, not reviewed yet. Everything you already approved is unchanged.")
    psite.call("POST", "/api/admin/project", {"id": a.id, "claude": True, "state": "ready", "claudeNote": text}, slug=False)
    studio.log(text)


def deploy():
    for cmd in (["npm", "run", "build"], ["netlify", "deploy", "--prod", "--build"]):
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        if p.returncode:
            sys.exit(f"{' '.join(cmd)} failed: {(p.stderr or p.stdout)[-300:]}")


if __name__ == "__main__":
    try:
        main()
    except (SystemExit, Exception) as e:  # tell Keri on her project page instead of leaving the card on "working"
        if isinstance(e, SystemExit) and not isinstance(e.code, str):
            raise
        pid = sys.argv[sys.argv.index("--id") + 1] if "--id" in sys.argv else None
        if pid and "run" in sys.argv:
            try:
                studio.Site("", by="Claude").call("POST", "/api/admin/project", {"id": pid, "claude": True, "state": "problem",
                    "stateText": "Adding the new files stopped partway. Vernon or Claude will look at it; nothing you approved was changed."}, slug=False)
            except Exception:
                pass
        raise
