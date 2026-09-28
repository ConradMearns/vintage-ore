# Copper prospecting guide: p5.js animation

A two-and-a-half-minute animation of the prospecting plan the simulations settled on for native copper at
node-search radius 6. It follows one illustrative run from the first density reading to the second shaft.

## Run it

Open `index.html` in a browser. Everything it needs is in this folder (p5.js is vendored in `lib/`); the only
network request is the optional Google Fonts stylesheet, and it falls back to system fonts without it.

If your browser blocks local scripts from `file://`, serve the folder instead:

```
python3 -m http.server 8000 --directory anim-sonnet
```

## Controls

| Input | Action |
|---|---|
| Space, or the `>` / `II` button | play / pause |
| Left / right arrow | previous scene (or restart this one) / next scene |
| `R` | restart |
| `+` / `-`, or the `1x` button | speed |
| Scene chips, or the scrubber | jump anywhere |

URL parameters for stills: `?paused=1&scene=4&at=6` freezes scene 4 at 6 s; `?t=90` jumps to 90 s overall;
`?sweep=1` renders every scene every 0.1 s and reports problems in the page title (a self-check).

## The eight steps it shows

1. **Read every ~100 blocks** until the density reading says "decent".
2. **Climb**: four compass readings 64 blocks out, step to the best, repeat until none is better.
3. **Dig and probe every 13 blocks** (node search, radius 6), counting ladders.
4. **Edge search**: after a hit, halve the gap up the shaft; the top of the ore is the highest probe with ore plus 6.
5. **Tunnel to the count**: 3-block test arms east and south, follow the axis that changed most, stop at visible ore, give up at 120 durability.
6. **Mine the whole body**, then probe again.
7. **Dig on to 112 ladders**, repeating the routine at each hit.
8. **Next shaft 32 blocks away.**

## What is computed and what is placed

`world.js` has no p5 in it and can be run under node (`node -e "console.log(require('./world.js').RUN)"`).

Computed, from the game's rules: the density field and its words (`floor(f * 7.5)`), the walk and the compass
climb, every node-search count (the exact radius-6 cube), the edge-search halving, the tunnel chase and where ore
first shows in a tunnel wall, and the durability and ore totals in the header (1 per block dug, 2 per probe,
3 per density reading, 1 per ore block mined).

Placed by hand: where the two ore bodies (and the bystander deposits) sit. Their shapes are pancakes like the
ones measured in the survey (3 layers thick in the middle, thinning to the edge), not real world data.

Quoted from the report, not recomputed: the per-ore table, 26.5 ore per 100 durability (vs 25.3 probing every 6),
and the shaft-spacing shares (61 / 79 / 90 / 98 % at 16 / 20 / 24 / 32 blocks).

## Caveats

- **The game reports node-search counts as words** (trace under 10, small under 20, medium under 40, large under
  80, very large under 160, huge), and the animation shows them that way. The simulations behind the guide followed
  exact counts when steering a tunnel, so real direction-finding is a bit coarser than the simulated one. Edge
  search only needs "any ore or none", so it is unaffected.
- This run hit two deposits, so its 54 ore per 100 durability underground is well above the measured average (26.5).
- Numbers are for radius 6. Radius 8 changes some of them.

## Files

- `index.html`: page shell
- `sketch.js`: scenes, drawing, controls
- `world.js`: the rules and the illustrative run (no drawing)
- `lib/p5.min.js`: p5.js 1.9.4 (LGPL-2.1), vendored so the animation works offline
