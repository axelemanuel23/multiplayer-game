const WebSocket = require('ws');
const http = require('http');

// Crear servidor HTTP
const server = http.createServer();

// Crear servidor WebSocket
const wss = new WebSocket.Server({ server });

let clients = [];
let gameState = {
  jugadores: [null, null],
  tableros: [
    Array(5).fill().map(() => Array(5).fill(0)),
    Array(5).fill().map(() => Array(5).fill(0))
  ],
  barcos: [[], []],
  intentos: [0, 0],
  barcosHundidos: [0, 0],
  jugadorActual: 0,
  ganador: null,
  fase: 'espera'
};

// Función para enviar el estado del juego a cada cliente
function broadcastGameState() {
  clients.forEach(client => {
    const { id } = client;
    const oponente = 1 - id;
    
    // Crear copia del tablero del oponente ocultando sus barcos durante colocación
    const tableroOponenteOculto = gameState.fase === 'colocacion' ? 
      gameState.tableros[oponente].map(fila => fila.map(() => 0)) :
      gameState.tableros[oponente].map((fila, y) => 
        fila.map((celda, x) => {
          // Si es agua (1) o un barco hundido (2), mostrar
          if (celda === 1 || gameState.barcos[oponente].find(b => b.x === x && b.y === y && b.hundido)) {
            return celda;
          }
          return 0; // Ocultar barcos no hundidos
        })
      );

    // Enviar solo la información relevante para este jugador
    client.ws.send(JSON.stringify({
      type: 'update',
      state: {
        miTablero: gameState.tableros[id],
        tableroOponente: tableroOponenteOculto,
        misBarcos: gameState.barcos[id],
        misIntentos: gameState.intentos[id],
        misBarcosHundidos: gameState.barcosHundidos[id],
        barcosOponenteHundidos: gameState.barcosHundidos[oponente],
        ganador: gameState.ganador,
        fase: gameState.fase,
        esMiTurno: gameState.jugadorActual === id
      }
    }));
  });
}

// Función para reiniciar el juego
function resetGame() {
  gameState = {
    jugadores: [null, null],
    tableros: [
      Array(5).fill().map(() => Array(5).fill(0)),
      Array(5).fill().map(() => Array(5).fill(0))
    ],
    barcos: [[], []],
    intentos: [0, 0],
    barcosHundidos: [0, 0],
    jugadorActual: 0,
    ganador: null,
    fase: 'espera'
  };
  broadcastGameState();
}

// Manejar conexiones de WebSocket
wss.on('connection', (ws) => {
  console.log('Nuevo cliente conectado');
  
  // Solo permitir 2 jugadores
  if (clients.length >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'Partida llena' }));
    ws.close();
    return;
  }

  // Asignar ID al cliente
  const clientId = clients.length;
  clients.push({ id: clientId, ws });

  // Enviar estado inicial al nuevo cliente
  ws.send(JSON.stringify({ 
    type: 'init',
    state: {
      miId: clientId
    }
  }));

  // Si hay 2 jugadores, comenzar el juego
  if (clients.length === 2) {
    console.log('Dos jugadores conectados - Iniciando juego');
    gameState.fase = 'colocacion';
    broadcastGameState();
  }

  // Manejar mensajes recibidos
  ws.on('message', (message) => {
    try {
      const parsedMessage = JSON.parse(message);
      console.log('Mensaje recibido:', parsedMessage);
      
      switch (parsedMessage.type) {
        case 'colocarBarco':
          if (gameState.fase !== 'colocacion' || gameState.barcos[clientId].length >= 3) {
            ws.send(JSON.stringify({ type: 'error', message: 'No puedes colocar más barcos' }));
            break;
          }
          
          const nuevoBarco = { x: parsedMessage.x, y: parsedMessage.y, hundido: false };
          
          // Verificar si ya hay un barco en esa posición
          if (gameState.tableros[clientId][parsedMessage.y][parsedMessage.x] === 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ya hay un barco en esa posición' }));
            break;
          }
          
          gameState.barcos[clientId].push(nuevoBarco);
          gameState.tableros[clientId][parsedMessage.y][parsedMessage.x] = 2;
          console.log(`Jugador ${clientId} colocó un barco en (${parsedMessage.x}, ${parsedMessage.y})`);
          
          // Si ambos colocaron sus 3 barcos, comenzar fase de disparos
          if (gameState.barcos[0].length === 3 && gameState.barcos[1].length === 3) {
            console.log('Ambos jugadores colocaron sus barcos - Iniciando fase de disparos');
            gameState.fase = 'disparos';
            gameState.jugadorActual = 0;
          }
          broadcastGameState();
          break;

        case 'disparo':
          if (gameState.fase !== 'disparos') {
            ws.send(JSON.stringify({ type: 'error', message: 'No es fase de disparos' }));
            break;
          }
          if (gameState.ganador !== null) {
            ws.send(JSON.stringify({ type: 'error', message: 'El juego ya terminó' }));
            break;
          }
          if (gameState.jugadorActual !== clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'No es tu turno' }));
            break;
          }
              
          const oponente = 1 - clientId;
          const x = parsedMessage.x;
          const y = parsedMessage.y;
          
          // Verificar si ya disparó en esa posición o si hay un barco hundido
          const barcoEnPosicion = gameState.barcos[oponente].find(
            barco => barco.x === x && barco.y === y
          );
          
          if (gameState.tableros[oponente][y][x] === 1 || 
              (barcoEnPosicion && barcoEnPosicion.hundido)) {
            ws.send(JSON.stringify({ type: 'error', message: 'No puedes disparar en esa posición' }));
            break;
          }
          
          const barcoImpactado = gameState.barcos[oponente].find(
            barco => barco.x === x && barco.y === y
          );
                           
          if (barcoImpactado) {
            console.log(`¡Impacto! Jugador ${clientId} impactó un barco del Jugador ${oponente}`);
            gameState.tableros[oponente][y][x] = 2; // Impacto
            barcoImpactado.hundido = true;
            gameState.barcosHundidos[oponente]++;
            
            if (gameState.barcosHundidos[oponente] === 3) {
              gameState.ganador = clientId;
            }
          } else {
            console.log(`Agua - Disparo del Jugador ${clientId} en (${x}, ${y})`);
            gameState.tableros[oponente][y][x] = 1; // Agua
          }
          
          gameState.intentos[clientId]++;
          gameState.jugadorActual = oponente;
          broadcastGameState();
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Mensaje no reconocido' }));
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Error procesando mensaje' }));
    }
  });

  // Manejar desconexiones
  ws.on('close', () => {
    console.log(`Cliente ${clientId} desconectado`);
    clients = clients.filter(client => client.id !== clientId);
    
    // Reiniciar juego cuando un jugador se desconecta
    resetGame();
  });

  // Manejar errores
  ws.on('error', (error) => {
    console.error('Error de WebSocket:', error);
    ws.send(JSON.stringify({ type: 'error', message: 'Error interno del servidor' }));
  });
});

// Iniciar el servidor
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
});
