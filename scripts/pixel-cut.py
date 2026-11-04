"""Cuts a drawn room into true pixel art: finds the pixel grid, samples one colour per block, clears the backdrop.
  python3 scripts/pixel-cut.py room <room>      public/sprites/rooms/<room>.png -> <room>.cut.png
"""
import json, os, sys
from collections import Counter
import numpy as np
from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPR = os.path.join(ROOT, 'public', 'sprites')


def _period(profile, pmin=3.5, pmax=30.0, with_mag=False):
    """Fractional period + phase of a 1-D edge profile (Fourier sweep, 0.01 px steps)."""
    x = np.arange(len(profile)); pr = profile - profile.mean(); best = (0.0, pmin, 0.0)
    for per in np.arange(pmin, pmax, 0.01):
        c = (pr * np.exp(-2j * np.pi * x / per)).sum()
        if abs(c) > best[0]: best = (abs(c), per, (-np.angle(c) / (2 * np.pi) * per) % per)
    return (best[1], best[2], best[0]) if with_mag else (best[1], best[2])


def detect_block(im, prefer=None):
    """The image model draws pixel art on a NON-whole grid (11.47 px blocks on a 1376 px sheet,
    5.1 px on a 1024 px room). Measure the exact period and phase from where colours change."""
    a = np.asarray(im.convert('RGB')).astype(int)
    ex = (np.abs(np.diff(a, axis=1)).sum(axis=2) > 60).sum(axis=0).astype(float)
    ey = (np.abs(np.diff(a, axis=0)).sum(axis=2) > 60).sum(axis=1).astype(float)
    px, ox = _period(ex); py, oy = _period(ey)
    if prefer:                                          # rooms: the model draws on a 5.1 px grid; the sweep sometimes locks onto 2x or 3x of it (a half-size, chunky cut)
        (qx, qox, mqx), (qy, qoy, mqy) = _period(ex, *prefer, with_mag=True), _period(ey, *prefer, with_mag=True)
        (_, _, mx), (_, _, my) = _period(ex, with_mag=True), _period(ey, with_mag=True)
        if (px + py) / 2 > prefer[1] and mqx >= 0.3 * mx and mqy >= 0.3 * my: px, ox, py, oy = qx, qox, qy, qoy
    n = (px + py) / 2                                   # blocks are square
    return n, (ox + 1) % n, (oy + 1) % n                # diff index j = boundary at j+1


