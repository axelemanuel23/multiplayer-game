(function () {
  const PHASE_LABEL = {
    LOBBY: 'Esperando jugadores',
    GUIA: 'Cómo se juega',
    ROLE_REVEAL: 'Revisen su rol en el celular',
    DEBATE: 'Debate',
    VOTE: 'Votación',
    VOTE_RESULT: 'Resultado de la votación',
    NIGHT: 'Es de noche',
    DAWN: 'Amanece',
    GAME_OVER: 'Fin de la partida',
  };

  const PHASE_HINT = {
    VOTE: 'Voten desde el celular.',
    NIGHT: 'Cada jugador actúa en su celular.',
  };

  const ROLE = {
    gnosia: { name: 'Infectado', hint: 'Ataca de noche sin que te descubran.' },
    engineer: { name: 'Ingeniero', hint: 'Cada noche podrás analizar a un jugador.' },
    guardian: { name: 'Oficial de Bioseguridad', hint: 'Cada noche puedes sellar la cabina de un jugador.' },
    doctor: { name: 'Doctor', hint: 'Cada noche puedes examinar a un eliminado.' },
    crew: { name: 'Tripulante', hint: 'Debate y vota para encontrar a los infectados.' },
    // Tripulante verificado como sano, visible para todos (no es un rol interno: se marca con verified).
    vigia: { name: 'Vigía', hint: 'Nunca estuviste expuesto y todos lo saben. Sin habilidad, pero tu palabra pesa.' },
  };

  let skew = 0;
  const syncClock = (state) => { skew = state.now - Date.now(); };
  const remaining = (endsAt) => Math.max(0, Math.ceil((endsAt - (Date.now() + skew)) / 1000));
  const fmtTime = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  function renderRoster(ul, players, myId) {
    ul.replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === myId ? ' (tú)' : '') + (p.verified ? ' ✓' : '');
      if (p.verified) { li.classList.add('verified'); li.title = ROLE.vigia.name + ': verificado sano'; }
      if (!p.connected) li.classList.add('off');
      if (!p.alive) li.classList.add('out');
      return li;
    }));
  }

  // Texto público del resultado de una fase (votación, amanecer o fin de partida).
  function describeResult(r) {
    if (!r) return [];
    if (r.kind === 'vote') {
      const lines = r.rows.map((x) => x.name + ': ' + x.voters.length + (x.voters.length === 1 ? ' voto' : ' votos') + ' (' + x.voters.join(', ') + ')');
      if (r.abstained) lines.push('Sin votar: ' + r.abstained);
      lines.push(r.text || (r.eliminated ? r.eliminated + ' fue puesto en cuarentena.' : 'Empate o sin votos: nadie fue aislado.'));
      return lines;
    }
    if (r.kind === 'dawn') return [r.text || (r.victim ? r.victim + ' no despertó.' : 'Amaneció y todos siguen con vida.')];
    if (r.kind === 'end') {
      const lines = [r.winner === 'humans' ? 'Ganan los sanos.' : 'Ganan los infectados.'];
      if (r.text) lines.push(r.text);
      return lines.concat(r.roles.map((x) => x.name + ': ' + (x.verified ? ROLE.vigia : ROLE[x.role]).name + (x.alive ? '' : ' (eliminado)')));
    }
    return [];
  }

  function renderResult(el, result) {
    el.replaceChildren(...describeResult(result).map((t, i) => {
      const p = document.createElement('p');
      p.textContent = t;
      if (i === 0 && result.kind === 'end') p.className = 'verdict';
      return p;
    }));
  }

  // Línea de texto de un informe privado (Ingeniero, Doctor, Guardián, Gnosia).
  function describeReport(r) {
    const n = 'Noche ' + r.night + ': ';
    if (r.kind === 'investigate') return n + r.name + (r.isGnosia ? ' está infectado.' : ' está sano.');
    if (r.kind === 'examine') return n + r.name + (r.isGnosia ? ' estaba infectado.' : ' estaba sano.');
    if (r.kind === 'protect') return n + 'protegiste a ' + r.name + '.';
    if (r.kind === 'attack') return n + 'atacaste a ' + r.name + '.';
    if (r.kind === 'reveal_sent') return n + 'le dijiste a ' + r.name + ' que eres ' + ROLE[r.claim].name + '.';
    if (r.kind === 'revealed') return n + r.name + ' te reveló que es ' + ROLE[r.claim].name + '.';
    return '';
  }

  const MODE_LABEL = { primera: 'Primera partida', estandar: 'Estándar', aleatoria: 'Roles aleatorios' };

  // Vista previa de un modo en el lobby: qué roles tendría con la cantidad de jugadores actual.
  function previewText(pv) {
    if (!pv) return '';
    const inf = pv.infected + (pv.infected === 1 ? ' infectado' : ' infectados');
    if (pv.azar) return inf + ' + ' + pv.azar.k + (pv.azar.k === 1 ? ' rol' : ' roles') + ' al azar entre ' + pv.azar.pool.map((r) => ROLE[r].name).join(', ');
    const parts = [inf].concat(pv.roles.map((r) => ROLE[r].name));
    if (pv.vigias) parts.push(pv.vigias + (pv.vigias === 1 ? ' Vigía' : ' Vigías'));
    parts.push(pv.crew + (pv.crew === 1 ? ' Tripulante' : ' Tripulantes'));
    return parts.join(' · ') + (pv.igualEstandar ? ' (igual al estándar)' : '');
  }

  // Texto público con la composición de roles de la partida.
  function compText(state) {
    return state.composition
      ? 'En la nave: ' + Object.entries(state.composition).filter(([, n]) => n > 0).map(([r, n]) => ROLE[r].name + ' ×' + n).join(' · ') : '';
  }

  // Texto público con los Vigías (verificados sanos) de la partida; vacío si no hay.
  function vigiaText(state) {
    const v = state.players.filter((p) => p.verified);
    if (!state.composition || !v.length) return '';
    return (v.length === 1 ? 'Vigía verificado sano: ' : 'Vigías verificados sanos: ') + v.map((p) => p.name + (p.alive ? '' : ' (eliminado)')).join(', ');
  }

  // Conexión WebSocket con reconexión automática.
  function connect({ onOpen, onMessage }) {
    const conn = document.getElementById('conn');
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    let ws, tries = 0;
    const api = { send: (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } };

    function open() {
      ws = new WebSocket(url);
      ws.onopen = () => { tries = 0; conn.classList.remove('off'); onOpen(api); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        // Nombres de rol temáticos que envía el servidor (Infectado, Oficial de Bioseguridad…).
        if (m.t === 'state' && m.roleNames) for (const k of Object.keys(m.roleNames)) if (ROLE[k]) ROLE[k].name = m.roleNames[k];
        onMessage(m, api);
      };
      ws.onclose = () => {
        conn.classList.add('off');
        setTimeout(open, Math.min(1000 * ++tries, 5000));
      };
    }
    open();
    return api;
  }

  window.Gnosia = { MODE_LABEL, previewText, compText, vigiaText, PHASE_LABEL, PHASE_HINT, ROLE, renderResult, describeReport, syncClock, remaining, fmtTime, renderRoster, connect };
})();
