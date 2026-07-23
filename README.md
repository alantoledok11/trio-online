# Trio Online

Servidor + cliente pra jogar Trio em tempo real com gente espalhada — Node.js,
Express e Socket.io no back, HTML/CSS/JS puro no front. O servidor é dono do
estado do jogo (usa `trio-engine.js`) e só manda pra cada navegador o que é
público (contagens de carta, ids da mesa) — o valor de uma carta só viaja pra
todo mundo no instante em que ela é revelada de verdade.

## Testar localmente

```
npm install
npm start
```

Abre `http://localhost:3000` em 3 a 6 abas (ou dispositivos na mesma rede,
trocando `localhost` pelo IP da sua máquina) e joga.

## Publicar pra colegas espalhados acessarem

Rodando só na sua máquina, só quem tá na sua rede chega nele. Pra qualquer um
entrar de qualquer lugar, precisa publicar em algum host que mantenha o
processo Node no ar. Serviços com plano grátis que servem bem pra isso:
Render, Railway, Fly.io. Em qualquer um deles o processo é o mesmo:

1. Suba esse projeto pra um repositório Git.
2. Aponte o serviço de hospedagem pra esse repositório.
3. Comando de start: `npm start` (o servidor já lê a porta de `process.env.PORT`,
   que é como esses serviços informam qual porta usar — não precisa mexer em nada).
4. Depois de publicado, o link que o serviço te der é o que você manda pros colegas.

Pra esse passo de publicar e ir ajustando o código depois, o **Claude Code** é
o lugar certo — ele roda o processo, te ajuda a resolver erro de deploy, etc.
Esse chat só entrega os arquivos.

## O que já foi testado

- `test-trio.js`: o motor de regras puro (setup, revelar, trincas, vitórias) —
  49 checagens, incluindo simulações de partidas completas.
- `test-server.js`: sobe o servidor de verdade, conecta múltiplos clientes via
  socket.io-client e joga uma partida real pela rede, checando especificamente
  que nenhum valor de carta escondida vaza pra quem não devia ver.

Rodar os dois: `node test-trio.js` e `node test-server.js` (o segundo já sobe
e derruba o servidor sozinho).

## Limitações conhecidas (pra próxima rodada)

- Estado fica só na memória do processo — se o servidor reiniciar, as partidas
  em andamento se perdem.
- Sem reconexão: se alguém cair no meio do jogo, ele fica marcado como
  desconectado mas a vaga não é liberada nem retomada automaticamente.
- Sem CPU/bots nessa versão (o Truco tinha; dá pra portar a mesma ideia aqui
  se fizer falta pra testar sozinho).
