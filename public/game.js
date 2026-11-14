'use strict';
/* =====================================================================
   SUPER BOMBARDERO · Simulación autoritativa (se ejecuta SOLO en el servidor)
   Port fiel de la lógica del cliente: movimiento, bombas, explosiones, bloques,
   objetos, monturas, muerte súbita, enemigos, etapas (coop) y bots.
   La física corre a 60 pasos/s fijos (igual que el juego local) para que los tiempos
   (mecha, fuego, velocidades) no cambien; la red envía snapshots a 30 Hz.
===================================================================== */
const TS = 48, COLS = 15, ROWS = 13, FUSE = 140, FL = 34, BSPD = 6, SD_INT = 6, HALF = 17;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DV = {right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1]};
const DIRN = ['down', 'up', 'left', 'right'];
const MK = ['g', 'b', 'm', 'r', 'y'];
const MOUNTS = {g: {cd: 70, ab: 'dash'}, b: {cd: 30, ab: 'toss'}, m: {cd: 150, ab: 'line'}, r: {cd: 50, ab: 'jump'}, y: {cd: 100, ab: 'block'}};
const AIRDUR = 26, JUMPDUR = 20;
const SPAWNS = [[1, 1], [13, 11], [13, 1], [1, 11]];
const SAFE = [[1, 1], [2, 1], [1, 2], [13, 1], [12, 1], [13, 2], [1, 11], [2, 11], [1, 10], [13, 11], [12, 11], [13, 10]];
const BATTLE_MAPS = [
  {n: 'Prado Clasico', layout: 'classic', theme: 'grass'},
  {n: 'Fabrica de Acero', layout: 'rooms', theme: 'factory'},
  {n: 'Glaciar Abierto', layout: 'open', theme: 'ice'},
  {n: 'Cruz del Volcan', layout: 'cross', theme: 'lava'},
  {n: 'Estacion Espacial', layout: 'classic', theme: 'space'},
  {n: 'Oasis del Desierto', layout: 'open', theme: 'desert'},
  {n: 'Aleatorio', random: true}
];
const STAGES = [
  {name: 'Prado', theme: 'grass', layout: 'classic', dens: .55, time: 240, en: ['balloon', 'balloon', 'balloon', 'balloon', 'blob']},
  {name: 'Desierto', theme: 'desert', layout: 'open', dens: .5, time: 240, en: ['balloon', 'balloon', 'blob', 'blob', 'fast']},
  {name: 'Fabrica', theme: 'factory', layout: 'rooms', dens: .55, time: 260, en: ['blob', 'blob', 'blob', 'fast', 'fast', 'ghost']},
  {name: 'Glaciar', theme: 'ice', layout: 'cross', dens: .55, time: 260, en: ['fast', 'fast', 'ghost', 'ghost', 'smart', 'smart']},
  {name: 'Volcan', theme: 'lava', layout: 'classic', dens: .6, time: 280, en: ['smart', 'smart', 'smart', 'ghost', 'ghost', 'fast', 'fast']},
  {name: 'Guarida del Jefe', theme: 'space', layout: 'arena', dens: .14, time: 300, en: ['balloon', 'balloon'], boss: true}
];
const ETYPES = ['balloon', 'blob', 'fast', 'ghost', 'smart', 'boss'];
const EN = {
  balloon: {spd: .9, pts: 100, s: 1},
  blob: {spd: 1.2, pts: 200, s: 1},
  fast: {spd: 2.1, pts: 300, s: 1},
  ghost: {spd: .9, pts: 400, s: 1, wall: true},
  smart: {spd: 1.4, pts: 500, s: 1},
  boss: {spd: 1.1, pts: 5000, s: 2, hp: 12}
};
const SKILL = [{think: 12, margin: 2, mist: .10}, {think: 7, margin: 10, mist: .03}, {think: 4, margin: 16, mist: 0}];
const ITC = {bomb: 'b', fire: 'f', speed: 's', kick: 'k', vest: 'v', life: 'l'};
for (const k of MK) ITC['egg_' + k] = k.toUpperCase();
const QMAX = 40;          // cola maxima de comandos por jugador (~0,66 s)
const CREDIT_MAX = 12;    // pasos "de credito" para absorber jitter de red (200 ms)
const CATCHUP_Q = 3;      // si la cola supera esto, se consume un comando extra por paso (solo con credito)
const KEYFRAME = 15;      // cada N snapshots se reenvian bombas/llamas aunque no hayan cambiado (0,5 s a 30 Hz)
const EVOK = new Set(['place', 'boom', 'item', 'die', 'kick', 'win', 'thud', 'hit']);

const rnd = Math.random, ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];

/* ---------- Inicialización de Socket con WebSockets Forzados ---------- */
const socket = io({
  transports: ['websocket']
});

/* ---------- Generación de mapas ---------- */
function buildLevel(layout, dens, itemChance, withExit, story) {
  const grid = []; for (let y = 0; y < ROWS; y++) grid.push(new Array(COLS).fill(0));
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) grid[y][x] = 1;
  const set = (x, y) => { grid[y][x] = 1; };
  if (layout === 'classic' || layout === 'cross') { for (let y = 2; y < ROWS - 1; y += 2) for (let x = 2; x < COLS - 1; x += 2) set(x, y); }
  if (layout === 'cross') { for (let y = 3; y <= 9; y++) set(7, y); for (let x = 5; x <= 9; x++) set(x, 6); }
  if (layout === 'open') [[3, 3], [7, 3], [11, 3], [3, 9], [7, 9], [11, 9], [5, 6], [9, 6], [7, 6]].forEach(a => set(a[0], a[1]));
  if (layout === 'rooms') {
    for (let y = 1; y <= 11; y++) for (const x of [5, 9]) if (![3, 6, 9].includes(y)) set(x, y);
    [[3, 2], [3, 10], [11, 2], [11, 10], [7, 4], [7, 8]].forEach(a => set(a[0], a[1]));
  }
  if (layout === 'arena') [[3, 3], [11, 3], [3, 9], [11, 9]].forEach(a => set(a[0], a[1]));
  const isSafe = (x, y) => SAFE.some(s => s[0] === x && s[1] === y);
  const hid = [], items = [], fire = [], fo = [];
  for (let y = 0; y < ROWS; y++) { hid.push(new Array(COLS).fill(null)); items.push(new Array(COLS).fill(null)); fire.push(new Array(COLS).fill(0)); fo.push(new Array(COLS).fill(-1)); }
  const softs = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y][x] === 0 && !isSafe(x, y) && rnd() < dens) { grid[y][x] = 2; softs.push([x, y]); }
  const roll = () => {
    const w = story ? [['bomb', 25], ['fire', 25], ['speed', 20], ['kick', 8], ['vest', 8], ['life', 4], ['egg', 11]] : [['bomb', 28], ['fire', 28], ['speed', 20], ['kick', 10], ['vest', 6], ['egg', 12]];
    const t = w.reduce((a, b) => a + b[1], 0); let r = rnd() * t;
    for (const [n, v] of w) { if ((r -= v) < 0) return n === 'egg' ? 'egg_' + pick(MK) : n; } return 'bomb';
  };
  let exit = null;
  if (withExit && softs.length) { const s = pick(softs); hid[s[1]][s[0]] = 'exit'; exit = {x: s[0], y: s[1], rev: false}; }
  for (const [x, y] of softs) if (!hid[y][x] && rnd() < itemChance) hid[y][x] = roll();
  return {grid, hid, items, fire, fo, exit};
}
function makeSpiral() {
  const out = []; let x0 = 1, x1 = COLS - 2, y0 = 1, y1 = ROWS - 2;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push([x, y0]);
    for (let y = y0 + 1; y <= y1; y++) out.push([x1, y]);
    if (y0 < y1) for (let x = x1 - 1; x >= x0; x--) out.push([x, y1]);
    if (x0 < x1) for (let y = y1 - 1; y > y0; y--) out.push([x0, y]);
    x0++; x1--; y0++; y1--;
  }
  return out;
}

