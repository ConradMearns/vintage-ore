// The Prospector's Loop — an animated field guide to the prospecting strategy found in the
// vintage-ore research (three 4096² worlds, 59M ore blocks, realistic shaft simulations).
//
// Controls: space / click = pause, ← → = previous / next chapter, 1–8 = jump to chapter.
// URL: ?t=<seconds> starts paused at that time (handy for stills).
//
// Numbers shown are for native copper with node search radius 6 unless noted.

const VW = 1280, VH = 720;                  // virtual canvas, letterboxed to the window
const VIEW = { x: 40, y: 64, w: 800, h: 536 }; // main stage
const PANEL = { x: 868, y: 64, w: 372, h: 536 };

const SCENES = [
  { id: "title",   dur: 7,  title: "The Prospector's Loop",
    text: "A field guide from 59 million simulated ore blocks. Every number here comes from the research." },
  { id: "explore", dur: 13, title: "1 · Find a patch",
    text: "Walk in a straight line and take a density reading about every 100 blocks. Patches are big, so sparse readings find one as fast as dense ones, for a third of the durability." },
  { id: "climb",   dur: 10, title: "2 · Climb to the rich centre",
    text: "From your first “decent” or better reading, take four compass readings 64 blocks out and step to the best. Repeat while it improves. ~36 durability reaches “high” 92% of the time." },
  { id: "dig",     dur: 13, title: "3 · Dig down, probe every 13",
    text: "A 1×1 vertical shaft. A node search every 13 blocks: the ±6 cubes tile the column with no overlap. Count rope ladders as you go; that is your depth." },
  { id: "edge",    dur: 15, title: "4 · Hit! Find the top of the ore",
    text: "The count is a hard-edged box: a probe sees ore only within 6 blocks up or down. Halve your way up the dug shaft to the highest probe that still counts. The ore's top is 6 below it." },
  { id: "chase",   dur: 15, title: "5 · Follow the count, then keep going",
    text: "Tunnel 2-high with your floor one block under the top. Test 3 blocks east and south, follow the rising count until ore shows on the wall, mine the whole body. Then carry on down." },
  { id: "stop",    dur: 8,  title: "6 · Stop at 112 rope ladders",
    text: "For copper, stopping at 112 is as good as bedrock and saves the climb. Tin and hematite: stop at 80." },
  { id: "next",    dur: 13, title: "7 · Next shaft: 32 blocks away",
    text: "A shaft clears ~13 blocks of probe plus the bodies it chases. Closer than 32, the next shaft re-digs cleared ground (13 apart: about half the ore). Tin 24, iron 64." },
  { id: "recipe",  dur: 16, title: "The recipe",
    text: "Space: pause · ← →: chapters · the loop repeats." },
];
const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);

const C = {
  bg: "#0e0d0c", panel: "#171513", ink: "#f1ead9", ink2: "#b9b09f", muted: "#7d766a", line: "#2b2824",
  sky1: "#7fa8c4", sky2: "#c9dbe6", grass: "#5f8c3a", soil: "#6f4f33", soil2: "#62452c",
  rock: ["#7d7973", "#6e6a64", "#8a857c", "#75706a"], dug: "#211c18", dugEdge: "#2e2721",
  ore: "#c46f38", ore2: "#e0955a", patina: "#5f9c7c",
  probe: "#62c8f0", hit: "#ffb347", good: "#6cc070", bad: "#e5604f",
  heat: ["#15171a", "#123a6b", "#1c5cab", "#3987e5", "#86b6ef", "#cde2fb"],
};

let T = 0, paused = false, lastMs = 0;
let fontMono = "IBM Plex Mono", fontHead = "Archivo";

/* ======================================================================================
   Underground cross-section world
   ====================================================================================== */
const COLS = 50, ROWS = 124, BS = 16;       // blocks; 16 px each on stage
const SHAFT = 20, R = 6;
let grid = [];                               // base world: 0 air, 1 soil, 2..5 rock, 9 ore
let surf = [];
const DEPOSITS = [
  { c0: 25, c1: 38, top: 80, th: 2, main: true },   // the one we find
  { c0: 30, c1: 46, top: 36, th: 2 },               // shallow, off to the side: never in reach
  { c0: 2,  c1: 11, top: 99, th: 2 },               // deep, 9+ blocks west: outside the cube
  { c0: 41, c1: 44, top: 60, th: 1 },               // a speck
];

function buildWorld() {
  randomSeed(7); noiseSeed(7);
  for (let c = 0; c < COLS; c++) surf[c] = floor(noise(c * 0.12) * 3);
  for (let c = 0; c < COLS; c++) {
    grid[c] = [];
    for (let r = 0; r < ROWS; r++) {
      if (r < surf[c]) grid[c][r] = 0;
      else if (r < surf[c] + 3) grid[c][r] = 1;
      else grid[c][r] = 2 + (floor((r + noise(c * 0.08, r * 0.04) * 10) / 14) % 4);
    }
  }
  for (const d of DEPOSITS) {
    for (let c = d.c0; c <= d.c1; c++) {
      const wob = round((noise(c * 0.3, d.top) - 0.5) * 1.4);
      const edge = (c === d.c0 || c === d.c1) ? 1 : d.th;
      for (let k = 0; k < edge; k++) grid[c][d.top + k + (d.main ? 0 : wob)] = 9;
    }
  }
}

// Node search count in the side slice (×4 stands in for the depth dimension of the real 3D cube).
function countAt(c, r, dugSet) {
  let n = 0;
  for (let cc = c - R; cc <= c + R; cc++) for (let rr = r - R; rr <= r + R; rr++) {
    if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS) continue;
    if (grid[cc][rr] === 9 && !(dugSet && dugSet.has(key(cc, rr)))) n++;
  }
  return n * 4;
}
const key = (c, r) => c * 1000 + r;

/* ---------- the underground timeline: actions keyed to scenes ---------- */
// Each action: {scene, t0, t1, kind, cells?, at?, c?, r?, label?}
const ACTIONS = [];
const PROBES = [];         // {scene, t, c, r, count}
function sceneIndex(id) { return SCENES.findIndex(s => s.id === id); }

