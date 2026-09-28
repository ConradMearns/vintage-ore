/* Prospecting guide animation (p5.js), merged edition.
 *
 * One illustrative run of the plan the simulations picked for native copper at node-search radius 6.
 * Everything on screen is computed by world.js from the game's own rules; nothing is hand-placed except
 * where the ore bodies sit.
 *
 * Keys: space = play/pause, ←/→ = previous/next scene, 0-9 = jump to a scene, R = restart, L = loop,
 * +/- = speed. Merged from anim-sonnet (computed 3D counts, ledger, controls) and anim-opus (the labelled
 * 6-block edge rule, a patch filled with shafts, the "what loses ore" recipe card, looping, number keys).
 */
'use strict';

const W = 1280, H = 720;
const ST = { x: 24, y: 92, w: 860, h: 528 };      // the stage
const PN = { x: 904, y: 92, w: 352, h: 528 };     // the text panel
const CTRL = { x: 24, y: 640 };                   // play / restart / speed / loop
const TLN = { x: 216, y: 640, w: 1040 };          // scene chips + scrubber

const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';
const HEAD = '"Archivo", "IBM Plex Sans", system-ui, sans-serif';

const C = {
  bg: '#0e0f0e', panel: '#1a1a19', panel2: '#242523', ink: '#f2f1ec', ink2: '#c3c2b7', muted: '#898781',
  line: '#2c2c2a', rock: '#3a332c', void: '#141210', ore: '#e2853a', oreHi: '#ffc48a', good: '#3fb08a',
  probe: '#6da7ec', accent: '#eda100', grass: '#3f7a3a', loss: '#e5604f',
};
// none, very poor, poor, decent, high, very high, ultra high (the blue ramp from the report)
const WCOL = ['#5a5a56', '#2a62b0', '#3987e5', '#5aa0ee', '#86b6ef', '#b3d1f6', '#dcebfb'];

const { P, RUN, PATCH, WALK, CLIMB, START, MAP } = World;

// p5 wraps any font string that contains a space in one pair of quotes, which turns a normal CSS font stack
// ('"IBM Plex Sans", system-ui, sans-serif') into an invalid family name; the canvas then ignores it and every
// label stays at the default 12px. Re-apply the stack exactly as written.
(function fixFontStacks() {
  const R = p5.Renderer2D.prototype, orig = R._applyTextProperties;
  R._applyTextProperties = function () {
    const r = orig.apply(this, arguments);
    if (typeof this._textFont === 'string') this.drawingContext.font = (this._textStyle || 'normal') + ' ' + (this._textSize || 12) + 'px ' + this._textFont;
    return r;
  };
})();

/* ---------- small helpers ---------- */
const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const A = (hex, a) => { const c = color(hex); c.setAlpha(a * 255); return c; };
const fmt = n => Math.round(n).toLocaleString('en-US');

function T(s, x, y, size, colr, o) {
  o = o || {};
  push(); noStroke(); fill(colr || C.ink);
  textFont(o.font || FONT); textSize(size || 14); textStyle(o.bold ? BOLD : NORMAL);
  textAlign(o.align || LEFT, o.v || BASELINE); text(s, x, y); pop();
}
function wrap(s, x, y, w, size, lh, colr, o) {
  o = o || {};
  push(); noStroke(); fill(colr); textFont(o.font || FONT); textSize(size); textStyle(o.bold ? BOLD : NORMAL); textAlign(LEFT, BASELINE);
  let line = '';
  for (const wd of s.split(' ')) {
    const test = line ? line + ' ' + wd : wd;
    if (textWidth(test) > w && line) { text(line, x, y); y += lh; line = wd; } else line = test;
  }
  if (line) { text(line, x, y); y += lh; }
  pop();
  return y;
}
function pill(s, x, y, o) {
  o = o || {};
  push(); textFont(o.font || FONT); textSize(o.size || 12); textStyle(o.bold ? BOLD : NORMAL);
  const w = textWidth(s) + 16, h = (o.size || 12) + 10;
  const px = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  noStroke(); fill(o.bg || A('#0e0f0e', 0.82)); rect(px, y - h / 2, w, h, h / 2);
  if (o.border) { noFill(); stroke(o.border); strokeWeight(1); rect(px, y - h / 2, w, h, h / 2); }
  noStroke(); fill(o.color || C.ink); textAlign(LEFT, CENTER); text(s, px + 8, y + 0.5);
  pop();
  return w;
}
function dashed(on) { drawingContext.setLineDash(on ? [5, 4] : []); }
function clipStage() { drawingContext.save(); drawingContext.beginPath(); drawingContext.rect(ST.x, ST.y, ST.w, ST.h); drawingContext.clip(); }
function unclip() { drawingContext.restore(); }
function caption(main, sub) {
  const h = sub ? 56 : 40, y = ST.y + ST.h - h - 10;
  push(); noStroke(); fill(A('#0e0f0e', 0.86)); rect(ST.x + 10, y, ST.w - 20, h, 10);
  pop();
  T(main, ST.x + 26, y + (sub ? 24 : 26), 15, C.ink, { bold: true });
  if (sub) T(sub, ST.x + 26, y + 44, 13, C.ink2);
}
function ring(x, y, age, maxR, colr) {
  if (age < 0 || age > 1) return;
  push(); noFill(); stroke(A(colr, 1 - age)); strokeWeight(2); circle(x, y, 2 * maxR * easeOut(age)); pop();
}

/* ---------- prebuilt graphics ---------- */
let heat, terrainG, rockG;
const noise2 = World.valueNoise(3);

function heatColor(f) {
  const w = World.wordIndex(f);
  if (w === 0) return [0, 0, 0, 0];
  const c = color(WCOL[w]);
  return [red(c), green(c), blue(c), 60 + Math.min(1, f / 0.6) * 195];
}
function buildHeat() {
  const cell = 2, w = MAP.w / cell, h = MAP.h / cell;
  heat = createImage(w, h); heat.loadPixels();
  const d = heat.pixelDensity ? heat.pixelDensity() : 1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const f = World.density((i + 0.5) * cell, (j + 0.5) * cell), c = heatColor(f);
    for (let dj = 0; dj < d; dj++) for (let di = 0; di < d; di++) {
      const k = 4 * ((j * d + dj) * w * d + (i * d + di));
      heat.pixels[k] = c[0]; heat.pixels[k + 1] = c[1]; heat.pixels[k + 2] = c[2]; heat.pixels[k + 3] = c[3];
    }
  }
  heat.updatePixels();
}
function buildTerrain() {
  terrainG = createGraphics(ST.w, ST.h); terrainG.noStroke();
  const cs = 5;
  for (let y = 0; y < ST.h; y += cs) for (let x = 0; x < ST.w; x += cs) {
    const n = noise2(x / 90, y / 90) * 0.6 + noise2(x / 22, y / 22) * 0.4;
    terrainG.fill(22 + n * 22, 30 + n * 30, 22 + n * 14); terrainG.rect(x, y, cs, cs);
  }
}
// The side-on view scrolls with the player, so its rock is one tall texture: sky, then 130 blocks of depth.
const SKY_H = 300, SEC_PXB = 8, ROCK_H = SKY_H + 132 * SEC_PXB;
function buildRock() {
  rockG = createGraphics(ST.w, ROCK_H); rockG.noStroke();
  for (let y = 0; y < SKY_H; y += 4) { const u = y / SKY_H; rockG.fill(lerpColor(color('#16202b'), color('#2c4152'), u)); rockG.rect(0, y, ST.w, 4); }
  const cs = 4;
  for (let y = SKY_H; y < ROCK_H; y += cs) for (let x = 0; x < ST.w; x += cs) {
    const band = Math.floor((y - SKY_H) / (3.2 * SEC_PXB) + noise2(x / 140, y / 40) * 1.5);
    const n = noise2(x / 9, y / 9);
    const base = [58 + (band % 3) * 4, 51 + (band % 3) * 3, 44 + (band % 3) * 3];
    const k = 0.86 + n * 0.28;
    rockG.fill(base[0] * k, base[1] * k, base[2] * k); rockG.rect(x, y, cs, cs);
  }
  rockG.fill(C.grass); rockG.rect(0, SKY_H - 6, ST.w, 6);
  rockG.fill('#54402c'); rockG.rect(0, SKY_H, ST.w, 8);
}

/* ---------- geometry: section view (side-on) and plan view (from above) ---------- */
// cam = the depth at the vertical middle of the view; drawSection() sets it for the frame.
const SEC = { pxb: SEC_PXB, sx: ST.x + 230, yc: ST.y + 300, cam: 8 };
const secX = x => SEC.sx + x * SEC.pxb;
const secY = d => SEC.yc + (d - SEC.cam) * SEC.pxb;

const PL = { B: 21.5, ox: ST.x + 14 * 21.5, oy: ST.y + 12.3 * 21.5 };
const plX = x => PL.ox + x * PL.B;
const plY = z => PL.oy + z * PL.B;

const TD = { sc: 6.6, ox: ST.x + 20 * 6.6, oy: ST.y + 246 };
const tdX = x => TD.ox + x * TD.sc;
const tdY = z => TD.oy + z * TD.sc;

function footprint(body) {
  const m = new Map();
  for (const c of body.cells) {
    const k = c.x + ',' + c.z;
    if (!m.has(k)) m.set(k, { x: c.x, z: c.z, n: 0 });
    m.get(k).n++;
  }
  return [...m.values()];
}
const FOOT = { A: footprint(RUN.A), B: footprint(RUN.B) };

function oreColor(c, hi) {
  const n = noise2(c.x * 0.9 + c.z * 0.4, c.d * 0.9 + 3);
  if (hi) return n > 0.8 ? '#7be0b5' : n > 0.4 ? '#ffc48a' : '#ffa457';
  return n > 0.82 ? '#3fa583' : n > 0.45 ? '#e2853a' : '#b8622a';
}

