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
  6: { gnosia: 1, engineer: 1, guardian: 1, crew: 3 },
  7: { gnosia: 2, engineer: 1, guardian: 1, crew: 3 },
  8: { gnosia: 2, engineer: 1, guardian: 1, doctor: 1, crew: 3 },
  9: { gnosia: 2, engineer: 1, guardian: 1, doctor: 1, crew: 4 },
  10: { gnosia: 3, engineer: 1, guardian: 1, doctor: 1, crew: 4 },
  11: { gnosia: 3, engineer: 1, guardian: 1, doctor: 1, crew: 5 },
  12: { gnosia: 3, engineer: 1, guardian: 1, doctor: 1, crew: 6 },
};

// Duración de cada fase (null = sin temporizador).
const DURATION = {
  ROLE_REVEAL: 15000, DEBATE: 120000, VOTE: 45000, VOTE_RESULT: 10000,
  NIGHT: 40000, DAWN: 10000, GAME_OVER: null,
};

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

// Dirección base para el QR: PUBLIC_URL si existe; si no, la misma dirección con la que se abrió la pantalla común.
function baseUrl(ws) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const h = (ws && ws.req && ws.req.headers) || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  if (!host || local || !/^[a-z0-9.\-:]+$/i.test(host)) return `http://${lanIp()}:${PORT}`;
  return `${proto}://${host}`;
}

async function joinInfo(room, ws) {
  const base = baseUrl(ws);
  const joinUrl = `${base}/play?sala=${room.code}`;
  return { joinUrl, qr: await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }) };
}

// ---------- estado de sala ----------
function createRoom() {
  const room = {
    code: newCode(), hostToken: token(), hostWs: null,
    players: new Map(), // id -> { id, name, token, ws, role, alive, investigation }
    phase: 'LOBBY', phaseEndsAt: null, timer: null, result: null,
    votes: new Map(), night: null, nights: 0, last: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const aliveList = (room) => [...room.players.values()].filter((p) => p.alive);

function winner(room) {
  const a = aliveList(room);
  const g = a.filter((p) => p.role === 'gnosia').length;
  if (g === 0) return 'humans';
  if (g >= a.length - g) return 'gnosia';
  return null;
}

// Estado PÚBLICO: es lo único que ven la pantalla común y los demás jugadores.
// Los roles solo aparecen al terminar la partida (result.kind === 'end').
function publicState(room) {
  return {
    t: 'state', code: room.code, phase: room.phase, phaseEndsAt: room.phaseEndsAt, now: Date.now(),
    min: MIN_PLAYERS, max: MAX_PLAYERS, result: room.result,
    progress: room.phase === 'VOTE' ? { done: room.votes.size, total: aliveList(room).length } : null,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, connected: !!p.ws, alive: p.alive })),
  };
}

function broadcast(room) {
  const s = publicState(room);
  send(room.hostWs, s);
  for (const p of room.players.values()) send(p.ws, s);
}

function setPhase(room, phase, result = null) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.result = result;
  const ms = DURATION[phase];
  room.phaseEndsAt = ms ? Date.now() + ms : null;
  if (ms) room.timer = setTimeout(() => advance(room), ms);
  if (phase === 'VOTE') room.votes = new Map();
  if (phase === 'NIGHT') {
    room.nights += 1;
    room.night = { acted: new Set(), attacks: new Map(), protected: new Set() };
  }
  broadcast(room);
  if (phase === 'NIGHT') for (const p of aliveList(room)) sendNight(room, p);
}

function advance(room) {
  switch (room.phase) {
    case 'ROLE_REVEAL': return setPhase(room, 'DEBATE');
    case 'DEBATE': return setPhase(room, 'VOTE');
    case 'VOTE': return resolveVote(room);
    case 'VOTE_RESULT': { const w = winner(room); return w ? endGame(room, w) : setPhase(room, 'NIGHT'); }
    case 'NIGHT': return resolveNight(room);
    case 'DAWN': { const w = winner(room); return w ? endGame(room, w) : setPhase(room, 'DEBATE'); }
    default: return undefined;
  }
}

