"""Bayesian direction finding: the propick as a sensor.

After a node search hit, the player keeps a set of hypotheses "a body shaped like S sits at offset O".
Shapes come from a library of real ore bodies (from other worlds than the one being mined). Every piece of
evidence re-weights the hypotheses:
  - node-search counts at any probe (the exact game rule: blocks inside the cube),
  - the shaft already dug (a body touching it would have been seen and mined),
  - tunnel segments that revealed nothing.
Next action = the one with the best chance of revealing ore per durability: a probe at another shaft height
while the level is uncertain, then 2-high tunnel segments from any dug point.

All geometry is in a local frame centred on the hit probe.
"""
from dataclasses import dataclass

import numpy as np

from miner import FLOOR_Y, Run, Strategy

DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]


class ShapeLib:
    """Occupancy, summed-volume tables and face-dilated occupancy for a list of body shapes."""

    def __init__(self, shapes, R):
        self.R = R
        dims, occ_base, sat_base, dil_base = [], [], [], []
        occ_flat, sat_flat, dil_flat = [], [], []
        o = s_ = d_ = 0
        self.sizes = []
        for pts in shapes:
            pts = pts - pts.min(0)
            sx, sy, sz = pts.max(0) + 1
            g = np.zeros((sx, sy, sz), dtype=np.int32)
            g[pts[:, 0], pts[:, 1], pts[:, 2]] = 1
            sat = np.zeros((sx + 1, sy + 1, sz + 1), dtype=np.int32)
            sat[1:, 1:, 1:] = g.cumsum(0).cumsum(1).cumsum(2)
            dil = np.zeros((sx + 2, sy + 2, sz + 2), dtype=bool)
            core = g.astype(bool)
            dil[1:-1, 1:-1, 1:-1] |= core
            dil[:-2, 1:-1, 1:-1] |= core
            dil[2:, 1:-1, 1:-1] |= core
            dil[1:-1, :-2, 1:-1] |= core
            dil[1:-1, 2:, 1:-1] |= core
            dil[1:-1, 1:-1, :-2] |= core
            dil[1:-1, 1:-1, 2:] |= core
            dims.append((sx, sy, sz))
            sat_base.append(s_)
            dil_base.append(d_)
            sat_flat.append(sat.ravel())
            dil_flat.append(dil.ravel())
            s_ += sat.size
            d_ += dil.size
            self.sizes.append(len(pts))
        self.dims = np.array(dims, dtype=np.int32)
        self.sat_base = np.array(sat_base, dtype=np.int64)
        self.dil_base = np.array(dil_base, dtype=np.int64)
        self.sat = np.concatenate(sat_flat)
        self.dil = np.concatenate(dil_flat)
        self.sizes = np.array(self.sizes)
        self._init_hypotheses()

    def box_count(self, sid, ox, oy, oz, lo, hi):
        """Blocks of each hypothesis inside the inclusive box [lo, hi] (local frame)."""
        d = self.dims[sid]
        a = [np.clip(lo[i] - (ox, oy, oz)[i], 0, d[:, i]) for i in range(3)]
        b = [np.clip(hi[i] + 1 - (ox, oy, oz)[i], 0, d[:, i]) for i in range(3)]
        sy1, sz1 = d[:, 1] + 1, d[:, 2] + 1
        base = self.sat_base[sid]

        def at(x, y, z):
            return self.sat[base + (x * sy1 + y) * sz1 + z]
        n = (at(b[0], b[1], b[2]) - at(a[0], b[1], b[2]) - at(b[0], a[1], b[2]) - at(b[0], b[1], a[2])
             + at(a[0], a[1], b[2]) + at(a[0], b[1], a[2]) + at(b[0], a[1], a[2]) - at(a[0], a[1], a[2]))
        empty = (a[0] >= b[0]) | (a[1] >= b[1]) | (a[2] >= b[2])
        return np.where(empty, 0, n)

    def touches(self, sid, ox, oy, oz, cells):
        """True where the body is equal or face-adjacent to any of the cells."""
        d = self.dims[sid] + 2
        base = self.dil_base[sid]
        hit = np.zeros(len(sid), dtype=bool)
        for (cx, cy, cz) in cells:
            lx, ly, lz = cx - ox + 1, cy - oy + 1, cz - oz + 1
            ok = (lx >= 0) & (ly >= 0) & (lz >= 0) & (lx < d[:, 0]) & (ly < d[:, 1]) & (lz < d[:, 2])
            idx = base + (np.where(ok, lx, 0) * d[:, 1] + np.where(ok, ly, 0)) * d[:, 2] + np.where(ok, lz, 0)
            hit |= ok & self.dil[idx]
        return hit

    def _init_hypotheses(self):
        """Every (shape, offset) whose body intersects the probe cube at the origin, with its count there."""
        R = self.R
        parts = []
        for sid, (sx, sy, sz) in enumerate(self.dims):
            ox, oy, oz = np.meshgrid(np.arange(-R - sx + 1, R + 1), np.arange(-R - sy + 1, R + 1),
                                     np.arange(-R - sz + 1, R + 1), indexing="ij")
            ox, oy, oz = ox.ravel(), oy.ravel(), oz.ravel()
            s = np.full(len(ox), sid, dtype=np.int32)
            k = self.box_count(s, ox, oy, oz, (-R, -R, -R), (R, R, R))
            keep = k > 0
            parts.append((s[keep], ox[keep], oy[keep], oz[keep], k[keep]))
        self.h_sid, self.h_ox, self.h_oy, self.h_oz, self.h_k0 = (np.concatenate(p) for p in zip(*parts))


