"""Compare direction-finding methods on world 1 with a shape library from worlds 2 and 3."""
import sys
import time

import numpy as np
import pandas as pd

import bodies as B
from bayes import BayesRun, BayesStrategy, ShapeLib, build_library
from miner import Run, Strategy, World
from survey import Survey

ORES = sys.argv[1].split(",") if len(sys.argv) > 1 else ["nativecopper"]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 600

test = Survey("w4k_s1")
tb, tbo = B.load(test)
W = World(test, tb, tbo, shaft_spacing=32, offset=16)
train = [B.load(Survey(n)) for n in ("w4k_s2", "w4k_s3")]
rng = np.random.default_rng(7)

for ore in ORES:
    code = {"quartz_nativesilver": "silver"}.get(ore, ore)
    # shafts that at least have a reading of this ore, so hits happen
    r = W.readings[code] if code in W.readings else pd.Series(0, index=W.readings.index)
    shafts = rng.choice(np.nonzero(r.to_numpy() > 0.025)[0], size=N, replace=False)
    t = time.time()
    lib = ShapeLib(build_library([b for b, _ in train], [o for _, o in train], ore), 6)
    BayesRun.lib = lib
    print(f"\n{ore}: library {len(lib.dims)} shapes, {len(lib.h_sid)} hypotheses, built {time.time() - t:.1f}s")
    idx = W.index(ore)
    for name, st, cls in [("perfect aim", Strategy(6, 13, localise="oracle"), Run),
                          ("routine", Strategy(6, 13), Run),
                          ("smart aim", BayesStrategy(6, 13), BayesRun)]:
        t = time.time()
        rows = []
        for i in shafts:
            run = cls(idx, st, int(W.sx[i]), int(W.sz[i]), int(W.surface[i]), W.air[i]).run()
            rows.append((run.cost, run.yld, run.deps))
        a = np.array(rows)
        print(f"  {name:12s} ore/100 dur {100 * a[:, 1].sum() / a[:, 0].sum():5.1f}  yield {a[:, 1].mean():6.1f}  cost {a[:, 0].mean():6.1f}  deposits {a[:, 2].mean():.2f}  ({time.time() - t:.0f}s)")
