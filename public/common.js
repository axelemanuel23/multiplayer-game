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

  // Nombres de rol por defecto (los del tema "infectados"). El tema activo los reemplaza.
  const DEFAULT_ROLE_NAMES = {
    gnosia: 'Infectado', engineer: 'Ingeniero', guardian: 'Oficial de Bioseguridad', doctor: 'Doctor', crew: 'Tripulante',
  };
  const ROLE = {};
  for (const k of Object.keys(DEFAULT_ROLE_NAMES)) ROLE[k] = { name: DEFAULT_ROLE_NAMES[k], hint: '' };

  // Textos fijos de la interfaz por defecto (copia de "ui" en content/temas/infectados.json).
  // Se usa en el lobby y si el servidor no manda tema.
  const DEFAULT_UI = {
    "lugar_etiqueta": "En la nave",
    "victoria": {
      "humans": "Ganan los sanos.",
      "gnosia": "Ganan los infectados."
    },
    "eliminado_fallback": "{nombre} fue puesto en cuarentena.",
    "sin_eliminado_fallback": "Empate o sin votos: nadie fue aislado.",
    "amanecer_victima_fallback": "{nombre} no despertó.",
    "amanecer_sin_victima_fallback": "Amaneció y todos siguen con vida.",
    "estado_eliminado": " (eliminado)",
    "pregunta_voto": "¿A quién pones en cuarentena?",
    "pregunta_noche": {
      "gnosia": "¿A quién atacas esta noche?",
      "engineer": "¿A quién analizas?",
      "guardian": "¿A quién proteges?",
      "doctor": "¿A qué eliminado examinas?",
      "crew": "¿Cerca de quién haces ronda?"
    },
    "pista_rol": {
      "gnosia": "Ataca de noche sin que te descubran.",
      "engineer": "Cada noche podrás analizar a un jugador.",
      "guardian": "Cada noche puedes sellar la cabina de un jugador.",
      "doctor": "Cada noche puedes examinar a un eliminado.",
      "crew": "Debate y vota para encontrar a los infectados."
    },
    "informe": {
      "investigate_malo": "{nombre} está infectado.",
      "investigate_bueno": "{nombre} está sano.",
      "examine_malo": "{nombre} estaba infectado.",
      "examine_bueno": "{nombre} estaba sano.",
      "protect": "protegiste a {nombre}.",
      "attack": "atacaste a {nombre}.",
      "reveal_sent": "le dijiste a {nombre} que eres {rol}.",
      "revealed": "{nombre} te reveló que es {rol}."
    },
    "proteger_confirmacion": "Sellaste la cabina de {nombre}.",
    "ronda_con_nombre": "Hiciste una ronda cerca de {nombre}. No notaste nada extraño.",
    "ronda_sin_nombre": "Hiciste tu ronda. No notaste nada extraño.",
    "sin_fallecidos": "Todavía no hay fallecidos para examinar.",
    "observador": "Fuiste eliminado. Sigue la partida como observador.",
    "soy": "Soy {rol}",
    "fases": {},
    "colores": {
      "malo": "#ff5d7a"
    }
  };

  let UI = DEFAULT_UI;
  const ui = () => UI;
  const tpl = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  const phaseLabel = (p) => (UI.fases && UI.fases[p]) || PHASE_LABEL[p] || p;

  // Aplica el tema que llega en cada "state": textos de interfaz, nombres de rol y color del bando oculto.
  function applyTheme(state) {
    UI = (state.theme && state.theme.ui) || DEFAULT_UI;
    const names = state.roleNames || DEFAULT_ROLE_NAMES;
    for (const k of Object.keys(ROLE)) {
      if (names[k]) ROLE[k].name = names[k];
      ROLE[k].hint = (UI.pista_rol && UI.pista_rol[k]) || '';
    }
    const root = document.documentElement.style;
    const c = UI.colores && UI.colores.malo;
    if (c) root.setProperty('--foe', c); else root.removeProperty('--foe');
  }
  applyTheme({});

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
      lines.push(r.text || (r.eliminated ? tpl(UI.eliminado_fallback, { nombre: r.eliminated }) : UI.sin_eliminado_fallback));
      return lines;
    }
    if (r.kind === 'dawn') return [r.text || (r.victim ? tpl(UI.amanecer_victima_fallback, { nombre: r.victim }) : UI.amanecer_sin_victima_fallback)];
    if (r.kind === 'end') {
      const lines = [UI.victoria[r.winner === 'humans' ? 'humans' : 'gnosia']];
      if (r.text) lines.push(r.text);
      return lines.concat(r.roles.map((x) => x.name + ': ' + ROLE[x.role].name + (x.alive ? '' : UI.estado_eliminado)));
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
    const v = { nombre: r.name, rol: r.claim && ROLE[r.claim] ? ROLE[r.claim].name : '' };
    const inf = UI.informe || {};
    let key = r.kind;
    if (r.kind === 'investigate') key = r.isGnosia ? 'investigate_malo' : 'investigate_bueno';
    else if (r.kind === 'examine') key = r.isGnosia ? 'examine_malo' : 'examine_bueno';
    return inf[key] ? n + tpl(inf[key], v) : '';
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
        // Tema activo: textos de interfaz y nombres de rol (Infectado / Sicario, etc.).
        if (m.t === 'state') applyTheme(m);
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

  window.Gnosia = { PHASE_LABEL, PHASE_HINT, ROLE, ui, tpl, phaseLabel, renderResult, describeReport, syncClock, remaining, fmtTime, renderRoster, connect };
})();
