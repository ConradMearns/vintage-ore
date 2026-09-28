"""How far apart should consecutive shafts be?

For each spacing d, lay out 4x4 grids of shafts ("patches") at random places, dig them one after another
with a shared set of mined bodies, and compare every shaft with the same shaft dug on untouched ground.
Output: data/spacing.json (per ore, per spacing, per reading word).

  uv run python analysis/spacing.py w4k_s1 w4k_s2 w4k_s3
"""
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

import bodies as B
from miner import OreIndex, Run, Strategy
from report_data import READING_CODE, WORD_ORDER, report_word
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
SPACINGS = [6, 8, 10, 13, 16, 20, 24, 32, 48]
GRID = 4
PATCHES = 150          # per world, per ore, per spacing
# Recommended method per ore from the depth study (R6 every 13, stopping depth).
ORES = {"nativecopper": 999, "cassiterite": 80, "hematite": 80, "bismuthinite": 96, "sphalerite": 96, "magnetite": 999}

G = {}


class Ground:
    """Per world: surface, reading grid for each ore, cave air for the columns we will dig, ore indexes."""

    def __init__(self, s: Survey, blocks, bodies, cols):
        self.s = s
        self.h = s.heightmap()
        sp = s.meta["readingSpacing"]
        self.sp = sp
        self.read = {}
        for ore in ORES:
            code = READING_CODE.get(ore, ore)
            r = s.q("SELECT x, z, total_factor FROM readings WHERE ore = :o", o=code)
            g = np.zeros((s.size_z // sp, s.size_x // sp), dtype=np.float32)
            g[(r.z - s.z0) // sp, (r.x - s.x0) // sp] = r.total_factor
            self.read[ore] = g
        s.db.execute("CREATE TEMP TABLE want(x INTEGER, z INTEGER)")
        s.db.executemany("INSERT INTO want VALUES (?, ?)", list(cols))
        air = pd.read_sql_query("SELECT a.x, a.z, a.y0, a.y1 FROM air_runs a JOIN want w ON a.x = w.x AND a.z = w.z", s.db)
        self.air = {}
        for x, z, y0, y1 in air.itertuples(index=False):
            self.air.setdefault((x, z), []).append((y0, y1))
        self.idx = {ore: OreIndex(blocks[blocks.ore == ore], bodies[bodies.ore == ore]) for ore in ORES}

    def surface(self, x, z):
        return int(self.h[z - self.s.z0, x - self.s.x0])

    def reading(self, ore, x, z):
        s, sp = self.s, self.sp
        return float(self.read[ore][(z - s.z0) // sp, (x - s.x0) // sp])


def patch_origins(s: Survey, seed):
    rng = np.random.default_rng(seed)
    span = (GRID - 1) * max(SPACINGS)
    lo = 16
    hi = s.size_x - span - 16
    return rng.integers(lo, hi, size=(PATCHES, 2)) + np.array([s.x0, s.z0])


def patch_cells(origin, d):
    return [(int(origin[0] + i * d), int(origin[1] + j * d)) for j in range(GRID) for i in range(GRID)]


def _task(args):
    wi, ore, d = args
    g, origins = G[wi]
    st = Strategy(6, 13, max_depth=ORES[ore])
    idx = g.idx[ore]
    rows = []
    for p, origin in enumerate(origins):
        mined, dug = set(), set()
        for k, (x, z) in enumerate(patch_cells(origin, d)):
            h, air = g.surface(x, z), g.air.get((x, z), [])
            solo = Run(idx, st, x, z, h, air).run()
            shared = Run(idx, st, x, z, h, air)
            shared.mined, shared.dug = mined, dug
            shared.run()
            rows.append((wi, p, k, g.reading(ore, x, z), solo.cost, solo.yld, solo.deps, shared.cost, shared.yld, shared.deps))
    df = pd.DataFrame(rows, columns=["world", "patch", "k", "reading", "solo_cost", "solo_yield", "solo_deps",
                                     "cost", "yield", "deps"])
    df["ore"], df["d"] = ore, d
    return df


def main(names):
    t0 = time.time()
    for wi, name in enumerate(names):
        s = Survey(name)
        blocks, bodies = B.load(s)
        origins = patch_origins(s, 1000 + wi)
        cols = {c for o in origins for d in SPACINGS for c in patch_cells(o, d)}
        G[wi] = (Ground(s, blocks, bodies, cols), origins)
        print(f"world {name} ready {time.time() - t0:.0f}s ({len(cols)} columns)", flush=True)
    tasks = [(wi, ore, d) for wi in G for ore in ORES for d in SPACINGS]
    with mp.get_context("fork").Pool(min(22, mp.cpu_count() - 2)) as pool:
        parts = []
        for k, df in enumerate(pool.imap_unordered(_task, tasks)):
            parts.append(df)
            if k % 20 == 0:
                print(f"  {k}/{len(tasks)} {time.time() - t0:.0f}s", flush=True)
    df = pd.concat(parts)
    df.to_pickle(ROOT / "data/spacing.pkl")
    df["word"] = report_word(df.reading)

    def summ(g):
        return {"n": int(len(g)),
                "rate": float(g["yield"].sum() / g.cost.sum() * 100),
                "solo_rate": float(g.solo_yield.sum() / g.solo_cost.sum() * 100),
                "yield_ratio": float(g["yield"].sum() / max(1, g.solo_yield.sum())),
                "yield": float(g["yield"].mean()), "cost": float(g.cost.mean()), "deps": float(g.deps.mean())}

    out = {"spacings": SPACINGS, "grid": GRID, "ores": {}}
    for ore, go in df.groupby("ore"):
        o = {"max_depth": ORES[ore], "all": {}, "by_word": {}}
        for d, gd in go.groupby("d"):
            o["all"][int(d)] = summ(gd)
            # only shafts that have neighbours dug before them (k>0) carry the overlap effect
            o["all"][int(d)]["later"] = summ(gd[gd.k > 0])
        for w, gw in go.groupby("word"):
            if w not in WORD_ORDER:
                continue
            o["by_word"][w] = {int(d): summ(gd) for d, gd in gw.groupby("d") if len(gd) >= 40}
        out["ores"][ore] = o
    (ROOT / "data/spacing.json").write_text(json.dumps(out))
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1:] or ["w4k_s1", "w4k_s2", "w4k_s3"])
