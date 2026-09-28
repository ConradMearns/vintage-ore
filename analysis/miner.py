"""Mining simulator v2: a player who only knows what the game tells them.

The player digs a 1x1 vertical shaft from the surface. They learn about ore in two ways only:
  - seeing it: an ore block face-adjacent to any block they dug (or the dug block itself)
  - node search: the game's count of target-ore blocks in the cube of radius R around the probed block

When a probe count reaches `min_count`, the player localises the ore with a procedure that uses only those
two signals (see Run.localise), mines every body they uncover, then carries on down the shaft.
Depth is measured below the shaft's surface block, i.e. the number of rope ladders needed.

Durability (one number): 1 per solid block dug (shaft cave air is free; side tunnels are assumed solid),
2 per node search, and to mine a body: 1 per ore block + walkway rock (see bodies extract cost).
A side tunnel is 2 blocks high, so 2 per step. Walking back is free.
"""
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from bodies import MIN_DEPOSIT_BLOCKS
from survey import Survey

REACH = 4
FLOOR_Y = 2
DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]


@dataclass(frozen=True)
class Strategy:
    radius: int = 6
    spacing: int = 6
    min_count: int = 1
    max_depth: int = 999            # stop the shaft this many blocks below the surface (ladder count)
    probe_start: int = 0            # no probes shallower than this
    stop_after_first: bool = False
    localise: str = "gradient"      # "gradient" (realistic) | "oracle" (knows where the ore is)
    arm: int = 3                    # test-arm / tunnel segment length while localising
    give_up: int = 120              # durability spent in one localisation without a find before giving up
    lateral: int = 0                # after a probe that led to a deposit, dig 4 side arms of this length
    lateral_every: bool = False     # lateral search after every such probe (default: only the first)
    level_probes: tuple = (3, 6, -3, -6)   # shaft offsets probed to find the ore's level
    level_pick: str = "edge"        # "max" | "centroid" | "edge" (search up the dug shaft for the last probe height that still counts ore)
    test_arms: int = 2              # 2: test +x/+z and infer the other side; 4: test all four sides

    @property
    def label(self):
        s = f"R{self.radius} every {self.spacing}"
        if self.probe_start:
            s += f", from {self.probe_start}"
        if self.max_depth < 999:
            s += f", to {self.max_depth} deep"
        if self.min_count > 1:
            s += f", chase ≥{self.min_count}"
        if self.lateral:
            s += f", side arms {self.lateral}" + (" each hit" if self.lateral_every else "")
        if self.stop_after_first:
            s += ", stop at 1st"
        if self.localise == "oracle":
            s += " (perfect aim)"
        return s


class OreIndex:
    def __init__(self, blocks: pd.DataFrame, bodies: pd.DataFrame):
        self.xyz = blocks[["x", "y", "z"]].to_numpy()
        self.body = blocks.body.to_numpy()
        self.tree = cKDTree(self.xyz) if len(blocks) else None
        b = bodies
        walk_len = np.maximum(b.hspan, b.footprint / (2 * REACH + 1))
        self.extract = (b.n + walk_len * np.clip(2 - b.thickness, 0, None)).to_dict()
        self.n = b.n.to_dict()

    def count(self, p, r):
        return 0 if self.tree is None else int(self.tree.query_ball_point(p, r, p=np.inf, return_length=True))

    def cube(self, p, r):
        return [] if self.tree is None else self.tree.query_ball_point(p, r, p=np.inf)

    def seen(self, cells):
        """Bodies with a block equal or face-adjacent to any of the cells."""
        if self.tree is None or not len(cells):
            return set()
        out = set()
        for lst in self.tree.query_ball_point(np.asarray(cells, float), 1.0, p=1):
            for j in lst:
                out.add(int(self.body[j]))
        return out


