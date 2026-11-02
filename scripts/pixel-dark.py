"""How much of a room is dark? Prints "<dark> <very dark> <blobs>" as shares of the opaque pixels.
  python3 scripts/pixel-dark.py <room>      public/sprites/rooms/<room>.cut.png
<blobs> = dark pixels that sit inside a dark patch at least 5 px thick (outlines and small dark details do not count):
the dark stains / black areas people hate. Measured: good rooms <= 0.011, black-stained rooms >= 0.031."""
import os, sys
import numpy as np
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
im = np.asarray(Image.open(os.path.join(ROOT, 'public', 'sprites', 'rooms', sys.argv[1] + '.cut.png')).convert('RGBA')).astype(int)
opaque = im[..., 3] > 200
lum = (im[..., 0] * 299 + im[..., 1] * 587 + im[..., 2] * 114) / 1000
n = max(int(opaque.sum()), 1)
dark = (lum < 45) & opaque; vdark = (lum < 22) & opaque
patch = (lum < 60) & opaque
core = patch.copy()                                   # erosion by a 5x5 square: only patches thicker than 4 px survive
H, W = patch.shape
for dy in range(-2, 3):
    for dx in range(-2, 3):
        sh = np.zeros_like(patch); ys, yd = (slice(dy, None), slice(0, H - dy)) if dy >= 0 else (slice(0, H + dy), slice(-dy, None))
        xs, xd = (slice(dx, None), slice(0, W - dx)) if dx >= 0 else (slice(0, W + dx), slice(-dx, None))
        sh[yd, xd] = patch[ys, xs]
        core &= sh
print(round(dark.sum() / n, 3), round(vdark.sum() / n, 3), round(core.sum() / n, 3))
