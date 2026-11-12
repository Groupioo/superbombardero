'use strict';
/* =====================================================================
   Super Bombardero - servidor de salas (WebSocket) para Render
   Solo gestiona salas y retransmite mensajes. El anfitrion (J1) ejecuta
   la simulacion del juego, igual que con el Worker de Cloudflare.
===================================================================== */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
// Opcional: ALLOWED_ORIGINS="https://tuweb.web.app,https://tujuego.onrender.com" (vacio = permite todos)
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_ROOMS = 300;
const MAX_MSG_PER_SEC = 200;
const IDLE_MS = 30000;
const CODE_RE = /^[A-Z2-9]{4}$/;

const rooms = new Map();

/* ---------- HTTP (health check para Render / UptimeRobot) ---------- */
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Super Bombardero server OK'); return; }
  res.writeHead(404); res.end();
});
httpServer.keepAliveTimeout = 120000;
httpServer.headersTimeout = 125000;

/* perMessageDeflate desactivado: la compresion añade latencia y no ayuda con mensajes pequeños */
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { socket.destroy(); return; }
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (ALLOWED.length && !(origin && ALLOWED.includes(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  try { socket.setNoDelay(true); } catch (e) {}
  const code = String(u.searchParams.get('room') || '').toUpperCase();
  const create = u.searchParams.get('create') === '1';
  wss.handleUpgrade(req, socket, head, ws => { ws.roomCode = code; ws.create = create; wss.emit('connection', ws, req); });
});

/* ---------- Utilidades ---------- */
const clampInt = (v, lo, hi, def) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (def === undefined ? lo : def); };
const num = v => { v = Number(v); return Number.isFinite(v) ? v : 0; };

function cleanOpts(o) {
  o = o || {};
  return {
    map: clampInt(o.map, 0, 6, 0), rounds: clampInt(o.rounds, 0, 2, 0), sudden: o.sudden === undefined ? true : !!o.sudden,
    items: clampInt(o.items, 0, 2, 1), bots: !!o.bots, status: 'lobby', last: ''
  };
}
function applyMeta(meta, p) {
  if (p.map !== undefined) meta.map = clampInt(p.map, 0, 6, meta.map);
  if (p.rounds !== undefined) meta.rounds = clampInt(p.rounds, 0, 2, meta.rounds);
  if (p.items !== undefined) meta.items = clampInt(p.items, 0, 2, meta.items);
  if (p.sudden !== undefined) meta.sudden = !!p.sudden;
  if (p.bots !== undefined) meta.bots = !!p.bots;
}
function sendRaw(ws, s) { if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} } }
const send = (ws, o) => sendRaw(ws, JSON.stringify(o));
function fail(ws, msg) {
  try { ws.send(JSON.stringify({ t: 'err', msg }), () => { try { ws.close(); } catch (e) {} }); } catch (e) { try { ws.terminate(); } catch (x) {} }
}
function broadcastLobby(room) {
  const s = JSON.stringify({ t: 'lobby', players: room.players, slots: room.slots, meta: room.meta });
  for (const c of room.conns.values()) sendRaw(c, s);
}

/* ---------- Entrada / salida de jugadores ---------- */
function onHello(ws, m) {
  if (ws.joined || ws.joining) return;
  const code = ws.roomCode;
  if (!CODE_RE.test(code)) return fail(ws, 'CODIGO INVALIDO');
  const uid = String(m.uid || '').slice(0, 80);
  if (!uid) return fail(ws, 'USUARIO INVALIDO');
  const name = String(m.name || 'JUGADOR').slice(0, 16), nat = String(m.nat || '').slice(0, 24);
  let room = rooms.get(code);
  if (ws.create) {
    if (room) return fail(ws, 'ESA SALA YA EXISTE');
    if (rooms.size >= MAX_ROOMS) return fail(ws, 'SERVIDOR LLENO, INTENTA EN UN RATO');
    room = { code, meta: cleanOpts(m.opts), players: {}, slots: [null, null, null, null], conns: new Map(), hostUid: uid };
    rooms.set(code, room);
  } else if (!room) return fail(ws, 'LA SALA NO EXISTE');

  let slot = room.slots.indexOf(uid);
  if (slot >= 0) {
    // Mismo usuario reconectando: toma el lugar de la conexion anterior
    const old = room.conns.get(uid);
    if (old && old !== ws) { old.joined = false; try { old.close(); } catch (e) {} }
  } else {
    if (room.meta.status === 'play') return fail(ws, 'LA PARTIDA YA EMPEZO');
    slot = room.slots.indexOf(null);
    if (slot < 0) return fail(ws, 'SALA LLENA (MAXIMO 4)');
    room.slots[slot] = uid;
    const used = Object.values(room.players).map(p => p.ch);
    let ch = clampInt(m.ch, 0, 3, 0);
    if (used.includes(ch)) { const f = [0, 1, 2, 3].find(c => !used.includes(c)); ch = f === undefined ? 0 : f; }
    room.players[uid] = { name, nat, ch };
  }
  ws.room = room; ws.uid = uid; ws.joined = true; room.conns.set(uid, ws);
  send(ws, { t: 'welcome', slot, host: uid === room.hostUid });
  broadcastLobby(room);
}

