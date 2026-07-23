/**
 * TRIO — motor de regras (puro, sem DOM/rede)
 * 36 cartas (1 a 12, 3 cópias de cada), 3 a 6 jogadores.
 *
 * Suposições que assumi por não estarem 100% explícitas nas regras
 * (fica fácil de mudar se não for isso que você imaginou):
 *  1) Depois de 1 ou 2 revelações que bateram, o jogador PODE optar por
 *     parar (stopTurn) em vez de arriscar a próxima — ele não é obrigado
 *     a ir até errar ou até o limite de 3.
 *  2) Não dá pra revelar a mesma carta física duas vezes no mesmo turno
 *     (evita o caso degenerado de pedir "mais baixa" e "mais alta" de um
 *     jogador que só tem 1 carta na mão, o que seria a mesma carta).
 *  3) Depois de fechar um trio (3 iguais), o turno sempre acaba — o limite
 *     de 3 revelações por turno é rígido.
 *  4) Ordem de turno é sequencial pelos assentos (0,1,2...).
 */

const VALUES = Array.from({length:12}, (_,i)=>i+1); // 1..12
const COPIES_PER_VALUE = 3;
const TRIOS_TO_WIN = 3;
const INSTANT_WIN_VALUE = 7;

let _cardIdCounter = 0;
function makeCard(value){ return { id: 'c'+(_cardIdCounter++), value }; }

function createDeck(){
  const deck = [];
  for(const v of VALUES) for(let i=0;i<COPIES_PER_VALUE;i++) deck.push(makeCard(v));
  return deck;
}

function shuffle(deck){
  const d = deck.slice();
  for(let i=d.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [d[i],d[j]] = [d[j],d[i]];
  }
  return d;
}

/* ------------------------------- Setup ---------------------------------- */
function setupGame(numPlayers){
  if(numPlayers < 3 || numPlayers > 7){
    throw new Error('Trio é jogado com 3 a 7 jogadores.');
  }
  const deck = shuffle(createDeck());
  const cardsPerPlayer = { 3: 9, 4: 7, 5: 6, 6: 5, 7: 5 };
  const perPlayer = cardsPerPlayer[numPlayers];

  const players = [];
  for(let p=0; p<numPlayers; p++){
    const hand = deck.splice(0, perPlayer);
    hand.sort((a,b)=>a.value-b.value); // cada jogador organiza a própria mão, do menor pro maior
    players.push({ seat:p, hand, trios:[] }); // trios: valores já fechados por esse jogador
  }
  const table = deck; // sobras ficam viradas pra baixo, no centro

  return {
    numPlayers,
    players,
    table,
    originalTableIds: table.map(c => c.id),
    currentPlayer: 0,
    turn: null,      // preenchido por startTurn()
    winner: null,
    log: []
  };
}

/* --------------------------- Acesso a cartas ----------------------------- */
function getHandCardAtPosition(state, player, position){
  if(player.hand.length === 0) return null;
  const revealedIds = (state && state.turn) ? state.turn.revealedIds : [];
  const available = player.hand.filter(c => !revealedIds.includes(c.id));
  if(available.length === 0) return null;
  return position === 'lowest' ? available[0] : available[available.length-1];
}

function resolveTarget(state, target){
  if(target.type === 'hand'){
    const player = state.players[target.seat];
    if(!player) throw new Error('Jogador inválido: '+target.seat);
    const card = getHandCardAtPosition(state, player, target.position);
    if(!card) throw new Error('Esse jogador não tem mais cartas ocultas.');
    return card;
  }
  if(target.type === 'table'){
    const card = state.table.find(c=>c.id===target.cardId);
    if(!card) throw new Error('Essa carta da mesa não existe (já deve ter saído do jogo).');
    return card;
  }
  throw new Error('Tipo de alvo desconhecido: '+target.type);
}

function removeCardFromState(state, target, cardId){
  if(target.type === 'hand'){
    const player = state.players[target.seat];
    player.hand = player.hand.filter(c=>c.id!==cardId);
  } else {
    state.table = state.table.filter(c=>c.id!==cardId);
  }
}

/* ------------------------------- Turno ----------------------------------- */
function startTurn(state){
  if(state.winner) throw new Error('O jogo já terminou.');
  if(state.turn) throw new Error('Já existe um turno em andamento.');
  state.turn = { player: state.currentPlayer, reveals: [], revealedIds: [] };
  return state.turn;
}

/**
 * Revela uma carta. Retorna:
 *  { status:'revealed', card, canContinue:true }   -> pode revelar mais (ou parar, se >=2)
 *  { status:'mismatch', card, canContinue:false }  -> não bateu, turno encerrado
 *  { status:'trio', card, canContinue:false, value }-> 3 iguais, trio fechado, turno encerrado
 */
function revealCard(state, target){
  const turn = state.turn;
  if(!turn) throw new Error('Chame startTurn() antes de revelar.');
  if(turn.reveals.length >= 3) throw new Error('Limite de 3 revelações por turno já atingido.');

  const card = resolveTarget(state, target);
  if(turn.revealedIds.includes(card.id)){
    throw new Error('Essa carta já foi revelada nesse turno.');
  }

  turn.reveals.push({ target, card });
  turn.revealedIds.push(card.id);

  if(turn.reveals.length === 1){
    return { status:'revealed', card, canContinue:true };
  }

  const firstValue = turn.reveals[0].card.value;
  const isMatch = card.value === firstValue;

  if(!isMatch){
    endTurn(state);
    return { status:'mismatch', card, canContinue:false };
  }

  if(turn.reveals.length === 3){
    const value = completeTrio(state);
    return { status:'trio', card, canContinue:false, value };
  }

  return { status:'revealed', card, canContinue:true }; // 2 bateram, pode parar ou arriscar a 3ª
}

// Jogador escolhe não arriscar mais uma revelação (1 ou 2 já feitas, batendo ou não).
function stopTurn(state){
  if(!state.turn) throw new Error('Não há turno em andamento.');
  endTurn(state);
}

function completeTrio(state){
  const turn = state.turn;
  const value = turn.reveals[0].card.value;
  for(const {target, card} of turn.reveals) removeCardFromState(state, target, card.id);

  const player = state.players[turn.player];
  player.trios.push(value);
  state.log.push('Jogador '+turn.player+' fechou o trio de '+value+'.');

  if(value === INSTANT_WIN_VALUE || player.trios.length >= TRIOS_TO_WIN || hasConnectedTrios(player.trios)){
    state.winner = turn.player;
    state.log.push('🏆 Jogador '+turn.player+' venceu o jogo!');
  }
  state.turn = null; // fecha o turno sem passar a vez ainda (feito abaixo, via endTurn-like)
  if(!state.winner) state.currentPlayer = (state.currentPlayer+1) % state.players.length;
  return value;
}

function endTurn(state){
  state.turn = null;
  if(!state.winner) state.currentPlayer = (state.currentPlayer+1) % state.players.length;
}

function hasConnectedTrios(trios){
  for(let i=0; i<trios.length; i++){
    for(let j=i+1; j<trios.length; j++){
      const a = trios[i];
      const b = trios[j];
      if(a + b === 7 || Math.abs(a - b) === 7) return true;
    }
  }
  return false;
}

/* ------------------------------- Exports ---------------------------------- */
if(typeof module !== 'undefined'){
  module.exports = {
    VALUES, COPIES_PER_VALUE, TRIOS_TO_WIN, INSTANT_WIN_VALUE,
    createDeck, shuffle, setupGame,
    getHandCardAtPosition, resolveTarget,
    startTurn, revealCard, stopTurn
  };
}
