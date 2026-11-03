#!/usr/bin/env python3
"""Remake video previews so they carry the clip's own sound (one-time fix, Nov 3, 2026).

  preview_sound.py --slug river-oaks [--ids ground-01,ground-02]

Until Nov 3, 2026 every watermarked preview was made silent, so Keri heard nothing from her Osmo clips in the
studio or gallery even though the delivered files kept their sound. For each video whose delivered file has real
sound (not the silent track drones and some exports carry), this remakes <id>.mp4/.jpg from it, and <id>.orig.*
from the untouched original when the item has one, then bumps the preview's ?v= so browsers fetch the new one.
Next: npm run build, deploy, commit.
"""
import argparse, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import studio  # noqa: E402


def loudness(path):
    err = subprocess.run(["ffmpeg", "-v", "info", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    m = re.search(r"mean_volume: ([-0-9.]+)", err)
    return float(m.group(1)) if m else None


def bump(url):
    m = re.search(r"[?&]v=(\d+)", url or "")
    return studio.ver_url(url, int(m.group(1)) + 1 if m else 2) if url else url


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--ids", default="")
    a = ap.parse_args()
    mpath = studio.manifest_path(a.slug)
    man = json.load(open(mpath))
    media = os.path.join(ROOT, "public", "media", a.slug)
    r2 = studio.R2()
    import fcntl  # the auto-editor (studio.py auto) writes the manifest too: hold its lock while we work
    lock = open(os.path.join(tempfile.gettempdir(), "aerial-abstract-autorender.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    man = json.load(open(mpath))  # re-read under the lock
    want = set(x for x in a.ids.split(",") if x)
    done = []
    with tempfile.TemporaryDirectory() as td:
        for it in man["items"]:
            if it["type"] != "video" or it.get("upsellOnly") or (want and it["id"] not in want):
                continue
            full = os.path.join(td, "full.mp4")
            r2.get(f"full/{a.slug}/{it['id']}", full)
            vol = loudness(full)
            if vol is None or vol < -80:
                continue  # no sound, or a silent track
            info = studio.probe(full)
            studio.video_preview(full, info, os.path.join(media, f"{it['id']}.mp4"), os.path.join(media, f"{it['id']}.jpg"))
            it["preview"], it["poster"] = bump(it.get("preview")), bump(it.get("poster"))
            if it.get("origPreview") and r2.head(f"orig/{a.slug}/{it['id']}"):
                orig = os.path.join(td, "orig.mp4")
                r2.get(f"orig/{a.slug}/{it['id']}", orig)
                base = os.path.join(media, f"{it['id']}.orig")
                studio.video_preview(orig, studio.probe(orig), base + ".mp4", base + ".jpg")
                it["origPreview"], it["origPoster"] = bump(it["origPreview"]), bump(it.get("origPoster"))
            done.append(it["id"])
            studio.log(f"   {it['id']}: preview now has sound ({vol:.0f} dB)")
    json.dump(man, open(mpath, "w"), indent=2)
    studio.log(f"{len(done)} preview(s) remade with sound. Next: npm run build, deploy, commit.")


if __name__ == "__main__":
    main()
