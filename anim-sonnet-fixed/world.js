/* Pure logic for the prospecting animation. No p5 in here, so it can be tested under node.
 *
 * Everything the animation shows is computed, not scripted: the density field, the walk, the compass climb,
 * the ore bodies, the node-search counts, the edge search and the tunnel chase all come from the same rules
 * the simulations used (radius-6 cube, probe every 13, edge search, 3-block tunnel segments).
 */
const World = (function () {
  'use strict';

  const P = {
    R: 6,               // node search radius (world setting "propickNodeSearchRadius")
    probeStep: 13,      // one node search every 13 blocks down: the cubes just touch
    stopDepth: 112,     // rope ladders for copper
    shaftSpacing: 32,   // blocks between shafts for copper
    readEvery: 100,     // surface density readings while exploring
    climbStep: 64,      // compass readings this far out while climbing
    arm: 3,             // tunnel segment length
    giveUp: 120,        // durability without a find before giving up on a hit
    readingCost: 3,     // a density reading is three samples
    probeCost: 2,       // a node search costs two durability
  };

  /* ---------- small deterministic helpers ---------- */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function valueNoise(seed) {
    const r = rng(seed), N = 64, g = new Float32Array(N * N);
    for (let i = 0; i < g.length; i++) g[i] = r();
    const s = t => t * t * (3 - 2 * t);
    const at = (i, j) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = s(x - xi), yf = s(y - yi);
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      const top = a + (b - a) * xf, bot = c + (d - c) * xf;
      return top + (bot - top) * yf;
    };
  }

  /* ---------- the surface: a density field like the propick's ore map ---------- */
  const MAP = { w: 1600, h: 980 };
  const noise = valueNoise(7);
  const PATCHES = [
    { x: 1180, y: 330, s: 170, a: 0.60 },
    { x: 400, y: 230, s: 135, a: 0.44 },
    { x: 760, y: 780, s: 125, a: 0.40 },
  ];
  function density(x, y) {
    let f = 0;
    for (const p of PATCHES) {
      const dx = x - p.x, dy = y - p.y;
      f += p.a * Math.exp(-(dx * dx + dy * dy) / (2 * p.s * p.s));
    }
    f *= 0.72 + 0.56 * noise(x / 160, y / 160);
    f += 0.035 * noise(x / 60 + 9, y / 60 + 3);
    return Math.max(0, Math.min(0.8, f));
  }

  // Game rule: word = index of floor(f * 7.5); nothing is said at or below 0.025.
  const WORDS = ['none', 'very poor', 'poor', 'decent', 'high', 'very high', 'ultra high'];
  function wordIndex(f) { return f <= 0.025 ? 0 : 1 + Math.min(5, Math.floor(f * 7.5)); }
  const DECENT = 3;

  // Node search results come back as words, not numbers (ItemProspectingPick.resultTextByQuantity).
  const BUCKETS = ['Trace', 'Small', 'Medium', 'Large', 'Very large', 'Huge'];
  function bucket(n) {
    if (n <= 0) return { idx: -1, label: 'No ore nearby', n };
    const cuts = [10, 20, 40, 80, 160];
    let i = 0;
    while (i < cuts.length && n >= cuts[i]) i++;
    return { idx: i, label: BUCKETS[i], n };
  }

  /* ---------- step 1: walk in a straight line, reading every 100 blocks ---------- */
  function explore(start, aimAt, turn) {
    const ang = Math.atan2(aimAt.y - start.y, aimAt.x - start.x) + (turn || 0);
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };
    const readings = [];
    for (let k = 0; k < 60; k++) {
      const x = start.x + dir.x * P.readEvery * k, y = start.y + dir.y * P.readEvery * k;
      const f = density(x, y);
      readings.push({ k, x, y, f, w: wordIndex(f) });
      if (readings[k].w >= DECENT) break;
    }
    return { start, dir, readings };
  }

  /* ---------- step 2: compass readings 64 blocks out, step to the best, repeat ---------- */
  function climb(from) {
    const steps = [];
    let pos = { x: from.x, y: from.y }, v = density(pos.x, pos.y);
    const dirs = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]];
    for (let it = 0; it < 10; it++) {
      const nb = dirs.map(([name, dx, dy]) => {
        const x = Math.max(0, Math.min(MAP.w, pos.x + dx * P.climbStep));
        const y = Math.max(0, Math.min(MAP.h, pos.y + dy * P.climbStep));
        const f = density(x, y);
        return { name, x, y, f, w: wordIndex(f) };
      });
      let best = nb[0];
      for (const n of nb) if (n.f > best.f) best = n;
      const moved = best.f > v;
      steps.push({ from: { x: pos.x, y: pos.y, f: v, w: wordIndex(v) }, nb, best, moved });
      if (!moved) break;
      pos = { x: best.x, y: best.y }; v = best.f;
    }
    return { steps, end: { x: pos.x, y: pos.y, f: v, w: wordIndex(v) }, readings: steps.length * 4 };
  }

  /* ---------- ore bodies ---------- */
  // A pancake: elliptical footprint, 3 layers thick in the middle, thinning to 1 at the edge.
  function makeBody(id, seed, cx, cz, rx, rz, top) {
    const nz = valueNoise(seed);
    const cells = [];
    for (let x = Math.floor(cx - rx - 2); x <= Math.ceil(cx + rx + 2); x++) {
      for (let z = Math.floor(cz - rz - 2); z <= Math.ceil(cz + rz + 2); z++) {
        const q = Math.hypot((x - cx) / rx, (z - cz) / rz) + 0.22 * (nz(x / 2.2, z / 2.2) - 0.5);
        if (q >= 1) continue;
        const layers = q < 0.55 ? [0, 1, 2] : q < 0.85 ? [0, 1] : [1];
        for (const l of layers) cells.push({ x, z, d: top + l, body: id });
      }
    }
    return { id, cx, cz, rx, rz, top, cells };
  }

  // The exact game rule: every ore block inside the cube of radius R around the probe.
  function count(cells, x, z, d, mined) {
    let n = 0;
    for (const c of cells) {
      if (mined && mined.has(c.body)) continue;
      if (Math.abs(c.x - x) <= P.R && Math.abs(c.z - z) <= P.R && Math.abs(c.d - d) <= P.R) n++;
    }
    return n;
  }

  // Ore you can see: any dug cell with an ore block on a face.
  function seenFrom(cells, x, z, ds, mined) {
    for (const c of cells) {
      if (mined && mined.has(c.body)) continue;
      if (!ds.includes(c.d)) continue;
      if (Math.abs(c.x - x) + Math.abs(c.z - z) <= 1) return true;
    }
    return false;
  }

  /* ---------- step 4: edge search up the dug shaft ---------- */
  function edgeSearch(cells, hitDepth, emptyAbove, mined) {
    let lo = emptyAbove, hi = hitDepth;
    const probes = [];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const c = count(cells, 0, 0, mid, mined);
      probes.push({ d: mid, c, lo, hi });
      if (c > 0) hi = mid; else lo = mid;
    }
    return { probes, highest: hi, top: hi + P.R, lo, emptyAbove, hitDepth };
  }

  /* ---------- step 5: tunnel toward the count ---------- */
  // Two test arms (east, south), compare counts, follow the axis that changed most, stop at the first ore you see.
  function chase(cells, level, mined) {
    const ds = [level - 1, level];                    // a 2-high tunnel covers the top layer and the one below
    const out = { level, steps: [], armE: [], armS: [], follow: [], cost: 0, probes: [] };
    const c0 = count(cells, 0, 0, level, mined);
    out.c0 = c0;
    // east arm
    for (let s = 1; s <= P.arm; s++) {
      out.armE.push({ x: s, z: 0 }); out.cost += 2;
      if (seenFrom(cells, s, 0, ds, mined)) { out.seenIn = 'E'; out.seenAt = { x: s, z: 0 }; return out; }
    }
    out.cE = count(cells, P.arm, 0, level, mined); out.cost += P.probeCost;
    for (let s = 1; s <= P.arm; s++) {
      out.armS.push({ x: 0, z: s }); out.cost += 2;
      if (seenFrom(cells, 0, s, ds, mined)) { out.seenIn = 'S'; out.seenAt = { x: 0, z: s }; return out; }
    }
    out.cS = count(cells, 0, P.arm, level, mined); out.cost += P.probeCost;
    const dE = out.cE - c0, dS = out.cS - c0;
    out.dE = dE; out.dS = dS;
    // axis with the bigger change; toward it if it rose, away if it fell
    const useE = Math.abs(dE) >= Math.abs(dS);
    const delta = useE ? dE : dS;
    out.axis = useE ? 'x' : 'z';
    out.sign = delta >= 0 ? 1 : -1;
    out.decision = useE ? (delta >= 0 ? 'east' : 'west') : (delta >= 0 ? 'south' : 'north');
    // follow: continue from the end of the arm we already dug when the sign matches, else start from the shaft
    let x = 0, z = 0;
    if (useE && out.sign > 0) x = P.arm; else if (!useE && out.sign > 0) z = P.arm;
    for (let s = 0; s < 40 && out.cost < P.giveUp; s++) {
      x += useE ? out.sign : 0; z += useE ? 0 : out.sign;
      out.follow.push({ x, z }); out.cost += 2;
      if (seenFrom(cells, x, z, ds, mined)) { out.seenIn = out.axis; out.seenAt = { x, z }; break; }
      if (out.follow.length % P.arm === 0) {
        const c = count(cells, x, z, level, mined); out.probes.push({ x, z, c }); out.cost += P.probeCost;
      }
    }
    return out;
  }

  /* ---------- the illustrative run ---------- */
  function buildRun() {
    const A = makeBody('A', 11, 9, -2, 4.6, 4.0, 57);
    const B = makeBody('B', 23, 9, 2, 4.3, 3.6, 96);
    // Bystanders: ore the shaft never comes within 6 blocks of. Kept inside the section view's window.
    const decorSpec = [
      [-19, 4, 5, 4, 31], [30, -3, 6, 5, 38], [52, 2, 7, 5, 66], [-22, -5, 5, 4, 68], [64, 6, 6, 4, 90],
      [-16, 0, 6, 5, 100], [36, 5, 5, 4, 108], [70, -3, 5, 4, 48], [-24, 3, 4, 3, 82], [22, 4, 5, 4, 22],
    ];
    const decor = decorSpec.map((s, i) => makeBody('D' + i, 100 + i, s[0], s[1], s[2], s[3], s[4]));
    const bodies = [A, B, ...decor];
    const cells = [].concat(...bodies.map(b => b.cells));
    const none = new Set();

    // step 3: probes every 13 blocks down the shaft
    const shaftProbes = [];
    for (let d = P.probeStep; d <= P.stopDepth; d += P.probeStep) shaftProbes.push(d);
    const firstHit = shaftProbes.find(d => count(cells, 0, 0, d, none) > 0);
    const before = shaftProbes.filter(d => d < firstHit).map(d => ({ d, c: 0 }));
    const hitCount = count(cells, 0, 0, firstHit, none);

    // step 4: edge search between the last empty probe and the hit
    const emptyAbove = firstHit - P.probeStep;
    const edgeA = edgeSearch(cells, firstHit, emptyAbove, none);
    const levelA = edgeA.top + 1;                      // shaft floor: tunnel occupies top and top+1

    // step 5: chase
    const chaseA = chase(cells, levelA, none);
    const minedA = new Set(['A']);
    const nA = A.cells.length;
    const reprobeA = count(cells, chaseA.seenAt ? chaseA.seenAt.x : 0, chaseA.seenAt ? chaseA.seenAt.z : 0, levelA, minedA);

    // step 7: on down. Probe again at each 13 blocks; A is gone.
    const later = shaftProbes.filter(d => d > firstHit).map(d => ({ d, c: count(cells, 0, 0, d, minedA) }));
    const hitB = later.find(p => p.c > 0);
    const edgeB = edgeSearch(cells, hitB.d, hitB.d - P.probeStep, minedA);
    const levelB = edgeB.top + 1;
    const chaseB = chase(cells, levelB, minedA);
    const nB = B.cells.length;

    // durability ledger (one number, as in the simulations)
    const L = {};
    L.dig1 = firstHit; L.probes1 = shaftProbes.filter(d => d <= firstHit).length * P.probeCost;
    L.edgeA = edgeA.probes.length * P.probeCost + (levelA - firstHit);
    L.chaseA = chaseA.cost;
    L.mineA = nA + P.probeCost;
    L.down1 = (hitB.d - levelA) + later.filter(p => p.d <= hitB.d).length * P.probeCost;
    L.edgeB = edgeB.probes.length * P.probeCost + (levelB - hitB.d);
    L.chaseB = chaseB.cost;
    L.mineB = nB + P.probeCost;
    L.down2 = P.stopDepth - levelB + later.filter(p => p.d > hitB.d).length * P.probeCost;
    const underground = Object.values(L).reduce((a, b) => a + b, 0);
    return { A, B, decor, bodies, cells, shaftProbes, firstHit, before, hitCount, edgeA, levelA, chaseA, nA, reprobeA,
             later, hitB, edgeB, levelB, chaseB, nB, ledger: L, underground, ore: nA + nB,
             orePer100: 100 * (nA + nB) / underground };
  }

  /* ---------- step 8: a patch seen from above, shafts 32 blocks apart ---------- */
  function buildPatch(run) {
    const r = rng(5);
    const shafts = [];
    // two rows of three, walked in a loop: shaft 1 is top-left
    const order = [[0, -0.5], [1, -0.5], [2, -0.5], [2, 0.5], [1, 0.5], [0, 0.5]];
    order.forEach(([i, j], n) => shafts.push({ x: i * P.shaftSpacing, z: j * P.shaftSpacing, n }));
    const bodies = [];
    shafts.forEach((s, n) => {
      // shaft 1's own two bodies, moved to where shaft 1 stands
      if (n === 0) { bodies.push({ owner: 0, b: run.A, dx: s.x, dz: s.z }, { owner: 0, b: run.B, dx: s.x, dz: s.z }); return; }
      const k = 2 + Math.floor(r() * 2);
      for (let q = 0; q < k; q++) {
        const cx = s.x + (r() - 0.35) * 14, cz = s.z + (r() - 0.5) * 12;
        bodies.push({ owner: n, b: makeBody('P' + n + q, 300 + n * 7 + q, cx, cz, 3 + r() * 4, 2.6 + r() * 3.4, 40), dx: 0, dz: 0 });
      }
    });
    // ore between shafts that no shaft reaches (this is what spacing leaves behind)
    for (let q = 0; q < 12; q++) {
      const cx = 12 + r() * 60, cz = -32 + r() * 64;
      if (shafts.some(s => Math.abs(s.x - cx) < 13 && Math.abs(s.z - cz) < 13)) continue;
      bodies.push({ owner: -1, b: makeBody('Q' + q, 500 + q, cx, cz, 3 + r() * 3, 2.5 + r() * 2.5, 40), dx: 0, dz: 0 });
    }
    return { shafts, bodies };
  }

  const RUN = buildRun();
  const PATCH = buildPatch(RUN);

  /* ---------- the walk and the climb for the run ---------- */
  const START = { x: 60, y: 780 };
  const WALK = explore(START, { x: PATCHES[0].x, y: PATCHES[0].y }, 0.09);
  const found = WALK.readings[WALK.readings.length - 1];
  const CLIMB = climb(found);

  /* ---------- the whole patch: a 32-block lattice inside the "decent" outline ---------- */
  // Anchored on shaft 1 (where the climb ended), filled from the middle out, because the middle reads highest.
  function buildPatchFill() {
    const c = { x: CLIMB.end.x, y: CLIMB.end.y }, span = 700, decent = 4 / 15, shafts = [];
    for (let i = -14; i <= 14; i++) {
      for (let j = -14; j <= 14; j++) {
        const x = c.x + i * P.shaftSpacing, y = c.y + j * P.shaftSpacing;
        if (x < 0 || y < 0 || x > MAP.w || y > MAP.h) continue;
        if (Math.abs(x - c.x) > span / 2 - 8 || Math.abs(y - c.y) > span / 2 - 8) continue;
        const f = density(x, y);
        if (f >= decent) shafts.push({ x, y, i, j, d: Math.hypot(i, j), f });
      }
    }
    shafts.sort((a, b) => a.d - b.d);
    // outline: short segments wherever a 7-block sample flips across the "decent" threshold
    const outline = [], n = 100, step = span / n;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const x = c.x - span / 2 + a * step, y = c.y - span / 2 + b * step;
        const f0 = density(x, y) >= decent;
        if (a + 1 < n && (density(x + step, y) >= decent) !== f0) outline.push({ x: x + step / 2, y, v: true });
        if (b + 1 < n && (density(x, y + step) >= decent) !== f0) outline.push({ x, y: y + step / 2, v: false });
      }
    }
    return { center: c, span, shafts, outline, step };
  }
  const PATCHFILL = buildPatchFill();

  return { P, MAP, PATCHES, density, WORDS, wordIndex, DECENT, BUCKETS, bucket, explore, climb, makeBody, count, seenFrom,
           edgeSearch, chase, RUN, PATCH, START, WALK, CLIMB, PATCHFILL, rng, valueNoise };
})();

if (typeof module !== 'undefined') module.exports = World;