def likelihood(obs, pred):
    """Soft count match: other bodies of the same ore in the cube add to the count."""
    tau = 1.0 + 0.25 * np.maximum(obs, pred)
    return np.exp(-np.abs(obs - pred) / tau)


class Posterior:
    def __init__(self, lib: ShapeLib, c0, max_particles=30000, rng=None):
        self.lib = lib
        w = likelihood(c0, lib.h_k0)
        keep = w > 1e-3 * w.max()
        idx = np.nonzero(keep)[0]
        w = w[idx]
        rng = rng or np.random.default_rng(0)
        if len(idx) > max_particles:
            pick = rng.choice(len(idx), size=max_particles, replace=True, p=w / w.sum())
            u, cnt = np.unique(pick, return_counts=True)
            idx, w = idx[u], cnt.astype(float)
        self.sid, self.ox, self.oy, self.oz = lib.h_sid[idx], lib.h_ox[idx], lib.h_oy[idx], lib.h_oz[idx]
        self.w = w / w.sum()

    def alive(self):
        return self.w.sum() > 0 and np.isfinite(self.w).all()

    def _norm(self):
        s = self.w.sum()
        if s > 0:
            self.w /= s

    def predict(self, p):
        R = self.lib.R
        return self.lib.box_count(self.sid, self.ox, self.oy, self.oz,
                                  (p[0] - R, p[1] - R, p[2] - R), (p[0] + R, p[1] + R, p[2] + R))

    def observe_count(self, p, c):
        self.w = self.w * likelihood(c, self.predict(p))
        self._norm()

    def observe_dug(self, cells, soft=0.02):
        """Cells were dug and showed no ore of this kind: hypotheses touching them become unlikely."""
        t = self.lib.touches(self.sid, self.ox, self.oy, self.oz, cells)
        self.w = np.where(t, self.w * soft, self.w)
        self._norm()

    def observe_shaft(self, y_lo, y_hi, soft=0.02):
        """The shaft column (0, y, 0) for y in [y_lo, y_hi] was dug without seeing this body."""
        d = self.lib.dims[self.sid] + 2
        lx, lz = -self.ox + 1, -self.oz + 1
        inside = (lx >= 0) & (lz >= 0) & (lx < d[:, 0]) & (lz < d[:, 2])
        # body y-extent overlaps the dug range (conservative: whole column of the bounding box)
        overlap = (self.oy - 1 <= y_hi) & (self.oy + d[:, 1] - 2 >= y_lo)
        cand = inside & overlap & (self.w > 0)
        if cand.any():
            ids = np.nonzero(cand)[0]
            hit = np.zeros(len(ids), dtype=bool)
            for y in range(y_lo, y_hi + 1):
                sub = ~hit
                if not sub.any():
                    break
                j = ids[sub]
                hit[sub] = self.lib.touches(self.sid[j], self.ox[j], self.oy[j], self.oz[j], [(0, y, 0)])
            self.w[ids[hit]] *= soft
            self._norm()

    def layer_prob(self, y):
        """P(the body has blocks within the band a 2-high tunnel at level y can see: y-1 .. y+2)."""
        top = self.oy + self.lib.dims[self.sid][:, 1] - 1
        return float(self.w[(self.oy <= y + 2) & (top >= y - 1)].sum())

    def reveal_prob(self, cells):
        t = self.lib.touches(self.sid, self.ox, self.oy, self.oz, cells)
        return float(self.w[t].sum()), t