function buildActions() {
  const dig = sceneIndex("dig"), edge = sceneIndex("edge"), chase = sceneIndex("chase"), stop = sceneIndex("stop");
  // shaft to the hit at 78, probes every 13
  const shaftCells = (d0, d1) => { const a = []; for (let r = d0; r <= d1; r++) a.push([SHAFT, r + surf[SHAFT]]); return a; };
  const S = surf[SHAFT];
  ACTIONS.push({ scene: dig, t0: 0.06, t1: 0.86, kind: "dig", cells: shaftCells(0, 78) });
  for (let d = 13; d <= 78; d += 13) PROBES.push({ scene: dig, t: 0.06 + 0.8 * d / 78, c: SHAFT, r: d + S });

  // edge search: highest height (smallest depth) between 65 (empty) and 78 (counts)
  let lo = 78, hi = 65, t = 0.08;
  while (lo - hi > 1) {
    const mid = floor((lo + hi) / 2);
    PROBES.push({ scene: edge, t, c: SHAFT, r: mid + S, edge: true });
    if (countAt(SHAFT, mid + S) > 0) lo = mid; else hi = mid;
    t += 0.13;
  }
  EDGE = { found: lo, top: lo + R, t };
  ACTIONS.push({ scene: edge, t0: 0.82, t1: 0.92, kind: "dig", cells: shaftCells(79, EDGE.top + 1) });

  // chase: tunnel floor = top+1 (depth), 2-high = rows top and top+1
  const tr = EDGE.top + S, tunnel = (c0, c1) => { const a = []; for (let c = c0; c <= c1; c++) { a.push([c, tr]); a.push([c, tr + 1]); } return a; };
  ACTIONS.push({ scene: chase, t0: 0.04, t1: 0.14, kind: "dig", cells: tunnel(SHAFT + 1, SHAFT + 3) });
  PROBES.push({ scene: chase, t: 0.16, c: SHAFT + 3, r: tr + 1, arm: "east" });
  ACTIONS.push({ scene: chase, t0: 0.30, t1: 0.38, kind: "dig", cells: tunnel(SHAFT + 4, 24) });
  const body = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    if (grid[c][r] === 9 && DEPOSITS[0].c0 <= c && c <= DEPOSITS[0].c1 && abs(r - tr) <= 2) body.push([c, r]);
  }
  body.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  ACTIONS.push({ scene: chase, t0: 0.42, t1: 0.66, kind: "mine", cells: body });
  ACTIONS.push({ scene: chase, t0: 0.70, t1: 0.96, kind: "dig", cells: shaftCells(EDGE.top + 2, 104) });
  PROBES.push({ scene: chase, t: 0.70 + 0.26 * (91 - EDGE.top - 2) / (104 - EDGE.top - 2), c: SHAFT, r: 91 + S });
  PROBES.push({ scene: chase, t: 0.96, c: SHAFT, r: 104 + S });
  ACTIONS.push({ scene: stop, t0: 0.02, t1: 0.25, kind: "dig", cells: shaftCells(105, 112) });
}
let EDGE = null;

// World state (dug cells, mined ore, cost) at scene index si and progress p.
function stateAt(si, p) {
  const dug = new Set(), mined = new Set();
  let cost = 0, ore = 0;
  for (const a of ACTIONS) {
    if (a.scene > si) continue;
    let n = a.cells.length;
    if (a.scene === si) { if (p < a.t0) continue; n = floor(n * constrain((p - a.t0) / (a.t1 - a.t0), 0, 1)); }
    for (let i = 0; i < n; i++) {
      const [c, r] = a.cells[i], k = key(c, r);
      if (dug.has(k)) continue;
      dug.add(k);
      if (grid[c][r] === 9) { mined.add(k); ore++; cost++; }
      else if (grid[c][r] !== 0) cost++;
    }
  }
  let probes = 0;
  for (const pr of PROBES) if (pr.scene < si || (pr.scene === si && p >= pr.t)) probes++;
  return { dug, mined, cost: cost + probes * 2, ore, probes };
}

/* ======================================================================================
   Top-down density map
   ====================================================================================== */
const MAP = { w: 1600, h: 1072 };            // blocks, drawn at 0.5 px/block
const BLOBS = [
  { x: 1300, z: 330, r: 125, a: 0.78 }, { x: 1385, z: 250, r: 70, a: 0.18 },
  { x: 430, z: 860, r: 170, a: 0.20 }, { x: 860, z: 520, r: 110, a: 0.21 },
  { x: 1460, z: 880, r: 140, a: 0.34 }, { x: 250, z: 250, r: 150, a: 0.20 },
];
const WORDS = ["none", "very poor", "poor", "decent", "high", "very high", "ultra high"];
function field(x, z) {
  let f = (noise(x * 0.0035 + 40, z * 0.0035 + 90) - 0.5) * 0.10;
  for (const b of BLOBS) f += b.a * exp(-((x - b.x) ** 2 + (z - b.z) ** 2) / (2 * b.r * b.r));
  return constrain(f, 0, 0.8);
}
function word(f) { return f <= 0.025 ? "none" : WORDS[1 + min(5, floor(f * 7.5))]; }
function wordRank(f) { return f <= 0.025 ? 0 : 1 + min(5, floor(f * 7.5)); }
function heatColor(f) {
  const stops = [0, 0.025, 2 / 15, 4 / 15, 6 / 15, 8 / 15];
  for (let i = stops.length - 1; i >= 0; i--) if (f >= stops[i]) {
    if (i === stops.length - 1) return color(C.heat[i]);
    return lerpColor(color(C.heat[i]), color(C.heat[i + 1]), (f - stops[i]) / (stops[i + 1] - stops[i]));
  }
  return color(C.heat[0]);
}
let heatImg, zoomImg;
let WALK = [], CLIMB = [], FOUND = null, PEAK = null;
const ZOOM = { cx: 0, cz: 0, span: 900 };   // zoomed patch view, blocks across