/* =====================================================================
   createGame(cfg)
   cfg = {mode:'battle'|'coop', players:[{i,sid,name,ch,bot}], map, rounds, sudden, items, botSkill}
===================================================================== */
function createGame(cfg) {
  const coopMode = cfg.mode === 'coop';
  const G = {
    mode: coopMode ? 'story' : 'battle', coop: coopMode, players: [], grid: null, hid: null, items: null, fire: null, fo: null,
    flames: [], bombs: [], sblocks: [], enemies: [], exit: null, exitCd: 0, t: 0, phase: 'intro', phaseT: 0, introText: '', introSub: '', clearText: '',
    time: 0, sudden: false, spiral: [], spiralIdx: 0, sdT: 0, endT: 0, goT: 0, sdMsg: 0, stage: 0, S: null, target: 1, round: 0, overT: 0,
    themeKey: 'grass', ev: [], txq: [], seq: 0, fAdd: 0, sentF: -1, sentB: '', snapN: 0, finished: null, eid: 0, bossDead: false
  };
  const opts = {map: cfg.map | 0, sudden: cfg.sudden !== false, items: cfg.items | 0, rounds: cfg.rounds | 0};

  const sfx = n => { if (EVOK.has(n) && G.ev.length < 16) G.ev.push(n); };
  const say = (x, y, s, c) => { if (G.txq.length < 8) G.txq.push([Math.round(x), Math.round(y), s, c || '#fff']); };
  const puff = () => {};   // las partículas las genera el cliente

  /* ---------- Jugadores ---------- */
  function makePlayer(d) {
    const i = d.i;
    return {i, sid: d.sid || null, name: d.name || ('J' + (i + 1)), ch: d.ch | 0, bot: !!d.bot, skill: cfg.botSkill === undefined ? 1 : cfg.botSkill, x: 0, y: 0, dir: 'down', alive: true,
      bombs: 1, range: 2, lvl: 0, sp: 2.2, kick: false, active: 0, shield: 0, invuln: 0, anim: 0, mv: false, mount: null, cd: 0, cdMax: 1, dash: null, jump: null,
      lives: 3, score: 0, wins: 0, deadT: 0, spawn: SPAWNS[i], think: 0, tgt: null, wantBomb: false, placeT: 0, left: false,
      q: [], rx: 0, ack: 0, credit: 0, inp: {dx: 0, dy: 0, b: 0, a: 0}, lastB: 0, lastA: 0};
  }
  function placeAtSpawn(p) { p.x = (p.spawn[0] + .5) * TS; p.y = (p.spawn[1] + .5) * TS; p.dir = 'down'; p.mv = false; }
  function resetPlayer(p, full) {
    placeAtSpawn(p); p.mount = null; p.dash = null; p.jump = null; p.cd = 0; p.alive = true; p.active = 0; p.deadT = 0; p.tgt = null; p.wantBomb = false; p.think = ri(1, 10);
    p.q.length = 0; p.ack = p.rx; p.credit = 0;           // nueva ronda/reaparicion: se descartan comandos pendientes
    if (full) { p.bombs = 1; p.range = 2; p.lvl = 0; p.sp = 2.2; p.kick = false; p.shield = 0; p.invuln = 0; }
  }
  function loadMap(layout, themeKey, dens, itemChance, withExit, story) {
    const m = buildLevel(layout, dens, itemChance, withExit, story);
    G.grid = m.grid; G.hid = m.hid; G.items = m.items; G.fire = m.fire; G.fo = m.fo; G.exit = m.exit;
    G.flames = []; G.bombs = []; G.sblocks = []; G.enemies = []; G.themeKey = themeKey; G.exitCd = 0;
  }

  /* ---------- Etapas (cooperativo) ---------- */
  function startStage(i, fresh) {
    const S = STAGES[i]; G.stage = i; G.S = S;
    loadMap(S.layout, S.theme, S.dens, .18, !S.boss, true);
    for (const p of G.players) {
      if (!fresh && p.lives <= 0) { p.alive = false; p.deadT = 999; p.active = 0; continue; }
      resetPlayer(p, false); p.invuln = 150; if (fresh) { p.lives = 3; p.score = 0; }
    }
    if (G.coop && G.players.some(isOut) && G.players.some(q => !isOut(q))) ensureLifeItem();
    if (S.boss) {
      for (let y = 3; y <= 8; y++) for (let x = 5; x <= 10; x++) if (G.grid[y][x] === 2) { G.grid[y][x] = 0; G.hid[y][x] = null; }
      spawnEnemy('boss', 7, 5);
    }
    for (const t of S.en) spawnRandomEnemy(t);
    G.time = S.time * 60; G.phase = 'intro'; G.phaseT = 140; G.introText = 'ETAPA ' + (i + 1); G.introSub = S.name.toUpperCase(); G.bossDead = false;
  }
  /* ---------- Batalla ---------- */
  function startRound() {
    G.round++;
    let mm = BATTLE_MAPS[opts.map] || BATTLE_MAPS[0];
    if (mm.random) mm = pick(BATTLE_MAPS.filter(m => !m.random));
    loadMap(mm.layout, mm.theme, .62, [.12, .3, .5][opts.items] || .3, false, false);
    for (const p of G.players) { resetPlayer(p, true); if (p.left) { p.alive = false; p.deadT = 999; } }
    G.time = 180 * 60; G.sudden = false; G.spiral = makeSpiral(); G.spiralIdx = 0; G.sdT = 0; G.endT = 0; G.sdMsg = 0;
    G.phase = 'intro'; G.phaseT = 110; G.introText = 'RONDA ' + G.round; G.introSub = mm.n.toUpperCase();
  }
  function spawnRandomEnemy(type) {
    for (let k = 0; k < 300; k++) {
      const x = ri(1, COLS - 2), y = ri(1, ROWS - 2);
      if (G.grid[y][x] === 1) continue;
      if (G.players.some(p => Math.abs(p.spawn[0] - x) + Math.abs(p.spawn[1] - y) < 7)) continue;
      if (G.enemies.some(e => Math.abs(e.ax - x) + Math.abs(e.ay - y) < 2)) continue;
      if (G.exit && G.exit.x === x && G.exit.y === y) continue;
      G.grid[y][x] = 0; G.hid[y][x] = null; spawnEnemy(type, x, y); return true;
    }
    return false;
  }

  /* ---------- Física de jugadores ---------- */
  function bombAt(x, y) { for (const b of G.bombs) if (!b.dead && !b.air && b.ox === x && b.oy === y) return b; return null; }
  function solidFor(x, y, p) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true;
    if (G.grid[y][x] !== 0) return true;
    const b = bombAt(x, y);
    return !!(b && !b.ignore.has(p));
  }
  function hitbox(p, nx, ny) {
    const x0 = Math.floor((nx - HALF) / TS), x1 = Math.floor((nx + HALF - 1) / TS), y0 = Math.floor((ny - HALF) / TS), y1 = Math.floor((ny + HALF - 1) / TS);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (solidFor(x, y, p)) return true;
    return false;
  }
  function movePlayer(p, dx, dy, sp) {
    const nx = p.x + dx * sp, ny = p.y + dy * sp;
    if (!hitbox(p, nx, ny)) { p.x = nx; p.y = ny; return; }
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), fx = gx + dx, fy = gy + dy;
    if (p.kick) {
      const b = bombAt(fx, fy);
      if (b && !b.ignore.has(p) && !b.vx && !b.vy && Math.abs(p.x - (gx + .5) * TS) <= 9 && Math.abs(p.y - (gy + .5) * TS) <= 9) kickBomb(b, dx, dy);
    }
    if (!solidFor(fx, fy, p)) {
      if (dx !== 0) { const d = (gy + .5) * TS - p.y, st = Math.sign(d) * Math.min(Math.abs(d), sp); if (st && !hitbox(p, p.x, p.y + st)) p.y += st; }
      else { const d = (gx + .5) * TS - p.x, st = Math.sign(d) * Math.min(Math.abs(d), sp); if (st && !hitbox(p, p.x + st, p.y)) p.x += st; }
    } else {
      const tx = dx > 0 ? (gx + 1) * TS - HALF : dx < 0 ? gx * TS + HALF : p.x;
      const ty = dy > 0 ? (gy + 1) * TS - HALF : dy < 0 ? gy * TS + HALF : p.y;
      if (((dx > 0 && tx >= p.x) || (dx < 0 && tx <= p.x) || (dy > 0 && ty >= p.y) || (dy < 0 && ty <= p.y)) &&
          Math.abs(tx - p.x) <= sp && Math.abs(ty - p.y) <= sp && !hitbox(p, tx, ty)) { p.x = tx; p.y = ty; }
    }
  }
  function overlapsTile(p, tx, ty) { return Math.abs(p.x - (tx + .5) * TS) < TS / 2 + HALF && Math.abs(p.y - (ty + .5) * TS) < TS / 2 + HALF; }
  function maxBombs(p) { return p.bombs + (p.mount === 'm' ? 2 : 0); }
  function placeBombAt(p, gx, gy, quiet) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (p.active >= maxBombs(p) || G.grid[gy][gx] !== 0 || bombAt(gx, gy)) return false;
    const b = {gx, gy, ox: gx, oy: gy, vx: 0, vy: 0, off: 0, timer: FUSE, range: p.range, owner: p, ignore: new Set(), dead: false};
    for (const q of G.players) if (q.alive && overlapsTile(q, gx, gy)) b.ignore.add(q);
    G.bombs.push(b); p.active++; p.placeT = 16; if (!quiet) sfx('place');
    return true;
  }
  function placeBomb(p) { if (!p.alive) return; placeBombAt(p, Math.floor(p.x / TS), Math.floor(p.y / TS)); }

  /* ---------- Monturas ---------- */
  function tileFree(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS && G.grid[y][x] === 0 && !bombAt(x, y); }
  function tossBomb(p) {
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), [dx, dy] = DV[p.dir];
    let b = bombAt(gx, gy); if (!b) b = bombAt(gx + dx, gy + dy);
    if (!b) return false;
    let tg = null;
    for (const d of [3, 4, 5, 2, 1]) { const x = b.ox + dx * d, y = b.oy + dy * d; if (tileFree(x, y)) { tg = [x, y]; break; } }
    if (!tg) return false;
    b.air = {t: 0, dur: AIRDUR, sx: b.ox, sy: b.oy}; b.vx = b.vy = 0; b.off = 0;
    b.gx = b.ox = tg[0]; b.gy = b.oy = tg[1]; b.ignore = new Set();
    sfx('kick'); return true;
  }
  function landBomb(b) {
    const a = b.air; let x = b.ox, y = b.oy;
    if (!tileFree(x, y)) {
      const dx = Math.sign(x - a.sx), dy = Math.sign(y - a.sy); let f = null;
      for (let d = 1; d <= 6 && !f; d++) if (tileFree(x + dx * d, y + dy * d)) f = [x + dx * d, y + dy * d];
      if (f) { x = f[0]; y = f[1]; }
    }
    b.air = null; b.gx = b.ox = x; b.gy = b.oy = y; b.off = 0; b.vx = b.vy = 0;
    for (const p of G.players) if (p.alive && overlapsTile(p, x, y)) b.ignore.add(p);
    sfx('thud');
  }
  function lineBombs(p) {
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), [dx, dy] = DV[p.dir]; let n = 0;
    if (placeBombAt(p, gx, gy, true)) n++;
    for (let i = 1; i < COLS; i++) {
      const x = gx + dx * i, y = gy + dy * i;
      if (!tileFree(x, y) || !placeBombAt(p, x, y, true)) break; n++;
    }
    if (n) sfx('place');
    return n > 0;
  }
  function enemyOnTile(e, tx, ty) { return etiles(e).some(t => t[0] === tx && t[1] === ty); }
  function blockTileOk(x, y, skip) {
    if (!tileFree(x, y) || G.items[y][x] || (G.exit && G.exit.x === x && G.exit.y === y)) return false;
    for (const q of G.players) if (q.alive && q !== skip && overlapsTile(q, x, y)) return false;
    for (const e of G.enemies) if (!e.dying && enemyOnTile(e, x, y)) return false;
    return true;
  }
  function launchBlock(p) {
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), [dx, dy] = DV[p.dir], x = gx + dx, y = gy + dy;
    if (!blockTileOk(x, y, p)) return false;
    G.sblocks.push({x, y, dx, dy, off: 0, dead: false}); sfx('thud'); return true;
  }
  function updateBlocks() {
    for (const k of G.sblocks) {
      if (k.dead) continue;
      if (G.fire[k.y][k.x] > 0) { k.dead = true; continue; }
      if (k.off === 0 && !blockTileOk(k.x + k.dx, k.y + k.dy)) {
        k.dead = true;
        if (G.grid[k.y][k.x] === 0 && !bombAt(k.x, k.y)) { G.grid[k.y][k.x] = 2; G.hid[k.y][k.x] = null; sfx('thud'); }
        continue;
      }
      k.off += 8;
      if (k.off >= TS) { k.x += k.dx; k.y += k.dy; k.off = 0; }
    }
    G.sblocks = G.sblocks.filter(k => !k.dead);
  }
  function useAbility(p) {
    if (!p.alive || !p.mount || p.cd > 0 || p.dash || p.jump || G.phase !== 'play') return;
    const M = MOUNTS[p.mount], [dx, dy] = DV[p.dir]; let ok = false;
    if (M.ab === 'dash') { p.dash = {dx, dy, t: 0}; sfx('kick'); ok = true; }
    else if (M.ab === 'toss') ok = tossBomb(p);
    else if (M.ab === 'line') ok = lineBombs(p);
    else if (M.ab === 'block') ok = launchBlock(p);
    else if (M.ab === 'jump') {
      const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS);
      for (const d of [2, 3]) { const x = gx + dx * d, y = gy + dy * d; if (tileFree(x, y)) { p.jump = {sx: p.x, sy: p.y, tx: (x + .5) * TS, ty: (y + .5) * TS, t: 0, dur: JUMPDUR}; sfx('kick'); ok = true; break; } }
    }
    if (ok) { p.cd = M.cd; p.cdMax = M.cd; }
  }
  function mountTick(p) {
    if (p.cd > 0) p.cd--;
    if (p.jump) {
      const j = p.jump; j.t++; const k = Math.min(1, j.t / j.dur);
      p.x = j.sx + (j.tx - j.sx) * k; p.y = j.sy + (j.ty - j.sy) * k; p.mv = true; p.anim++;
      if (j.t >= j.dur) { p.x = j.tx; p.y = j.ty; p.jump = null; sfx('thud'); }
    } else if (p.dash) {
      const d = p.dash, ox = p.x, oy = p.y;
      movePlayer(p, d.dx, d.dy, 9); p.mv = true; p.anim += 2;
      if (Math.hypot(p.x - ox, p.y - oy) < 1 || ++d.t > 100) p.dash = null;
    }
  }
  function kickBomb(b, dx, dy) { b.vx = dx; b.vy = dy; b.off = 0; sfx('kick'); }
  function bombCanEnter(b, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return false;
    if (G.grid[ty][tx] !== 0) return false;
    for (const o of G.bombs) if (o !== b && !o.dead && o.ox === tx && o.oy === ty) return false;
    for (const p of G.players) if (p.alive && overlapsTile(p, tx, ty)) return false;
    for (const e of G.enemies) if (!e.dying && enemyOnTile(e, tx, ty)) return false;
    return true;
  }
  function updateBomb(b) {
    b.timer--;
    if (b.air) { const a = b.air; a.t++; if (b.timer <= 0) a.t = a.dur; if (a.t >= a.dur) landBomb(b); else return; }
    if (b.vx || b.vy) {
      if (b.off === 0 && !bombCanEnter(b, b.gx + b.vx, b.gy + b.vy)) { b.vx = b.vy = 0; b.ox = b.gx; b.oy = b.gy; }
      if (b.vx || b.vy) {
        b.off += BSPD;
        if (b.off >= TS) { b.off -= TS; b.gx += b.vx; b.gy += b.vy; }
        const nx = b.off >= TS / 2 ? b.gx + b.vx : b.gx, ny = b.off >= TS / 2 ? b.gy + b.vy : b.gy;
        if (nx !== b.ox || ny !== b.oy) {
          b.ox = nx; b.oy = ny;
          for (const p of G.players) if (p.alive && overlapsTile(p, nx, ny)) b.ignore.add(p);
        }
      }
    }
    for (const p of Array.from(b.ignore)) if (!p.alive || !overlapsTile(p, b.ox, b.oy)) b.ignore.delete(p);
    if (b.timer <= 0) explodeBomb(b);
  }
  function addFlame(x, y, kind, owner, reveal) {
    G.flames.push({x, y, t: FL, kind, o: owner}); G.fAdd++;
    G.fire[y][x] = FL; G.fo[y][x] = owner;
    const ex = G.exit;
    if (!reveal && ex && ex.rev && ex.x === x && ex.y === y && G.mode !== 'battle' && G.exitCd <= 0 && !G.S.boss) {
      if (G.enemies.filter(e => !e.dying).length < 12) {
        const e = spawnEnemy(pick(G.stage < 2 ? ['balloon', 'blob'] : ['blob', 'fast', 'smart']), x, y);
        e.immune = FL + 10; G.exitCd = 90;
      }
    }
  }
  function destroySoft(x, y) {
    G.grid[y][x] = 0;
    const h = G.hid[y][x]; G.hid[y][x] = null;
    if (h === 'exit') { if (G.exit) G.exit.rev = true; } else if (h) G.items[y][x] = h;
  }
  function explodeBomb(b) {
    if (b.dead) return; b.dead = true;
    if (b.owner) b.owner.active = Math.max(0, b.owner.active - 1);
    const oi = b.owner ? b.owner.i : -1, chain = [];
    sfx('boom');
    addFlame(b.ox, b.oy, 'c', oi);
    for (const [dx, dy, km, ke] of [[1, 0, 'h', 'r'], [-1, 0, 'h', 'l'], [0, 1, 'v', 'd'], [0, -1, 'v', 'u']]) {
      for (let i = 1; i <= b.range; i++) {
        const tx = b.ox + dx * i, ty = b.oy + dy * i, c = G.grid[ty][tx];
        if (c === 1) break;
        if (c === 2) { destroySoft(tx, ty); addFlame(tx, ty, ke, oi, true); break; }
        if (G.items[ty][tx]) { G.items[ty][tx] = null; addFlame(tx, ty, ke, oi); break; }
        addFlame(tx, ty, i === b.range ? ke : km, oi);
        const ob = bombAt(tx, ty); if (ob) chain.push(ob);
      }
    }
    for (const o of chain) explodeBomb(o);
  }

  /* ---------- Cooperativo ---------- */
  function isOut(q) { return !q.alive && q.lives <= 0; }
  function revivePlayer(q, by) {
    q.lives = 1; resetPlayer(q, false); q.x = by.x; q.y = by.y; q.dir = 'down'; q.invuln = 240; q.placeT = 0;
    for (const b of G.bombs) if (overlapsTile(q, b.ox, b.oy)) b.ignore.add(q);
    sfx('win');
  }
  function ensureLifeItem() {
    const softs = [], free = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (G.items[y][x] === 'life' || (G.grid[y][x] === 2 && G.hid[y][x] === 'life')) return;
      if (G.grid[y][x] === 2 && G.hid[y][x] !== 'exit') softs.push([x, y]);
      else if (G.grid[y][x] === 0 && !G.items[y][x] && !G.fire[y][x] && !bombAt(x, y)) free.push([x, y]);
    }
    if (softs.length) { const t = pick(softs); G.hid[t[1]][t[0]] = 'life'; }
    else if (free.length) { const t = pick(free); G.items[t[1]][t[0]] = 'life'; }
  }
  function applyItem(p, t) {
    if (t.startsWith('egg_')) {
      const k = t.slice(4);
      p.mount = k; p.dash = null; p.cd = 0; sfx('item'); say(p.x, p.y - 20, 'MONTURA', '#fff');
      return;
    }
    switch (t) {
      case 'bomb': p.bombs = Math.min(8, p.bombs + 1); break;
      case 'fire': p.range = Math.min(10, p.range + 1); break;
      case 'speed': p.lvl = Math.min(5, p.lvl + 1); p.sp = 2.2 + p.lvl * .4; break;
      case 'kick': p.kick = true; break;
      case 'vest': p.shield = 600; break;
      case 'life': {
        const mate = G.mode !== 'battle' ? G.players.find(q => q !== p && isOut(q)) : null;
        if (mate) { revivePlayer(mate, p); t = 'revive'; } else p.lives++;
        break;
      }
    }
    sfx('item'); say(p.x, p.y - 20, {bomb: 'BOMBA+', fire: 'FUEGO+', speed: 'VELOC+', kick: 'PATADA', vest: 'ESCUDO', life: '1UP', revive: '¡REVIVE!'}[t] || '', '#fff');
  }
  function killPlayer(p, force) {
    if (!p.alive || G.phase !== 'play') return;
    if (!force && (p.invuln > 0 || p.shield > 0 || p.jump)) return;
    if (!force && p.mount) {
      p.mount = null; p.dash = null; p.invuln = 120; sfx('hit'); say(p.x, p.y - 20, '¡MONTURA PERDIDA!', '#fff');
      return;
    }
    p.mount = null; p.dash = null; p.jump = null;
    p.alive = false; p.deadT = 0; sfx('die');
    if (G.mode !== 'battle') { p.lives--; if (p.lives <= 0 && G.coop && G.players.some(q => q !== p && (q.alive || q.lives > 0))) ensureLifeItem(); }
  }

  /* ---------- Enemigos ---------- */
  function spawnEnemy(type, ax, ay) {
    const d = EN[type];
    const e = {id: ++G.eid, type, ax, ay, s: d.s, dx: 0, dy: 0, prog: 0, spd: d.spd, hp: d.hp || 1, maxhp: d.hp || 1, dying: false, dieT: 0, hitT: 0, wait: 0, anim: rnd() * 100, bombT: 150, immune: 0, wall: !!d.wall, pts: d.pts, face: 1};
    G.enemies.push(e); chooseDir(e); return e;
  }
  function ecenter(e) { return [(e.ax + e.s / 2) * TS + e.dx * e.prog, (e.ay + e.s / 2) * TS + e.dy * e.prog]; }
  function etiles(e) { const c = ecenter(e), x0 = Math.round(c[0] / TS - e.s / 2), y0 = Math.round(c[1] / TS - e.s / 2), o = []; for (let j = 0; j < e.s; j++) for (let i = 0; i < e.s; i++) o.push([x0 + i, y0 + j]); return o; }
  function canEnter(e, dx, dy) {
    const tiles = [];
    for (let k = 0; k < e.s; k++) {
      if (dx > 0) tiles.push([e.ax + e.s, e.ay + k]); else if (dx < 0) tiles.push([e.ax - 1, e.ay + k]);
      else if (dy > 0) tiles.push([e.ax + k, e.ay + e.s]); else tiles.push([e.ax + k, e.ay - 1]);
    }
    for (const [x, y] of tiles) {
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
      const c = G.grid[y][x];
      if (c === 1) return false;
      if (c === 2 && !e.wall) return false;
      if (e.type !== 'boss' && bombAt(x, y)) return false;
    }
    return true;
  }
  function fireAhead(e, d) {
    const dx = d[0], dy = d[1];
    for (let k = 0; k < e.s; k++) {
      let x, y;
      if (dx > 0) { x = e.ax + e.s; y = e.ay + k; } else if (dx < 0) { x = e.ax - 1; y = e.ay + k; } else if (dy > 0) { x = e.ax + k; y = e.ay + e.s; } else { x = e.ax + k; y = e.ay - 1; }
      if (G.fire[y] && G.fire[y][x] > 0) return true;
    }
    return false;
  }
  function nearestPlayer(e) {
    let best = null, bd = 1e9;
    for (const p of G.players) if (p.alive) { const d = Math.abs(Math.floor(p.x / TS) - e.ax) + Math.abs(Math.floor(p.y / TS) - e.ay); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  function seePlayer(e, ok) {
    for (const p of G.players) {
      if (!p.alive) continue;
      const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS);
      if (e.s === 1) {
        if (gy === e.ay && Math.abs(gx - e.ax) <= 6) { const s = Math.sign(gx - e.ax); let clear = true; for (let x = e.ax + s; x !== gx; x += s) if (G.grid[e.ay][x] !== 0) clear = false; const d = ok.find(o => o[0] === s && o[1] === 0); if (clear && d) return d; }
        if (gx === e.ax && Math.abs(gy - e.ay) <= 6) { const s = Math.sign(gy - e.ay); let clear = true; for (let y = e.ay + s; y !== gy; y += s) if (G.grid[y][e.ax] !== 0) clear = false; const d = ok.find(o => o[1] === s && o[0] === 0); if (clear && d) return d; }
      } else {
        const d = ok.filter(o => (o[0] && Math.sign(gx - e.ax - .5) === o[0]) || (o[1] && Math.sign(gy - e.ay - .5) === o[1]));
        if (d.length && Math.abs(gx - e.ax) + Math.abs(gy - e.ay) < 9) return pick(d);
      }
    }
    return null;
  }
  function bfsEnemy(e) {
    const targets = G.players.filter(p => p.alive).map(p => Math.floor(p.y / TS) * COLS + Math.floor(p.x / TS)); if (!targets.length) return null;
    const seen = new Set([e.ay * COLS + e.ax]), q = [[e.ax, e.ay, 0, null]]; let qi = 0;
    while (qi < q.length) {
      const [x, y, d, f] = q[qi++];
      if (targets.includes(y * COLS + x) && f) return f;
      if (d > 28) continue;
      for (const dir of DIRS) {
        const nx = x + dir[0], ny = y + dir[1]; if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const k = ny * COLS + nx; if (seen.has(k) || G.grid[ny][nx] !== 0 || bombAt(nx, ny)) continue;
        seen.add(k); q.push([nx, ny, d + 1, f || dir]);
      }
    }
    return null;
  }
  function chooseDir(e) {
    let ok = DIRS.filter(d => canEnter(e, d[0], d[1]));
    if (!ok.length) { e.dx = e.dy = 0; e.wait = 15; return; }
    const ok2 = ok.filter(d => !fireAhead(e, d)); if (ok2.length) ok = ok2;
    let ch = null;
    if (e.type === 'smart') { const st = bfsEnemy(e); if (st && rnd() < .8) ch = ok.find(o => o[0] === st[0] && o[1] === st[1]) || null; }
    if (!ch && (e.type === 'blob' || e.type === 'boss')) { const s = seePlayer(e, ok); if (s && rnd() < .75) ch = s; }
    if (!ch && e.type === 'ghost' && rnd() < .8) {
      const p = nearestPlayer(e);
      if (p) { const px = Math.floor(p.x / TS), py = Math.floor(p.y / TS); let bd = 1e9; for (const d of ok) { const dd = Math.abs(e.ax + d[0] - px) + Math.abs(e.ay + d[1] - py); if (dd < bd) { bd = dd; ch = d; } } }
    }
    if (!ch) {
      const st = ok.find(d => d[0] === e.dx && d[1] === e.dy);
      if (st && rnd() < .7) ch = st; else { const nb = ok.filter(d => !(d[0] === -e.dx && d[1] === -e.dy)); ch = pick(nb.length ? nb : ok); }
    }
    e.dx = ch[0]; e.dy = ch[1]; if (ch[0]) e.face = ch[0];
  }
  function enemyBomb(e) {
    for (let k = 0; k < 6; k++) {
      const x = e.ax + ri(0, 1), y = e.ay + ri(0, 1);
      if (G.grid[y][x] === 0 && !bombAt(x, y)) { G.bombs.push({gx: x, gy: y, ox: x, oy: y, vx: 0, vy: 0, off: 0, timer: 100, range: e.hp <= 6 ? 4 : 3, owner: null, ignore: new Set(), dead: false}); sfx('place'); return; }
    }
  }
  function updateEnemy(e) {
    e.anim++;
    if (e.dying) { e.dieT++; return; }
    if (e.hitT > 0) e.hitT--; if (e.immune > 0) e.immune--;
    if (e.wait > 0) { e.wait--; if (e.wait === 0) chooseDir(e); }
    else {
      if (!e.dx && !e.dy) chooseDir(e);
      if (e.dx || e.dy) {
        e.prog += e.type === 'boss' ? e.spd + (1 - e.hp / e.maxhp) * .9 : e.spd;
        if (e.prog >= TS) { e.prog -= TS; e.ax += e.dx; e.ay += e.dy; chooseDir(e); if (!e.dx && !e.dy) e.prog = 0; }
      }
    }
    if (e.type === 'boss' && --e.bombT <= 0) { enemyBomb(e); e.bombT = ri(110, 190); }
    if (e.immune <= 0) {
      for (const [x, y] of etiles(e)) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
        if (G.fire[y][x] > 0) { hitEnemy(e, G.fo[y][x]); break; }
      }
    }
  }
  function hitEnemy(e, owner) {
    if (e.dying) return;
    if (e.type === 'boss') {
      if (owner < 0 || e.hitT > 0) return;
      e.hp--; e.hitT = 70; sfx('hit');
      if (e.hp === 8 || e.hp === 4) { spawnRandomEnemy('fast'); spawnRandomEnemy('blob'); }
      if (e.hp > 0) return;
    }
    e.dying = true; e.dieT = 0; sfx('edie');
    const c = ecenter(e), p = G.players.find(q => q.i === owner);
    if (p) p.score += e.pts;
    say(c[0], c[1] - 10, String(e.pts), '#ffd34d');
    if (e.type === 'boss') {
      G.bossDead = true;
      for (const o of G.enemies) if (o !== e && !o.dying) { o.dying = true; o.dieT = 0; }
      const x = e.ax, y = e.ay; G.grid[y][x] = 0; G.hid[y][x] = null;
      G.exit = {x, y, rev: true};
    }
  }

  /* ---------- Bots ---------- */
  function blastTiles(x, y, r) {
    const out = [[x, y]];
    for (const [dx, dy] of DIRS) for (let i = 1; i <= r; i++) {
      const tx = x + dx * i, ty = y + dy * i, c = G.grid[ty][tx];
      if (c === 1) break; out.push([tx, ty]); if (c === 2 || G.items[ty][tx]) break;
    }
    return out;
  }
  function computeDanger() {
    const D = []; for (let y = 0; y < ROWS; y++) D.push(new Array(COLS).fill(Infinity));
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (G.fire[y][x] > 0) D[y][x] = 0;
    const bs = G.bombs.filter(b => !b.dead), t = bs.map(b => b.timer), bl = bs.map(b => blastTiles(b.ox, b.oy, b.range));
    for (let it = 0; it < bs.length; it++) {
      let ch = false;
      for (let i = 0; i < bs.length; i++) for (let j = 0; j < bs.length; j++) if (i !== j && t[i] < t[j] && bl[i].some(c => c[0] === bs[j].ox && c[1] === bs[j].oy)) { t[j] = t[i]; ch = true; }
      if (!ch) break;
    }
    bs.forEach((b, i) => { for (const [x, y] of bl[i]) D[y][x] = Math.min(D[y][x], t[i]); });
    if (G.sudden) for (let k = 0; k < 8; k++) { const s = G.spiral[G.spiralIdx + k]; if (s) D[s[1]][s[0]] = Math.min(D[s[1]][s[0]], k * SD_INT); }
    return D;
  }
  const unsafe = (D, x, y, ta, m) => { const d = D[y][x]; return d !== Infinity && d - m <= ta && ta <= d + FL + 6; };
  function bfsFind(p, D, margin, pred, maxd) {
    const sx = Math.floor(p.x / TS), sy = Math.floor(p.y / TS), spt = TS / p.sp;
    const seen = new Set([sy * COLS + sx]), q = [[sx, sy, 0, -1, -1]]; let qi = 0;
    while (qi < q.length) {
      const [x, y, d, fx, fy] = q[qi++];
      if (pred(x, y, d)) return {x, y, d, fx, fy};
      if (d >= maxd) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const k = ny * COLS + nx; if (seen.has(k) || G.grid[ny][nx] !== 0) continue;
        if (bombAt(nx, ny)) continue;
        if (unsafe(D, nx, ny, (d + 1) * spt, margin)) continue;
        seen.add(k); q.push([nx, ny, d + 1, d === 0 ? nx : fx, d === 0 ? ny : fy]);
      }
    }
    return null;
  }
  function goodSpot(p, x, y) {
    for (const [tx, ty] of blastTiles(x, y, p.range)) {
      if (G.grid[ty][tx] === 2) return true;
      for (const q of G.players) if (q !== p && q.alive && Math.floor(q.x / TS) === tx && Math.floor(q.y / TS) === ty) return true;
    }
    return false;
  }
  function botWantsBomb(p, D, sk) {
    if (p.active >= p.bombs) return false;
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS);
    if (bombAt(gx, gy) || !goodSpot(p, gx, gy)) return false;
    const D2 = D.map(r => r.slice());
    for (const [x, y] of blastTiles(gx, gy, p.range)) D2[y][x] = Math.min(D2[y][x], FUSE);
    return !!bfsFind(p, D2, sk.margin, (x, y) => D2[y][x] === Infinity, 14);
  }
  function botThink(p, sk) {
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS);
    const D = computeDanger(); p.tgt = null;
    const wander = () => {
      const n = DIRS.map(d => [gx + d[0], gy + d[1]]).filter(t => G.grid[t[1]][t[0]] === 0 && !bombAt(t[0], t[1]) && D[t[1]][t[0]] === Infinity);
      if (n.length) { const t = pick(n); p.tgt = {x: t[0], y: t[1]}; }
    };
    if (D[gy][gx] !== Infinity) {
      if (rnd() < sk.mist) { wander(); return; }
      const r = bfsFind(p, D, sk.margin, (x, y) => D[y][x] === Infinity, 40);
      if (r && r.fx >= 0) { p.tgt = {x: r.fx, y: r.fy}; return; }
      let best = null, bd = -1;
      for (const [dx, dy] of DIRS) { const nx = gx + dx, ny = gy + dy; if (G.grid[ny][nx] === 0 && !bombAt(nx, ny) && D[ny][nx] > bd) { bd = D[ny][nx]; best = [nx, ny]; } }
      if (best) p.tgt = {x: best[0], y: best[1]};
      return;
    }
    if (rnd() < sk.mist) { wander(); return; }
    if (botWantsBomb(p, D, sk)) { p.wantBomb = true; p.think = 1; return; }
    let r = bfsFind(p, D, sk.margin, (x, y) => G.items[y][x] && G.items[y][x] !== 'life', 10);
    if (r && r.fx >= 0) { p.tgt = {x: r.fx, y: r.fy}; return; }
    if (p.active < p.bombs) {
      r = bfsFind(p, D, sk.margin, (x, y, d) => d > 0 && goodSpot(p, x, y), 40);
      if (r && r.fx >= 0) { p.tgt = {x: r.fx, y: r.fy}; return; }
    }
    if (rnd() < .25) wander();
  }
  function botStep(p, t) {
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), cx = (t.x + .5) * TS, cy = (t.y + .5) * TS, ax = (gx + .5) * TS, ay = (gy + .5) * TS, tol = p.sp * .8;
    if (gx !== t.x) { if (Math.abs(p.y - ay) > tol) return [0, Math.sign(ay - p.y)]; return [Math.sign(cx - p.x), 0]; }
    if (gy !== t.y) { if (Math.abs(p.x - ax) > tol) return [Math.sign(ax - p.x), 0]; return [0, Math.sign(cy - p.y)]; }
    if (Math.abs(p.x - cx) > tol) return [Math.sign(cx - p.x), 0];
    if (Math.abs(p.y - cy) > tol) return [0, Math.sign(cy - p.y)];
    return [0, 0];
  }
  function botInput(p) {
    const sk = SKILL[p.skill] || SKILL[1];
    if (--p.think <= 0) { p.think = sk.think; botThink(p, sk); }
    const out = {dx: 0, dy: 0, bomb: false, act: false};
    if (p.wantBomb) { out.bomb = true; p.wantBomb = false; }
    if (p.tgt) { const m = botStep(p, p.tgt); out.dx = m[0]; out.dy = m[1]; }
    if (p.mount && p.cd <= 0) {
      if (p.mount === 'm' && out.bomb) { out.bomb = false; out.act = true; }
      else if (p.mount === 'b' && rnd() < .04) { const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS), [dx, dy] = DV[p.dir]; if (bombAt(gx + dx, gy + dy)) out.act = true; }
    }
    return out;
  }
  /* Entrada de un humano: cola de comandos numerados (seq). Cada paso fisico consume 1 comando, asi el servidor
     avanza exactamente lo mismo que el cliente predijo localmente.
     Comando = dir (0 nada, 1 izq, 2 der, 3 arr, 4 abj) | 8 bomba | 16 habilidad. */
  const CD = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
  function nextCmd(p) {
    const e = p.q.shift(); if (!e) return null;
    p.ack = e[0]; const c = e[1], d = CD[c & 7] || CD[0];
    return {dx: d[0], dy: d[1], bomb: !!(c & 8), act: !!(c & 16)};
  }
  function humanInput(p) {
    const c = nextCmd(p);
    if (!c) { if (p.credit < CREDIT_MAX) p.credit++; return {dx: 0, dy: 0, bomb: false, act: false}; }   // sin comando: el jugador esta quieto
    return c;
  }
  /* Aplica habilidad/movimiento/bomba de un comando (sin los temporizadores del jugador). */
  function applyCmd(p, inp) {
    if (inp.act) useAbility(p);
    if (!p.dash && !p.jump && (inp.dx || inp.dy)) {
      p.dir = inp.dx < 0 ? 'left' : inp.dx > 0 ? 'right' : inp.dy < 0 ? 'up' : 'down';
      movePlayer(p, inp.dx, inp.dy, p.sp); p.mv = true; p.anim++;
    }
    if (inp.bomb) placeBomb(p);
  }

  /* ---------- Actualización ---------- */
  function updatePlayer(p) {
    if (p.left && p.alive && G.phase === 'play') killPlayer(p, true);
    if (!p.alive) {
      p.deadT++; p.q.length = 0; p.ack = p.rx;
      if (G.mode !== 'battle' && p.lives > 0 && p.deadT > 110 && G.phase === 'play') { resetPlayer(p, false); p.invuln = 200; }
      return;
    }
    const inp = p.bot ? botInput(p) : humanInput(p);
    p.mv = false;
    if (G.phase !== 'play') { inp.bomb = inp.act = false; inp.dx = inp.dy = 0; }
    applyCmd(p, inp);
    /* recuperar retraso de red: si se acumulo cola, se consume un comando extra
       (limitado por credito => no hay ganancia neta de velocidad) */
    if (!p.bot && p.alive && p.q.length > CATCHUP_Q && p.credit > 0) { const c2 = nextCmd(p); if (c2) { p.credit--; applyCmd(p, c2); } }
    mountTick(p);
    if (p.invuln > 0) p.invuln--; if (p.shield > 0) p.shield--; if (p.placeT > 0) p.placeT--;
    const gx = Math.floor(p.x / TS), gy = Math.floor(p.y / TS);
    const it = G.items[gy][gx]; if (it) { G.items[gy][gx] = null; applyItem(p, it); }
  }
  function updateFx() {
    for (const f of G.flames) f.t--;
    G.flames = G.flames.filter(f => f.t > 0);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) G.fire[y][x] = 0;
    for (const f of G.flames) { if (G.fire[f.y][f.x] < f.t) { G.fire[f.y][f.x] = f.t; G.fo[f.y][f.x] = f.o; } }
    for (const e of G.enemies) if (e.dying) e.dieT++;
    G.enemies = G.enemies.filter(e => !(e.dying && e.dieT > 45));
  }
  function dropBlock() {
    let s;
    while (G.spiralIdx < G.spiral.length) { s = G.spiral[G.spiralIdx++]; if (G.grid[s[1]][s[0]] !== 1) break; s = null; }
    if (!s) return;
    const [x, y] = s;
    G.grid[y][x] = 1; G.items[y][x] = null; G.hid[y][x] = null; G.fire[y][x] = 0;
    for (const b of G.bombs) if (!b.dead && b.ox === x && b.oy === y) { b.dead = true; if (b.owner) b.owner.active = Math.max(0, b.owner.active - 1); }
    for (const p of G.players) if (p.alive && Math.floor(p.x / TS) === x && Math.floor(p.y / TS) === y) killPlayer(p, true);
    sfx('thud');
  }
  const pname = p => String(p.name || ('JUGADOR ' + (p.i + 1))).toUpperCase();
  function finishRound(w) {
    G.phase = 'clear'; G.phaseT = 170;
    if (w) { w.wins++; G.clearText = pname(w) + ' GANA'; w.invuln = 9999; } else G.clearText = 'EMPATE';
    G.introSub = ''; sfx('win');
  }
  function stageClear(p) {
    G.phase = 'clear'; G.phaseT = 170; G.clearText = 'ETAPA SUPERADA'; sfx('win');
    const bonus = Math.floor(G.time / 60) * 10; p.score += bonus; G.introSub = 'BONUS TIEMPO +' + bonus;
    for (const q of G.players) q.invuln = 9999;
  }
  function finish(title, text) { G.finished = {title, text}; G.phase = 'done'; }
  function afterClear() {
    if (G.mode === 'battle') {
      const w = G.players.find(p => p.wins >= G.target);
      if (w) finish('¡' + pname(w) + ' GANA!', G.players.map(p => pname(p) + ': ' + p.wins).join('  ·  '));
      else startRound();
    } else if (G.stage + 1 < STAGES.length) startStage(G.stage + 1, false);
    else finish('¡VICTORIA!', 'Han derrotado al jefe.\nPuntuacion total: ' + G.players.reduce((a, p) => a + p.score, 0));
  }

  /** Un paso de simulación (1/60 s). */
  function step() {
    if (G.phase === 'done') return;
    G.t++;
    if (G.phase === 'intro' || G.phase === 'clear' || G.phase === 'over') for (const p of G.players) if (!p.bot) { p.q.length = 0; p.ack = p.rx; }   // fuera de juego no se acumulan comandos
    if (G.phase === 'intro') { if (--G.phaseT <= 0) { G.phase = 'play'; G.goT = 50; } updateFx(); return; }
    if (G.phase === 'clear') { G.phaseT--; updateFx(); for (const b of G.bombs) b.timer = 9999; if (G.phaseT <= 0) afterClear(); return; }
    if (G.phase === 'over') {
      G.overT++; updateFx(); for (const p of G.players) p.deadT++;
      if (G.overT > 130) finish('GAME OVER', 'Llegaron a la etapa ' + (G.stage + 1) + '\nPuntuacion: ' + G.players.reduce((a, p) => a + p.score, 0));
      return;
    }
    if (G.goT > 0) G.goT--;
    if (G.exitCd > 0) G.exitCd--;
    G.time--;
    for (const p of G.players) updatePlayer(p);
    for (const b of G.bombs) if (!b.dead) updateBomb(b);
    G.bombs = G.bombs.filter(b => !b.dead);
    updateBlocks();
    updateFx();
    if (G.mode === 'battle' && opts.sudden && G.time <= 60 * 60) {
      if (!G.sudden) { G.sudden = true; G.sdMsg = 120; sfx('thud'); }
      if (--G.sdT <= 0 && G.spiralIdx < G.spiral.length) { G.sdT = SD_INT; dropBlock(); }
    }
    if (G.sdMsg > 0) G.sdMsg--;
    for (const p of G.players) if (p.alive && G.fire[Math.floor(p.y / TS)][Math.floor(p.x / TS)] > 0) killPlayer(p);
    for (const e of G.enemies) updateEnemy(e);
    for (const p of G.players) {
      if (!p.alive) continue;
      for (const e of G.enemies) {
        if (e.dying) continue;
        const c = ecenter(e), eh = e.s * TS * .5 * .78;
        if (Math.abs(c[0] - p.x) < eh + HALF * .8 && Math.abs(c[1] - p.y) < eh + HALF * .8) killPlayer(p);
      }
    }
    if (G.mode === 'battle') {
      const alive = G.players.filter(p => p.alive);
      if (G.time <= 0) finishRound(null);
      else if (alive.length <= 1) { if (!G.endT) G.endT = 50; else if (--G.endT <= 0) finishRound(alive[0] || null); } else G.endT = 0;
    } else {
      if (G.time <= 0) { for (const p of G.players) killPlayer(p, true); G.time = 1; }
      const live = G.enemies.filter(e => !e.dying).length, ex = G.exit;
      if (ex && ex.rev && live === 0) {
        ex.open = true;
        for (const p of G.players) if (p.alive && Math.floor(p.x / TS) === ex.x && Math.floor(p.y / TS) === ex.y) { stageClear(p); break; }
      } else if (ex) ex.open = false;
      if (G.coop && G.phase === 'play' && G.t % 120 === 0 && G.players.some(isOut) && G.players.some(q => !isOut(q))) ensureLifeItem();
      if (G.players.every(p => !p.alive && p.lives <= 0) && G.phase === 'play') { G.phase = 'over'; G.overT = 0; }
    }
  }

  /* ---------- Interfaz hacia server.js ---------- */
  function setInput(sid, d) {
    const p = G.players.find(q => q.sid === sid && !q.bot); if (!p || !d || !Array.isArray(d.c)) return;
    const s0 = d.s | 0, n = Math.min(d.c.length, 16);
    for (let k = 0; k < n; k++) {
      const seq = s0 + k; if (seq <= p.rx) continue;               // duplicado / ya recibido
      p.rx = seq;
      if (p.q.length < QMAX) p.q.push([seq, (d.c[k] | 0) & 31]);
    }
  }
  function removePlayer(sid) {
    const p = G.players.find(q => q.sid === sid); if (!p) return;
    p.left = true; p.sid = null; p.q.length = 0;
    if (G.mode !== 'battle') { p.lives = 0; if (p.alive && G.phase === 'play') killPlayer(p, true); }
  }
  const r1 = v => Math.round(v * 10);              // posiciones en decimas (entero): precision suficiente para reconciliar sin deriva
  const maskOf = b => { let m = 0; for (const q of b.ignore) m |= 1 << q.i; return m; };
  const bombRec = (b, withTimer) => [b.gx, b.gy, b.ox, b.oy, b.vx, b.vy, b.off, withTimer ? b.timer : 0, b.air ? b.air.t + 1 : 0, b.air ? b.air.sx : 0, b.air ? b.air.sy : 0, maskOf(b), b.owner ? b.owner.i : -1].join(',');
  function snapshot() {
    const kf = G.snapN++ % KEYFRAME === 0, play = G.phase === 'play';
    const P = {};
    // [x*10,y*10,dir,alive,mv,shield,invuln,bombs,range,lvl,kick,wins,placeT,mount,jumpT,lives,score,cd,cdMax, lastProcessedInput, dash]
    for (const p of G.players) P[p.i] = [r1(p.x), r1(p.y), Math.max(0, DIRN.indexOf(p.dir)), p.alive ? 1 : 0, p.mv ? 1 : 0, Math.min(999, p.shield | 0), Math.min(9999, p.invuln | 0),
      p.bombs, p.range, p.lvl, p.kick ? 1 : 0, p.wins, p.placeT > 0 ? p.placeT : 0, p.mount ? MK.indexOf(p.mount) + 1 : 0, p.jump ? p.jump.t + 1 : 0, p.lives, p.score, p.cd | 0, p.cdMax | 0, p.ack, p.dash ? 1 : 0];
    const st = {s: ++G.seq, t: G.t, ph: G.phase === 'done' ? 'clear' : G.phase, pt: G.phaseT, tm: G.time, rd: G.round, tg: G.target, sd: G.sdMsg, gt: G.goT, sg: G.stage, p: P};
    if (!play) { st.tx = G.introText || ''; st.sb = G.introSub || null; st.ct = G.clearText || null; }       // textos solo fuera de juego
    // bombas: solo se reenvian si cambian (la mecha la cuenta el cliente) o en keyframe
    const bk = G.bombs.map(b => bombRec(b, false)).join(';');
    if (kf || bk !== G.sentB) { G.sentB = bk; st.b = G.bombs.map(b => bombRec(b, true)).join(';'); }
    const yk = G.sblocks.map(k => [k.x, k.y, k.dx, k.dy, k.off].join(',')).join(';'); if (yk) st.yk = yk;
    // llamas: solo si aparecieron nuevas (el cliente las hace expirar solo) o en keyframe
    if (kf || G.fAdd !== G.sentF) { G.sentF = G.fAdd; st.f = G.flames.map(f => [f.x, f.y, f.t, f.kind].join(',')).join(';'); }
    if (G.enemies.length) st.e = G.enemies.map(e => [e.id, ETYPES.indexOf(e.type), e.ax, e.ay, e.dx, e.dy, +e.prog.toFixed(1), e.dying ? 1 : 0, e.dieT, e.hitT, e.hp, e.face]);
    if (G.exit && G.exit.rev) st.ex = [G.exit.x, G.exit.y, G.exit.open ? 1 : 0];
    if (G.ev.length) st.ev = G.ev.join(',');
    if (G.txq.length) st.xt = G.txq;
    G.ev = []; G.txq = [];
    return st;
  }
  function mapPayload() {
    let g = '', it = '';
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { g += G.grid[y][x]; it += G.items[y][x] ? ITC[G.items[y][x]] : '0'; }
    return {g, i: it, th: G.themeKey};
  }

  /* ---------- Arranque ---------- */
  G.players = cfg.players.map(makePlayer).sort((a, b) => a.i - b.i);
  if (coopMode) { G.target = 1; startStage(0, true); }
  else { G.target = [1, 2, 3][opts.rounds] || 1; startRound(); }
  return {
    G, step, snapshot, mapPayload, setInput, removePlayer,
    get finished() { return G.finished; },
    humans: () => G.players.filter(p => !p.bot && !p.left).length,
    playersInfo: () => G.players.map(p => ({i: p.i, name: p.name, ch: p.ch, bot: p.bot}))
  };
}

module.exports = {createGame, BATTLE_MAPS, STAGES};
