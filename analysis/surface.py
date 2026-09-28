"""Surface prospecting: finding a good spot with density readings.

A density reading costs 3 durability (three samples a few blocks apart) and reports the ore map at the first
sample. We simulate a player who walks in a straight line from a random spot, taking a reading every D blocks,
until one reaches a target word; then optionally climbs toward the patch centre with compass readings.
We also measure patch sizes: how many shafts fit in a patch at the recommended spacing.

  uv run python analysis/surface.py w4k_s1 w4k_s2 w4k_s3
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from report_data import READING_CODE
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
ORES = ["nativecopper", "cassiterite", "bismuthinite", "sphalerite", "hematite", "magnetite", "galena", "chromite", "ilmenite", "pentlandite", "cinnabar", "quartz_nativesilver", "quartz_nativegold"]
TARGETS = {"decent": 4 / 15, "high": 6 / 15}
SPACINGS = [16, 32, 48, 64, 96, 128]
MAX_WALK = 6000
TRIALS = 3000
READING_COST = 3
SHAFT_SPACING = {"nativecopper": 32, "hematite": 64, "magnetite": 64}   # others: 24 (from the spacing study)


def grid(s: Survey, code):
    sp = s.meta["readingSpacing"]
    r = s.q("SELECT x, z, total_factor FROM readings WHERE ore = :o", o=code)
    g = np.zeros((s.size_z // sp, s.size_x // sp), dtype=np.float32)
    g[(r.z - s.z0) // sp, (r.x - s.x0) // sp] = r.total_factor
    return g, sp


def walk(g, sp, D, thr, rng):
    """Straight walks in random directions; distance (blocks) and readings until a reading >= thr."""
    n = g.shape[0]
    start = rng.uniform(0, n * sp, size=(TRIALS, 2))
    ang = rng.uniform(0, 2 * np.pi, size=TRIALS)
    step = np.stack([np.cos(ang), np.sin(ang)], 1) * D
    dist = np.full(TRIALS, np.nan)
    for k in range(int(MAX_WALK / D) + 1):
        p = start + step * k
        # reflect at the survey edge (the player turns around)
        p = np.abs(p) % (2 * n * sp)
        p = np.where(p >= n * sp, 2 * n * sp - p - 1, p)
        i = (p / sp).astype(int).clip(0, n - 1)
        hit = np.isnan(dist) & (g[i[:, 1], i[:, 0]] >= thr)
        dist[hit] = k * D
        if not np.isnan(dist).any():
            break
    return dist


def climb(g, sp, thr, S, rng, words):
    """From random spots that read >= thr, take compass readings S blocks away and step to the best
    while it improves. Returns readings used and start/final reading."""
    n = g.shape[0]
    cand = np.argwhere(g >= thr)
    if len(cand) == 0:
        return None
    pick = cand[rng.integers(0, len(cand), size=min(2000, len(cand)))]
    k = max(1, S // sp)
    out = []
    for zi, xi in pick:
        v0 = g[zi, xi]
        v, readings = v0, 0
        for _ in range(20):
            nb = [(zi + dz, xi + dx) for dz, dx in ((k, 0), (-k, 0), (0, k), (0, -k))]
            nb = [(a, b) for a, b in nb if 0 <= a < n and 0 <= b < n]
            readings += len(nb)
            best = max(nb, key=lambda t: g[t])
            if g[best] <= v:
                break
            (zi, xi), v = best, g[best]
        out.append((readings, v0, v))
    a = np.array(out)
    return {"readings": float(a[:, 0].mean()), "start": float(a[:, 1].mean()), "final": float(a[:, 2].mean()),
            "final_word": {w: float((a[:, 2] >= t).mean()) for w, t in words.items()}}


def patches(g, sp, thr, spacing):
    lab, n = ndimage.label(g >= thr)
    if n == 0:
        return None
    area = np.bincount(lab.ravel())[1:] * sp * sp
    # size seen by a player standing in a random good spot = area-weighted
    w = area / area.sum()
    order = np.argsort(area)
    cum = np.cumsum(w[order])
    med = area[order][np.searchsorted(cum, 0.5)]
    return {"count_per_km2": float(n / (g.size * sp * sp) * 1e6), "median_area_seen": float(med),
            "shafts_in_median_patch": float(med / spacing ** 2),
            "share_of_map": float((g >= thr).mean())}


def main(names):
    rng = np.random.default_rng(3)
    surveys = [Survey(n) for n in names]
    out = {"spacings": SPACINGS, "targets": list(TARGETS), "reading_cost": READING_COST, "ores": {}}
    words = {"decent": 4 / 15, "high": 6 / 15, "very high+": 8 / 15}
    for ore in ORES:
        code = READING_CODE.get(ore, ore)
        grids = [grid(s, code) for s in surveys]
        o = {"walk": {}, "climb": {}, "patch": {}}
        for tname, thr in TARGETS.items():
            o["walk"][tname] = {}
            for D in SPACINGS:
                d = np.concatenate([walk(g, sp, D, thr, rng) for g, sp in grids])
                found = ~np.isnan(d)
                o["walk"][tname][D] = {"found": float(found.mean()),
                                       "median_walk": float(np.median(d[found])) if found.any() else None,
                                       "mean_readings": float(np.mean(d[found] / D + 1)) if found.any() else None}
            sub = [p for p in (patches(g, sp, thr, SHAFT_SPACING.get(ore, 24)) for g, sp in grids) if p]
            o["patch"][tname] = {k: float(np.mean([p[k] for p in sub])) for k in sub[0]} if sub else None
        for S in (32, 64, 128):
            res = [c for c in (climb(g, sp, TARGETS["decent"], S, rng, words) for g, sp in grids) if c]
            if res:
                o["climb"][S] = {"readings": float(np.mean([r["readings"] for r in res])),
                                 "start": float(np.mean([r["start"] for r in res])),
                                 "final": float(np.mean([r["final"] for r in res])),
                                 "final_word": {w: float(np.mean([r["final_word"][w] for r in res])) for w in words}}
        out["ores"][ore] = o
        print(ore, json.dumps(o["walk"]["decent"][32]), json.dumps(o["walk"]["high"][32]), json.dumps(o["patch"]), json.dumps(o["climb"].get(64)), flush=True)
    (ROOT / "data/surface.json").write_text(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:] or ["w4k_s1", "w4k_s2", "w4k_s3"])
