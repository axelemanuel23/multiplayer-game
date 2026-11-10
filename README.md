# Gnosia LAN

Pantalla común (PC) + celulares. El servidor es autoritativo: solo envía a cada cliente lo que le corresponde.

## Uso
```
npm install
npm start
```
1. Abre `http://localhost:3000/host` en la PC (pantalla común): aparece el QR y el código.
2. Los celulares (mismo Wi-Fi) escanean el QR o entran a `http://<IP-de-la-PC>:3000/play`.
3. Cuando haya al menos 4 jugadores, inicia desde la pantalla común.

Variables: `PORT` (3000) y `PUBLIC_URL` (si lo publicas en internet, para que el QR apunte al dominio).

## Protocolo (WebSocket `/ws`, mensajes JSON `{ t: tipo, ... }`)

| Dirección | Mensaje | Contenido |
|---|---|---|
| host → srv | `host:create` / `host:resume` | `{code, hostToken}` para retomar |
| host → srv | `host:start` | inicia la partida |
| jugador → srv | `player:join` | `{code, name}` |
| jugador → srv | `player:resume` | `{code, token}` |
| srv → host | `host:created` | `{code, hostToken, joinUrl, qr}` |
| srv → jugador | `player:joined` | `{code, playerId, token, name}` |
| srv → todos | `state` | estado PÚBLICO: fase, `phaseEndsAt`, `now`, jugadores (sin roles) |
| srv → jugador | `you:role` | PRIVADO: `{role, allies?}` |
| srv → cualquiera | `error` | `{code, message}` |

## Fases (esqueleto)
`LOBBY → ROLE_REVEAL (15 s) → DEBATE (120 s) → VOTE`

Pendiente: votación, noche con acciones por rol (con acción señuelo para todos), eliminaciones y condiciones de victoria. La tabla de roles está en `ROLE_TABLE` de `server.js`.
