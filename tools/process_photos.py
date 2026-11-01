#!/usr/bin/env python3
"""Photo pipeline for a client gallery.

For every JPG/JPEG/HEIC/PNG in --src:
  1. Convert HEIC to JPEG (and fix rotation).
  2. Apply a gentle auto-enhance: levels, shadow lift, vibrance, light sharpening.
  3. Write the full-resolution deliverable to --full  (photo-01.jpg ...).
  4. Write a watermarked, low-res preview to --preview (photo-01.jpg ...).
Prints JSON manifest items to stdout (merge with tools/build_manifest.py).

Usage: process_photos.py --src DIR --full DIR --preview DIR [--no-enhance]
"""
import argparse, glob, json, os, sys
import numpy as np
from PIL import Image, ImageOps, ImageFilter, ImageDraw, ImageFont
import pillow_heif

pillow_heif.register_heif_opener()
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from watermark import watermark_overlay  # noqa: E402

PREVIEW_LONG_EDGE = 1600


def enhance(im: Image.Image) -> Image.Image:
    a = np.asarray(im).astype(np.float32) / 255.0
    lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    # 1) gentle levels: stretch 0.3–99.7 percentile, blended 50% with original
    lo, hi = np.percentile(lum, [0.3, 99.7])
    if hi - lo > 0.2:
        stretched = np.clip((a - lo) / (hi - lo), 0, 1)
        a = 0.5 * a + 0.5 * stretched
    # 2) shadow lift: stronger for dark (night) frames
    mean = float(lum.mean())
    k = 0.32 if mean < 0.30 else 0.14 if mean < 0.45 else 0.06
    a = a + k * a * (1 - a) ** 2
    # 3) vibrance: boost low-saturation pixels more than saturated ones
    mx, mn = a.max(axis=2, keepdims=True), a.min(axis=2, keepdims=True)
    sat = mx - mn
    l2 = a.mean(axis=2, keepdims=True)
    boost = 0.14 * (1 - sat)
    a = l2 + (a - l2) * (1 + boost)
    out = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))
    # 4) light sharpening scaled to resolution
    return out.filter(ImageFilter.UnsharpMask(radius=max(1.2, im.width / 2400), percent=55, threshold=3))


def classify(path: str, im: Image.Image) -> str:
    name = os.path.basename(path).upper()
    if name.endswith(".HEIC"):
        return "ground"
    # DJI drones shoot 4:3 here; the Osmo Pocket 3 shoots 16:9 (3840x2160)
    if name.startswith("DJI_") and abs(im.width / im.height - 4 / 3) < 0.02:
        return "aerial"
    return "ground"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--full", required=True)
    ap.add_argument("--preview", required=True)
    ap.add_argument("--no-enhance", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.full, exist_ok=True)
    os.makedirs(args.preview, exist_ok=True)

    files = sorted(
        f for f in glob.glob(os.path.join(args.src, "*"))
        if f.lower().endswith((".jpg", ".jpeg", ".heic", ".png")) and not os.path.basename(f).startswith("._")
    )
    loaded = []
    for f in files:
        im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        loaded.append((classify(f, im), f, im))
    # aerials first (the headline product), then ground shots; chronological within each
    loaded.sort(key=lambda t: (0 if t[0] == "aerial" else 1, os.path.basename(t[1])))

    items = []
    counters = {"aerial": 0, "ground": 0}
    for n, (kind, f, im) in enumerate(loaded, 1):
        counters[kind] += 1
        pid = f"photo-{n:02d}"
        full = im if args.no_enhance else enhance(im)
        full_path = os.path.join(args.full, f"{pid}.jpg")
        exif = Image.open(f).info.get("exif") if not f.lower().endswith(".heic") else None
        full.save(full_path, "JPEG", quality=94, subsampling=0, **({"exif": exif} if exif else {}))

        pv = full.copy()
        pv.thumbnail((PREVIEW_LONG_EDGE, PREVIEW_LONG_EDGE), Image.LANCZOS)
        pv = Image.alpha_composite(pv.convert("RGBA"), watermark_overlay(pv.width, pv.height)).convert("RGB")
        pv.save(os.path.join(args.preview, f"{pid}.jpg"), "JPEG", quality=72, progressive=True)

        items.append({
            "id": pid, "type": "photo",
            "title": f"{'Aerial' if kind == 'aerial' else 'Ground'} photo {counters[kind]}",
            "category": kind,
            "orientation": "portrait" if full.height > full.width else "landscape",
            "width": full.width, "height": full.height,
            "source": os.path.basename(f), "fullFile": f"{pid}.jpg",
        })
        print(f"  {pid}  {kind:6s}  {os.path.basename(f)}", file=sys.stderr)
    json.dump(items, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
