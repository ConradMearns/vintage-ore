"""Vertical-shaft mining simulator.

A shaft is a 1x1 vertical line dug from the surface. Every `spacing` blocks the player does a node search
(radius R cube, the game's exact rule). When the target ore's count in the cube reaches `min_count`, the player
chases every not-yet-mined body of that ore that the cube touches, then continues down.

Cost model (total durability, one number):
  dig            1 per solid block broken in the shaft (cave air is free)
  node search    2 per probe
  localise       LOCALISE_COST per probe that triggers a chase (a couple of extra probes to find direction)
  access         2 per horizontal step (2-high tunnel) + 1 per vertical step to the body's nearest block in the cube
  extract        1 per ore block + walkway rock: a 1x2 walkway through the body, every ore block within
                 REACH of it; rock per walkway step = max(0, 2 - mean ore thickness)
Yield = ore blocks of the target ore mined.
"""
from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

from bodies import MIN_DEPOSIT_BLOCKS
from survey import Survey

SHAFT_SPACING = 16
SHAFT_OFFSET = 8
MAX_R = 8
LOCALISE_COST = 4
REACH = 4
FLOOR_Y = 2

BUCKETS = {"trace": 1, "small": 10, "medium": 20, "large": 40}

# Propick reading code (deposit variant) for block ore types whose names differ.
READING_CODE = {"quartz_nativesilver": "silver", "quartz_nativegold": "gold", "olivine_peridot": "peridot"}


@dataclass(frozen=True)
class Strategy:
    radius: int = 6
    spacing: int = 6
    min_count: int = 1        # node-search count that triggers a chase
    stop_after_first: bool = False
    max_depth: int = 999      # blocks below surface

    @property
    def label(self):
        s = f"R{self.radius} every {self.spacing}"
        if self.min_count > 1:
            s += f", chase ≥{self.min_count}"
        if self.stop_after_first:
            s += ", stop at 1st"
        if self.max_depth < 999:
            s += f", ≤{self.max_depth} deep"
        return s


