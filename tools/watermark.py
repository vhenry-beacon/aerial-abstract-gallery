"""Shared watermark overlay for photo and video previews."""
import math
from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
TEXT = "AERIAL ABSTRACT  ·  PREVIEW"


def _font(size):
    # Linux (original build machine) first, then macOS system fonts: Avenir Next Demi Bold, Arial Bold.
    for p, idx in ((FONT_BOLD, 0), ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
                   ("/System/Library/Fonts/Avenir Next.ttc", 2), ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0)):
        try:
            return ImageFont.truetype(p, size, index=idx)
        except OSError:
            pass
    return ImageFont.load_default()


def watermark_overlay(w: int, h: int, opacity: int = 62, center_y: float = 0.5) -> Image.Image:
    """Transparent RGBA layer: repeated diagonal text plus a centered label."""
    diag = int(math.hypot(w, h))
    size = max(14, int(min(w, h) / 22))
    font = _font(size)
    layer = Image.new("RGBA", (diag, diag), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tw = d.textlength(TEXT, font=font)
    step_x, step_y = int(tw + size * 3), int(size * 4.2)
    for row, y in enumerate(range(0, diag, step_y)):
        off = (row % 2) * step_x // 2
        for x in range(-step_x, diag, step_x):
            d.text((x + off + 1, y + 1), TEXT, font=font, fill=(0, 0, 0, opacity // 2))
            d.text((x + off, y), TEXT, font=font, fill=(255, 255, 255, opacity))
    layer = layer.rotate(28, resample=Image.BICUBIC)
    left, top = (diag - w) // 2, (diag - h) // 2
    out = layer.crop((left, top, left + w, top + h))
    # centered stronger label
    d2 = ImageDraw.Draw(out)
    big = _font(max(18, int(min(w, h) / 11)))
    label = "PREVIEW"
    bw = d2.textlength(label, font=big)
    d2.text(((w - bw) / 2 + 2, h * center_y - big.size / 2 + 2), label, font=big, fill=(0, 0, 0, 70))
    d2.text(((w - bw) / 2, h * center_y - big.size / 2), label, font=big, fill=(255, 255, 255, 120))
    return out


if __name__ == "__main__":
    import sys
    w, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    watermark_overlay(w, h).save(out)
