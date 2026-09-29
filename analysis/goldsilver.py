"""Gold and silver prospecting study: facts about quartz slabs, the signals a player has, and strategy evaluation.

  uv run python gs_cache.py w4k_s1 w4k_s2 w4k_s3        # once: compact quartz/gold/silver arrays per world
  uv run python goldsilver.py w4k_s1 w4k_s2 w4k_s3      # writes ../data/goldsilver.json (~1 minute)
  uv run python goldsilver.py --embed                   # copies that JSON into ../report/goldsilver.html

Sections of the JSON: facts (slabs, nuggets), signals (density readings, loose stones), scenarios (where you start),
variants (each rule of the routine switched off or changed), patch (shaft spacing), all pooled over the worlds.
"""
import json
import multiprocessing as mp
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from goldminer import Ground, Shaft, Strategy, run_batch, starts
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
TRIALS = 600
BOOT = 300
MENTION = 0.002          # the game lists an ore as "miniscule" from here
VERY_POOR = 0.025        # ... and gives it a density word from here
GS = []                  # Ground per world, shared with forked workers


# ---------------------------------------------------------------------------------------------------------------
# facts
# ---------------------------------------------------------------------------------------------------------------
def q(a, ps=(5, 25, 50, 75, 95)):
    return [float(v) for v in np.percentile(a, ps)]


