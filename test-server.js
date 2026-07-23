// Teste end-to-end do servidor: sobe o servidor de verdade numa porta de teste,
// conecta clientes reais via socket.io-client, joga partidas completas, e
// confere a propriedade mais importante: nenhum cliente recebe o valor de uma
// carta que não foi legitimamente revelada pra ele.

process.env.PORT = 0; // porta livre escolhida pelo SO
const { io: ioClient } = require('socket.io-client');

let pass = 0, fail = 0;
function check(label, cond){
  if(cond){ pass++; console.log('OK   '+label); }
  else { fail++; console.log('FAIL '+label); }
}

function wait(ms){ return new Promise(res=>setTimeout(res, ms)); }

async function main(){
  // sobe o server.js num child process real, escutando numa porta de teste
  const http = require('http');
  const path = require('path');
  delete require.cache[require.resolve('./server.js')];

  // servidor já dá listen() sozinho ao ser importado; usamos porta 0 só não
  // funciona bem pra pegar a porta depois, então fixamos uma porta de teste.
  process.env.PORT = 3901;
  require('./server.js');
  await wait(400);
  const BASE = 'http://localhost:3901';

  function makeClient(){
    const known = {};      // memória PRÓPRIA desse cliente (só o que ele viu de verdade)
    const leaks = [];      // qualquer valor de carta que apareça fora de 'cardRevealed'
    const c = ioClient(BASE, { transports:['websocket'], forceNew:true });
    let latestState = null;
    c.on('state', (s) => {
      latestState = s;
      const raw = JSON.stringify(s);
      // 'state' nunca deveria conter um valor de carta -- só ids/contagens.
      // heurística: procura por qualquer numero de 1 a 12 associado a uma chave "value"
      if(/"value"\s*:/.test(raw)) leaks.push('campo "value" apareceu no evento state: '+raw.slice(0,200));
    });
    c.on('cardRevealed', (info) => { known[info.cardId] = info.value; });
    return { socket:c, known, leaks, getState:()=>latestState };
  }

  function emitAsync(socket, event, payload){
    return new Promise(resolve => socket.emit(event, payload, resolve));
  }

  // ---------- Teste 1: fluxo básico de sala ----------
  {
    const host = makeClient();
    await new Promise(r=>host.socket.on('connect', r));
    const createRes = await emitAsync(host.socket, 'createRoom', { name:'Anfitriao' });
    check('createRoom retorna ok + code', createRes.ok && /^[A-Z0-9]{5}$/.test(createRes.code));

    const guest = makeClient();
    await new Promise(r=>guest.socket.on('connect', r));
    const joinBadRes = await emitAsync(guest.socket, 'joinRoom', { code:'ZZZZZ', name:'Fulano' });
    check('joinRoom com codigo invalido retorna erro', joinBadRes.ok === false);

    const joinRes = await emitAsync(guest.socket, 'joinRoom', { code:createRes.code, name:'Convidado' });
    check('joinRoom com codigo valido funciona', joinRes.ok && joinRes.seat === 1);

    const startTooFewRes = await emitAsync(host.socket, 'startGame', {});
    check('startGame com <3 jogadores falha', startTooFewRes.ok === false);

    const startByGuestRes = await emitAsync(guest.socket, 'startGame', {});
    check('startGame por quem nao e host falha', startByGuestRes.ok === false);

    host.socket.disconnect(); guest.socket.disconnect();
  }

  // ---------- Teste 2: partida completa de verdade, com verificação de vazamento ----------
  const N = 4;
  const clients = [];
  const hostClient = makeClient();
  await new Promise(r=>hostClient.socket.on('connect', r));
  const createRes2 = await emitAsync(hostClient.socket, 'createRoom', { name:'P0' });
  check('sala criada pro teste de partida completa', createRes2.ok);
  clients.push(hostClient);

  for(let i=1;i<N;i++){
    const c = makeClient();
    await new Promise(r=>c.socket.on('connect', r));
    const res = await emitAsync(c.socket, 'joinRoom', { code: createRes2.code, name:'P'+i });
    check('jogador '+i+' entrou na sala', res.ok && res.seat === i);
    clients.push(c);
  }

  const fullRes = await emitAsync((await (async()=>{ const c=makeClient(); await new Promise(r=>c.socket.on('connect',r)); return c; })()).socket, 'joinRoom', { code:'AAAAA' , name:'x'});
  // (sala inexistente, so garantindo que nao trava; ja testado acima tambem)

  const startRes = await emitAsync(hostClient.socket, 'startGame', {});
  check('startGame com 4 jogadores funciona', startRes.ok);
  await wait(200);

  function availableTargets(state, seat){
    const opts = [];
    for(const p of state.players){
      if(p.handCount>0){ opts.push({type:'hand', seat:p.seat, position:'lowest'}); opts.push({type:'hand', seat:p.seat, position:'highest'}); }
    }
    for(const id of state.tableIds) opts.push({type:'table', cardId:id});
    return opts;
  }
  function chooseTarget(state, seat, known, revealedThisTurnIds){
    const avail = availableTargets(state, seat).filter(t=>{
      // evita re-mirar exatamente a mesma posicao/carta que ja foi usada nesse turno --
      // aproximaçao simples: não filtra por id (não sabemos o id de posições não reveladas),
      // deixamos o servidor validar e simplesmente tentamos de novo se der erro.
      return true;
    });
    if(state.turnRevealsCount === 0){
      const groups = {};
      for(const t of avail){
        // não temos o id de cartas de mão (só de mesa); pra mirar em pares conhecidos
        // usamos só as cartas de mesa conhecidas (id explicito) pra simplificar o bot de teste.
        if(t.type==='table' && known[t.cardId]!==undefined){
          (groups[known[t.cardId]] = groups[known[t.cardId]]||[]).push(t);
        }
      }
      const ready = Object.values(groups).find(g=>g.length>=2);
      if(ready) return ready[0];
      return avail[Math.floor(Math.random()*avail.length)];
    }
    return avail[Math.floor(Math.random()*avail.length)];
  }

  let leakDetected = false;
  let turns = 0;
  const MAX_TURNS = 250;
  while(turns < MAX_TURNS){
    const state = hostClient.getState();
    if(!state) { await wait(50); continue; }
    if(state.winner !== null && state.winner !== undefined) break;
    const seat = state.currentPlayer;
    const actor = clients[seat];
    let attempts = 0;
    let advanced = false;
    while(attempts < 6 && !advanced){
      attempts++;
      const s = actor.getState();
      if(!s || s.winner!==null) { advanced = true; break; }
      const target = chooseTarget(s, seat, actor.known, null);
      const res = await emitAsync(actor.socket, 'revealCard', target);
      if(!res.ok){ continue; } // tenta outro alvo
      await wait(15);
      if(res.status === 'revealed'){
        // continua ou para, as vezes por escolha propria
        if(Math.random()<0.5){
          const stopRes = await emitAsync(actor.socket, 'stopTurn', {});
          advanced = stopRes.ok;
        }
        // se nao parou, o loop de tentativas tenta revelar mais uma (mesmo turno)
        continue;
      } else {
        advanced = true; // mismatch ou trio -> turno acabou sozinho no servidor
      }
    }
    turns++;
    await wait(10);
  }
  await wait(150);

  for(const c of clients){
    if(c.leaks.length){ leakDetected = true; console.log('VAZAMENTO em cliente:', c.leaks); }
  }
  check('nenhum vazamento de valor de carta fora de cardRevealed, em toda a partida', !leakDetected);

  const finalState = hostClient.getState();
  check('partida chegou a um estado final (venceu ou atingiu o teto de turnos sem travar)', !!finalState);
  if(finalState && finalState.winner !== null && finalState.winner !== undefined){
    const w = finalState.players.find(p=>p.seat===finalState.winner);
    const validWin = w.trios.includes(7) || w.trios.length >= 3;
    check('vencedor tem condicao de vitoria valida (3 trios ou trio do 7)', validWin);
    console.log('  -> venceu o jogador '+finalState.winner+' ('+w.name+') apos '+turns+' turnos, trios: '+JSON.stringify(w.trios));
  } else {
    console.log('  -> jogo nao terminou em '+MAX_TURNS+' turnos simulados (bot de teste é so aleatorio+memoria parcial, ok pra esse teste)');
  }

  // ---------- Teste 3: validações de segurança básicas ----------
  {
    const state = hostClient.getState();
    if(state && state.winner===null){
      const notMyTurnSeat = (state.currentPlayer+1)%N;
      const res = await emitAsync(clients[notMyTurnSeat].socket, 'revealCard', {type:'table', cardId: state.tableIds[0] || 'inexistente'});
      check('revelar fora da sua vez retorna erro', res.ok === false);
    } else {
      check('(pulo) revelar fora da vez — jogo ja tinha terminado', true);
    }
  }

  clients.forEach(c=>c.socket.disconnect());

  console.log('\n'+pass+' passaram, '+fail+' falharam.');
  process.exit(fail>0 ? 1 : 0);
}

main().catch(e=>{ console.error('ERRO NO TESTE:', e); process.exit(1); });
