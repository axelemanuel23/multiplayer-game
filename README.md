# Gnosia LAN

Juego de deducción social para jugar en persona: pantalla común (PC) + celulares. Servidor autoritativo en memoria. Resumen completo del diseño y las reglas en `RESUMEN_PROYECTO.md`.

## Uso
```
npm install
npm start
```
1. Abre `http://localhost:3000/host` en la PC (pantalla común): aparecen el QR y el código de sala.
2. Los celulares (mismo Wi-Fi) escanean el QR o entran a `http://<IP-de-la-PC>:3000/play`.
3. Con 4 jugadores o más, elige el modo en la pantalla común e inicia la partida:
   - **Primera partida:** más fácil, con todos los roles y la guía siempre activada. Para aprender.
   - **Estándar:** reglas fijas, resultados parejos entre partidas.
   - **Roles aleatorios:** con 4 a 9 jugadores los roles se sortean en cada partida (de 10 en adelante es igual al estándar).
   Las tablas de cada modo están en `server.js` (`ROLE_TABLE`, `PRIMERA_TABLE`, `RANDOM_TABLE`).

Variables de entorno: `PORT` (3000) y `PUBLIC_URL` (opcional; si no, el QR usa la dirección con la que se abrió `/host`).

Estructura: `server.js` (servidor y reglas), `content/narrativas.json` (textos de ambientación), `content/guia.json` (guía introductoria que se muestra antes de la partida; se puede saltar o desactivar desde el lobby), `public/` (pantalla común y celular), `test/smoke.js` (pruebas).

Balance: `npm run simular` (o `node test/simulate.js --comparar`) simula miles de partidas por modo y cantidad de jugadores.

Pruebas: con el servidor corriendo (`PORT=3000 node server.js &`), ejecutar `PORT=3000 npm test`.

Despliegue en Render: Web Service con build `npm install` y start `npm start`. La carpeta `content/` debe estar en el repositorio.
