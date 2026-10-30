"""Regenerates Cardlake's raster icons in public/ from the card mark in
public/favicon.svg. Run by hand when the mark changes (needs Pillow); the
output is committed, so nothing runs this at build or deploy time.

    python scripts/generate_icons.py

The mark is the one the site's nav shows (the vault header's .cardle-mark): a 34-unit
rounded square (radius 10) with a 135deg #4a86e9 -> #42b3e7 gradient, and the
white two-card glyph drawn 18 units wide in its centre. The glyph's 24-unit
box is offset by (-0.5, 1.3), as in the SVG viewBox, so the tilted back card
is centred and not clipped.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parents[1] / "public"
GRADIENT = ((0x4a, 0x86, 0xe9), (0x42, 0xb3, 0xe7))  # as in favicon.svg
WHITE = (255, 255, 255, 255)
SUPERSAMPLE = 8

MARK = 34                   # the mark's own units
RADIUS = 10
GLYPH_AT, GLYPH_SIZE = 8, 18
VIEWBOX = (-0.5, 1.3, 24)   # the glyph's viewBox: x, y, size
STROKE = 2.2


def gradient_square(size: int, radius: float) -> Image.Image:
    # 135deg on a square runs corner to corner: t = (x + y) / (2 * size)
    down = Image.linear_gradient("L")                       # 0 at the top, 255 at the bottom
    ramp = Image.blend(down.rotate(90), down, .5).resize((size, size), Image.BICUBIC)
    (r0, g0, b0), (r1, g1, b1) = GRADIENT
    image = Image.merge("RGB", [ramp.point(lambda t, a=a, b=b: round(a + (b - a) * t / 255)) for a, b in ((r0, r1), (g0, g1), (b0, b1))]).convert("RGBA")
    mask = Image.new("L", (size, size))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    image.putalpha(mask)
    return image


def to_px(gx: float, gy: float, unit: float) -> tuple[float, float]:
    """A point in glyph (viewBox) coordinates, in pixels on the icon."""
    vx, vy, vs = VIEWBOX
    k = GLYPH_SIZE / vs
    return (GLYPH_AT + (gx - vx) * k) * unit, (GLYPH_AT + (gy - vy) * k) * unit


def card_outline(size: int, box: tuple[float, float, float, float], unit: float) -> Image.Image:
    # SVG strokes straddle the path; Pillow draws outlines inside the box, so
    # grow the box by half the stroke to land in the same place.
    k = GLYPH_SIZE / VIEWBOX[2] * unit
    stroke = STROKE * k
    x0, y0 = to_px(box[0], box[1], unit)
    x1, y1 = to_px(box[0] + box[2], box[1] + box[3], unit)
    layer = Image.new("RGBA", (size, size))
    ImageDraw.Draw(layer).rounded_rectangle(
        (x0 - stroke / 2, y0 - stroke / 2, x1 + stroke / 2, y1 + stroke / 2),
        radius=2 * k + stroke / 2, outline=WHITE, width=round(stroke))
    return layer


def render(px: int, rounded: bool) -> Image.Image:
    size = px * SUPERSAMPLE
    unit = size / MARK
    image = gradient_square(size, RADIUS * unit if rounded else 0)
    # rotate(-8 10 14) in SVG (y points down) is 8 degrees counterclockwise,
    # which is Pillow's positive direction.
    back = card_outline(size, (3, 5, 14, 18), unit).rotate(8, resample=Image.BICUBIC, center=to_px(10, 14, unit))
    image.alpha_composite(back)
    image.alpha_composite(card_outline(size, (7, 3, 14, 18), unit))
    return image.resize((px, px), Image.LANCZOS)


def main() -> None:
    render(192, rounded=True).save(PUBLIC / "icon-192.png", optimize=True)
    render(512, rounded=True).save(PUBLIC / "icon-512.png", optimize=True)
    # Android crops maskable icons to its own shape and keeps only a centred
    # circle of 80% width; the glyph already sits inside it, so the square
    # just runs to the edges.
    render(512, rounded=False).convert("RGB").save(PUBLIC / "icon-maskable-512.png", optimize=True)
    # iOS applies its own corner mask and shows transparency as black.
    render(180, rounded=False).convert("RGB").save(PUBLIC / "apple-touch-icon.png", optimize=True)
    render(256, rounded=True).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == "__main__":
    main()