@dataclass(frozen=True)
class BayesStrategy(Strategy):
    localise: str = "bayes"
    level_mode: str = "edge"             # "fixed": probe level_probes offsets; "adaptive": pick probes by predicted-count spread
    max_level_probes: int = 4
    level_confidence: float = 0.7
    segment: int = 3
    min_reveal_per_cost: float = 0.012   # stop when the best segment reveals ore with less than this chance per durability
    probe_std: float = 2.5               # probe after a segment when the predicted-count spread is at least this
    sideways: str = "greedy"             # "greedy": best reveal chance per cost; "directed": model picks a direction, then follow the count
    ray: int = 12                        # blocks ahead considered when picking a direction

    @property
    def label(self):
        return Strategy.label.fget(self) + " (smart aim)"


class BayesRun(Run):
    lib: ShapeLib = None

    def localise(self, p0, c0):
        if self.st.localise != "bayes":
            return super().localise(p0, c0)
        return self._bayes(p0, c0)

    def _bayes(self, p0, c0):
        st, X, Y0, Z = self.st, self.x, p0[1], self.z
        found = False
        post = Posterior(self.lib, c0)
        # evidence already in hand: earlier shaft probes and the shaft itself
        for (q, c) in self.probes[:-1]:
            post.observe_count((q[0] - X, q[1] - Y0, q[2] - Z), c)
        post.observe_shaft(self.cursor - Y0, self.h - 1 - Y0)
        if not post.alive():
            return super()._gradient(p0, c0)

        # 1. level: probe the shaft where predicted counts disagree most, until one level is likely
        def best_level():
            ys = range(-st.radius - 2, st.radius + 3)
            return max(ys, key=lambda y: post.layer_prob(y))
        if st.level_mode == "edge":
            ys, f = self._edge_level(Y0, c0)
            found |= f
            for (q, c) in self.probes:
                if (q[0], q[2]) == (X, Z) and q[1] != Y0:
                    post.observe_count((0, q[1] - Y0, 0), c)
            post.observe_shaft(self.cursor - Y0, self.h - 1 - Y0)
        elif st.level_mode == "fixed":
            for dy in st.level_probes:
                y = Y0 + dy
                if y >= self.h or y < FLOOR_Y:
                    continue
                if y < self.cursor:
                    found |= self.dig_shaft_to(y)
                c = self.probe((X, y, Z))
                post.observe_count((0, dy, 0), c)
            post.observe_shaft(self.cursor - Y0, self.h - 1 - Y0)
        for _ in range(st.max_level_probes if st.level_mode == "adaptive" else 0):
            yb = best_level()
            if post.layer_prob(yb) >= st.level_confidence:
                break
            best, best_score = None, 0.0
            for dy in range(-8, 9):
                y = Y0 + dy
                if dy == 0 or y >= self.h or y < FLOOR_Y:
                    continue
                pred = post.predict((0, dy, 0))
                m = (post.w * pred).sum()
                var = (post.w * (pred - m) ** 2).sum()
                cost = 2 + max(0, self.cursor - y)
                score = var / cost
                if score > best_score:
                    best, best_score = dy, score
            if best is None:
                break
            y = Y0 + best
            if y < self.cursor:
                found |= self.dig_shaft_to(y)
                post.observe_shaft(self.cursor - Y0, self.h - 1 - Y0)
            c = self.probe((X, y, Z))
            post.observe_count((0, best, 0), c)
        ly = (ys - Y0) if st.level_mode == "edge" else best_level()
        level = Y0 + ly
        if level < self.cursor:
            found |= self.dig_shaft_to(level)

        if st.sideways == "directed":
            return self._directed(post, X, Z, level, ly, found)

        # 2. tunnel from any dug point at that level toward the likeliest ore
        frontier = [(0, ly, 0)]
        spent0 = self.cost
        rounds = 0
        while self.cost - spent0 < st.give_up and rounds < 4:
            best = None
            for f in frontier:
                for d in DIRS:
                    cells, x, z = [], f[0], f[2]
                    for _ in range(st.segment):
                        x += d[0]
                        z += d[1]
                        for c in ((x, ly, z), (x, ly + 1, z)):
                            if (c[0] + X, c[1] + Y0, c[2] + Z) not in self.dug:
                                cells.append(c)
                    if not cells:
                        continue
                    p, _ = post.reveal_prob(cells)
                    score = p / len(cells)
                    if best is None or score > best[0]:
                        best = (score, f, d, cells)
            if best is None or best[0] < st.min_reveal_per_cost:
                break
            _, f, d, cells = best
            start = (f[0] + X, level, f[2] + Z)
            end, got = self.tunnel(start, d, st.segment)
            endl = (end[0] - X, ly, end[2] - Z)
            frontier = [p for p in frontier if p != f] + [f, endl]
            frontier = frontier[-6:]
            if got:
                found = True
                rounds += 1
                c = self.probe(end)
                if c < st.min_count:
                    break
                # new search centred on the find, same level
                X, Z = end[0], end[2]
                Y0 = level
                ly = 0
                post = Posterior(self.lib, c)
                frontier = [(0, 0, 0)]
                spent0 = self.cost
                continue
            post.observe_dug(cells)
            pred = post.predict(endl)
            m = (post.w * pred).sum()
            if np.sqrt((post.w * (pred - m) ** 2).sum()) >= st.probe_std:
                post.observe_count(endl, self.probe(end))
            if not post.alive():
                break
        return found, level


