#!/usr/bin/env python3
"""Build Aerial Abstract's ready-made music catalog with Stable Audio 3 on this Mac (tools/make_music.py).

  build_music_catalog.py [--only cinematic,lofi] [--lengths 8,15,30] [--versions 2] [--dry-run]

Each scenario is made at several lengths so a reel can use a track that *ends naturally* close to its own length
(the studio offers, per scenario, the shortest track at least as long as the reel; the reel builder trims the rest
with a short fade). Tracks go to R2 music/library/<scenario>/<seconds>s-<A|B>.m4a and are listed in
lib/music-library.json, which the studio's Try sounds reads (deploy after a rebuild). Re-running skips tracks that
are already in the catalog, so it can be stopped and resumed.
Written Nov 3, 2026, after Vernon found "Make music" too slow to wait for (the Mac checks for requests every 15 min).
"""
import argparse, json, os, sys, tempfile, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import studio  # noqa: E402
from make_music import generate, installed  # noqa: E402

SCENARIOS = [
    ("warm-acoustic", "Warm acoustic", "warm gentle acoustic guitar and soft piano, light percussion, uplifting and heartfelt, 100 BPM",
     "Family moments, community events, opening shots"),
    ("bright-upbeat", "Bright & upbeat", "bright upbeat indie pop, acoustic guitar strums, hand claps, light drums, happy and energetic, 118 BPM",
     "Festivals, kids playing, fast social reels"),
    ("cinematic", "Cinematic", "cinematic inspiring, soft piano, warm strings, gentle build to an uplifting swell, 90 BPM",
     "Drone flyovers, website and YouTube reels, the venue"),
    ("soft-calm", "Soft & calm", "calm soft felt piano and airy ambient pads, peaceful and reflective, 76 BPM",
     "Ceremonies, prayer halls, quiet and emotional moments"),
    ("lofi", "Lo-fi", "mellow lofi chillhop, warm electric piano, soft dusty drums, relaxed and cozy, 84 BPM",
     "Sunsets, slower vertical reels, casual moments"),
    ("percussion", "Percussion only", "hand percussion only, frame drum, darbuka and hand claps, festive and warm, no melodic instruments, 96 BPM",
     "Clients who prefer no musical instruments; energetic and respectful"),
    ("elegant", "Elegant celebration", "elegant romantic strings and piano, graceful and joyful, light orchestral, 88 BPM",
     "Weddings, galas, formal celebrations"),
    ("clean-modern", "Clean modern", "clean modern corporate, soft plucked synths, light electronic beat, positive and confident, 110 BPM",
     "Business, real estate, construction and property reels"),
]
LENGTHS = [8, 15, 30, 45, 60, 90]
LIB = os.path.join(ROOT, "lib", "music-library.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="")
    ap.add_argument("--lengths", default=",".join(map(str, LENGTHS)))
    ap.add_argument("--versions", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not installed():
        sys.exit("Stable Audio isn't installed (see tools/make_music.py)")
    lengths = [int(x) for x in a.lengths.split(",")]
    lib = json.load(open(LIB)) if os.path.exists(LIB) else []
    have = {t["id"] for t in lib}
    r2 = studio.R2()
    todo = [(s, L, v) for s in SCENARIOS if not a.only or s[0] in a.only.split(",") for L in lengths
            for v in "AB"[: a.versions] if f"{s[0]}-{L}-{v}" not in have]
    studio.log(f"{len(todo)} track(s) to make ({sum(L for _, L, _ in todo)} s of music)")
    if a.dry_run:
        return
    with tempfile.TemporaryDirectory() as td:
        for k, ((sid, title, prompt, good), L, v) in enumerate(todo, 1):
            out = os.path.join(td, "t.m4a")
            # a fixed seed per track, so a rebuild makes the same catalog; A and B differ by seed
            generate(prompt, float(L), zlib.crc32(f"{sid}-{L}-{v}".encode()) % 2_000_000_000, out)
            key = f"music/library/{sid}/{L}s-{v}.m4a"
            r2.put(key, out, "audio/mp4")
            lib.append({"id": f"{sid}-{L}-{v}", "scenario": sid, "title": title, "version": v, "seconds": L,
                        "mood": prompt.split(",")[0].strip().capitalize(), "goodFor": good, "key": key,
                        "source": "Made for Aerial Abstract with Stable Audio 3 (Stability AI Community License): owned, free for client use."})
            lib.sort(key=lambda t: ([s[0] for s in SCENARIOS].index(t["scenario"]) if t.get("scenario") in [s[0] for s in SCENARIOS] else 99,
                                    t["seconds"], t["version"]))
            json.dump(lib, open(LIB, "w"), indent=1)  # saved after every track, so a stop loses nothing
            studio.log(f"   {k}/{len(todo)} {sid} {L}s {v}")
    studio.log(f"catalog: {len(lib)} track(s) in lib/music-library.json. Next: commit and deploy.")


if __name__ == "__main__":
    main()
