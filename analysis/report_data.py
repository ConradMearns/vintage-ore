"""Build report/data.json from one or more surveys: maps, depth profiles, body shapes, calibration,
strategies (pooled over surveys, with per-survey values), depth windows, side arms, keep-searching.

  uv run python analysis/report_data.py w4k_s1 w4k_s2 w4k_s3
"""
import base64
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import bodies as B
from miner import Strategy, World
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
SHAFT_SPACING = 32
MAP_CELLS = 256
MIN_ORE_BLOCKS = int(__import__("os").environ.get("MIN_ORE_BLOCKS", 500))

WORDS6 = ["very poor", "poor", "decent", "high", "very high", "ultra high"]
# The game's six words, with "very high" and "ultra high" merged (both rare; keeps buckets well sampled).
WORD_ORDER = ["none", "very poor", "poor", "decent", "high", "very high+"]
# Propick reading code (deposit variant) for block ore types whose names differ.
READING_CODE = {"quartz_nativesilver": "silver", "quartz_nativegold": "gold", "olivine_peridot": "peridot"}
# Deposits with oreMapScale != 1 hit a region-border shift in MapLayerOre.GenLayer (see PLAN.md).
REGION_SHIFTED = {"pentlandite", "chromite", "ilmenite", "anthracite", "lignite", "bituminouscoal"}


def report_word(f):
    f = np.asarray(f)
    w = np.array(WORDS6)[np.clip((f * 7.5).astype(int), 0, 5)]
    w = np.where(np.isin(w, ["very high", "ultra high"]), "very high+", w)
    return np.where(f > 0.025, w, "none")


BASELINE = Strategy(6, 6)
DEPTHS = [48, 64, 80, 96, 112, 128]


def strategies():
    out = []
    def add(st, family):
        out.append((st, family))
    for r, sp in [(2, 5), (4, 6), (4, 9), (6, 6), (6, 9), (6, 13), (8, 6), (8, 12), (8, 17)]:
        add(Strategy(r, sp), "probe")
    for r, sp in [(6, 13), (8, 17)]:
        for d in DEPTHS:
            add(Strategy(r, sp, max_depth=d), "depth")
        add(Strategy(r, sp, lateral=16), "lateral")
        add(Strategy(r, sp, lateral=32), "lateral")
        add(Strategy(r, sp, lateral=32, lateral_every=True), "lateral")
        add(Strategy(r, sp, stop_after_first=True), "other")
        add(Strategy(r, sp, min_count=10), "other")
    add(Strategy(6, 6, localise="oracle"), "aim")
    add(Strategy(6, 13, localise="oracle"), "aim")
    add(Strategy(8, 17, localise="oracle"), "aim")
    return out


STRATS = strategies()
WORLDS = {}


def _task(args):
    wi, ore, si = args
    W = WORLDS[wi]
    st, fam = STRATS[si]
    res, trace = W.simulate(ore, st)
    code = READING_CODE.get(ore, ore)
    res["reading"] = W.readings[code].to_numpy()[res.shaft] if code in W.readings else 0.0
    res["word"] = report_word(res.reading)
    res["world"] = wi
    if st == BASELINE:
        trace = trace.merge(res[["shaft", "word"]], on="shaft")
        trace["world"] = wi
    else:
        trace = None
    return wi, ore, si, res, trace


def agg(res):
    c = res.cost.sum()
    return {"rate": float(res["yield"].sum() / c * 100) if c else 0.0,
            "dep_per_1k": float(res.deposits.sum() / c * 1000) if c else 0.0,
            "cost": float(res.cost.mean()), "yield": float(res["yield"].mean()),
            "deposits": float(res.deposits.mean()), "n": int(len(res))}


def strategy_rows(results):
    rows = []
    for si, (st, fam) in enumerate(STRATS):
        res = pd.concat(results[si])
        row = {"label": st.label, "family": fam, "radius": st.radius, "spacing": st.spacing,
               "max_depth": st.max_depth if st.max_depth < 999 else None, "lateral": st.lateral,
               "lateral_every": st.lateral_every, "stop_after_first": st.stop_after_first,
               "min_count": st.min_count, "oracle": st.localise == "oracle", "baseline": st == BASELINE,
               **agg(res),
               "per_world": [round(agg(g)["rate"], 2) for _, g in res.groupby("world")],
               "by_word": {w: agg(g) for w, g in res.groupby("word") if len(g) >= 30}}
        rows.append(row)
    return rows


def calibration(res):
    out = {}
    for w in WORD_ORDER:
        g = res[res.word == w]
        if len(g) < 30:
            continue
        out[w] = {"n": int(len(g)), "p_any": float((g.deposits > 0).mean()), "deposits": float(g.deposits.mean()),
                  "yield": float(g["yield"].mean()),
                  "yield_q": [float(q) for q in g["yield"].quantile([.1, .25, .5, .75, .9])],
                  "cost": float(g.cost.mean()), "rate": float(g["yield"].sum() / g.cost.sum() * 100),
                  "p_any_world": [float((gg.deposits > 0).mean()) for _, gg in g.groupby("world")]}
    return out


