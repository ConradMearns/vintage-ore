"""Build report/data.json for one survey: maps, depth profiles, body shapes, calibration, strategies, keep-searching."""
import base64
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import bodies as B
from sim import READING_CODE, ShaftField, Strategy, WORDS, reading_word
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
MAP_STEP = 8          # heatmap cell size in blocks (readings are taken every 4)
# The game's six words, with "very high" and "ultra high" merged (both rare; keeps buckets well sampled).
WORD_ORDER = ["none", "very poor", "poor", "decent", "high", "very high+"]


def report_word(factor):
    w = reading_word(factor)
    return np.where(np.isin(w, ["very high", "ultra high"]), "very high+", w)

STRATEGIES = [
    Strategy(2, 2), Strategy(2, 5),
    Strategy(4, 4), Strategy(4, 6), Strategy(4, 9),
    Strategy(6, 6), Strategy(6, 9), Strategy(6, 13),
    Strategy(6, 6, min_count=10), Strategy(6, 13, min_count=10),
    Strategy(6, 6, stop_after_first=True), Strategy(6, 13, stop_after_first=True),
    Strategy(8, 6), Strategy(8, 8), Strategy(8, 12), Strategy(8, 17),
]
BASELINE = Strategy(6, 6)   # the player's current method: node search every 6 blocks, radius 6
MIN_ORE_BLOCKS = 500


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.astype(np.uint8).tobytes()).decode()


