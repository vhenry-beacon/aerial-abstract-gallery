#!/usr/bin/env python3
"""Make background music for highlight reels on this Mac with Stable Audio 3 Medium (Stability AI, open weights).

  make_music.py --slug river-oaks --reel reel-social-30 --prompt "warm acoustic, gentle" [--seconds 30] [--count 3]
  make_music.py --slug river-oaks --jobs        # what studio.py auto runs: every "Make music" request Keri queued

Stable Audio 3 runs locally through Apple's MLX (installed in ~/Projects/stable-audio-3/optimized/mlx, Nov 3, 2026;
see that folder's README). Under the Stability AI Community License the business owns what it generates and may use
it commercially (free below $1M annual revenue); the model was trained on licensed music, and nothing it makes is
registered with YouTube/Instagram Content ID.

Each track is generated at the reel's own length (so it builds and ends naturally instead of being cut off), leveled
for background use (-16 LUFS, a touch under social apps' -14 so it sits behind the picture), and stored in R2
music/generated/<slug>/<job>-<n>.m4a. The studio's Try sounds lists them as "Made for this reel".
Written Nov 3, 2026.
"""
import argparse, json, os, subprocess, sys, tempfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import studio  # noqa: E402

SA3 = os.path.expanduser("~/Projects/stable-audio-3/optimized/mlx")
# added to every request so the results suit the background of an event video
STYLE = "instrumental background music, no vocals, polished professional production, warm and subtle, mixed for video"
NEGATIVE = "vocals, singing, lyrics, speech, distorted, harsh, noisy, lo-quality, abrupt"


def installed():
    return os.path.exists(os.path.join(SA3, ".venv", "bin", "python")) and \
        os.path.exists(os.path.join(SA3, "models", "mlx", "dit_medium_f16.npz"))


def generate(prompt, seconds, seed, out):
    """One track: Stable Audio 3 Medium -> leveled, gently faded AAC."""
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "x.wav")
        subprocess.run([os.path.join(SA3, ".venv", "bin", "python"), os.path.join(SA3, "scripts", "sa3_mlx.py"),
                        "--prompt", f"{prompt}, {STYLE}", "--negative-prompt", NEGATIVE, "--cfg", "1.5",
                        "--dit", "medium", "--decoder", "same-l", "--seconds", f"{seconds:.1f}", "--seed", str(seed),
                        "--out", wav], cwd=SA3, check=True, capture_output=True, text=True)
        d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-af",
                        f"loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.05,afade=t=out:st={max(0, d - 1.2):.2f}:d=1.2",
                        "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], check=True)


def run_job(site, r2, job, log=print):
    """Make job["count"] versions for one reel request, upload them, and tell the studio."""
    tracks = []
    try:
        if not installed():
            raise RuntimeError("Stable Audio isn't installed on the editing Mac yet")
        with tempfile.TemporaryDirectory() as td:
            for n in range(job.get("count") or 3):
                out = os.path.join(td, f"{n}.m4a")
                seed = int(uuid.uuid4().int % 2_000_000_000)
                log(f"   music {job['id']} #{n + 1}: {job['prompt'][:60]!r}, {job['seconds']:.0f}s")
                generate(job["prompt"], float(job["seconds"]), seed, out)
                key = f"music/generated/{site.slug}/{job['id']}-{n + 1}.m4a"
                r2.put(key, out, "audio/mp4")
                tracks.append({"key": key, "title": f"{job['prompt'][:48]} · version {n + 1}"})
        site.post({"musicJobDone": job["id"], "tracks": tracks})
    except Exception as e:  # report it on the request in the studio instead of failing silently
        err = e.stderr[-300:] if isinstance(e, subprocess.CalledProcessError) and e.stderr else str(e)
        site.post({"musicJobDone": job["id"], "tracks": tracks, "error": err or "Making the music failed"})
        log(f"   music {job['id']} failed: {err}")
    return tracks


def queued(data):
    return [j for j in (data["review"].get("musicJobs") or []) if j.get("status") == "queued"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--jobs", action="store_true")
    ap.add_argument("--reel")
    ap.add_argument("--prompt")
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--count", type=int, default=3)
    a = ap.parse_args()
    site, r2 = studio.Site(a.slug, by="Claude"), studio.R2()
    data = site.review()
    if a.jobs:
        for job in queued(data):
            run_job(site, r2, job, studio.log)
        return
    if not (a.reel and a.prompt):
        ap.error("--reel and --prompt (or --jobs)")
    seconds = a.seconds or next((r["seconds"] for r in data.get("reels", []) if r["id"] == a.reel), 30)
    # queue it like the studio does, then make it right away
    site.call("POST", "/api/admin/review", {"by": "Keri", "musicJob": {"reelId": a.reel, "prompt": a.prompt, "seconds": seconds, "count": a.count}})
    job = queued(site.review())[-1]
    run_job(site, r2, job, studio.log)


if __name__ == "__main__":
    main()
