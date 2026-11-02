"""Colored outlines for rooms: no black strokes outside the characters (the author, 2026-10-31).
Every near-black pixel becomes a darker shade of the colour it borders. Thick lines are done
from the outside in (each pass recolours the dark pixels that touch a light one).
  python3 scripts/pixel-selout.py <room>     public/sprites/rooms/<room>.cut.png -> same file (keeps .ink.png)
"""
import os, shutil, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
room = sys.argv[1]
path = os.path.join(ROOT, 'public', 'sprites', 'rooms', f'{room}.cut.png')
ink = path.replace('.cut.png', '.ink.png')
if not os.path.exists(ink): shutil.copy(path, ink)          # always work from the original ink version

a = np.asarray(Image.open(ink).convert('RGBA')).astype(float)
rgb, al = a[..., :3], a[..., 3] > 0
lum = rgb @ np.array([0.299, 0.587, 0.114])
dark = al & (lum < 60)
DARKEN = 0.5
H, W = dark.shape
for _ in range(6):
    if not dark.any(): break
    newrgb = rgb.copy(); fixed = np.zeros_like(dark)
    for y, x in zip(*np.nonzero(dark)):
        acc = [];
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yy, xx = y + dy, x + dx
                if (dy or dx) and 0 <= yy < H and 0 <= xx < W and al[yy, xx] and not dark[yy, xx]:
                    acc.append(rgb[yy, xx])
        if acc:
            c = np.mean(acc, axis=0)
            newrgb[y, x] = c * DARKEN
            fixed[y, x] = True
    rgb = newrgb; dark &= ~fixed
# anything still dark (isolated) -> a deep warm brown instead of black
rgb[dark] = np.array([70, 48, 40])
out = np.dstack([np.clip(rgb, 0, 255), a[..., 3]]).astype(np.uint8)
Image.fromarray(out).save(path)
print(f'{room}: outlines recoloured, {int((al & (lum < 60)).sum())} dark pixels')