def keep_searching(res):
    out = {}
    for w in WORD_ORDER:
        g = res[res.word == w]
        hit = g[g.first_cost.notna()]
        if len(hit) < 30:
            continue
        rest = (hit.cost - hit.first_cost).sum()
        out[w] = {"n": int(len(hit)), "first_rate": float(hit.first_yield.sum() / hit.first_cost.sum() * 100),
                  "continue_rate": float((hit["yield"] - hit.first_yield).sum() / rest * 100) if rest > 0 else None,
                  "continue_deposits_per_1k": float((hit.deposits - 1).sum() / rest * 1000) if rest > 0 else None,
                  "fresh_rate": float(g["yield"].sum() / g.cost.sum() * 100)}
    return out


def curves(trace, spacing):
    depths = np.arange(spacing, 181, spacing)
    out = {}
    trace = trace.assign(key=trace.world * 10_000_000 + trace.shaft)
    word = trace.groupby("key").word.first()
    piv = {v: trace.pivot_table(index="key", columns="depth", values=v).reindex(columns=depths).ffill(axis=1)
           for v in ("cost", "yield", "deposits")}
    for w in WORD_ORDER:
        ids = word.index[word == w]
        if len(ids) < 30:
            continue
        out[w] = {"n": int(len(ids)), "depth": depths.tolist(),
                  **{v: piv[v].loc[ids].mean().round(2).tolist() for v in piv}}
    return out


def neighbours(bodies_by_world, ore):
    D = np.arange(0, 97, 4)
    fd, fr, md, mr = [], [], [], []
    for bodies in bodies_by_world:
        dep = bodies[(bodies.ore == ore) & (bodies.n >= B.MIN_DEPOSIT_BLOCKS)]
        if len(dep) < 30:
            continue
        pts = dep[["cx", "cz"]].to_numpy()
        tree = cKDTree(pts)
        d_dep = tree.query(pts, k=2)[0][:, 1]
        rnd = np.random.default_rng(0).uniform(pts.min(0), pts.max(0), size=(20000, 2))
        d_rnd = tree.query(rnd, k=1)[0]
        fd.append([(d_dep <= x).mean() for x in D])
        fr.append([(d_rnd <= x).mean() for x in D])
        md.append(np.median(d_dep))
        mr.append(np.median(d_rnd))
    if not fd:
        return None
    return {"D": D.tolist(), "from_deposit": np.mean(fd, 0).tolist(), "from_random": np.mean(fr, 0).tolist(),
            "median_from_deposit": float(np.mean(md)), "median_from_random": float(np.mean(mr))}