/* ---------- section view ---------- */
function drawSection(o) {
  SEC.cam = o.cam == null ? 8 : o.cam;
  image(rockG, ST.x, secY(0) - SKY_H);
  // probe-spacing guides
  push(); stroke(A('#ffffff', 0.06)); strokeWeight(1);
  for (let d = P.probeStep; d <= P.stopDepth; d += P.probeStep) line(ST.x, secY(d), ST.x + ST.w, secY(d));
  pop();
  T('surface', ST.x + 12, secY(0) - 12, 11.5, C.muted, { font: MONO });

  // ore, drawn side-on; cells inside the current probe cube light up
  const cubeD = o.cube ? o.cube.d : null;
  noStroke();
  const hiCells = [];
  for (const b of RUN.bodies) {
    const mined = (b.id === 'A' && o.minedA) || (b.id === 'B' && o.minedB);
    for (const c of b.cells) {
      const x = secX(c.x - 0.5), y = secY(c.d);
      if (mined) { fill(C.void); rect(x, y, SEC.pxb + 0.4, SEC.pxb + 0.4); continue; }
      if (cubeD !== null && Math.abs(c.x) <= P.R && Math.abs(c.z) <= P.R && Math.abs(c.d - cubeD) <= P.R) { hiCells.push(c); continue; }
      fill(oreColor(c, false)); rect(x, y, SEC.pxb + 0.4, SEC.pxb + 0.4);
    }
  }
  for (const c of hiCells) { fill(oreColor(c, true)); rect(secX(c.x - 0.5), secY(c.d), SEC.pxb + 0.4, SEC.pxb + 0.4); }

  // dug tunnel band at the top of body A / B
  if (o.tunnel) {
    fill(C.void); rect(secX(-0.5), secY(o.tunnel.level - 1), (o.tunnel.len + 1) * SEC.pxb, 2 * SEC.pxb);
  }

  // the shaft with its ladders
  const dug = o.dug || 0;
  if (dug > 0) {
    const hw = SEC.pxb / 2, top = secY(0), bot = secY(dug);
    fill(C.void); rect(secX(0) - hw, top, SEC.pxb, bot - top);
    stroke(A('#c9a66b', 0.9)); strokeWeight(1.2);
    line(secX(0) - hw + 1.5, top, secX(0) - hw + 1.5, bot); line(secX(0) + hw - 1.5, top, secX(0) + hw - 1.5, bot);
    stroke(A('#c9a66b', 0.55));
    for (let d = Math.max(1, Math.floor(o.cam - 40)); d <= dug && d <= o.cam + 40; d += 1) line(secX(0) - hw + 1.5, secY(d), secX(0) + hw - 1.5, secY(d));
    noStroke();
  }

  // probe cubes
  for (const c of (o.ghosts || [])) {
    push(); noFill(); stroke(A(C.probe, c.a == null ? 0.22 : c.a)); strokeWeight(1);
    rect(secX(-6.5), secY(c.d - 6.5), 13 * SEC.pxb, 13 * SEC.pxb); pop();
  }
  if (o.cube) {
    const a = o.cube.a == null ? 1 : o.cube.a;
    push(); fill(A(C.probe, 0.10 * a)); stroke(A(C.probe, 0.95 * a)); strokeWeight(1.6);
    rect(secX(-6.5), secY(o.cube.d - 6.5), 13 * SEC.pxb, 13 * SEC.pxb); pop();
    ring(secX(0), secY(o.cube.d), o.cube.pulse == null ? 1 : o.cube.pulse, 26, C.probe);
    if (o.cube.label) {
      const ore = o.cube.c > 0, y = secY(o.cube.d);
      pill(o.cube.label, secX(7.6), y, { color: ore ? C.oreHi : C.ink2, bg: A('#0e0f0e', 0.88), border: ore ? C.ore : C.line, bold: ore });
    }
  }
  // results ruler
  // results ruler; labels that would touch their neighbour step further left
  let lastY = -1e9, shift = 0;
  for (const m of (o.marks || []).slice().sort((a, b) => a.d - b.d)) {
    const y = secY(m.d), ore = m.c > 0;
    shift = y - lastY < 12 ? shift + 30 : 0; lastY = y;
    push(); stroke(ore ? C.ore : C.muted); strokeWeight(1.5); fill(ore ? C.ore : A('#0e0f0e', 0.9)); circle(secX(-10), y, 8); pop();
    T(String(m.d), secX(-12) - shift, y + 4, 11, ore ? C.oreHi : C.muted, { font: MONO, align: RIGHT });
  }
  // guide lines across the view, labelled at the left edge
  for (const l of (o.lines || [])) {
    push(); stroke(l.color || C.accent); strokeWeight(l.w || 1.5); dashed(l.dash !== false);
    line(ST.x, secY(l.d), ST.x + ST.w, secY(l.d)); dashed(false); pop();
    if (l.text) pill(l.text, ST.x + 10, secY(l.d) - 13, { size: 12, bold: true, color: l.color || C.accent, bg: A('#0e0f0e', 0.88) });
  }
  if (o.band) {
    push(); noStroke(); fill(A(C.accent, 0.09)); rect(ST.x, secY(o.band[0]), ST.w, secY(o.band[1]) - secY(o.band[0])); pop();
  }
  // the edge-search rule drawn as a measurement: from the highest probe that counts down to the top of the ore
  if (o.brace) {
    const b = o.brace, bx = secX(18), y0 = secY(b.d0), y1 = secY(b.d1), a = b.a == null ? 1 : b.a;
    push(); stroke(A(C.accent, a)); strokeWeight(2); dashed(true);
    line(secX(0), y0, bx + 16, y0); dashed(false);
    line(bx - 8, y0, bx + 16, y0); line(bx - 8, y1, bx + 16, y1);
    line(bx, y0, bx, y1 - 5); noStroke(); fill(A(C.accent, a)); triangle(bx - 6, y1 - 10, bx + 6, y1 - 10, bx, y1 - 1); pop();
    pill(b.text, bx + 22, (y0 + y1) / 2, { size: 12.5, bold: true, color: C.accent, bg: A('#0e0f0e', 0.9 * a), border: C.accent });
  }
  // the player
  if (o.player != null) {
    const y = secY(o.player);
    push(); noStroke(); fill(A('#ffe9a8', 0.16)); circle(secX(0), y, 40);
    fill('#f3c96b'); circle(secX(0), y, 13); fill('#0e0f0e'); circle(secX(0) + 2, y - 1, 3.4); pop();
  }
  // ladder count, pinned to the top of the view so it stays readable while the camera follows the player
  if (o.ladders != null) {
    pill(o.ladders + ' ladders', secX(0) + 22, ST.y + 24, { size: 13, font: MONO, bold: true, color: C.ink, bg: A('#0e0f0e', 0.9) });
  }
}

/* ---------- plan view ---------- */
function drawPlanBase() {
  noStroke(); fill('#2a241f'); rect(ST.x, ST.y, ST.w, ST.h);
  push(); stroke(A('#ffffff', 0.045)); strokeWeight(1);
  for (let x = -14; x <= 26; x++) line(plX(x - 0.5), ST.y, plX(x - 0.5), ST.y + ST.h);
  for (let z = -12; z <= 12; z++) line(ST.x, plY(z - 0.5), ST.x + ST.w, plY(z - 0.5));
  pop();
  T('east →', ST.x + ST.w - 14, ST.y + 22, 12, C.muted, { font: MONO, align: RIGHT });
  T('north ↑', ST.x + 14, ST.y + 22, 12, C.muted, { font: MONO });
}
function drawFootprint(list, o) {
  o = o || {};
  const B = PL.B;
  noStroke();
  for (const f of list) {
    const gone = o.gone && o.gone.has(f.x + ',' + f.z);
    const x = plX(f.x - 0.5), y = plY(f.z - 0.5);
    if (gone) { fill(C.void); rect(x, y, B, B); continue; }
    const a = o.solid ? 1 : 0.30;
    const shade = f.n === 3 ? '#e2853a' : f.n === 2 ? '#c8722f' : '#a55d27';
    fill(A(shade, a)); rect(x + 0.5, y + 0.5, B - 1, B - 1, 2);
    if (o.marks && o.marks.has(f.x + ',' + f.z)) { fill(A('#ffc48a', 0.55)); rect(x + 0.5, y + 0.5, B - 1, B - 1, 2); }
  }
}
function drawCube(x, z, a, label, ore) {
  push(); fill(A(C.probe, 0.07 * a)); stroke(A(C.probe, 0.9 * a)); strokeWeight(1.6);
  rect(plX(x - 6.5), plY(z - 6.5), 13 * PL.B, 13 * PL.B); pop();
  if (label) pill(label, plX(x + 6.5) + 8, plY(z - 6.5) + 12, { color: ore ? C.oreHi : C.ink2, border: ore ? C.ore : C.line, bold: ore });
}
function drawTunnel(cells) {
  noStroke(); fill(C.void);
  for (const c of cells) rect(plX(c.x - 0.5), plY(c.z - 0.5), PL.B, PL.B);
}
function drawShaftCell() {
  noStroke(); fill(C.void); rect(plX(-0.5), plY(-0.5), PL.B, PL.B);
  stroke('#c9a66b'); strokeWeight(1.5); noFill(); rect(plX(-0.5) + 3, plY(-0.5) + 3, PL.B - 6, PL.B - 6); noStroke();
}
function drawPlayerPlan(x, z) {
  push(); noStroke(); fill(A('#ffe9a8', 0.16)); circle(plX(x), plY(z), 40);
  fill('#f3c96b'); circle(plX(x), plY(z), 14); pop();
}

/* ---------- panel, HUD, timeline ---------- */
function drawHud(S, t, i) {
  T('Copper prospecting, start to finish', 24, 40, 24, C.ink, { font: HEAD, bold: true });
  T('Node search radius 6 · one illustrative run of the plan from three simulated 4096² worlds', 24, 64, 13, C.muted);
  const st = S.stats(t);
  const blocks = [['DURABILITY SPENT', fmt(st[0])], ['ORE BLOCKS MINED', fmt(st[1])], ['LADDERS', st[2] == null ? '-' : String(Math.round(st[2]))]];
  blocks.forEach(([k, v], n) => {
    const x = 760 + n * 166;
    T(k, x, 30, 10.5, C.muted, { font: MONO });
    T(v, x, 62, 30, n === 1 ? C.oreHi : C.ink, { font: HEAD, bold: true });
  });
}
function drawPanel(S, i) {
  push(); noStroke(); fill(C.panel); rect(PN.x, PN.y, PN.w, PN.h, 12); pop();
  let y = PN.y + 34;
  if (S.step) {
    push(); noStroke(); fill(C.ore); circle(PN.x + 32, y - 4, 30); pop();
    T(String(S.step), PN.x + 32, y + 1, 17, '#1a1208', { font: HEAD, bold: true, align: CENTER });
    T('STEP ' + S.step + ' OF 8', PN.x + 58, y, 11, C.muted, { font: MONO });
  } else {
    T(S.kicker || '', PN.x + 20, y, 11, C.muted, { font: MONO });
  }
  y += 34;
  y = wrap(S.title, PN.x + 20, y, PN.w - 40, 24, 28, C.ink, { font: HEAD, bold: true });
  y += 10;
  for (const p of S.paras) y = wrap(p, PN.x + 20, y, PN.w - 40, 14.5, 21, C.ink2) + 8;
  if (S.rule) {
    const lines = Math.ceil(S.rule.length / 34), h = 30 + lines * 20;
    const ry = PN.y + PN.h - h - 18;
    push(); noStroke(); fill(C.panel2); rect(PN.x + 16, ry, PN.w - 32, h, 8); fill(C.ore); rect(PN.x + 16, ry, 4, h, 4, 0, 0, 4); pop();
    T('THE RULE', PN.x + 32, ry + 22, 10.5, C.muted, { font: MONO });
    wrap(S.rule, PN.x + 32, ry + 42, PN.w - 64, 14, 20, C.ink, { bold: true });
  }
}
let chips = [];
// one table drives both drawing and hit-testing
const BTNS = [{ id: 'play', x: 24, w: 40 }, { id: 'restart', x: 70, w: 40 }, { id: 'speed', x: 116, w: 40 }, { id: 'loop', x: 162, w: 40 }];
const btnLabel = id => id === 'play' ? (playing ? 'II' : '>') : id === 'restart' ? 'R' : id === 'speed' ? speed + 'x' : 'L';
const btnOn = id => id === 'play' ? playing : id === 'loop' ? loopOn : false;
function drawTimeline(cur, t) {
  // controls
  const by = CTRL.y + 16;
  for (const b of BTNS) {
    push(); noStroke(); fill(btnOn(b.id) ? C.ore : C.panel); rect(b.x, CTRL.y, b.w, 32, 8); pop();
    T(btnLabel(b.id), b.x + b.w / 2, by + 5, 13, btnOn(b.id) ? '#1a1208' : C.ink, { align: CENTER, font: MONO, bold: true });
  }
  chips = [];
  const n = SCENES.length, gap = 4, cw = (TLN.w - gap * (n - 1)) / n;
  SCENES.forEach((S, k) => {
    const x = TLN.x + k * (cw + gap);
    chips.push({ x, y: TLN.y, w: cw, h: 32, k });
    const past = k < cur, on = k === cur;
    push(); noStroke(); fill(on ? C.ore : past ? '#3a2d20' : C.panel); rect(x, TLN.y, cw, 32, 8); pop();
    T(S.chip, x + cw / 2, by + 5, 12, on ? '#1a1208' : past ? C.oreHi : C.ink2, { align: CENTER, bold: on });
  });
  // scrubber
  const sy = 690;
  push(); noStroke(); fill(C.line); rect(TLN.x, sy, TLN.w, 4, 2);
  const px = TLN.x + TLN.w * clamp01(clock / total);
  fill(C.ore); rect(TLN.x, sy, px - TLN.x, 4, 2);
  fill(C.ink); circle(px, sy + 2, 12);
  pop();
  T(clockText(clock) + ' / ' + clockText(total), CTRL.x, sy + 8, 12, C.muted, { font: MONO });
}
const clockText = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

