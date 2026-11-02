#!/usr/bin/env python3
"""Stitch short snippets of one video into a mashup clip: hard cuts, one color look, full resolution, no audio.

  make_mashup.py --src video.mp4 --pieces "1.0:3.5,52.5:3,64:3" --look warm --brightness 0.04 --out mashup-01.mp4

--pieces is a list of start:duration pairs in source seconds. Each snippet is cut frame-exact
(process_clips.cut_clip), so no snippet shows a frame from the next scene. Audio is dropped:
snippet audio jumps at every cut; music goes on later.
Written Nov 2, 2026 for Keri's "three 15-20 second mashups of 2-4 second snippets" request.
"""
import argparse, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from looks import look_filter  # noqa: E402
from process_clips import probe, run  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True)
    ap.add_argument("--pieces", required=True)
    ap.add_argument("--look", default="original")
    ap.add_argument("--brightness", type=float, default=0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--crf", type=int, default=16)
    a = ap.parse_args()

    fps = probe(a.src)["fps"]
    lf = look_filter({"preset": a.look, "brightness": a.brightness})
    frames = 0
    with tempfile.TemporaryDirectory() as td:
        parts = []
        for k, p in enumerate(a.pieces.split(",")):
            s, d = map(float, p.split(":"))
            fa, n = round(s * fps), round(d * fps)
            out = os.path.join(td, f"p{k:02d}.mp4")
            vf = ",".join(f for f in ("setpts=PTS-STARTPTS", lf) if f)
            run(["ffmpeg", "-y", "-ss", f"{max(0.0, (fa - 0.5) / fps):.6f}", "-i", a.src, "-map", "0:v:0", "-an",
                 "-vf", vf, "-frames:v", str(n), "-c:v", "libx264", "-preset", "veryfast", "-crf", str(a.crf),
                 "-pix_fmt", "yuv420p", out])
            parts.append(out)
            frames += n
        lst = os.path.join(td, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", a.out])
    print(json.dumps({"out": a.out, "pieces": len(parts), "frames": frames, "seconds": round(frames / fps, 2)}))


if __name__ == "__main__":
    main()