def heatmaps(s: Survey, codes):
    step = s.size_x // MAP_CELLS
    step -= step % s.meta["readingSpacing"]
    r = s.q(f"SELECT x, z, ore, total_factor FROM readings WHERE (x - {s.x0}) % {step} = 0 AND (z - {s.z0}) % {step} = 0")
    n = s.size_x // step
    grids = {}
    for code in codes:
        sub = r[r.ore == code]
        g = np.zeros((n, n), dtype=np.uint8)
        g[(sub.z - s.z0) // step, (sub.x - s.x0) // step] = np.clip(sub.total_factor * 255 / 0.8, 0, 255)
        grids[code] = base64.b64encode(g.tobytes()).decode()
    return {"n": n, "step": step, "scale": 0.8, "grids": grids}


def depth_profiles(blocks_by_world, bodies_by_world):
    out = {}
    bins = np.arange(0, 181, 4)
    ybins = np.arange(0, 257, 4)
    for blocks, bodies in zip(blocks_by_world, bodies_by_world):
        shape = bodies["shape"].reindex(blocks.body).to_numpy()
        d = (blocks.surface - blocks.y).clip(lower=0).to_numpy()
        yv = blocks.y.to_numpy()
        for ore, idx in blocks.groupby("ore", observed=True).indices.items():
            o = out.setdefault(ore, {"bin": 4, "depth": {k: np.zeros(len(bins) - 1) for k in ("pancake", "clump", "speck")},
                                     "y": np.zeros(len(ybins) - 1)})
            for sh in o["depth"]:
                m = shape[idx] == sh
                o["depth"][sh] += np.histogram(d[idx][m], bins)[0]
            o["y"] += np.histogram(yv[idx], ybins)[0]
    n = len(blocks_by_world)
    return {ore: {"bin": 4, "depth": {k: (v / n).round(1).tolist() for k, v in o["depth"].items()},
                  "y": (o["y"] / n).round(1).tolist()} for ore, o in out.items()}


def shape_summary(bodies_all):
    rows = {}
    for ore, g in bodies_all.groupby("ore", observed=True):
        rows[ore] = {sh: {"bodies": int((g["shape"] == sh).sum()), "blocks": int(g.n[g["shape"] == sh].sum())}
                     for sh in ("pancake", "clump", "speck")}
        dep = g[g.n >= B.MIN_DEPOSIT_BLOCKS]
        rows[ore]["dims"] = None if dep.empty else {
            "med_thick": float(dep.yspan.median()), "med_span": float(dep.hspan.median()),
            "med_depth": float(dep.depth.median()), "p10_depth": float(dep.depth.quantile(.1)),
            "p90_depth": float(dep.depth.quantile(.9))}
    return rows


def main(names):
    t0 = time.time()
    surveys = [Survey(n) for n in names]
    loaded = [B.load(s) for s in surveys]
    print(f"loaded {len(surveys)} surveys in {time.time() - t0:.0f}s", flush=True)
    for wi, (s, (blocks, bodies)) in enumerate(zip(surveys, loaded)):
        WORLDS[wi] = World(s, blocks, bodies, shaft_spacing=SHAFT_SPACING, offset=SHAFT_SPACING // 2)

    totals = pd.concat([bl.ore.value_counts() for bl, _ in loaded]).groupby(level=0).sum()
    codes = set()
    for s in surveys:
        codes |= set(s.q("SELECT DISTINCT ore FROM readings").ore)
    ores = [o for o in totals.sort_values(ascending=False).index
            if totals[o] >= MIN_ORE_BLOCKS * len(surveys) and READING_CODE.get(o, o) in codes]
    print("ores:", ores, flush=True)
    for W in WORLDS.values():            # build KD-trees before forking so workers share them
        for ore in ores:
            W.index(ore)
    print(f"indexes built {time.time() - t0:.0f}s", flush=True)

    tasks = [(wi, ore, si) for ore in ores for si in range(len(STRATS)) for wi in WORLDS]
    results = {ore: {si: [] for si in range(len(STRATS))} for ore in ores}
    traces = {ore: [] for ore in ores}
    with mp.get_context("fork").Pool(min(22, mp.cpu_count() - 2)) as pool:
        for k, (wi, ore, si, res, trace) in enumerate(pool.imap_unordered(_task, tasks, chunksize=2)):
            results[ore][si].append(res)
            if trace is not None:
                traces[ore].append(trace)
            if k % 100 == 0:
                print(f"  {k}/{len(tasks)} tasks, {time.time() - t0:.0f}s", flush=True)

    base_i = next(i for i, (st, _) in enumerate(STRATS) if st == BASELINE)
    bodies_by_world = [b for _, b in loaded]
    per_ore = {}
    for ore in ores:
        base = pd.concat(results[ore][base_i])
        per_ore[ore] = {"reading_code": READING_CODE.get(ore, ore),
                        "region_shifted": READING_CODE.get(ore, ore) in REGION_SHIFTED,
                        "strategies": strategy_rows(results[ore]),
                        "calibration": calibration(base),
                        "curves": curves(pd.concat(traces[ore]), BASELINE.spacing),
                        "keep": keep_searching(base),
                        "neighbours": neighbours(bodies_by_world, ore)}

    s0, (bl0, bo0) = surveys[0], loaded[0]
    dep0 = bo0[(bo0.n >= B.MIN_DEPOSIT_BLOCKS) & bo0.ore.isin(ores)]
    bodies_all = pd.concat(bodies_by_world)
    data = {
        "surveys": [{"name": s.dir.name, "seed": s.meta["seed"], "rate": s.meta["worldConfig"]["globalDepositSpawnRate"]}
                    for s in surveys],
        "meta": s0.meta,
        "totals": {"blocks": int(sum(len(b) for b, _ in loaded)),
                   "deposits": int((bodies_all.n >= B.MIN_DEPOSIT_BLOCKS).sum()),
                   "shafts": int(sum(len(W.sx) for W in WORLDS.values())), "area": s0.size_x, "worlds": len(surveys)},
        "model": {"shaft_spacing": SHAFT_SPACING, "reach": 4, "min_deposit_blocks": B.MIN_DEPOSIT_BLOCKS,
                  "baseline": BASELINE.label, "arm": BASELINE.arm, "give_up": BASELINE.give_up,
                  "level_probes": list(BASELINE.level_probes), "depths": DEPTHS},
        "ores": ores, "words": WORD_ORDER,
        "ore_blocks": {o: int(v) for o, v in totals.items()},
        "map_seed": s0.meta["seed"],
        "maps": heatmaps(s0, [READING_CODE.get(o, o) for o in ores]),
        "bodies": {ore: [[int(r.cx - s0.x0), int(r.cz - s0.z0), int(r.n), int(r.depth), r.shape[0]]
                         for r in g.itertuples()] for ore, g in dep0.groupby("ore", observed=True)},
        "profiles": depth_profiles([b for b, _ in loaded], bodies_by_world),
        "shapes": shape_summary(bodies_all),
        "per_ore": per_ore,
    }
    out = ROOT / "report" / "data.json"
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1:] or ["s1_rate1"])
