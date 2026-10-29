"""Recolor 小克 (characters/Claude) frames: orange hair -> warm red, orange eyes -> amber gold."""
from pathlib import Path

import cv2
import numpy as np

# lbpcascade_animeface by nagadomi (MIT): https://github.com/nagadomi/lbpcascade_animeface
CASCADE = cv2.CascadeClassifier(str(Path(__file__).with_name('lbpcascade_animeface.xml')))

# Parameters (degrees, 0-360)
HAIR_SHIFT = -8.0      # hue shift applied to the orange band
HAIR_LO, HAIR_HI = 4.0, 30.0   # full shift inside, fades to 0 outside
HAIR_FADE = 6.0
HAIR_SAT = 1.08
HAIR_VAL = 0.93
EYE_HUE = 37.0         # target hue for irises
EYE_SAT = 0.95
EYE_VAL = 1.18


class FaceTracker:
    def __init__(self):
        self.box = None
        self.miss = 0
        self.prev_em = None

    def update(self, rgba):
        h, w = rgba.shape[:2]
        scale = 1280.0 / w
        small = cv2.resize(rgba, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        a = small[:, :, 3:4].astype(np.float32) / 255
        bgr = (small[:, :, 2::-1].astype(np.float32) * a + 190 * (1 - a)).astype(np.uint8)
        g = cv2.equalizeHist(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
        faces = CASCADE.detectMultiScale(g, 1.05, 3, minSize=(60, 60))
        best = None
        ys, xs = np.nonzero(small[:, :, 3] > 128)
        if len(faces) and len(ys):
            top, bottom = ys.min(), ys.max()
            left, right = xs.min(), xs.max()
            ch = bottom - top
            cw = right - left
            # the face sits in the upper part of the figure and is large;
            # this drops false hits on the dress, tassels and the book
            ok = [f for f in faces
                  if f[1] + f[3] / 2 < top + ch * 0.6 and f[2] > min(cw, ch) * 0.3]
            if ok:
                f = max(ok, key=lambda r: r[2])
                best = np.array(f, dtype=np.float32) / scale
        if best is not None:
            if self.box is not None and np.abs(best - self.box).max() < best[2] * 0.25:
                self.box = 0.5 * self.box + 0.5 * best
            else:
                self.box = best
            self.miss = 0
        else:
            self.miss += 1
            if self.miss > 6:
                self.box = None
        return self.box


def hue_weight(hdeg, lo, hi, fade):
    w = np.ones_like(hdeg)
    w = np.where(hdeg < lo, np.clip(1 - (lo - hdeg) / fade, 0, 1), w)
    w = np.where(hdeg > hi, np.clip(1 - (hdeg - hi) / fade, 0, 1), w)
    # treat reds just below 0 as below lo
    return w


def eye_mask(hsv, alpha, box):
    """Return float mask of iris pixels inside the face box."""
    H, W = alpha.shape
    m = np.zeros((H, W), np.float32)
    if box is None:
        return m
    x, y, bw, bh = box
    x0 = int(max(0, x - bw * 0.05)); x1 = int(min(W, x + bw * 1.05))
    y0 = int(max(0, y + bh * 0.25)); y1 = int(min(H, y + bh * 0.95))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return m
    sub = hsv[y0:y1, x0:x1]
    hdeg = sub[:, :, 0].astype(np.float32) * 2
    s = sub[:, :, 1].astype(np.float32) / 255
    v = sub[:, :, 2].astype(np.float32) / 255
    orange = ((hdeg >= 2) & (hdeg <= 34) & (s > 0.40) & (v > 0.25) & (alpha[y0:y1, x0:x1] > 128))
    # erode first so a bang tip that overlaps the eye does not merge the
    # iris into the big hair component
    er = max(1, int(round(bw / 100)))
    core = cv2.erode(orange.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=er)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(core, connectivity=4)
    area_box = bw * bh
    keep = np.zeros(n, bool)
    dark = v < 0.35
    lash = max(2, int(bh * 0.06))
    sh, sw = orange.shape
    for i in range(1, n):
        cx, cy, ww, hh, ar = stats[i]
        touches = cx <= 0 or cy <= 0 or cx + ww >= sw or cy + hh >= sh
        if touches:
            continue
        if not (area_box * 0.0008 < ar < area_box * 0.06):
            continue
        if ww > bw * 0.35 or hh > bh * 0.35:
            continue
        # irises sit mid-face, under a dark lash line, and are not mostly dark
        relcy = (cent[i][1] + y0 - y) / bh
        if not (0.3 < relcy < 0.72):
            continue
        if dark[cy:cy + hh, cx:cx + ww].mean() > 0.3:
            continue
        above = dark[max(0, cy - lash):cy, cx:cx + ww]
        if cy == 0 or above.size == 0 or above.mean() < 0.25:
            continue
        # irises are darker on average than lit hair; a half-closed eye can
        # be bright, so allow that when the lash line above is strong
        if v[lab == i].mean() > (0.97 if above.mean() > 0.5 else 0.92):
            continue
        keep[i] = True
    sel = keep[lab].astype(np.uint8)
    if sel.any():
        sel = cv2.dilate(sel, np.ones((3, 3), np.uint8), iterations=er + 1)
        # only recolor orange-ish pixels inside the dilated region
        sel = sel * ((hdeg >= 0) & (hdeg <= 40) & (s > 0.2))
    m[y0:y1, x0:x1] = cv2.GaussianBlur(sel.astype(np.float32), (3, 3), 0)
    return m


def recolor(rgba, tracker, debug=False):
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    # HSV_FULL: H in 0-255 -> convert to degrees
    hdeg = hsv[:, :, 0] * 360.0 / 256.0
    s = hsv[:, :, 1] / 255
    v = hsv[:, :, 2] / 255
    hsv8 = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)  # 0-180 for eye mask helper

    box = tracker.update(rgba)
    em = eye_mask(hsv8, alpha, box)
    # carry the previous iris mask over when this frame misses an eye, so
    # one eye does not flicker back to orange; only iris-like pixels count
    if tracker.prev_em is not None and box is not None:
        cand = (((hdeg <= 40) | (hdeg >= 350)) & (s > 0.35) & (v < 0.95) & (alpha > 128))
        held = tracker.prev_em * cand * 0.9  # no dilation: the hold never grows
        em = np.maximum(em, held)
    tracker.prev_em = em.astype(np.float32)

    # hair band: hue weight * saturation gate (skin/cream/gold-pale stay)
    hw = hue_weight(hdeg, HAIR_LO, HAIR_HI, HAIR_FADE)
    sw = np.clip((s - 0.35) / 0.2, 0, 1)
    wgt = hw * sw * (1 - em)

    nh = hdeg + HAIR_SHIFT * wgt
    ns = np.clip(s * (1 + (HAIR_SAT - 1) * wgt), 0, 1)
    nv = np.clip(v * (1 + (HAIR_VAL - 1) * wgt), 0, 1)

    # eyes
    nh = nh * (1 - em) + (hdeg + (EYE_HUE - 17.0)) * em
    ns = ns * (1 - em) + np.clip(s * EYE_SAT, 0, 1) * em
    nv = nv * (1 - em) + np.clip(v * EYE_VAL, 0, 1) * em

    nh = np.mod(nh, 360.0)
    out_hsv = np.stack([nh * 256.0 / 360.0, ns * 255, nv * 255], -1)
    out_hsv = np.clip(out_hsv, 0, 255).astype(np.uint8)
    out = cv2.cvtColor(out_hsv, cv2.COLOR_HSV2RGB_FULL)
    res = np.dstack([out, alpha])
    if debug:
        return res, em, box
    return res
