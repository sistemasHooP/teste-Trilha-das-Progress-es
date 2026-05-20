const App = (function() {
  const STORAGE_KEYS = {
    salaId: 'trilha.salaId',
    playerId: 'trilha.playerId',
    playerName: 'trilha.playerName',
    engine: 'trilha.engine',
    serverId: 'trilha.serverId'
  };
  const DICE_MIN_ROLL_MS = 1300;
  const QUESTION_AFTER_DICE_MS = 520;
  const HEARTBEAT_INTERVAL = 10000;
  const MODE_INFOS = {
    race: {
      badge: 'Grupo',
      title: 'Corrida das Progressões',
      text: 'Modo de tabuleiro para jogar em grupo, com sala pequena e turnos sincronizados.',
      items: [
        'Ideal para 2 a 4 jogadores.',
        'Cada jogador rola o dado na sua vez.',
        'Para avançar, precisa acertar a pergunta de PA ou PG.'
      ]
    },
    solo: {
      badge: 'Solo',
      title: 'Missão PA & PG',
      text: 'Modo individual para treinar no mesmo tabuleiro, sem precisar esperar outros jogadores.',
      items: [
        'Ideal para estudar sozinho.',
        'O aluno joga no próprio ritmo.',
        'Boa opção para testar as casas especiais.'
      ]
    },
    classroom: {
      badge: 'Turma',
      title: 'Desafio da Turma',
      text: 'Modo rápido para o professor criar uma disputa com muitos alunos ao mesmo tempo.',
      items: [
        'Todos respondem as mesmas perguntas.',
        'O ranking valoriza acerto e velocidade.',
        'Melhor modo para sala cheia ou campeonato.'
      ]
    },
    mega: {
      badge: 'Interturmas',
      title: 'Mega Batalha',
      text: 'Modo ao vivo para 2, 3 ou 4 turmas competirem ao mesmo tempo com placar por equipe.',
      items: [
        'O professor cria o evento e define os nomes das turmas.',
        'Cada turma recebe um PIN próprio para evitar entradas erradas.',
        'A pontuação mistura acertos, velocidade e combo coletivo.'
      ]
    }
  };

  const state = {
    salaId: '',
    playerId: '',
    playerName: '',
    engine: '',
    serverId: '',
    estado: null,
    pollingId: null,
    modalMode: '',
    modalQuestionId: '',
    busyAction: false,
    delayQuestionOpen: false,
    lastAnswerReview: null,
    syncedRankingIds: {},
    ignoreStateUpdates: false,
    sessionVersion: 0,
    heartbeatId: null,
    reconnecting: false
  };

  function init() {
    bindEvents();
    restoreSession();

    if (!ApiClient.isConfigured()) {
      UI.setConnection('warn', 'Configurar API');
      UI.toast('Cole a URL do Web App em js/config.js para conectar o jogo.', 'warn');
    } else {
      UI.setConnection('idle', 'Pronto para jogar');
    }

    loadHomeRanking();
  }

  function bindEvents() {
    UI.$('#createRoomBtn').addEventListener('click', createRoom);
    UI.$('#soloRoomBtn').addEventListener('click', createSoloRoom);
    UI.$('#joinRoomBtn').addEventListener('click', function() {
      joinRoom();
    });
    UI.$('#startGameBtn').addEventListener('click', startGame);
    UI.$('#rollDiceBtn').addEventListener('click', rollDice);
    UI.$('#leaveLobbyBtn').addEventListener('click', leaveCurrentRoom);
    UI.$('#leaveGameBtn').addEventListener('click', leaveCurrentRoom);
    UI.$('#copyLobbyCodeBtn').addEventListener('click', function() {
      UI.copyText(UI.$('#roomCode').textContent, 'Código da sala copiado.');
    });
    UI.$('#finalHomeBtn').addEventListener('click', leaveToHome);
    UI.$('#newRoomBtn').addEventListener('click', createNewRoomFromFinal);
    UI.$('#answerQuestionBtn').addEventListener('click', answerQuestion);
    UI.$('#swapQuestionBtn').addEventListener('click', swapQuestion);
    UI.$('#reviewAnswerBtn').addEventListener('click', showAnswerReview);
    UI.$('#adminBackBtn').addEventListener('click', adminBackOneHouse);
    UI.$('#houseInfoClose').addEventListener('click', UI.hideHouseInfo);
    UI.$('#modeInfoClose').addEventListener('click', UI.hideModeInfo);
    UI.$('#modeInfoOk').addEventListener('click', UI.hideModeInfo);
    UI.$('#modeInfoScrim').addEventListener('click', UI.hideModeInfo);
    document.querySelectorAll('[data-mode-info]').forEach(function(button) {
      button.addEventListener('click', function() {
        UI.showModeInfo(MODE_INFOS[button.dataset.modeInfo]);
      });
    });
    document.querySelectorAll('[data-quick-join]').forEach(function(button) {
      button.addEventListener('click', function() {
        const card = button.closest('.mode-card');
        const input = card ? card.querySelector('[data-code-input]') : null;
        UI.$('#roomCodeInput').value = input ? input.value.trim() : '';
        joinRoom(button);
      });
    });
    document.querySelectorAll('[data-code-input]').forEach(function(input) {
      input.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter') {
          return;
        }

        event.preventDefault();
        const card = input.closest('.mode-card');
        const button = card ? card.querySelector('[data-quick-join]') : null;
        UI.$('#roomCodeInput').value = input.value.trim();
        joinRoom(button || UI.$('#joinRoomBtn'));
      });
    });
    UI.$('#boardMount').addEventListener('click', function(event) {
      const cell = event.target.closest('[data-position]');
      if (!cell) {
        return;
      }

      UI.showHouseInfo(Board.getHouseInfo(cell.dataset.position));
    });
    UI.$('#continueQuestionBtn').addEventListener('click', function() {
      state.modalMode = '';
      state.modalQuestionId = '';
      UI.closeQuestion();
    });

    UI.$('#answerOptions').addEventListener('click', function(event) {
      const button = event.target.closest('[data-answer]');
      if (button) {
        UI.selectAnswer(button.dataset.answer);
      }
    });

    UI.$('#homeForm').addEventListener('submit', function(event) {
      event.preventDefault();
    });
  }

  function restoreSession() {
    state.salaId = localStorage.getItem(STORAGE_KEYS.salaId) || '';
    state.playerId = localStorage.getItem(STORAGE_KEYS.playerId) || '';
    state.playerName = localStorage.getItem(STORAGE_KEYS.playerName) || '';
    state.engine = localStorage.getItem(STORAGE_KEYS.engine) || (state.salaId && state.playerId ?'gas' : '');
    state.serverId = localStorage.getItem(STORAGE_KEYS.serverId) || '';

    if (state.playerName) {
      UI.$('#playerName').value = state.playerName;
    }

    if (state.salaId && state.playerId && state.engine === 'firebase') {
      state.reconnecting = true;
      UI.setReconnect(true);
      restoreFirebaseSession();
    } else if (state.salaId && state.playerId && ApiClient.isConfigured()) {
      state.reconnecting = true;
      UI.setReconnect(true);
      startHeartbeat();
      refreshState(true);
      startPolling();
    } else {
      UI.showView('home');
    }
  }

  async function restoreFirebaseSession() {
    UI.setConnection('idle', 'Reconectando');

    try {
      const firebaseGame = await waitForFirebaseGame(2200);
      if (!firebaseGame || !firebaseGame.isConfigured || !firebaseGame.isConfigured()) {
        throw new Error('Firebase do jogo não carregou.');
      }

      await firebaseGame.subscribe(state.salaId, state.playerId, handleEstado, state.serverId);
      UI.setConnection('ok', 'Conectado');
    } catch (error) {
      state.reconnecting = false;
      UI.setReconnect(false);
      clearSession();
      UI.showView('home');
      UI.toast('Sessao anterior encerrada neste aparelho.', 'warn');
      window.setTimeout(function() {
        state.ignoreStateUpdates = false;
      }, 200);
    }
  }

  async function activateFirebaseSession(data, name) {
    const firebaseGame = await waitForFirebaseGame(2200);
    if (!firebaseGame || !firebaseGame.subscribe) {
      throw new Error('Firebase do jogo não carregou.');
    }

    stopPolling();
    stopHeartbeat();
    saveSession(data.sala.salaId, data.jogador.playerId, name, 'firebase', data.sala.serverId || data.serverId || '');
    handleEstado(data.estado);
    await firebaseGame.subscribe(state.salaId, state.playerId, handleEstado, state.serverId);
  }

  async function createRoom() {
    const name = UI.$('#playerName').value.trim();
    if (!name) {
      UI.toast('Informe seu nome.', 'warn');
      return;
    }

    const button = UI.$('#createRoomBtn');
    stopPolling();
    clearSession();
    state.playerName = name;
    UI.setHomeBusy(true, button, 'Criando');

    try {
      const firebaseGame = await waitForFirebaseGame(1200);
      if (firebaseGame && firebaseGame.isConfigured && firebaseGame.isConfigured()) {
        const data = await firebaseGame.createRoom(name, 'MULTI');
        await activateFirebaseSession(data, name);
        UI.toast('Corrida das Progressões criada.');
        return;
      }

      if (!ApiClient.isConfigured()) {
        throw new Error('Configure o Firebase ou a URL da API para criar sala.');
      }

      const data = await ApiClient.request('criarSala', { nome: name });
      saveSession(data.sala.salaId, data.jogador.playerId, name, 'gas');
      handleEstado(data.estado);
      startHeartbeat();
      startPolling();
      UI.toast('Corrida das Progressões criada.');
    } catch (error) {
      handleError(error);
    } finally {
      UI.setHomeBusy(false);
    }
  }

  async function joinRoom(triggerButton) {
    const name = UI.$('#playerName').value.trim();
    const code = UI.$('#roomCodeInput').value.trim();

    if (!name) {
      UI.toast('Informe seu nome.', 'warn');
      return;
    }

    if (!code) {
      UI.toast('Informe o código da sala.', 'warn');
      return;
    }

    const button = triggerButton || UI.$('#joinRoomBtn');
    stopPolling();
    clearSession();
    state.playerName = name;
    UI.setHomeBusy(true, button, 'Verificando');

    try {
      const megaClient = await waitForMegaBattleClient(900);
      if (megaClient && typeof megaClient.tryJoinByCode === 'function') {
        const joinedMega = await megaClient.tryJoinByCode(name, code);
        if (joinedMega) {
          return;
        }
      }

      const classroomClient = await waitForClassroomClient(900);
      if (classroomClient && typeof classroomClient.tryJoinByCode === 'function') {
        const joinedChallenge = await classroomClient.tryJoinByCode(name, code);
        if (joinedChallenge) {
          return;
        }
      }

      const firebaseGame = await waitForFirebaseGame(1200);
      if (firebaseGame && firebaseGame.isConfigured && firebaseGame.isConfigured()) {
        UI.setHomeBusy(true, button, 'Entrando');
        const data = await firebaseGame.joinRoom(name, code);
        if (data) {
          await activateFirebaseSession(data, name);
          UI.toast('Você entrou na sala.');
          return;
        }
      }

      if (!ApiClient.isConfigured()) {
        throw new Error('Sala não encontrada.');
      }

      UI.setHomeBusy(true, button, 'Entrando');
      const data = await ApiClient.request('entrarSala', {
        codigoSala: code,
        nome: name
      });
      saveSession(data.sala.salaId, data.jogador.playerId, name, 'gas');
      handleEstado(data.estado);
      startHeartbeat();
      startPolling();
      UI.toast('Você entrou na sala.');
    } catch (error) {
      handleError(error);
    } finally {
      UI.setHomeBusy(false);
    }
  }

  async function createSoloRoom() {
    const name = UI.$('#playerName').value.trim();
    if (!name) {
      UI.toast('Informe seu nome.', 'warn');
      return;
    }

    const button = UI.$('#soloRoomBtn');
    stopPolling();
    stopHeartbeat();
    clearSession();
    state.playerName = name;
    UI.setHomeBusy(true, button, 'Criando');

    try {
      const firebaseGame = await waitForFirebaseGame(1200);
      if (firebaseGame && firebaseGame.isConfigured && firebaseGame.isConfigured()) {
        const data = await firebaseGame.createRoom(name, 'SOLO');
        await activateFirebaseSession(data, name);
        UI.toast('Missão PA & PG iniciada.');
        return;
      }

      if (!ApiClient.isConfigured()) {
        throw new Error('Configure o Firebase ou a URL da API para jogar solo.');
      }

      const data = await ApiClient.request('criarSalaSolo', { nome: name });
      saveSession(data.sala.salaId, data.jogador.playerId, name, 'gas');
      handleEstado(data.estado);
      startHeartbeat();
      startPolling();
      UI.toast('Missão PA & PG iniciada.');
    } catch (error) {
      handleError(error);
    } finally {
      UI.setHomeBusy(false);
    }
  }

  async function startGame() {
    if (state.busyAction) {
      return;
    }

    const button = UI.$('#startGameBtn');
    state.busyAction = true;
    UI.setWorking(true, 'Iniciando jogo', 'Preparando a partida.');
    UI.setButtonBusy(button, true, 'Iniciando');

    try {
      if (state.engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1500);
        if (!firebaseGame) {
          throw new Error('Firebase do jogo não carregou.');
        }
        const data = await firebaseGame.startGame(state.salaId, state.playerId);
        handleEstado(data.estado);
        UI.toast('Partida iniciada.');
        return;
      }

      const data = await ApiClient.request('iniciarJogo', {
        salaId: state.salaId,
        playerId: state.playerId
      });
      handleEstado(data.estado);
      UI.toast('Partida iniciada.');
    } catch (error) {
      handleError(error);
    } finally {
      state.busyAction = false;
      UI.setWorking(false);
      UI.setButtonBusy(button, false);
    }
  }

  async function rollDice() {
    if (state.busyAction) {
      return;
    }

    const button = UI.$('#rollDiceBtn');
    let rolledValue = null;
    let pendingToOpen = null;
    const rollStartedAt = Date.now();
    state.busyAction = true;
    state.delayQuestionOpen = true;
    state.lastAnswerReview = null;
    UI.setWorking(true, 'Rolando o dado', 'Preparando a pergunta.');
    UI.setDiceRolling(true);
    UI.setButtonBusy(button, true, 'Rolando');

    try {
      const payload = {
        salaId: state.salaId,
        playerId: state.playerId
      };
      const forcedDice = getForcedDiceValue();
      if (forcedDice) {
        payload.dadoForcado = forcedDice;
      }

      let data;
      if (state.engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1500);
        if (!firebaseGame) {
          throw new Error('Firebase do jogo não carregou.');
        }
        data = await firebaseGame.rollDice(state.salaId, state.playerId, payload);
      } else {
        data = await ApiClient.request('rolarDado', payload);
      }
      handleEstado(data.estado);

      if (data.dado) {
        rolledValue = data.dado;
        UI.setDiceValue(data.dado);
      }

      if (data.pergunta) {
        pendingToOpen = data.estado.perguntaPendente;
      }

      if (data.especial) {
        UI.toast(data.estado.ultimaAcao.mensagem);
      }
    } catch (error) {
      handleError(error);
    } finally {
      const elapsed = Date.now() - rollStartedAt;
      const delay = Math.max(0, DICE_MIN_ROLL_MS - elapsed);
      window.setTimeout(function() {
        UI.setDiceRolling(false, rolledValue || Game.lastDice(state.estado));
        UI.setButtonBusy(button, false, null, false);
        state.delayQuestionOpen = false;
        state.busyAction = false;
        UI.setWorking(false);
        if (state.estado && state.estado.sala.status === 'EM_ANDAMENTO') {
          UI.renderGame(state.estado, state.playerId);
        }
        if (pendingToOpen && state.estado && state.estado.sala.status === 'EM_ANDAMENTO') {
          window.setTimeout(function() {
            if (state.estado && state.estado.sala.status === 'EM_ANDAMENTO' && !state.busyAction) {
              openPendingQuestion(pendingToOpen);
            }
          }, QUESTION_AFTER_DICE_MS);
        }
      }, delay);
    }
  }

  async function answerQuestion() {
    if (state.busyAction) {
      return;
    }

    const pending = Game.getMyPendingQuestion(state.estado, state.playerId);
    const answer = UI.getSelectedAnswer();

    if (!pending || !answer) {
      return;
    }

    const button = UI.$('#answerQuestionBtn');
    state.busyAction = true;
    UI.setButtonBusy(button, true, 'Enviando');
    state.modalMode = '';
    state.modalQuestionId = '';
    UI.closeQuestion();

    try {
      let data;
      if (state.engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1500);
        if (!firebaseGame) {
          throw new Error('Firebase do jogo não carregou.');
        }
        data = await firebaseGame.answerQuestion(state.salaId, state.playerId, pending.perguntaId, answer);
      } else {
        data = await ApiClient.request('responderPergunta', {
          salaId: state.salaId,
          playerId: state.playerId,
          perguntaId: pending.perguntaId,
          resposta: answer
        });
      }
      state.lastAnswerReview = data.feedback.correta ?null : data.feedback;
      UI.toast(data.feedback.correta ?'Resposta correta!' : getWrongAnswerMessage(data.feedback), data.feedback.correta ?'info' : 'error');
      handleEstado(data.estado);
    } catch (error) {
      handleError(error);
    } finally {
      state.busyAction = false;
      UI.setButtonBusy(button, false);
    }
  }

  async function swapQuestion() {
    if (state.busyAction) {
      return;
    }

    const pending = Game.getMyPendingQuestion(state.estado, state.playerId);
    if (!pending) {
      return;
    }

    const button = UI.$('#swapQuestionBtn');
    state.busyAction = true;
    UI.setWorking(true, 'Trocando pergunta', 'Buscando outra questão para este turno.');
    UI.setButtonBusy(button, true, 'Trocando');

    try {
      let data;
      if (state.engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1500);
        if (!firebaseGame) {
          throw new Error('Firebase do jogo não carregou.');
        }
        data = await firebaseGame.swapQuestion(state.salaId, state.playerId, pending.perguntaId);
      } else {
        data = await ApiClient.request('trocarPergunta', {
          salaId: state.salaId,
          playerId: state.playerId,
          perguntaIdAtual: pending.perguntaId
        });
      }
      handleEstado(data.estado);
      openPendingQuestion(data.estado.perguntaPendente);
      UI.toast('Pergunta trocada.');
    } catch (error) {
      handleError(error);
    } finally {
      state.busyAction = false;
      UI.setWorking(false);
      UI.setButtonBusy(button, false);
    }
  }

  async function adminBackOneHouse() {
    if (state.busyAction) {
      return;
    }

    if (!state.estado || !Game.isAdmin(state.estado, state.playerId)) {
      return;
    }

    const button = UI.$('#adminBackBtn');
    state.busyAction = true;
    state.lastAnswerReview = null;
    UI.setWorking(true, 'Movendo teste', 'Voltando 1 casa.');
    UI.setButtonBusy(button, true, 'Voltando');

    try {
      let data;
      if (state.engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1500);
        if (!firebaseGame) {
          throw new Error('Firebase do jogo não carregou.');
        }
        data = await firebaseGame.adminBackOneHouse(state.salaId, state.playerId);
      } else {
        data = await ApiClient.request('adminVoltarUmaCasa', {
          salaId: state.salaId,
          playerId: state.playerId
        });
      }
      handleEstado(data.estado);
    } catch (error) {
      handleError(error);
    } finally {
      state.busyAction = false;
      UI.setWorking(false);
      UI.setButtonBusy(button, false);
    }
  }

  async function refreshState(silent) {
    if (state.engine === 'firebase') {
      return;
    }

    if (!state.salaId || !state.playerId || !ApiClient.isConfigured()) {
      return;
    }

    if (state.ignoreStateUpdates || (silent && state.busyAction)) {
      return;
    }

    const requestVersion = state.sessionVersion;
    const requestSalaId = state.salaId;

    try {
      const data = await ApiClient.request('getEstadoSala', {
        salaId: state.salaId,
        playerId: state.playerId
      });

      if (requestVersion !== state.sessionVersion || requestSalaId !== state.salaId) {
        return;
      }

      handleEstado(data.estado);
      UI.setConnection('ok', 'Conectado');
    } catch (error) {
      if (requestVersion !== state.sessionVersion || requestSalaId !== state.salaId) {
        return;
      }

      const busy = /ocupado|bloqueio|lock/i.test(error.message || '');
      UI.setConnection(busy ?'warn' : 'error', busy ?'Sincronizando' : 'Sem conexão');
      if (state.reconnecting) {
        state.reconnecting = false;
        UI.setReconnect(false);
      }
      if (!silent) {
        handleError(error);
      }
    }
  }

  function handleEstado(estado) {
    if (state.ignoreStateUpdates) {
      return;
    }

    if (!state.salaId || !state.playerId || !estado || !estado.sala || estado.sala.salaId !== state.salaId) {
      return;
    }

    if (!estado.voce && estado.sala.status !== 'ENCERRADA') {
      stopPolling();
      stopHeartbeat();
      clearSession();
      UI.closeQuestion();
      UI.showView('home');
      UI.toast('Você saiu dessa sala. Entre ou crie uma nova sala.', 'warn');
      return;
    }

    state.estado = estado;
    UI.setConnection('ok', 'Conectado');
    if (state.reconnecting) {
      state.reconnecting = false;
      UI.setReconnect(false);
    }

    if (estado.sala.status === 'AGUARDANDO') {
      UI.renderLobby(estado, state.playerId, state.busyAction);
    }

    if (estado.sala.status === 'EM_ANDAMENTO') {
      UI.renderGame(estado, state.playerId);
      UI.renderAnswerReview(state.lastAnswerReview);
    }

    if (estado.sala.status === 'ENCERRADA') {
      stopPolling();
      stopHeartbeat();
      state.modalMode = '';
      UI.closeQuestion();
      UI.renderFinal(estado);
      syncFinalRanking(estado);
    }

    const pending = Game.getMyPendingQuestion(estado, state.playerId);
    if (pending && estado.sala.status === 'EM_ANDAMENTO') {
      if (!state.busyAction && !state.delayQuestionOpen && state.modalMode !== 'feedback' && state.modalQuestionId !== pending.perguntaId) {
        openPendingQuestion(pending);
      }
    } else if (state.modalMode === 'question') {
      state.modalMode = '';
      state.modalQuestionId = '';
      UI.closeQuestion();
    }
  }

  function openPendingQuestion(pending) {
    if (!pending || !pending.pergunta) {
      return;
    }

    state.modalMode = 'question';
    state.modalQuestionId = pending.perguntaId;
    UI.openQuestion(pending);
  }

  function getForcedDiceValue() {
    if (!state.estado || !Game.isAdmin(state.estado, state.playerId)) {
      return '';
    }

    const select = UI.$('#forcedDiceSelect');
    return select ?select.value : '';
  }

  function getWrongAnswerMessage(feedback) {
    const moved = Math.abs(Number(feedback.movimento || 0));
    if (moved === 0) {
      return 'Resposta errada. Você ficou na mesma casa.';
    }

    if (moved > 1) {
      return 'Resposta errada. Você voltou ' + moved + ' casas.';
    }
    return 'Resposta errada. Você não avançou.';
  }

  function showAnswerReview() {
    if (state.lastAnswerReview) {
      UI.showAnswerReview(state.lastAnswerReview);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollingId = window.setInterval(function() {
      refreshState(true);
    }, CONFIG.POLLING_INTERVAL || 2000);
  }

  function stopPolling() {
    if (state.pollingId) {
      window.clearInterval(state.pollingId);
      state.pollingId = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    sendHeartbeat(true);
    state.heartbeatId = window.setInterval(function() {
      sendHeartbeat(false);
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (state.heartbeatId) {
      window.clearInterval(state.heartbeatId);
      state.heartbeatId = null;
    }
  }

  async function sendHeartbeat(silent) {
    if (state.engine === 'firebase') {
      return;
    }

    if (!state.salaId || !state.playerId || !ApiClient.isConfigured() || state.ignoreStateUpdates) {
      return;
    }

    const requestVersion = state.sessionVersion;
    const requestSalaId = state.salaId;

    try {
      const data = await ApiClient.request('registrarPresenca', {
        salaId: state.salaId,
        playerId: state.playerId
      });

      if (requestVersion !== state.sessionVersion || requestSalaId !== state.salaId) {
        return;
      }

      if (!state.busyAction && data.estado) {
        handleEstado(data.estado);
      }
    } catch (error) {
      if (requestVersion !== state.sessionVersion || requestSalaId !== state.salaId) {
        return;
      }

      if (!silent) {
        handleError(error);
      }
    }
  }

  function saveSession(salaId, playerId, playerName, engine, serverId) {
    state.sessionVersion += 1;
    state.ignoreStateUpdates = false;
    state.salaId = salaId;
    state.playerId = playerId;
    state.playerName = playerName;
    state.engine = engine || 'gas';
    state.serverId = serverId || '';
    localStorage.setItem(STORAGE_KEYS.salaId, salaId);
    localStorage.setItem(STORAGE_KEYS.playerId, playerId);
    localStorage.setItem(STORAGE_KEYS.playerName, playerName);
    localStorage.setItem(STORAGE_KEYS.engine, state.engine);
    if (state.serverId) {
      localStorage.setItem(STORAGE_KEYS.serverId, state.serverId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.serverId);
    }
  }

  function clearSession() {
    stopPolling();
    stopHeartbeat();
    disconnectFirebaseGame();
    state.sessionVersion += 1;
    state.ignoreStateUpdates = true;
    state.salaId = '';
    state.playerId = '';
    state.engine = '';
    state.serverId = '';
    state.estado = null;
    state.modalMode = '';
    state.modalQuestionId = '';
    state.busyAction = false;
    state.delayQuestionOpen = false;
    state.lastAnswerReview = null;
    state.reconnecting = false;
    UI.setReconnect(false);
    localStorage.removeItem(STORAGE_KEYS.salaId);
    localStorage.removeItem(STORAGE_KEYS.playerId);
    localStorage.removeItem(STORAGE_KEYS.engine);
    localStorage.removeItem(STORAGE_KEYS.serverId);
  }

  function leaveToHome() {
    stopPolling();
    clearSession();
    UI.closeQuestion();
    UI.showView('home');
    loadHomeRanking();
    window.setTimeout(function() {
      state.ignoreStateUpdates = false;
    }, 200);
  }

  async function leaveCurrentRoom() {
    const salaId = state.salaId;
    const playerId = state.playerId;
    const engine = state.engine;

    stopPolling();
    stopHeartbeat();
    UI.setLeaving(true);

    try {
      if (salaId && playerId && engine === 'firebase') {
        const firebaseGame = await waitForFirebaseGame(1200);
        if (firebaseGame && firebaseGame.leaveRoom) {
          await firebaseGame.leaveRoom(salaId, playerId);
        }
      } else if (salaId && playerId && ApiClient.isConfigured()) {
        await ApiClient.request('sairSala', {
          salaId: salaId,
          playerId: playerId
        });
      }
    } catch (error) {
      UI.toast('Você saiu neste aparelho. A sala antiga será ignorada aqui.', 'warn');
    } finally {
      UI.setLeaving(false);
      clearSession();
      UI.closeQuestion();
      UI.showView('home');
      loadHomeRanking();
      window.setTimeout(function() {
        state.ignoreStateUpdates = false;
      }, 200);
    }
  }

  async function createNewRoomFromFinal() {
    const name = state.playerName || localStorage.getItem(STORAGE_KEYS.playerName) || UI.$('#playerName').value.trim();
    leaveToHome();
    UI.$('#playerName').value = name;
    if (name) {
      await createRoom();
    }
  }

  function handleError(error) {
    if (state.reconnecting) {
      state.reconnecting = false;
      UI.setReconnect(false);
    }
    const hasConnection = ApiClient.isConfigured() || (window.FirebaseGame && window.FirebaseGame.isConfigured && window.FirebaseGame.isConfigured());
    UI.setConnection(hasConnection ?'error' : 'warn', hasConnection ?'Erro' : 'Configurar API');
    UI.toast(error.message || String(error), 'error');
  }

  async function loadHomeRanking() {
    const firebaseRanking = await waitForFirebaseRanking(1200);
    if (firebaseRanking && firebaseRanking.isConfigured && firebaseRanking.isConfigured()) {
      try {
        const ranking = firebaseRanking.loadByCategories
          ? await firebaseRanking.loadByCategories(3)
          : await firebaseRanking.load(5);
        UI.renderHomeRanking(ranking);
        return;
      } catch (error) {
        console.warn('Ranking Firebase indisponível:', error);
      }
    }

    if (!ApiClient.isConfigured()) {
      UI.renderHomeRankingError();
      return;
    }

    try {
      const data = await ApiClient.request('getRanking', { limit: 5 });
      UI.renderHomeRanking({ race: data.ranking || [], solo: [], classroom: [] });
    } catch (error) {
      UI.renderHomeRankingError();
    }
  }

  async function syncFinalRanking(estado) {
    if (!isRankableFinal(estado)) {
      return;
    }

    const key = [estado.sala.modo || 'MULTI', estado.sala.salaId, estado.vencedor.playerId].join(':');
    if (state.syncedRankingIds[key]) {
      return;
    }
    state.syncedRankingIds[key] = true;

    const firebaseRanking = await waitForFirebaseRanking(1600);
    if (!firebaseRanking || !firebaseRanking.isConfigured || !firebaseRanking.isConfigured()) {
      return;
    }

    try {
      await firebaseRanking.saveResult(estado);
      const ranking = firebaseRanking.loadMode
        ? await firebaseRanking.loadMode(5, estado.sala.modo || 'MULTI')
        : await firebaseRanking.load(5);
      if (state.estado && state.estado.sala && state.estado.sala.salaId === estado.sala.salaId) {
        state.estado.rankingGeral = ranking;
        UI.renderFinal(state.estado);
      }
    } catch (error) {
      console.warn('Ranking Firebase não foi gravado:', error);
    }
  }

  function isRankableFinal(estado) {
    return !!(estado &&
      estado.sala &&
      estado.vencedor &&
      estado.sala.status === 'ENCERRADA' &&
      estado.sala.motivoEncerramento === 'VITORIA_PERGUNTA' &&
      Number(estado.sala.tempoDecorridoSegundos || 0) > 0);
  }

  function waitForClassroomClient(timeoutMs) {
    if (window.ClassroomChallenge) {
      return Promise.resolve(window.ClassroomChallenge);
    }

    return new Promise(function(resolve) {
      const started = Date.now();
      const timer = window.setInterval(function() {
        if (window.ClassroomChallenge || Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          resolve(window.ClassroomChallenge || null);
        }
      }, 50);
    });
  }

  function waitForMegaBattleClient(timeoutMs) {
    if (window.MegaBattle) {
      return Promise.resolve(window.MegaBattle);
    }

    return new Promise(function(resolve) {
      const started = Date.now();
      const timer = window.setInterval(function() {
        if (window.MegaBattle || Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          resolve(window.MegaBattle || null);
        }
      }, 50);
    });
  }

  function waitForFirebaseRanking(timeoutMs) {
    if (window.FirebaseRanking) {
      return Promise.resolve(window.FirebaseRanking);
    }

    return new Promise(function(resolve) {
      const started = Date.now();
      const timer = window.setInterval(function() {
        if (window.FirebaseRanking || Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          resolve(window.FirebaseRanking || null);
        }
      }, 50);
    });
  }

  function waitForFirebaseGame(timeoutMs) {
    if (window.FirebaseGame) {
      return Promise.resolve(window.FirebaseGame);
    }

    return new Promise(function(resolve) {
      const started = Date.now();
      const timer = window.setInterval(function() {
        if (window.FirebaseGame || Date.now() - started >= timeoutMs) {
          window.clearInterval(timer);
          resolve(window.FirebaseGame || null);
        }
      }, 50);
    });
  }

  function disconnectFirebaseGame() {
    if (window.FirebaseGame && typeof window.FirebaseGame.unsubscribe === 'function') {
      window.FirebaseGame.unsubscribe();
    }
  }

  function pauseForExternalMode() {
    clearSession();
    UI.closeQuestion();
    UI.setConnection('idle', 'Abrindo sala');
    window.setTimeout(function() {
      state.ignoreStateUpdates = false;
    }, 200);
  }

  return {
    init,
    pauseForExternalMode
  };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', App.init);
