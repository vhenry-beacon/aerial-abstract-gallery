#!/usr/bin/env python3
"""Split an edited long video into individual scene clips for a client gallery.

1. Detects hard cuts (scene changes) in the source.
2. Builds clips of --min to --max seconds: short scenes are merged with their
   neighbours, long scenes are divided into even pieces.
3. Writes full-quality clips (H.264, original resolution + audio) to --full
   and small watermarked, silent previews + poster frames to --preview.
Prints JSON manifest items to stdout.

Usage: process_clips.py --src video.mp4 [--src2 more.mp4] --full DIR --preview DIR
                        [--min 10] [--max 15] [--threshold 0.30] [--prefix clip]
"""
import argparse, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from watermark import watermark_overlay  # noqa: E402


def probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path])
    d = json.loads(out)
    s = d["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    return {"w": s["width"], "h": s["height"], "fps": num / den, "dur": float(d["format"]["duration"])}


def scene_cuts(path, threshold):
    """Return timestamps (seconds) of hard cuts."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-an",
           "-vf", f"scale=240:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"]
    p = subprocess.run(cmd, stderr=subprocess.PIPE, text=True)
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", p.stderr)]


def plan_segments(cuts, dur, lo, hi, min_scene=1.0):
    bounds = [0.0] + [c for c in cuts if 0.5 < c < dur - 0.5] + [dur]
    scenes = [(a, b) for a, b in zip(bounds, bounds[1:]) if b - a >= min_scene]
    segs = []
    cur = None
    for a, b in scenes:
        if cur is None:
            cur = [a, b]
        elif (cur[1] - cur[0]) < lo and (b - cur[0]) <= hi + 3:
            cur[1] = b  # merge a short scene into the running clip
        else:
            segs.append(cur)
            cur = [a, b]
    if cur:
        if segs and (cur[1] - cur[0]) < lo * 0.6 and (cur[1] - segs[-1][0]) <= hi + 5:
            segs[-1][1] = cur[1]
        else:
            segs.append(cur)
    out = []
    for a, b in segs:
        length = b - a
        if length <= hi + 3:
            out.append((a, b))
        else:  # split long scenes into even pieces near the target length
            n = max(2, round(length / ((lo + hi) / 2)))
            step = length / n
            out += [(a + i * step, a + (i + 1) * step) for i in range(n)]
    return [(round(a, 3), round(b, 3)) for a, b in out if b - a >= 3]


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cut_clip(src, fa, fb, fps, out, crf=16):
    """Full-quality clip of source frames fa..fb-1 exactly (fb is the first frame of the next clip).

    Cuts are counted in frames, not seconds: seeking half a frame before frame fa and keeping exactly
    fb - fa frames means the clip never ends on the next scene's first frame (the old seconds-based
    -t cut did, on every clip, because the rounded end landed just past that frame).
    """
    # Only the frame count limits the video (an extra seconds-based -t dropped the last frame on some clips);
    # the sound is trimmed to the same length.
    run(["ffmpeg", "-y", "-ss", f"{max(0.0, (fa - 0.5) / fps):.6f}", "-i", src,
         "-map", "0:v:0", "-map", "0:a:0?", "-vf", "setpts=PTS-STARTPTS", "-frames:v", str(fb - fa),
         "-af", f"asetpts=PTS-STARTPTS,atrim=end={(fb - fa) / fps:.6f}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, action="append")
    ap.add_argument("--full", required=True)
    ap.add_argument("--preview", required=True)
    ap.add_argument("--min", type=float, default=10)
    ap.add_argument("--max", type=float, default=15)
    ap.add_argument("--threshold", type=float, default=0.30)
    ap.add_argument("--prefix", default="clip")
    ap.add_argument("--start-index", type=int, default=1)
    ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--crf", type=int, default=16)
    args = ap.parse_args()
    os.makedirs(args.full, exist_ok=True)
    os.makedirs(args.preview, exist_ok=True)

    items, n = [], args.start_index
    for src in args.src:
        info = probe(src)
        cuts = scene_cuts(src, args.threshold)
        segs = plan_segments(cuts, info["dur"], args.min, args.max)
        print(f"{os.path.basename(src)}: {info['w']}x{info['h']} {info['fps']:.2f}fps {info['dur']:.1f}s, "
              f"{len(cuts)} cuts -> {len(segs)} clips", file=sys.stderr)
        if args.plan_only:
            for a, b in segs:
                print(f"  {a:8.2f} - {b:8.2f}  ({b - a:5.2f}s)", file=sys.stderr)
            continue

        portrait = info["h"] > info["w"]
        pw = 540 if portrait else 960
        ph = int(round(info["h"] * pw / info["w"] / 2) * 2)
        with tempfile.TemporaryDirectory() as td:
            wm = os.path.join(td, "wm.png")
            watermark_overlay(pw, ph).save(wm)
            for a, b in segs:
                cid = f"{args.prefix}-{n:02d}"
                full = os.path.join(args.full, f"{cid}.mp4")
                fa, fb = round(a * info["fps"]), round(b * info["fps"])  # scene cuts land on whole frames
                a, b = round(fa / info["fps"], 3), round(fb / info["fps"], 3)
                # full quality: frame-exact cut, original resolution, audio kept (AAC)
                cut_clip(src, fa, fb, info["fps"], full, args.crf)
                # preview: small, silent, watermarked
                run(["ffmpeg", "-y", "-i", full, "-i", wm, "-filter_complex",
                     f"[0:v]scale={pw}:{ph},fps=30[v];[v][1:v]overlay=0:0",
                     "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
                     "-movflags", "+faststart", os.path.join(args.preview, f"{cid}.mp4")])
                run(["ffmpeg", "-y", "-ss", f"{min(1.0, (b - a) / 2)}", "-i", os.path.join(args.preview, f"{cid}.mp4"),
                     "-frames:v", "1", "-q:v", "4", os.path.join(args.preview, f"{cid}.jpg")])
                items.append({
                    "id": cid, "type": "video", "title": f"Clip {n:02d}",
                    "duration": round(b - a, 2), "orientation": "portrait" if portrait else "landscape",
                    "width": info["w"], "height": info["h"],
                    "source": os.path.basename(src), "sourceStart": a, "sourceEnd": b,
                    "sourceFrames": [fa, fb],
                    "fullFile": f"{cid}.mp4",
                })
                print(f"  {cid}  {a:7.2f}-{b:7.2f}  {os.path.getsize(full) / 1e6:6.1f} MB", file=sys.stderr)
                n += 1
    json.dump(items, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
