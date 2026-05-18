const UI = (function() {
  let selectedAnswer = '';
  let diceTimer = null;
  let gameClockTimer = null;
  let gameClockDeadline = 0;

  function $(selector) {
    return document.querySelector(selector);
  }

  function $all(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function showView(name) {
    $all('.view').forEach(function(view) {
      view.classList.remove('view--active');
    });
    $('#' + name + 'View').classList.add('view--active');
    if (name !== 'game') {
      stopGameClock();
    }
  }

  function setConnection(status, text) {
    const pill = $('#connectionStatus');
    pill.className = 'status-pill status-pill--' + status;
    pill.textContent = text;
  }

  function toast(message, type) {
    const host = $('#toastHost');
    const item = document.createElement('div');
    item.className = 'toast toast--' + (type || 'info');
    item.textContent = message;
    host.appendChild(item);

    window.setTimeout(function() {
      item.remove();
    }, 4200);
  }

  function renderLobby(estado, playerId, isBusy) {
    showView('lobby');
    $('#roomCode').textContent = estado.sala.codigoSala;
    
    // Atualiza o código público no botão de copiar
    $all('.copy-code-btn').forEach(function(btn) {
      btn.dataset.code = estado.sala.codigoSala;
    });

    const connectedCount = estado.jogadores.filter(function(player) {
      return !isDisconnected(player);
    }).length;
    $('#playerCountBadge').textContent = connectedCount + '/' + estado.regras.maximoJogadores;
    $('#lobbyPlayers').innerHTML = estado.jogadores.map(function(player) {
      return renderPlayerItem(player, playerId);
    }).join('');

    const isCreator = Game.isCreator(estado, playerId);
    const canStart = isCreator && connectedCount >= estado.regras.minimoJogadores;
    $('#startGameBtn').hidden = !isCreator;
    $('#startGameBtn').disabled = !canStart || !!isBusy;
    $('#startGameBtn').textContent = isBusy ? 'Iniciando jogo' : 'Iniciar jogo';
    $('#lobbyStatus').textContent = isBusy
      ? 'Preparando a partida.'
      : canStart
      ? 'A sala já pode iniciar.'
      : 'Mínimo 2 jogadores e máximo 4.';
  }

  function renderGame(estado, playerId) {
    showView('game');
    Board.render($('#boardMount'), estado);

    $('#roundValue').textContent = estado.sala.rodada || 1;
    $('#roomCodeGame').textContent = 'Sala ' + estado.sala.codigoSala;
    
    // Atualiza o código público no botão de copiar na tela do jogo
    $all('.copy-code-btn').forEach(function(btn) {
      btn.dataset.code = estado.sala.codigoSala;
    });

    $('#turnName').textContent = estado.jogadorDaVez ? estado.jogadorDaVez.nome : 'Aguardando';
    setGameClock(estado.sala.tempoRestanteSegundos);
    renderLastAction(estado);
    setDiceValue(Game.lastDice(estado));

    const canRoll = Game.isMyTurn(estado, playerId);
    const busyAction = document.body.classList.contains('is-busy-action');
    $('#rollDiceBtn').disabled = !canRoll || busyAction;
    $('#rollDiceBtn').textContent = busyAction ? 'Processando jogada' : (canRoll ? 'Sua vez: rolar dado' : 'Aguardando vez');
    $('#turnCard').classList.toggle('is-my-turn', canRoll);
    $('.turn-panel').classList.toggle('turn-panel--active', canRoll);
    $('#adminPanel').hidden = !Game.isAdmin(estado, playerId);

    $('#positionsList').innerHTML = estado.jogadores.map(function(player) {
      const color = Game.getPlayerColor(player.ordem);
      const skip = player.pulouProximaRodada ? '<span class="mini-badge">Pula</span>' : '';
      const connection = renderConnectionBadge(player);
      return [
        '<li class="position-item' + (isDisconnected(player) ? ' is-disconnected' : '') + '">',
        '  <span class="player-name"><span class="player-dot" style="background:' + color + '"></span><span>' + escapeHtml(player.nome) + '</span></span>',
        '  <strong>' + formatHouseLabel(player.posicao) + '</strong>',
        connection,
        skip,
        '</li>'
      ].join('');
    }).join('');
  }

  function renderFinal(estado) {
    showView('final');
    const winner = estado.vencedor;
    $('#finalTitle').textContent = winner ? 'Vitória!' : 'Fim da partida';
    $('#winnerName').textContent = winner
      ? winner.nome + ' venceu em ' + formatDuration(estado.sala.tempoDecorridoSegundos) + '.'
      : getFinalMessage(estado);
    $('#rankingList').innerHTML = Game.ranking(estado).map(function(player, index) {
      const color = Game.getPlayerColor(player.ordem);
      return [
        '<div class="ranking-item">',
        '  <span class="rank-number">' + (index + 1) + '</span>',
        '  <span class="player-name"><span class="player-dot" style="background:' + color + '"></span><span>' + escapeHtml(player.nome) + '</span></span>',
        '  <strong>' + formatHouseLabel(player.posicao) + '</strong>',
        '</div>'
      ].join('');
    }).join('');

    const fastest = estado.rankingGeral || [];
    $('#fastestRankingList').innerHTML = fastest.length
      ? fastest.map(function(item, index) {
        return [
          '<div class="ranking-item ranking-item--fastest">',
          '  <span class="rank-number">' + (index + 1) + '</span>',
          '  <span><strong>' + escapeHtml(item.nome) + '</strong><small>' + escapeHtml(item.modo || 'MULTI') + ' · sala ' + escapeHtml(item.codigoSala || '') + '</small></span>',
          '  <strong>' + formatDuration(item.duracaoSegundos) + '</strong>',
          '</div>'
        ].join('');
      }).join('')
      : '<p class="muted-text">Ainda não há vitórias registradas neste modo.</p>';
  }

  function renderHomeRanking(items) {
    const list = $('#homeRankingList');
    const status = $('#homeRankingStatus');

    if (!list || !status) {
      return;
    }

    const categories = Array.isArray(items)
      ? { race: items, solo: [], classroom: [] }
      : Object.assign({ race: [], solo: [], classroom: [] }, items || {});
    const total = Object.keys(categories).reduce(function(sum, key) {
      return sum + (Array.isArray(categories[key]) ? categories[key].length : 0);
    }, 0);

    status.textContent = total ? 'Top por modo' : 'Sem dados';
    renderHomeRankingCategory('race', categories.race || []);
    renderHomeRankingCategory('solo', categories.solo || []);
    renderHomeRankingCategory('classroom', categories.classroom || []);
  }

  function renderHomeRankingCategory(category, ranking) {
    const target = document.querySelector('[data-home-ranking="' + category + '"]');
    const items = Array.isArray(ranking) ? ranking : [];

    if (!target) {
      return;
    }

    target.innerHTML = items.length
      ? items.slice(0, 3).map(function(item, index) {
        return [
          '<div class="ranking-item ranking-item--fastest">',
          '  <span class="rank-number">' + (index + 1) + '</span>',
          '  <span><strong>' + escapeHtml(item.nome || 'Jogador') + '</strong><small>' + escapeHtml(getRankingSubtitle(item)) + '</small></span>',
          '  <strong>' + escapeHtml(getRankingValue(item)) + '</strong>',
          '</div>'
        ].join('');
      }).join('')
      : '<p class="muted-text">Ainda não há vitórias registradas.</p>';
  }

  function renderHomeRankingError() {
    const list = $('#homeRankingList');
    const status = $('#homeRankingStatus');

    if (!list || !status) {
      return;
    }

    status.textContent = 'Indisponível';
    ['race', 'solo', 'classroom'].forEach(function(category) {
      const target = document.querySelector('[data-home-ranking="' + category + '"]');
      if (target) {
        target.innerHTML = '<p class="muted-text">Ranking indisponível no momento.</p>';
      }
    });
  }

  function renderPlayerItem(player, playerId) {
    const color = Game.getPlayerColor(player.ordem);
    const you = player.playerId === playerId ? '<span class="mini-badge">Você</span>' : '';
    const creator = player.ordem === 0 ? '<span class="mini-badge">Criador</span>' : '';
    const connection = renderConnectionBadge(player);
    return [
      '<li class="player-item' + (isDisconnected(player) ? ' is-disconnected' : '') + '">',
      '  <span class="player-name"><span class="player-dot" style="background:' + color + '"></span><span>' + escapeHtml(player.nome) + '</span></span>',
      '  <span>' + connection + you + creator + '</span>',
      '</li>'
    ].join('');
  }

  function renderAnswerReview(feedback) {
    const panel = $('#answerReview');
    if (!panel) {
      return;
    }

    panel.hidden = !feedback;
  }

  function renderLastAction(estado) {
    const target = $('#lastAction');
    const action = estado.ultimaAcao;

    if (!action) {
      const sameAction = target.dataset.actionKey === 'idle';
      target.className = 'last-action last-action--idle';
      target.dataset.actionKey = 'idle';
      target.innerHTML = [
        '<summary class="action-summary">',
        '  <span class="action-dot" aria-hidden="true"></span>',
        '  <span class="action-text">',
        '    <span class="action-label">Última jogada</span>',
        '    <strong>Sem jogadas ainda</strong>',
        '    <small>Aguardando a primeira rolagem.</small>',
        '  </span>',
        '  <span class="action-more" aria-hidden="true"></span>',
        '</summary>'
      ].join('');
      target.open = sameAction && target.open;
      return;
    }

    const player = findPlayer(estado, action.playerId);
    const kind = getActionKind(action.tipo);
    const title = getActionTitle(action.tipo);
    const message = formatActionMessage(action.mensagem || 'Partida atualizada.');
    const actionKey = String(action.tipo || '') + ':' + String(action.criadoEmMs || message);
    const keepOpen = target.dataset.actionKey === actionKey && target.open;
    const chips = [];

    if (player) {
      chips.push('<span>Jogador: ' + escapeHtml(player.nome) + '</span>');
    }

    if (action.dado || (estado.ultimoDado && estado.ultimoDado.valor)) {
      chips.push('<span>Dado: ' + escapeHtml(action.dado || estado.ultimoDado.valor) + '</span>');
    }

    if (action.posicao !== undefined && action.posicao !== '') {
      chips.push('<span>' + escapeHtml(formatHouseLabel(action.posicao)) + '</span>');
    }

    target.className = 'last-action last-action--' + kind;
    target.dataset.actionKey = actionKey;
    target.innerHTML = [
      '<summary class="action-summary">',
      '  <span class="action-dot" aria-hidden="true"></span>',
      '  <span class="action-text">',
      '    <span class="action-label">Última jogada</span>',
      '    <strong>' + escapeHtml(title) + '</strong>',
      '    <small>' + escapeHtml(message) + '</small>',
      '  </span>',
      '  <span class="action-more" aria-hidden="true"></span>',
      '</summary>',
      chips.length ? '<div class="action-body"><div class="action-chips">' + chips.join('') + '</div></div>' : ''
    ].join('');
    target.open = keepOpen;
  }

  function findPlayer(estado, playerId) {
    const players = estado && estado.jogadores ? estado.jogadores : [];
    return players.find(function(player) {
      return player.playerId === playerId;
    });
  }

  function getActionKind(type) {
    const map = {
      RESPOSTA_CORRETA: 'ok',
      RESPOSTA_ERRADA: 'bad',
      PERGUNTA_SORTEADA: 'question',
      PERGUNTA_TROCADA: 'question',
      CASA_ESPECIAL: 'special',
      TURNO_PULADO: 'special',
      JOGO_ENCERRADO: 'ok',
      JOGO_INICIADO: 'special',
      JOGADOR_SAIU: 'info',
      JOGADOR_DESCONECTADO: 'bad'
    };
    return map[type] || 'info';
  }

  function getActionTitle(type) {
    const map = {
      RESPOSTA_CORRETA: 'Acerto confirmado',
      RESPOSTA_ERRADA: 'Resposta errada',
      PERGUNTA_SORTEADA: 'Pergunta para avançar',
      PERGUNTA_TROCADA: 'Pergunta trocada',
      CASA_ESPECIAL: 'Casa especial',
      TURNO_PULADO: 'Turno pulado',
      JOGO_ENCERRADO: 'Fim de jogo',
      JOGO_INICIADO: 'Partida iniciada',
      JOGADOR_SAIU: 'Jogador saiu',
      JOGADOR_DESCONECTADO: 'Jogador desconectado',
      MOVIMENTO: 'Movimento no tabuleiro'
    };
    return map[type] || 'Atualização da partida';
  }

  function openQuestion(pending) {
    selectedAnswer = '';
    const question = pending.pergunta;
    $('#questionType').textContent = question.tipo;
    $('#questionDice').hidden = !pending.dado;
    $('#questionDice').textContent = pending.dado ? 'Dado ' + pending.dado : '';
    $('#questionHouse').textContent = 'Casa ' + pending.casa;
    $('#questionText').textContent = question.enunciado;
    $('#answerOptions').hidden = false;
    $('#answerOptions').innerHTML = Object.keys(question.alternativas).map(function(letter) {
      return [
        '<button class="answer-option" type="button" data-answer="' + letter + '">',
        '  <strong>' + letter + '</strong>',
        '  <span>' + escapeHtml(question.alternativas[letter]) + '</span>',
        '</button>'
      ].join('');
    }).join('');

    $('#questionFeedback').hidden = true;
    $('#questionFeedback').className = 'question-feedback';
    $('#questionModal').classList.remove('modal--success', 'modal--error');
    $('#swapQuestionBtn').hidden = !(pending.permiteTroca && !pending.trocaUsada);
    $('#answerQuestionBtn').hidden = false;
    $('#answerQuestionBtn').disabled = true;
    $('#continueQuestionBtn').hidden = true;
    $('#questionModal').classList.add('is-open');
    $('#questionModal').setAttribute('aria-hidden', 'false');
  }

  function selectAnswer(answer) {
    selectedAnswer = answer;
    $all('.answer-option').forEach(function(option) {
      option.classList.toggle('is-selected', option.dataset.answer === answer);
    });
    $('#answerQuestionBtn').disabled = !answer;
  }

  function getSelectedAnswer() {
    return selectedAnswer;
  }

  function showQuestionFeedback(feedback, autoClose) {
    const box = $('#questionFeedback');
    box.hidden = false;
    box.className = 'question-feedback ' + (feedback.correta ? 'question-feedback--ok' : 'question-feedback--bad');
    $('#questionModal').classList.toggle('modal--success', feedback.correta);
    $('#questionModal').classList.toggle('modal--error', !feedback.correta);
    if (autoClose) {
      box.innerHTML = [
        '<div class="feedback-title"><span>' + (feedback.correta ? 'CERTO' : 'ERRO') + '</span><strong>' + (feedback.correta ? 'Resposta correta!' : 'Resposta errada.') + '</strong></div>',
        '<p>Resposta correta: ' + escapeHtml(feedback.respostaCorreta) + '</p>'
      ].join('');
    } else {
      box.innerHTML = [
        '<div class="feedback-title"><span>' + (feedback.correta ? 'CERTO' : 'ERRO') + '</span><strong>' + (feedback.correta ? 'Resposta correta!' : 'Resposta errada.') + '</strong></div>',
        '<p>Resposta correta: ' + escapeHtml(feedback.respostaCorreta) + '</p>',
        '<p>' + escapeHtml(feedback.explicacao) + '</p>',
        '<p>' + movementText(feedback.movimento) + '</p>'
      ].join('');
    }

    $('#answerOptions').hidden = true;
    $('#swapQuestionBtn').hidden = true;
    $('#answerQuestionBtn').hidden = true;
    $('#continueQuestionBtn').hidden = !!autoClose;
  }

  function showAnswerReview(feedback) {
    $('#questionType').textContent = 'Revisão';
    $('#questionDice').hidden = true;
    $('#questionHouse').textContent = 'Resposta correta';
    $('#questionText').textContent = 'A resposta correta era ' + feedback.respostaCorreta + '.';
    $('#answerOptions').hidden = true;
    $('#questionFeedback').hidden = false;
    $('#questionFeedback').className = 'question-feedback question-feedback--bad';
    $('#questionFeedback').innerHTML = [
      '<div class="feedback-title"><span>REVISAR</span><strong>Resposta correta: ' + escapeHtml(feedback.respostaCorreta) + '</strong></div>',
      '<p>' + escapeHtml(feedback.explicacao) + '</p>',
      '<p>' + movementText(feedback.movimento) + '</p>'
    ].join('');
    $('#swapQuestionBtn').hidden = true;
    $('#answerQuestionBtn').hidden = true;
    $('#continueQuestionBtn').hidden = false;
    $('#questionModal').classList.remove('modal--success');
    $('#questionModal').classList.add('modal--error', 'is-open');
    $('#questionModal').setAttribute('aria-hidden', 'false');
  }

  function closeQuestion() {
    selectedAnswer = '';
    $('#questionModal').classList.remove('is-open');
    $('#questionModal').classList.remove('modal--success', 'modal--error');
    $('#questionModal').setAttribute('aria-hidden', 'true');
  }

  function setDiceValue(value) {
    const dice = $('#diceValue');
    const number = Number(value);

    if (number >= 1 && number <= 6) {
      dice.dataset.value = String(number);
      dice.innerHTML = renderDiceFace(number);
      return;
    }

    dice.dataset.value = '';
    dice.textContent = '?';
  }

  function renderDiceFace(value) {
    const pipMap = {
      1: [5],
      2: [1, 9],
      3: [1, 5, 9],
      4: [1, 3, 7, 9],
      5: [1, 3, 5, 7, 9],
      6: [1, 3, 4, 6, 7, 9]
    };

    return Array.from({ length: 9 }, function(_, index) {
      const position = index + 1;
      return '<span class="pip' + (pipMap[value].indexOf(position) !== -1 ? ' is-on' : '') + '"></span>';
    }).join('');
  }

  function setDiceRolling(isRolling, finalValue) {
    const dice = $('#diceValue');
    dice.classList.toggle('is-rolling', isRolling);

    if (diceTimer) {
      window.clearInterval(diceTimer);
      diceTimer = null;
    }

    if (isRolling) {
      diceTimer = window.setInterval(function() {
        setDiceValue(Math.floor(Math.random() * 6) + 1);
      }, 80);
      return;
    }

    if (finalValue) {
      setDiceValue(finalValue);
    }
  }

  function setButtonBusy(button, isBusy, textWhenBusy, restoreDisabled) {
    if (!button) {
      return;
    }

    if (isBusy) {
      button.dataset.originalText = button.textContent;
      button.textContent = textWhenBusy || 'Aguarde';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      if (restoreDisabled !== false) {
        button.disabled = false;
      }
    }
  }

  function setHomeBusy(isBusy, activeButton, textWhenBusy) {
    const buttons = $all('#homeForm button');

    buttons.forEach(function(button) {
      if (isBusy) {
        if (!button.dataset.originalText) {
          button.dataset.originalText = button.textContent;
        }
        button.disabled = true;
      } else {
        button.disabled = false;
        if (button.dataset.originalText) {
          button.textContent = button.dataset.originalText;
          delete button.dataset.originalText;
        }
      }
    });

    if (isBusy && activeButton) {
      if (!activeButton.dataset.originalText) {
        activeButton.dataset.originalText = activeButton.textContent;
      }
      activeButton.textContent = textWhenBusy || 'Aguarde';
    }
  }

  function setWorking(isWorking, title, text) {
    const status = $('#workStatus');
    const titleNode = $('#workTitle');
    const textNode = $('#workText');

    document.body.classList.toggle('is-busy-action', isWorking);
    status.hidden = !isWorking;
    titleNode.textContent = title || 'Processando';
    textNode.textContent = text || 'Aguarde um instante.';
  }

  function setLeaving(isLeaving) {
    $('#leaveScreen').hidden = !isLeaving;
  }

  function setReconnect(isReconnecting) {
    const screen = $('#reconnectScreen');
    if (screen) {
      screen.hidden = !isReconnecting;
    }
  }

  function showHouseInfo(info) {
    const box = $('#houseInfo');
    $('#houseInfoBadge').textContent = 'Casa ' + info.position;
    $('#houseInfoTitle').textContent = info.title;
    $('#houseInfoText').textContent = info.text;
    box.classList.toggle('house-info--special', !!info.special);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideHouseInfo() {
    $('#houseInfo').hidden = true;
  }

  function showModeInfo(info) {
    const modal = $('#modeInfoModal');
    $('#modeInfoBadge').textContent = info.badge || 'Modo';
    $('#modeInfoTitle').textContent = info.title || 'Modo de jogo';
    $('#modeInfoText').textContent = info.text || '';
    $('#modeInfoList').innerHTML = (info.items || []).map(function(item) {
      return '<li>' + escapeHtml(item) + '</li>';
    }).join('');
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function hideModeInfo() {
    const modal = $('#modeInfoModal');
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function movementText(delta) {
    if (delta > 0) {
      return 'Avançou ' + delta + ' casa.';
    }

    if (delta < 0) {
      return 'Voltou ' + Math.abs(delta) + ' casa.';
    }

    return 'Ficou na mesma casa.';
  }

  function formatHouseLabel(position) {
    const value = Number(position || 0);
    if (value <= 0) {
      return 'Início';
    }

    return 'Casa ' + value;
  }

  function formatActionMessage(message) {
    return String(message || '').replace(/casa 0/gi, 'inicio');
  }

  function isDisconnected(player) {
    return player && player.statusConexao && player.statusConexao !== 'ONLINE';
  }

  function renderConnectionBadge(player) {
    if (!isDisconnected(player)) {
      return '<span class="mini-badge mini-badge--online">Online</span>';
    }

    if (player.statusConexao === 'EXPIRADO') {
      return '<span class="mini-badge mini-badge--offline">Saiu</span>';
    }

    return '<span class="mini-badge mini-badge--offline">Desconectado</span>';
  }

  function setGameClock(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    gameClockDeadline = Date.now() + total * 1000;
    updateGameClock();

    if (!gameClockTimer) {
      gameClockTimer = window.setInterval(updateGameClock, 1000);
    }
  }

  function updateGameClock() {
    const target = $('#timeValue');
    if (!target || !gameClockDeadline) {
      return;
    }

    const remaining = Math.max(0, Math.ceil((gameClockDeadline - Date.now()) / 1000));
    target.textContent = formatClock(remaining);
  }

  function stopGameClock() {
    if (gameClockTimer) {
      window.clearInterval(gameClockTimer);
      gameClockTimer = null;
    }
    gameClockDeadline = 0;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes + 'min ' + String(rest).padStart(2, '0') + 's';
  }

  function getFinalMessage(estado) {
    if (estado && estado.sala && estado.sala.motivoEncerramento === 'TEMPO_ESGOTADO') {
      return 'O tempo acabou. Ninguém venceu esta partida.';
    }

    return 'A partida foi encerrada sem vencedor.';
  }

  function getModeLabel(mode) {
    const map = {
      MULTI: 'Corrida',
      SOLO: 'Missão',
      CLASSROOM: 'Turma',
      DESAFIO: 'Turma'
    };
    return map[String(mode || '').toUpperCase()] || String(mode || 'Geral');
  }

  function getRankingSubtitle(item) {
    if (isClassroomRanking(item)) {
      return getModeLabel(item.modo) + ' · ' + Number(item.acertos || 0) + ' acertos · sala ' + (item.codigoSala || '-');
    }

    return getModeLabel(item.modo) + ' · sala ' + (item.codigoSala || '-');
  }

  function getRankingValue(item) {
    if (isClassroomRanking(item)) {
      return Number(item.pontos || 0) + ' pts';
    }

    return formatDuration(item.duracaoSegundos);
  }

  function isClassroomRanking(item) {
    const mode = String(item && item.modo ? item.modo : '').toUpperCase();
    return mode === 'CLASSROOM' || mode === 'DESAFIO';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    $,
    showView,
    setConnection,
    toast,
    renderLobby,
    renderGame,
    renderFinal,
    renderHomeRanking,
    renderHomeRankingError,
    renderAnswerReview,
    openQuestion,
    selectAnswer,
    getSelectedAnswer,
    showQuestionFeedback,
    showAnswerReview,
    closeQuestion,
    setDiceValue,
    setDiceRolling,
    setButtonBusy,
    setHomeBusy,
    setWorking,
    setLeaving,
    setReconnect,
    showHouseInfo,
    hideHouseInfo,
    showModeInfo,
    hideModeInfo
  };
})();

window.UI = UI;
