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

Salas: se cierran solas tras 1 hora sin ninguna conexión (`ROOM_IDLE_MS`) o tras 6 horas sin actividad aunque haya conexiones (`ROOM_MAX_IDLE_MS`). La pantalla común tiene los botones **Terminar partida** (revela los roles, sin ganador) y **Cerrar sala** (desconecta a todos y abre una sala nueva).

Estructura: `server.js` (servidor y reglas), `content/temas/*.json` (una ambientación por archivo), `public/` (pantalla común y celular), `test/smoke.js` (pruebas).

## Modos de partida
Se elige en el lobby de la pantalla común:
- **Primera partida:** empieza con una guía corta (se puede saltar) y reparte todos los roles en orden (Ingeniero, Doctor, Guardián y Vigías, siempre con un Tripulante común).
- **Estándar:** progresión gradual. 4–6 jugadores: 1 infectado; 7–12: 2 infectados. Los roles especiales se suman con la cantidad de jugadores.
- **Roles aleatorios:** de 4 a 6 hay 1 infectado y 1 rol al azar (sin Vigía); 7–8, 2 infectados y 3 roles; 9, 2 infectados y 2 roles; de 10 en adelante rige la tabla estándar.

Las tablas están al comienzo de `server.js` (`STANDARD`, `FIRST`, `buildComposition`). Los Vigías (personal de a bordo) son humanos verificados y públicos, sin habilidad: usan el trasfondo `crew_a_bordo` de cada tema.

## Temas de ambientación
Cada archivo de `content/temas/` es una ambientación completa: historia general, narrativas por rol, eventos y textos de la interfaz (`ui`). Las reglas no cambian, solo los textos y los nombres de rol. En el lobby de la pantalla común se elige la ambientación (o "Aleatoria", que sortea sin repetir seguido). Para agregar un tema, copiar `mafia.json`, cambiar el `id` y reescribir los textos: aparece solo en el selector. Los marcadores permitidos están en la clave `marcadores` de cada tema.

Pruebas: con el servidor corriendo (`PORT=3000 node server.js &`), ejecutar `PORT=3000 npm test`.

Despliegue en Render: Web Service con build `npm install` y start `npm start`. La carpeta `content/temas/` debe estar en el repositorio.