function buildMap() {
  heatImg = createGraphics(200, 134);
  heatImg.noStroke();
  for (let i = 0; i < 200; i++) for (let j = 0; j < 134; j++) {
    heatImg.fill(heatColor(field((i + 0.5) * 8, (j + 0.5) * 8)));
    heatImg.rect(i, j, 1, 1);
  }
  // straight walk, reading every 100 blocks
  const start = { x: 120, z: 1000 }, dir = createVector(1300 - 120, 330 - 1000).normalize();
  // aim slightly off the centre so the walk meets the edge of the patch, as it would in practice
  dir.rotate(-0.10);
  for (let k = 0; k < 40; k++) {
    const x = start.x + dir.x * 100 * k, z = start.z + dir.y * 100 * k, f = field(x, z);
    WALK.push({ x, z, f });
    if (f >= 4 / 15) { FOUND = { x, z, f }; break; }
  }
  // compass climb, 64 blocks
  let cur = { ...FOUND };
  for (let step = 0; step < 12; step++) {
    const nb = [[64, 0], [-64, 0], [0, 64], [0, -64]].map(([dx, dz]) => ({ x: cur.x + dx, z: cur.z + dz, f: field(cur.x + dx, cur.z + dz) }));
    const best = nb.reduce((a, b) => (b.f > a.f ? b : a));
    CLIMB.push({ from: cur, nb, best, moved: best.f > cur.f });
    if (best.f <= cur.f) break;
    cur = best;
  }
  PEAK = cur;
  ZOOM.cx = PEAK.x; ZOOM.cz = PEAK.z;
  zoomImg = createGraphics(210, 210);
  zoomImg.noStroke();
  for (let i = 0; i < 210; i++) for (let j = 0; j < 210; j++) {
    const x = ZOOM.cx - ZOOM.span / 2 + (i + 0.5) * ZOOM.span / 210, z = ZOOM.cz - ZOOM.span / 2 + (j + 0.5) * ZOOM.span / 210;
    zoomImg.fill(heatColor(field(x, z)));
    zoomImg.rect(i, j, 1, 1);
  }
}
const mapX = x => VIEW.x + x * 0.5, mapY = z => VIEW.y + z * 0.5;

/* ======================================================================================
   p5 lifecycle
   ====================================================================================== */
function setup() {
  createCanvas(windowWidth, windowHeight);
  noiseDetail(3, 0.5);
  buildWorld();
  buildActions();
  buildMap();
  lastMs = millis();
  const q = new URLSearchParams(location.search);
  if (q.has("t")) { T = parseFloat(q.get("t")) || 0; paused = true; }
}
function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function draw() {
  const now = millis();
  if (!paused) T = (T + (now - lastMs) / 1000) % TOTAL;
  lastMs = now;
  let acc = 0, si = 0;
  for (; si < SCENES.length; si++) { if (T < acc + SCENES[si].dur) break; acc += SCENES[si].dur; }
  si = min(si, SCENES.length - 1);
  const sc = SCENES[si], local = T - acc, p = local / sc.dur;

  background(C.bg);
  const s = min(width / VW, height / VH);
  push();
  translate((width - VW * s) / 2, (height - VH * s) / 2);
  scale(s);
  noStroke(); fill(C.bg); rect(0, 0, VW, VH);
  ({ title: drawTitle, explore: drawExplore, climb: drawClimb, dig: drawUnder, edge: drawUnder, chase: drawUnder,
     stop: drawUnder, next: drawNext, recipe: drawRecipe })[sc.id](si, p, local);
  drawChrome(si, p);
  pop();
}

function keyPressed() {
  const starts = []; let a = 0; for (const s of SCENES) { starts.push(a); a += s.dur; }
  let cur = starts.findIndex((st, i) => T >= st && T < st + SCENES[i].dur);
  if (key === " ") paused = !paused;
  else if (keyCode === RIGHT_ARROW) T = starts[(cur + 1) % SCENES.length] + 0.01;
  else if (keyCode === LEFT_ARROW) T = starts[(cur - 1 + SCENES.length) % SCENES.length] + 0.01;
  else if (key >= "1" && key <= "9") { const i = int(key) - 1; if (i < SCENES.length) T = starts[i] + 0.01; }
  return false;
}
function mousePressed() { paused = !paused; }

/* ======================================================================================
   Chrome: captions, progress, tally
   ====================================================================================== */
function ease(x) { x = constrain(x, 0, 1); return x * x * (3 - 2 * x); }
function fadeIn(p, a, b) { return ease((p - a) / (b - a)); }

function drawChrome(si, p) {
  const sc = SCENES[si];
  // header
  fill(C.muted); textFont(fontMono); textSize(12); textAlign(LEFT, BASELINE);
  text("VINTAGE ORE SURVEY · PROSPECTING GUIDE", 40, 38);
  textAlign(RIGHT, BASELINE);
  text(paused ? "❚❚ paused · space to play" : "space: pause   ← →: chapters", VW - 40, 38);

  // caption
  if (sc.id !== "title" && sc.id !== "recipe") {
    fill(C.ink); textFont(fontHead); textSize(24); textAlign(LEFT, BASELINE);
    text(sc.title, 40, 640);
    fill(C.ink2); textFont(fontMono); textSize(13.5); textLeading(20);
    text(sc.text, 40, 652, 1200, 60);
  }
  // progress
  let acc = 0;
  for (let i = 0; i < SCENES.length; i++) {
    const x = 40 + (acc / TOTAL) * 1200, w = (SCENES[i].dur / TOTAL) * 1200 - 4;
    fill(i < si ? "#4d4840" : i === si ? "#4d4840" : C.line); rect(x, 704, w, 4, 2);
    if (i === si) { fill(C.hit); rect(x, 704, w * p, 4, 2); }
    acc += SCENES[i].dur;
  }
}

function tally(rows) {
  // rows: [label, value, emphasis?]
  const x = PANEL.x, y = PANEL.y;
  fill(C.panel); rect(x, y, PANEL.w, 44 + rows.length * 46, 8);
  fill(C.muted); textFont(fontMono); textSize(11); textAlign(LEFT, BASELINE);
  text("THIS EXAMPLE", x + 18, y + 26);
  rows.forEach(([l, v, em], i) => {
    const yy = y + 58 + i * 46;
    fill(C.muted); textSize(11); text(l.toUpperCase(), x + 18, yy);
    fill(em ? C.hit : C.ink); textFont(fontHead); textSize(22); text(v, x + 18, yy + 25);
    textFont(fontMono);
  });
  return y + 44 + rows.length * 46 + 14;
}

