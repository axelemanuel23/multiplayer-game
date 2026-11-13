const WebSocket = require('ws');
const URL = `ws://localhost:${process.env.PORT || 3000}/ws`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => new Promise((r) => {
  const ws = new WebSocket(URL); ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  ws.on('open', () => r(ws));
});
const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
const all = (ws, t) => ws.msgs.filter((m) => m.t === t);
const tx = (ws, m) => ws.send(JSON.stringify(m));
const assert = (c, msg) => { if (!c) { console.error('FALLÓ:', msg); process.exit(1); } console.log('ok -', msg); };

async function newGame(names, opts = {}) {
  const host = await open(); tx(host, { t: 'host:create' }); await wait(250);
  const code = last(host, 'host:created').code;
  const ps = [];
  for (const n of names) { const p = await open(); tx(p, { t: 'player:join', code, name: n }); ps.push(p); }
  await wait(250);
  tx(host, { t: 'host:start', guide: false, ...(opts.mode ? { mode: opts.mode } : {}) }); await wait(250);
  // La Primera partida siempre muestra la guía: se salta para llegar a los roles.
  if (last(host, 'state').phase === 'GUIA') { tx(host, { t: 'host:skip' }); await wait(250); }
  const g = { host, code, ps, names };
  g.role = (i) => last(ps[i], 'you:role').role;
  g.id = (i) => last(ps[i], 'player:joined').playerId;
  g.state = () => last(host, 'state');
  g.skip = async () => { tx(host, { t: 'host:skip' }); await wait(200); };
  g.toVote = async () => { await g.skip(); await g.skip(); };
  g.send = async (i, m) => { tx(ps[i], m); await wait(60); };
  return g;
}