def resample(im, n, ox, oy, key=True, spill=True):
    """One colour per block = the majority colour of the block's inner pixels (a 25% margin is
    skipped on each side, so anti-aliased block borders never vote)."""
    a = np.asarray(im.convert('RGBA')).astype(int); h, w = a.shape[:2]
    cols = int((w - ox) // n); rows = int((h - oy) // n)
    out = Image.new('RGBA', (cols, rows)); op = out.load()
    m = n * 0.25
    for r in range(rows):
        y0, y1 = int(round(oy + r * n + m)), int(round(oy + (r + 1) * n - m))
        for c in range(cols):
            x0, x1 = int(round(ox + c * n + m)), int(round(ox + (c + 1) * n - m))
            blk = a[y0:max(y1, y0 + 1), x0:max(x1, x0 + 1)].reshape(-1, 4)
            rgb = blk[:, :3]
            bg = np.zeros(len(rgb), bool) if not key else ((rgb[:, 0] > 150) & (rgb[:, 2] > 150) & (rgb[:, 1] < 110)) | ((rgb[:, 1] > 160) & (rgb[:, 1] > rgb[:, 0] * 1.8) & (rgb[:, 1] > rgb[:, 2] * 1.8))
            fg = rgb[~bg]
            if len(fg) <= bg.sum() or len(fg) == 0: op[c, r] = (0, 0, 0, 0); continue
            keys = (fg[:, 0] >> 3) * 1024 + (fg[:, 1] >> 3) * 32 + (fg[:, 2] >> 3)
            vals, cnt = np.unique(keys, return_counts=True); k = vals[cnt.argmax()]
            sel = fg[keys == k].mean(axis=0).astype(int)
            r_, g_, b_ = int(sel[0]), int(sel[1]), int(sel[2])
            if spill and r_ > g_ + 60 and b_ > g_ + 60: r_, b_ = g_ + 60, g_ + 60     # magenta spill
            op[c, r] = (r_, g_, b_, 255)
    return out


def quantize(im, colors=48):
    rgb = im.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA')
    rgb.putalpha(im.getchannel('A'))
    return rgb


def clear_backdrop(small):
    """The model is told to paint a flat magenta backdrop, but sometimes paints a noisy pink/purple one that the
    magenta key misses (dark stains around the room, a square-looking room). Take the colours that touch the picture's
    edge as the backdrop palette and clear every connected pixel of those colours."""
    a = np.asarray(small.convert('RGBA')).astype(int); h, w = a.shape[:2]
    op = a[..., 3] > 0
    ring = np.zeros((h, w), bool); ring[:3, :] = ring[-3:, :] = ring[:, :3] = ring[:, -3:] = True
    ring &= op
    if not ring.any(): return small
    vals, cnt = np.unique(a[ring][:, :3], axis=0, return_counts=True)
    pal = vals[cnt >= max(3, ring.sum() * 0.004)]                      # the colours that really make up the backdrop
    if not len(pal): return small
    like = np.zeros((h, w), bool)
    for c in pal: like |= (np.abs(a[..., :3] - c).sum(axis=2) < 36)
    like &= op
    reach = ring & like
    while True:                                                         # flood from the edge through backdrop-coloured pixels
        g = reach.copy()
        g[1:, :] |= reach[:-1, :]; g[:-1, :] |= reach[1:, :]; g[:, 1:] |= reach[:, :-1]; g[:, :-1] |= reach[:, 1:]
        g &= like
        if (g == reach).all(): break
        reach = g
    a[reach, 3] = 0
    return Image.fromarray(a.astype('uint8'), 'RGBA')


job = sys.argv[1]
if job == 'room':
    room = sys.argv[2]
    im = Image.open(os.path.join(SPR, 'rooms', f'{room}.png'))
    n, ox, oy = detect_block(im, prefer=(4.4, 6.2))
    print(f'{room}: block {n:.2f}px, phase ({ox:.1f},{oy:.1f})')
    small = resample(im, n, ox, oy)
    # Things the model paints magenta or green inside the room (a purple cabinet, pink neon, green trim) match the backdrop key and came out
    # as see-through holes (the author, 2026-11-04: "white stains all over"). Only key colour reachable from the picture's edge is backdrop:
    # a hole enclosed by the room gets its drawn colour back.
    k = np.asarray(small).copy(); clear = k[..., 3] == 0
    outside = np.zeros_like(clear); outside[[0, -1], :] = clear[[0, -1], :]; outside[:, [0, -1]] |= clear[:, [0, -1]]
    while True:
        g = outside.copy(); g[1:, :] |= outside[:-1, :]; g[:-1, :] |= outside[1:, :]; g[:, 1:] |= outside[:, :-1]; g[:, :-1] |= outside[:, 1:]
        g &= clear
        if (g == outside).all(): break
        outside = g
    holes = clear & ~outside
    if holes.any():
        k[holes] = np.asarray(resample(im, n, ox, oy, key=False, spill=False))[holes]; small = Image.fromarray(k)
        print(f'  filled {int(holes.sum())} hole pixels')
    small = clear_backdrop(quantize(small, 96))
    small = small.crop(small.getbbox())
    small.save(os.path.join(SPR, 'rooms', f'{room}.cut.png'))
    print(f'  -> {small.size[0]}x{small.size[1]}')
    # Grain: the model sometimes draws on a grid twice as big (10 px blocks); cut on the 5 px grid, every art pixel then comes out doubled
    # (a half-resolution, chunky room) and colour changes sit only on every other column and row. Good rooms measure 0.4-1.0, doubled ones 0.1-0.3.
    a = np.asarray(small.convert('RGBA')).astype(int); op = a[..., 3] > 200
    edges_x = ((np.abs(np.diff(a[..., :3], axis=1)).sum(-1) > 30) & op[:, 1:] & op[:, :-1]).sum(0)
    edges_y = ((np.abs(np.diff(a[..., :3], axis=0)).sum(-1) > 30) & op[1:] & op[:-1]).sum(1)
    grain = max(min(e[0::2].sum(), e[1::2].sum()) / max(e[0::2].sum(), e[1::2].sum(), 1) for e in (edges_x, edges_y))
    print(f'  grain {grain:.2f}' + ('  (doubled pixels: drawn on a coarse grid)' if grain < 0.35 else ''))
