#!/usr/bin/env python3
"""Build a ~30s highlight reel from chosen moments, with crossfades, a title
card and optional licensed music. Also writes a watermarked low-res preview.

Usage:
  make_reel.py --src video.mp4 --moments "1.0:4.5,47.8:3.5,..." \
     --title "Fall Festival" --subtitle "River Oaks Islamic Center" \
     --out full/highlight-reel.mp4 --preview public/media/<slug>/reel-sample.mp4 \
     [--music track.mp3] [--width 1080]
--moments is a list of start:duration pairs (seconds in the source).
"""
import argparse, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from watermark import watermark_overlay  # noqa: E402

SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
SANS = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
XF = 0.4  # crossfade seconds


def esc(t):
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace(",", "\\,")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--moments", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--endcard", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", required=True)
    ap.add_argument("--music")
    ap.add_argument("--width", type=int, default=1080)
    a = ap.parse_args()

    moments = [tuple(map(float, m.split(":"))) for m in a.moments.split(",")]
    W = a.width
    H = int(W * 16 / 9)
    inputs, chains = [], []
    for i, (s, d) in enumerate(moments):
        inputs += ["-ss", str(s), "-t", str(d), "-i", a.src]
        chains.append(f"[{i}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30,format=yuv420p,setpts=PTS-STARTPTS[v{i}]")
    # chain crossfades
    last, offset = "v0", moments[0][1]
    for i in range(1, len(moments)):
        offset -= XF
        out = f"x{i}"
        chains.append(f"[{last}][v{i}]xfade=transition=fade:duration={XF}:offset={offset:.3f}[{out}]")
        last = out
        offset += moments[i][1]
    total = offset
    ts, ss = int(W / 8.5), int(W / 26)
    title = (f"drawtext=fontfile={SERIF}:text='{esc(a.title)}':fontsize={ts}:fontcolor=white:"
             f"x=(w-text_w)/2:y=h*0.40:shadowcolor=black@0.55:shadowx=3:shadowy=3:"
             f"alpha='if(lt(t,0.4),t/0.4,if(lt(t,3.6),1,max(0,(4.2-t)/0.6)))':enable='lt(t,4.2)'")
    sub = (f"drawtext=fontfile={SANS}:text='{esc(a.subtitle.upper())}':fontsize={ss}:fontcolor=white:"
           f"x=(w-text_w)/2:y=h*0.40+{int(ts * 1.25)}:shadowcolor=black@0.55:shadowx=2:shadowy=2:"
           f"alpha='if(lt(t,0.7),max(0,(t-0.3)/0.4),if(lt(t,3.6),1,max(0,(4.2-t)/0.6)))':enable='lt(t,4.2)'") if a.subtitle else None
    endc = (f"drawtext=fontfile={SANS}:text='{esc(a.endcard.upper())}':fontsize={ss}:fontcolor=white:"
            f"x=(w-text_w)/2:y=h*0.46:shadowcolor=black@0.6:shadowx=2:shadowy=2:"
            f"alpha='min(1,max(0,(t-{total - 3.2:.2f})/0.5))':enable='gte(t,{total - 3.2:.2f})'") if a.endcard else None
    fx = ",".join(f for f in (title, sub, endc) if f)
    chains.append(f"[{last}]{fx},fade=t=out:st={total - 0.6:.2f}:d=0.6[vout]")

    cmd = ["ffmpeg", "-y", *inputs]
    maps = ["-map", "[vout]"]
    if a.music:
        cmd += ["-i", a.music]
        chains.append(f"[{len(moments)}:a]atrim=0:{total:.2f},afade=t=in:d=0.5,afade=t=out:st={total - 1.5:.2f}:d=1.5[aout]")
        maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-filter_complex", ";".join(chains), *maps, "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", a.out]
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    pw, ph = 540, 960
    with tempfile.TemporaryDirectory() as td:
        wm = os.path.join(td, "wm.png")
        watermark_overlay(pw, ph, center_y=0.72).save(wm)
        pcmd = ["ffmpeg", "-y", "-i", a.out, "-i", wm, "-filter_complex", f"[0:v]scale={pw}:{ph}[v];[v][1:v]overlay=0:0",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        pcmd += ["-c:a", "aac", "-b:a", "96k"] if a.music else ["-an"]
        subprocess.run(pcmd + [a.preview], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["ffmpeg", "-y", "-ss", "1.6", "-i", a.preview, "-frames:v", "1", "-q:v", "4",
                    a.preview.rsplit(".", 1)[0] + ".jpg"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"reel: {total:.1f}s -> {a.out}; preview -> {a.preview}")


if __name__ == "__main__":
    main()