def _ray_cells(ly, d, n, start=(0, 0)):
    cells, x, z = [], start[0], start[1]
    for _ in range(n):
        x += d[0]
        z += d[1]
        cells += [(x, ly, z), (x, ly + 1, z)]
    return cells


def _directed(self, post, X, Z, level, ly, found):
    """Pick the direction whose next `ray` blocks most likely reveal ore; walk it following the count
    (as the routine does); if the count drops, re-pick with the new evidence, up to the give-up budget."""
    st = self.st
    start_cost = self.cost
    pos = (X, level, Z)
    c = self.probe(pos)
    tried = set()
    while self.cost - start_cost < st.give_up:
        lx, lz = pos[0] - X, pos[2] - Z
        best = None
        for d in DIRS:
            if (pos, d) in tried:
                continue
            p, _ = post.reveal_prob(_ray_cells(ly, d, st.ray, (lx, lz)))
            if best is None or p > best[0]:
                best = (p, d)
        if best is None or best[0] < 0.05:
            break
        d = best[1]
        tried.add((pos, d))
        while self.cost - start_cost < st.give_up:
            prev = pos
            pos, got = self.tunnel(pos, d, st.arm)
            if got:
                return True, level
            post.observe_dug(_ray_cells(ly, d, st.arm, (prev[0] - X, prev[2] - Z)))
            nc = self.probe(pos)
            post.observe_count((pos[0] - X, ly, pos[2] - Z), nc)
            if nc < c:
                break
            c = nc
    return found, level


BayesRun._directed = _directed


def build_library(blocks_list, bodies_list, ore, n_shapes=250, seed=0):
    """Random bodies of one ore (any size) from the given worlds, as point arrays."""
    rng = np.random.default_rng(seed)
    shapes = []
    per = int(np.ceil(n_shapes / len(blocks_list)))
    for blocks, bodies in zip(blocks_list, bodies_list):
        ids = bodies.index[bodies.ore == ore].to_numpy()
        if not len(ids):
            continue
        pick = set(rng.choice(ids, size=min(per, len(ids)), replace=False).tolist())
        sub = blocks[blocks.body.isin(pick)]
        for _, g in sub.groupby("body"):
            shapes.append(g[["x", "y", "z"]].to_numpy())
    return shapes
