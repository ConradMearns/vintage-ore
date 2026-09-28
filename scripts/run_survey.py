#!/usr/bin/env python3
"""Create a fresh headless Vintage Story world and run the OreSurvey mod over it.

Example:
  scripts/run_survey.py --name pilot --seed 12345 --size 256
  scripts/run_survey.py --name s1_rate1.6 --seed 1 --size 2048 --set globalDepositSpawnRate=1.6
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = Path(os.environ.get("VINTAGE_STORY", Path.home() / "Games/vintagestory"))
MOD_BIN = ROOT / "mod/OreSurvey/bin/Release/Mods"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--size", type=int, default=2048)
    ap.add_argument("--spacing", type=int, default=4, help="propick reading grid spacing")
    ap.add_argument("--playstyle", default="surviveandbuild")
    ap.add_argument("--set", action="append", default=[], help="world config override key=value")
    ap.add_argument("--keep-world", action="store_true", help="keep the .vcdbs save afterwards")
    args = ap.parse_args()

    server_dir = ROOT / "data/servers" / args.name
    out_dir = ROOT / "data/surveys" / args.name
    if server_dir.exists():
        shutil.rmtree(server_dir)
    (server_dir / "ModConfig").mkdir(parents=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    world_cfg = {"propickNodeSearchRadius": "6"}
    for kv in args.set:
        k, v = kv.split("=", 1)
        world_cfg[k] = v

    subprocess.run([str(GAME / "VintagestoryServer"), "--dataPath", str(server_dir), "--genconfig"],
                   cwd=GAME, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cfg_path = server_dir / "serverconfig.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["Port"] = 42420 + (abs(hash(args.name)) % 1000)
    cfg["AdvertiseServer"] = False
    cfg["Upnp"] = False
    cfg["WorldConfig"].update({
        "Seed": str(args.seed),
        "WorldName": args.name,
        "SaveFileLocation": str(server_dir / "Saves/world.vcdbs"),
        "PlayStyle": args.playstyle,
        "WorldConfiguration": world_cfg,
    })
    cfg_path.write_text(json.dumps(cfg, indent=2))

    (server_dir / "ModConfig/oresurvey.json").write_text(json.dumps({
        "AutoRun": True,
        "ShutdownWhenDone": True,
        "Size": args.size,
        "ReadingSpacing": args.spacing,
        "OutDir": str(out_dir),
    }, indent=2))

    (out_dir / "DONE").unlink(missing_ok=True)
    print(f"[run_survey] {args.name}: seed={args.seed} size={args.size} cfg={world_cfg}", flush=True)
    proc = subprocess.run([str(GAME / "VintagestoryServer"), "--dataPath", str(server_dir),
                           "--addModPath", str(MOD_BIN)], cwd=GAME, stdin=subprocess.DEVNULL)
    ok = (out_dir / "DONE").exists()
    print(f"[run_survey] server exited {proc.returncode}; survey {'complete' if ok else 'INCOMPLETE'} -> {out_dir}")
    if ok and not args.keep_world:
        shutil.rmtree(server_dir / "Saves", ignore_errors=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
