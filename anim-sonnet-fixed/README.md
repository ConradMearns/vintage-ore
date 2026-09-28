# Copper prospecting guide: merged animation

A three-minute p5.js animation of the prospecting plan the simulations settled on for native copper at
node-search radius 6. It follows one illustrative run, from the first density reading to a whole patch of shafts.

This is the merged edition. It starts from [`anim-sonnet`](../anim-sonnet) and adds the best parts of
[`anim-opus`](../anim-opus). See [What was merged](#what-was-merged).

## Run it

Open `index.html` in a browser. Everything it needs is in this folder (p5.js is vendored in `lib/`); the only
network request is the optional Google Fonts stylesheet, and it falls back to system fonts without it.

If your browser blocks local scripts from `file://`, serve the folder instead:

```
python3 -m http.server 8000 --directory anim-sonnet-fixed
```

## Controls

| Input | Action |
|---|---|
| Space, or the `>` / `II` button | play / pause |
| Left / right arrow | previous scene (or restart this one) / next scene |
| `0`-`9` | jump to a scene (`0` overview, `1`-`8` the steps, `9` the patch); `End` jumps to the recipe |
| `L`, or the `L` button | loop |
| `R` | restart |
| `+` / `-`, or the `1x` button | speed |
| Scene chips, or the scrubber | jump anywhere |

URL parameters for stills and checks: `?paused=1&scene=4&at=6` freezes scene 4 at 6 s; `?t=90` jumps to 90 s
overall; `?loop=1` starts looping; `?sweep=1` renders every scene every 0.1 s and reports any problem in the page
title (a self-check).

## The scenes

1. **Overview**: the eight steps.
2. **Read every ~100 blocks** until the density reading says "decent".
3. **Climb**: four compass readings 64 blocks out, step to the best, repeat until none is better.
4. **Dig and probe every 13 blocks** (node search, radius 6), counting ladders.
5. **Edge search**: after a hit, halve the gap up the shaft. The top of the ore is the highest probe with ore plus 6, drawn as a measured 6-block span.
6. **Tunnel to the count**: 3-block test arms east and south, follow the axis that changed most, stop at visible ore, give up at 120 durability.
7. **Mine the whole body**, then probe again.
8. **Dig on to 112 ladders**, repeating the routine at each hit.
9. **Next shaft 32 blocks away**, and why.
10. **Fill the patch**: the same 32-block lattice across the whole "decent" outline, middle first.
11. **The recipe**: all eight steps, the per-ore table, and what loses ore.

## What was merged

From `anim-sonnet` (kept as the core):

- every count is computed from real 3D deposits with the exact radius-6 cube, and shown as the game's words (trace, small, large…) rather than numbers
- one full run with a live durability and ore ledger, checked by a self-test
- scrubber, scene chips, speed control, offline p5.js, a README that states its caveats

From `anim-opus`:

- the edge-search rule drawn as a labelled 6-block measurement, in both edge searches
- a whole patch filled with shafts (170 fit in this one)
- a closing recipe card that says what *loses* ore: stopping at the first deposit (18.6 vs 26.5), side tunnels after a hit (24.1–25.8), probing every 6 (25.3), and shafts 13 blocks apart (about half the ore)
- looping and number-key navigation

Not carried over from `anim-opus`: its 2D cross-section with ×4 counts, its south-arm count (which was a fixed offset, not
computed), and its text numbers that had gone stale (for example iron spacing of 64; the current data says 80).

## What is computed and what is placed

`world.js` has no p5 in it and can be run under node (`node -e "console.log(require('./world.js').RUN)"`).

Computed, from the game's rules: the density field and its words (`floor(f * 7.5)`), the walk and the compass
climb, every node-search count, the edge-search halving, the tunnel chase and where ore first shows in a tunnel wall,
the patch lattice, and the durability and ore totals in the header (1 per block dug, 2 per probe, 3 per density
reading, 1 per ore block mined).

Placed by hand: where the two ore bodies and the bystander deposits sit. Their shapes are pancakes like the ones
measured in the survey (3 layers thick in the middle, thinning to the edge), not real world data.

Quoted from the analysis, not recomputed: the per-ore table, 26.5 ore per 100 durability (vs 25.3 probing every 6),
the alternatives in the recipe card, and the shaft-spacing shares (61 / 79 / 90 / 98 % at 16 / 20 / 24 / 32 blocks).

## Caveats

- **The game reports node-search counts as words** (trace under 10, small under 20, medium under 40, large under
  80, very large under 160, huge), and the animation shows them that way. The simulations behind the guide followed
  exact counts when steering a tunnel, so real direction-finding is a bit coarser than the simulated one. Edge
  search only needs "any ore or none", so it is unaffected.
- This run hit two deposits, so its 54 ore per 100 durability underground is well above the measured average (26.5).
- This patch fits 170 shafts; a typical "decent" copper patch holds about 100.
- Numbers are for radius 6. Radius 8 changes some of them.

## Files

- `index.html`: page shell
- `sketch.js`: scenes, drawing, controls
- `world.js`: the rules and the illustrative run (no drawing)
- `lib/p5.min.js`: p5.js 1.9.4 (LGPL-2.1), vendored so the animation works offline