// Gana la mayoría simple; empate o sin votos = nadie es eliminado.
function resolveVote(room) {
  const tally = new Map();
  for (const [voterId, targetId] of room.votes) {
    if (targetId === 'skip') continue;
    if (!tally.has(targetId)) tally.set(targetId, []);
    tally.get(targetId).push(room.players.get(voterId).name);
  }
  const rows = [...tally].map(([id, voters]) => ({ id, name: room.players.get(id).name, voters }))
    .sort((a, b) => b.voters.length - a.voters.length);
  const abstained = aliveList(room).length - [...room.votes.values()].filter((t) => t !== 'skip').length;
  let eliminated = null;
  if (rows.length && (rows.length === 1 || rows[0].voters.length > rows[1].voters.length)) {
    eliminated = rows[0].name;
    room.players.get(rows[0].id).alive = false;
  }
  setPhase(room, 'VOTE_RESULT', { kind: 'vote', rows: rows.map(({ name, voters }) => ({ name, voters })), eliminated, abstained });
}

// Los Gnosia eligen víctima (pluralidad; empate al azar). Sin elección = nadie cae.
function resolveNight(room) {
  const counts = new Map();
  for (const t of room.night.attacks.values()) counts.set(t, (counts.get(t) || 0) + 1);
  let victim = null;
  if (counts.size) {
    const max = Math.max(...counts.values());
    const top = [...counts].filter(([, n]) => n === max).map(([id]) => id);
    const target = room.players.get(top[crypto.randomInt(top.length)]);
    if (!room.night.protected.has(target.id)) { victim = target; victim.alive = false; } // el Guardián frustra el ataque
  }
  setPhase(room, 'DAWN', { kind: 'dawn', victim: victim ? victim.name : null });
}

function endGame(room, w) {
  setPhase(room, 'GAME_OVER', {
    kind: 'end', winner: w,
    roles: [...room.players.values()].map((p) => ({ name: p.name, role: p.role, alive: p.alive })),
  });
}

function assignRoles(room) {
  const ps = [...room.players.values()];
  const deck = [];
  for (const [role, n] of Object.entries(ROLE_TABLE[ps.length])) for (let i = 0; i < n; i++) deck.push(role);
  shuffle(deck);
  room.nights = 0;
  ps.forEach((p, i) => { p.role = deck[i]; p.alive = true; p.reports = []; });
}

// Información PRIVADA: solo se envía al dueño.
function sendRole(room, p) {
  const msg = { t: 'you:role', role: p.role };
  if (p.role === 'gnosia') {
    msg.allies = [...room.players.values()].filter((o) => o.role === 'gnosia' && o.id !== p.id).map((o) => o.name);
  }
  send(p.ws, msg);
}

// Informe privado: queda guardado en el servidor (se recupera al reconectar) y se envía a su dueño.
function addReport(room, p, entry) {
  const report = { night: room.nights, ...entry };
  p.reports.push(report);
  send(p.ws, { t: 'you:report', report });
}

// Todos los vivos reciben una pantalla de noche (los Tripulantes, una acción señuelo) para no delatar roles.
function sendNight(room, p) {
  const others = aliveList(room).filter((o) => o.id !== p.id);
  const dead = [...room.players.values()].filter((o) => !o.alive);
  const targets = p.role === 'gnosia' ? others.filter((o) => o.role !== 'gnosia')
    : p.role === 'engineer' || p.role === 'guardian' ? others
      : p.role === 'doctor' ? dead : [];
  send(p.ws, { t: 'night:prompt', role: p.role, targets: targets.map((o) => ({ id: o.id, name: o.name })), acted: room.night.acted.has(p.id), night: room.nights });
}

const whoAmI = (ws) => {
  const c = ws.ctx;
  if (!c || c.kind !== 'player') return {};
  return { room: c.room, p: c.room.players.get(c.playerId) };
};
// ¿Ya votaron/actuaron todos los vivos que siguen conectados? (un celular caído no bloquea la fase)
function allIn(room) {
  const need = aliveList(room).filter((p) => p.ws);
  if (!need.length) return false;
  const done = room.phase === 'VOTE' ? (p) => room.votes.has(p.id) : (p) => room.night.acted.has(p.id);
  return need.every(done);
}
function closeIfAllIn(room) {
  if ((room.phase === 'VOTE' || room.phase === 'NIGHT') && allIn(room)) { advance(room); return true; }
  return false;
}

const hostRoom = (ws) => (ws.ctx && ws.ctx.kind === 'host' ? ws.ctx.room : null);

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
    if (p && p.ws === ws) { p.ws = null; if (!closeIfAllIn(c.room)) broadcast(c.room); }
  }
}