(async () => {
  const names = ['Ana', 'Beto', 'Cami', 'Dani', 'Eli'];

  // --- Lobby, roles, composición pública, reconexión ---
  let g = await newGame(names);
  const roles = names.map((_, i) => g.role(i));
  const count = (r) => roles.filter((x) => x === r).length;
  assert(count('gnosia') === 1 && count('engineer') === 1 && count('crew') === 3, 'roles según la tabla (1/1/3)');
  assert(g.state().composition.gnosia === 1 && g.state().composition.engineer === 1, 'la composición de roles es pública');
  assert(!JSON.stringify(g.state()).includes('"role"'), 'el estado público no filtra roles de jugadores');
  const stories = names.map((_, i) => last(g.ps[i], 'you:role').story);
  assert(stories.every((x) => typeof x === 'string' && x.length > 40 && !/[{}]/.test(x)), 'cada jugador recibe su narrativa personal, sin marcadores sin reemplazar');
  assert(g.state().story && !/[{}]/.test(g.state().story) && g.state().roleNames.gnosia === 'Infectado', 'narrativa general pública y nombres de rol temáticos');
  const again = await open();
  tx(again, { t: 'player:resume', code: g.code, token: last(g.ps[0], 'player:joined').token }); await wait(200);
  assert(last(again, 'you:role').role === roles[0], 'la reconexión recupera el rol');
  g.ps[0] = again;

  // --- Día 1: los humanos votan al Gnosia y ganan ---
  await g.toVote(); assert(g.state().phase === 'VOTE', 'fase de votación');
  const gi = roles.indexOf('gnosia');
  for (let i = 0; i < 5; i++) tx(g.ps[i], { t: 'player:vote', target: i === gi ? 'skip' : g.id(gi) });
  await wait(300);
  assert(g.state().result.eliminated === names[gi] && /\S/.test(g.state().result.text), 'todos votaron: se cierra y elimina al Gnosia (con texto narrativo)');
  await g.skip();
  assert(g.state().phase === 'GAME_OVER' && g.state().result.winner === 'humans' && /\S/.test(g.state().result.text), 'ganan los humanos (con texto narrativo)');
  tx(g.host, { t: 'host:reset' }); await wait(200);
  assert(g.state().phase === 'LOBBY' && g.state().composition === null, 'nueva partida vuelve al lobby');

  // --- Noche con 5: tiempo fijo, ronda señuelo, cambio de elección del Gnosia ---
  g = await newGame(names);
  const r2 = names.map((_, i) => g.role(i));
  const G = r2.indexOf('gnosia'), E = r2.indexOf('engineer');
  const crew = r2.map((r, i) => (r === 'crew' ? i : -1)).filter((i) => i >= 0);
  await g.toVote();
  for (let i = 0; i < 5; i++) tx(g.ps[i], { t: 'player:vote', target: 'skip' });
  await wait(300); await g.skip();
  assert(g.state().phase === 'NIGHT', 'VOTE_RESULT → NIGHT');
  const prompts = names.map((_, i) => last(g.ps[i], 'night:prompt'));
  assert(prompts.every((p) => p && p.revealTargets.length === 4), 'todos reciben el mismo menú de noche');
  assert(prompts[crew[0]].targets.length === 4, 'el Tripulante tiene acción señuelo (ronda)');
  assert(prompts[G].claims.length === 2 && prompts[G].claims.includes('engineer'), 'el Gnosia puede declarar roles que existen en la partida');
  assert(prompts[E].claims.length === 1 && prompts[E].claims[0] === 'engineer', 'el humano solo puede declarar su rol real');
  await g.send(G, { t: 'player:night', target: g.id(crew[0]) });
  await g.send(G, { t: 'player:night', target: g.id(crew[1]) }); // cambia de opinión
  await g.send(E, { t: 'player:night', target: g.id(G) });
  for (const c of crew) await g.send(c, { t: 'player:night', target: g.id(E) });
  await wait(200);
  assert(g.state().phase === 'NIGHT', 'la noche NO se cierra antes aunque todos hayan actuado');
  assert(last(g.ps[E], 'you:report').report.isGnosia === true, 'el Ingeniero descubre al Gnosia');
  await g.send(crew[2], { t: 'player:night', target: g.id(E) });
  assert(last(g.ps[crew[2]], 'error').code === 'ALREADY_ACTED', 'las acciones de un solo uso no se repiten');
  await g.skip();
  assert(g.state().phase === 'DAWN' && g.state().result.victim === names[crew[1]] && g.state().result.text.includes(names[crew[1]]), 'amanece: cae la última elección del Gnosia (con texto narrativo)');
  assert(last(g.ps[G], 'you:report').report.kind === 'attack' && last(g.ps[G], 'you:report').report.name === names[crew[1]], 'el Gnosia conserva su informe de ataque');
  const back = await open();
  tx(back, { t: 'player:resume', code: g.code, token: last(g.ps[E], 'player:joined').token }); await wait(200);
  assert(last(back, 'you:reports').reports.length === 1, 'al reconectar, el Ingeniero recupera su informe');

  // --- 10 jugadores: Vigía, intenciones, revelaciones, Guardián y Doctor ---
  const n8 = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9', 'J10'];
  g = await newGame(n8);
  const r8 = n8.map((_, i) => g.role(i));
  const idx = (r) => r8.map((x, i) => (x === r ? i : -1)).filter((i) => i >= 0);
  const [G1, G2] = idx('gnosia'), GD = idx('guardian')[0], DR = idx('doctor')[0], EN = idx('engineer')[0], cr = idx('crew');
  assert(idx('gnosia').length === 2 && GD !== undefined && DR !== undefined && cr.length === 5, 'tabla estándar de 10: 2 Infectados, Guardián, Doctor, Ingeniero y 5 Tripulantes');
  const vs = g.state().players.filter((p) => p.verified);
  assert(vs.length === 1 && cr.map((i) => n8[i]).includes(vs[0].name), 'con 10 hay 1 Vigía público y es un Tripulante (nunca un infectado)');
  assert(g.state().composition.crew === 4 && g.state().composition.vigia === 1, 'la composición pública separa al Vigía de los Tripulantes');
  assert(last(g.ps[n8.indexOf(vs[0].name)], 'you:role').verified === true && last(g.ps[G1], 'you:role').verified === false, 'solo el Vigía recibe la marca verified en su rol');
  assert(!g.ps[G1].msgs.some((m) => m.t === 'night:prompt' && m.claims && m.claims.includes('vigia')), 'los infectados no pueden declararse Vigía');

  // Día 1 sin eliminados → noche 1
  await g.toVote();
  for (let i = 0; i < 10; i++) tx(g.ps[i], { t: 'player:vote', target: 'skip' });
  await wait(300); await g.skip();

  // Intención de ataque visible para el aliado
  await g.send(G1, { t: 'player:night', target: g.id(cr[0]) });
  assert(last(g.ps[G2], 'ally:intents').intents.find((x) => x.name === n8[G1]).target === n8[cr[0]], 'el aliado ve la intención de ataque en vivo');
  await g.send(G2, { t: 'player:night', target: g.id(cr[0]) });
  await g.send(GD, { t: 'player:night', target: g.id(cr[0]) });
  await g.send(EN, { t: 'player:night', target: g.id(cr[1]) });
  for (const c of cr) await g.send(c, { t: 'player:night', target: g.id(GD) });

  // Revelaciones: el humano no puede mentir; los infectados sí (y pueden repetir el mismo rol)
  await g.send(EN, { t: 'player:reveal', target: g.id(GD), claim: 'doctor' }); // intenta mentir: el servidor lo corrige
  await g.send(GD, { t: 'player:reveal', target: g.id(EN), claim: 'guardian' });
  await g.send(G1, { t: 'player:reveal', target: g.id(cr[1]), claim: 'gnosia' });
  assert(last(g.ps[G1], 'error').code === 'BAD_CLAIM', 'un infectado no puede declararse infectado');
  await g.send(G1, { t: 'player:reveal', target: g.id(cr[1]), claim: 'engineer' });
  await g.send(G2, { t: 'player:reveal', target: g.id(cr[1]), claim: 'engineer' });
  await g.send(G1, { t: 'player:reveal', target: g.id(cr[2]), claim: 'doctor' });
  assert(last(g.ps[G1], 'error').code === 'ALREADY_ACTED', 'una sola acción social por noche');
  assert(!last(g.ps[GD], 'you:report') || last(g.ps[GD], 'you:report').report.kind !== 'revealed', 'las revelaciones no llegan antes del amanecer');
  await g.skip();
  assert(g.state().phase === 'DAWN' && g.state().result.victim === null, 'el Guardián frustra el ataque');
  const got = all(g.ps[cr[1]], 'you:report').map((m) => m.report).filter((r) => r.kind === 'revealed');
  assert(got.length === 2 && got.every((r) => r.claim === 'engineer'), 'dos infectados pueden adjudicarse el mismo rol');
  assert(all(g.ps[GD], 'you:report').some((m) => m.report.kind === 'revealed' && m.report.claim === 'engineer'), 'el rol real del humano llega aunque intentó otro');

  // Día 2: intención de voto entre aliados; eliminan a un Tripulante
  await g.skip(); await g.skip();
  const out = cr[2];
  await g.send(G1, { t: 'player:vote', target: g.id(out) });
  assert(last(g.ps[G2], 'ally:intents').kind === 'vote' && last(g.ps[G2], 'ally:intents').intents.find((x) => x.name === n8[G1]).target === n8[out], 'el aliado ve la intención de voto en vivo');
  for (let i = 0; i < 10; i++) if (i !== G1) tx(g.ps[i], { t: 'player:vote', target: i === out ? 'skip' : g.id(out) });
  await wait(300);
  assert(g.state().result.eliminated === n8[out], 'día 2: se elimina a un Tripulante');
  await g.skip(); await wait(100);
  assert(last(g.ps[DR], 'night:prompt').targets.some((x) => x.name === n8[out]), 'el Doctor ve a los eliminados como objetivos');
  await g.send(DR, { t: 'player:night', target: g.id(out) });
  const exam = last(g.ps[DR], 'you:report').report;
  assert(exam.kind === 'examine' && exam.night === 2 && exam.isGnosia === false, 'el Doctor examina al eliminado (era humano)');

  // --- Narrativas generales: no se repiten en partidas seguidas ---
  g = await newGame(names);
  const seen = new Set();
  for (let k = 0; k < 7; k++) {
    if (k > 0) { tx(g.host, { t: 'host:start', guide: false }); await wait(250); }
    seen.add(g.state().story);
    const rs = names.map((_, i) => g.role(i));
    const gx = rs.indexOf('gnosia');
    await g.toVote();
    for (let i = 0; i < 5; i++) tx(g.ps[i], { t: 'player:vote', target: i === gx ? 'skip' : g.id(gx) });
    await wait(300); await g.skip();
    tx(g.host, { t: 'host:reset' }); await wait(200);
  }
  assert(seen.size === 7, '7 partidas seguidas usan 7 narrativas generales distintas');

  // --- Tabla completa: sin roles especiales con 4, Vigías según la tabla ---
  const expected = { 4: [1, 0, 0, 0, 0], 5: [1, 1, 0, 0, 0], 6: [1, 1, 0, 0, 0], 7: [2, 1, 1, 0, 0], 8: [2, 1, 1, 0, 0], 9: [2, 1, 1, 0, 0], 10: [2, 1, 1, 1, 1], 11: [3, 1, 1, 1, 2], 12: [3, 1, 1, 1, 2] };
  for (const n of Object.keys(expected).map(Number)) {
    const nm = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
    g = await newGame(nm);
    const rr = nm.map((_, i) => g.role(i));
    const c = (r) => rr.filter((x) => x === r).length;
    const got = [c('gnosia'), c('engineer'), c('doctor'), c('guardian'), g.state().players.filter((p) => p.verified).length];
    assert(JSON.stringify(got) === JSON.stringify(expected[n]) && c('crew') === n - got[0] - got[1] - got[2] - got[3], `tabla de ${n}: infectados/ingeniero/doctor/guardián/vigías = ${got.join('/')}`);
    const vnames = g.state().players.filter((p) => p.verified).map((p) => p.name);
    assert(vnames.every((v) => rr[nm.indexOf(v)] === 'crew'), `con ${n} los Vigías son siempre Tripulantes`);
  }

  // --- Guía introductoria: solo la pantalla común, saltable, sin roles hasta terminarla ---
  async function lobbyOf(nm) {
    const host = await open(); tx(host, { t: 'host:create' }); await wait(250);
    const code = last(host, 'host:created').code; const ps = [];
    for (const n of nm) { const p = await open(); tx(p, { t: 'player:join', code, name: n }); ps.push(p); }
    await wait(250);
    return { host, code, ps };
  }
  {
    const L = await lobbyOf(names);
    tx(L.host, { t: 'host:start' }); await wait(250);
    let st = last(L.host, 'state');
    assert(st.phase === 'GUIA' && st.guide && st.guide.step === 0 && st.guide.total >= 5 && st.phaseEndsAt === null, 'con guía: la partida arranca en GUIA, sin temporizador');
    assert(L.ps.every((p) => !last(p, 'you:role')), 'durante la guía los celulares aún no reciben su rol');
    assert(st.composition && st.composition.gnosia === 1 && st.story === null, 'durante la guía la composición ya es pública, pero no la narrativa');
    tx(L.host, { t: 'host:guide', dir: 'prev' }); await wait(150);
    assert(last(L.host, 'state').guide.step === 0, 'no se puede retroceder antes de la primera página');
    tx(L.ps[0], { t: 'host:guide', dir: 'next' }); await wait(150);
    assert(last(L.ps[0], 'error').code === 'FORBIDDEN' && last(L.host, 'state').guide.step === 0, 'un celular no puede avanzar la guía');
    const total = st.guide.total; const titles = [st.guide.titulo]; const lines = [...st.guide.lineas];
    for (let i = 1; i < total; i++) {
      tx(L.host, { t: 'host:guide', dir: 'next' }); await wait(120);
      st = last(L.host, 'state');
      assert(st.phase === 'GUIA' && st.guide.step === i, `guía: página ${i + 1} de ${total}`);
      titles.push(st.guide.titulo); lines.push(...st.guide.lineas);
    }
    assert(titles.some((t) => /Ingeniero/.test(t)) && titles.some((t) => /Infectado/.test(t)), 'la guía explica los roles que hay en la partida');
    assert(!titles.some((t) => /Doctor|Bioseguridad|Vigía/.test(t)), 'con 5 jugadores la guía no explica roles que no existen');
    assert(lines.concat(titles).every((x) => !/[{}]/.test(x)) && /\S/.test(lines[0]), 'la guía no tiene marcadores sin reemplazar');
    assert(!JSON.stringify(st).includes('"role"'), 'la guía no filtra roles de jugadores');
    // reconexión en medio de la guía: sigue sin recibir el rol
    const mid = await open();
    tx(mid, { t: 'player:resume', code: L.code, token: last(L.ps[0], 'player:joined').token }); await wait(200);
    assert(!last(mid, 'you:role') && last(mid, 'state').phase === 'GUIA', 'reconectar durante la guía no revela el rol antes de tiempo');
    tx(L.host, { t: 'host:guide', dir: 'next' }); await wait(250);
    assert(last(L.host, 'state').phase === 'ROLE_REVEAL' && last(mid, 'you:role') && last(L.ps[1], 'you:role'), 'al terminar la guía empieza la lectura de roles y llegan los roles');
  }
  {
    const n10 = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9', 'J10'];
    const L = await lobbyOf(n10);
    tx(L.host, { t: 'host:start' }); await wait(250);
    const total = last(L.host, 'state').guide.total; const titles = [last(L.host, 'state').guide.titulo];
    for (let i = 1; i < total; i++) { tx(L.host, { t: 'host:guide', dir: 'next' }); await wait(100); titles.push(last(L.host, 'state').guide.titulo); }
    assert(['Ingeniero', 'Doctor', 'Bioseguridad', 'Vigía', 'Infectado'].every((r) => titles.some((t) => t.includes(r))), 'con 10 jugadores la guía incluye Ingeniero, Doctor, Guardián, Vigía e Infectado');
    // saltar la guía entera
    const L2 = await lobbyOf(names);
    tx(L2.host, { t: 'host:start' }); await wait(250);
    tx(L2.host, { t: 'host:skip' }); await wait(250);
    assert(last(L2.host, 'state').phase === 'ROLE_REVEAL' && L2.ps.every((p) => last(p, 'you:role')), 'saltar la guía pasa directo a la lectura de roles');
    tx(L2.host, { t: 'host:skip' }); await wait(200);
    assert(last(L2.host, 'state').phase === 'DEBATE', 'después de saltar la guía el flujo sigue normal');
  }

  // --- Modos de partida: Primera partida, Estándar y Roles aleatorios ---
  const nmN = (n) => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
  const compOf = (gm, nm) => {
    const rr = nm.map((_, i) => gm.role(i));
    const c = (r) => rr.filter((x) => x === r).length;
    const vig = gm.state().players.filter((p) => p.verified);
    return { got: [c('gnosia'), c('engineer'), c('doctor'), c('guardian'), vig.length], plain: c('crew') - vig.length, vig, rr };
  };
  {
    // Vista previa en el lobby (sin sortear nada) y modo inválido = estándar
    const L5 = await lobbyOf(names);
    const pv = last(L5.host, 'state').preview;
    assert(pv && pv.primera.infected === 1 && pv.primera.roles.join() === 'engineer,doctor,guardian' && pv.estandar.roles.join() === 'engineer' && pv.aleatoria.azar.k === 1 && !pv.aleatoria.azar.pool.includes('vigia'),
      'el lobby muestra la vista previa de los tres modos (con 5: sin Vigía en el pool del sorteo)');
    const L3 = await lobbyOf(['Ana', 'Beto', 'Cami']);
    assert(last(L3.host, 'state').preview === null, 'con menos del mínimo de jugadores no hay vista previa');
    const L10 = await lobbyOf(nmN(10));
    assert(last(L10.host, 'state').preview.aleatoria.igualEstandar === true, 'con 10 o más, el modo aleatorio se muestra como igual al estándar');
    tx(L5.host, { t: 'host:start', mode: 'primera', guide: false }); await wait(250);
    assert(last(L5.host, 'state').phase === 'GUIA' && last(L5.host, 'state').mode === 'primera' && last(L5.host, 'state').preview === null, 'la Primera partida muestra la guía aunque se pida sin ella (y sin vista previa en juego)');
    g = await newGame(names, { mode: 'xyz' });
    assert(g.state().mode === 'estandar', 'un modo desconocido cae en el estándar');
  }
  const primeraT = { 4: [1, 1, 0, 0, 1], 5: [1, 1, 1, 1, 0], 6: [1, 1, 1, 1, 1], 7: [2, 1, 1, 1, 1], 8: [2, 1, 1, 1, 2], 9: [2, 1, 1, 1, 2], 10: [2, 1, 1, 1, 2], 11: [2, 1, 1, 1, 1], 12: [2, 1, 1, 1, 1] };
  for (const n of Object.keys(primeraT).map(Number)) {
    const nm = nmN(n);
    g = await newGame(nm, { mode: 'primera' });
    const { got, plain, vig, rr } = compOf(g, nm);
    assert(JSON.stringify(got) === JSON.stringify(primeraT[n]) && plain >= 1 && vig.every((v) => rr[nm.indexOf(v.name)] === 'crew'),
      `Primera partida con ${n}: infectados/ing/doc/gua/vigías = ${got.join('/')} y al menos un Tripulante común`);
  }
  // Roles aleatorios: restricciones por cantidad y variedad entre partidas
  const REGLA = { 4: [1, 1, false], 5: [1, 1, false], 6: [1, 1, false], 7: [2, 3, true], 8: [2, 3, true], 9: [2, 2, true] };
  for (const n of [4, 5, 6, 7, 8, 9]) {
    const nm = nmN(n); const seenKeys = new Set(); let ok = true; let always = true;
    for (let k = 0; k < 8; k++) {
      g = await newGame(nm, { mode: 'aleatoria' });
      const { got, plain } = compOf(g, nm);
      const [inf, roles, conVigia] = REGLA[n];
      const nRoles = got[1] + got[2] + got[3] + got[4];
      if (got[0] !== inf || nRoles !== roles || plain < 1 || (!conVigia && got[4] !== 0)) ok = false;
      seenKeys.add(got.join('/'));
    }
    assert(ok, `Roles aleatorios con ${n}: siempre ${REGLA[n][0]} infectado(s) y ${REGLA[n][1]} rol(es)${REGLA[n][2] ? '' : ' (sin Vigía)'}, con un Tripulante común`);
    assert(seenKeys.size >= 2, `Roles aleatorios con ${n}: la composición cambia entre partidas`);
  }
  for (const n of [10, 11, 12]) {
    const nm = nmN(n);
    g = await newGame(nm, { mode: 'aleatoria' });
    const { got } = compOf(g, nm);
    assert(JSON.stringify(got) === JSON.stringify({ 10: [2, 1, 1, 1, 1], 11: [3, 1, 1, 1, 2], 12: [3, 1, 1, 1, 2] }[n]), `Roles aleatorios con ${n} = estándar (${got.join('/')})`);
  }

  // --- Pausa ---
  g = await newGame(names);
  await g.toVote();
  tx(g.host, { t: 'host:pause' }); await wait(200);
  const paused = g.state();
  assert(paused.paused === true && paused.phaseEndsAt === null && paused.remainingMs > 0, 'la pausa congela el tiempo restante');
  await g.send(0, { t: 'player:vote', target: 'skip' });
  assert(last(g.ps[0], 'error').code === 'PAUSED', 'en pausa no se puede votar');
  await g.skip();
  assert(g.state().phase === 'VOTE', 'en pausa no se puede saltar la fase');
  await wait(1200);
  assert(g.state().remainingMs === paused.remainingMs, 'el tiempo no corre durante la pausa');
  tx(g.host, { t: 'host:resume' }); await wait(200);
  const resumed = g.state();
  assert(resumed.paused === false && Math.abs((resumed.phaseEndsAt - resumed.now) - paused.remainingMs) < 1500, 'al reanudar sigue con el tiempo que quedaba');
  await g.send(0, { t: 'player:vote', target: 'skip' });
  assert(last(g.ps[0], 'vote:ack'), 'al reanudar se puede votar de nuevo');

  // --- Un celular caído no bloquea la votación ---
  g = await newGame(names);
  await g.toVote();
  g.ps[4].close(); await wait(200);
  for (let i = 0; i < 4; i++) tx(g.ps[i], { t: 'player:vote', target: 'skip' });
  await wait(300);
  assert(g.state().phase === 'VOTE_RESULT', 'con un jugador desconectado, la votación cierra con los conectados');
  process.exit(0);
})();
