"""Color looks for the final render. Mirrors public/assets/looks.js (keep PRESETS in sync).

look_filter(look) returns an ffmpeg filter chain (or "" for no change), used for both
video clips and photos.
"""

PRESETS = {
    "original":  dict(brightness=0,     contrast=0,     saturation=0,     warmth=0,     fade=0),
    "bright":    dict(brightness=0.06,  contrast=0.05,  saturation=0.10,  warmth=0,     fade=0),
    "warm":      dict(brightness=0.02,  contrast=0.03,  saturation=0.08,  warmth=0.45,  fade=0),
    "cool":      dict(brightness=0,     contrast=0.05,  saturation=0,     warmth=-0.45, fade=0),
    "vivid":     dict(brightness=0.02,  contrast=0.12,  saturation=0.45,  warmth=0,     fade=0),
    "cinematic": dict(brightness=-0.03, contrast=0.15,  saturation=-0.12, warmth=0.15,  fade=0.10),
    "matte":     dict(brightness=0.02,  contrast=-0.10, saturation=-0.10, warmth=0.05,  fade=0.35),
    "bw":        dict(brightness=0,     contrast=0.12,  saturation=-1,    warmth=0,     fade=0),
    "vintage":   dict(brightness=0.02,  contrast=-0.05, saturation=-0.25, warmth=0.35,  fade=0.25),
}
RANGES = dict(brightness=(-0.5, 0.5), contrast=(-0.5, 0.5), saturation=(-1, 1), warmth=(-1, 1), fade=(0, 1))


def effective(look):
    look = look or {}
    p = PRESETS.get(look.get("preset"), PRESETS["original"])
    out = {}
    for k, (lo, hi) in RANGES.items():
        out[k] = min(hi, max(lo, p[k] + float(look.get(k) or 0)))
    return out


def look_filter(look):
    e = effective(look)
    if all(abs(v) < 0.005 for v in e.values()):
        return ""
    parts = []
    if abs(e["warmth"]) >= 0.005:
        # 6500 K is neutral; lower = warmer (more orange), higher = cooler (more blue)
        parts.append(f"colortemperature=temperature={6500 - e['warmth'] * 2600:.0f}:mix={min(1, abs(e['warmth']) * 0.9 + 0.1):.2f}")
    parts.append(f"eq=brightness={e['brightness'] * 0.5:.3f}:contrast={1 + e['contrast']:.3f}:saturation={max(0, 1 + e['saturation']):.3f}")
    if e["fade"] >= 0.005:
        lift, roll = e["fade"] * 0.22, 1 - e["fade"] * 0.05
        parts.append(f"curves=all='0/{lift:.3f} 1/{roll:.3f}'")
    return ",".join(parts)


if __name__ == "__main__":
    import json, sys
    print(look_filter(json.loads(sys.argv[1])))