/* ---------- ledger (durability and ore, by scene) ---------- */
const LG = RUN.ledger;
const K1 = WALK.readings.length, K2 = CLIMB.readings;
const D_AFTER = {};
D_AFTER.s1 = P.readingCost * K1;
D_AFTER.s2 = D_AFTER.s1 + P.readingCost * K2;
D_AFTER.s3 = D_AFTER.s2 + LG.dig1 + LG.probes1;
D_AFTER.s4 = D_AFTER.s3 + LG.edgeA;
D_AFTER.s5 = D_AFTER.s4 + LG.chaseA;
D_AFTER.s6 = D_AFTER.s5 + LG.mineA;
D_AFTER.s7 = D_AFTER.s6 + LG.down1 + LG.edgeB + LG.chaseB + LG.mineB + LG.down2;

/* ---------- scenes ---------- */
let SCENES = [], starts = [], total = 0;

function icon(n, cx, cy, s) {
  push(); translate(cx, cy); noFill(); strokeWeight(2); stroke(C.ink2); strokeCap(ROUND);
  if (n === 1) { for (let i = 0; i < 5; i++) { fill(WCOL[Math.min(6, i + 1)]); noStroke(); circle(-s + i * s / 2, s / 2 - i * s / 4, 7); } }
  if (n === 2) { for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { line(0, 0, dx * s * 0.8, dy * s * 0.8); } fill(C.ore); noStroke(); circle(0, 0, 9); }
  if (n === 3) { line(0, -s, 0, s); for (let i = -1; i <= 1; i++) { stroke(A(C.probe, 0.9)); rect(-s * 0.35, i * s * 0.55 - s * 0.27, s * 0.7, s * 0.55); } }
  if (n === 4) { stroke(C.accent); line(-s, -s * 0.4, s, -s * 0.4); line(-s, s * 0.4, s, s * 0.4); stroke(C.ink2); line(0, -s * 0.4, 0, s * 0.4); fill(C.ore); noStroke(); rect(-s * 0.6, s * 0.4, s * 1.2, s * 0.25, 3); }
  if (n === 5) { stroke(C.ink2); line(-s, -s * 0.5, 0, -s * 0.5); line(0, -s * 0.5, 0, s * 0.5); line(0, s * 0.5, s, s * 0.5); fill(C.ore); noStroke(); triangle(s, s * 0.5 - 6, s, s * 0.5 + 6, s + 10, s * 0.5); }
  if (n === 6) { noStroke(); fill(C.ore); ellipse(0, 0, s * 1.8, s * 1.1); stroke(C.void); dashed(true); line(-s * 0.7, 0, s * 0.7, 0); dashed(false); }
  if (n === 7) { stroke('#c9a66b'); line(-3, -s, -3, s); line(3, -s, 3, s); for (let i = -s; i < s; i += 6) line(-3, i, 3, i); stroke(C.accent); line(-s, s, s, s); noStroke(); fill(C.ink2); textAlign(CENTER); textSize(11); textFont(MONO); text('112', s * 0.85, s - 6); }
  if (n === 8) { stroke(C.ink2); rect(-s - 4, -6, 10, 12); rect(s - 6, -6, 10, 12); stroke(C.accent); line(-s + 8, 0, s - 8, 0); line(s - 14, -4, s - 8, 0); line(s - 14, 4, s - 8, 0); }
  pop();
}

