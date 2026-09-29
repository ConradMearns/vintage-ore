"""Gold and silver prospecting simulator.

Gold and silver are child deposits of quartz: each replaces a block *inside* a quartz slab (see PLAN.md, gold and
silver). Quartz slabs are thin (median one block per column), gently tilted, ~60 blocks across, and appear at any depth.
Nuggets come in clouds of at most ~15, so the node search can only ever say "trace" (<10): the player learns whether
any gold/silver is inside the 13x13x13 cube, nothing more. Everything here therefore uses presence-only probes.

Cost model (durability), same as miner.py: 1 per block of shaft, 2 per step of a 2-high tunnel (walking back is free),
2 per node search, 1 to break a nugget that is beside the tunnel (nuggets in the tunnel's own cells are free). Cave air
is ignored (it would only make shafts cheaper). Visible = face-adjacent to a dug cell.

A trial is one shaft at a surface point:
  shaft down, node search every `spacing` blocks (R=6);
  a probe that finds quartz or nuggets sends the player into the slab: locate it (edge search, 8), tunnel to it, then
  dig up to four arms along the slab from the entry column, probing every `spacing` steps;
  a probe that finds nuggets triggers a harvest of the 13x13 patch (`strip`: lanes at +-3, +-6 with a re-probe after each;
  `oracle`: perfect aim, the lower bound on cost).
"""
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import bodies as B
from survey import Survey

R = 6
MIN_SLAB = 200          # quartz bodies smaller than this are not slabs worth entering
EDGE_SEARCH_COST = 8    # four probes to find the slab level
DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]


@dataclass(frozen=True)
class Strategy:
    spacing: int = 13         # shaft probe spacing (and probe spacing along arms)
    max_depth: int = 120
    sweep: str = "hit"        # which slabs get arms: "never" | "hit" (a shaft probe found nuggets) | "always" (any slab)
    arms: int = 4
    arm_len: int = 40
    patience: int = 0         # an arm stops after this many empty probes in a row (0: never stops early)
    harvest: str = "strip"    # "strip" | "oracle"
    lanes: tuple = (3, -3, 6, -6)   # lateral offsets of the harvest lanes
    first_probe: int = 0            # depth of the first shaft probe (0: same as spacing); 6 covers a slab within 12 of the surface

    @property
    def label(self):
        s = f"probe {self.spacing}, to {self.max_depth}, sweep {self.sweep}"
        if self.sweep != "never":
            s += f" {self.arms}x{self.arm_len}" + (f" patience {self.patience}" if self.patience else "")
        s += f", {self.harvest}" + ("" if self.lanes == (3, -3, 6, -6) else f" lanes {len(self.lanes)}")
        return s


