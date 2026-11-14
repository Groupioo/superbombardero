'use strict';
/* =====================================================================
   SUPER BOMBARDERO · Servidor dedicado (Express + Socket.io)
   - Sirve /public (index.html y recursos estáticos)
   - Gestiona salas: crear, listar, unirse, salir y cierre automático
   - Game loop autoritativo: física a 60 pasos/s fijos, snapshots a NET_HZ (30) por segundo
   - Solo WebSocket; el cliente predice su movimiento y el servidor confirma con lastProcessedInput
   - GET /health para monitoreo (Render Health Check / UptimeRobot)
===================================================================== */
const path = require('path');
const http = require('http');
const express = require('express');
const {Server} = require('socket.io');
const {createGame, BATTLE_MAPS} = require('./game');

const PORT = process.env.PORT || 3000;
const NET_HZ = Math.max(10, Math.min(60, +process.env.NET_HZ || 30));     // ticks de red por segundo (20-30 recomendado)
const SIM_DT = 1000 / 60;                                                  // paso fijo de física
const ROOM_IDLE_MS = 30 * 60 * 1000;                                       // sala en lobby sin actividad
const MAX_PLAYERS = {battle: 4, coop: 2};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {origin: process.env.CORS_ORIGIN || '*'},        // permite alojar index.html en otro dominio
  transports: ['websocket'],                              // sin HTTP long-polling (agrega latencia y CPU)
  perMessageDeflate: false, httpCompression: false,       // paquetes pequenos: comprimir cuesta mas CPU de lo que ahorra
  pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 1e4
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {extensions: ['html']}));
app.get('/health', (req, res) => {
  let players = 0; for (const r of rooms.values()) players += r.members.size;
  res.json({status: 'ok', uptime: Math.round(process.uptime()), rooms: rooms.size, players, tickRate: NET_HZ, node: process.version});
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------------------------------------------------------------
   Salas
   room = {code, mode, hostSid, members: Map(sid -> {sid,uid,name,nat,ch,slot}), meta, status, game, loop, last, touched}
--------------------------------------------------------------------- */
const rooms = new Map();
const sidRoom = new Map();           // sid -> code

const clean = (s, n) => String(s == null ? '' : s).replace(/[^\p{L}\p{N}_ .\-]/gu, '').slice(0, n);
const genCode = () => { for (let k = 0; k < 50; k++) { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; if (!rooms.has(s)) return s; } return null; };

function slotsOf(room) {
  const max = MAX_PLAYERS[room.mode], out = new Array(max).fill(null);
  for (const m of room.members.values()) out[m.slot] = {sid: m.sid, name: m.name, nat: m.nat, ch: m.ch};
  return out;
}
function lobbyPayload(room) {
  return {code: room.code, mode: room.mode, max: MAX_PLAYERS[room.mode], hostSid: room.hostSid, status: room.status, meta: room.meta, slots: slotsOf(room), last: room.last || ''};
}
function sendLobby(room) { io.to(room.code).emit('lobby', lobbyPayload(room)); }
function freeChar(room, pref) {
  const used = new Set(Array.from(room.members.values()).map(m => m.ch));
  if (pref >= 0 && pref < 4 && !used.has(pref)) return pref;
  for (let c = 0; c < 4; c++) if (!used.has(c)) return c;
  return 0;
}
function freeSlot(room) {
  const taken = new Set(Array.from(room.members.values()).map(m => m.slot));
  for (let i = 0; i < MAX_PLAYERS[room.mode]; i++) if (!taken.has(i)) return i;
  return -1;
}

function destroyRoom(room, reason) {
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  room.game = null;
  if (reason) io.to(room.code).emit('closed', {reason});
  for (const sid of room.members.keys()) {
    sidRoom.delete(sid);
    const s = io.sockets.sockets.get(sid); if (s) s.leave(room.code);
  }
  rooms.delete(room.code);
}

function leaveRoom(sid) {
  const code = sidRoom.get(sid); if (!code) return;
  sidRoom.delete(sid);
  const room = rooms.get(code); if (!room) return;
  room.members.delete(sid); room.touched = Date.now();
  const s = io.sockets.sockets.get(sid); if (s) s.leave(code);
  if (room.game) room.game.removePlayer(sid);
  if (room.members.size === 0) { destroyRoom(room); return; }                     // cierre automático: sala vacía
  if (room.hostSid === sid) room.hostSid = room.members.keys().next().value;       // el anfitrión se fue: pasa al siguiente
  if (room.status === 'play' && room.game && room.game.humans() === 0) { endGame(room, null); return; }
  sendLobby(room);
}

/* ---------------------------------------------------------------------
   Game loop autoritativo
--------------------------------------------------------------------- */
function startGame(room) {
  const humans = Array.from(room.members.values()).sort((a, b) => a.slot - b.slot);
  const ps = humans.map(m => ({i: m.slot, sid: m.sid, name: m.name, ch: m.ch}));
  if (room.mode === 'battle' && room.meta.bots) {
    const used = new Set(ps.map(p => p.ch));
    for (let i = 0; i < 4; i++) if (!ps.some(p => p.i === i)) { const ch = [0, 1, 2, 3].find(c => !used.has(c)); used.add(ch); ps.push({i, name: 'BOT ' + (i + 1), ch, bot: true}); }
  }
  room.game = createGame({mode: room.mode, players: ps, map: room.meta.map, rounds: room.meta.rounds, sudden: room.meta.sudden, items: room.meta.items, botSkill: 1});
  room.status = 'play'; room.last = '';
  io.to(room.code).emit('start', {mode: room.mode, players: room.game.playersInfo(), hz: NET_HZ});
  room.lastMap = ''; room.mapV = 0;
  let last = Date.now(), acc = 0;
  room.loop = setInterval(() => {
    const g = room.game; if (!g) return;
    const now = Date.now(); acc += Math.min(200, now - last); last = now;
    let n = 0;
    while (acc >= SIM_DT && n < 4) { g.step(); acc -= SIM_DT; n++; if (g.finished) break; }
    if (n >= 4) acc = 0;
    broadcast(room);
    if (g.finished) endGame(room, g.finished);
  }, 1000 / NET_HZ);
}
function broadcast(room) {
  const g = room.game; if (!g) return;
  const mp = g.mapPayload(), key = mp.g + mp.i + mp.th;
  if (key !== room.lastMap) { room.lastMap = key; mp.v = ++room.mapV; io.to(room.code).emit('map', mp); }   // el mapa solo se reenvía si cambia
  io.to(room.code).volatile.emit('state', g.snapshot());
}
function endGame(room, result) {
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  room.game = null; room.status = 'lobby'; room.touched = Date.now();
  room.last = result ? result.title + '\n' + result.text : '';
  if (result) io.to(room.code).emit('end', result);
  if (room.members.size) sendLobby(room);
}

/* ---------------------------------------------------------------------
   Eventos de Socket.io
--------------------------------------------------------------------- */
const ack = (cb, o) => { if (typeof cb === 'function') cb(o); };
function addMember(room, socket, d) {
  const slot = freeSlot(room); if (slot < 0) return null;
  const m = {sid: socket.id, uid: clean(d.uid, 64), name: clean(d.name, 16) || ('J' + (slot + 1)), nat: clean(d.nat, 20), ch: freeChar(room, d.ch | 0), slot};
  room.members.set(socket.id, m); sidRoom.set(socket.id, room.code); socket.join(room.code); room.touched = Date.now();
  return m;
}

io.on('connection', socket => {
  socket.on('p', cb => ack(cb, Date.now()));                                   // ping/RTT medido por el cliente

  socket.on('room:list', (d, cb) => {
    if (typeof d === 'function') cb = d;
    const list = [];
    for (const r of rooms.values()) {
      if (r.status !== 'lobby' || r.members.size >= MAX_PLAYERS[r.mode]) continue;
      const h = r.members.get(r.hostSid);
      list.push({code: r.code, mode: r.mode, count: r.members.size, max: MAX_PLAYERS[r.mode], host: h ? h.name : '?'});
    }
    ack(cb, {ok: true, rooms: list.slice(0, 30)});
  });

  socket.on('room:create', (d, cb) => {
    d = d || {};
    if (sidRoom.has(socket.id)) leaveRoom(socket.id);
    const mode = d.mode === 'coop' ? 'coop' : 'battle', code = genCode();
    if (!code) return ack(cb, {ok: false, error: 'SERVIDOR LLENO'});
    const room = {code, mode, hostSid: socket.id, members: new Map(), status: 'lobby', game: null, loop: null, last: '', touched: Date.now(),
      meta: {map: Math.min(BATTLE_MAPS.length - 1, Math.max(0, d.map | 0)), rounds: Math.min(2, Math.max(0, d.rounds | 0)), sudden: d.sudden !== false, items: Math.min(2, Math.max(0, d.items === undefined ? 1 : d.items | 0)), bots: false}};
    rooms.set(code, room); addMember(room, socket, d);
    ack(cb, {ok: true, code}); sendLobby(room);
  });

  socket.on('room:join', (d, cb) => {
    d = d || {};
    const code = String(d.code || '').toUpperCase().trim(), room = rooms.get(code);
    if (!room) return ack(cb, {ok: false, error: 'LA SALA NO EXISTE'});
    if (room.members.has(socket.id)) return ack(cb, {ok: true, code});
    if (room.status !== 'lobby') return ack(cb, {ok: false, error: 'LA PARTIDA YA COMENZO'});
    if (room.members.size >= MAX_PLAYERS[room.mode]) return ack(cb, {ok: false, error: 'SALA LLENA'});
    if (sidRoom.has(socket.id)) leaveRoom(socket.id);
    addMember(room, socket, d);
    ack(cb, {ok: true, code}); sendLobby(room);
  });

  socket.on('room:leave', () => leaveRoom(socket.id));

  socket.on('room:ch', d => {
    const room = rooms.get(sidRoom.get(socket.id)), m = room && room.members.get(socket.id);
    if (!m || room.status !== 'lobby' || !d) return;
    const c = d.ch | 0; if (c < 0 || c > 3) return;
    for (const o of room.members.values()) if (o !== m && o.ch === c) return;       // personaje ocupado
    m.ch = c; sendLobby(room);
  });

  socket.on('room:meta', d => {
    const room = rooms.get(sidRoom.get(socket.id));
    if (!room || room.hostSid !== socket.id || room.status !== 'lobby' || !d) return;
    const mt = room.meta;
    if (d.map !== undefined) mt.map = Math.min(BATTLE_MAPS.length - 1, Math.max(0, d.map | 0));
    if (d.rounds !== undefined) mt.rounds = Math.min(2, Math.max(0, d.rounds | 0));
    if (d.items !== undefined) mt.items = Math.min(2, Math.max(0, d.items | 0));
    if (d.sudden !== undefined) mt.sudden = !!d.sudden;
    if (d.bots !== undefined && room.mode === 'battle') mt.bots = !!d.bots;
    sendLobby(room);
  });

  socket.on('room:start', (d, cb) => {
    if (typeof d === 'function') cb = d;
    const room = rooms.get(sidRoom.get(socket.id));
    if (!room) return ack(cb, {ok: false, error: 'NO ESTAS EN UNA SALA'});
    if (room.hostSid !== socket.id) return ack(cb, {ok: false, error: 'SOLO EL ANFITRION PUEDE COMENZAR'});
    if (room.status !== 'lobby') return ack(cb, {ok: false, error: 'YA HAY UNA PARTIDA'});
    if (room.mode === 'battle' && room.members.size < 2 && !room.meta.bots) return ack(cb, {ok: false, error: 'NECESITAS AL MENOS 2 JUGADORES (O ACTIVA LOS BOTS)'});
    startGame(room); ack(cb, {ok: true});
  });

  /* Solo se reciben inputs: direccion + contadores de bomba/habilidad. La posicion la decide el servidor. */
  /* Lote de comandos numerados: {s: seq del primer comando, c: [cmd, cmd, ...]}. El servidor devuelve en cada snapshot
     el ultimo seq procesado de cada jugador (lastProcessedInput) para que el cliente reconcilie su prediccion. */
  socket.on('input', d => {
    if (!d || !Array.isArray(d.c)) return;
    const room = rooms.get(sidRoom.get(socket.id));
    if (room && room.game) room.game.setInput(socket.id, d);
  });

  socket.on('disconnect', () => leaveRoom(socket.id));
});

/* Cierre automatico de salas olvidadas en el lobby */
setInterval(() => {
  const now = Date.now();
  for (const r of Array.from(rooms.values())) if (r.status === 'lobby' && now - r.touched > ROOM_IDLE_MS) destroyRoom(r, 'SALA CERRADA POR INACTIVIDAD');
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log('Super Bombardero escuchando en el puerto ' + PORT + ' (red ' + NET_HZ + ' Hz, fisica 60 Hz)'));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { io.emit('closed', {reason: 'SERVIDOR REINICIANDOSE'}); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