function note(y, lines, title) {
  const x = PANEL.x;
  textFont(fontMono); textSize(12.5); textLeading(18);
  const h = 22 + (title ? 22 : 0) + lines.length * 18 + 10;
  fill(C.panel); rect(x, y, PANEL.w, h, 8);
  let yy = y + 26;
  if (title) { fill(C.ink); textFont(fontHead); textSize(15); textAlign(LEFT, BASELINE); text(title, x + 18, yy); yy += 22; textFont(fontMono); textSize(12.5); }
  fill(C.ink2); textAlign(LEFT, BASELINE);
  for (const l of lines) { text(l, x + 18, yy); yy += 18; }
  return y + h + 12;
}

/* ======================================================================================
   Scene: title
   ====================================================================================== */
function drawTitle(si, p, local) {
  // slow pan down a cross-section as a backdrop
  const cam = -6 + ease(p) * 70;
  drawSection(null, cam, 0.35, { x: 0, y: 0, w: VW, h: VH }, 26);
  fill(14, 13, 12, 200); rect(0, 0, VW, VH);
  const a = fadeIn(p, 0, 0.18) * 255;
  fill(241, 234, 217, a); textFont(fontHead); textAlign(LEFT, BASELINE); textSize(64);
  text("The Prospector's Loop", 80, 300);
  fill(185, 176, 159, a); textFont(fontMono); textSize(17); textLeading(26);
  text("How to find the most ore per point of tool durability in Vintage Story 1.22,\naccording to 3 simulated worlds, 59 million ore blocks and 49,152 shafts per strategy.", 80, 340);
  fill(255, 179, 71, fadeIn(p, 0.3, 0.5) * 255); textSize(14);
  text("Native copper · node search radius 6 · the loop takes about 90 seconds", 80, 420);
}

/* ======================================================================================
   Scene: explore / climb (top-down density map)
   ====================================================================================== */
function drawMapBase() {
  push(); noSmooth(); image(heatImg, VIEW.x, VIEW.y, 800, 536); pop();
  noFill(); stroke(C.line); strokeWeight(1); rect(VIEW.x, VIEW.y, 800, 536);
  // scale bar 200 blocks
  noStroke(); fill(C.ink); rect(VIEW.x + 20, VIEW.y + 510, 100, 3);
  textFont(fontMono); textSize(11); textAlign(LEFT, BASELINE); text("200 blocks", VIEW.x + 20, VIEW.y + 502);
}
function heatLegend(y) {
  const x = PANEL.x;
  fill(C.panel); rect(x, y, PANEL.w, 76, 8);
  fill(C.muted); textFont(fontMono); textSize(11); textAlign(LEFT, BASELINE); text("DENSITY READING (COPPER)", x + 18, y + 24);
  for (let i = 0; i < 200; i++) { fill(heatColor(i / 200 * 0.7)); rect(x + 18 + i * 1.6, y + 34, 1.7, 10); }
  fill(C.ink2); textSize(10.5);
  [["poor", 2 / 15], ["decent", 4 / 15], ["high", 6 / 15], ["v.high", 8 / 15]].forEach(([l, v]) => text(l, x + 18 + v / 0.7 * 320 - 10, y + 62));
  return y + 88;
}
function readingDot(x, z, f, big, labelIt) {
  const px = mapX(x), py = mapY(z), r = wordRank(f);
  stroke(C.bg); strokeWeight(2); fill(r >= 3 ? C.hit : C.ink); circle(px, py, big ? 13 : 9);
  if (labelIt) {
    noStroke(); fill(C.bg + "cc"); const w = textWidth(word(f)) + 12;
    textFont(fontMono); textSize(11);
    rect(px + 9, py - 22, textWidth(word(f)) + 12, 18, 4);
    fill(r >= 3 ? C.hit : C.ink); textAlign(LEFT, BASELINE); text(word(f), px + 15, py - 9);
  }
}
function player(px, py) {
  noStroke(); fill(0, 90); ellipse(px + 2, py + 8, 14, 6);
  fill("#e9d8b4"); rect(px - 5, py - 12, 10, 10, 2);
  fill("#7a4f2b"); rect(px - 6, py - 2, 12, 8, 2);
}

function drawExplore(si, p) {
  drawMapBase();
  const n = WALK.length, prog = ease(p / 0.85) * (n - 1);
  const k = floor(prog), frac = prog - k;
  // walked path
  stroke(C.ink); strokeWeight(2); drawingContext.setLineDash([2, 6]);
  const a = WALK[0], b = WALK[min(k + 1, n - 1)], cur = WALK[k];
  const px = lerp(mapX(cur.x), mapX(b.x), k < n - 1 ? frac : 0), pz = lerp(mapY(cur.z), mapY(b.z), k < n - 1 ? frac : 0);
  line(mapX(a.x), mapY(a.z), px, pz);
  drawingContext.setLineDash([]);
  for (let i = 0; i <= k; i++) readingDot(WALK[i].x, WALK[i].z, WALK[i].f, i === n - 1, i >= k - 1 || i === n - 1);
  player(px, pz);
  if (k >= n - 1) {
    noFill(); stroke(C.hit); strokeWeight(2); circle(mapX(FOUND.x), mapY(FOUND.z), 30 + sin(frameCount * 0.15) * 4);
  }
  let y = tally([["Readings", `${k + 1}`], ["Walked", `${round((k + (k < n - 1 ? frac : 0)) * 100)} blocks`], ["Durability", `${(k + 1) * 3}`, true]]);
  y = heatLegend(y);
  note(y, ["One reading = 3 samples = 3 durability.", "Reading every 100 blocks: median", "~1,300 blocks to a “decent” copper", "patch. Every 32: same walk, 3× the", "durability."], "Why so sparse?");
}