class Ground:
    """One survey: quartz slabs, nuggets, surface, reading grids."""

    def __init__(self, name):
        s = Survey(name)
        self.name, self.x0, self.z0 = name, s.x0, s.z0
        z = np.load(s.dir / "gs.npz")
        self.h = z["surface"]
        q = z["quartz_xyz"]
        lab = B.label_bodies(q[:, 0], q[:, 1], q[:, 2]).astype(np.int32)
        self.qlab = lab
        size = np.bincount(lab)
        self.slab = size >= MIN_SLAB
        self.qtree = cKDTree(q.astype(np.float64))
        # column table for slab bodies: sorted keys (body, x, z) -> ymin, ymax
        keep = self.slab[lab]
        qq, ll = q[keep], lab[keep]
        xr, zr = (qq[:, 0] - self.x0).astype(np.int64), (qq[:, 2] - self.z0).astype(np.int64)
        key = (ll.astype(np.int64) << 26) | (xr << 13) | zr
        df = pd.DataFrame({"k": key, "y": qq[:, 1]})
        g = df.groupby("k").y.agg(["min", "max"])
        self.ckeys = g.index.to_numpy()
        self.cmin = g["min"].to_numpy(np.int32)
        self.cmax = g["max"].to_numpy(np.int32)
        # nuggets: 0 gold, 1 silver
        gx, sx = z["quartz_nativegold_xyz"].astype(np.int64), z["quartz_nativesilver_xyz"].astype(np.int64)
        self.nxyz = np.concatenate([gx, sx])
        self.ntype = np.concatenate([np.zeros(len(gx), np.int8), np.ones(len(sx), np.int8)])
        self.ntree = cKDTree(self.nxyz.astype(np.float64))
        self.read = {}
        for c in ("gold", "silver"):
            r = z[c + "_read"]
            g2 = np.zeros((4096 // 4, 4096 // 4), np.float32)
            g2[((r[:, 1] - self.z0) // 4).astype(int), ((r[:, 0] - self.x0) // 4).astype(int)] = r[:, 2]
            self.read[c] = g2

    def col(self, b, x, z):
        k = (int(b) << 26) | ((x - self.x0) << 13) | (z - self.z0)
        i = np.searchsorted(self.ckeys, k)
        if i < len(self.ckeys) and self.ckeys[i] == k:
            return int(self.cmin[i]), int(self.cmax[i])
        return None


class Shaft:
    """State shared by all shafts dug in one patch: dug slab columns and mined nuggets."""

    def __init__(self, g: Ground):
        self.g = g
        self.dug = set()
        self.mined = np.zeros(len(g.nxyz), bool)
        self.swept = set()

    def new_run(self, st: Strategy, x, z):
        return Run(self, st, x, z)


class Run:
    def __init__(self, shared: Shaft, st: Strategy, x, z):
        self.sh, self.g, self.st = shared, shared.g, st
        self.x, self.z = x, z
        self.h = int(self.g.h[z - self.g.z0, x - self.g.x0])
        self.cursor = self.h
        self.cost = 0.0
        self.got = [0, 0]
        self.first = None
        self.slabs = 0
        self.probes = 0
        self.positive = 0         # probes that found nuggets
        self.bucketed = 0         # ... of which the game would word as more than "trace" (10 or more)

    # --- primitives ---------------------------------------------------------------------------------
    def nuggets_in(self, p, r=R):
        idx = self.g.ntree.query_ball_point(p, r, p=np.inf)
        return [i for i in idx if not self.sh.mined[i]]

    def probe(self, p):
        self.cost += 2
        self.probes += 1
        n = len(self.nuggets_in(p))
        self.positive += n > 0
        self.bucketed += n >= 10
        return n

    def quartz_near(self, p):
        d, i = self.g.qtree.query(p, p=np.inf, distance_upper_bound=R + 2.5)
        if not np.isfinite(d):
            return None
        b = int(self.g.qlab[i])
        return b if self.g.slab[b] else None

    def collect(self, i, free=False):
        if self.sh.mined[i]:
            return
        self.sh.mined[i] = True
        self.got[int(self.g.ntype[i])] += 1
        if not free:
            self.cost += 1
        if self.first is None:
            self.first = self.cost

    def dig_column(self, b, x, z, ybase):
        """Dig one 2-high tunnel column at (x, z) whose bottom cell is ybase; expose and take neighbouring nuggets."""
        k = (b, x, z)
        if k in self.sh.dug:
            return
        self.sh.dug.add(k)
        self.cost += 2
        cells = np.array([[x, ybase, z], [x, ybase + 1, z]], float)
        for c, lst in zip(cells, self.g.ntree.query_ball_point(cells, 1, p=1)):
            for i in lst:
                if not self.sh.mined[i]:
                    self.collect(i, free=bool((self.g.nxyz[i] == c).all()))

    # --- slab work ----------------------------------------------------------------------------------
    def enter_slab(self, b, p):
        """Level via edge search, dig the shaft to it and tunnel to the nearest column of slab b. Returns (x, z, ybase)."""
        g, x, z = self.g, self.x, self.z
        best = None
        for r in range(0, R + 3):
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if max(abs(dx), abs(dz)) != r:
                        continue
                    c = g.col(b, x + dx, z + dz)
                    if c and c[0] - 1 <= p[1] + R + 2 and c[1] >= p[1] - R - 2:
                        d = abs(dx) + abs(dz)
                        if best is None or d < best[0]:
                            best = (d, x + dx, z + dz, c[0])
            if best is not None:
                break
        if best is None:
            return None
        d, ex, ez, yb = best
        self.cost += EDGE_SEARCH_COST
        if yb < self.cursor:
            self.cost += self.cursor - yb
            self.cursor = yb
        self.cost += 2 * d
        self.dug_column_free(b, ex, ez)
        return ex, ez, yb

    def dug_column_free(self, b, x, z):
        self.dig_column(b, x, z, self.g.col(b, x, z)[0])

    def follow(self, b, x, z, yb):
        c = self.g.col(b, x, z)
        if c is None:
            return None
        if c[0] != yb:
            self.cost += abs(c[0] - yb)
        self.dig_column(b, x, z, c[0])
        return c[0]

    def sweep(self, b, ex, ez, yb):
        st = self.st
        dirs = DIRS[:st.arms]
        for d in dirs:
            x, z, y = ex, ez, yb
            empty = 0
            for step in range(1, st.arm_len + 1):
                x, z = x + d[0], z + d[1]
                y2 = self.follow(b, x, z, y)
                if y2 is None:
                    break
                y = y2
                if step % st.spacing == 0:
                    if self.probe((x, y, z)):
                        empty = 0
                        self.harvest(b, (x, y, z), d)
                    else:
                        empty += 1
                        if st.patience and empty >= st.patience:
                            break

    def harvest(self, b, p, d):
        if self.st.harvest == "oracle":
            return self._oracle(p)
        return self._strip(b, p, d)

    def _oracle(self, p):
        pts = self.nuggets_in(p)
        if not pts:
            return
        self.cost += 2
        pos = np.array(p, float)
        while pts:
            dist = [abs(self.g.nxyz[i][0] - pos[0]) + abs(self.g.nxyz[i][2] - pos[2]) for i in pts]
            j = int(np.argmin(dist))
            i = pts.pop(j)
            self.cost += 2 * max(dist[j] - 1, 0)
            pos = self.g.nxyz[i].astype(float)
            self.collect(i)

    def _strip(self, b, p, d):
        """Lanes parallel to the arm at lateral offsets +3, -3, +6, -6 over the 13 columns around p, re-probing after each."""
        x, y, z = p
        lat = (-d[1], d[0])
        yb = y
        for o in self.st.lanes:
            # connector from the arm to the lane, then the lane itself
            step = 1 if o > 0 else -1
            cols = [(oo, 0) for oo in range(step, o + step, step)] + [(o, a) for a in range(-R, R + 1) if a != 0]
            for oo, a in cols:
                cx, cz = x + a * d[0] + oo * lat[0], z + a * d[1] + oo * lat[1]
                c = self.g.col(b, cx, cz)
                if c is None:
                    if a == 0 and (-1, cx, cz) not in self.sh.dug:   # the connector crosses plain rock: still costs 2 a step
                        self.sh.dug.add((-1, cx, cz))
                        self.cost += 2
                    continue
                self.dig_column(b, cx, cz, c[0])
            if not self.probe(p):
                break

    # --- the shaft ------------------------------------------------------------------------------------
    def run(self):
        st, g = self.st, self.g
        floor = max(2, self.h - st.max_depth)
        depth = 0
        while True:
            depth += st.spacing if depth or not st.first_probe else st.first_probe
            y = self.h - depth
            if y < floor:
                break
            self.cost += self.cursor - y
            self.cursor = y
            p = (self.x, y, self.z)
            nug = self.probe(p)
            b = self.quartz_near(p)
            if b is None or b in self.sh.swept:
                continue
            if not (nug or st.sweep == "always"):
                continue
            ent = self.enter_slab(b, p)
            if ent is None:
                continue
            self.sh.swept.add(b)
            self.slabs += 1
            ex, ez, yb = ent
            if nug:
                self.harvest(b, (ex, yb, ez), (1, 0))
            if st.sweep != "never":
                self.sweep(b, ex, ez, yb)
        return self

    def result(self):
        return dict(cost=self.cost, gold=self.got[0], silver=self.got[1], first=self.first if self.first else np.nan,
                    slabs=self.slabs, probes=self.probes, positive=self.positive, bucketed=self.bucketed)


def stone_sites(g: Ground, kind, rng, n):
    """Surface columns of loose stones, sampled as the game places them (see PLAN.md, loose stones).
    'quartz': 0.35 * 0.05 * (1.11 - depth/9) per quartz block; 'gold'/'silver': 0.65 * 0.1 * (1 - depth/8) per nugget."""
    if not hasattr(g, "_stone"):
        z = np.load(Survey(g.name).dir / "gs.npz")
        g._stone = {}
        for k, key, f in (("quartz", "quartz_xyz", lambda d: 0.35 * 0.05 * np.clip(1.11 - d / 9.0, 0, None)),
                          ("gold", "quartz_nativegold_xyz", lambda d: 0.65 * 0.1 * np.clip(1 - d / 8.0, 0, None)),
                          ("silver", "quartz_nativesilver_xyz", lambda d: 0.65 * 0.1 * np.clip(1 - d / 8.0, 0, None))):
            a = z[key]
            d = g.h[a[:, 2] - g.z0, a[:, 0] - g.x0].astype(int) - a[:, 1]
            pr = f(d)
            m = pr > 0
            g._stone[k] = (a[m][:, [0, 2]], pr[m] / pr[m].sum())
    xz, pr = g._stone[kind]
    i = rng.choice(len(xz), size=n, p=pr)
    return [(int(x), int(zz)) for x, zz in xz[i]]


def starts(g: Ground, kind, n, rng, lo=None, hi=None, need=None):
    """Start columns. kind 'any' (random surface point), 'gold'/'silver' (a point whose reading is in [lo, hi)), or
    'stone-quartz' / 'stone-gold' / 'stone-silver' (a loose stone of that kind). `need=(ore, threshold)` keeps only
    starts whose reading of that ore is at least the threshold (what a 3-durability reading at the stone would show)."""
    sz = 4096 // 4
    if kind.startswith("stone-"):
        pts = []
        while len(pts) < n:
            cand = stone_sites(g, kind[6:], rng, n * 3)
            if need:
                cand = [(x, z) for x, z in cand if g.read[need[0]][(z - g.z0) // 4, (x - g.x0) // 4] >= need[1]]
            pts += cand
        return pts[:n]
    if kind == "any":
        i = rng.integers(8, sz - 8, size=(n, 2))
    else:
        grid = g.read[kind]
        cand = np.argwhere((grid >= lo) & (grid < hi))
        cand = cand[(cand > 8).all(1) & (cand < sz - 8).all(1)]
        i = cand[rng.integers(0, len(cand), size=n)]
    return [(int(g.x0 + a[1] * 4), int(g.z0 + a[0] * 4)) for a in i]


def run_batch(g: Ground, st: Strategy, pts):
    out = []
    for x, z in pts:
        sh = Shaft(g)
        out.append(sh.new_run(st, x, z).run().result())
    return pd.DataFrame(out)


if __name__ == "__main__":
    import sys
    import time
    name = sys.argv[1] if len(sys.argv) > 1 else "w4k_s1"
    t = time.time()
    g = Ground(name)
    print("loaded", round(time.time() - t), "s", "slab bodies", int(g.slab.sum()))
    rng = np.random.default_rng(1)
    for kind, lo, hi in [("any", 0, 0), ("gold", 0.002, 1), ("silver", 0.002, 1)]:
        pts = starts(g, kind, 60, rng, lo, hi)
        for st in (Strategy(sweep="never"), Strategy(), Strategy(sweep="always"), Strategy(harvest="oracle")):
            t = time.time()
            r = run_batch(g, st, pts)
            n = r.gold + r.silver
            print(f"{kind:7s} {st.label:40s} cost {r.cost.mean():6.0f}  gold {r.gold.mean():5.1f} silver {r.silver.mean():5.1f}"
                  f"  per100 {100 * n.sum() / r.cost.sum():5.2f}  P(any) {np.mean(n > 0):.2f}  slabs {r.slabs.mean():.1f}  {time.time() - t:.0f}s")
