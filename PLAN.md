# Vintage Story Ore Research — Plan

**Question:** Given the prospecting reading a player sees at a spot, which mining strategy should they use,
and how much ore should they expect per tool durability (block break)? After finding one deposit, is it
worth continuing to search nearby?

Target game version: **1.22.0** (install at `~/Games/vintagestory`, .NET 10 SDK available).
Decompiled reference source lives in `ref/decomp/` (git-ignored; regenerate with `ilspycmd`).

---

## 1. How the game actually works (from decompiled 1.22 source)

### Density mode (the "heatmap")
`ItemProspectingPick.ProbeBlockDensityMode` / `GenProbeResults` (VSSurvivalMod)
- Needs 3 samples, all within 20 blocks of each other and not too close together; costs **1 durability per sample**.
- The reading is **not** a scan of real blocks. For each ore, it reads the region's **ore map**
  (a seeded 2D noise layer, `mapRegion.OreMaps[code]`) at the XZ position, and multiplies by the fraction
  of the rock column at that XZ that is a valid host rock within the ore's Y range:
  `totalFactor = (oreMap & 0xFF)/255 * hostRockFraction`
- Displayed word = `["very poor","poor","decent","high","very high","ultra high"][clamp(totalFactor*7.5, 0, 5)]`;
  shown only if `totalFactor > 0.025`, "miniscule" if `> 0.002`. ppt is derived from the same factor.
- Consequence: the density reading is a **probability-of-spawn signal**, not a count of real ore. Our job is
  to measure how well it predicts what actually generated.

### Node search mode
`ProbeBlockNodeMode`, enabled when world config `propickNodeSearchRadius` > 0 (options 0/2/4/6/8;
"Survive and build" preset = 6, "Exploration" = 8). Costs **2 durability**.
- Counts every `ore-*` block in a **cube** of ±R around the broken block, grouped by ore type.
- Reported only as buckets: trace <10, small <20, medium <40, large <80, very large <160, huge ≥160.
- Tells you *which* ores and *roughly how many*, but not direction or distance.

### Deposit generation
`GenDeposits.GeneratePartial` + `DiscDepositGenerator.GenDeposit` (VSEssentials)
- Per chunk (32×32) and per deposit variant: `tries = TriesPerChunk * oreMapFactor * chanceMultiplier`
  (fractional part rolled). Each try picks a random XZ center in the chunk → one **deposit**.
- A deposit is a distorted elliptical **disc** (radius from `Radius` NatFloat, e.g. native copper 7±3,
  thickness from `Thickness`), whose Y follows surface / rock strata depending on generator type.
- A single grade (poor/medium/rich/bountiful) is rolled per deposit; ore only replaces allowed host rock.
- Child deposits (e.g. gems/minerals inside other ores) can spawn inside parent deposits.
- So the ground-truth unit of "a unique deposit" = one `(variant, center)` placement. We can capture these
  exactly by hooking `DiscDepositGenerator.GenDeposit` with Harmony.

### Gotchas found while building the pipeline
- `ProPickWorkSpace.GetRockColumn` (used by every density reading) runs a private copy of
  `GenDeposits.GeneratePartial` on `DummyChunk`s with an unseeded RNG. Hooks on `GenDeposit` must ignore
  those calls or you record ~30 phantom deposits per reading.
- `DepositVariant.GetOreMapFactor` returns 0 if the neighbour chunk's map region isn't loaded yet. That
  changes the number of RNG draws for that neighbour, so its deposit rolls shift. This is real game behaviour
  near region borders (every 512 blocks), and those shifted rolls do place real ore. We only record a deposit
  when its disc overlaps the chunk being generated.
- The propick fills its deposit table in a `RunGame` callback; readings taken before that come back empty.
- Deposits overlap a lot (native copper ≈ 12 non-empty discs per chunk in the pilot). A connected "ore body"
  (what a player follows) often merges several generator deposits (70% for native copper at 26-adjacency).
  We track both units: **generator deposit** (from the hook) and **ore body** (connected component).

---

## 2. Architecture