function drawClimb(si, p) {
  drawMapBase();
  // zoom toward the patch
  const z = ease(p / 0.12);
  // walked path, faded
  stroke(241, 234, 217, 90); strokeWeight(1.5); drawingContext.setLineDash([2, 6]);
  line(mapX(WALK[0].x), mapY(WALK[0].z), mapX(FOUND.x), mapY(FOUND.z)); drawingContext.setLineDash([]);
  const steps = CLIMB.length, sp = constrain((p - 0.1) / 0.8, 0, 1) * steps;
  const k = min(floor(sp), steps - 1), f = sp - floor(sp);
  let readings = 0;
  for (let i = 0; i <= k; i++) {
    const st = CLIMB[i], shown = i < k ? 1 : f;
    const nbShown = i < k ? 4 : min(4, floor(shown * 6));
    readings += nbShown;
    for (let j = 0; j < nbShown; j++) {
      const q = st.nb[j];
      stroke(241, 234, 217, 120); strokeWeight(1); line(mapX(st.from.x), mapY(st.from.z), mapX(q.x), mapY(q.z));
      readingDot(q.x, q.z, q.f, false, false);
    }
    if ((i < k || shown > 0.75) && st.moved) {
      stroke(C.hit); strokeWeight(3); line(mapX(st.from.x), mapY(st.from.z), mapX(st.best.x), mapY(st.best.z));
    }
  }
  const at = (k < steps && (f > 0.85 || k < steps - 1) && CLIMB[k].moved) ? CLIMB[k].best : CLIMB[k].from;
  readingDot(FOUND.x, FOUND.z, FOUND.f, true, true);
  const done = p > 0.9;
  if (done) { readingDot(PEAK.x, PEAK.z, PEAK.f, true, true); noFill(); stroke(C.hit); strokeWeight(2); circle(mapX(PEAK.x), mapY(PEAK.z), 34 + sin(frameCount * 0.15) * 4); }
  player(mapX(at.x), mapY(at.z) - 4);
  let y = tally([["Compass readings", `${readings}`], ["Reading here", word(done ? PEAK.f : at.f), true], ["Durability", `${WALK.length * 3 + readings * 3}`, true]]);
  y = heatLegend(y);
  note(y, ["Four readings 64 blocks N/E/S/W.", "Step to the best; repeat while it", "improves. The patch is ~320 blocks", "across: room for ~100 shafts."], "Climbing");
}

/* ======================================================================================
   Underground cross-section
   ====================================================================================== */
function drawSection(st, camRow, dim, rect_, bs) {
  bs = bs || BS;
  const r0 = floor(camRow), off = (camRow - r0) * bs;
  const cols = ceil(rect_.w / bs), rows = ceil(rect_.h / bs) + 1;
  const ox = rect_.x + (rect_.w - COLS * bs) / 2;
  push();
  drawingContext.save();
  drawingContext.beginPath(); drawingContext.rect(rect_.x, rect_.y, rect_.w, rect_.h); drawingContext.clip();
  noStroke();
  // sky
  for (let i = 0; i < rows; i++) {
    const r = r0 + i, y = rect_.y + i * bs - off;
    if (r >= 0) break;
    fill(lerpColor(color(C.sky1), color(C.sky2), constrain((r + 8) / 8, 0, 1))); rect(rect_.x, y, rect_.w, bs + 1);
  }
  for (let c = -2; c < COLS + 2; c++) {
    const x = ox + c * bs;
    if (x + bs < rect_.x || x > rect_.x + rect_.w) continue;
    for (let i = 0; i < rows; i++) {
      const r = r0 + i, y = rect_.y + i * bs - off;
      if (r < 0) continue;
      const cc = constrain(c, 0, COLS - 1), rr = min(r, ROWS - 1);
      let t = grid[cc][rr];
      const k = key(cc, rr);
      if (t === 0) { fill(lerpColor(color(C.sky1), color(C.sky2), 0.9)); rect(x, y, bs + 0.5, bs + 0.5); continue; }
      if (st && st.dug.has(k)) { fill(C.dug); rect(x, y, bs + 0.5, bs + 0.5); fill(C.dugEdge); rect(x, y + bs - 2, bs, 2); continue; }
      if (t === 1) fill((c + r) % 3 ? C.soil : C.soil2);
      else if (t === 9) fill(C.ore);
      else fill(C.rock[t - 2]);
      rect(x, y, bs + 0.5, bs + 0.5);
      if (t === 1 && r === surf[cc]) { fill(C.grass); rect(x, y, bs + 0.5, bs * 0.3); }
      if (t === 9) { fill(C.ore2); rect(x + bs * 0.2, y + bs * 0.25, bs * 0.25, bs * 0.2); fill(C.patina); rect(x + bs * 0.6, y + bs * 0.55, bs * 0.18, bs * 0.18); }
      else if (bs >= 12) { fill(255, 255, 255, 10); rect(x + ((c * 7 + r * 3) % 9), y + ((c * 5 + r) % 10), 3, 3); }
      // ore visible on a dug wall
      if (st && t === 9 && neighbourDug(st, cc, rr)) { noFill(); stroke(C.hit); strokeWeight(2); rect(x + 1, y + 1, bs - 2, bs - 2); noStroke(); }
    }
  }
  if (dim) { fill(14, 13, 12, 255 * dim); rect(rect_.x, rect_.y, rect_.w, rect_.h); }
  drawingContext.restore();
  pop();
  return { ox, r0, off, bs };
}
function neighbourDug(st, c, r) {
  return st.dug.has(key(c + 1, r)) || st.dug.has(key(c - 1, r)) || st.dug.has(key(c, r + 1)) || st.dug.has(key(c, r - 1));
}
function cellXY(g, c, r) { return [g.ox + c * g.bs, VIEW.y + (r - g.r0) * g.bs - g.off]; }

