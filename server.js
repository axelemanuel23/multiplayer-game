'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // ej: https://mijuego.com (si no, se usa la IP local)
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;

// Tabla de roles según cantidad de jugadores (editable).
const ROLE_TABLE = {
  4: { gnosia: 1, engineer: 1, crew: 2 },
  5: { gnosia: 1, engineer: 1, crew: 3 },
  6: { gnosia: 1, engineer: 1, crew: 4 },
  7: { gnosia: 2, engineer: 1, crew: 4 },
  8: { gnosia: 2, engineer: 1, crew: 5 },
  9: { gnosia: 2, engineer: 1, crew: 6 },
  10: { gnosia: 3, engineer: 1, crew: 6 },
  11: { gnosia: 3, engineer: 1, crew: 7 },
  12: { gnosia: 3, engineer: 1, crew: 8 },
};

// Flujo de fases. La duración null = sin temporizador (fin del esqueleto por ahora).
const FLOW = ['ROLE_REVEAL', 'DEBATE', 'VOTE'];
const DURATION = { ROLE_REVEAL: 15000, DEBATE: 120000, VOTE: null };

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- utilidades ----------
const token = () => crypto.randomBytes(16).toString('hex');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const fail = (ws, code, message) => send(ws, { t: 'error', code, message });

function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

async function joinInfo(room) {
  const base = PUBLIC_URL || `http://${lanIp()}:${PORT}`;
  const joinUrl = `${base}/play?sala=${room.code}`;
  return { joinUrl, qr: await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }) };
}

// ---------- estado de sala ----------
function createRoom() {
  const room = {
    code: newCode(),
    hostToken: token(),
    hostWs: null,
    players: new Map(), // id -> { id, name, token, ws, role, alive }
    phase: 'LOBBY',
    phaseEndsAt: null,
    timer: null,
    last: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

// Estado PÚBLICO: es lo único que ven la pantalla común y los demás jugadores. Nunca incluye roles.
function publicState(room) {
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    now: Date.now(),
    min: MIN_PLAYERS,
    max: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: !!p.ws, alive: p.alive,
    })),
  };
}

function broadcast(room) {
  const s = publicState(room);
  send(room.hostWs, s);
  for (const p of room.players.values()) send(p.ws, s);
}

function setPhase(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  const ms = DURATION[phase];
  room.phaseEndsAt = ms ? Date.now() + ms : null;
  if (ms) room.timer = setTimeout(() => advance(room), ms);
  broadcast(room);
}

function advance(room) {
  const next = FLOW[FLOW.indexOf(room.phase) + 1];
  if (next) setPhase(room, next);
}

function assignRoles(room) {
  const ps = [...room.players.values()];
  const deck = [];
  for (const [role, n] of Object.entries(ROLE_TABLE[ps.length])) {
    for (let i = 0; i < n; i++) deck.push(role);
  }
  shuffle(deck);
  ps.forEach((p, i) => { p.role = deck[i]; p.alive = true; });
}

// Información PRIVADA: solo se envía al dueño del rol.
function sendRole(room, p) {
  const msg = { t: 'you:role', role: p.role };
  if (p.role === 'gnosia') {
    msg.allies = [...room.players.values()].filter((o) => o.role === 'gnosia' && o.id !== p.id).map((o) => o.name);
  }
  send(p.ws, msg);
}

// ---------- conexiones ----------
function attachHost(ws, room) {
  if (room.hostWs && room.hostWs !== ws) room.hostWs.close();
  room.hostWs = ws;
  ws.ctx = { kind: 'host', room };
}

function attachPlayer(ws, room, p) {
  if (p.ws && p.ws !== ws) p.ws.close();
  p.ws = ws;
  ws.ctx = { kind: 'player', room, playerId: p.id };
}

