# Gnosia LAN

Juego de deducción social para jugar en persona: pantalla común (PC) + celulares. Servidor autoritativo en memoria. Resumen completo del diseño y las reglas en `RESUMEN_PROYECTO.md`.

## Uso
```
npm install
npm start
```
1. Abre `http://localhost:3000/host` en la PC (pantalla común): aparecen el QR y el código de sala.
2. Los celulares (mismo Wi-Fi) escanean el QR o entran a `http://<IP-de-la-PC>:3000/play`.
3. Con 4 jugadores o más, inicia la partida desde la pantalla común.

Variables de entorno: `PORT` (3000) y `PUBLIC_URL` (opcional; si no, el QR usa la dirección con la que se abrió `/host`).

Estructura: `server.js` (servidor y reglas), `content/temas/*.json` (una ambientación por archivo), `public/` (pantalla común y celular), `test/smoke.js` (pruebas).

## Temas de ambientación
Cada archivo de `content/temas/` es una ambientación completa: historia general, narrativas por rol, eventos y textos de la interfaz (`ui`). Las reglas no cambian, solo los textos y los nombres de rol. En el lobby de la pantalla común se elige la ambientación (o "Aleatoria", que sortea sin repetir seguido). Para agregar un tema, copiar `mafia.json`, cambiar el `id` y reescribir los textos: aparece solo en el selector. Los marcadores permitidos están en la clave `marcadores` de cada tema.

Pruebas: con el servidor corriendo (`PORT=3000 node server.js &`), ejecutar `PORT=3000 npm test`.

Despliegue en Render: Web Service con build `npm install` y start `npm start`. La carpeta `content/temas/` debe estar en el repositorio.