```
┌──────────────────────────────┐     ┌──────────────────────────┐     ┌─────────────────────────┐
│ OreSurvey server mod (C#)    │ --> │ survey dataset (SQLite + │ --> │ Python analysis +        │
│ - pregen area on headless    │     │  npz block grids)        │     │ strategy simulator       │
│   dedicated server           │     │                          │     │ -> interactive report    │
│ - Harmony hook: log deposits │     │                          │     │                         │
│ - dump ore blocks + solidity │     │                          │     │                         │
│ - dump propick readings grid │     │                          │     │                         │
└──────────────────────────────┘     └──────────────────────────┘     └─────────────────────────┘
```

### Phase A — Data extraction mod (`mod/OreSurvey`)
- Headless `VintagestoryServer` with a scripted world (fixed seed, chosen preset, world config).
- Command `/oresurvey run <x0> <z0> <x1> <z1>`: force-generate all chunk columns in the area, then per column:
  Everything goes into one compact `survey.sqlite` (no voxel dumps):
  - `deposits(code, generator, parent_code, x, y, z, radius_x, radius_z, thickness, calls)` from the Harmony hook
  - `ore_blocks(x, y, z, block_id)` + `blocks(id, code, ore, grade, rock)`
  - `columns(cx, cz, ms, heights BLOB)`: worldgen terrain height per chunk column (uint16[32×32])
  - `air_runs(x, z, y0, y1)`: cave air below the surface; everything else below the surface is solid, so
    mining cost (block breaks) is exact without storing the voxel grid
  - `readings(x, z, y, ore, total_factor, ppt)`: the game's own `GenProbeResults` on a grid (default every 4 blocks)
- Run over several seeds so conclusions aren't one-world flukes.

### Phase B — Ground truth & calibration (Python)
- Assign ore blocks to deposits (by hook data; cross-check with connected components).
- Calibrate: P(deposit within D blocks | reading word), expected ore blocks per reading word, per ore type.
- Node-search simulation for any R (not only 2/4/6/8) directly from ore block data.

### Phase C — Strategy simulator
Agents that move through the voxel grid, paying 1 durability per solid block broken, 1 per density sample,
2 per node search. Candidate strategies:
1. **Blind shaft + branch mine** at the reading location (baseline).
2. **Node-search grid**: dig down to target Y, node-search every k blocks in a lattice, tunnel toward hits.
3. **Gradient follow**: use node-search bucket changes to hill-climb toward a deposit.
4. **Deposit-then-stop** vs **deposit-then-continue** (the "after I find one, keep looking?" question):
   after exhausting a deposit, continue the search pattern for N more durability and measure marginal yield.
- Metrics: ore blocks (and nuggets/units) per durability, unique deposits found per durability,
  time-to-first-ore, variance.
- Output conditioned on the **initial reading** (ore type × density word × node-search radius setting).

### Phase D — Tool
Interactive page: choose ore, reading word, node radius, durability budget → recommended strategy,
expected yield distribution, and "keep searching after first deposit?" answer. Plus the world heatmap
overlaid with true deposit locations.

---

## 3. Decisions
- Sweep world configs. Only `globalDepositSpawnRate` (and surface copper/tin) changes worldgen; node search
  radius is simulated after the fact from ore blocks, for any radius.
- 2048×2048 per world, 3 seeds per config. All ores. Yield = ore blocks.

## 4. Status
- [x] Pilot (seed 12345, 256×256): 5 s server time, 16 MB sqlite, 99.99% of ore blocks attributed to a
      recorded deposit. Chunk-level correlation between density reading and ore blocks: copper 0.69, tin 0.56.
- [ ] Choose the "unique deposit" definition for the headline metric (ore body vs generator deposit)
- [ ] Sweep: seeds × globalDepositSpawnRate at 2048²
- [ ] Calibration analysis, then the strategy simulator

## Usage
```
dotnet build -c Release mod/OreSurvey
scripts/run_survey.py --name pilot --seed 12345 --size 256 [--set globalDepositSpawnRate=1.6]
uv run python -c "import sys; sys.path.insert(0,'analysis'); from survey import Survey; ..."
```