function detach(ws) {
  const c = ws.ctx;
  if (!c) return;
  if (c.kind === 'host' && c.room.hostWs === ws) c.room.hostWs = null;
  if (c.kind === 'player') {
    const p = c.room.players.get(c.playerId);
    if (p && p.ws === ws) { p.ws = null; broadcast(c.room); }
  }
}

const handlers = {
  async 'host:create'(ws) {
    const room = createRoom();
    attachHost(ws, room);
    send(ws, { t: 'host:created', code: room.code, hostToken: room.hostToken, ...(await joinInfo(room)) });
    send(ws, publicState(room));
  },

  async 'host:resume'(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room || room.hostToken !== m.hostToken) return fail(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');
    attachHost(ws, room);
    send(ws, { t: 'host:created', code: room.code, hostToken: room.hostToken, ...(await joinInfo(room)) });
    send(ws, publicState(room));
  },

  'host:start'(ws) {
    const c = ws.ctx;
    if (!c || c.kind !== 'host') return fail(ws, 'FORBIDDEN', 'Solo la pantalla común puede iniciar.');
    const room = c.room;
    if (room.phase !== 'LOBBY') return fail(ws, 'BAD_PHASE', 'La partida ya empezó.');
    if (room.players.size < MIN_PLAYERS) return fail(ws, 'NOT_ENOUGH', `Hacen falta al menos ${MIN_PLAYERS} jugadores.`);
    assignRoles(room);
    for (const p of room.players.values()) sendRole(room, p);
    setPhase(room, FLOW[0]);
  },

  'player:join'(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) return fail(ws, 'ROOM_NOT_FOUND', 'Código de sala incorrecto.');
    if (room.phase !== 'LOBBY') return fail(ws, 'GAME_STARTED', 'La partida ya empezó.');
    if (room.players.size >= MAX_PLAYERS) return fail(ws, 'ROOM_FULL', 'La sala está llena.');
    const name = String(m.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
    if (!name) return fail(ws, 'BAD_NAME', 'Escribe un nombre.');
    const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return fail(ws, 'NAME_TAKEN', 'Ese nombre ya está en uso.');
    const p = { id: crypto.randomBytes(4).toString('hex'), name, token: token(), ws: null, role: null, alive: true };
    room.players.set(p.id, p);
    room.last = Date.now();
    attachPlayer(ws, room, p);
    send(ws, { t: 'player:joined', code: room.code, playerId: p.id, token: p.token, name: p.name });
    broadcast(room);
  },

  'player:resume'(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && [...room.players.values()].find((x) => x.token === m.token);
    if (!p) return fail(ws, 'SESSION_LOST', 'No se pudo retomar tu sesión.');
    attachPlayer(ws, room, p);
    send(ws, { t: 'player:joined', code: room.code, playerId: p.id, token: p.token, name: p.name });
    if (p.role) sendRole(room, p);
    broadcast(room);
  },
};

// ---------- HTTP (archivos estáticos) ----------
const FILES = {
  '/host': ['host.html', 'text/html; charset=utf-8'],
  '/play': ['play.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/') { res.writeHead(302, { Location: '/host' }); return res.end(); }
  const entry = FILES[pathname];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
  fs.readFile(path.join(__dirname, 'public', entry[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const h = m && Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : null;
    if (!h) return fail(ws, 'UNKNOWN_MESSAGE', 'Mensaje desconocido.');
    try { await h(ws, m); } catch (e) { console.error(e); fail(ws, 'INTERNAL', 'Error interno.'); }
  });
  ws.on('close', () => detach(ws));
});

// Latido: detecta celulares que perdieron conexión sin cerrar el socket.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

// Limpieza de salas abandonadas (3 horas sin conexiones).
setInterval(() => {
  for (const [code, room] of rooms) {
    const alive = room.hostWs || [...room.players.values()].some((p) => p.ws);
    if (!alive && Date.now() - room.last > 3 * 3600 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pantalla común: http://localhost:${PORT}/host`);
  console.log(`Los celulares entran por: http://${lanIp()}:${PORT}/play`);
});