def heatmaps(s: Survey, codes):
    r = s.q(f"""SELECT x, z, ore, total_factor FROM readings
                WHERE (x - {s.x0}) % {MAP_STEP} = 0 AND (z - {s.z0}) % {MAP_STEP} = 0""")
    n = s.size_x // MAP_STEP
    out = {}
    for code in codes:
        sub = r[r.ore == code]
        g = np.zeros((n, n), dtype=np.uint8)
        g[(sub.z - s.z0) // MAP_STEP, (sub.x - s.x0) // MAP_STEP] = np.clip(sub.total_factor * 255 / 0.8, 0, 255)
        out[code] = b64(g)
    return {"n": n, "step": MAP_STEP, "scale": 0.8, "grids": out}


def depth_profiles(blocks, bodies):
    shape = bodies["shape"].reindex(blocks.body).to_numpy()
    d = (blocks.surface - blocks.y).clip(lower=0).to_numpy()
    out = {}
    for ore, idx in blocks.groupby("ore").indices.items():
        bins = np.arange(0, 181, 4)
        prof = {}
        for sh in ("pancake", "clump", "speck"):
            m = shape[idx] == sh
            prof[sh] = np.histogram(d[idx][m], bins)[0].tolist()
        yb = np.arange(0, 257, 4)
        out[ore] = {"bin": 4, "depth": prof, "y": np.histogram(blocks.y.to_numpy()[idx], yb)[0].tolist()}
    return out


def shape_summary(bodies):
    rows = {}
    for ore, g in bodies.groupby("ore"):
        rows[ore] = {
            sh: {"bodies": int((g["shape"] == sh).sum()), "blocks": int(g.n[g["shape"] == sh].sum()),
                 "med_n": float(g.n[g["shape"] == sh].median()) if (g["shape"] == sh).any() else None}
            for sh in ("pancake", "clump", "speck")
        }
        dep = g[g.n >= B.MIN_DEPOSIT_BLOCKS]
        rows[ore]["dims"] = {"med_thick": float(dep.yspan.median()) if len(dep) else None,
                             "med_span": float(dep.hspan.median()) if len(dep) else None,
                             "med_depth": float(dep.depth.median()) if len(dep) else None,
                             "p10_depth": float(dep.depth.quantile(.1)) if len(dep) else None,
                             "p90_depth": float(dep.depth.quantile(.9)) if len(dep) else None}
    return rows


def body_points(bodies, s):
    out = {}
    for ore, g in bodies[bodies.n >= B.MIN_DEPOSIT_BLOCKS].groupby("ore"):
        out[ore] = [[round(r.cx - s.x0, 1), round(r.cz - s.z0, 1), int(r.n), int(r.depth), r.shape[0]]
                    for r in g.itertuples()]
    return out


def mean_curve(trace: pd.DataFrame, res: pd.DataFrame, spacing: int):
    """Mean cumulative cost & yield vs depth, per reading word (shafts that ended carry their final value)."""
    depths = np.arange(spacing, 181, spacing)
    piv_c = trace.pivot_table(index="shaft", columns="depth", values="cost").reindex(columns=depths).ffill(axis=1)
    piv_y = trace.pivot_table(index="shaft", columns="depth", values="yield").reindex(columns=depths).ffill(axis=1)
    piv_d = trace.pivot_table(index="shaft", columns="depth", values="deposits").reindex(columns=depths).ffill(axis=1)
    word = res.set_index("shaft").word
    out = {}
    for w in WORD_ORDER:
        ids = word.index[word == w]
        ids = ids[ids.isin(piv_c.index)]
        if len(ids) < 20:
            continue
        out[w] = {"n": int(len(ids)), "depth": depths.tolist(),
                  "cost": piv_c.loc[ids].mean().round(1).tolist(),
                  "yield": piv_y.loc[ids].mean().round(1).tolist(),
                  "deposits": piv_d.loc[ids].mean().round(3).tolist()}
    return out


def calibration(res: pd.DataFrame):
    out = {}
    for w in WORD_ORDER:
        g = res[res.word == w]
        if len(g) < 20:
            continue
        out[w] = {"n": int(len(g)), "p_any": float((g.deposits > 0).mean()),
                  "deposits": float(g.deposits.mean()), "yield": float(g["yield"].mean()),
                  "yield_q": [float(q) for q in g["yield"].quantile([.1, .25, .5, .75, .9])],
                  "cost": float(g.cost.mean()), "rate": float(g["yield"].sum() / g.cost.sum())}
    return out


def keep_searching(res_full: pd.DataFrame):
    """After the first deposit in a shaft: marginal rate of continuing down vs the average rate of a fresh shaft."""
    out = {}
    for w in WORD_ORDER:
        g = res_full[res_full.word == w]
        hit = g[g.first_cost.notna()]
        if len(hit) < 20:
            continue
        rest_cost = (hit.cost - hit.first_cost).sum()
        out[w] = {"n": int(len(hit)),
                  "first_rate": float(hit.first_yield.sum() / hit.first_cost.sum()),
                  "continue_rate": float((hit["yield"] - hit.first_yield).sum() / rest_cost) if rest_cost > 0 else None,
                  "continue_deposits_per_1k": float((hit.deposits - 1).sum() / rest_cost * 1000) if rest_cost > 0 else None,
                  "fresh_rate": float(g["yield"].sum() / g.cost.sum())}
    return out


def neighbours(bodies, ore):
    """P(another deposit of the same ore within D blocks horizontally): from a deposit vs from a random spot."""
    dep = bodies[(bodies.ore == ore) & (bodies.n >= B.MIN_DEPOSIT_BLOCKS)]
    if len(dep) < 30:
        return None
    pts = dep[["cx", "cz"]].to_numpy()
    tree = cKDTree(pts)
    d_dep = tree.query(pts, k=2)[0][:, 1]
    lo, hi = pts.min(0), pts.max(0)
    rnd = np.random.default_rng(0).uniform(lo, hi, size=(20000, 2))
    d_rnd = tree.query(rnd, k=1)[0]
    D = np.arange(0, 97, 4)
    return {"D": D.tolist(),
            "from_deposit": [float((d_dep <= x).mean()) for x in D],
            "from_random": [float((d_rnd <= x).mean()) for x in D],
            "median_from_deposit": float(np.median(d_dep)), "median_from_random": float(np.median(d_rnd))}


def main(name):
    t0 = time.time()
    s = Survey(name)
    blocks, bodies = B.load(s)
    field = ShaftField(s, blocks, bodies)
    totals = blocks.ore.value_counts()
    reading_codes = set(s.q("SELECT DISTINCT ore FROM readings").ore)
    ores = [o for o in totals.index if totals[o] >= MIN_ORE_BLOCKS and READING_CODE.get(o, o) in reading_codes]
    print("ores:", ores, flush=True)

    per_ore = {}
    for ore in ores:
        strat_rows, cal, curves, keep = [], None, None, None
        for st in STRATEGIES:
            res, trace = field.simulate(ore, st)
            res["word"] = report_word(res.reading)
            by_word = {w: {"rate": float(g["yield"].sum() / g.cost.sum()),
                           "dep_per_1k": float(g.deposits.sum() / g.cost.sum() * 1000),
                           "cost": float(g.cost.mean()), "yield": float(g["yield"].mean()),
                           "deposits": float(g.deposits.mean())}
                       for w, g in res.groupby("word") if len(g) >= 20}
            strat_rows.append({"label": st.label, "radius": st.radius, "spacing": st.spacing,
                               "min_count": st.min_count, "stop_after_first": st.stop_after_first,
                               "baseline": st == BASELINE,
                               "rate": float(res["yield"].sum() / res.cost.sum()),
                               "dep_per_1k": float(res.deposits.sum() / res.cost.sum() * 1000),
                               "cost": float(res.cost.mean()), "by_word": by_word})
            if st == BASELINE:
                cal = calibration(res)
                curves = mean_curve(trace, res, st.spacing)
                keep = keep_searching(res)
        per_ore[ore] = {"reading_code": READING_CODE.get(ore, ore), "strategies": strat_rows,
                        "calibration": cal, "curves": curves, "keep": keep, "neighbours": neighbours(bodies, ore)}
        print(f"  {ore}: {time.time() - t0:.0f}s", flush=True)

    dep = bodies[bodies.n >= B.MIN_DEPOSIT_BLOCKS]
    data = {
        "survey": name, "meta": s.meta,
        "totals": {"blocks": int(len(blocks)), "bodies": int(len(bodies)), "deposits": int(len(dep)),
                   "shafts": int(len(field.sx)), "area": s.size_x},
        "model": {"shaft_spacing": 16, "localise_cost": 4, "reach": 4, "min_deposit_blocks": B.MIN_DEPOSIT_BLOCKS,
                  "baseline": BASELINE.label},
        "ores": ores, "words": WORD_ORDER,
        "ore_blocks": {o: int(v) for o, v in totals.items()},
        "maps": heatmaps(s, [READING_CODE.get(o, o) for o in ores]),
        "bodies": body_points(bodies[bodies.ore.isin(ores)], s),
        "profiles": depth_profiles(blocks, bodies),
        "shapes": shape_summary(bodies),
        "per_ore": per_ore,
    }
    out = ROOT / "report" / f"data_{name}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "s1_rate1")
