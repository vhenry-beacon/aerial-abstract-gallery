// Color looks shared by the review studio (live CSS preview) and tools/looks.py (final ffmpeg render).
// A look = a preset plus slider adjustments. Keep PRESETS in sync with tools/looks.py.
window.Looks = (() => {
  const PRESETS = {
    original:  { label: "Original",      brightness: 0,    contrast: 0,     saturation: 0,     warmth: 0,     fade: 0 },
    bright:    { label: "Bright & clean", brightness: 0.06, contrast: 0.05,  saturation: 0.10,  warmth: 0,     fade: 0 },
    warm:      { label: "Warm golden",   brightness: 0.02, contrast: 0.03,  saturation: 0.08,  warmth: 0.45,  fade: 0 },
    cool:      { label: "Cool blue",     brightness: 0,    contrast: 0.05,  saturation: 0,     warmth: -0.45, fade: 0 },
    vivid:     { label: "Vivid",         brightness: 0.02, contrast: 0.12,  saturation: 0.45,  warmth: 0,     fade: 0 },
    cinematic: { label: "Cinematic",     brightness: -0.03, contrast: 0.15, saturation: -0.12, warmth: 0.15,  fade: 0.10 },
    matte:     { label: "Soft matte",    brightness: 0.02, contrast: -0.10, saturation: -0.10, warmth: 0.05,  fade: 0.35 },
    bw:        { label: "Black & white", brightness: 0,    contrast: 0.12,  saturation: -1,    warmth: 0,     fade: 0 },
    vintage:   { label: "Vintage",       brightness: 0.02, contrast: -0.05, saturation: -0.25, warmth: 0.35,  fade: 0.25 },
  };
  const SLIDERS = [
    { key: "brightness", label: "Brightness", min: -0.5, max: 0.5 },
    { key: "contrast", label: "Contrast", min: -0.5, max: 0.5 },
    { key: "saturation", label: "Color", min: -1, max: 1 },
    { key: "warmth", label: "Warmth", min: -1, max: 1 },
    { key: "fade", label: "Fade", min: 0, max: 1 },
  ];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Preset values plus the slider offsets, clamped to each slider's range.
  function effective(look) {
    const p = PRESETS[look?.preset] || PRESETS.original;
    const out = {};
    for (const s of SLIDERS) out[s.key] = clamp(p[s.key] + (Number(look?.[s.key]) || 0), s.min, s.max);
    return out;
  }
  function isOriginal(look) {
    const e = effective(look);
    return SLIDERS.every((s) => Math.abs(e[s.key]) < 0.005);
  }
  // Browser approximation. The rendered file uses ffmpeg's eq / colortemperature / curves.
  function cssFilter(look) {
    if (!look || isOriginal(look)) return "none";
    const e = effective(look);
    const f = [
      `brightness(${(1 + e.brightness + e.fade * 0.06).toFixed(3)})`,
      `contrast(${(1 + e.contrast - e.fade * 0.22).toFixed(3)})`,
      `saturate(${Math.max(0, 1 + e.saturation).toFixed(3)})`,
    ];
    if (e.warmth > 0) f.push(`sepia(${(e.warmth * 0.32).toFixed(3)})`);
    if (e.warmth < 0) f.push(`sepia(${(-e.warmth * 0.25).toFixed(3)}) hue-rotate(175deg) saturate(${(1 - e.warmth * 0.3).toFixed(3)})`);
    return f.join(" ");
  }
  return { PRESETS, SLIDERS, effective, isOriginal, cssFilter };
})();
