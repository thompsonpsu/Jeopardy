const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return games[code] ? generateCode() : code;
}

function getValues(round) {
  if (round === 1) return [200, 400, 600, 800, 1000];
  if (round === 2) return [400, 800, 1200, 1600, 2000];
  return [];
}

function freshBoard() {
  const b = {};
  for (let c = 0; c < 6; c++)
    for (let r = 0; r < 5; r++)
      b[`${c}-${r}`] = true;
  return b;
}

function sanitizePlayers(players) {
  return players.map(p => ({ id: p.id, name: p.name, score: p.score, local: !!p.local, owner: p.owner || null }));
}

function getGameState(game) {
  return {
    players: sanitizePlayers(game.players),
    round: game.round,
    categories: game.categories,
    board: game.board,
    started: game.started,
    host: game.host
  };
}

io.on('connection', (socket) => {

  socket.on('create-game', ({ playerName }, cb) => {
    const code = generateCode();
    const game = {
      host: socket.id,
      players: [{ id: socket.id, name: playerName.trim(), score: 0 }],
      round: 0,
      categories: ['', '', '', '', '', ''],
      board: freshBoard(),
      started: false,
      finalWagers: {},
      finalResolved: {}
    };
    games[code] = game;
    socket.join(code);
    socket.data = { code, playerName: playerName.trim() };
    cb({ code, game: getGameState(game) });
  });

  socket.on('join-game', ({ code, playerName }, cb) => {
    code = (code || '').toUpperCase().trim();
    playerName = (playerName || '').trim();
    const game = games[code];

    if (!game) return cb({ error: 'Game not found. Check the room code.' });

    if (game.started) {
      const existing = game.players.find(
        p => p.name.toLowerCase() === playerName.toLowerCase()
      );
      if (existing) {
        const wasHost = existing.id === game.host;
        const oldId = existing.id;
        existing.id = socket.id;
        if (wasHost) {
          game.host = socket.id;
          game.players.forEach(p => {
            if (p.local && p.owner === oldId) p.owner = socket.id;
          });
        }
        socket.join(code);
        socket.data = { code, playerName: existing.name };
        io.to(code).emit('player-update', { players: sanitizePlayers(game.players) });
        return cb({ success: true, game: getGameState(game), reconnected: true });
      }
      return cb({ error: 'Game already in progress.' });
    }

    if (game.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return cb({ error: 'That name is already taken.' });
    }

    game.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(code);
    socket.data = { code, playerName };
    io.to(code).emit('player-update', { players: sanitizePlayers(game.players) });
    cb({ success: true, game: getGameState(game) });
  });

  socket.on('add-local-player', (data, cb) => {
    if (typeof cb !== 'function') return;
    const playerName = (data?.playerName || '').trim();
    const { code } = socket.data || {};
    const game = games[code];
    if (!game || game.host !== socket.id) return cb({ error: 'Only the host can add players.' });
    if (game.started) return cb({ error: 'Game already started.' });
    if (!playerName) return cb({ error: 'Enter a name.' });
    if (game.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return cb({ error: 'That name is already taken.' });
    }
    const localId = 'local-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    game.players.push({ id: localId, name: playerName, score: 0, local: true, owner: socket.id });
    io.to(code).emit('player-update', { players: sanitizePlayers(game.players) });
    cb({ success: true, playerId: localId });
  });

  socket.on('start-game', () => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game || game.host !== socket.id || game.players.length < 1) return;
    game.started = true;
    game.round = 1;
    game.board = freshBoard();
    io.to(code).emit('game-started', { game: getGameState(game) });
  });

  socket.on('set-categories', ({ categories }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game) return;
    game.categories = categories.map(c => (c || '').trim());
    io.to(code).emit('categories-updated', { categories: game.categories });
  });

  socket.on('select-clue', ({ col, row }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game || !game.board[`${col}-${row}`]) return;
    game.board[`${col}-${row}`] = false;
    io.to(code).emit('clue-claimed', {
      col, row,
      claimedBy: socket.id,
      board: game.board
    });
  });

  socket.on('resolve-clue', ({ col, row, awardTo, isDailyDouble, wager, isCorrect }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game) return;

    const values = getValues(game.round);
    const value = values[row];

    if (isDailyDouble && awardTo) {
      const player = game.players.find(p => p.id === awardTo);
      if (player) {
        const maxWager = Math.max(player.score, value);
        const w = Math.min(Math.abs(wager || 0), maxWager);
        player.score += isCorrect ? w : -w;
      }
    } else if (awardTo) {
      const player = game.players.find(p => p.id === awardTo);
      if (player) player.score += (isCorrect !== false) ? value : -value;
    }

    const players = sanitizePlayers(game.players);
    io.to(code).emit('clue-resolved', { col, row, players, board: game.board });

    const cluesLeft = Object.values(game.board).filter(v => v).length;
    if (cluesLeft === 0) {
      io.to(code).emit('round-complete', { round: game.round, players });
    }
  });

  socket.on('advance-round', () => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game) return;

    if (game.round === 1) {
      game.round = 2;
      game.board = freshBoard();
      game.categories = ['', '', '', '', '', ''];
      io.to(code).emit('new-round', { game: getGameState(game) });
    } else if (game.round === 2) {
      game.round = 'final';
      game.finalWagers = {};
      game.finalResolved = {};
      io.to(code).emit('final-jeopardy', {
        players: sanitizePlayers(game.players),
        qualified: game.players.filter(p => p.score > 0).map(p => p.id)
      });
    }
  });

  socket.on('submit-wager', ({ wager, playerId }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game || game.round !== 'final') return;

    let targetId = socket.id;
    if (playerId) {
      const localPlayer = game.players.find(p => p.id === playerId && p.local && p.owner === socket.id);
      if (!localPlayer) return;
      targetId = playerId;
    }

    const player = game.players.find(p => p.id === targetId);
    if (!player || player.score <= 0) return;
    game.finalWagers[targetId] = Math.min(Math.abs(wager || 0), player.score);

    io.to(code).emit('wager-received', { playerId: targetId });

    const qualified = game.players.filter(p => p.score > 0);
    if (qualified.every(p => game.finalWagers[p.id] !== undefined)) {
      io.to(code).emit('all-wagers-in', { players: sanitizePlayers(game.players), wagers: game.finalWagers });
    }
  });

  socket.on('resolve-final', ({ playerId, correct }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game || game.round !== 'final') return;

    const player = game.players.find(p => p.id === playerId);
    const wager = game.finalWagers[playerId] || 0;
    if (player) {
      player.score += correct ? wager : -wager;
      game.finalResolved[playerId] = correct;
    }

    const players = sanitizePlayers(game.players);
    io.to(code).emit('final-player-resolved', { playerId, correct, wager, players });

    const qualified = game.players.filter(p => game.finalWagers[p.id] !== undefined);
    if (qualified.every(p => game.finalResolved[p.id] !== undefined)) {
      io.to(code).emit('game-over', { players });
    }
  });

  socket.on('adjust-score', ({ playerId, amount }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game) return;
    const player = game.players.find(p => p.id === playerId);
    if (player) {
      player.score += amount;
      io.to(code).emit('score-update', { players: sanitizePlayers(game.players) });
    }
  });

  socket.on('skip-clue', ({ col, row }) => {
    const { code } = socket.data || {};
    const game = games[code];
    if (!game) return;
    game.board[`${col}-${row}`] = false;
    const players = sanitizePlayers(game.players);
    io.to(code).emit('clue-resolved', { col, row, players, board: game.board });

    const cluesLeft = Object.values(game.board).filter(v => v).length;
    if (cluesLeft === 0) {
      io.to(code).emit('round-complete', { round: game.round, players });
    }
  });

  socket.on('disconnect', () => {
    const { code } = socket.data || {};
    if (code && games[code]) {
      const game = games[code];
      io.to(code).emit('player-disconnected', { playerId: socket.id });
      setTimeout(() => {
        if (games[code] && game.players.every(p => !io.sockets.sockets.get(p.id))) {
          delete games[code];
        }
      }, 600000);
    }
  });
});

const PORT = process.env.PORT || 3000;
let shareBaseUrl = `http://localhost:${PORT}`;

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  console.log('\n==========================================');
  console.log('   JEOPARDY! Play Along Server');
  console.log('==========================================');
  console.log(`\n   Local:    http://localhost:${PORT}`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        shareBaseUrl = `http://${net.address}:${PORT}`;
        console.log(`   Network:  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\n   Share the Network URL with players!');
  console.log('==========================================\n');
});

app.get('/api/share-base-url', (req, res) => {
  res.json({ url: shareBaseUrl });
});
