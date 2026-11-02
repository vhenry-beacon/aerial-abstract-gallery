#!/usr/bin/env python3
"""Re-cut a gallery's clips from the source edit, frame-exact, keeping Keri's studio edits.

  recut_clips.py --slug river-oaks --src /path/VerticalSocialMediaEDITED.mp4 [--ids clip-02,clip-03]

For every clip cut from --src (manifest "source" matches its file name):
  1. cut source frames [start, end) again with process_clips.cut_clip -> R2 orig/<slug>/<id>
  2. if the studio has an edit for it (look / trim / speed), render that edit on the new cut;
     otherwise the new cut is the delivered file -> R2 full/<slug>/<id>
  3. rebuild the watermarked preview and poster, bump their ?v= cache-buster, fix the duration
Review statuses, notes and versions in the studio are left exactly as they are.
Afterwards: npm run build, netlify deploy --prod --build, commit.

Written Nov 1, 2026 after the first River Oaks cut ended every clip on the next clip's first frame.
"""
import argparse, fcntl, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import studio  # noqa: E402
from process_clips import cut_clip, probe as probe_src  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--src", required=True)
    ap.add_argument("--ids", default="")
    a = ap.parse_args()

    # same lock as the auto-editor, so the two never work on one gallery at once
    lock = open(os.path.join(tempfile.gettempdir(), "aerial-abstract-autorender.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)

    site, r2 = studio.Site(a.slug, by="Claude"), studio.R2()
    review = site.review()["review"]
    fps = probe_src(a.src)["fps"]
    man_path = studio.manifest_path(a.slug)
    man = json.load(open(man_path))
    media = os.path.join(studio.ROOT, "public", "media", a.slug)
    want = set(filter(None, a.ids.split(",")))
    todo = [m for m in man["items"] if m["type"] == "video" and m.get("source") == os.path.basename(a.src)
            and "sourceStart" in m and (not want or m["id"] in want)]
    if not todo:
        sys.exit(f"no clips in {a.slug} come from {os.path.basename(a.src)}")

    with tempfile.TemporaryDirectory() as td:
        for m in todo:
            iid = m["id"]
            fa, fb = m.get("sourceFrames") or (round(m["sourceStart"] * fps), round(m["sourceEnd"] * fps))
            rv = review["items"].get(iid) or {}
            edit = rv.get("edit")
            change = studio.describe(edit, m) if edit else "back to the original"
            studio.log(f"{iid}: source frames {fa}-{fb - 1} ({fb - fa} frames); edit: {change}")
            cut = os.path.join(td, f"{iid}.cut.mp4")
            cut_clip(a.src, fa, fb, fps, cut)
            r2.put(f"orig/{a.slug}/{iid}", cut, "video/mp4")
            if change in ("back to the original", "no visible change"):
                full, info = cut, studio.probe(cut)
            else:
                full = os.path.join(td, f"{iid}.out.mp4")
                info = studio.render_video(cut, edit, full)
            size = r2.put(f"full/{a.slug}/{iid}", full, "video/mp4")
            site.call("POST", "/api/admin/upload-done", {"id": iid, "name": m.get("fullFile") or f"{iid}.mp4", "type": "video/mp4"})
            studio.video_preview(full, info, os.path.join(media, f"{iid}.mp4"), os.path.join(media, f"{iid}.jpg"))
            v = f"{rv.get('version') or 0}f"
            m["preview"], m["poster"] = studio.ver_url(m["preview"], v), studio.ver_url(m["poster"], v)
            m["duration"] = round(info["dur"], 2)
            m["sourceFrames"] = [fa, fb]
            studio.log(f"   done: {size / 1e6:.1f} MB, {info['dur']:.2f}s")
            for f in (cut, full):
                if os.path.exists(f):
                    os.remove(f)
    json.dump(man, open(man_path, "w"), indent=2)
    studio.log(f"{len(todo)} clip(s) re-cut. Now: npm run build && netlify deploy --prod --build, then commit.")


if __name__ == "__main__":
    main()