def facts(g: Ground):
    z = np.load(Survey(g.name).dir / "gs.npz")
    lab, slab = g.qlab, g.slab
    nq = len(lab)
    out = {"quartz_blocks": nq, "slab_bodies": int(slab.sum()), "slab_share_of_quartz": float(slab[lab].mean())}
    # columns of slab bodies
    body = g.ckeys >> 26
    xz = g.ckeys & ((1 << 26) - 1)
    ext = g.cmax - g.cmin + 1
    out["columns_per_slab"] = q(np.bincount(body, minlength=len(slab))[slab])
    out["extent_per_column"] = {"median": float(np.median(ext)), "share_1": float((ext == 1).mean()),
                                "share_le3": float((ext <= 3).mean()), "p99": float(np.percentile(ext, 99))}
    for name, dk in (("x", 1 << 13), ("z", 1)):
        i = np.searchsorted(g.ckeys, g.ckeys + dk)
        ok = (i < len(g.ckeys)) & (g.ckeys[np.minimum(i, len(g.ckeys) - 1)] == g.ckeys + dk)
        dy = np.abs(g.cmin[i[ok]] - g.cmin[ok])
        out["tilt_" + name] = {"share_0": float((dy == 0).mean()), "share_le1": float((dy <= 1).mean())}
    cnt = np.bincount(np.unique(xz, return_inverse=True)[1])
    out["columns_with_slab"] = float(len(cnt) / 4096 ** 2)
    out["columns_with_two_slabs"] = float((cnt >= 2).sum() / 4096 ** 2)
    xr, zr = xz >> 13, xz & 8191
    depth = g.h[zr, xr].astype(int) - g.cmax
    out["slab_depth"] = q(depth, (5, 25, 50, 75, 95, 99))
    out["slab_depth_hist"] = np.histogram(depth.clip(0, 199), bins=range(0, 201, 10))[0].tolist()
    # nuggets: per slab
    per = {}
    for ore, key in (("gold", "quartz_nativegold_xyz"), ("silver", "quartz_nativesilver_xyz")):
        a = z[key].astype(np.float64)
        d, i = g.qtree.query(a, p=np.inf)
        nb = lab[i]
        cnt = np.bincount(nb, minlength=len(slab))[slab]
        srt = np.sort(cnt)[::-1]
        n = len(cnt)
        cl = z[ore + "_clouds"]
        ct = cKDTree(cl)
        dd, jj = ct.query(a, p=np.inf, distance_upper_bound=8)
        per_cloud = np.bincount(jj[np.isfinite(dd)], minlength=len(cl))
        nug_depth = g.h[a[:, 2].astype(int) - g.z0, a[:, 0].astype(int) - g.x0].astype(int) - a[:, 1]
        per[ore] = {"blocks": int(len(a)), "in_slab_touching": float((d <= 1).mean()),
                    "share_slabs_any": float((cnt > 0).mean()), "per_slab_mean": float(cnt.mean()),
                    "top10pct_share": float(srt[:max(1, n // 10)].sum() / srt.sum()),
                    "top1pct_share": float(srt[:max(1, n // 100)].sum() / srt.sum()),
                    "per_1000_quartz": float(1000 * len(a) / nq),
                    "clouds": int(len(cl)), "blocks_per_cloud_mean": float(per_cloud.mean()),
                    "clouds_empty": float((per_cloud == 0).mean()), "blocks_per_cloud_p90": float(np.percentile(per_cloud, 90)),
                    "depth": q(nug_depth, (5, 25, 50, 75, 95))}
    out["nuggets"] = per
    return out


def pool(fs, key_fn):
    vals = [key_fn(f) for f in fs]
    return {"mean": float(np.mean(vals)), "min": float(np.min(vals)), "max": float(np.max(vals))}


# ---------------------------------------------------------------------------------------------------------------
# signals
# ---------------------------------------------------------------------------------------------------------------
def signals(worlds):
    rng = np.random.default_rng(11)
    rich_rows, walk_rows, persist = [], [], {}
    stones = {"quartz": [], "gold": [], "silver": []}
    stone_slabs = []
    for g in GS:
        z = np.load(Survey(g.name).dir / "gs.npz")
        area_km2 = 4096 * 4096 / 1e6
        # loose stones, expected per km2 (formulas in DiscDepositGenerator / ChildDepositGenerator)
        for k, key, f in (("quartz", "quartz_xyz", lambda d: 0.35 * 0.05 * np.clip(1.11 - d / 9.0, 0, None)),
                          ("gold", "quartz_nativegold_xyz", lambda d: 0.65 * 0.1 * np.clip(1 - d / 8.0, 0, None)),
                          ("silver", "quartz_nativesilver_xyz", lambda d: 0.65 * 0.1 * np.clip(1 - d / 8.0, 0, None))):
            a = z[key]
            d = g.h[a[:, 2] - g.z0, a[:, 0] - g.x0].astype(int) - a[:, 1]
            p = f(d)
            stones[k].append(float(p.sum() / area_km2))
            if k == "quartz":
                e = np.bincount(g.qlab, weights=p, minlength=len(g.slab))[g.slab]
                stone_slabs.append(float((1 - np.exp(-e)).mean()))
                shallow = np.unique(a[d <= 9][:, 2].astype(np.int64) * 10000 + a[d <= 9][:, 0] - g.x0)
                stones["shallow_columns"] = stones.get("shallow_columns", []) + [float(len(shallow) / 4096 ** 2)]
        # readings
        N = 1024
        for ore, key in (("gold", "quartz_nativegold_xyz"), ("silver", "quartz_nativesilver_xyz")):
            grid = g.read[ore]
            nug = z[key]
            nt = cKDTree(nug[:, [0, 2]])
            pts = np.stack(np.meshgrid(np.arange(N), np.arange(N)), -1).reshape(-1, 2)
            pick = rng.choice(len(pts), 80000, replace=False)
            P = pts[pick]
            v = grid[P[:, 1], P[:, 0]]
            near = np.array([len(c) for c in nt.query_ball_point(P * 4 + [g.x0, g.z0], 48, p=np.inf)])
            band = np.digitize(v, [MENTION, 0.005, 0.01, VERY_POOR])
            band = np.where(v <= 0, -1, band)
            for b, n in zip(band, near):
                rich_rows.append((ore, int(b), int(n)))
            # walking search: straight walks, one reading every D blocks until a reading mentions the ore
            for D in (32, 48, 64, 96, 128):
                T = 1500
                st = rng.uniform(200, N * 4 - 200, (T, 2))
                ang = rng.uniform(0, 2 * np.pi, T)
                step = np.stack([np.cos(ang), np.sin(ang)], 1) * D
                dist = np.full(T, np.nan)
                for k in range(int(8000 / D)):
                    p = np.abs(st + step * k) % (2 * N * 4)
                    p = np.where(p >= N * 4, 2 * N * 4 - p - 1, p)
                    i = (p / 4).astype(int).clip(0, N - 1)
                    hit = np.isnan(dist) & (grid[i[:, 1], i[:, 0]] >= MENTION)
                    dist[hit] = k
                    if not np.isnan(dist).any():
                        break
                walk_rows.append((ore, D, float(np.nanmean(dist) + 1), float(np.isnan(dist).mean())))
            m = grid >= MENTION
            for S in (2, 4, 8, 16, 32, 64):
                a, b = m[:, :-S], m[:, S:]
                persist.setdefault(ore, {}).setdefault(S * 4, []).append(float((a & b).sum() / a.sum()))
            persist[ore].setdefault("base", []).append(float(m.mean()))
    r = pd.DataFrame(rich_rows, columns=["ore", "band", "n"])
    bands = {-1: "no reading", 0: "0.002-0.005", 1: "0.005-0.01", 2: "0.01-0.025", 3: ">0.025 (density word)", 4: ">0.025 (density word)"}
    rich = {}
    for ore, d in r.groupby("ore"):
        rows = []
        # merge the two top bins (both mean a density word); band 0 = below MENTION but positive
        d = d.assign(band=d.band.replace({4: 3}))
        for b, dd in d.groupby("band"):
            rows.append({"band": {-1: "no reading", 0: "positive, below 0.002", 1: "0.002-0.005", 2: "0.005-0.01", 3: "0.01-0.025", 4: ">0.025"}.get(b, str(b)),
                         "code": int(b), "share": float(len(dd) / len(d)), "mean_nuggets": float(dd.n.mean()),
                         "p_any": float((dd.n > 0).mean()), "p_ge20": float((dd.n >= 20).mean())})
        rich[ore] = rows
    w = pd.DataFrame(walk_rows, columns=["ore", "D", "readings", "notfound"]).groupby(["ore", "D"]).mean().reset_index()
    return {"richness_by_reading": rich,
            "walk": {o: dd[["D", "readings", "notfound"]].to_dict("records") for o, dd in w.groupby("ore")},
            "persistence": {o: {str(k): float(np.mean(v)) for k, v in d.items()} for o, d in persist.items()},
            "loose_stones_per_km2": {k: float(np.mean(v)) for k, v in stones.items() if k != "shallow_columns"},
            "slab_with_stone": float(np.mean(stone_slabs)), "columns_slab_within_9": float(np.mean(stones["shallow_columns"]))}


# ---------------------------------------------------------------------------------------------------------------
# simulation
# ---------------------------------------------------------------------------------------------------------------
DEEP = dict()
SHALLOW = dict(max_depth=24, first_probe=6)
MAIN = Strategy(**DEEP)
MAIN_SHALLOW = Strategy(**SHALLOW)
DIRS8 = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]

POPS = {
    "blind": ("any", None, None, None),
    "gold mention": ("gold", MENTION, 1, None),
    "silver mention": ("silver", MENTION, 1, None),
    "gold 0.01+": ("gold", 0.01, 1, None),
    "silver 0.01+": ("silver", 0.01, 1, None),
    "stone: quartz": ("stone-quartz", None, None, None),
    "stone: quartz, gold mention": ("stone-quartz", None, None, ("gold", MENTION)),
    "stone: quartz, silver mention": ("stone-quartz", None, None, ("silver", MENTION)),
    "stone: gold nugget": ("stone-gold", None, None, None),
    "stone: silver nugget": ("stone-silver", None, None, None),
}


def _batch(a):
    wi, pop, st, seed, n = a
    kind, lo, hi, need = POPS[pop]
    rng = np.random.default_rng(seed)
    pts = starts(GS[wi], kind, n, rng, lo, hi, need)
    r = run_batch(GS[wi], st, pts)
    r["world"] = wi
    return r


def _patch(a):
    wi, pop, d, seed, n = a
    kind, lo, hi, need = POPS[pop]
    g = GS[wi]
    rng = np.random.default_rng(seed)
    rows = []
    for t, (x, z) in enumerate(starts(g, kind, n, rng, lo, hi, need)):
        dx, dz = DIRS8[rng.integers(0, 8)]
        sh = Shaft(g)
        for k in range(4):
            xx, zz = x + dx * d * k, z + dz * d * k
            if not (g.x0 + 64 < xx < g.x0 + 4096 - 64 and g.z0 + 64 < zz < g.z0 + 4096 - 64):
                break
            r = sh.new_run(MAIN, xx, zz).run().result()
            r.update(k=k, trial=t, world=wi)
            rows.append(r)
    r = pd.DataFrame(rows)
    r["d"], r["pop"] = d, pop
    return r


def summarise(df, boot=BOOT, seed=0):
    """Pooled ore blocks per 100 durability with a bootstrap interval over shafts, plus per-shaft outcome stats."""
    n = (df.gold + df.silver).to_numpy()
    c = df.cost.to_numpy()
    rng = np.random.default_rng(seed)
    b = []
    for _ in range(boot):
        i = rng.integers(0, len(df), len(df))
        b.append(100 * n[i].sum() / c[i].sum())
    pw = [100 * (w.gold + w.silver).sum() / w.cost.sum() for _, w in df.groupby("world")]
    propick = 2 * df.probes.to_numpy()
    return {"per100": float(100 * n.sum() / c.sum()), "lo": float(np.percentile(b, 5)), "hi": float(np.percentile(b, 95)),
            "per100_worlds": [float(v) for v in pw],
            "gold100": float(100 * df.gold.sum() / c.sum()), "silver100": float(100 * df.silver.sum() / c.sum()),
            "cost": float(c.mean()), "gold": float(df.gold.mean()), "silver": float(df.silver.mean()),
            "p_any": float((n > 0).mean()), "median": float(np.median(n)), "p90": float(np.percentile(n, 90)),
            "propick_share": float(propick.sum() / c.sum()), "beyond_trace": float(df.bucketed.sum() / max(df.positive.sum(), 1)), "slabs": float(df.slabs.mean()),
            "first": float(np.nanmedian(df["first"])) if df["first"].notna().any() else None, "shafts": int(len(df))}


VARIANTS = [  # (group, label, strategy)
    ("routine", "The routine (probe 13, to 120, arms after a hit 4 x 40, 4 lanes)", MAIN),
    ("sweep", "Never sweep (harvest around the first hit only)", Strategy(sweep="never")),
    ("sweep", "Sweep every slab found, hit or not", Strategy(sweep="always")),
    ("arms", "2 arms instead of 4", Strategy(arms=2)),
    ("arms", "Arms 24 long", Strategy(arm_len=24)),
    ("arms", "Arms 64 long", Strategy(arm_len=64)),
    ("arms", "Arms stop after 2 empty probes", Strategy(patience=2)),
    ("lanes", "Harvest lanes: 2 (at +-3) instead of 4", Strategy(lanes=(3, -3))),
    ("lanes", "Harvest lanes: none (main tunnel only)", Strategy(lanes=(0,))),
    ("spacing", "Probe every 10", Strategy(spacing=10)),
    ("spacing", "Probe every 16", Strategy(spacing=16)),
    ("spacing", "Probe every 19", Strategy(spacing=19)),
    ("depth", "Shaft to 64", Strategy(max_depth=64)),
    ("depth", "Shaft to 96", Strategy(max_depth=96)),
    ("aim", "Perfect aim at hits (lower bound on cost)", Strategy(harvest="oracle")),
]
SHALLOW_VARIANTS = [
    ("routine", "Shallow routine (probe at 6 and 19, arms after a hit)", MAIN_SHALLOW),
    ("sweep", "Never sweep", Strategy(sweep="never", **SHALLOW)),
    ("sweep", "Sweep the slab whether or not the probe saw nuggets", Strategy(sweep="always", **SHALLOW)),
    ("arms", "2 arms", Strategy(arms=2, **SHALLOW)),
    ("aim", "Perfect aim at hits", Strategy(harvest="oracle", **SHALLOW)),
]


def simulate(pool_, ):
    out = {"trials_per_world": TRIALS, "strategy": {k: getattr(MAIN, k) for k in ("spacing", "max_depth", "sweep", "arms", "arm_len", "lanes")}}
    jobs, keys = [], []
    for pop in POPS:
        deep = not pop.startswith("stone")
        for wi in range(len(GS)):
            jobs.append((wi, pop, MAIN if deep else MAIN_SHALLOW, 100 * wi + len(keys), TRIALS))
            keys.append(("scenario", pop))
    for pop in ("blind", "gold mention", "silver mention"):
        for grp, label, st in VARIANTS:
            for wi in range(len(GS)):
                jobs.append((wi, pop, st, 1000 + wi, TRIALS))
                keys.append(("variant", pop, grp, label))
    for pop in ("stone: quartz", "stone: quartz, silver mention", "stone: gold nugget"):
        for grp, label, st in SHALLOW_VARIANTS:
            for wi in range(len(GS)):
                jobs.append((wi, pop, st, 2000 + wi, TRIALS))
                keys.append(("variant", pop, grp, label))
    res = pool_.map(_batch, jobs, chunksize=1)
    frames = {}
    for k, r in zip(keys, res):
        frames.setdefault(k, []).append(r)
    scen, var = {}, []
    for k, rs in frames.items():
        s = summarise(pd.concat(rs))
        if k[0] == "scenario":
            scen[k[1]] = s
        else:
            var.append({"pop": k[1], "group": k[2], "label": k[3], **s})
    out["scenarios"], out["variants"] = scen, var
    # spacing between shafts
    pj = [(wi, pop, d, 3000 + wi + d, 400) for pop in ("blind", "gold mention", "silver mention") for d in (16, 32, 48, 64, 96) for wi in range(len(GS))]
    pr = pd.concat(pool_.map(_patch, pj, chunksize=1))
    pr["n"] = pr.gold + pr.silver
    full = pr.groupby(["pop", "d", "world", "trial"]).k.transform("count") == 4
    pr = pr[full]
    out["patch"] = [{"pop": pop, "d": int(d), "per100": [float(100 * x.n.sum() / x.cost.sum()) for _, x in g_.groupby("k")],
                     "nuggets": [float(x.n.mean()) for _, x in g_.groupby("k")]} for (pop, d), g_ in pr.groupby(["pop", "d"], sort=False)]
    return out


def main(names):
    global GS
    t = time.time()
    GS = [Ground(n) for n in names]
    print("loaded", round(time.time() - t), "s", flush=True)
    fs = [facts(g) for g in GS]
    print("facts", round(time.time() - t), "s", flush=True)
    sig = signals(names)
    print("signals", round(time.time() - t), "s", flush=True)
    with mp.get_context("fork").Pool(min(22, mp.cpu_count())) as p:
        sim = simulate(p)
    print("simulation", round(time.time() - t), "s", flush=True)
    out = {"worlds": names, "facts": fs, "signals": sig, **sim,
           "durability": {"copper": 150, "tinbronze": 250, "bismuthbronze": 300, "blackbronze": 350, "iron": 650, "steel": 1625}}
    (ROOT / "data/goldsilver.json").write_text(json.dumps(out))
    print("wrote data/goldsilver.json")


def embed():
    page = ROOT / "report/goldsilver.html"
    data = (ROOT / "data/goldsilver.json").read_text()
    html = page.read_text()
    html = re.sub(r"(/\*DATA\*/).*?(/\*END\*/)", lambda m: m.group(1) + data + m.group(2), html, flags=re.S)
    page.write_text(html)
    print("embedded", len(data), "bytes into", page)


if __name__ == "__main__":
    if sys.argv[1:] == ["--embed"]:
        embed()
    else:
        main(sys.argv[1:] or ["w4k_s1", "w4k_s2", "w4k_s3"])