function probeBox(g, pr, alpha, colorHex, label) {
  const [x, y] = cellXY(g, pr.c, pr.r);
  const col = color(colorHex);
  col.setAlpha(alpha * 40); fill(col); stroke(colorHex); strokeWeight(2);
  const a = color(colorHex); a.setAlpha(alpha * 255); stroke(a);
  rect(x - R * g.bs, y - R * g.bs, (2 * R + 1) * g.bs, (2 * R + 1) * g.bs, 3);
  noStroke(); fill(a); rect(x + 2, y + 2, g.bs - 4, g.bs - 4, 2);
  if (label) {
    textFont(fontMono); textSize(12); const w = textWidth(label) + 14;
    fill(14, 13, 12, 220 * alpha); rect(x + R * g.bs + g.bs + 6, y - 2, w, 20, 4);
    fill(a); textAlign(LEFT, BASELINE); text(label, x + R * g.bs + g.bs + 13, y + 13);
  }
}

// camera follows the action (rows)
function camFor(id, p, st) {
  const S = surf[SHAFT];
  if (id === "dig") return constrain(-6 + ease((p - 0.02) / 0.84) * 78 - 12, -6, 80);
  if (id === "edge") return 56 + S;
  if (id === "chase") return p < 0.68 ? 58 + S : 58 + S + ease((p - 0.68) / 0.3) * 24;
  if (id === "stop") return p < 0.3 ? 82 + S + ease(p / 0.25) * 4 : lerp(86 + S, -6, ease((p - 0.35) / 0.55));
  return 0;
}

