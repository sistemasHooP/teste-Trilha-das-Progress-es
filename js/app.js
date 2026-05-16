const App = (function() {
  const STORAGE_KEYS = {
    salaId: 'trilha.salaId',
    playerId: 'trilha.playerId',
    playerName: 'trilha.playerName'
  };
  const DICE_RESULT_DELAY = 420;
  const HEARTBEAT_INTERVAL = 10000;

  const state = {
    salaId: '',
    playerId: '',
    playerName: '',
    estado: null,
    pollingId: null,
    modalMode: '',
    modalQuestionId: '',
    busyAction: false,
    delayQuestionOpen: false,
    lastAnswerReview: null,
    ignoreStateUpdates: false,
    sessionVersion: 0,
    heartbeatId: null
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
  }

  function bindEvents() {
    UI.$('#createRoomBtn').addEventListener('click', createRoom);
    UI.$('#soloRoomBtn').addEventListener('click', createSoloRoom);
    UI.$('#joinRoomBtn').addEventListener('click', joinRoom);
    UI.$('#startGameBtn').addEventListener('click', startGame);
    UI.$('#rollDiceBtn').addEventListener('click', rollDice);
    UI.$('#leaveLobbyBtn').addEventListener('click', leaveCurrentRoom);
    UI.$('#leaveGameBtn').addEventListener('click', leaveCurrentRoom);
    UI.$('#finalHomeBtn').addEventListener('click', leaveToHome);
    UI.$('#newRoomBtn').addEventListener('click', createNewRoomFromFinal);
    UI.$('#answerQuestionBtn').addEventListener('click', answerQuestion);
    UI.$('#swapQuestionBtn').addEventListener('click', swapQuestion);
    UI.$('#reviewAnswerBtn').addEventListener('click', showAnswerReview);
    UI.$('#adminBackBtn').addEventListener('click', adminBackOneHouse);
    UI.$('#houseInfoClose').addEventListener('click', UI.hideHouseInfo);
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

    if (state.playerName) {
      UI.$('#playerName').value = state.playerName;
    }

    if (state.salaId && state.playerId && ApiClient.isConfigured()) {
      startHeartbeat();
      refreshState(true);
      startPolling();
    } else {
      UI.showView('home');
    }
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
      const data = await ApiClient.request('criarSala', { nome: name });
      saveSession(data.sala.salaId, data.jogador.playerId, name);
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

  async function joinRoom() {
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

    const button = UI.$('#joinRoomBtn');
    stopPolling();
    clearSession();
    state.playerName = name;
    UI.setHomeBusy(true, button, 'Verificando');

    try {
      const classroomClient = await waitForClassroomClient(900);
      if (classroomClient && typeof classroomClient.tryJoinByCode === 'function') {
        const joinedChallenge = await classroomClient.tryJoinByCode(name, code);
        if (joinedChallenge) {
          return;
        }
      }

      UI.setHomeBusy(true, button, 'Entrando');
      const data = await ApiClient.request('entrarSala', {
        codigoSala: code,
        nome: name
      });
      saveSession(data.sala.salaId, data.jogador.playerId, name);
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
      const data = await ApiClient.request('criarSalaSolo', { nome: name });
      saveSession(data.sala.salaId, data.jogador.playerId, name);
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

      const data = await ApiClient.request('rolarDado', payload);
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
          openPendingQuestion(pendingToOpen);
        }
      }, DICE_RESULT_DELAY);
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
    UI.setWorking(true, 'Conferindo resposta', 'Aguarde um instante.');
    UI.setButtonBusy(button, true, 'Enviando');
    state.modalMode = '';
    state.modalQuestionId = '';
    UI.closeQuestion();

    try {
      const data = await ApiClient.request('responderPergunta', {
        salaId: state.salaId,
        playerId: state.playerId,
        perguntaId: pending.perguntaId,
        resposta: answer
      });
      state.lastAnswerReview = data.feedback.correta ? null : data.feedback;
      UI.toast(data.feedback.correta ? 'Resposta correta!' : getWrongAnswerMessage(data.feedback), data.feedback.correta ? 'info' : 'error');
      handleEstado(data.estado);
    } catch (error) {
      handleError(error);
    } finally {
      state.busyAction = false;
      UI.setWorking(false);
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
      const data = await ApiClient.request('trocarPergunta', {
        salaId: state.salaId,
        playerId: state.playerId,
        perguntaIdAtual: pending.perguntaId
      });
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
      const data = await ApiClient.request('adminVoltarUmaCasa', {
        salaId: state.salaId,
        playerId: state.playerId
      });
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
      UI.setConnection(busy ? 'warn' : 'error', busy ? 'Sincronizando' : 'Sem conexão');
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
    return select ? select.value : '';
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

  function saveSession(salaId, playerId, playerName) {
    state.sessionVersion += 1;
    state.ignoreStateUpdates = false;
    state.salaId = salaId;
    state.playerId = playerId;
    state.playerName = playerName;
    localStorage.setItem(STORAGE_KEYS.salaId, salaId);
    localStorage.setItem(STORAGE_KEYS.playerId, playerId);
    localStorage.setItem(STORAGE_KEYS.playerName, playerName);
  }

  function clearSession() {
    stopPolling();
    stopHeartbeat();
    state.sessionVersion += 1;
    state.ignoreStateUpdates = true;
    state.salaId = '';
    state.playerId = '';
    state.estado = null;
    state.modalMode = '';
    state.modalQuestionId = '';
    state.busyAction = false;
    state.delayQuestionOpen = false;
    state.lastAnswerReview = null;
    localStorage.removeItem(STORAGE_KEYS.salaId);
    localStorage.removeItem(STORAGE_KEYS.playerId);
  }

  function leaveToHome() {
    stopPolling();
    clearSession();
    UI.closeQuestion();
    UI.showView('home');
    window.setTimeout(function() {
      state.ignoreStateUpdates = false;
    }, 200);
  }

  async function leaveCurrentRoom() {
    const salaId = state.salaId;
    const playerId = state.playerId;

    stopPolling();
    stopHeartbeat();
    UI.setLeaving(true);

    try {
      if (salaId && playerId && ApiClient.isConfigured()) {
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
    UI.setConnection(ApiClient.isConfigured() ? 'error' : 'warn', ApiClient.isConfigured() ? 'Erro' : 'Configurar API');
    UI.toast(error.message || String(error), 'error');
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