const handlers = {
  async 'host:create'(ws) {
    const room = createRoom();
    attachHost(ws, room);
    send(ws, { t: 'host:created', code: room.code, hostToken: room.hostToken, ...(await joinInfo(room, ws)) });
    send(ws, publicState(room));
  },

  async 'host:resume'(ws, m) {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room || room.hostToken !== m.hostToken) return fail(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');
    attachHost(ws, room);
    send(ws, { t: 'host:created', code: room.code, hostToken: room.hostToken, ...(await joinInfo(room, ws)) });
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
    setPhase(room, 'ROLE_REVEAL');
  },

  'host:skip'(ws) {
    const room = hostRoom(ws);
    if (!room) return fail(ws, 'FORBIDDEN', 'Solo la pantalla común puede hacerlo.');
    if (room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER') advance(room);
  },

  'host:reset'(ws) {
    const room = hostRoom(ws);
    if (!room) return fail(ws, 'FORBIDDEN', 'Solo la pantalla común puede hacerlo.');
    if (room.phase !== 'GAME_OVER') return fail(ws, 'BAD_PHASE', 'La partida no terminó.');
    for (const p of room.players.values()) { p.role = null; p.alive = true; p.reports = []; }
    room.nights = 0;
    setPhase(room, 'LOBBY');
  },

  'player:vote'(ws, m) {
    const { room, p } = whoAmI(ws);
    if (!p) return fail(ws, 'FORBIDDEN', 'No estás en una partida.');
    if (room.phase !== 'VOTE') return fail(ws, 'BAD_PHASE', 'No es momento de votar.');
    if (!p.alive) return fail(ws, 'DEAD', 'Estás fuera de la partida.');
    if (m.target !== 'skip') {
      const t = room.players.get(m.target);
      if (!t || !t.alive || t.id === p.id) return fail(ws, 'BAD_TARGET', 'Voto inválido.');
    }
    room.votes.set(p.id, m.target);
    send(ws, { t: 'vote:ack', target: m.target });
    if (allIn(room)) return advance(room); // todos votaron: se cierra antes
    broadcast(room);
  },

  'player:night'(ws, m) {
    const { room, p } = whoAmI(ws);
    if (!p) return fail(ws, 'FORBIDDEN', 'No estás en una partida.');
    if (room.phase !== 'NIGHT') return fail(ws, 'BAD_PHASE', 'No es de noche.');
    if (!p.alive) return fail(ws, 'DEAD', 'Estás fuera de la partida.');
    if (room.night.acted.has(p.id)) return fail(ws, 'ALREADY_ACTED', 'Ya elegiste esta noche.');
    const t = room.players.get(m.target);
    if (p.role === 'gnosia') {
      if (!t || !t.alive || t.role === 'gnosia') return fail(ws, 'BAD_TARGET', 'Objetivo inválido.');
      room.night.attacks.set(p.id, t.id);
      addReport(room, p, { kind: 'attack', name: t.name });
    } else if (p.role === 'engineer') {
      if (!t || !t.alive || t.id === p.id) return fail(ws, 'BAD_TARGET', 'Objetivo inválido.');
      addReport(room, p, { kind: 'investigate', name: t.name, isGnosia: t.role === 'gnosia' });
    } else if (p.role === 'guardian') {
      if (!t || !t.alive || t.id === p.id) return fail(ws, 'BAD_TARGET', 'Objetivo inválido.');
      room.night.protected.add(t.id);
      addReport(room, p, { kind: 'protect', name: t.name });
    } else if (p.role === 'doctor') {
      // El Doctor examina a un eliminado; si todavía no hay ninguno, la acción es un señuelo.
      if ([...room.players.values()].some((o) => !o.alive)) {
        if (!t || t.alive) return fail(ws, 'BAD_TARGET', 'Objetivo inválido.');
        addReport(room, p, { kind: 'examine', name: t.name, isGnosia: t.role === 'gnosia' });
      }
    }
    room.night.acted.add(p.id);
    send(ws, { t: 'night:ack' });
    if (allIn(room)) advance(room); // todos actuaron: amanece antes
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
    const p = { id: crypto.randomBytes(4).toString('hex'), name, token: token(), ws: null, role: null, alive: true, reports: [] };
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
    if (p.reports.length) send(ws, { t: 'you:reports', reports: p.reports });
    broadcast(room);
    if (room.phase === 'NIGHT' && p.alive) sendNight(room, p);
    if (room.phase === 'VOTE' && room.votes.has(p.id)) send(ws, { t: 'vote:ack', target: room.votes.get(p.id) });
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

wss.on('connection', (ws, req) => {
  ws.req = req;
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
