(function () {
  const PHASE_LABEL = {
    LOBBY: 'Esperando jugadores',
    ROLE_REVEAL: 'Revisen su rol en el celular',
    DEBATE: 'Debate',
    VOTE: 'Votación',
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

  window.Gnosia = { PHASE_LABEL, ROLE, syncClock, remaining, fmtTime, renderRoster, connect };
})();
