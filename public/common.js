(function () {
  const PHASE_LABEL = {
    LOBBY: 'Esperando jugadores',
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
    gnosia: { name: 'Gnosia', hint: 'Elimina tripulantes sin que te descubran.' },
    engineer: { name: 'Ingeniero', hint: 'Cada noche podrás investigar a un jugador.' },
    crew: { name: 'Tripulante', hint: 'Debate y vota para encontrar a los Gnosia.' },
  };

  let skew = 0;
  const syncClock = (state) => { skew = state.now - Date.now(); };
  const remaining = (endsAt) => Math.max(0, Math.ceil((endsAt - (Date.now() + skew)) / 1000));
  const fmtTime = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  function renderRoster(ul, players, myId) {
    ul.replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === myId ? ' (tú)' : '');
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
      lines.push(r.eliminated ? r.eliminated + ' fue puesto en hibernación.' : 'Empate o sin votos: nadie fue eliminado.');
      return lines;
    }
    if (r.kind === 'dawn') return [r.victim ? r.victim + ' no despertó.' : 'Amaneció y todos siguen con vida.'];
    if (r.kind === 'end') {
      return [r.winner === 'humans' ? 'Ganan los humanos.' : 'Ganan los Gnosia.']
        .concat(r.roles.map((x) => x.name + ': ' + ROLE[x.role].name + (x.alive ? '' : ' (eliminado)')));
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

  window.Gnosia = { PHASE_LABEL, PHASE_HINT, ROLE, renderResult, syncClock, remaining, fmtTime, renderRoster, connect };
})();
