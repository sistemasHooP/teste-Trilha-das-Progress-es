import { FirebaseQuestions } from './firebase-questions.js?v=20260520-link1';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const FirebaseGame = (function() {
  const ROOT = 'game';
  const BOARD_END = 30;
  const MAX_PLAYERS = 4;
  const MIN_PLAYERS = 2;
  const GAME_TIME_LIMIT_SECONDS = 30 * 60;
  const DISCONNECT_AFTER_MS = 20 * 1000;
  const EXPIRE_AFTER_MS = 30 * 1000;
  const MAINTENANCE_INTERVAL_MS = 5 * 1000;
  const CLEANUP_FINISHED_MS = 5 * 60 * 1000;
  const CLEANUP_IDLE_LOBBY_MS = 15 * 60 * 1000;
  const CLEANUP_RUNNING_MS = 60 * 60 * 1000;
  const SERVER_CONNECT_TIMEOUT_MS = 9000;
  const SERVER_READ_TIMEOUT_MS = 6000;
  const SERVER_WRITE_TIMEOUT_MS = 8000;

  const SPECIAL_HOUSES = {
    8: { tipo: 'VOLTAR_2', titulo: 'Volte 2 casas', automatico: true, delta: -2 },
    13: { tipo: 'DESAFIO_BONUS', titulo: 'Desafio bônus', automatico: false, bonus: true },
    16: { tipo: 'TROCAR_PERGUNTA', titulo: 'Troque uma pergunta', automatico: false, permiteTroca: true },
    19: { tipo: 'PULAR_PROXIMA', titulo: 'Fique uma rodada sem jogar', automatico: true },
    22: { tipo: 'VOLTAR_2', titulo: 'Volte 2 casas', automatico: true, delta: -2 },
    26: { tipo: 'AVANCAR_2', titulo: 'Avance 2 casas', automatico: true, delta: 2 },
    29: { tipo: 'TROCAR_PERGUNTA', titulo: 'Troque uma pergunta', automatico: false, permiteTroca: true },
    30: { tipo: 'CHEGADA', titulo: 'Chegada', automatico: true }
  };

  const state = {
    contexts: {},
    context: null,
    serverId: '',
    roomId: '',
    playerId: '',
    room: null,
    players: [],
    unsubscribeRoom: null,
    unsubscribePlayers: null,
    heartbeatId: null,
    onState: null,
    lastMaintenanceAt: 0
  };

  function isConfigured() {
    return getConfiguredServers().length > 0;
  }

  function getServerLabel(server) {
    return (server && (server.label || server.name || server.id)) || 'servidor Firebase';
  }

  async function createRoom(name, mode) {
    const context = await chooseServer();
    state.context = context;
    state.serverId = context.server.id;
    cleanupOldRooms(context).catch(function(error) {
      console.warn('Limpeza inicial da Corrida ignorada:', error);
    });
    const now = Date.now();
    const roomId = createId('SALA');
    const playerId = createId('PLAYER');
    const code = await createUniqueCode(context);
    const normalizedMode = mode === 'SOLO' ?'SOLO' : 'MULTI';
    const questions = await loadQuestions();
    const status = normalizedMode === 'SOLO' ?'EM_ANDAMENTO' : 'AGUARDANDO';

    const room = {
      salaId: roomId,
      codigoSala: code,
      status: status,
      modo: normalizedMode,
      criadoEmMs: now,
      atualizadoEmMs: now,
      iniciadoEmMs: normalizedMode === 'SOLO' ?now : 0,
      encerradoEmMs: 0,
      jogadorDaVezIndex: 0,
      vencedorPlayerId: '',
      rodada: 1,
      tempoLimiteSegundos: GAME_TIME_LIMIT_SECONDS,
      motivoEncerramento: '',
      hostUid: context.uid,
      hostPlayerId: playerId,
      questionCursor: 0,
      questions: questions,
      pendingQuestion: null,
      lastAction: normalizedMode === 'SOLO'
        ?makeAction('JOGO_INICIADO', name + ' iniciou a Missão PA & PG.', playerId)
        : null,
      lastDice: null
    };
    room.serverId = context.server.id;

    const player = makePlayer(playerId, roomId, name, 0, context.uid, now);
    await withTimeout(
      update(ref(context.db), {
        [path('rooms', roomId)]: room,
        [path('players', roomId, playerId)]: player,
        [path('codes', code)]: { salaId: roomId, serverId: context.server.id, createdAt: now }
      }),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao criar a sala no ' + getServerLabel(context.server) + '.'
    );

    await enterPresence(context, roomId, playerId);
    return {
      sala: publicRoom(room),
      jogador: player,
      estado: buildEstado(room, [player], playerId)
    };
  }

  async function joinRoom(name, code) {
    const normalizedCode = normalizeCode(code);
    const found = await findRoomByCode(normalizedCode);
    if (!found) {
      return null;
    }

    const context = found.context;
    state.context = context;
    state.serverId = context.server.id;
    cleanupOldRooms(context).catch(function(error) {
      console.warn('Limpeza ao entrar na Corrida ignorada:', error);
    });

    const roomId = found.roomId;
    const roomSnap = await withTimeout(
      get(ref(context.db, path('rooms', roomId))),
      SERVER_READ_TIMEOUT_MS,
      'Tempo limite ao abrir sala.'
    );
    const room = roomSnap.val();
    if (!room || room.status !== 'AGUARDANDO') {
      throw new Error('Essa sala não está aguardando jogadores.');
    }

    const players = await getPlayers(context, roomId);
    const activePlayers = players.filter(function(player) {
      return player.ativo !== false;
    });
    if (activePlayers.length >= MAX_PLAYERS) {
      throw new Error('A sala ja tem 4 jogadores.');
    }

    const playerId = createId('PLAYER');
    const now = Date.now();
    const player = makePlayer(playerId, roomId, name, activePlayers.length, context.uid, now);
    await withTimeout(
      set(ref(context.db, path('players', roomId, playerId)), player),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao entrar na sala.'
    );
    await withTimeout(
      update(ref(context.db, path('rooms', roomId)), { atualizadoEmMs: now }),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao atualizar sala.'
    );
    await enterPresence(context, roomId, playerId);

    return {
      sala: publicRoom(room),
      jogador: player,
      estado: buildEstado(room, players.concat([player]), playerId)
    };
  }

  async function subscribe(roomId, playerId, onState, serverId) {
    const context = await getContextForRoom(roomId, playerId, serverId);
    unsubscribe();
    state.context = context;
    state.serverId = context.server.id;
    state.roomId = roomId;
    state.playerId = playerId;
    state.onState = onState;
    const playerSnap = await get(ref(context.db, path('players', roomId, playerId)));
    if (!playerSnap.exists() || playerSnap.val().ativo === false) {
      throw new Error('Sua entrada nessa sala expirou.');
    }
    await enterPresence(context, roomId, playerId);

    state.unsubscribeRoom = onValue(ref(context.db, path('rooms', roomId)), function(snapshot) {
      state.room = snapshot.val();
      emitState();
    });
    state.unsubscribePlayers = onValue(ref(context.db, path('players', roomId)), function(snapshot) {
      const value = snapshot.val() || {};
      state.players = Object.keys(value).map(function(id) {
        return value[id];
      }).sort(sortPlayers);
      emitState();
    });
  }

  function unsubscribe() {
    if (state.unsubscribeRoom) {
      state.unsubscribeRoom();
    }
    if (state.unsubscribePlayers) {
      state.unsubscribePlayers();
    }
    if (state.heartbeatId) {
      window.clearInterval(state.heartbeatId);
    }
    state.unsubscribeRoom = null;
    state.unsubscribePlayers = null;
    state.heartbeatId = null;
    state.room = null;
    state.players = [];
    state.onState = null;
    state.lastMaintenanceAt = 0;
  }

  async function startGame(roomId, playerId) {
    const context = await getContext();
    const room = await getRoom(context, roomId);
    const players = await getPlayers(context, roomId);
    assertRoom(room);
    assertHost(room, playerId);
    if (players.filter(isActivePlayer).length < MIN_PLAYERS) {
      throw new Error('Precisa de pelo menos 2 jogadores.');
    }

    const now = Date.now();
    await update(ref(context.db, path('rooms', roomId)), {
      status: 'EM_ANDAMENTO',
      iniciadoEmMs: now,
      atualizadoEmMs: now,
      lastAction: makeAction('JOGO_INICIADO', 'Partida iniciada.', playerId)
    });
    return { estado: buildEstado(Object.assign({}, room, { status: 'EM_ANDAMENTO', iniciadoEmMs: now }), players, playerId) };
  }

  async function rollDice(roomId, playerId, options) {
    const context = await getContext();
    const room = await getRoom(context, roomId);
    const players = await getPlayers(context, roomId);
    assertRunning(room);
    const expiredRoom = await closeIfTimeExpired(context, room, players, playerId);
    if (expiredRoom) {
      return { tempoEsgotado: true, estado: buildEstado(expiredRoom, players, playerId) };
    }

    if (room.pendingQuestion) {
      if (room.pendingQuestion.playerId !== playerId) {
        throw new Error('Existe uma pergunta pendente para outro jogador.');
      }
      return {
        dado: room.pendingQuestion.dado,
        pergunta: publicQuestion(getQuestion(room, room.pendingQuestion.perguntaId)),
        pendente: room.pendingQuestion,
        estado: buildEstado(room, players, playerId)
      };
    }

    const currentPlayer = getCurrentPlayer(room, players);
    if (!currentPlayer || currentPlayer.playerId !== playerId) {
      throw new Error('Ainda não é a sua vez.');
    }

    if (currentPlayer.pulouProximaRodada) {
      const next = advanceTurn(room, players);
      await update(ref(context.db), {
        [path('players', roomId, playerId, 'pulouProximaRodada')]: false,
        [path('rooms', roomId, 'jogadorDaVezIndex')]: next.jogadorDaVezIndex,
        [path('rooms', roomId, 'rodada')]: next.rodada,
        [path('rooms', roomId, 'atualizadoEmMs')]: Date.now(),
        [path('rooms', roomId, 'lastAction')]: makeAction('TURNO_PULADO', currentPlayer.nome + ' ficou uma rodada sem jogar.', playerId)
      });
      return { pulouTurno: true, estado: buildEstado(Object.assign({}, room, next), players, playerId) };
    }

    const dado = getDiceValue(options, currentPlayer);
    const origem = Number(currentPlayer.posicao || 0);
    const destino = origem + dado;
    const now = Date.now();

    if (destino > BOARD_END) {
      const next = advanceTurn(room, players);
      const necessario = BOARD_END - origem;
      await update(ref(context.db), {
        [path('rooms', roomId, 'jogadorDaVezIndex')]: next.jogadorDaVezIndex,
        [path('rooms', roomId, 'rodada')]: next.rodada,
        [path('rooms', roomId, 'atualizadoEmMs')]: now,
        [path('rooms', roomId, 'lastDice')]: { playerId: playerId, valor: dado, createdAt: now },
        [path('rooms', roomId, 'lastAction')]: makeAction('MOVIMENTO', currentPlayer.nome + ' tirou ' + dado + ', mas precisava tirar ' + necessario + ' para chegar na casa 30. Permaneceu na casa ' + origem + '.', playerId, dado, origem)
      });
      return { dado: dado, semMovimento: true, estado: buildEstado(Object.assign({}, room, next), players, playerId) };
    }

    if (isAdminPlayer(currentPlayer)) {
      return rollAdmin(context, room, players, currentPlayer, dado, origem, destino);
    }

    const question = drawQuestion(room);
    const special = getSpecialHouse(destino);
    const pending = {
      salaId: roomId,
      playerId: playerId,
      perguntaId: question.perguntaId,
      origem: origem,
      destino: destino,
      casa: destino,
      dado: dado,
      trocaUsada: false,
      permiteTroca: !!(special && special.permiteTroca),
      bonus: !!(special && special.bonus),
      especial: special || null,
      criadoEmMs: now
    };

    await update(ref(context.db), {
      [path('rooms', roomId, 'pendingQuestion')]: pending,
      [path('rooms', roomId, 'questionCursor')]: nextQuestionCursor(room),
      [path('rooms', roomId, 'atualizadoEmMs')]: now,
      [path('rooms', roomId, 'lastDice')]: { playerId: playerId, valor: dado, createdAt: now },
      [path('rooms', roomId, 'lastAction')]: makeAction('PERGUNTA_SORTEADA', currentPlayer.nome + ' rolou ' + dado + '. Para avançar para a casa ' + destino + ', precisa acertar a pergunta.', playerId, dado, destino)
    });

    return {
      dado: dado,
      pergunta: publicQuestion(question),
      pendente: pending,
      estado: buildEstado(Object.assign({}, room, { pendingQuestion: pending }), players, playerId)
    };
  }

  async function answerQuestion(roomId, playerId, perguntaId, answer) {
    const context = await getContext();
    const room = await getRoom(context, roomId);
    const players = await getPlayers(context, roomId);
    assertRunning(room);
    const expiredRoom = await closeIfTimeExpired(context, room, players, playerId);
    if (expiredRoom) {
      return {
        feedback: {
          correta: false,
          respostaCorreta: '',
          explicacao: 'O tempo da partida acabou.',
          posicaoAnterior: 0,
          posicaoAtual: 0,
          movimento: 0
        },
        estado: buildEstado(expiredRoom, players, playerId)
      };
    }

    const pending = room.pendingQuestion;
    if (!pending || pending.playerId !== playerId || pending.perguntaId !== perguntaId) {
      throw new Error('Não há pergunta pendente para você.');
    }

    const player = players.find(function(item) { return item.playerId === playerId; });
    const question = getQuestion(room, perguntaId);
    const correta = normalizeAnswer(question.correta) === normalizeAnswer(answer);
    const oldPosition = Number(pending.origem || player.posicao || 0);
    const targetPosition = Number(pending.destino || pending.casa || oldPosition);
    const result = applyAnswerResult(correta, oldPosition, targetPosition);
    const now = Date.now();
    const updates = {};
    const next = result.finalPosition >= BOARD_END ?null : advanceTurn(room, players);
    const action = result.finalPosition >= BOARD_END
      ?makeAction('JOGO_ENCERRADO', player.nome + ' venceu a partida.', playerId, pending.dado, result.finalPosition)
      : makeAction(
        correta ?'RESPOSTA_CORRETA' : 'RESPOSTA_ERRADA',
        correta ?player.nome + ' acertou e foi para a casa ' + result.finalPosition + '.' + result.extraMessage : player.nome + ' errou e ficou na casa ' + oldPosition + '.',
        playerId,
        pending.dado,
        result.finalPosition
      );

    updates[path('players', roomId, playerId, 'posicao')] = result.finalPosition;
    updates[path('players', roomId, playerId, 'pulouProximaRodada')] = result.skipNextRound || !!player.pulouProximaRodada;
    updates[path('rooms', roomId, 'pendingQuestion')] = null;
    updates[path('rooms', roomId, 'atualizadoEmMs')] = now;

    const feedback = {
      correta: correta,
      respostaCorreta: question.correta,
      explicacao: question.explicacao || '',
      posicaoAnterior: oldPosition,
      posicaoAtual: result.finalPosition,
      movimento: result.finalPosition - oldPosition,
      efeitoEspecial: result.appliedSpecial || null
    };

    if (result.finalPosition >= BOARD_END) {
      updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
      updates[path('rooms', roomId, 'vencedorPlayerId')] = playerId;
      updates[path('rooms', roomId, 'encerradoEmMs')] = now;
      updates[path('rooms', roomId, 'motivoEncerramento')] = 'VITORIA_PERGUNTA';
      updates[path('rooms', roomId, 'lastAction')] = action;
    } else {
      updates[path('rooms', roomId, 'jogadorDaVezIndex')] = next.jogadorDaVezIndex;
      updates[path('rooms', roomId, 'rodada')] = next.rodada;
      updates[path('rooms', roomId, 'lastAction')] = action;
    }

    await update(ref(context.db), updates);
    const newRoom = Object.assign({}, room, {
      pendingQuestion: null,
      atualizadoEmMs: now,
      lastAction: action
    }, result.finalPosition >= BOARD_END ?{
      status: 'ENCERRADA',
      vencedorPlayerId: playerId,
      encerradoEmMs: now,
      motivoEncerramento: 'VITORIA_PERGUNTA'
    } : {
      jogadorDaVezIndex: next.jogadorDaVezIndex,
      rodada: next.rodada
    });
    const newPlayers = players.map(function(item) {
      if (item.playerId !== playerId) {
        return item;
      }
      return Object.assign({}, item, {
        posicao: result.finalPosition,
        pulouProximaRodada: result.skipNextRound || !!item.pulouProximaRodada
      });
    });
    return {
      feedback: feedback,
      estado: buildEstado(newRoom, newPlayers, playerId)
    };
  }

  async function swapQuestion(roomId, playerId, perguntaIdAtual) {
    const context = await getContext();
    const room = await getRoom(context, roomId);
    const players = await getPlayers(context, roomId);
    const pending = room.pendingQuestion;
    if (!pending || pending.playerId !== playerId || pending.perguntaId !== perguntaIdAtual) {
      throw new Error('Nao ha pergunta para trocar.');
    }
    if (!pending.permiteTroca || pending.trocaUsada) {
      throw new Error('Esta casa não permite trocar novamente.');
    }

    const newQuestion = drawQuestion(room, perguntaIdAtual);
    const newPending = Object.assign({}, pending, {
      perguntaId: newQuestion.perguntaId,
      trocaUsada: true
    });
    const player = players.find(function(item) { return item.playerId === playerId; });
    await update(ref(context.db), {
      [path('rooms', roomId, 'pendingQuestion')]: newPending,
      [path('rooms', roomId, 'questionCursor')]: nextQuestionCursor(room),
      [path('rooms', roomId, 'atualizadoEmMs')]: Date.now(),
      [path('rooms', roomId, 'lastAction')]: makeAction('PERGUNTA_TROCADA', (player ?player.nome : 'Jogador') + ' trocou a pergunta.', playerId, pending.dado, pending.casa)
    });

    const newRoom = Object.assign({}, room, { pendingQuestion: newPending });
    return {
      pergunta: publicQuestion(newQuestion),
      estado: buildEstado(newRoom, players, playerId)
    };
  }

  async function adminBackOneHouse(roomId, playerId) {
    const context = await getContext();
    const players = await getPlayers(context, roomId);
    const player = players.find(function(item) { return item.playerId === playerId; });
    if (!isAdminPlayer(player)) {
      throw new Error('Apenas admin123 pode usar esse teste.');
    }

    const newPosition = Math.max(0, Number(player.posicao || 0) - 1);
    await update(ref(context.db), {
      [path('players', roomId, playerId, 'posicao')]: newPosition,
      [path('rooms', roomId, 'lastAction')]: makeAction('MOVIMENTO', 'admin123 voltou 1 casa para teste.', playerId, '', newPosition),
      [path('rooms', roomId, 'atualizadoEmMs')]: Date.now()
    });
    const room = await getRoom(context, roomId);
    const refreshedPlayers = await getPlayers(context, roomId);
    return { estado: buildEstado(room, refreshedPlayers, playerId) };
  }

  async function leaveRoom(roomId, playerId) {
    const context = await getContext();
    const room = await getRoom(context, roomId);
    const players = await getPlayers(context, roomId);
    const now = Date.now();
    const remainingPlayers = players.filter(function(player) {
      return player.playerId !== playerId && isActivePlayer(player);
    }).sort(sortPlayers);
    const updates = {
      [path('players', roomId, playerId, 'ativo')]: false,
      [path('players', roomId, playerId, 'statusConexao')]: 'DESCONECTADO',
      [path('players', roomId, playerId, 'ultimoSinalEm')]: now,
      [path('rooms', roomId, 'atualizadoEmMs')]: now
    };

    if (room && remainingPlayers.length === 0) {
      updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
      updates[path('rooms', roomId, 'encerradoEmMs')] = now;
      updates[path('rooms', roomId, 'motivoEncerramento')] = 'SEM_JOGADORES';
      updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_SAIU', 'A sala foi encerrada porque todos sairam.', playerId);
    } else if (room && room.status === 'AGUARDANDO' && remainingPlayers.length > 0 && room.hostPlayerId === playerId) {
      updates[path('rooms', roomId, 'hostPlayerId')] = remainingPlayers[0].playerId;
      updates[path('rooms', roomId, 'hostUid')] = remainingPlayers[0].uid || '';
      updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_SAIU', 'O criador saiu. A sala passou para ' + remainingPlayers[0].nome + '.', playerId);
    } else if (room && room.status === 'EM_ANDAMENTO' && room.modo !== 'SOLO' && remainingPlayers.length === 1) {
      updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
      updates[path('rooms', roomId, 'vencedorPlayerId')] = remainingPlayers[0].playerId;
      updates[path('rooms', roomId, 'encerradoEmMs')] = now;
      updates[path('rooms', roomId, 'motivoEncerramento')] = 'VITORIA_POR_SAIDA';
      updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGO_ENCERRADO', remainingPlayers[0].nome + ' venceu porque ficou sozinho na partida.', remainingPlayers[0].playerId);
    }

    await update(ref(context.db), updates);
    unsubscribe();
  }

  async function removeLocalSession(roomId, playerId) {
    try {
      await leaveRoom(roomId, playerId);
    } catch (error) {
      unsubscribe();
    }
  }

  async function rollAdmin(context, room, players, player, dado, origem, destino) {
    const roomId = room.salaId;
    const special = getSpecialHouse(destino);
    let finalPosition = destino;
    let updates = {};
    let action = makeAction('MOVIMENTO', player.nome + ' rolou ' + dado + ' e parou na casa ' + destino + '.', player.playerId, dado, destino);

    if (special && special.tipo === 'VOLTAR_2') {
      finalPosition = Math.max(0, destino - 2);
      action = makeAction('CASA_ESPECIAL', player.nome + ' caiu na casa ' + destino + ' e voltou para a casa ' + finalPosition + '.', player.playerId, dado, finalPosition);
    }
    if (special && special.tipo === 'AVANCAR_2') {
      finalPosition = Math.min(BOARD_END, destino + 2);
      action = makeAction('CASA_ESPECIAL', player.nome + ' caiu na casa 26 e avançou para a casa ' + finalPosition + '.', player.playerId, dado, finalPosition);
    }
    if (special && special.tipo === 'PULAR_PROXIMA') {
      updates[path('players', roomId, player.playerId, 'pulouProximaRodada')] = true;
      action = makeAction('CASA_ESPECIAL', player.nome + ' ficará uma rodada sem jogar.', player.playerId, dado, destino);
    }

    updates[path('players', roomId, player.playerId, 'posicao')] = finalPosition;
    updates[path('rooms', roomId, 'lastDice')] = { playerId: player.playerId, valor: dado, createdAt: Date.now() };
    updates[path('rooms', roomId, 'atualizadoEmMs')] = Date.now();

    if (finalPosition >= BOARD_END) {
      updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
      updates[path('rooms', roomId, 'vencedorPlayerId')] = player.playerId;
      updates[path('rooms', roomId, 'encerradoEmMs')] = Date.now();
      updates[path('rooms', roomId, 'motivoEncerramento')] = 'VITORIA_DADO_ADMIN';
      updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGO_ENCERRADO', player.nome + ' venceu a partida.', player.playerId, dado, BOARD_END);
    } else {
      const next = advanceTurn(room, players);
      updates[path('rooms', roomId, 'jogadorDaVezIndex')] = next.jogadorDaVezIndex;
      updates[path('rooms', roomId, 'rodada')] = next.rodada;
      updates[path('rooms', roomId, 'lastAction')] = action;
    }

    await update(ref(context.db), updates);
    const newRoom = await getRoom(context, roomId);
    const newPlayers = await getPlayers(context, roomId);
    return { dado: dado, estado: buildEstado(newRoom, newPlayers, player.playerId) };
  }

  function buildEstado(room, players, requesterPlayerId) {
    const activePlayers = players.filter(isActivePlayer).sort(sortPlayers);
    const displayPlayers = room.status === 'ENCERRADA' ?players.sort(sortPlayers) : activePlayers;
    const currentPlayer = room.status === 'EM_ANDAMENTO' ?getCurrentPlayer(room, activePlayers) : null;
    const hasWinner = isWinnerReason(room.motivoEncerramento) && room.vencedorPlayerId;
    const winner = hasWinner ?players.find(function(player) {
      return player.playerId === room.vencedorPlayerId;
    }) : null;
    const pending = buildPending(room);
    const now = Date.now();

    return {
      sala: Object.assign(publicRoom(room), {
        tempoRestanteSegundos: getRemainingSeconds(room, now),
        tempoDecorridoSegundos: getElapsedSeconds(room, now)
      }),
      jogadores: displayPlayers.map(publicPlayer),
      voce: publicPlayer(players.find(function(player) { return player.playerId === requesterPlayerId; }) || null),
      jogadorDaVez: currentPlayer ?publicPlayer(currentPlayer) : null,
      ultimaAcao: room.lastAction || null,
      ultimoDado: room.lastDice || null,
      perguntaPendente: pending,
      vencedor: winner ?publicPlayer(winner) : null,
      statusPartida: room.status,
      regras: {
        minimoJogadores: room.modo === 'SOLO' ?1 : MIN_PLAYERS,
        maximoJogadores: room.modo === 'SOLO' ?1 : MAX_PLAYERS
      },
      rankingGeral: []
    };
  }

  function isWinnerReason(reason) {
    return String(reason || '').indexOf('VITORIA_') === 0;
  }

  function buildPending(room) {
    const pending = room.pendingQuestion;
    if (!pending) {
      return null;
    }
    return Object.assign({}, pending, {
      pergunta: publicQuestion(getQuestion(room, pending.perguntaId))
    });
  }

  function applyAnswerResult(correta, oldPosition, targetPosition) {
    let finalPosition = oldPosition;
    let appliedSpecial = null;
    let extraMessage = '';
    let skipNextRound = false;
    const special = getSpecialHouse(targetPosition);

    if (correta) {
      finalPosition = targetPosition;
      if (special && special.tipo === 'CHEGADA') {
        finalPosition = BOARD_END;
      } else if (special) {
        appliedSpecial = special;
        if (special.tipo === 'VOLTAR_2') {
          finalPosition = Math.max(0, targetPosition - 2);
          extraMessage = ' Ao cair na casa ' + targetPosition + ', voltou 2 casas.';
        }
        if (special.tipo === 'AVANCAR_2') {
          finalPosition = targetPosition + 2;
          extraMessage = ' Ao cair na casa 26, avançou mais 2 casas.';
        }
        if (special.tipo === 'PULAR_PROXIMA') {
          skipNextRound = true;
          extraMessage = ' Ao cair na casa 19, ficará uma rodada sem jogar.';
        }
        if (special.tipo === 'DESAFIO_BONUS') {
          finalPosition = targetPosition + 1;
          extraMessage = ' Desafio bônus: avançou mais 1 casa.';
        }
      }
    }

    return {
      finalPosition: Math.min(finalPosition, BOARD_END),
      appliedSpecial: appliedSpecial,
      extraMessage: extraMessage,
      skipNextRound: skipNextRound
    };
  }

  async function closeIfTimeExpired(context, room, players, playerId) {
    if (!room || room.status !== 'EM_ANDAMENTO' || !room.iniciadoEmMs) {
      return null;
    }

    if (getElapsedSeconds(room, Date.now()) < GAME_TIME_LIMIT_SECONDS) {
      return null;
    }

    const roomId = room.salaId;
    const action = makeAction('JOGO_ENCERRADO', 'O tempo da partida acabou. Ninguém venceu.', playerId, '', '');
    await update(ref(context.db, path('rooms', roomId)), {
      status: 'ENCERRADA',
      vencedorPlayerId: '',
      encerradoEmMs: Date.now(),
      motivoEncerramento: 'TEMPO_ESGOTADO',
      pendingQuestion: null,
      lastAction: action,
      atualizadoEmMs: Date.now()
    });

    return Object.assign({}, room, {
      status: 'ENCERRADA',
      vencedorPlayerId: '',
      encerradoEmMs: Date.now(),
      motivoEncerramento: 'TEMPO_ESGOTADO',
      pendingQuestion: null,
      lastAction: action
    });
  }

  function drawQuestion(room, excludeId) {
    const questions = Array.isArray(room.questions) ?room.questions : Object.keys(room.questions || {}).map(function(key) { return room.questions[key]; });
    if (!questions.length) {
      throw new Error('Nenhuma pergunta carregada para esta sala.');
    }
    let index = Number(room.questionCursor || 0) % questions.length;
    let question = questions[index];
    if (excludeId && question.perguntaId === excludeId && questions.length > 1) {
      index = (index + 1) % questions.length;
      question = questions[index];
    }
    return question;
  }

  function nextQuestionCursor(room) {
    const questions = Array.isArray(room.questions) ?room.questions : Object.keys(room.questions || {});
    return (Number(room.questionCursor || 0) + 1) % Math.max(1, questions.length);
  }

  function getQuestion(room, perguntaId) {
    const questions = Array.isArray(room.questions) ?room.questions : Object.keys(room.questions || {}).map(function(key) { return room.questions[key]; });
    return questions.find(function(question) {
      return question.perguntaId === perguntaId;
    }) || questions[0] || {};
  }

  async function loadQuestions() {
    const questions = await FirebaseQuestions.load(30);
    if (!questions.length) {
      throw new Error('Nenhuma pergunta encontrada no Firebase.');
    }
    return questions;
  }

  async function getRoom(context, roomId) {
    const snapshot = await get(ref(context.db, path('rooms', roomId)));
    return snapshot.val();
  }

  async function getPlayers(context, roomId) {
    const snapshot = await withTimeout(
      get(ref(context.db, path('players', roomId))),
      SERVER_READ_TIMEOUT_MS,
      'Tempo limite ao ler jogadores.'
    );
    const value = snapshot.val() || {};
    return Object.keys(value).map(function(id) {
      return value[id];
    }).sort(sortPlayers);
  }

  async function getContext() {
    if (state.context) {
      return state.context;
    }

    const contexts = await getConfiguredContexts();
    state.context = contexts[0];
    state.serverId = contexts[0].server.id;
    return state.context;
  }

  async function getContextByServerId(serverId) {
    const contexts = await getConfiguredContexts();
    if (!serverId) {
      return contexts[0];
    }
    return contexts.find(function(context) {
      return context.server.id === serverId;
    }) || contexts[0];
  }

  async function getContextForRoom(roomId, playerId, serverId) {
    if (serverId) {
      return getContextByServerId(serverId);
    }

    if (state.context) {
      return state.context;
    }

    const contexts = await getConfiguredContexts();
    for (const context of contexts) {
      try {
        const playerSnap = await withTimeout(
          get(ref(context.db, path('players', roomId, playerId))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao localizar jogador.'
        );
        if (playerSnap.exists()) {
          return context;
        }
      } catch (error) {
        console.warn('Busca de jogador ignorou servidor:', getServerLabel(context.server), error);
      }
    }

    return contexts[0];
  }

  async function getConfiguredContexts() {
    const servers = getConfiguredServers();
    if (!servers.length) {
      throw new Error('Firebase não configurado.');
    }

    const results = await Promise.all(servers.map(async function(server) {
      if (!state.contexts[server.id]) {
        try {
          const app = getSharedApp(server);
          const auth = getAuth(app);
          const signIn = auth.currentUser
            ? Promise.resolve({ user: auth.currentUser })
            : signInAnonymously(auth);
          const authResult = await withTimeout(
            signIn,
            SERVER_CONNECT_TIMEOUT_MS,
            'Tempo limite ao conectar no ' + getServerLabel(server) + '.'
          );
          state.contexts[server.id] = {
            server: server,
            app: app,
            auth: auth,
            uid: authResult.user.uid,
            db: getDatabase(app)
          };
        } catch (error) {
          console.warn('Servidor da Corrida indisponível:', getServerLabel(server), error);
          return null;
        }
      }
      return state.contexts[server.id];
    }));
    const contexts = results.filter(Boolean);
    if (!contexts.length) {
      throw new Error('Nenhum servidor Firebase respondeu. Tente novamente em alguns segundos.');
    }
    return contexts;
  }

  async function chooseServer() {
    const contexts = await getConfiguredContexts();
    const candidates = await Promise.all(contexts.map(async function(context) {
      cleanupOldRooms(context).catch(function(error) {
        console.warn('Limpeza da Corrida ignorada:', error);
      });
      try {
        const roomsSnap = await withTimeout(
          get(ref(context.db, path('rooms'))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao contar salas.'
        );
        const rooms = roomsSnap.val() || {};
        const activeCount = Object.keys(rooms).filter(function(roomId) {
          return rooms[roomId] && rooms[roomId].status !== 'ENCERRADA';
        }).length;
        return { context: context, activeCount: activeCount };
      } catch (error) {
        console.warn('Contagem de salas ignorada:', error);
        return { context: context, activeCount: Infinity };
      }
    }));

    candidates.sort(function(a, b) {
      return a.activeCount - b.activeCount;
    });
    return (candidates[0] && candidates[0].context) || contexts[0];
  }

  async function findRoomByCode(code) {
    const contexts = await getConfiguredContexts();
    for (const context of contexts) {
      cleanupOldRooms(context).catch(function(error) {
        console.warn('Limpeza ao entrar ignorada:', error);
      });
      try {
        const codeSnap = await withTimeout(
          get(ref(context.db, path('codes', code))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao buscar código.'
        );
        if (codeSnap.exists()) {
          const roomId = codeSnap.val().salaId;
          const roomSnap = await withTimeout(
            get(ref(context.db, path('rooms', roomId))),
            SERVER_READ_TIMEOUT_MS,
            'Tempo limite ao abrir sala.'
          );
          const room = roomSnap.val();
          if (!room || room.status === 'ENCERRADA') {
            continue;
          }
          return {
            context: context,
            roomId: roomId
          };
        }
      } catch (error) {
        console.warn('Busca de sala ignorou servidor:', getServerLabel(context.server), error);
      }
    }
    return null;
  }

  function getSharedApp(server) {
    const appName = 'trilha-' + server.id;
    const existing = getApps().find(function(app) {
      return app.name === appName;
    });
    return existing || initializeApp(server.firebaseConfig, appName);
  }

  function getConfiguredServers() {
    const config = window.CLASSROOM_CONFIG || {};
    const servers = Array.isArray(config.servers) ?config.servers : [];
    return servers.filter(function(server) {
      const firebaseConfig = server && server.firebaseConfig ?server.firebaseConfig : {};
      return !!(firebaseConfig.apiKey &&
        firebaseConfig.databaseURL &&
        firebaseConfig.projectId &&
        firebaseConfig.appId &&
        String(firebaseConfig.apiKey).indexOf('COLE_AQUI') === -1);
    });
  }

  async function createUniqueCode(context) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = String(randomInt(1000, 9999));
      try {
        const snapshot = await withTimeout(
          get(ref(context.db, path('codes', code))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao conferir código.'
        );
        if (!snapshot.exists()) {
          return code;
        }
      } catch (error) {
        return code;
      }
    }
    return String(randomInt(10000, 99999));
  }

  async function enterPresence(context, roomId, playerId) {
    const updates = {
      statusConexao: 'ONLINE',
      ultimoSinalEm: Date.now()
    };
    await withTimeout(
      update(ref(context.db, path('players', roomId, playerId)), updates),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao atualizar presença.'
    );
    onDisconnect(ref(context.db, path('players', roomId, playerId))).update({
      statusConexao: 'DESCONECTADO'
    });
    if (state.heartbeatId) {
      window.clearInterval(state.heartbeatId);
    }
    state.heartbeatId = window.setInterval(function() {
      withTimeout(
        update(ref(context.db, path('players', roomId, playerId)), {
          statusConexao: 'ONLINE',
          ultimoSinalEm: Date.now()
        }),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao renovar presença.'
      ).catch(function(error) {
        console.warn('Presença da Corrida ignorada:', error);
      });
    }, 10000);
  }

  async function runConnectionMaintenance() {
    const context = state.context;
    const room = state.room;
    const players = state.players || [];
    const now = Date.now();

    if (!context || !room || !room.salaId || !players.length || now - state.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) {
      return;
    }

    state.lastMaintenanceAt = now;
    const roomId = room.salaId;
    const activePlayers = players.filter(isActivePlayer).sort(sortPlayers);
    const remainingPlayers = activePlayers.filter(function(player) {
      return !isExpiredNow(player, now);
    });
    const connectedPlayers = remainingPlayers.filter(function(player) {
      return isConnectedNow(player, now);
    });
    const updates = {};

    activePlayers.forEach(function(player) {
      if (!isConnectedNow(player, now) && player.statusConexao !== 'DESCONECTADO') {
        updates[path('players', roomId, player.playerId, 'statusConexao')] = 'DESCONECTADO';
      }
      if (isExpiredNow(player, now)) {
        updates[path('players', roomId, player.playerId, 'ativo')] = false;
        updates[path('players', roomId, player.playerId, 'statusConexao')] = 'DESCONECTADO';
      }
    });

    if (room.status === 'AGUARDANDO') {
      if (!remainingPlayers.length) {
        updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
        updates[path('rooms', roomId, 'encerradoEmMs')] = now;
        updates[path('rooms', roomId, 'motivoEncerramento')] = 'SEM_JOGADORES';
        updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_DESCONECTADO', 'A sala foi encerrada por falta de jogadores.', '', '', '');
      } else if (!remainingPlayers.some(function(player) { return player.playerId === room.hostPlayerId; })) {
        updates[path('rooms', roomId, 'hostPlayerId')] = remainingPlayers[0].playerId;
        updates[path('rooms', roomId, 'hostUid')] = remainingPlayers[0].uid || '';
      }
    }

    if (room.status === 'EM_ANDAMENTO') {
      if (room.modo !== 'SOLO' && connectedPlayers.length === 1 && activePlayers.length > 1) {
        updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
        updates[path('rooms', roomId, 'vencedorPlayerId')] = connectedPlayers[0].playerId;
        updates[path('rooms', roomId, 'encerradoEmMs')] = now;
        updates[path('rooms', roomId, 'motivoEncerramento')] = 'VITORIA_POR_DESCONEXAO';
        updates[path('rooms', roomId, 'pendingQuestion')] = null;
        updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGO_ENCERRADO', connectedPlayers[0].nome + ' venceu porque ficou sozinho na partida.', connectedPlayers[0].playerId, '', connectedPlayers[0].posicao || 0);
      } else if (connectedPlayers.length === 0) {
        updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
        updates[path('rooms', roomId, 'encerradoEmMs')] = now;
        updates[path('rooms', roomId, 'motivoEncerramento')] = 'SEM_JOGADORES';
        updates[path('rooms', roomId, 'pendingQuestion')] = null;
        updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_DESCONECTADO', 'A sala foi encerrada por falta de jogadores.', '', '', '');
      } else {
        const currentPlayer = getCurrentPlayer(room, activePlayers);
        if (currentPlayer && !isConnectedNow(currentPlayer, now)) {
          const next = advanceTurn(room, activePlayers);
          updates[path('rooms', roomId, 'jogadorDaVezIndex')] = next.jogadorDaVezIndex;
          updates[path('rooms', roomId, 'rodada')] = next.rodada;
          updates[path('rooms', roomId, 'pendingQuestion')] = null;
          updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_DESCONECTADO', currentPlayer.nome + ' ficou sem sinal e teve a vez pulada.', currentPlayer.playerId, '', currentPlayer.posicao || 0);
        }
      }
    }

    if (Object.keys(updates).length) {
      updates[path('rooms', roomId, 'atualizadoEmMs')] = now;
      await update(ref(context.db), updates);
    }
  }

  async function cleanupOldRooms(context) {
    try {
      const snapshot = await withTimeout(
        get(ref(context.db, path('rooms'))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao ler salas antigas.'
      );
      const rooms = snapshot.val() || {};
      const now = Date.now();
      const updates = {};

      Object.keys(rooms).forEach(function(roomId) {
        const room = rooms[roomId] || {};
        const updatedAt = Number(room.atualizadoEmMs || room.criadoEmMs || 0);
        const age = now - updatedAt;

        if (room.status === 'ENCERRADA' && age > CLEANUP_FINISHED_MS) {
          updates[path('rooms', roomId)] = null;
          updates[path('players', roomId)] = null;
          if (room.codigoSala) {
            updates[path('codes', room.codigoSala)] = null;
          }
          return;
        }

        if (room.status === 'AGUARDANDO' && age > CLEANUP_IDLE_LOBBY_MS) {
          updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
          updates[path('rooms', roomId, 'encerradoEmMs')] = now;
          updates[path('rooms', roomId, 'motivoEncerramento')] = 'LOBBY_INATIVO';
          updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGADOR_DESCONECTADO', 'Sala encerrada por inatividade.', '', '', '');
          updates[path('rooms', roomId, 'atualizadoEmMs')] = now;
          return;
        }

        if (room.status === 'EM_ANDAMENTO' && age > CLEANUP_RUNNING_MS) {
          updates[path('rooms', roomId, 'status')] = 'ENCERRADA';
          updates[path('rooms', roomId, 'vencedorPlayerId')] = '';
          updates[path('rooms', roomId, 'encerradoEmMs')] = now;
          updates[path('rooms', roomId, 'motivoEncerramento')] = 'TEMPO_MAXIMO';
          updates[path('rooms', roomId, 'pendingQuestion')] = null;
          updates[path('rooms', roomId, 'lastAction')] = makeAction('JOGO_ENCERRADO', 'Partida encerrada por tempo máximo.', '', '', '');
          updates[path('rooms', roomId, 'atualizadoEmMs')] = now;
        }
      });

      if (Object.keys(updates).length) {
        await withTimeout(
          update(ref(context.db), updates),
          SERVER_WRITE_TIMEOUT_MS,
          'Tempo limite ao limpar salas antigas.'
        );
      }
    } catch (error) {
      console.warn('Limpeza de salas antigas ignorada:', error);
    }
  }

  function emitState() {
    if (!state.room || !state.players.length || !state.onState) {
      return;
    }
    runConnectionMaintenance().catch(function(error) {
      console.warn('Manutencao Firebase falhou:', error);
    });
    state.onState(buildEstado(state.room, state.players, state.playerId));
  }

  function publicRoom(room) {
    return {
      salaId: room.salaId,
      codigoSala: room.codigoSala,
      status: room.status,
      criadoEm: toIso(room.criadoEmMs),
      atualizadoEm: toIso(room.atualizadoEmMs),
      jogadorDaVezIndex: Number(room.jogadorDaVezIndex || 0),
      vencedorPlayerId: room.vencedorPlayerId || '',
      rodada: Number(room.rodada || 1),
      modo: room.modo || 'MULTI',
      serverId: room.serverId || state.serverId || (state.context && state.context.server ?state.context.server.id : ''),
      iniciadoEm: room.iniciadoEmMs ?toIso(room.iniciadoEmMs) : '',
      encerradoEm: room.encerradoEmMs ?toIso(room.encerradoEmMs) : '',
      motivoEncerramento: room.motivoEncerramento || ''
    };
  }

  function publicPlayer(player) {
    if (!player) {
      return null;
    }
    return {
      playerId: player.playerId,
      salaId: player.salaId,
      nome: player.nome,
      ordem: Number(player.ordem || 0),
      posicao: Number(player.posicao || 0),
      ativo: player.ativo !== false,
      pulouProximaRodada: !!player.pulouProximaRodada,
      criadoEm: toIso(player.criadoEmMs),
      ultimoSinalEm: toIso(player.ultimoSinalEm),
      statusConexao: player.statusConexao || 'ONLINE'
    };
  }

  function publicQuestion(question) {
    if (!question) {
      return null;
    }
    return {
      perguntaId: question.perguntaId,
      tipo: question.tipo,
      enunciado: question.enunciado,
      alternativas: question.alternativas
    };
  }

  function makePlayer(playerId, roomId, name, order, uid, now) {
    return {
      playerId: playerId,
      uid: uid,
      salaId: roomId,
      nome: String(name || 'Jogador').trim().slice(0, 40),
      ordem: order,
      posicao: 0,
      ativo: true,
      pulouProximaRodada: false,
      criadoEmMs: now,
      ultimoSinalEm: now,
      statusConexao: 'ONLINE'
    };
  }

  function makeAction(type, message, playerId, dado, posicao) {
    return {
      tipo: type,
      mensagem: message,
      playerId: playerId || '',
      dado: dado || '',
      posicao: posicao === undefined ?'' : posicao,
      criadoEmMs: Date.now()
    };
  }

  function getCurrentPlayer(room, players) {
    const activePlayers = players.filter(isActivePlayer).sort(sortPlayers);
    if (!activePlayers.length) {
      return null;
    }
    const index = Math.max(0, Math.min(Number(room.jogadorDaVezIndex || 0), activePlayers.length - 1));
    return activePlayers[index] || activePlayers[0];
  }

  function advanceTurn(room, players) {
    const activePlayers = players.filter(isActivePlayer).sort(sortPlayers);
    const currentIndex = Math.max(0, Math.min(Number(room.jogadorDaVezIndex || 0), Math.max(0, activePlayers.length - 1)));
    const nextIndex = activePlayers.length ?(currentIndex + 1) % activePlayers.length : 0;
    const rodada = Number(room.rodada || 1) + (nextIndex === 0 ?1 : 0);
    return {
      jogadorDaVezIndex: nextIndex,
      rodada: rodada
    };
  }

  function getDiceValue(options, player) {
    const forced = Number(options && options.dadoForcado);
    if (isAdminPlayer(player) && forced >= 1 && forced <= 6) {
      return forced;
    }
    return randomInt(1, 6);
  }

  function getSpecialHouse(position) {
    return SPECIAL_HOUSES[String(position)] || null;
  }

  function getRemainingSeconds(room, now) {
    if (room.status !== 'EM_ANDAMENTO' || !room.iniciadoEmMs) {
      return GAME_TIME_LIMIT_SECONDS;
    }
    return Math.max(0, GAME_TIME_LIMIT_SECONDS - getElapsedSeconds(room, now));
  }

  function getElapsedSeconds(room, now) {
    if (!room.iniciadoEmMs) {
      return 0;
    }
    const end = room.encerradoEmMs || now;
    return Math.max(0, Math.floor((end - room.iniciadoEmMs) / 1000));
  }

  function isActivePlayer(player) {
    return player && player.ativo !== false;
  }

  function isConnectedNow(player, now) {
    if (!player || player.ativo === false || player.statusConexao === 'DESCONECTADO') {
      return false;
    }
    return now - Number(player.ultimoSinalEm || 0) <= DISCONNECT_AFTER_MS;
  }

  function isExpiredNow(player, now) {
    if (!player || player.ativo === false) {
      return false;
    }
    return now - Number(player.ultimoSinalEm || 0) > EXPIRE_AFTER_MS;
  }

  function isAdminPlayer(player) {
    return String(player && player.nome || '').trim().toLowerCase() === 'admin123';
  }

  function sortPlayers(a, b) {
    return Number(a.ordem || 0) - Number(b.ordem || 0);
  }

  function normalizeAnswer(value) {
    return String(value || '').trim().toUpperCase().charAt(0);
  }

  function assertRoom(room) {
    if (!room) {
      throw new Error('Sala não encontrada.');
    }
  }

  function assertRunning(room) {
    assertRoom(room);
    if (room.status !== 'EM_ANDAMENTO') {
      throw new Error('O jogo não está em andamento.');
    }
  }

  function assertHost(room, playerId) {
    if (room.hostPlayerId !== playerId) {
      throw new Error('Apenas o criador pode iniciar.');
    }
  }

  function path() {
    return [ROOT].concat(Array.from(arguments)).join('/');
  }

  function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
  }

  function createId(prefix) {
    const array = new Uint32Array(2);
    crypto.getRandomValues(array);
    return prefix + '_' + Array.from(array).map(function(value) {
      return value.toString(16).toUpperCase();
    }).join('');
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise(function(_, reject) {
      timer = window.setTimeout(function() {
        reject(new Error(message || 'Tempo limite atingido.'));
      }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(function() {
      if (timer) {
        window.clearTimeout(timer);
      }
    });
  }

  function toIso(value) {
    return value ?new Date(Number(value)).toISOString() : '';
  }

  return {
    isConfigured,
    createRoom,
    joinRoom,
    subscribe,
    unsubscribe,
    startGame,
    rollDice,
    answerQuestion,
    swapQuestion,
    adminBackOneHouse,
    leaveRoom,
    removeLocalSession
  };
})();

window.FirebaseGame = FirebaseGame;