function buildScenes() {
  const S = [];

  /* ===== 0. overview ===== */
  {
    const items = [
      ['Read every ~100 blocks', 'until the pick says “decent”'],
      ['Climb', 'compass readings 64 out'],
      ['Dig, probe every 13', 'radius-6 cubes just touch'],
      ['Edge search', 'find the top of the ore'],
      ['Tunnel to the count', '3 blocks at a time'],
      ['Mine the body', 'then probe again'],
      ['Dig on to 112 ladders', 'same routine at each hit'],
      ['Next shaft 32 away', 'and keep going'],
    ];
    S.push({
      chip: 'Overview', kicker: 'THE PLAN', title: 'How to prospect native copper',
      paras: ['This is the plan the simulations settled on. They dug 49,152 shafts per strategy across three generated worlds of 4096×4096 blocks, and scored each in ore per point of tool durability.',
        'The animation follows one run of it, start to finish. Every reading, count and tunnel you see is computed from the same rules the simulations used.'],
      rule: null, dur: 9.5, noFade: true,
      stats: () => [0, 0, null],
      draw(t) {
        noStroke(); fill(C.panel); rect(ST.x, ST.y, ST.w, ST.h, 12);
        T('The plan, in eight steps', ST.x + 28, ST.y + 44, 22, C.ink, { font: HEAD, bold: true });
        const cw = 188, ch = 200, gx = 16, x0 = ST.x + 28, y0 = ST.y + 76;
        items.forEach(([a, b], n) => {
          const u = ease(seg(t, 0.5 + n * 0.5, 1.1 + n * 0.5));
          const col = n % 4, row = Math.floor(n / 4);
          const x = x0 + col * (cw + gx), y = y0 + row * (ch + 22) + (1 - u) * 18;
          push(); noStroke(); fill(A(C.panel2, u)); rect(x, y, cw, ch, 12); pop();
          push(); noStroke(); fill(A(C.ore, u)); circle(x + 26, y + 28, 30); pop();
          T(String(n + 1), x + 26, y + 34, 17, A('#1a1208', u), { font: HEAD, bold: true, align: CENTER });
          push(); drawingContext.globalAlpha = u; icon(n + 1, x + cw / 2, y + 96, 30); drawingContext.globalAlpha = 1; pop();
          push(); drawingContext.globalAlpha = u;
          T(a, x + 16, y + 158, 14, C.ink, { bold: true }); T(b, x + 16, y + 180, 12.5, C.ink2);
          drawingContext.globalAlpha = 1; pop();
        });
      },
    });
  }

  /* ===== 1. explore ===== */
  {
    const R = WALK.readings, K = R.length, T0 = 1.4, DT = 0.9, TL = T0 + (K - 1) * DT;
    const heatA = TL + 1.4, heatB = TL + 3.4, dur = TL + 4.8, sc = ST.w / MAP.w;
    const sx = x => ST.x + x * sc, sy = y => ST.y + y * sc;
    S.push({
      chip: '1 Explore', step: 1, title: 'Read every ~100 blocks',
      paras: ['Walk in a straight line and take a density reading about every 100 blocks. Each one costs 3 durability.',
        'Patches of copper are hundreds of blocks across, so sparse readings find one almost as fast as dense ones, for a fraction of the durability. Reading every 16 blocks would cost five times as much.',
        'On average it takes about 1,340 blocks and 19 readings to reach a “decent” reading.'],
      rule: 'Read every ~100 blocks until the pick says “decent”.', dur,
      stats: t => [P.readingCost * R.filter((r, k) => t >= T0 + k * DT).length, 0, null],
      draw(t) {
        image(terrainG, ST.x, ST.y);
        const h = ease(seg(t, heatA, heatB));
        if (h > 0) { push(); tint(255, 255 * 0.62 * h); image(heat, ST.x, ST.y, MAP.w * sc, MAP.h * sc); pop(); }
        // scale bar
        push(); stroke(C.ink2); strokeWeight(2); line(ST.x + 22, ST.y + ST.h - 24, ST.x + 22 + 200 * sc, ST.y + ST.h - 24); pop();
        T('200 blocks', ST.x + 22, ST.y + ST.h - 32, 11.5, C.ink2, { font: MONO });
        // path and readings
        const u = clamp01((t - T0) / DT) + Math.min(K - 1, Math.max(0, Math.floor((t - T0) / DT)));
        const uu = Math.max(0, Math.min(K - 1, (t - T0) / DT));
        push(); stroke(A('#ffffff', 0.35)); strokeWeight(1.5); dashed(true);
        line(sx(START.x), sy(START.y), sx(START.x + WALK.dir.x * P.readEvery * uu), sy(START.y + WALK.dir.y * P.readEvery * uu)); dashed(false); pop();
        R.forEach((r, k) => {
          const tk = T0 + k * DT;
          if (t < tk) return;
          const x = sx(r.x), y = sy(r.y), last = k === K - 1;
          ring(x, y, (t - tk) / 1.1, 30, WCOL[Math.max(1, r.w)]);
          push(); stroke('#0e0f0e'); strokeWeight(2); fill(WCOL[r.w]); circle(x, y, last ? 16 : 11); pop();
          const up = k % 2 === 0;
          T(World.WORDS[r.w] === 'none' ? 'nothing' : World.WORDS[r.w], x, up ? y - 14 : y + 24, 11.5, r.w === 0 ? C.muted : C.ink, { align: CENTER, font: MONO });
        });
        // the walker
        const wx = sx(START.x + WALK.dir.x * P.readEvery * uu), wy = sy(START.y + WALK.dir.y * P.readEvery * uu);
        push(); noStroke(); fill(A('#ffe9a8', 0.16)); circle(wx, wy, 34); fill('#f3c96b'); circle(wx, wy, 11); pop();
        T('start', sx(START.x), sy(START.y) + 26, 11.5, C.muted, { align: CENTER, font: MONO });
        if (t < TL - 0.2) {
          const seen = R.filter((r, k) => t >= T0 + k * DT), lastW = seen.length ? seen[seen.length - 1].w : 0, best = seen.reduce((m, r) => Math.max(m, r.w), 0);
          caption('Reading ' + Math.max(1, Math.min(K, seen.length)) + ' of ' + K + (t < T0 ? '' : ': ' + (lastW === 0 ? 'nothing here' : World.WORDS[lastW])),
            best === 0 ? 'Nothing yet. Keep walking; each reading costs 3 durability.' : 'A trace of copper. Keep going until the word reaches “decent”.');
        }
        else if (t < heatA) caption('“Decent”: a patch is here.', 'Total walked: ' + fmt((K - 1) * P.readEvery) + ' blocks, ' + K + ' readings, ' + P.readingCost * K + ' durability.');
        else caption('This is the patch the readings were pointing at.', 'You could not see it; the pick only answers at the spot you stand on. Now climb to its centre.');
      },
    });
  }

  /* ===== 2. climb ===== */
  {
    const steps = CLIMB.steps, NS = steps.length, T0 = 1.6, PER = 0.45, HOLD = 0.35, MOVE = 0.9, STEP = 4 * PER + HOLD + MOVE;
    const dur = T0 + NS * STEP + 2.8;
    const fromMap = { sc: ST.w / MAP.w, cx: MAP.w / 2, cy: MAP.h / 2 };
    const end = CLIMB.end, mid = { x: (WALK.readings[K1 - 1].x + end.x) / 2, y: (WALK.readings[K1 - 1].y + end.y) / 2 };
    const toView = { sc: 1.7, cx: mid.x, cy: mid.y };
    const view = t => { const u = ease(seg(t, 0, T0)); return { sc: lerp(fromMap.sc, toView.sc, u), cx: lerp(fromMap.cx, toView.cx, u), cy: lerp(fromMap.cy, toView.cy, u) }; };
    const posAt = t => {
      let p = { x: steps[0].from.x, y: steps[0].from.y };
      steps.forEach((s, j) => { const t1 = T0 + j * STEP + 4 * PER + HOLD; if (s.moved && t > t1) { const u = ease(seg(t, t1, t1 + MOVE)); p = { x: lerp(s.from.x, s.best.x, u), y: lerp(s.from.y, s.best.y, u) }; } });
      return p;
    };
    const readsSoFar = t => steps.reduce((n, s, j) => n + Math.max(0, Math.min(4, Math.floor((t - (T0 + j * STEP)) / PER) + 1)), 0);
    S.push({
      chip: '2 Climb', step: 2, title: 'Climb to the centre',
      paras: ['From the “decent” spot, take four compass readings 64 blocks out: north, east, south, west. Step to the best one and repeat.',
        'Stop when no direction beats where you stand. That costs about 12 readings (36 durability) and ends on “high” or better 92% of the time.'],
      rule: 'Step to the best compass reading. Stop when none is better.', dur, noFade: true,
      stats: t => [D_AFTER.s1 + P.readingCost * readsSoFar(t), 0, null],
      draw(t) {
        const v = view(t);
        const X = x => ST.x + ST.w / 2 + (x - v.cx) * v.sc, Y = y => ST.y + ST.h / 2 + (y - v.cy) * v.sc;
        image(terrainG, ST.x, ST.y); noStroke(); fill(A('#0e0f0e', 0));
        push(); tint(255, 255 * 0.62); image(heat, X(0), Y(0), MAP.w * v.sc, MAP.h * v.sc); pop();
        // trail
        push(); stroke(A('#ffffff', 0.4)); strokeWeight(1.5); dashed(true);
        let last = { x: WALK.readings[K1 - 1].x, y: WALK.readings[K1 - 1].y };
        beginShape(); noFill(); vertex(X(last.x), Y(last.y));
        steps.forEach((s, j) => { const t1 = T0 + j * STEP + 4 * PER + HOLD; if (s.moved && t > t1) { const u = ease(seg(t, t1, t1 + MOVE)); vertex(X(lerp(s.from.x, s.best.x, u)), Y(lerp(s.from.y, s.best.y, u))); } });
        endShape(); dashed(false); pop();
        // readings
        steps.forEach((s, j) => {
          const tj = T0 + j * STEP, active = t >= tj && t < tj + STEP;
          const fade = t < tj + 4 * PER + HOLD + MOVE ? 1 : 0.28;
          if (t < tj) return;
          s.nb.forEach((n, i) => {
            const tk = tj + i * PER;
            if (t < tk) return;
            const x = X(n.x), y = Y(n.y), isBest = s.best === n && s.moved;
            push(); stroke('#0e0f0e'); strokeWeight(2); drawingContext.globalAlpha = fade; fill(WCOL[n.w]); circle(x, y, 13);
            if (isBest && t > tj + 4 * PER) { noFill(); stroke(C.accent); strokeWeight(2.5); circle(x, y, 26); }
            drawingContext.globalAlpha = 1; pop();
            if (fade === 1 || i === 0) T(World.WORDS[n.w], x, y + (n.name === 'N' ? -16 : 26), 12, C.ink, { align: CENTER, font: MONO });
            push(); stroke(A('#ffffff', 0.25 * fade)); strokeWeight(1); line(X(s.from.x), Y(s.from.y), x, Y(n.y)); pop();
          });
        });
        const p = posAt(t);
        push(); noStroke(); fill(A('#ffe9a8', 0.16)); circle(X(p.x), Y(p.y), 40); fill('#f3c96b'); circle(X(p.x), Y(p.y), 13); pop();
        // caption
        const j = Math.floor((t - T0) / STEP);
        if (t < T0) caption('Zooming in on the patch', null);
        else if (t >= T0 + NS * STEP) caption('No direction is better: stop here.', 'You read “' + World.WORDS[end.w] + '” (' + K2 + ' readings, ' + P.readingCost * K2 + ' durability). This is where the first shaft goes.');
        else {
          const s = steps[Math.max(0, Math.min(NS - 1, j))];
          const inStep = t - (T0 + Math.max(0, j) * STEP);
          caption(inStep < 4 * PER ? 'Compass readings, 64 blocks out' : s.moved ? 'Step toward the best: “' + World.WORDS[s.best.w] + '”' : 'Nothing beats the spot you stand on',
            'Round ' + (Math.max(0, j) + 1) + ' of ' + NS + '. Each reading costs 3 durability.');
        }
      },
    });
  }

  /* ===== 3. dig and probe ===== */
  {
    const list = RUN.shaftProbes.filter(d => d <= RUN.firstHit);
    const segs = []; let t = 0.9, prev = 0;
    list.forEach(d => {
      segs.push({ k: 'dig', t0: t, t1: t + 1.15, from: prev, to: d }); t += 1.15;
      segs.push({ k: 'probe', t0: t, t1: t + 1.15, d, c: World.count(RUN.cells, 0, 0, d) }); t += 1.15; prev = d;
    });
    const dur = t + 3.0;
    const state = tt => {
      let dug = 0, player = 0, done = [], active = null;
      for (const s of segs) {
        if (tt < s.t0) break;
        if (s.k === 'dig') { dug = player = lerp(s.from, s.to, ease(seg(tt, s.t0, s.t1))); }
        else {
          dug = player = s.d;
          if (tt >= s.t0 + 0.55) done.push({ d: s.d, c: s.c });
          if (tt < s.t1 + 0.0 || s === segs[segs.length - 1]) active = { d: s.d, c: s.c, u: seg(tt, s.t0, s.t0 + 0.9), reveal: tt >= s.t0 + 0.55, last: s === segs[segs.length - 1] };
        }
      }
      return { dug, player, done, active };
    };
    const probesStarted = tt => segs.filter(s => s.k === 'probe' && tt >= s.t0).length;
    S.push({
      chip: '3 Dig', step: 3, title: 'Dig, probing every 13',
      paras: ['Dig a straight shaft, one block wide, with a ladder in every block. Every 13 blocks, do a node search.',
        'At radius 6 the pick counts every ore block in a 13×13×13 cube around you. Cubes 13 apart just touch, so no depth goes unchecked, with half as many probes as probing every 6.',
        'Copper sits between about 50 and 110 blocks down, so you will not see ore for a while. The game answers in words: trace, small, medium, large.'],
      rule: 'Node search every 13 blocks. Count your ladders.', dur,
      stats: tt => { const s = state(tt); return [D_AFTER.s2 + Math.floor(s.dug) + P.probeCost * probesStarted(tt), 0, s.player]; },
      draw(tt) {
        const s = state(tt);
        const ghosts = s.done.filter(p => !s.active || p.d !== s.active.d).map(p => ({ d: p.d, a: 0.2 }));
        const cube = s.active ? { d: s.active.d, a: 1, pulse: s.active.u, label: s.active.reveal ? World.bucket(s.active.c).label : null, c: s.active.c } : null;
        drawSection({ cam: Math.max(8, s.player), dug: s.dug, player: s.player, ladders: Math.round(s.dug), ghosts, cube, marks: s.done.filter(p => !s.active || p.d !== s.active.d || s.active.reveal) });
        const hit = s.active && s.active.last && tt > segs[segs.length - 1].t1;
        if (hit) caption(World.bucket(s.active.c).label + ': ore is within 6 blocks. But where, and how high?', 'The pick only counts; it does not point. Next: pin down the height with an edge search.');
        else if (s.active) caption(s.active.reveal ? (s.active.c > 0 ? World.bucket(s.active.c).label : 'No ore nearby') : 'Node search, radius 6', 'Probe at ' + s.active.d + ' blocks down · costs 2 durability');
        else caption('Digging down', Math.round(s.dug) + ' ladders so far · 1 durability per block');
      },
    });
  }

  /* ===== 4. edge search ===== */
  {
    const E = RUN.edgeA, hit = RUN.firstHit, empty = E.emptyAbove;
    const segs = []; let t = 2.4, prev = hit;
    E.probes.forEach(p => {
      segs.push({ k: 'move', t0: t, t1: t + 0.55, from: prev, to: p.d }); t += 0.55;
      segs.push({ k: 'probe', t0: t, t1: t + 1.15, p }); t += 1.15; prev = p.d;
    });
    const tRes = t, tDig = t + 3.0, dur = tDig + 2.2 + 1.0;
    const state = tt => {
      let player = hit, lo = empty, hi = hit, active = null, done = [];
      for (const s of segs) {
        if (tt < s.t0) break;
        if (s.k === 'move') player = lerp(s.from, s.to, ease(seg(tt, s.t0, s.t1)));
        else {
          player = s.p.d;
          if (tt >= s.t0 + 0.55) { done.push(s.p); if (s.p.c > 0) hi = s.p.d; else lo = s.p.d; }
          if (tt < s.t1) active = { p: s.p, u: seg(tt, s.t0, s.t0 + 0.9), reveal: tt >= s.t0 + 0.55 };
        }
      }
      let dug = hit;
      if (tt > tDig) { const u = ease(seg(tt, tDig, tDig + 2.2)); player = lerp(E.highest, RUN.levelA, u); dug = lerp(hit, RUN.levelA, u); }
      else if (tt > tRes) player = E.highest;
      return { player, lo, hi, active, done, dug };
    };
    S.push({
      chip: '4 Edge', step: 4, title: 'Edge search: find the top',
      paras: ['The cube is a hard box: a probe sees ore only within 6 blocks above or below. So the highest probe that still counts ore sits exactly 6 blocks above the top of the deposit.',
        'Climb back up your own shaft, halving the gap between the last empty probe (' + empty + ') and the hit (' + hit + '). Four probes: ' + E.probes.map(p => p.d).join(', ') + '. Only “any ore or none” matters, so the game’s word buckets do not get in the way.',
        'Dig back down so a 2-high tunnel’s floor sits one block under the top.'],
      rule: 'Top of the ore = the highest probe with ore, plus 6.', dur,
      stats: tt => { const s = state(tt); const pr = segs.filter(x => x.k === 'probe' && tt >= x.t0).length; return [D_AFTER.s3 + P.probeCost * pr + Math.max(0, Math.round(s.dug - hit)), 0, s.player]; },
      draw(tt) {
        const s = state(tt);
        const ghosts = [{ d: empty, a: 0.22 }, { d: hit, a: 0.22 }];
        const cube = s.active ? { d: s.active.p.d, pulse: s.active.u, c: s.active.p.c, label: s.active.reveal ? (s.active.p.c > 0 ? 'Trace: ore!' : 'No ore nearby') : null } : null;
        const marks = [{ d: empty, c: 0 }, { d: hit, c: RUN.hitCount }, ...s.done];
        const lines = tt < tRes ? [{ d: s.lo, text: 'last empty: ' + s.lo, color: C.muted }, { d: s.hi, text: 'ore at: ' + s.hi, color: C.accent }] : [];
        if (tt >= tRes) lines.push({ d: E.top, text: 'top = ' + E.highest + ' + ' + P.R + ' = ' + E.top, color: C.accent, dash: false, w: 2 });
        drawSection({ cam: 50, dug: s.dug, player: s.player, ladders: Math.round(s.dug), ghosts, cube, marks, lines,
                      band: tt < tRes ? [s.lo, s.hi] : null, tunnel: tt > tDig + 1.9 ? { level: RUN.levelA, len: 0 } : null,
                      brace: tt >= tRes ? { d0: E.highest, d1: E.top, text: P.R + ' blocks', a: ease(seg(tt, tRes, tRes + 0.6)) } : null });
        if (tt < 2.4) caption('Ore is between ' + empty + ' and ' + hit + ' blocks down (in reach)', 'The last empty probe was ' + P.probeStep + ' above the hit. The top is somewhere near.');
        else if (tt < tRes) caption(cube ? (s.active.reveal ? (s.active.p.c > 0 ? 'Ore at ' + s.active.p.d + ': go shallower' : 'Empty at ' + s.active.p.d + ': go deeper') : 'Probe at ' + s.active.p.d) : 'Halve the gap', 'Between ' + s.lo + ' (empty) and ' + s.hi + ' (ore). Each probe costs 2.');
        else if (tt < tDig) caption('Highest probe with ore: ' + E.highest + '. Top of the deposit: ' + E.top + '.', 'A probe reaches 6 blocks down, so the deposit begins 6 below the highest probe that still counts it.');
        else caption('Dig down to ' + RUN.levelA + ': the tunnel will use layers ' + (RUN.levelA - 1) + ' and ' + RUN.levelA + '.', 'Floor one block under the top, so the tunnel runs through the thickest part.');
      },
    });
  }

  /* ===== 5. tunnel to the count ===== */
  {
    const C5 = RUN.chaseA, lvl = RUN.levelA;
    const t0 = 2.4, tE0 = t0, tE1 = tE0 + 1.8, tEp = tE1 + 1.3, tS0 = tEp + 0.3, tS1 = tS0 + 1.8, tSp = tS1 + 1.3;
    const tDec = tSp + 0.4, tF0 = tDec + 3.0, tF1 = tF0 + 2.2, dur = tF1 + 3.0;
    const armSteps = (tt, a, b, n) => Math.floor(ease(seg(tt, a, b)) * n + 0.0001);
    const state = tt => {
      const tunnel = [];
      const e = armSteps(tt, tE0, tE1, C5.armE.length); for (let i = 0; i < e; i++) tunnel.push(C5.armE[i]);
      const s = armSteps(tt, tS0, tS1, C5.armS.length); for (let i = 0; i < s; i++) tunnel.push(C5.armS[i]);
      const f = armSteps(tt, tF0, tF1, C5.follow.length); for (let i = 0; i < f; i++) tunnel.push(C5.follow[i]);
      let pos = { x: 0, z: 0 };
      if (tt < tE1) { const u = ease(seg(tt, tE0, tE1)); pos = { x: u * P.arm, z: 0 }; }
      else if (tt < tS0) pos = { x: P.arm, z: 0 };
      else if (tt < tS1) { const u = ease(seg(tt, tS0, tS1)); pos = { x: 0, z: u * P.arm }; }
      else if (tt < tF0) pos = { x: 0, z: 0 };
      else { const u = ease(seg(tt, tF0, tF1)); pos = { x: lerp(P.arm, C5.follow[C5.follow.length - 1].x, u), z: 0 }; }
      const cost = 2 * (e + s + f) + P.probeCost * ((tt >= tEp ? 1 : 0) + (tt >= tSp ? 1 : 0));
      return { tunnel, pos, cost };
    };
    S.push({
      chip: '5 Tunnel', step: 5, title: 'Tunnel toward the count',
      paras: ['From the shaft, dig a 3-block tunnel east and one south, probing at each end. Head along the axis whose count changed most: toward it if it rose, away if it fell.',
        'Keep tunnelling 3 blocks at a time. Stop probing the moment you see ore in a tunnel wall. Give up after 120 durability without a find.',
        'The game reports counts as words, so watch for the word to change (small to large here).'],
      rule: 'Follow the count. Stop when you see ore. Give up at 120.', dur,
      stats: tt => [D_AFTER.s4 + state(tt).cost, 0, RUN.levelA],
      draw(tt) {
        const s = state(tt);
        drawPlanBase();
        drawFootprint(FOOT.A, { solid: false });
        // x-ray label
        pill('x-ray: the hidden ore body (you cannot see this)', ST.x + ST.w - 14, ST.y + 46, { align: 'right', color: C.oreHi, size: 11.5, border: C.ore });
        drawTunnel(s.tunnel);
        drawShaftCell();
        // cubes and results
        if (tt < tE0) drawCube(0, 0, 1, World.bucket(C5.c0).label, true);
        if (tt >= tEp && tt < tS1 + 0.3) drawCube(P.arm, 0, 1, World.bucket(C5.cE).label, true);
        if (tt >= tSp && tt < tF0) drawCube(0, P.arm, 1, World.bucket(C5.cS).label, C5.cS > 0);
        if (tt >= tF0 + 1.6) {
          const sn = C5.seenAt; const marks = new Set();
          for (const f of FOOT.A) if (Math.abs(f.x - sn.x) + Math.abs(f.z - sn.z) <= 1) marks.add(f.x + ',' + f.z);
          drawFootprint(FOOT.A.filter(f => marks.has(f.x + ',' + f.z)), { solid: true });
          ring(plX(sn.x + 1), plY(sn.z), (tt - tF0 - 1.6) / 0.9, 40, C.oreHi);
        }
        drawPlayerPlan(s.pos.x, s.pos.z);
        // give-up budget
        const bx = ST.x + 24, by = ST.y + 72;
        T('give-up budget: ' + s.cost + ' of ' + P.giveUp + ' durability', bx, by - 8, 12, C.muted, { font: MONO });
        push(); noStroke(); fill(C.line); rect(bx, by, 260, 8, 4); fill(s.cost > 90 ? '#d03b3b' : C.accent); rect(bx, by, 260 * Math.min(1, s.cost / P.giveUp), 8, 4); pop();
        // decision arrows
        if (tt >= tDec && tt < tF0 + 0.6) {
          const u = ease(seg(tt, tDec, tDec + 0.6));
          push(); stroke(C.accent); strokeWeight(3); fill(C.accent);
          line(plX(3.5), plY(-3.3), plX(3.5 + 7 * u), plY(-3.3));
          if (u > 0.8) triangle(plX(10.5), plY(-3.3) - 8, plX(10.5), plY(-3.3) + 8, plX(10.5) + 14, plY(-3.3)); pop();
        }
        // captions
        if (tt < tE0) caption('You are at the shaft, at tunnel level ' + lvl, 'A node search here says: ' + World.bucket(C5.c0).label + '. Now test two directions.');
        else if (tt < tEp) caption('Dig 3 blocks east', 'Tunnels are 2 blocks high: 2 durability per step.');
        else if (tt < tS0) caption('East end: ' + World.bucket(C5.cE).label, 'Up from ' + World.bucket(C5.c0).label + '. Now the other axis.');
        else if (tt < tSp) caption('Dig 3 blocks south', 'Back at the shaft, test the other axis.');
        else if (tt < tDec) caption('South end: ' + World.bucket(C5.cS).label, 'No change in the word, while east jumped.');
        else if (tt < tF0) caption('East rose the most: follow it', 'Toward the axis that changed; away from one that fell.');
        else if (tt < tF0 + 1.6) caption('Tunnel east, 3 blocks at a time', 'Keep going while the count holds or rises.');
        else caption('Ore in the tunnel wall: stop probing.', 'Total since the hit: ' + C5.cost + ' durability, well under the 120 budget. Now mine it.');
      },
    });
  }

  /* ===== 6. mine ===== */
  {
    const C5 = RUN.chaseA, sn = C5.seenAt;
    const order = FOOT.A.slice().sort((a, b) => Math.hypot(a.x - sn.x, a.z - sn.z) - Math.hypot(b.x - sn.x, b.z - sn.z));
    const tM0 = 1.6, tM1 = 7.4, tP = tM1 + 0.4, dur = tP + 3.4;
    const tunnelAll = [...C5.armE, ...C5.armS, ...C5.follow];
    const state = tt => {
      const u = ease(seg(tt, tM0, tM1)), n = Math.floor(u * order.length + 1e-6);
      const gone = new Set(); let ore = 0;
      for (let i = 0; i < n; i++) { gone.add(order[i].x + ',' + order[i].z); ore += order[i].n; }
      return { n, gone, ore: Math.min(ore, RUN.nA), cur: order[Math.min(order.length - 1, n)] };
    };
    S.push({
      chip: '6 Mine', step: 6, title: 'Mine the whole body',
      paras: ['Mine every ore block you can reach: a 1×2 walkway through the body, with every ore block within four blocks of it. Each ore block costs 1 durability and is 1 ore.',
        'Then probe again from where you stand. “No ore nearby” means the body is done. If it still finds ore, repeat the routine; up to four bodies can sit in one cube.'],
      rule: 'Mine it all, then probe again.', dur,
      stats: tt => { const s = state(tt); return [D_AFTER.s5 + s.ore + (tt >= tP ? P.probeCost : 0), s.ore, RUN.levelA]; },
      draw(tt) {
        const s = state(tt);
        drawPlanBase();
        drawFootprint(FOOT.A, { solid: true, gone: s.gone });
        drawTunnel(tunnelAll); drawShaftCell();
        if (tt >= tM0 && tt < tM1 && s.cur) {
          const x = plX(s.cur.x), z = plY(s.cur.z);
          for (let i = 0; i < 5; i++) { const a = tt * 9 + i * 1.3; push(); noStroke(); fill(A('#ffd9a8', 0.8)); circle(x + Math.cos(a) * 12, z + Math.sin(a * 1.3) * 12, 3); pop(); }
          drawPlayerPlan(s.cur.x, s.cur.z);
        } else drawPlayerPlan(sn.x, sn.z);
        if (tt >= tP) drawCube(sn.x, sn.z, seg(tt, tP, tP + 0.4), tt >= tP + 0.5 ? 'No ore nearby' : null, false);
        if (tt < tM0) caption('Ore is in the wall.', 'Start mining from where you saw it.');
        else if (tt < tM1) caption('Mining: ' + s.ore + ' ore blocks so far', 'A 1×2 walkway, every ore block within four blocks. 1 durability per block.');
        else if (tt < tP + 0.5) caption('All ' + RUN.nA + ' ore blocks mined.', 'Now probe again from here.');
        else caption('No ore nearby: this body is finished.', 'That is ' + RUN.nA + ' ore for ' + (LG.edgeA + LG.chaseA + LG.mineA) + ' durability since the hit was confirmed. Back to the shaft.');
      },
    });
  }

  /* ===== 7. down to 112 ===== */
  {
    const later = RUN.later, hb = RUN.hitB, EB = RUN.edgeB, CB = RUN.chaseB;
    const plan = []; let t = 1.0;
    const add = o => { plan.push(Object.assign({ t0: t, t1: t + o.dur }, o)); t += o.dur; };
    add({ k: 'dig', from: RUN.levelA, to: 65, dur: 1.0 }); add({ k: 'probe', d: 65, c: 0, dur: 1.0 });
    add({ k: 'dig', from: 65, to: 78, dur: 1.0 }); add({ k: 'probe', d: 78, c: 0, dur: 1.0 });
    add({ k: 'dig', from: 78, to: hb.d, dur: 1.0 }); add({ k: 'probe', d: hb.d, c: hb.c, dur: 1.2 });
    EB.probes.forEach(p => { add({ k: 'move', from: p.d === EB.probes[0].d ? hb.d : null, to: p.d, dur: 0.45 }); add({ k: 'eprobe', p, dur: 0.85 }); });
    const tTop = t; add({ k: 'top', dur: 1.6 });
    add({ k: 'dig', from: EB.highest, to: RUN.levelB, dur: 1.2, fast: true });
    const tChase = t; add({ k: 'chase', dur: 2.4 });
    add({ k: 'dig', from: RUN.levelB, to: 104, dur: 1.0 }); add({ k: 'probe', d: 104, c: 0, dur: 1.0 });
    add({ k: 'dig', from: 104, to: P.stopDepth, dur: 1.0 });
    add({ k: 'stop', dur: 2.8 });
    const dur = t;
    const tMinedB = tChase + 1.6;
    const state = tt => {
      let player = RUN.levelA, dug = RUN.levelA, done = [], active = null, ghosts = [], moveFrom = hb.d, phase = '', edgeDone = [];
      let lo = hb.d - P.probeStep, hi = hb.d;
      for (const s of plan) {
        if (tt < s.t0) break;
        if (s.k === 'dig') { const u = ease(seg(tt, s.t0, s.t1)); const v = lerp(s.from, s.to, u); player = v; if (v > dug) dug = v; phase = 'dig'; }
        else if (s.k === 'probe') { player = s.d; if (s.d > dug) dug = s.d; if (tt >= s.t0 + 0.5) { done.push({ d: s.d, c: s.c }); } if (tt < s.t1) active = { d: s.d, c: s.c, reveal: tt >= s.t0 + 0.5, u: seg(tt, s.t0, s.t0 + 0.9), e: false }; phase = 'probe'; }
        else if (s.k === 'move') { const u = ease(seg(tt, s.t0, s.t1)); player = lerp(moveFrom, s.to, u); if (tt >= s.t1) moveFrom = s.to; phase = 'edge'; }
        else if (s.k === 'eprobe') { player = s.p.d; if (tt >= s.t0 + 0.45) { edgeDone.push(s.p); if (s.p.c > 0) hi = s.p.d; else lo = s.p.d; } if (tt < s.t1) active = { d: s.p.d, c: s.p.c, reveal: tt >= s.t0 + 0.45, u: seg(tt, s.t0, s.t0 + 0.8), e: true }; phase = 'edge'; }
        else if (s.k === 'top') { player = EB.highest; phase = 'top'; }
        else if (s.k === 'chase') { phase = 'chase'; player = RUN.levelB; }
        else if (s.k === 'stop') { player = P.stopDepth; phase = 'stop'; }
      }
      return { player, dug, done, active, phase, edgeDone, lo, hi };
    };
    const ledgerAt = tt => {
      // durability and ore as this scene progresses: digging (1/block), probes (2), edge search, chase, mining
      let d = D_AFTER.s6, ore = RUN.nA;
      for (const s of plan) {
        if (tt < s.t0) break;
        const u = seg(tt, s.t0, s.t1);
        if (s.k === 'dig') d += (s.to - s.from) * (s.fast ? 1 : 1) * (tt >= s.t1 ? 1 : ease(u));
        else if (s.k === 'probe' || s.k === 'eprobe') d += tt >= s.t0 + 0.4 ? P.probeCost : 0;
        else if (s.k === 'chase') { d += CB.cost * ease(seg(tt, s.t0, s.t0 + 1.2)) + (tt >= s.t0 + 1.6 ? RUN.nB + P.probeCost : 0); if (tt >= s.t0 + 1.6) ore += RUN.nB; }
      }
      return [d, ore];
    };
    S.push({
      chip: '7 Descend', step: 7, title: 'Dig on to 112 ladders',
      paras: ['Back in the shaft, carry on down, probing every 13 blocks. Each new hit gets the same edge search, tunnel and mine.',
        'Stop at 112 ladders. Copper deposits run from about 50 to 110 blocks down (80% of them), and past that the shaft costs more than it returns. You count ladders instead of reading Y.',
        'Other ores stop earlier: tin at 80 ladders, for example.'],
      rule: 'Same routine at every hit. Stop at 112 ladders.', dur,
      stats: tt => { const [d, o] = ledgerAt(tt); return [d, o, state(tt).player]; },
      draw(tt) {
        const s = state(tt), minedB = tt >= tMinedB;
        const cube = s.active ? { d: s.active.d, a: 1, pulse: s.active.u, c: s.active.c, label: s.active.reveal ? (s.active.e ? (s.active.c > 0 ? 'Trace: ore!' : 'No ore nearby') : (s.active.c > 0 ? World.bucket(s.active.c).label : 'No ore nearby')) : null } : null;
        const marks = [{ d: RUN.firstHit, c: RUN.hitCount }, ...s.done.filter(p => !(s.phase !== 'probe' && false))];
        const lines = [];
        if (s.phase === 'edge') { lines.push({ d: s.lo, color: C.muted, text: 'last empty: ' + s.lo }, { d: s.hi, color: C.accent, text: 'ore at: ' + s.hi }); }
        if (s.phase === 'top' || (s.phase === 'chase' && !minedB)) lines.push({ d: EB.top, color: C.accent, text: 'top = ' + EB.highest + ' + ' + P.R + ' = ' + EB.top, dash: false, w: 2 });
        const tunnelB = (tt > tChase - 0.2 && !minedB) ? { level: RUN.levelB, len: Math.round(ease(seg(tt, tChase, tChase + 1.4)) * 5) } : null;
        drawSection({ cam: Math.max(60, Math.min(100, s.player)), dug: s.dug, player: s.player, ladders: Math.round(s.dug), cube, marks: marks.concat(s.phase === 'edge' ? s.edgeDone : []), lines,
                      ghosts: [{ d: hb.d, a: s.phase === 'edge' ? 0.22 : 0 }], minedA: true, minedB, tunnel: tunnelB,
                      brace: (s.phase === 'top' || (s.phase === 'chase' && !minedB)) ? { d0: EB.highest, d1: EB.top, text: P.R + ' blocks' } : null });
        if (s.phase === 'stop') {
          push(); stroke(C.accent); strokeWeight(2); line(secX(-14), secY(P.stopDepth) + 5, secX(14), secY(P.stopDepth) + 5); pop();
          pill('STOP: 112 ladders', secX(16), secY(P.stopDepth) + 5, { size: 13, bold: true, color: '#1a1208', bg: C.accent });
        }
        if (s.phase === 'dig') caption('Digging on', Math.round(s.dug) + ' ladders · probes at 65, 78, 91, 104');
        else if (s.phase === 'probe') caption(s.active ? (s.active.reveal ? (s.active.c > 0 ? World.bucket(s.active.c).label + ' at ' + s.active.d + ': a second body!' : 'No ore nearby at ' + s.active.d) : 'Node search at ' + s.active.d) : 'Probing', s.active && s.active.d === 91 ? 'Body A is gone, so this is a new one.' : 'Probes stay 13 apart.');
        else if (s.phase === 'edge') caption('Edge search again', 'Between ' + s.lo + ' (empty) and ' + s.hi + ' (ore).');
        else if (s.phase === 'top') caption('Top of the second body: ' + EB.top, 'Highest probe with ore ' + EB.highest + ' plus 6.');
        else if (s.phase === 'chase') caption(tt < tMinedB ? 'Tunnel and mine it (sped up)' : 'Mined: +' + RUN.nB + ' ore', 'Same routine as before: two test arms, follow the count, mine everything.');
        else caption('112 ladders: stop, and climb out.', 'Ore so far: ' + (RUN.nA + RUN.nB) + ' blocks from two bodies, in ' + Math.round(RUN.underground) + ' durability underground.');
      },
    });
  }

  /* ===== 8. next shaft ===== */
  {
    const sh = PATCH.shafts, T0 = 1.6, TM = 2.0, TW = 4.6, per = 0.9, first = 5.6;
    const dur = first + (sh.length - 1) * per + 4.6;
    const nShown = tt => 1 + Math.max(0, Math.min(sh.length - 1, Math.floor((tt - first) / per + 1)));
    const shares = [[16, 61], [20, 79], [24, 90], [32, 98]];
    S.push({
      chip: '8 Next shaft', step: 8, title: 'Next shaft: 32 blocks away',
      paras: ['Climb out and walk 32 blocks before digging again. Closer, and the new shaft digs through ground the last one already cleared.',
        'Rule of thumb: 13 (one probe cube) plus the width of a large deposit (about 18 blocks for copper). Measured, a later shaft still finds 98% of a fresh shaft’s ore at 32 blocks apart, but only 61% at 16.',
        'Keep going while the reading stays good. One “decent” copper patch has room for around 100 shafts.'],
      rule: 'Move 32 blocks, dig again. Keep going while the reading holds.', dur,
      stats: () => [D_AFTER.s7, RUN.ore, null],
      draw(tt) {
        noStroke(); fill('#1b2119'); rect(ST.x, ST.y, ST.w, ST.h);
        push(); tint(255, 60); image(terrainG, ST.x, ST.y); pop();
        const n = nShown(tt);
        // ore bodies from above: hidden ones as x-ray, mined ones as cavities
        noStroke();
        for (const pb of PATCH.bodies) {
          const mined = pb.owner === 0 || (pb.owner > 0 && pb.owner < n && tt >= first + (pb.owner - 1) * per + 0.45);
          for (const f of footprint(pb.b)) {
            fill(mined ? A(C.void, 0.95) : A(C.ore, 0.34)); rect(tdX(f.x + pb.dx - 0.5), tdY(f.z + pb.dz - 0.5), TD.sc + 0.3, TD.sc + 0.3);
          }
        }
        // shafts and cubes
        sh.forEach((s, k) => {
          if (k >= n) return;
          const u = k === 0 ? 1 : ease(seg(tt, first + (k - 1) * per, first + (k - 1) * per + 0.35));
          push(); noFill(); stroke(A(C.probe, 0.5 * u)); strokeWeight(1); rect(tdX(s.x - 6.5), tdY(s.z - 6.5), 13 * TD.sc, 13 * TD.sc); pop();
          push(); noStroke(); fill(A('#f3c96b', u)); circle(tdX(s.x), tdY(s.z), 9); fill(A('#0e0f0e', u)); circle(tdX(s.x), tdY(s.z), 4); pop();
          T(String(k + 1), tdX(s.x) + 8, tdY(s.z) - 8, 11, A(C.ink, u), { font: MONO });
        });
        // measurement brackets
        const u1 = ease(seg(tt, T0, T0 + 0.6)), u2 = ease(seg(tt, T0 + 0.9, T0 + 1.5)), u3 = ease(seg(tt, TM + 0.4, TM + 1.0));
        // the two measurements sit in a dark strip along the top so nothing underneath fights them
        const by = ST.y + 46, s0 = sh[0];
        if (u1 > 0) { push(); noStroke(); fill(A('#0e0f0e', 0.88 * u1)); rect(ST.x, ST.y, ST.w, 74); pop(); }
        if (u1 > 0) { push(); stroke(A(C.probe, u1)); strokeWeight(2); line(tdX(-6.5), by, tdX(-6.5 + 13 * u1), by); line(tdX(-6.5), by - 5, tdX(-6.5), by + 5); pop();
          T('13: one probe cube', tdX(-6.5), by - 12, 12.5, A(C.probe, u1), { bold: true }); }
        if (u2 > 0) { push(); stroke(A(C.ore, u2)); strokeWeight(2); line(tdX(6.5), by, tdX(6.5 + 18 * u2), by); line(tdX(24.5), by - 5, tdX(24.5), by + 5); pop();
          T('≈18: a large deposit', tdX(6.5), by + 22, 12.5, A(C.oreHi, u2), { bold: true }); }
        if (u3 > 0) {
          push(); stroke(A(C.accent, u3)); strokeWeight(2); dashed(true); line(tdX(32), tdY(-27), tdX(32), tdY(27)); dashed(false); pop();
          T('13 + 18 ≈ 32', tdX(32) + 12, by + 4, 15, A(C.accent, u3), { bold: true });
        }
        // legend, in the strip's right corner
        const lx = ST.x + ST.w - 250;
        push(); noStroke(); fill(A(C.ore, 0.5)); rect(lx, ST.y + 22, 14, 10, 2); fill(C.void); rect(lx, ST.y + 44, 14, 10, 2); stroke(C.line); noFill(); rect(lx, ST.y + 44, 14, 10, 2); pop();
        T('ore you have not reached (x-ray)', lx + 22, ST.y + 31, 11.5, C.ink2, { font: MONO });
        T('ore already mined out', lx + 22, ST.y + 53, 11.5, C.ink2, { font: MONO });
        // walking arrow, shaft 1 to shaft 2
        if (tt >= TW && tt < first) {
          const u = ease(seg(tt, TW, first - 0.3)), wy = tdY(s0.z + 10);
          push(); stroke(C.accent); strokeWeight(2.5); dashed(true); line(tdX(s0.x), wy, tdX(s0.x + 32 * u), wy); dashed(false); noStroke(); fill(C.accent); circle(tdX(s0.x + 32 * u), wy, 9); pop();
          T('walk 32 blocks', tdX(s0.x + 16), wy + 20, 12.5, C.accent, { align: CENTER, bold: true });
        }
        // mini chart
        const uc = ease(seg(tt, first + 1.5, first + 2.2));
        if (uc > 0) {
          const cx = ST.x + ST.w - 250, cy = ST.y + 92;
          push(); noStroke(); fill(A('#0e0f0e', 0.92 * uc)); rect(cx, cy, 236, 136, 10); pop();
          T('Ore a later shaft still gets', cx + 14, cy + 24, 12.5, A(C.ink, uc), { bold: true });
          shares.forEach(([d, v], i) => {
            const y = cy + 40 + i * 24;
            T(d + ' apart', cx + 14, y + 12, 12, A(C.ink2, uc), { font: MONO });
            push(); noStroke(); fill(A(d === 32 ? C.good : C.ore, uc)); rect(cx + 90, y, 92 * v / 100 * uc, 14, 3); pop();
            T(v + '%', cx + 90 + 92 * v / 100 * uc + 6, y + 12, 12, A(C.ink, uc), { font: MONO });
          });
        }
        if (tt < T0) caption('Shaft 1 is done. Its two bodies are cleared.', 'Where does the next shaft go?');
        else if (tt < TW) caption('Space shafts by probe cube plus deposit width', 'Closer than that and the new probes only find ore the last chase already took.');
        else if (tt < first) caption('Climb out and walk 32 blocks', 'Walking is free; only digging and probing cost durability.');
        else if (tt < first + (sh.length - 1) * per + 0.5) caption('Shaft ' + n + ' of ' + sh.length + ': same routine', 'Probe every 13, edge search at a hit, tunnel, mine, stop at 112 ladders.');
        else caption('One good patch keeps you busy for a long time.', 'About 100 shafts fit in a typical “decent” patch at this spacing.');
      },
    });
  }

  /* ===== 9. the whole patch ===== */
  {
    const PF = World.PATCHFILL, sz = ST.h - 76, Z = { x: ST.x + (ST.w - sz) / 2, y: ST.y + 8, s: sz }, kk = sz / PF.span;
    const bx = x => Z.x + (x - PF.center.x + PF.span / 2) * kk, bz = z => Z.y + (z - PF.center.y + PF.span / 2) * kk;
    const N = PF.shafts.length, tIn = 1.4, tFill = 3.4, fillDur = 7.0, dur = tFill + fillDur + 4.2;
    S.push({
      chip: 'Patch', kicker: 'STEP 8, CONTINUED', title: 'Fill the patch',
      paras: ['Zoom out and the same 32-block lattice fills the whole “decent” outline. Start in the middle, where the reading is highest, and work outward.',
        'This patch has room for ' + N + ' shafts; a typical “decent” copper patch holds about 100. That is a great deal of ore before you need to look for another patch.',
        'Each shaft is worth what its own reading says, so leave the rim of the outline for last.'],
      rule: 'A 32-block lattice inside the “decent” outline, middle first.', dur,
      stats: () => [D_AFTER.s7, RUN.ore, null],
      draw(tt) {
        noStroke(); fill(C.panel); rect(ST.x, ST.y, ST.w, ST.h);
        // the density field around the patch, cropped out of the whole-map image
        noStroke(); fill('#0b0d10'); rect(Z.x, Z.y, Z.s, Z.s);
        image(heat, Z.x, Z.y, Z.s, Z.s, (PF.center.x - PF.span / 2) / 2, (PF.center.y - PF.span / 2) / 2, PF.span / 2, PF.span / 2);
        push(); noFill(); stroke(C.line); rect(Z.x, Z.y, Z.s, Z.s); pop();
        // the edge of the "decent" patch
        const ou = ease(seg(tt, tIn, tIn + 0.8)), sw = PF.step * kk;
        push(); noStroke(); fill(A(C.accent, 0.95 * ou));
        for (const o of PF.outline) { if (o.v) rect(bx(o.x) - 1, bz(o.y) - sw / 2, 2, sw); else rect(bx(o.x) - sw / 2, bz(o.y) - 1, sw, 2); }
        pop();
        // shafts, middle first
        const n = Math.max(1, Math.floor(N * ease(seg(tt, tFill, tFill + fillDur)) + 1e-6)), h = 13 * kk;
        for (let i = 0; i < n; i++) {
          const s = PF.shafts[i], px = bx(s.x), pz = bz(s.y);
          push(); noFill(); stroke(A(C.probe, 0.6)); strokeWeight(1); rect(px - h / 2, pz - h / 2, h, h);
          noStroke(); fill(i === 0 ? '#f3c96b' : C.good); circle(px, pz, i === 0 ? 7 : 4.5); pop();
        }
        pill('shaft 1 (this run)', bx(PF.shafts[0].x) + 12, bz(PF.shafts[0].y) - 16, { size: 11.5, color: '#f3c96b', border: '#f3c96b' });
        // counter and key, in the side margins
        T('SHAFTS PLACED', ST.x + 18, ST.y + 34, 10.5, C.muted, { font: MONO });
        T(String(n), ST.x + 18, ST.y + 78, 40, C.ink, { font: HEAD, bold: true });
        T('of ' + N + ' that fit', ST.x + 18, ST.y + 98, 12, C.ink2);
        push(); noFill(); stroke(C.accent); strokeWeight(2); line(ST.x + 18, ST.y + 150, ST.x + 40, ST.y + 150); pop();
        T('edge of the', ST.x + 48, ST.y + 146, 11.5, C.ink2, { font: MONO }); T('“decent” patch', ST.x + 48, ST.y + 160, 11.5, C.ink2, { font: MONO });
        push(); noFill(); stroke(A(C.probe, 0.8)); rect(ST.x + 21, ST.y + 184, 9, 9); noStroke(); fill(C.good); circle(ST.x + 25.5, ST.y + 188.5, 4.5); pop();
        T('a shaft and its', ST.x + 48, ST.y + 190, 11.5, C.ink2, { font: MONO }); T('probe cube', ST.x + 48, ST.y + 204, 11.5, C.ink2, { font: MONO });
        push(); stroke(C.ink); strokeWeight(3); line(ST.x + 18, ST.y + 236, ST.x + 18 + 32 * kk, ST.y + 236); pop();
        T('32 blocks', ST.x + 18, ST.y + 254, 11.5, C.ink2, { font: MONO });
        if (tt < tIn) caption('Zoom out to the whole patch', 'The compass climb ended in the middle of it.');
        else if (tt < tFill) caption('This is the outline of the “decent” patch', 'Everywhere inside it, the pick reads “decent” or better.');
        else if (tt < tFill + fillDur) caption('Shaft ' + n + ' of ' + N + ': same routine', 'Every shaft 32 blocks from its neighbours, working outward from the middle.');
        else caption('This patch fits ' + N + ' shafts at 32 blocks apart.', 'A typical “decent” copper patch holds about 100.');
      },
    });
  }

  /* ===== 10. recipe ===== */
  {
    const rows = [
      ['Copper', '112', '32'],
      ['Tin (cassiterite)', '80', '24'],
      ['Bismuthinite', '80', '20'],
      ['Iron (hematite)', '80', '80'],
    ];
    S.push({
      chip: 'Recipe', kicker: 'THE WHOLE GUIDE', title: 'The recipe',
      paras: ['Measured for copper at radius 6: 26.5 ore per 100 durability with this plan, against 25.3 for probing every 6. Numbers come from three simulated worlds, 49,152 shafts per strategy. Radius 8 does slightly better for tin and iron.',
        'This run hit two bodies, so it did better than average: ' + RUN.orePer100.toFixed(0) + ' ore per 100 durability underground (' + RUN.ore + ' ore for ' + Math.round(RUN.underground) + '). The average shaft mines about 26, because many hit nothing.',
        'One caveat: the game reports node-search counts as words (trace, small, medium…), but the simulations followed exact counts when steering a tunnel. Real tunnelling will be a little less efficient. Edge search needs only “ore or none”, so it holds up.'],
      rule: null, dur: 17,
      stats: () => [D_AFTER.s7, RUN.ore, null],
      draw(tt) {
        noStroke(); fill(C.panel); rect(ST.x, ST.y, ST.w, ST.h, 12);
        const steps = [
          ['Read every ~100 blocks', 'until the pick says “decent”'],
          ['Climb', '4 compass readings 64 blocks out; step to the best'],
          ['Dig, probe every 13', 'count your ladders'],
          ['Edge search', 'top of the ore = highest probe with ore + 6'],
          ['Tunnel to the count', '3 blocks at a time; give up at 120'],
          ['Mine the whole body', 'then probe again'],
          ['Repeat to your ladder count', 'copper 112'],
          ['Next shaft', 'copper 32 blocks away'],
        ];
        T('The plan', ST.x + 28, ST.y + 42, 20, C.ink, { font: HEAD, bold: true });
        steps.forEach(([a, b], i) => {
          const u = ease(seg(tt, 0.4 + i * 0.35, 0.9 + i * 0.35)), y = ST.y + 76 + i * 44;
          push(); drawingContext.globalAlpha = u;
          noStroke(); fill(C.ore); circle(ST.x + 42, y - 5, 24); T(String(i + 1), ST.x + 42, y, 13, '#1a1208', { font: HEAD, bold: true, align: CENTER });
          T(a, ST.x + 66, y - 2, 14.5, C.ink, { bold: true }); T(b, ST.x + 66, y + 15, 12.5, C.ink2);
          drawingContext.globalAlpha = 1; pop();
        });
        // per-ore table
        const tx = ST.x + 430, ty = ST.y + 42, u = ease(seg(tt, 3.6, 4.6));
        push(); drawingContext.globalAlpha = u;
        T('By ore (radius 6)', tx, ty, 20, C.ink, { font: HEAD, bold: true });
        T('ore', tx, ty + 34, 11, C.muted, { font: MONO }); T('STOP AT (LADDERS)', tx + 170, ty + 34, 11, C.muted, { font: MONO }); T('SHAFTS APART', tx + 310, ty + 34, 11, C.muted, { font: MONO });
        rows.forEach((r, i) => {
          const y = ty + 66 + i * 34;
          push(); noStroke(); fill(i % 2 ? A('#ffffff', 0.0) : A('#ffffff', 0.04)); rect(tx - 8, y - 20, 410, 30, 6); pop();
          T(r[0], tx, y, 14, C.ink); T(r[1], tx + 200, y, 16, C.oreHi, { font: MONO, bold: true, align: CENTER }); T(r[2], tx + 350, y, 16, C.oreHi, { font: MONO, bold: true, align: CENTER });
        });
        drawingContext.globalAlpha = 1; pop();
        // what loses ore: measured alternatives, copper at radius 6, ore per 100 durability
        const u2 = ease(seg(tt, 6.4, 7.4));
        push(); drawingContext.globalAlpha = u2;
        const hy = ST.y + 250, losses = [
          ['Stop at the first deposit', '18.6'],
          ['Side tunnels after a hit', '24.1–25.8'],
          ['Probe every 6, not 13', '25.3'],
          ['Shafts 13 blocks apart', 'half the ore'],
        ];
        push(); noStroke(); fill(C.panel2); rect(tx - 8, hy, 410, 232, 12); pop();
        T('WHAT LOSES ORE (COPPER, PER 100 DURABILITY)', tx + 8, hy + 26, 11, C.muted, { font: MONO });
        T('This plan', tx + 8, hy + 62, 15, C.ink, { bold: true }); T('26.5', tx + 390, hy + 64, 26, C.good, { font: HEAD, bold: true, align: RIGHT });
        losses.forEach(([l, v], i) => {
          const y = hy + 106 + i * 30;
          push(); stroke(C.line); strokeWeight(1); line(tx + 8, y - 20, tx + 392, y - 20); pop();
          T(l, tx + 8, y, 14, C.ink2); T(v, tx + 390, y, 15, C.loss, { font: MONO, bold: true, align: RIGHT });
        });
        drawingContext.globalAlpha = 1; pop();
      },
    });
  }

  SCENES = S;
  let t = 0; starts = [];
  for (const s of SCENES) { starts.push(t); t += s.dur; }
  total = t;
}

