# vintage-ore

Research into prospecting in [Vintage Story](https://www.vintagestory.at/) 1.22: given what the prospecting pick
tells you, how should you dig, and how much ore should you expect per point of tool durability?

The approach: generate worlds on a headless server, record every ore block and every density reading the game
would give, then simulate thousands of shafts under different strategies and score them in ore per durability.

## The result, for native copper (node search radius 6)

1. **Read every ~100 blocks** while exploring, until the density reading says "decent".
2. **Climb**: four compass readings 64 blocks out, step to the best, repeat.
3. **Dig a shaft, node search every 13 blocks** (the radius-6 cubes just touch), counting ladders.
4. **Edge search** at a hit: halve the gap up the shaft. The top of the ore is the highest probe that still counts ore, plus 6.
5. **Tunnel** 3 blocks at a time toward the rising count; stop at visible ore; give up after 120 durability.
6. **Mine the whole body**, probe again, and carry on down to the stop depth.
7. **Next shaft** the recommended distance away.

| Ore | Stop at (ladders) | Shafts apart |
|---|---|---|
| Copper | 112 | 32 |
| Tin (cassiterite) | 80 | 24 |
| Bismuthinite | 80 | 20 |
| Iron (hematite) | 80 | 80 |

This plan mines about **26.5 ore blocks per 100 durability** for copper, against 25.3 for probing every 6 blocks.
Stopping at the first deposit drops that to 18.6. Based on three simulated 4096×4096 worlds, 59 million ore blocks,
and 49,152 simulated shafts per strategy.

**Known limitation:** the game reports node-search counts as words (trace, small, medium…), but the tunnel-steering
simulation used exact counts, so its direction-finding results are somewhat optimistic. Edge search is unaffected.
See the open items in [PLAN.md](PLAN.md).

## Gold and silver

Gold and silver are nuggets inside thin quartz slabs, and the pick can only say "trace". Best starts: a loose nugget on the
ground, then a loose quartz stone where a reading says "Miniscule amounts of" gold or silver. Yields are 2 to 9 ore blocks
per 100 durability (copper: 26). Needs a tier-3 pickaxe. See [report/goldsilver.html](report/goldsilver.html)
(self-contained; rebuild data with `analysis/gs_cache.py`, `analysis/goldsilver.py`, then `goldsilver.py --embed`).

## Where things are

### The analysis

| | |
|---|---|
| [PLAN.md](PLAN.md) | How the game's prospecting works (from its own code), the architecture, decisions, findings and status |
| [mod/OreSurvey/](mod/OreSurvey/) | A server mod that pre-generates an area and records deposits, ore blocks, cave gaps and density readings into SQLite |
| [scripts/run_survey.py](scripts/run_survey.py) | Creates a fresh headless world and runs the mod over it |
| [analysis/](analysis/) | Loading surveys, connected ore bodies, the mining simulator, the aiming studies, shaft spacing and surface prospecting |
| [report/index.html](report/index.html) | The interactive report page. It reads `data.json` (from `analysis/report_data.py`) and optionally `spacing.json`, `surface.json` and `aim.json` (from `spacing.py`, `surface.py` and `aim_eval.py`, which write to `data/`; copy them next to the page). These files are gitignored, and the page needs to be served over HTTP, e.g. `python3 -m http.server --directory report` |

In `analysis/`: `survey.py` (load a survey), `bodies.py` (connected ore bodies), `miner.py` (the shaft simulator),
`bayes.py` and `bayes_eval.py` (a probabilistic direction-finding study), `aim_eval.py` (aiming methods compared),
`spacing.py` (how far apart to dig shafts), `surface.py` (finding a good spot), `report_data.py` (the report's data).

### The animations

Three p5.js animations of the guide above. Open each folder's `index.html` in a browser; each has its own README.

| | |
|---|---|
| [anim-sonnet-fixed/](anim-sonnet-fixed/) | **The merged edition**: everything computed from the game's rules, plus a labelled edge-search rule, a whole patch filled with shafts, and a recipe card of what loses ore |
| [anim-sonnet/](anim-sonnet/) | One full illustrative run with real 3D node-search counts, a live durability ledger, and full playback controls |
| [anim-opus/](anim-opus/) | A more compact, game-styled field guide that loops; approximates counts in 2D |

## Reproducing it

You need your own copy of Vintage Story 1.22 (this repository contains no game files), the .NET 10 SDK, and
[uv](https://docs.astral.sh/uv/). The build and the survey script look for the game in `~/Games/vintagestory`; set
`VINTAGE_STORY` (script) or `-p:VintageStoryPath=...` (build) to point elsewhere.

```
dotnet build -c Release mod/OreSurvey
python3 scripts/run_survey.py --name w4k_s1 --seed 1 --size 4096      # repeat for seeds 2 and 3
cd analysis
uv run python bodies.py w4k_s1                                          # connected ore bodies, cached
uv run python report_data.py w4k_s1 w4k_s2 w4k_s3                       # writes ../report/data.json
```

A 4096×4096 world takes roughly half an hour and produces a few hundred megabytes of SQLite; surveys land in `data/`,
which is gitignored. The decompiled game source that PLAN.md refers to (`ref/decomp/`) is also gitignored; regenerate
it locally with `ilspycmd` if you want to follow along.

## Notes

- Vintage Story is a trademark of Anego Studios. This project is not affiliated with or endorsed by them.
- No license has been chosen yet.
- The animations and much of the analysis were written with Claude Code.