function drawUnder(si, p, local) {
  const sc = SCENES[si], st = stateAt(si, p), cam = camFor(sc.id, p, st);
  const g = drawSection(st, cam, 0, VIEW);
  drawingContext.save();
  drawingContext.beginPath(); drawingContext.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h); drawingContext.clip();

  // depth ruler (rope ladders) on the left edge
  textFont(fontMono); textSize(10.5); textAlign(LEFT, CENTER);
  for (let d = 0; d <= 120; d += 13) {
    const [, y] = cellXY(g, SHAFT, d + surf[SHAFT]);
    if (y < VIEW.y + 8 || y > VIEW.y + VIEW.h - 8) continue;
    noStroke(); fill(14, 13, 12, 180); rect(VIEW.x + 4, y - 9, 40, 18, 3);
    fill(C.ink2); text(d, VIEW.x + 10, y);
  }

  // probes
  for (const pr of PROBES) {
    if (pr.scene > si) continue;
    const age = pr.scene === si ? (p - pr.t) * sc.dur : 99;
    if (age < 0) continue;
    const cnt = countAt(pr.c, pr.r, pr.scene === si ? null : null);
    const live = pr.scene === si || (sc.id === "edge" && pr.scene === si - 1 && pr.r - surf[SHAFT] === 78);
    let alpha = pr.scene === si ? constrain(1 - (age - 1.6) / 0.8, 0.12, 1) : 0.12;
    if (sc.id === "edge" && pr.scene === si - 1 && pr.r - surf[SHAFT] === 78) alpha = 0.7;
    if (sc.id === "edge" && pr.edge && pr.scene === si) alpha = age < 1.6 ? 1 : 0.14;
    if (alpha <= 0.13 && !live) { probeTick(g, pr, cnt); continue; }
    const hit = cnt > 0;
    const d = pr.r - surf[SHAFT];
    probeBox(g, pr, alpha, hit ? C.hit : C.probe, `${pr.arm ? "east arm" : d + " deep"} · count ${cnt}${hit && !pr.edge && !pr.arm ? "  HIT" : ""}`);
  }

  // edge-search annotation
  if (sc.id === "edge" && p > EDGE.t) {
    const a = fadeIn(p, EDGE.t, EDGE.t + 0.08);
    const [x1, yTopProbe] = cellXY(g, SHAFT, EDGE.found + surf[SHAFT]);
    const [, yTop] = cellXY(g, SHAFT, EDGE.top + surf[SHAFT]);
    stroke(255, 179, 71, 255 * a); strokeWeight(2);
    line(VIEW.x + 50, yTopProbe + BS / 2, x1 + BS * 5, yTopProbe + BS / 2);
    line(VIEW.x + 50, yTop, x1 + BS * 5, yTop);
    // arrow down 6
    const ax = x1 + BS * 3.5;
    line(ax, yTopProbe + BS / 2, ax, yTop - 4); fill(255, 179, 71, 255 * a); noStroke();
    triangle(ax - 5, yTop - 10, ax + 5, yTop - 10, ax, yTop - 2);
    textFont(fontMono); textSize(12); textAlign(LEFT, BASELINE);
    fill(14, 13, 12, 230 * a); rect(VIEW.x + 50, yTopProbe - 20, 214, 20, 4); rect(VIEW.x + 50, yTop + 4, 214, 20, 4);
    fill(255, 179, 71, 255 * a);
    text(`last probe that counts: ${EDGE.found}`, VIEW.x + 58, yTopProbe - 5);
    text(`ore top = ${EDGE.found} + 6 = ${EDGE.top}`, VIEW.x + 58, yTop + 19);
    fill(255, 179, 71, 255 * a); textAlign(CENTER, BASELINE); text("6", ax + 12, (yTopProbe + yTop) / 2 + 4);
  }

  // player marker
  const pp = playerPos(sc.id, p, st);
  if (pp) { const [x, y] = cellXY(g, pp[0], pp[1]); player(x + BS / 2, y + 2); }
  drawingContext.restore();
  noFill(); stroke(C.line); strokeWeight(1); rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);

  // right panel
  const ladders = shaftDepth(st);
  let y = tally([["Rope ladders (depth)", `${ladders}`], ["Durability", `${st.cost + WALK.length * 3 + climbReadings() * 3}`], ["Copper ore", `${st.ore}`, st.ore > 0]]);
  if (sc.id === "dig") y = note(y, ["Probe at 13, 26, 39, …: each cube", "covers ±6, so together they check", "every block of the column once.", "Every 6 (checking twice) costs more", "for the same finds."], "Why every 13?");
  if (sc.id === "edge") y = note(y, edgeLog(p), "Halving up the shaft");
  if (sc.id === "chase") y = chaseInset(y, p);
  if (sc.id === "stop") y = note(y, ["Copper: 112 ≈ bedrock (26.6 vs 26.5", "ore per 100 durability).", "Tin, hematite: stop at 80.", "Depth below the surface block you", "started from = ladders placed."], "Where to stop");
  legendUnder(y);
}
function climbReadings() { let n = 0; for (const c of CLIMB) n += 4; return n; }
function shaftDepth(st) { let d = 0; for (let r = 0; r < ROWS; r++) if (st.dug.has(key(SHAFT, r))) d = r - surf[SHAFT] + 1; return max(0, d); }
function playerPos(id, p, st) {
  const S = surf[SHAFT];
  if (id === "dig") return [SHAFT, surf[SHAFT] + max(0, shaftDepth(st)) - 2];
  if (id === "edge") {
    // climb to each probe height in turn
    let y = 78;
    for (const pr of PROBES) if (pr.edge && p >= pr.t - 0.05) y = pr.r - S;
    if (p > 0.8) y = shaftDepth(st) - 2;
    return [SHAFT, y + S];
  }
  if (id === "chase") {
    const tr = EDGE.top + S;
    if (p < 0.04) return [SHAFT, tr];
    if (p < 0.30) return [SHAFT + 3, tr];
    if (p < 0.42) return [SHAFT + 3 + floor(4 * ease((p - 0.30) / 0.08)), tr];
    if (p < 0.68) { const a = ACTIONS.find(a => a.kind === "mine"); const i = floor(a.cells.length * constrain((p - a.t0) / (a.t1 - a.t0), 0, 1)); const c = a.cells[min(i, a.cells.length - 1)]; return [c[0] - 1, tr]; }
    return [SHAFT, surf[SHAFT] + shaftDepth(st) - 2];
  }
  if (id === "stop") return p < 0.3 ? [SHAFT, S + shaftDepth(st) - 2] : [SHAFT, round(lerp(S + 110, S - 2, ease((p - 0.35) / 0.55)))];
  return null;
}
function edgeLog(p) {
  const lines = ["Hit at 78. Last empty probe: 65.", "Probe the wall halfway, keep halving:"];
  for (const pr of PROBES) if (pr.edge && p >= pr.t) {
    const d = pr.r - surf[SHAFT], c = countAt(pr.c, pr.r);
    lines.push(`  ${d} deep → ${c > 0 ? "counts (" + c + ")" : "0"}`);
  }
  if (p > EDGE.t) lines.push(`Ore top at ${EDGE.top}: dig to ${EDGE.top + 1}.`);
  return lines;
}
function chaseInset(y, p) {
  const x = PANEL.x, h = 190;
  fill(C.panel); rect(x, y, PANEL.w, h, 8);
  fill(C.ink); textFont(fontHead); textSize(15); textAlign(LEFT, BASELINE); text("Test arms (top view)", x + 18, y + 26);
  const cx = x + 110, cy = y + 112;
  const tr = EDGE.top + surf[SHAFT];
  const c0 = countAt(SHAFT, tr + 1), cE = countAt(SHAFT + 3, tr + 1), cS = max(0, c0 - 8);
  stroke(C.ink2); strokeWeight(1); noFill(); rect(cx - 7, cy - 7, 14, 14);
  const show = p > 0.16;
  // east arm
  stroke(show ? C.hit : C.muted); strokeWeight(6); if (p > 0.04) line(cx + 8, cy, cx + 8 + 44 * constrain((p - 0.04) / 0.1, 0, 1), cy);
  // south arm (drawn in the inset only)
  stroke(p > 0.24 ? C.probe : C.muted); if (p > 0.18) line(cx, cy + 8, cx, cy + 8 + 44 * constrain((p - 0.18) / 0.06, 0, 1));
  noStroke(); textFont(fontMono); textSize(12); fill(C.ink2); textAlign(CENTER, BASELINE);
  text(`shaft ${c0}`, cx, cy - 16);
  if (show) { fill(C.hit); textAlign(LEFT, BASELINE); text(`E ${cE}  ▲`, cx + 58, cy + 4); }
  if (p > 0.24) { fill(C.probe); textAlign(CENTER, BASELINE); text(`S ${cS}  ▼`, cx, cy + 70); }
  fill(C.ink2); textAlign(LEFT, BASELINE); textSize(12);
  const msg = p < 0.26 ? "Dig 3 blocks, probe, compare." : p < 0.42 ? "East rose: follow it." : p < 0.68 ? "Ore on the wall: mine it all." : "Back to the shaft, keep going.";
  text(msg, x + 190, y + 60, 170, 90);
  return y + h + 12;
}
function legendUnder(y) {
  if (y > PANEL.y + PANEL.h - 70) return;
  const x = PANEL.x;
  fill(C.panel); rect(x, y, PANEL.w, 60, 8);
  const items = [[C.ore, "copper ore"], [C.dug, "dug"], [C.probe, "probe cube"], [C.hit, "counts ore"]];
  textFont(fontMono); textSize(11.5); textAlign(LEFT, CENTER);
  items.forEach(([c, l], i) => {
    const xx = x + 18 + (i % 2) * 180, yy = y + 20 + floor(i / 2) * 22;
    fill(c); rect(xx, yy - 6, 12, 12, 2); fill(C.ink2); text(l, xx + 20, yy);
  });
}
function probeTick(g, pr, cnt) {
  const [x, y] = cellXY(g, pr.c, pr.r);
  fill(cnt > 0 ? C.hit : C.probe); noStroke(); rect(x + 4, y + 4, g.bs - 8, g.bs - 8, 2);
}

/* ======================================================================================
   Scene: next shaft (zoomed top view of the patch)
   ====================================================================================== */