class Run:
    """One shaft."""

    def __init__(self, idx: OreIndex, st: Strategy, x, z, h, air):
        self.idx, self.st, self.x, self.z, self.h, self.air = idx, st, x, z, h, air
        self.cost = 0.0
        self.yld = 0
        self.deps = 0
        self.mined = set()
        self.dug = set()
        self.cursor = h           # lowest dug shaft y + 1 (shaft cells are y in [cursor, h-1])
        self.first = None
        self.trace = []
        self.lateral_done = 0
        self.probes = []          # every node search so far: ((x, y, z), count)

    # --- primitives -------------------------------------------------------------------------------
    def mine(self, bodies):
        found = False
        for b in bodies:
            if b in self.mined:
                continue
            self.mined.add(b)
            self.cost += self.idx.extract[b]
            self.yld += self.idx.n[b]
            if self.idx.n[b] >= MIN_DEPOSIT_BLOCKS:
                self.deps += 1
                found = True
                if self.first is None:
                    self.first = (self.cost, self.yld)
        return found

    def dig_shaft_to(self, y):
        if y >= self.cursor:
            return False
        n = self.cursor - y
        for a, b in self.air:
            lo, hi = max(a, y), min(b, self.cursor - 1)
            if hi >= lo:
                n -= hi - lo + 1
        self.cost += n
        cells = [(self.x, yy, self.z) for yy in range(y, self.cursor)]
        self.cursor = y
        return self.mine(self.idx.seen(cells))

    def tunnel(self, start, d, steps):
        """Dig a 2-high tunnel from start (exclusive) along d. Returns (end, found_deposit)."""
        x, y, z = start
        new = []
        for _ in range(steps):
            x += d[0]
            z += d[1]
            for c in ((x, y, z), (x, y + 1, z)):
                if c not in self.dug:
                    self.dug.add(c)
                    new.append(c)
        self.cost += len(new)
        return (x, y, z), self.mine(self.idx.seen(new))

    def probe(self, p):
        self.cost += 2
        c = self.idx.count(p, self.st.radius)
        self.probes.append((tuple(p), c))
        return c

    # --- localisation -----------------------------------------------------------------------------
    def localise(self, p0, c0):
        if self.st.localise == "oracle":
            return self._oracle(p0)
        return self._gradient(p0, c0)

    def _oracle(self, p0):
        cand = {}
        for j in self.idx.cube(p0, self.st.radius):
            b = int(self.idx.body[j])
            if b in self.mined:
                continue
            d = self.idx.xyz[j]
            a = 2 * (abs(d[0] - p0[0]) + abs(d[2] - p0[2])) + abs(d[1] - p0[1])
            cand[b] = min(a, cand.get(b, 1 << 30))
        found = False
        if cand:
            self.cost += 4
            for b, a in sorted(cand.items(), key=lambda kv: kv[1]):
                self.cost += a
                found |= self.mine([b])
        return found, p0[1]

    def _gradient(self, p0, c0):
        """Find the level with the highest count (probes at ±3, ±6 in the shaft), then hill-climb sideways."""
        st, x, z = self.st, self.x, self.z
        y0 = p0[1]
        found = False
        if st.level_pick == "edge":
            ys, found = self._edge_level(y0, c0)
            return self._chase_from((x, ys, z), self.probe((x, ys, z)), found, ys)
        levels = {y0: c0}
        for dy in st.level_probes:
            y = y0 + dy
            if y >= self.h or y < FLOOR_Y:
                continue
            if y < self.cursor:
                found |= self.dig_shaft_to(y)
            levels[y] = self.probe((x, y, z))
        if st.level_pick == "centroid" and sum(levels.values()) > 0:
            ys = int(round(sum(y * c for y, c in levels.items()) / sum(levels.values())))
            c = levels[ys] if ys in levels else self.probe((x, ys, z))
        else:
            ys = max(levels, key=lambda y: (levels[y], -abs(y - y0)))
            c = levels[ys]
        return self._chase_from((x, ys, z), c, found, ys)

    def _edge_level(self, y0, c0):
        """Binary search the dug shaft above the hit for the highest probe height that still counts ore.
        The cube reaches R blocks down, so the top of the ore is R below that height."""
        st, R = self.st, self.st.radius
        lo, hi = y0, min(y0 + 2 * R + 1, self.h - 1)   # count(lo) > 0; count above hi assumed 0
        known = {q[1]: c for q, c in self.probes if q[0] == self.x and q[2] == self.z}
        if hi in known and known[hi] > 0:
            lo = hi
        while hi - lo > 1:
            mid = (lo + hi) // 2
            c = known.get(mid)
            if c is None:
                c = self.probe((self.x, mid, self.z))
                known[mid] = c
            if c > 0:
                lo = mid
            else:
                hi = mid
        top = lo - R                      # highest ore block level near the shaft
        ys = max(FLOOR_Y, top - 1)        # 2-high tunnel at top-1..top
        found = self.dig_shaft_to(ys) if ys < self.cursor else False
        return ys, found

    def _chase_from(self, pos, c, found, ys):
        st = self.st
        if c == 0:
            return found, ys
        spent_since_find = 0.0
        finds = 0
        for _ in range(4):  # up to 4 chase rounds (several bodies in one cube)
            start_cost = self.cost
            got, pos, c = self._climb(pos, c, st.give_up)
            if got:
                found = True
                finds += 1
                c = self.probe(pos)
                if c < st.min_count:
                    break
            else:
                break
            spent_since_find = self.cost - start_cost
        return found, ys

    def _climb(self, pos, c, budget):
        """Test arms, then walk toward rising counts. Returns (found_deposit, pos, last count)."""
        st = self.st
        start_cost = self.cost
        # test two arms; infer the opposite side from their sign
        grads = {}
        for d in (DIRS if st.test_arms == 4 else DIRS[:2]):
            end, got = self.tunnel(pos, d, st.arm)
            if got:
                return True, end, self.probe(end)
            grads[d] = self.probe(end) - c
        if st.test_arms == 4:
            order = sorted(((g, d) for d, g in grads.items() if g >= 0), reverse=True)[:2]
        else:
            order = sorted(((abs(g), (d if g >= 0 else (-d[0], -d[1]))) for d, g in grads.items()), reverse=True)
        best_c, best_pos = c, pos
        for turn, (_, d) in enumerate(order):
            cur, cc = best_pos, best_c
            while self.cost - start_cost < budget:
                cur, got = self.tunnel(cur, d, st.arm)
                if got:
                    return True, cur, self.probe(cur)
                nc = self.probe(cur)
                if nc < cc:
                    break
                cc = nc
                if cc >= best_c:
                    best_c, best_pos = cc, cur
            if self.cost - start_cost >= budget:
                break
        return False, best_pos, best_c

    def lateral(self, y):
        st = self.st
        step = 2 * st.radius + 1
        found = False
        for d in DIRS:
            pos = (self.x, y, self.z)
            walked = 0
            while walked < st.lateral:
                n = min(step, st.lateral - walked)
                pos, got = self.tunnel(pos, d, n)
                walked += n
                found |= got
                c = self.probe(pos)
                if c >= st.min_count:
                    saved = (self.x, self.z)
                    got2, _ = self._lateral_localise(pos, c)
                    found |= got2
        return found

    def _lateral_localise(self, pos, c):
        if self.st.localise == "oracle":
            return self._oracle(pos)
        got, _, _ = self._climb(pos, c, self.st.give_up)
        return got, pos[1]

    # --- the shaft ----------------------------------------------------------------------------------
    def run(self):
        st = self.st
        floor = max(FLOOR_Y, self.h - st.max_depth)
        depth = 0
        while True:
            depth += st.spacing
            y = self.h - depth
            if y < floor:
                self.dig_shaft_to(floor)
                break
            hit_before = self.deps
            self.dig_shaft_to(y)
            if depth >= st.probe_start:
                c = self.probe((self.x, y, self.z))
                if c >= st.min_count:
                    got, ylev = self.localise((self.x, y, self.z), c)
                    if got and st.lateral and (st.lateral_every or self.lateral_done == 0):
                        self.lateral_done += 1
                        self.lateral(ylev)
            self.trace.append((depth, self.cost, self.yld, self.deps))
            if st.stop_after_first and self.deps:
                break
        return self


