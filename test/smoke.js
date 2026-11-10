const WebSocket = require('ws');
const URL = `ws://localhost:${process.env.PORT || 3000}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => new Promise((r) => {
  const ws = new WebSocket(URL); ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  ws.on('open', () => r(ws));
});
const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
const tx = (ws, m) => ws.send(JSON.stringify(m));
const assert = (c, msg) => { if (!c) { console.error('FALLÓ:', msg); process.exit(1); } console.log('ok -', msg); };

(async () => {
  const host = await open(); tx(host, { t: 'host:create' }); await wait(300);
  const created = last(host, 'host:created');
  assert(created && created.code.length === 4 && created.qr.startsWith('<svg'), 'sala creada con código y QR');

  const players = [];
  for (const n of ['Ana', 'Beto', 'Cami', 'Dani', 'Eli']) {
    const p = await open(); tx(p, { t: 'player:join', code: created.code, name: n }); players.push(p);
  }
  await wait(300);
  assert(last(host, 'state').players.length === 5, '5 jugadores en el lobby');

  const dup = await open(); tx(dup, { t: 'player:join', code: created.code, name: 'ana' }); await wait(200);
  assert(last(dup, 'error').code === 'NAME_TAKEN', 'rechaza nombres repetidos');

  tx(host, { t: 'host:start' }); await wait(300);
  const roles = players.map((p) => last(p, 'you:role').role);
  const count = (r) => roles.filter((x) => x === r).length;
  assert(count('gnosia') === 1 && count('engineer') === 1 && count('crew') === 3, 'roles repartidos según la tabla (1/1/3)');
  assert(!JSON.stringify(last(host, 'state')).includes('"role"'), 'el estado público no filtra roles');
  assert(last(host, 'state').phase === 'ROLE_REVEAL', 'fase ROLE_REVEAL iniciada');

  const again = await open();
  tx(again, { t: 'player:resume', code: created.code, token: last(players[0], 'player:joined').token }); await wait(200);
  assert(last(again, 'you:role').role === roles[0], 'la reconexión recupera el rol');

  const late = await open(); tx(late, { t: 'player:join', code: created.code, name: 'Tarde' }); await wait(200);
  assert(last(late, 'error').code === 'GAME_STARTED', 'no se puede entrar con la partida iniciada');
  process.exit(0);
})();