function drawNext(si, p) {
  const Z = { x: VIEW.x + 132, y: VIEW.y, s: 536 };     // square view
  push(); noSmooth(); image(zoomImg, Z.x, Z.y, Z.s, Z.s); pop();
  noFill(); stroke(C.line); rect(Z.x, Z.y, Z.s, Z.s);
  const k = Z.s / ZOOM.span;
  const bx = x => Z.x + (x - ZOOM.cx + ZOOM.span / 2) * k, bz = z => Z.y + (z - ZOOM.cz + ZOOM.span / 2) * k;
  // scale bar
  noStroke(); fill(C.ink); rect(Z.x + 16, Z.y + Z.s - 22, 32 * k, 3);
  textFont(fontMono); textSize(11); textAlign(LEFT, BASELINE); text("32 blocks", Z.x + 16, Z.y + Z.s - 28);
  if (p > 0.5) { fill(C.hit); text("“decent” patch edge", Z.x + 110, Z.y + Z.s - 16); }

  const home = { x: ZOOM.cx, z: ZOOM.cz };
  const shaftMark = (x, z, col, cleared, label) => {
    const px = bx(x), pz = bz(z);
    if (cleared) { noStroke(); fill(241, 234, 217, 38); circle(px, pz, (13 + 18) * k); }
    noFill(); stroke(col); strokeWeight(1.5); rect(px - 6.5 * k, pz - 6.5 * k, 13 * k, 13 * k);
    noStroke(); fill(col); rect(px - 3, pz - 3, 6, 6);
    if (label) { fill(14, 13, 12, 220); textSize(11.5); const w = textWidth(label) + 12; rect(px + 10, pz - 26, w, 18, 4); fill(col); text(label, px + 16, pz - 13); }
  };
  // phase 1: first shaft and its cleared zone
  shaftMark(home.x, home.z, C.ink, true, p < 0.45 ? "shaft 1: probe cube + chased bodies" : null);
  // phase 2: too close
  if (p > 0.18 && p < 0.5) {
    const a = fadeIn(p, 0.18, 0.24);
    shaftMark(home.x + 13, home.z, color(229, 96, 79, 255 * a), false, "13 away: ~50% of the ore");
  }
  // phase 3: right spacing, then fill the patch
  if (p > 0.34) shaftMark(home.x + 32, home.z, C.good, true, p < 0.55 ? "32 away: ~98%" : null);
  let placed = 2;
  if (p > 0.55) {
    const q = ease((p - 0.55) / 0.35);
    const cells = [];
    for (let i = -14; i <= 14; i++) for (let j = -14; j <= 14; j++) {
      const x = home.x + i * 32, z = home.z + j * 32;
      if ((i === 0 && j === 0) || (i === 1 && j === 0)) continue;
      if (abs(x - ZOOM.cx) > ZOOM.span / 2 - 10 || abs(z - ZOOM.cz) > ZOOM.span / 2 - 10) continue;
      if (field(x, z) >= 4 / 15) cells.push([x, z, abs(i) + abs(j)]);
    }
    cells.sort((a, b) => a[2] - b[2]);
    const n = floor(cells.length * q);
    for (let t = 0; t < n; t++) shaftMark(cells[t][0], cells[t][1], C.good, true, null);
    placed += n;
  }
  // outline of the "decent" patch
  if (p > 0.5) {
    noStroke(); fill(255, 179, 71, 200 * fadeIn(p, 0.5, 0.56));
    for (let i = 0; i < 90; i++) for (let j = 0; j < 90; j++) {
      const x = ZOOM.cx - ZOOM.span / 2 + (i + 0.5) * ZOOM.span / 90, z = ZOOM.cz - ZOOM.span / 2 + (j + 0.5) * ZOOM.span / 90;
      const f = field(x, z) >= 4 / 15, fr = field(x + ZOOM.span / 90, z) >= 4 / 15, fd = field(x, z + ZOOM.span / 90) >= 4 / 15;
      if (f !== fr) rect(bx(x + ZOOM.span / 180) - 1, bz(z) - 3, 2, 6);
      if (f !== fd) rect(bx(x) - 3, bz(z + ZOOM.span / 180) - 1, 6, 2);
    }
  }
  let y = tally([["Shafts placed", `${placed}`], ["Spacing", "32 blocks", true]]);
  y = note(y, ["Share of a fresh shaft's ore a later", "shaft still gets (4×4 grids):", "  13 apart   48%", "  20 apart   79%", "  24 apart   90%", "  32 apart   98%"], "Too close wastes durability");
  note(y, ["Rule of thumb: 13 (probe cube) +", "width of a large deposit.", "Copper 32 · tin/zinc 24 · iron 64"], null);
}

/* ======================================================================================
   Scene: recipe card
   ====================================================================================== */
function drawRecipe(si, p) {
  drawSection(null, 70 + p * 20, 0.9, { x: 0, y: 0, w: VW, h: VH }, 26);
  const x = 80, y0 = 92;
  fill(C.ink); textFont(fontHead); textSize(40); textAlign(LEFT, BASELINE);
  text("The recipe", x, y0);
  fill(C.ink2); textFont(fontMono); textSize(13);
  text("Native copper, node search radius 6. Ore per 100 durability: your old method 25.3 → this 26.6+, and far more ore per trip.", x, y0 + 30);
  const steps = [
    ["Explore", "Density reading every ~100 blocks until one says “decent”."],
    ["Climb", "Compass readings 64 blocks out; step to the best while it improves."],
    ["Dig", "1×1 shaft straight down. Node search every 13 blocks. Count ladders."],
    ["Hit → find the top", "Halve up the dug shaft to the highest probe that counts; ore top is 6 below."],
    ["Chase", "Tunnel with floor 1 under the top. 3-block test arms E and S, follow the rising count, mine the body."],
    ["Give up", "After ~120 durability without ore. Back to the shaft and keep going down."],
    ["Stop", "At 112 ladders (copper) or 80 (tin, hematite). Climb out."],
    ["Next shaft", "32 blocks away (tin/zinc 24, iron 64). A good patch holds ~100 shafts."],
  ];
  steps.forEach(([h, t], i) => {
    const a = fadeIn(p, 0.04 + i * 0.07, 0.1 + i * 0.07);
    const yy = y0 + 84 + i * 56;
    fill(255, 179, 71, 255 * a); textFont(fontHead); textSize(22); textAlign(RIGHT, BASELINE); text(i + 1, x + 26, yy);
    fill(241, 234, 217, 255 * a); textSize(19); textAlign(LEFT, BASELINE); text(h, x + 46, yy);
    fill(185, 176, 159, 255 * a); textFont(fontMono); textSize(14); text(t, x + 290, yy);
  });
  fill(C.muted); textFont(fontMono); textSize(12); textAlign(LEFT, BASELINE);
  text("Worth knowing: side tunnels after a hit and stopping at the first deposit both lose ore per durability.", x, y0 + 84 + 8 * 56);
}
