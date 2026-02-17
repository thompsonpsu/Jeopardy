/**
 * Simulates 2 other users (e.g. on phones) joining your Jeopardy game.
 *
 * Usage:
 *   1. In your browser: create a game and note the 4-letter room code.
 *   2. Run: node test-join.js <ROOM_CODE> [SERVER_URL]
 *
 * Example:
 *   node test-join.js ABCD
 *   node test-join.js ABCD http://192.168.1.100:3000
 *
 * Default SERVER_URL is http://localhost:3000
 * Use your machine's LAN IP (e.g. from the server startup message) when testing from phones.
 */

const { io } = require('socket.io-client');

const roomCode = (process.argv[2] || '').toUpperCase().trim();
const baseUrl = process.argv[3] || 'http://localhost:3000';

if (!roomCode || roomCode.length !== 4) {
  console.log('Usage: node test-join.js <ROOM_CODE> [SERVER_URL]');
  console.log('Example: node test-join.js ABCD');
  process.exit(1);
}

console.log(`Connecting to ${baseUrl}, joining room "${roomCode}" as 2 test players...\n`);

function connectPlayer(name) {
  const socket = io(baseUrl, { transports: ['polling', 'websocket'] });

  socket.on('connect', () => {
    socket.emit('join-game', { code: roomCode, playerName: name }, (res) => {
      if (res.error) {
        console.log(`[${name}] Join failed: ${res.error}`);
        socket.disconnect();
        return;
      }
      console.log(`[${name}] Joined room ${roomCode} successfully.`);
    });
  });

  socket.on('player-update', ({ players }) => {
    const names = players.map(p => p.name).join(', ');
    console.log(`[${name}] Players in room: ${names}`);
  });

  socket.on('game-started', () => {
    console.log(`[${name}] Game started! (Simulated player stays in lobby; use real devices to play.)`);
  });

  socket.on('connect_error', (err) => {
    console.log(`[${name}] Connection error: ${err.message}`);
  });

  return socket;
}

const p1 = connectPlayer('TestPlayer1');
const p2 = connectPlayer('TestPlayer2');

// Keep process alive
process.on('SIGINT', () => {
  p1.disconnect();
  p2.disconnect();
  process.exit(0);
});

console.log('Two simulated players are joining. Check your host lobby in the browser.');
console.log('Press Ctrl+C to disconnect them.\n');