/* ---------- p5 lifecycle and controls ---------- */
let clock = 0, playing = true, speed = 1, loopOn = false;

function setup() {
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  const cv = createCanvas(W, H); cv.parent('stage');
  textFont(FONT); frameRate(60);
  buildHeat(); buildTerrain(); buildRock(); buildScenes();
  const q = new URLSearchParams(location.search);
  if (q.has('t')) clock = Math.max(0, parseFloat(q.get('t')));
  if (q.get('paused') === '1') playing = false;
  if (q.has('speed')) speed = parseFloat(q.get('speed'));
  if (q.has('loop')) loopOn = true;
  if (q.has('scene')) { clock = starts[Math.max(0, Math.min(SCENES.length - 1, +q.get('scene')))] + (parseFloat(q.get('at')) || 0); }
  window.__ANIM = { get clock() { return clock; }, total, scenes: SCENES.map((s, i) => ({ chip: s.chip, start: starts[i], dur: s.dur })) };
  if (q.has('sweep')) sweep();
}
// Dev check (?sweep=1): draw every scene every 0.1 s, look for exceptions and non-finite numbers, and check that the
// durability / ore totals in the header match across scene boundaries. Result goes to the page title.
function sweep() {
  const problems = [];
  try {
    for (let c = 0; c < total; c += 0.1) {
      const { i, t } = locate(c), S = SCENES[i];
      background(C.bg); clipStage(); S.draw(t); unclip();
      const st = S.stats(t);
      if (!st.slice(0, 2).every(Number.isFinite)) problems.push('non-finite stats in ' + S.chip + ' at ' + t.toFixed(2));
    }
    for (let i = 0; i + 1 < SCENES.length; i++) {
      const a = SCENES[i].stats(SCENES[i].dur), b = SCENES[i + 1].stats(0);
      if (Math.abs(a[0] - b[0]) > 1.5 || Math.abs(a[1] - b[1]) > 1.5) problems.push('boundary ' + SCENES[i].chip + ' -> ' + SCENES[i + 1].chip + ': ' + a.slice(0, 2).map(Math.round) + ' vs ' + b.slice(0, 2).map(Math.round));
    }
  } catch (e) { problems.push('EXCEPTION ' + e.message); }
  document.title = problems.length ? 'SWEEP PROBLEMS: ' + problems.join(' | ') : 'SWEEP OK ' + total.toFixed(1) + 's';
}
function locate(c) {
  let i = SCENES.length - 1;
  for (let k = 0; k < SCENES.length; k++) if (c < starts[k] + SCENES[k].dur) { i = k; break; }
  return { i, t: Math.min(SCENES[i].dur, c - starts[i]) };
}
function draw() {
  const dt = Math.min(0.1, deltaTime / 1000);
  if (playing) {
    clock += dt * speed;
    if (clock >= total) { if (loopOn) clock -= total; else { clock = total - 0.001; playing = false; } }
  }
  const { i, t } = locate(clock), S = SCENES[i];
  background(C.bg);
  clipStage(); S.draw(t); unclip();
  push(); noFill(); stroke(C.line); strokeWeight(1); rect(ST.x + 0.5, ST.y + 0.5, ST.w - 1, ST.h - 1, 12); pop();
  const f = S.noFade ? 0 : 1 - seg(t, 0, 0.4);
  if (f > 0) { push(); noStroke(); fill(A(C.bg, f)); rect(ST.x, ST.y, ST.w, ST.h); pop(); }
  drawHud(S, t, i); drawPanel(S, i); drawTimeline(i, t);
  cursor(overControl() ? 'pointer' : 'default');
}
const btnAt = () => mouseY >= CTRL.y && mouseY <= CTRL.y + 32 ? BTNS.find(b => mouseX >= b.x && mouseX <= b.x + b.w) : null;
function overControl() {
  if (btnAt()) return true;
  if (mouseY >= CTRL.y && mouseY <= CTRL.y + 32 && mouseX >= TLN.x && mouseX <= TLN.x + TLN.w) return true;
  return mouseY >= 682 && mouseY <= 704 && mouseX >= TLN.x && mouseX <= TLN.x + TLN.w;
}
function jump(k) { k = Math.max(0, Math.min(SCENES.length - 1, k)); clock = starts[k] + 0.001; }
function press(id) {
  if (id === 'play') { if (clock >= total - 0.01) clock = 0; playing = !playing; }
  else if (id === 'restart') { clock = 0; playing = true; }
  else if (id === 'speed') speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
  else if (id === 'loop') loopOn = !loopOn;
}
function mousePressed() {
  if (mouseY >= CTRL.y && mouseY <= CTRL.y + 32) {
    const b = btnAt(); if (b) { press(b.id); return; }
    for (const c of chips) if (mouseX >= c.x && mouseX <= c.x + c.w) { jump(c.k); return; }
  }
  if (mouseY >= 682 && mouseY <= 704 && mouseX >= TLN.x && mouseX <= TLN.x + TLN.w) clock = clamp01((mouseX - TLN.x) / TLN.w) * (total - 0.01);
}
function mouseDragged() { if (mouseY >= 676 && mouseY <= 710 && mouseX >= TLN.x - 10 && mouseX <= TLN.x + TLN.w + 10) clock = clamp01((mouseX - TLN.x) / TLN.w) * (total - 0.01); }
function keyPressed() {
  const { i } = locate(clock);
  if (key === ' ') { press('play'); return false; }
  if (keyCode === RIGHT_ARROW) { jump(i + 1); return false; }
  if (keyCode === LEFT_ARROW) { const s = starts[i]; jump(clock - s > 1.5 ? i : i - 1); return false; }
  if (key >= '0' && key <= '9') { jump(+key); return false; }      // 0 = overview, 1-8 = the steps, 9 = the patch
  if (keyCode === END) { jump(SCENES.length - 1); return false; }  // the recipe card
  if (key === 'l' || key === 'L') { press('loop'); return false; }
  if (key === 'r' || key === 'R') { press('restart'); }
  if (key === '+' || key === '=') speed = Math.min(4, speed * 2);
  if (key === '-') speed = Math.max(0.25, speed / 2);
}
window.addEventListener('error', e => { document.title = 'ERR ' + e.message + ' @' + e.lineno; });