function removeConn(ws) {
  const room = ws.room;
  if (!room || room.conns.get(ws.uid) !== ws) return;
  room.conns.delete(ws.uid);
  if (ws.uid === room.hostUid) {
    // Sin anfitrion no hay simulacion: se cierra la sala
    for (const c of room.conns.values()) { send(c, { t: 'closed' }); c.joined = false; try { c.close(); } catch (e) {} }
    room.conns.clear(); rooms.delete(room.code); return;
  }
  const i = room.slots.indexOf(ws.uid); if (i >= 0) room.slots[i] = null;
  delete room.players[ws.uid];
  if (!room.conns.size) rooms.delete(room.code); else broadcastLobby(room);
}

/* ---------- Mensajes ---------- */
function relay(room, from, raw, droppable) {
  for (const c of room.conns.values()) {
    if (c === from || c.readyState !== 1) continue;
    if (droppable && c.bufferedAmount > 65536) continue;   // cliente lento: se salta el estado viejo en vez de acumular lag
    try { c.send(raw); } catch (e) {}
  }
}
function onMessage(ws, m, raw) {
  const room = ws.room, isHost = ws.uid === room.hostUid, meta = room.meta;
  switch (m.t) {
    case 'ping': send(ws, { t: 'pong' }); break;
    case 'leave': removeConn(ws); try { ws.close(); } catch (e) {} break;
    case 'in': {
      if (isHost || !m.d || typeof m.d !== 'object') break;
      const h = room.conns.get(room.hostUid), d = m.d;
      if (h) sendRaw(h, JSON.stringify({ t: 'in', uid: ws.uid, d: { dx: num(d.dx), dy: num(d.dy), b: num(d.b), x: num(d.x), y: num(d.y), d: num(d.d), m: num(d.m), q: num(d.q) } }));
      break;
    }
    case 'state': if (isHost) relay(room, ws, raw, true); break;
    case 'map': if (isHost) relay(room, ws, raw, false); break;
    case 'ch': {
      if (meta.status !== 'lobby') break;
      const ch = clampInt(m.ch, 0, 3, -1); if (ch < 0) break;
      const taken = Object.keys(room.players).some(u => u !== ws.uid && room.players[u].ch === ch);
      if (taken) { broadcastLobby(room); break; }
      room.players[ws.uid].ch = ch; broadcastLobby(room); break;
    }
    case 'meta': if (isHost && meta.status === 'lobby') { applyMeta(meta, m); broadcastLobby(room); } break;
    case 'start': if (isHost && meta.status === 'lobby') { meta.status = 'play'; meta.last = ''; broadcastLobby(room); } break;
    case 'end': if (isHost && meta.status === 'play') { meta.status = 'lobby'; meta.last = String(m.last || '').slice(0, 400); broadcastLobby(room); } break;
  }
}

wss.on('connection', ws => {
  ws.lastSeen = Date.now(); ws.joined = false; ws.winT = ws.lastSeen; ws.winN = 0;
  const helloTimer = setTimeout(() => { if (!ws.joined) ws.terminate(); }, 8000);
  ws.on('pong', () => { ws.lastSeen = Date.now(); });
  ws.on('error', () => {});
  ws.on('close', () => { clearTimeout(helloTimer); if (ws.joined) removeConn(ws); });
  ws.on('message', (data, isBinary) => {
    const now = Date.now(); ws.lastSeen = now;
    if (isBinary) return;
    if (now - ws.winT >= 1000) { ws.winT = now; ws.winN = 0; }
    if (++ws.winN > MAX_MSG_PER_SEC) { ws.terminate(); return; }
    const raw = data.toString();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!ws.joined) { if (m.t === 'hello') onHello(ws, m); return; }
    onMessage(ws, m, raw);
  });
});

/* Detecta conexiones muertas (ping de protocolo cada 10 s, cierra tras 30 s sin respuesta) */
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.lastSeen > IDLE_MS) { ws.terminate(); continue; }
    try { ws.ping(); } catch (e) {}
  }
}, 10000);

httpServer.listen(PORT, '0.0.0.0', () => console.log('Super Bombardero server escuchando en el puerto ' + PORT));

process.on('SIGTERM', () => {
  for (const ws of wss.clients) { try { ws.close(1001, 'reinicio'); } catch (e) {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