class World:
    """Shaft grid + ore indexes for one survey."""

    def __init__(self, s: Survey, blocks, bodies, shaft_spacing=16, offset=8):
        self.s = s
        n = (s.size_x - 2 * offset) // shaft_spacing + 1
        ii, jj = np.meshgrid(np.arange(n), np.arange(n), indexing="xy")
        self.sx = (s.x0 + offset + ii * shaft_spacing).ravel()
        self.sz = (s.z0 + offset + jj * shaft_spacing).ravel()
        h = s.heightmap()
        self.surface = h[self.sz - s.z0, self.sx - s.x0].astype(int)
        air = s.q(f"""SELECT x, z, y0, y1 FROM air_runs
                      WHERE (x - {s.x0 + offset}) % {shaft_spacing} = 0 AND (z - {s.z0 + offset}) % {shaft_spacing} = 0""")
        pos = {(x, z): i for i, (x, z) in enumerate(zip(self.sx, self.sz))}
        self.air = [[] for _ in self.sx]
        for x, z, y0, y1 in air.itertuples(index=False):
            i = pos.get((x, z))
            if i is not None:
                self.air[i].append((y0, y1))
        r = s.q(f"""SELECT x, z, ore, total_factor FROM readings
                    WHERE (x - {s.x0 + offset}) % {shaft_spacing} = 0 AND (z - {s.z0 + offset}) % {shaft_spacing} = 0""")
        k = pd.Series(np.arange(len(self.sx)), index=pd.MultiIndex.from_arrays([self.sx, self.sz]))
        r["shaft"] = k.reindex(pd.MultiIndex.from_arrays([r.x, r.z])).to_numpy()
        self.readings = r.pivot_table(index="shaft", columns="ore", values="total_factor").reindex(
            np.arange(len(self.sx))).fillna(0.0)
        self.blocks = blocks
        self.bodies = bodies
        self._idx = {}

    def index(self, ore):
        if ore not in self._idx:
            b = self.blocks[self.blocks.ore == ore]
            self._idx[ore] = OreIndex(b, self.bodies[self.bodies.ore == ore])
        return self._idx[ore]

    def simulate(self, ore, st: Strategy, shafts=None):
        idx = self.index(ore)
        shafts = range(len(self.sx)) if shafts is None else shafts
        res, trace = [], []
        for i in shafts:
            r = Run(idx, st, int(self.sx[i]), int(self.sz[i]), int(self.surface[i]), self.air[i]).run()
            fc, fy = r.first if r.first else (np.nan, np.nan)
            res.append((i, r.h, r.cost, r.yld, r.deps, fc, fy))
            trace.extend((i, *t) for t in r.trace)
        res = pd.DataFrame(res, columns=["shaft", "surface", "cost", "yield", "deposits", "first_cost", "first_yield"])
        trace = pd.DataFrame(trace, columns=["shaft", "depth", "cost", "yield", "deposits"])
        return res, trace
