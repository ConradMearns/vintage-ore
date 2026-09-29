"""Compact per-world cache of the quartz / gold / silver blocks and gold/silver child clouds.

  uv run python gs_cache.py w4k_s1 w4k_s2 w4k_s3      -> data/surveys/<name>/gs.npz
"""
import sys

import numpy as np

from survey import Survey

ORES = ["quartz", "quartz_nativegold", "quartz_nativesilver", "galena_nativesilver"]
GRADES = ["poor", "medium", "rich", "bountiful"]


def build(name):
    s = Survey(name)
    b = s.q("""SELECT o.x, o.y, o.z, b.ore, b.grade FROM ore_blocks o JOIN blocks b ON b.id = o.block_id
               WHERE b.ore IN ('quartz', 'quartz_nativegold', 'quartz_nativesilver', 'galena_nativesilver')""")
    h = s.heightmap()
    out = {"surface": h}
    for i, ore in enumerate(ORES):
        sub = b[b.ore == ore]
        out[f"{ore}_xyz"] = sub[["x", "y", "z"]].to_numpy(np.int32)
        out[f"{ore}_grade"] = sub.grade.map({g: k for k, g in enumerate(GRADES)}).fillna(-1).to_numpy(np.int8)
    d = s.q("SELECT code, parent_code, x, y, z FROM deposits WHERE generator = 'ChildDepositGenerator' AND parent_code = 'quartz'")
    for code in ("gold", "silver"):
        out[f"{code}_clouds"] = d[d.code == code][["x", "y", "z"]].to_numpy(np.int32)
    q = s.q("SELECT x, y, z, radius_x, radius_z, thickness FROM deposits WHERE code = 'quartz'")
    out["quartz_discs"] = q.to_numpy(np.float32)
    r = s.q("SELECT x, z, ore, total_factor FROM readings WHERE ore IN ('gold', 'silver')")
    for code in ("gold", "silver"):
        rr = r[r.ore == code]
        out[f"{code}_read"] = np.column_stack([rr.x, rr.z, rr.total_factor]).astype(np.float32)
    np.savez(s.dir / "gs.npz", **out)
    print(name, {k: v.shape for k, v in out.items()})


if __name__ == "__main__":
    for n in sys.argv[1:]:
        build(n)