class ShaftField:
    """Precomputed shaft grid for one survey: surface, cave air, readings, and nearby ore blocks per target ore."""

    def __init__(self, s: Survey, blocks: pd.DataFrame, bodies: pd.DataFrame):
        self.s = s
        n = (s.size_x - 2 * SHAFT_OFFSET) // SHAFT_SPACING + 1
        ii, jj = np.meshgrid(np.arange(n), np.arange(n), indexing="xy")
        self.n = n
        self.sx = (s.x0 + SHAFT_OFFSET + ii * SHAFT_SPACING).ravel()
        self.sz = (s.z0 + SHAFT_OFFSET + jj * SHAFT_SPACING).ravel()
        h = s.heightmap()
        self.surface = h[self.sz - s.z0, self.sx - s.x0].astype(np.int32)
        self._load_air()
        self._load_readings()
        self.blocks = blocks
        self.bodies = bodies
        # walkway rock cost per body
        walk_len = np.maximum(bodies.hspan, bodies.footprint / (2 * REACH + 1))
        self.body_extract = (bodies.n + walk_len * np.clip(2 - bodies.thickness, 0, None)).to_dict()
        self.body_n = bodies.n.to_dict()
        self._rows = {}

    def _load_air(self):
        s = self.s
        air = s.q(f"""SELECT x, z, y0, y1 FROM air_runs
                      WHERE (x - {s.x0 + SHAFT_OFFSET}) % {SHAFT_SPACING} = 0 AND (z - {s.z0 + SHAFT_OFFSET}) % {SHAFT_SPACING} = 0""")
        idx = {(x, z): i for i, (x, z) in enumerate(zip(self.sx, self.sz))}
        self.air = [[] for _ in range(len(self.sx))]
        for x, z, y0, y1 in air.itertuples(index=False):
            i = idx.get((x, z))
            if i is not None:
                self.air[i].append((y0, y1))

    def _load_readings(self):
        s = self.s
        r = s.q(f"""SELECT x, z, ore, total_factor FROM readings
                    WHERE (x - {s.x0 + SHAFT_OFFSET}) % {SHAFT_SPACING} = 0 AND (z - {s.z0 + SHAFT_OFFSET}) % {SHAFT_SPACING} = 0""")
        idx = pd.Series(np.arange(len(self.sx)), index=pd.MultiIndex.from_arrays([self.sx, self.sz]))
        r["shaft"] = idx.reindex(pd.MultiIndex.from_arrays([r.x, r.z])).to_numpy()
        self.readings = r.pivot_table(index="shaft", columns="ore", values="total_factor").reindex(
            np.arange(len(self.sx))).fillna(0.0)

    def rows(self, ore: str):
        """Ore blocks within MAX_R (xz) of each shaft: arrays sorted by shaft, plus per-shaft slice bounds."""
        if ore in self._rows:
            return self._rows[ore]
        b = self.blocks[self.blocks.ore == ore]
        x = b.x.to_numpy() - self.s.x0 - SHAFT_OFFSET
        z = b.z.to_numpy() - self.s.z0 - SHAFT_OFFSET
        parts = []
        for di in (0, 1):
            for dj in (0, 1):
                i = x // SHAFT_SPACING + di
                j = z // SHAFT_SPACING + dj
                dx = x - i * SHAFT_SPACING
                dz = z - j * SHAFT_SPACING
                ok = (np.abs(dx) <= MAX_R) & (np.abs(dz) <= MAX_R) & (i >= 0) & (j >= 0) & (i < self.n) & (j < self.n)
                parts.append(pd.DataFrame({"shaft": (j * self.n + i)[ok], "dx": dx[ok], "dz": dz[ok],
                                           "y": b.y.to_numpy()[ok], "body": b.body.to_numpy()[ok]}))
        rows = pd.concat(parts).sort_values(["shaft", "y"], ascending=[True, False])
        arrs = {c: rows[c].to_numpy() for c in ("dx", "dz", "y", "body")}
        bounds = np.searchsorted(rows.shaft.to_numpy(), np.arange(len(self.sx) + 1))
        self._rows[ore] = (arrs, bounds)
        return self._rows[ore]

    def dig_cost(self, i, y_from, y_to):
        """Solid blocks broken digging from y_from-1 down to y_to inclusive."""
        n = y_from - y_to
        for a, b in self.air[i]:
            lo, hi = max(a, y_to), min(b, y_from - 1)
            if hi >= lo:
                n -= hi - lo + 1
        return n

    def simulate(self, ore: str, st: Strategy, shafts=None):
        """Returns per-shaft results and a per-probe trace (for yield-vs-durability curves)."""
        arrs, bounds = self.rows(ore)
        shafts = np.arange(len(self.sx)) if shafts is None else shafts
        res, trace = [], []
        for i in shafts:
            sl = slice(bounds[i], bounds[i + 1])
            dx, dz, y, body = arrs["dx"][sl], arrs["dz"][sl], arrs["y"][sl], arrs["body"][sl]
            inside = (np.abs(dx) <= st.radius) & (np.abs(dz) <= st.radius)
            dx, dz, y, body = dx[inside], dz[inside], y[inside], body[inside]
            h = int(self.surface[i])
            floor = max(FLOOR_Y, h - st.max_depth)
            cost = dig_y = 0
            dig_y = h
            yld = found = deposits = 0
            first_cost = first_yield = None
            mined = set()
            yp = h - st.spacing
            while yp >= floor:
                cost += self.dig_cost(i, dig_y, yp) + 2
                dig_y = yp
                m = np.abs(y - yp) <= st.radius
                if m.sum() >= st.min_count:
                    cand = {}
                    for bdx, bdz, by, bb in zip(dx[m], dz[m], y[m], body[m]):
                        if bb in mined:
                            continue
                        a = 2 * (abs(bdx) + abs(bdz)) + abs(by - yp)
                        if a < cand.get(bb, 1 << 30):
                            cand[bb] = a
                    if cand:
                        cost += LOCALISE_COST
                        for bb, a in sorted(cand.items(), key=lambda kv: kv[1]):
                            cost += a + self.body_extract[bb]
                            yld += self.body_n[bb]
                            found += 1
                            deposits += self.body_n[bb] >= MIN_DEPOSIT_BLOCKS
                            mined.add(bb)
                        if first_cost is None and deposits:
                            first_cost, first_yield = cost, yld
                trace.append((i, h - yp, cost, yld, deposits))
                if st.stop_after_first and deposits:
                    break
                yp -= st.spacing
            res.append((i, h, cost, yld, found, deposits, first_cost, first_yield))
        res = pd.DataFrame(res, columns=["shaft", "surface", "cost", "yield", "bodies", "deposits",
                                         "first_cost", "first_yield"])
        code = READING_CODE.get(ore, ore)
        res["reading"] = self.readings.get(code, pd.Series(0.0, index=self.readings.index)).to_numpy()[res.shaft]
        trace = pd.DataFrame(trace, columns=["shaft", "depth", "cost", "yield", "deposits"])
        return res, trace


WORDS = ["very poor", "poor", "decent", "high", "very high", "ultra high"]


def reading_word(factor):
    """The propick's density word; below 0.025 the game only says 'miniscule' / nothing."""
    f = np.asarray(factor)
    w = np.array(WORDS)[np.clip((f * 7.5).astype(int), 0, 5)]
    return np.where(f > 0.025, w, "none")
