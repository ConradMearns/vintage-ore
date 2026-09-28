"""Aiming methods compared on world 1 (shape library for smart aim from worlds 2-3) -> data/aim.json."""
import json
import sys
from pathlib import Path

import numpy as np

import bodies as B
from bayes import BayesRun, BayesStrategy, ShapeLib, build_library
from miner import Run, Strategy, World
from survey import Survey

ROOT = Path(__file__).resolve().parent.parent
ORES = ["nativecopper", "cassiterite", "bismuthinite", "hematite"]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 800

test = Survey("w4k_s1")
tb, tbo = B.load(test)
W = World(test, tb, tbo, shaft_spacing=32, offset=16)
train = [B.load(Survey(n)) for n in ("w4k_s2", "w4k_s3")]
rng = np.random.default_rng(11)
METHODS = [("Weighted-average level", Strategy(6, 13, level_pick="centroid"), Run),
           ("Edge search", Strategy(6, 13, level_pick="edge"), Run),
           ("Model-picked direction", BayesStrategy(6, 13, level_pick="edge", sideways="directed"), BayesRun),
           ("Perfect aim", Strategy(6, 13, localise="oracle"), Run)]
out = {"shafts": N, "methods": [m[0] for m in METHODS], "ores": {}}
for ore in ORES:
    shafts = rng.choice(np.nonzero(W.readings[ore].to_numpy() > 0.025)[0], size=N, replace=False)
    BayesRun.lib = ShapeLib(build_library([b for b, _ in train], [o for _, o in train], ore), 6)
    idx = W.index(ore)
    res = {}
    for name, st, cls in METHODS:
        a = np.array([(r.cost, r.yld) for r in (cls(idx, st, int(W.sx[i]), int(W.sz[i]), int(W.surface[i]), W.air[i]).run() for i in shafts)])
        res[name] = round(100 * a[:, 1].sum() / a[:, 0].sum(), 2)
    out["ores"][ore] = res
    print(ore, res, flush=True)
(ROOT / "data/aim.json").write_text(json.dumps(out))
