/**
 * TRIO ONLINE — servidor (Node.js + Express + Socket.io)
 *
 * O servidor é a ÚNICA fonte de verdade sobre o estado do jogo (usa o motor
 * puro de trio-engine.js). Ele nunca manda pro cliente o valor de uma carta
 * que não foi revelada — nem a do dono da própria mão, já que nesse jogo
 * ninguém sabe o valor de nada até revelar (igual pra todo mundo).
 *
 * Rodar localmente:
 *   npm install
 *   npm start
 *   -> abre http://localhost:3000 em algumas abas pra testar
 *
 * Pra colegas espalhados jogarem de verdade, esse processo precisa estar
 * publicado em algum host (Render, Railway, Fly.io etc.) — rodando só na
 * sua máquina, só quem estiver na sua rede consegue chegar nele.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  setupGame, startTurn, revealCard, stopTurn, TRIOS_TO_WIN, INSTANT_WIN_VALUE
} = require('./trio-engine.js');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Object.<string, Room>} */
const rooms = {};

function genRoomCode(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do{
    code = Array.from({length:5}, ()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  } while(rooms[code]);
  return code;
}

function makeRoom(code, hostSocketId){
  return {
    code,
    hostSocketId,
    status: 'waiting', // 'waiting' | 'playing'
    players: [], // {seat, socketId, name, connected}
    state: null  // preenchido por setupGame() quando o jogo começa
  };
}

function publicState(room){
  const state = room.state;
  return {
    code: room.code,
    status: room.status,
    hostSocketId: room.hostSocketId,
    players: room.players.map(p => ({
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      handCount: state ? state.players[p.seat].hand.length : null,
      trios: state ? state.players[p.seat].trios : []
    })),
    tableIds: state ? (state.originalTableIds ? state.originalTableIds.map(id => state.table.some(c=>c.id===id) ? id : null) : state.table.map(c=>c.id)) : [],
    currentPlayer: state ? state.currentPlayer : null,
    turnActive: state ? !!state.turn : false,
    turnRevealsCount: state && state.turn ? state.turn.reveals.length : 0,
    // Cartas viradas durante o turno atual — fonte de verdade para o cliente
    reveals: state && state.turn ? state.turn.reveals.map(r => ({
      type: r.target.type,
      seat: r.target.type === 'hand' ? r.target.seat : null,
      position: r.target.type === 'hand' ? r.target.position : null,
      cardId: r.card.id,
      value: r.card.value
    })) : [],
    winner: state ? state.winner : null,
    log: state ? state.log.slice(-40) : []
  };
}

function broadcastState(room){
  io.to(room.code).emit('state', publicState(room));
}

function findRoomOfSocket(socket){
  const code = socket.data.roomCode;
  return code ? rooms[code] : null;
}

// Depois que um turno acaba (mismatch, stop ou trio), o próximo turno começa
// sozinho — o cliente não precisa pedir.
function advanceTurnIfNeeded(room){
  const state = room.state;
  if(state.winner) return;
  if(!state.turn){
    startTurn(state);
    io.to(room.code).emit('turnStarted', { player: state.currentPlayer });
  }
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }, ack) => {
    name = (name || '').trim().slice(0, 18) || 'Jogador';
    const code = genRoomCode();
    const room = makeRoom(code, socket.id);
    room.players.push({ seat: 0, socketId: socket.id, name, connected: true });
    rooms[code] = room;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.seat = 0;

    ack && ack({ ok: true, code, seat: 0 });
    broadcastState(room);
  });

  socket.on('joinRoom', ({ code, name }, ack) => {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim().slice(0, 18) || 'Jogador';
    const room = rooms[code];
    if(!room) return ack && ack({ ok:false, error:'Sala não encontrada.' });
    if(room.status !== 'waiting') return ack && ack({ ok:false, error:'Esse jogo já começou.' });
    if(room.players.length >= MAX_PLAYERS) return ack && ack({ ok:false, error:'Sala cheia.' });

    const seat = room.players.length;
    room.players.push({ seat, socketId: socket.id, name, connected: true });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.seat = seat;

    ack && ack({ ok:true, code, seat });
    broadcastState(room);
  });

  socket.on('startGame', (_payload, ack) => {
    const room = findRoomOfSocket(socket);
    if(!room) return ack && ack({ ok:false, error:'Você não está em uma sala.' });
    if(room.hostSocketId !== socket.id) return ack && ack({ ok:false, error:'Só o anfitrião pode iniciar.' });
    if(room.status !== 'waiting') return ack && ack({ ok:false, error:'O jogo já começou.' });
    if(room.players.length < MIN_PLAYERS) return ack && ack({ ok:false, error:'Precisa de pelo menos 3 jogadores.' });

    try{
      const state = setupGame(room.players.length);
      startTurn(state);
      room.state = state;
      room.status = 'playing';
      ack && ack({ ok:true });
      io.to(room.code).emit('gameStarted');
      // Envia a mão completa para os jogadores humanos memorizarem
      for(const p of room.players) {
        if(p.connected) {
          const statePlayer = state.players[p.seat];
          if (statePlayer && statePlayer.hand) {
            const sorted = statePlayer.hand.map(c => c.value).sort((a,b)=>a-b);
            io.to(p.socketId).emit('showInitialHand', sorted);
          }
        }
      }
      io.to(room.code).emit('turnStarted', { player: state.currentPlayer });
      broadcastState(room);
    }catch(e){
      ack && ack({ ok:false, error: e.message });
    }
  });

  socket.on('revealCard', (target, ack) => {
    const room = findRoomOfSocket(socket);
    if(!room || !room.state) return ack && ack({ ok:false, error:'Jogo não encontrado.' });
    const state = room.state;
    const seat = socket.data.seat;
    if(state.winner) return ack && ack({ ok:false, error:'O jogo já terminou.' });
    if(!state.turn || state.turn.player !== seat) return ack && ack({ ok:false, error:'Não é a sua vez.' });

    let result;
    try{
      result = revealCard(state, target);
    }catch(e){
      return ack && ack({ ok:false, error: e.message });
    }

    io.to(room.code).emit('cardRevealed', {
      by: seat,
      target,
      cardId: result.card.id,
      value: result.card.value,
      status: result.status,
      canContinue: result.canContinue,
      trioValue: result.value
    });

    ack && ack({ ok:true, status: result.status });
    advanceTurnIfNeeded(room);
    broadcastState(room);
  });

  socket.on('stopTurn', (_payload, ack) => {
    const room = findRoomOfSocket(socket);
    if(!room || !room.state) return ack && ack({ ok:false, error:'Jogo não encontrado.' });
    const state = room.state;
    const seat = socket.data.seat;
    if(!state.turn || state.turn.player !== seat) return ack && ack({ ok:false, error:'Não é a sua vez.' });
    if(state.turn.reveals.length < 1) return ack && ack({ ok:false, error:'Revele pelo menos uma carta antes de parar.' });

    stopTurn(state);
    io.to(room.code).emit('turnEnded', { by: seat });
    ack && ack({ ok:true });
    advanceTurnIfNeeded(room);
    broadcastState(room);
  });

  socket.on('playAgain', (_payload, ack) => {
    const room = findRoomOfSocket(socket);
    if(!room) return ack && ack({ ok:false, error:'Sala não encontrada.' });
    if(room.status !== 'playing') return ack && ack({ ok:false, error:'O jogo não está em andamento.' });
    
    // Volta para o modo sala de espera (lobby)
    room.status = 'waiting';
    room.state = null;
    
    ack && ack({ ok:true });
    broadcastState(room);
  });

  socket.on('leaveRoom', (_payload, ack) => {
    const room = findRoomOfSocket(socket);
    if(room) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if(room.players.length === 0) {
        delete rooms[room.code];
      } else {
        // Se o host saiu, passa o host para o próximo jogador
        if (room.hostSocketId === socket.id) {
          room.hostSocketId = room.players[0].socketId;
        }
        broadcastState(room);
      }
    }
    socket.leave(socket.data.roomCode);
    socket.data.roomCode = null;
    ack && ack({ ok:true });
  });

  socket.on('chatMessage', (payload, ack) => {
    const room = findRoomOfSocket(socket);
    if(!room) return ack && ack({ ok:false });
    const player = room.players.find(p => p.socketId === socket.id);
    if(!player) return ack && ack({ ok:false });
    const text = String(payload && payload.text || '').trim().slice(0, 200);
    if(!text) return ack && ack({ ok:false });
    io.to(room.code).emit('chatMessage', { name: player.name, text, seat: player.seat, ts: Date.now() });
    ack && ack({ ok:true });
  });

  socket.on('disconnect', () => {
    const room = findRoomOfSocket(socket);
    if(!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if(player) player.connected = false;
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log('Trio Online rodando em http://localhost:' + PORT);
});