#!/usr/bin/env python3
"""Compose Aerial Abstract's own royalty-free music for highlight reels (numpy synthesis + ffmpeg mastering).

  compose_music.py --out DIR [--only golden-hour,frame-drum] [--upload]

Every track is original (written by this script), so it's free to use in any client video with no license,
no attribution and nothing for YouTube/Instagram Content ID to claim. Each is ~100 s so it covers the longest
reel, gets going within two seconds for the short ones, and is mastered to -14 LUFS (the loudness social apps
normalize to). --upload puts them in R2 music/library/<id>.m4a, where the studio's Sound menu offers them;
the track list itself is lib/music-library.json.
Written Nov 3, 2026.
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
rng = np.random.default_rng(7)

NOTE = {n: i for i, n in enumerate(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])}


def hz(name):
    """'A4' -> 440.0"""
    n, o = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((NOTE[n] + 12 * (o + 1) - 69) / 12)


def chord(root, kind="maj", octave=3):
    r = NOTE[root] + 12 * (octave + 1)
    steps = {"maj": (0, 4, 7), "min": (0, 3, 7), "sus2": (0, 2, 7), "maj7": (0, 4, 7, 11), "min7": (0, 3, 7, 10), "add9": (0, 4, 7, 14)}[kind]
    return [440.0 * 2 ** ((r + s - 69) / 12) for s in steps]


def env(n, a=0.005, d=0.1, s=0.6, r=0.1, length=None):
    """ADSR envelope of n samples (times in seconds)."""
    t = np.arange(n) / SR
    length = length if length is not None else n / SR
    e = np.where(t < a, t / max(a, 1e-6), 1.0)
    e = np.where((t >= a) & (t < a + d), 1 - (1 - s) * (t - a) / max(d, 1e-6), e)
    e = np.where(t >= a + d, s, e)
    rel = np.clip((t - (length - r)) / max(r, 1e-6), 0, 1)
    return e * (1 - rel)


# ---------------- instruments (each returns a mono note) ----------------
def pluck(f, dur, vel=1.0, bright=0.5):
    """Karplus-Strong string, computed a period at a time."""
    n = int(dur * SR); p = max(2, int(SR / f))
    out = np.empty(n + p)
    out[:p] = lp(rng.uniform(-1, 1, p), 3 + int(4 * (1 - bright))) * vel * 1.6  # softened pluck: warmer, less hiss
    decay = 0.996 - 0.004 * (1 - bright)
    i = p
    while i < n + p:
        prev = out[i - p:i]
        blk = decay * 0.5 * (prev + np.concatenate(([out[i - p - 1] if i - p - 1 >= 0 else 0], prev[:-1])))
        k = min(p, n + p - i)
        out[i:i + k] = blk[:k]
        i += k
    y = out[p:]
    return y * env(n, 0.002, 0.05, 0.9, 0.08)


def epiano(f, dur, vel=1.0):
    t = np.arange(int(dur * SR)) / SR
    mod = 1.6 * np.exp(-t * 3) * np.sin(2 * np.pi * f * t)
    y = np.sin(2 * np.pi * f * t + mod) + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 4)
    return 0.5 * vel * y * np.exp(-t * 1.6) * env(len(t), 0.004, 0.1, 1, 0.12)


def piano(f, dur, vel=1.0):
    t = np.arange(int(dur * SR)) / SR
    y = sum(a * np.sin(2 * np.pi * f * k * t * (1 + 0.0004 * k * k)) * np.exp(-t * (1.2 + 0.9 * k))
            for k, a in ((1, 1), (2, 0.45), (3, 0.25), (4, 0.12), (5, 0.06)))
    return 0.45 * vel * y * env(len(t), 0.003, 0.05, 1, 0.1)


def mallet(f, dur, vel=1.0):
    t = np.arange(int(dur * SR)) / SR
    y = np.sin(2 * np.pi * f * t) * np.exp(-t * 5) + 0.35 * np.sin(2 * np.pi * 3.93 * f * t) * np.exp(-t * 14) \
        + 0.12 * np.sin(2 * np.pi * 9.2 * f * t) * np.exp(-t * 30)
    return 0.6 * vel * y * env(len(t), 0.001, 0.02, 1, 0.05)


def pad(freqs, dur, vel=1.0, warm=0.6):
    """Detuned, softened saw-ish chord with a slow swell."""
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    for f in freqs:
        for det in (-0.004, 0.0, 0.0045):
            for k in range(1, 9):
                if f * k > 5000:
                    break
                y += (1 / k) * (warm ** (k - 1)) * np.sin(2 * np.pi * f * (1 + det) * k * t + rng.uniform(0, 6.28))
    y /= max(1, len(freqs) * 3)
    return 0.5 * vel * y * env(len(t), min(0.8, dur / 3), 0.2, 0.9, min(0.9, dur / 3))


def bass(f, dur, vel=1.0):
    t = np.arange(int(dur * SR)) / SR
    y = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    return 0.55 * vel * y * env(len(t), 0.006, 0.08, 0.7, 0.06)


def noise(n):
    return rng.uniform(-1, 1, n)


def hp(x, amt=1):
    for _ in range(amt):
        x = np.diff(x, prepend=0)
    return x


def lp(x, k=8):
    return np.convolve(x, np.ones(k) / k, mode="same")


def kick(vel=1.0):
    t = np.arange(int(0.35 * SR)) / SR
    f = 45 + 85 * np.exp(-t * 30)
    return vel * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def clap(vel=1.0):
    n = int(0.25 * SR); t = np.arange(n) / SR
    e = np.exp(-t * 30) + 0.6 * np.exp(-((t - 0.012) ** 2) / 1e-5) + 0.4 * np.exp(-((t - 0.024) ** 2) / 1e-5)
    return 0.5 * vel * hp(noise(n), 1) * e


def snap(vel=1.0):
    n = int(0.08 * SR); t = np.arange(n) / SR
    return 0.45 * vel * hp(noise(n), 2) * np.exp(-t * 70)


def hat(vel=1.0, open_=False):
    n = int((0.25 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return 0.22 * vel * hp(noise(n), 3) * np.exp(-t * (12 if open_ else 80))


def shaker(vel=1.0):
    n = int(0.12 * SR); t = np.arange(n) / SR
    return 0.18 * vel * hp(noise(n), 2) * np.sin(np.pi * t / t[-1]) ** 2


def frame_drum(vel=1.0, tone="dum"):
    """Frame drum (daf/riq-style): deep 'dum' or bright edge 'tek'."""
    n = int((0.6 if tone == "dum" else 0.18) * SR); t = np.arange(n) / SR
    if tone == "dum":
        body = np.sin(2 * np.pi * (70 + 25 * np.exp(-t * 20)) * t) * np.exp(-t * 6)
        skin = lp(noise(n), 30) * np.exp(-t * 25) * 0.6
        return 0.9 * vel * (body + skin)
    ring = sum(np.sin(2 * np.pi * f * t) for f in (380, 610, 870)) / 3
    return 0.5 * vel * (hp(noise(n), 1) * np.exp(-t * 45) + 0.5 * ring * np.exp(-t * 28))


def jingles(vel=1.0):
    n = int(0.3 * SR); t = np.arange(n) / SR
    y = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6)) for f in (5200, 6100, 7300, 8800)) / 4
    return 0.12 * vel * (y + 0.6 * hp(noise(n), 3)) * np.exp(-t * 14)


# ---------------- arranging ----------------
class Mix:
    def __init__(self, seconds):
        self.L = np.zeros(int((seconds + 4) * SR)); self.R = np.zeros_like(self.L)

    def put(self, x, at, gain=1.0, pan=0.0):
        i = int(at * SR)
        if i >= len(self.L):
            return
        x = x[: len(self.L) - i] * gain
        self.L[i:i + len(x)] += x * np.sqrt(0.5 * (1 - pan))
        self.R[i:i + len(x)] += x * np.sqrt(0.5 * (1 + pan))


def reverb(mix, seconds=1.8, wet=0.18):
    n = int(seconds * SR); t = np.arange(n) / SR
    out = []
    for ch, seed in ((mix.L, 1), (mix.R, 2)):
        ir = np.random.default_rng(seed).normal(0, 1, n) * np.exp(-t * 6.9 / seconds)
        ir[:int(0.012 * SR)] = 0
        ir /= np.sqrt((ir ** 2).sum())
        m = len(ch) + n
        size = 1 << (m - 1).bit_length()
        r = np.fft.irfft(np.fft.rfft(ch, size) * np.fft.rfft(ir, size), size)[: len(ch)]
        out.append(ch + wet * r * 3)
    mix.L, mix.R = out


def bars(bpm, beats=4):
    return beats * 60 / bpm


def golden_hour(m, total):
    """Warm acoustic pop: plucked guitar arpeggios, soft kick + clap, bass. G - D - Em - C, 108 BPM."""
    bpm = 108; B = bars(bpm); b = B / 4
    prog = [("G", "maj"), ("D", "maj"), ("E", "min"), ("C", "add9")]
    nbars = int(total / B) + 1
    for k in range(nbars):
        t0 = k * B; root, kind = prog[k % 4]
        notes = chord(root, kind, 3) + [chord(root, kind, 4)[1]]
        for s, step in enumerate([0, 2, 1, 2, 3, 2, 1, 2]):
            m.put(pluck(notes[step % len(notes)], 1.2, 0.7 + 0.2 * (s % 2 == 0), 0.6), t0 + s * b / 2, 0.55, -0.35)
        if k >= 1:
            m.put(bass(chord(root, kind, 1)[0], b * 1.8), t0, 0.7)
            m.put(bass(chord(root, kind, 1)[0], b * 1.6), t0 + 2.5 * b, 0.55)
        if k >= 2:
            for q in range(4):
                m.put(kick(0.9), t0 + q * b, 0.8 if q % 2 == 0 else 0.45)
            m.put(clap(), t0 + b, 0.45, 0.1); m.put(clap(), t0 + 3 * b, 0.45, 0.1)
        if k >= 6 and (k // 8) % 2 == 1:  # lift: shaker and a high melody every other section
            for e in range(8):
                m.put(shaker(), t0 + e * b / 2, 0.8, 0.4)
            m.put(pluck(chord(root, kind, 5)[(k % 3)], 1.5, 0.8, 0.8), t0 + 2 * b, 0.35, 0.3)


def festival_lights(m, total):
    """Bright upbeat pop: piano stabs, four-on-the-floor, claps, offbeat hats. C - G - Am - F, 120 BPM."""
    bpm = 120; B = bars(bpm); b = B / 4
    prog = [("C", "maj"), ("G", "maj"), ("A", "min"), ("F", "maj")]
    for k in range(int(total / B) + 1):
        t0 = k * B; root, kind = prog[k % 4]
        for q, dur in ((0, 1.5), (1.5, 1.0), (2.5, 1.5)):
            for f in chord(root, kind, 4):
                m.put(piano(f, b * dur * 1.2, 0.8), t0 + q * b, 0.35, 0.15)
        m.put(bass(chord(root, kind, 2)[0], b * 0.9), t0, 0.6)
        m.put(bass(chord(root, kind, 2)[0], b * 0.9), t0 + 1.5 * b, 0.5)
        m.put(bass(chord(root, kind, 2)[0], b * 0.9), t0 + 2.5 * b, 0.5)
        if k >= 1:
            for q in range(4):
                m.put(kick(), t0 + q * b, 0.85)
                m.put(hat(0.9), t0 + q * b + b / 2, 0.9, 0.3)
            m.put(clap(), t0 + b, 0.55); m.put(clap(), t0 + 3 * b, 0.55)
        if (k // 8) % 2 == 1:
            mel = chord(root, kind, 5)
            for s, i in enumerate((0, 1, 2, 1)):
                m.put(mallet(mel[i], 0.5, 0.7), t0 + s * b, 0.3, -0.3)


def gathering(m, total):
    """Cinematic and warm: swelling pads, piano arpeggio, toms enter later. D - Bm - G - A, 84 BPM."""
    bpm = 84; B = bars(bpm); b = B / 4
    prog = [("D", "add9"), ("B", "min7"), ("G", "maj7"), ("A", "sus2")]
    for k in range(int(total / B) + 1):
        t0 = k * B; root, kind = prog[k % 4]
        m.put(pad(chord(root, kind, 3), B * 1.05, 0.9), t0, 0.5)
        notes = chord(root, kind, 4)
        for s in range(8):
            m.put(piano(notes[s % len(notes)], b * 1.5, 0.55 + 0.15 * (s == 0)), t0 + s * b / 2, 0.35, -0.2 + 0.4 * (s % 2))
        m.put(bass(chord(root, kind, 1)[0], B * 0.95), t0, 0.5)
        if k >= 4:
            m.put(frame_drum(0.8, "dum"), t0, 0.55); m.put(frame_drum(0.6, "dum"), t0 + 2.5 * b, 0.45)
        if k >= 8:
            m.put(frame_drum(0.7, "tek"), t0 + b, 0.35); m.put(frame_drum(0.7, "tek"), t0 + 3 * b, 0.35)


def little_moments(m, total):
    """Playful: marimba patterns, finger snaps, bouncy bass. F - C - Dm - Bb, 104 BPM."""
    bpm = 104; B = bars(bpm); b = B / 4
    prog = [("F", "maj"), ("C", "maj"), ("D", "min"), ("A#", "maj")]
    for k in range(int(total / B) + 1):
        t0 = k * B; root, kind = prog[k % 4]
        n = chord(root, kind, 4)
        for s, i in enumerate((0, 2, 1, 2, 0, 2, 1, 3 if len(n) > 3 else 2)):
            m.put(mallet(n[i % len(n)], 0.6, 0.75), t0 + s * b / 2, 0.45, 0.25)
        m.put(bass(chord(root, kind, 2)[0], b * 0.5), t0, 0.6)
        m.put(bass(chord(root, kind, 2)[2], b * 0.5), t0 + 1.5 * b, 0.5)
        m.put(bass(chord(root, kind, 2)[0], b * 0.5), t0 + 2 * b, 0.55)
        if k >= 1:
            m.put(snap(), t0 + b, 0.7, -0.3); m.put(snap(), t0 + 3 * b, 0.7, -0.3)
            m.put(kick(0.7), t0, 0.6); m.put(kick(0.6), t0 + 2 * b, 0.5)
        if (k // 8) % 2 == 1:
            for e in range(8):
                m.put(shaker(), t0 + e * b / 2, 0.7, 0.4)


def frame_drum_track(m, total):
    """Percussion only (no melody instruments): frame drum, hand claps, jingles, shaker. 96 BPM."""
    bpm = 96; B = bars(bpm); b = B / 4
    for k in range(int(total / B) + 1):
        t0 = k * B
        m.put(frame_drum(1.0, "dum"), t0, 0.8)
        m.put(frame_drum(0.7, "tek"), t0 + b, 0.5, -0.2)
        m.put(frame_drum(0.8, "dum"), t0 + 1.5 * b, 0.55)
        m.put(frame_drum(0.7, "tek"), t0 + 2 * b, 0.5, 0.2)
        m.put(frame_drum(0.9, "dum"), t0 + 2.75 * b, 0.55)
        m.put(frame_drum(0.7, "tek"), t0 + 3 * b, 0.5, -0.2)
        if k >= 2:
            for e in range(8):
                m.put(shaker(0.9), t0 + e * b / 2, 0.8, 0.45)
        if k >= 4:
            m.put(clap(0.8), t0 + b, 0.35, 0.3); m.put(clap(0.8), t0 + 3 * b, 0.35, -0.3)
        if k >= 6 and (k // 4) % 2 == 1:
            for e in range(4):
                m.put(jingles(), t0 + e * b + b / 2, 0.8, 0.5)


def evening_glow(m, total):
    """Mellow lo-fi: electric piano 7ths, laid-back beat, soft vinyl hiss. Am7 - Dm7 - Gmaj7 - Cmaj7, 82 BPM."""
    bpm = 82; B = bars(bpm); b = B / 4
    prog = [("A", "min7"), ("D", "min7"), ("G", "maj7"), ("C", "maj7")]
    for k in range(int(total / B) + 1):
        t0 = k * B; root, kind = prog[k % 4]
        for q, d in ((0, 1.6), (2.25, 1.4)):
            for j, f in enumerate(chord(root, kind, 3)):
                m.put(epiano(f, b * d * 1.3, 0.7), t0 + q * b + j * 0.012, 0.4, 0.1)
        m.put(bass(chord(root, kind, 1)[0], b * 1.6), t0, 0.6)
        m.put(bass(chord(root, kind, 1)[2], b * 0.8), t0 + 2.5 * b, 0.45)
        if k >= 1:
            m.put(kick(0.8), t0, 0.7); m.put(kick(0.6), t0 + 2.6 * b, 0.55)
            m.put(lp(clap(0.8), 6), t0 + b, 0.45); m.put(lp(clap(0.8), 6), t0 + 3 * b, 0.45)
            for e in range(8):
                m.put(hat(0.6 + 0.3 * (e % 2 == 0)), t0 + e * b / 2 + (0.03 if e % 2 else 0), 0.7, 0.35)
    hiss = lp(noise(len(m.L)), 3) * 0.008
    m.L += hiss; m.R += np.roll(hiss, 3000)


TRACKS = [
    ("golden-hour", "Golden Hour", golden_hour, "Warm and uplifting · plucked guitar", "Family moments, the crowd, opening shots", 108),
    ("festival-lights", "Festival Lights", festival_lights, "Bright and upbeat · piano and claps", "Fast social reels, bounce houses, kids playing", 120),
    ("gathering", "Gathering", gathering, "Cinematic and warm · builds slowly", "Website and YouTube reels, the building, drone flyovers", 84),
    ("little-moments", "Little Moments", little_moments, "Playful · marimba and snaps", "Kids, face painting, balloons, short reels", 104),
    ("frame-drum", "Frame Drum", frame_drum_track, "Percussion only · no melody instruments", "Clients who prefer no musical instruments; energetic and respectful", 96),
    ("evening-glow", "Evening Glow", evening_glow, "Mellow lo-fi · electric piano", "Sunset shots, slower vertical reels", 82),
]


def render(tid, fn, out_dir, seconds=100):
    m = Mix(seconds)
    fn(m, seconds)
    reverb(m, 1.6 if tid != "frame-drum" else 1.1, 0.16)
    n = int(seconds * SR)
    st = np.stack([m.L[:n], m.R[:n]], axis=1)
    fade = int(2.5 * SR)
    st[-fade:] *= np.linspace(1, 0, fade)[:, None]
    st /= max(1e-9, np.abs(st).max()) * 1.05
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "x.f32")
        st.astype(np.float32).tofile(raw)
        out = os.path.join(out_dir, f"{tid}.m4a")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", raw,
                        "-af", "highpass=f=32,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=200,"
                               "loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.89",
                        "-ar", "44100", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], check=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--upload", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    lib = []
    for tid, title, fn, mood, good_for, bpm in TRACKS:
        if a.only and tid not in a.only.split(","):
            continue
        path = render(tid, fn, a.out)
        print(f"{tid}: {os.path.getsize(path) / 1e6:.1f} MB", flush=True)
        lib.append({"id": tid, "title": title, "mood": mood, "goodFor": good_for, "bpm": bpm, "seconds": 100,
                    "key": f"music/library/{tid}.m4a", "source": "Original, made for Aerial Abstract. Free to use in any client video."})
    if a.upload:
        sys.path.insert(0, HERE)
        import studio
        r2 = studio.R2()
        for t in lib:
            r2.put(t["key"], os.path.join(a.out, f"{t['id']}.m4a"), "audio/mp4")
        path = os.path.join(ROOT, "lib", "music-library.json")
        old = json.load(open(path)) if os.path.exists(path) else []
        keep = [t for t in old if t["id"] not in {x["id"] for x in lib}]
        json.dump(keep + lib, open(path, "w"), indent=1)
        print(f"uploaded {len(lib)} track(s); lib/music-library.json now lists {len(keep) + len(lib)}")


if __name__ == "__main__":
    main()
