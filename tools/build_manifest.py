#!/usr/bin/env python3
"""Merge clips.json + photos.json (from the processing scripts) into
clients/<slug>/manifest.json, adding the public preview paths.
Keeps any upsell-only items (e.g. the highlight reel) already in the manifest.

Usage: build_manifest.py --slug river-oaks --work /path/to/work/river-oaks
"""
import argparse, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument("--slug", required=True)
ap.add_argument("--work", required=True)
a = ap.parse_args()

man_path = os.path.join(ROOT, "clients", a.slug, "manifest.json")
old = json.load(open(man_path)) if os.path.exists(man_path) else {"items": []}
keep = [i for i in old["items"] if i.get("upsellOnly")]

items = []
for name in ("clips.json", "photos.json"):
    p = os.path.join(a.work, name)
    if not os.path.exists(p):
        continue
    for it in json.load(open(p)):
        base = f"/media/{a.slug}/{it['id']}"
        if it["type"] == "video":
            it["preview"], it["poster"] = base + ".mp4", base + ".jpg"
        else:
            it["preview"] = base + ".jpg"
        items.append(it)

json.dump({"items": items + keep}, open(man_path, "w"), indent=2)
print(f"{man_path}: {len(items)} items (+{len(keep)} add-on items)")
