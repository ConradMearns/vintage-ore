"""Connected ore bodies: 26-connected blocks of the same ore type (the node search groups by the same type key).

Cached per survey in data/surveys/<name>/bodies.pkl and blocks.npz.
"""
import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from survey import Survey

# Forward half of the 26-neighbourhood (the other half is covered by symmetry).
_OFFSETS = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
            if (dx, dy, dz) > (0, 0, 0)]

# Body shape classes; see classify(). Specks make up ~70% of bodies but <2% of ore, so "unique deposits"
# counts use MIN_DEPOSIT_BLOCKS.
PANCAKE_MIN_SPAN = 6
MIN_DEPOSIT_BLOCKS = 5


def _key(x, y, z):
    return (x.astype(np.int64) << 32) | (z.astype(np.int64) << 9) | y.astype(np.int64)


def label_bodies(x, y, z):
    """Connected-component labels for one ore type's blocks."""
    x = x - x.min() + 1
    z = z - z.min() + 1
    keys = _key(x, y, z)
    order = np.argsort(keys)
    sk = keys[order]
    rows, cols = [], []
    for dx, dy, dz in _OFFSETS:
        nk = _key(x + dx, y + dy, z + dz)
        pos = np.searchsorted(sk, nk)
        pos[pos == len(sk)] = 0
        hit = sk[pos] == nk
        rows.append(np.nonzero(hit)[0])
        cols.append(order[pos[hit]])
    r = np.concatenate(rows)
    c = np.concatenate(cols)
    n = len(x)
    g = coo_matrix((np.ones(len(r), dtype=np.int8), (r, c)), shape=(n, n))
    return connected_components(g, directed=False)[1]


def classify(b: pd.DataFrame) -> pd.Series:
    """pancake: wide and flat; clump: other bodies of >= MIN_DEPOSIT_BLOCKS; speck: tiny scatter."""
    wide = b.hspan >= PANCAKE_MIN_SPAN
    flat = b.yspan * 2 <= b.hspan
    return pd.Series(np.where(wide & flat, "pancake", np.where(b.n >= MIN_DEPOSIT_BLOCKS, "clump", "speck")),
                     index=b.index)


def compute(s: Survey):
    blocks = s.ore_blocks()
    h = s.heightmap()
    blocks["surface"] = h[blocks.z - s.z0, blocks.x - s.x0].astype(np.int32)
    body = np.empty(len(blocks), dtype=np.int64)
    next_id = 0
    for ore, idx in blocks.groupby("ore").indices.items():
        sub = blocks.iloc[idx]
        lab = label_bodies(sub.x.to_numpy(), sub.y.to_numpy(), sub.z.to_numpy())
        body[idx] = lab + next_id
        next_id += lab.max() + 1
    blocks["body"] = body

    g = blocks.groupby("body")
    bodies = g.agg(ore=("ore", "first"), n=("x", "size"),
                   xmin=("x", "min"), xmax=("x", "max"), ymin=("y", "min"), ymax=("y", "max"),
                   zmin=("z", "min"), zmax=("z", "max"),
                   cx=("x", "mean"), cy=("y", "mean"), cz=("z", "mean"), surface=("surface", "mean"))
    bodies["footprint"] = blocks.drop_duplicates(["body", "x", "z"]).groupby("body").size()
    bodies["yspan"] = bodies.ymax - bodies.ymin + 1
    bodies["hspan"] = np.maximum(bodies.xmax - bodies.xmin, bodies.zmax - bodies.zmin) + 1
    bodies["thickness"] = bodies.n / bodies.footprint
    bodies["depth"] = bodies.surface - bodies.cy
    bodies["shape"] = classify(bodies)
    return blocks, bodies


def load(s: Survey, refresh=False):
    bpath, kpath = s.dir / "bodies.pkl", s.dir / "blocks.pkl"
    if not refresh and bpath.exists() and kpath.exists():
        return pd.read_pickle(kpath), pd.read_pickle(bpath)
    blocks, bodies = compute(s)
    blocks.to_pickle(kpath)
    bodies.to_pickle(bpath)
    return blocks, bodies


if __name__ == "__main__":
    import sys
    import time
    t = time.time()
    s = Survey(sys.argv[1])
    blocks, bodies = load(s, refresh=True)
    print(f"{len(blocks)} blocks -> {len(bodies)} bodies in {time.time() - t:.0f}s")
    summ = bodies.groupby("ore").agg(bodies=("n", "size"), blocks=("n", "sum"), med_n=("n", "median"),
                                     med_thick=("yspan", "median"), med_span=("hspan", "median"),
                                     med_depth=("depth", "median"),
                                     pancake_share=("shape", lambda v: (v == "pancake").mean()))
    summ["ore_in_pancakes"] = bodies[bodies["shape"] == "pancake"].groupby("ore").n.sum() / summ.blocks
    print(summ.sort_values("blocks", ascending=False).round(2).to_string())
