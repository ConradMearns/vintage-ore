"""Load an OreSurvey dataset and attach ore blocks to the deposits that generated them."""
import json
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
SURVEYS = ROOT / "data/surveys"

# Disc edges are distorted by up to 0.2 of the radius (DiscDepositGenerator: 1 - noise*0.2 - d^2).
EDGE_SLACK = 1.25


class Survey:
    def __init__(self, name: str):
        self.dir = SURVEYS / name
        self.meta = json.loads((self.dir / "meta.json").read_text())
        self.db = sqlite3.connect(self.dir / "survey.sqlite")
        m = self.meta
        self.x0, self.z0 = m["cx0"] * 32, m["cz0"] * 32
        self.size_x, self.size_z = m["ncx"] * 32, m["ncz"] * 32

    def q(self, sql, **kw) -> pd.DataFrame:
        return pd.read_sql_query(sql, self.db, params=kw or None)

    def ore_blocks(self) -> pd.DataFrame:
        return self.q("SELECT o.x, o.y, o.z, b.ore, b.grade, b.rock FROM ore_blocks o JOIN blocks b ON b.id = o.block_id")

    def deposits(self) -> pd.DataFrame:
        return self.q("SELECT * FROM deposits")

    def readings(self) -> pd.DataFrame:
        return self.q("SELECT * FROM readings")

    def heightmap(self) -> np.ndarray:
        """Terrain height as [z, x] array relative to (x0, z0)."""
        h = np.zeros((self.size_z, self.size_x), dtype=np.uint16)
        for cx, cz, blob in self.db.execute("SELECT cx, cz, heights FROM columns"):
            if blob is None:
                continue
            tile = np.frombuffer(blob, dtype="<u2").reshape(32, 32)
            ox, oz = (cx - self.meta["cx0"]) * 32, (cz - self.meta["cz0"]) * 32
            h[oz:oz + 32, ox:ox + 32] = tile
        return h

    def air_runs(self) -> pd.DataFrame:
        return self.q("SELECT * FROM air_runs")


def assign_blocks(blocks: pd.DataFrame, deposits: pd.DataFrame) -> pd.Series:
    """Deposit id for each ore block (-1 if none), by normalised elliptical XZ distance to same-ore deposit centers.

    Child deposits (radius 0 in our records) are matched by nearest center within 4 blocks in 3D.
    """
    out = np.full(len(blocks), -1, dtype=np.int64)
    for ore, bsub in blocks.groupby("ore"):
        dsub = deposits[deposits.code == ore]
        if dsub.empty:
            continue
        idx = bsub.index.to_numpy()
        bxz = bsub[["x", "z"]].to_numpy(float)
        disc = dsub[dsub.radius_x > 0]
        best = np.full(len(bsub), np.inf)
        if not disc.empty:
            rmax = float(np.maximum(disc.radius_x, disc.radius_z).max()) * EDGE_SLACK
            tree = cKDTree(disc[["x", "z"]].to_numpy(float))
            for i, cand in enumerate(tree.query_ball_point(bxz, rmax)):
                if not cand:
                    continue
                d = disc.iloc[cand]
                nd = ((bxz[i, 0] - d.x) / d.radius_x) ** 2 + ((bxz[i, 1] - d.z) / d.radius_z) ** 2
                j = int(np.argmin(nd.to_numpy()))
                if nd.iloc[j] <= EDGE_SLACK ** 2:
                    best[i] = nd.iloc[j]
                    out[idx[i]] = d.id.iloc[j]
        child = dsub[dsub.radius_x == 0]
        if not child.empty:
            tree = cKDTree(child[["x", "y", "z"]].to_numpy(float))
            dist, j = tree.query(bsub[["x", "y", "z"]].to_numpy(float), distance_upper_bound=4)
            ok = np.isfinite(dist) & (out[idx] == -1)
            out[idx[ok]] = child.id.to_numpy()[j[ok]]
    return pd.Series(out, index=blocks.index, name="deposit_id")
