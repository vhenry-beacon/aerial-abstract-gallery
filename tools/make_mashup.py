#!/usr/bin/env python3
"""Stitch short snippets into a mashup clip: hard cuts, one color look, full resolution, no audio.

  make_mashup.py --src video.mp4 --pieces "1.0:3.5,52.5:3,64:3" --look warm --brightness 0.04 --out mashup-01.mp4
  make_mashup.py --pieces "C1.mp4@2:3,DJI_0010.MP4@14.5:2.5" --dir RAW --size 3840x2160 --out compilation-h.mp4

--pieces is a list of start:duration pairs in source seconds, each optionally prefixed with FILE@ to take
it from another video (relative to --dir). Each snippet is cut frame-exact (process_clips.cut_clip), so no
snippet shows a frame from the next scene. With several sources, --size (default: the first source's size)
and --fps (default 29.97) make every snippet match: each is scaled to fill the frame and center-cropped.
Audio is dropped: snippet audio jumps at every cut; music goes on later.
Written Nov 2, 2026 for Keri's "three 15-20 second mashups of 2-4 second snippets" request; multi-source
compilations added the same day for River Oaks.
"""
import argparse, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from looks import look_filter  # noqa: E402
from process_clips import probe, run  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src")
    ap.add_argument("--dir", default=".")
    ap.add_argument("--pieces", required=True)
    ap.add_argument("--look", default="original")
    ap.add_argument("--brightness", type=float, default=0)
    ap.add_argument("--size")
    ap.add_argument("--fps", type=float)
    ap.add_argument("--out", required=True)
    ap.add_argument("--crf", type=int, default=16)
    a = ap.parse_args()

    pieces = []
    for p in a.pieces.split(","):
        src, _, span = p.rpartition("@")
        src = os.path.join(a.dir, src) if src else a.src
        s, d = map(float, span.split(":"))
        pieces.append((src, s, d))
    infos = {src: probe(src) for src in {p[0] for p in pieces}}
    multi = len(infos) > 1 or a.size or a.fps
    first = infos[pieces[0][0]]
    W, H = map(int, a.size.split("x")) if a.size else (first["w"], first["h"])
    out_fps = a.fps or 30000 / 1001
    lf = look_filter({"preset": a.look, "brightness": a.brightness})
    frames = 0
    with tempfile.TemporaryDirectory() as td:
        parts = []
        for k, (src, s, d) in enumerate(pieces):
            fps = infos[src]["fps"]
            fa, n = round(s * fps), round(d * fps)
            out = os.path.join(td, f"p{k:02d}.mp4")
            fit = (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},setsar=1,fps={out_fps}"
                   if multi else "")
            vf = ",".join(f for f in ("setpts=PTS-STARTPTS", fit, lf) if f)
            run(["ffmpeg", "-y", "-ss", f"{max(0.0, (fa - 0.5) / fps):.6f}", "-i", src, "-map", "0:v:0", "-an",
                 "-vf", vf, "-frames:v", str(round(d * out_fps) if multi else n), "-c:v", "libx264", "-preset", "veryfast",
                 "-crf", str(a.crf), "-pix_fmt", "yuv420p", "-video_track_timescale", "30000", out])
            parts.append(out)
            frames += round(d * out_fps) if multi else n
        lst = os.path.join(td, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", a.out])
    fps = out_fps if multi else first["fps"]
    print(json.dumps({"out": a.out, "pieces": len(parts), "frames": frames, "seconds": round(frames / fps, 2)}))


if __name__ == "__main__":
    main()
