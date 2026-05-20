import { FirebaseQuestions } from './firebase-questions.js?v=20260520-speed2';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  runTransaction,
  goOffline,
  goOnline
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const MEGA_CONFIG = window.MEGA_BATTLE_CONFIG || window.CLASSROOM_CONFIG || {};

const MegaBattle = (function() {
  const ROOT = 'megaBattle';
  const STORAGE = {
    role: 'mega.role',
    roomId: 'mega.roomId',
    code: 'mega.code',
    name: 'mega.name',
    teamId: 'mega.teamId',
    serverId: 'mega.serverId'
  };
  const TEAM_COLORS = ['#0b8f4d', '#ffca3a', '#00b4d8', '#ef3e46'];
  const AUTO_NEXT_RESULTS_MS = 9000;
  const SCORE_CORRECT = 10;
  const SCORE_SPEED_MAX = 5;
  const SERVER_CONNECT_TIMEOUT_MS = 9000;
  const SERVER_READ_TIMEOUT_MS = 6500;
  const SERVER_WRITE_TIMEOUT_MS = 8000;
  const INVITE_JOIN_TIMEOUT_MS = 15000;

  const state = {
    contexts: {},
    contextList: [],
    context: null,
    role: '',
    uid: '',
    roomId: '',
    code: '',
    name: '',
    teamId: '',
    room: null,
    questions: {},
    secrets: {},
    results: {},
    teamScores: {},
    participantsByServer: {},
    answersByServer: {},
    pendingJoin: null,
    invite: null,
    inviteProcessed: false,
    selectedAnswer: '',
    selectedQuestionIndex: null,
    unsubs: [],
    heartbeatId: null,
    timerId: null,
    initialized: false,
    busy: false,
    leaving: false,
    autoClosing: false,
    autoAdvancing: false,
    studentScoreOpen: false,
    scorePhaseKey: ''
  };

  function init() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;
    bindEvents();
    renderTeamFields();
    state.invite = parseInviteLink();
    prepareInviteLink();
    restoreSession();
  }

  function bindEvents() {
    const createButton = byId('createMegaBtn');
    if (createButton) {
      createButton.addEventListener('click', openSetup);
    }

    byId('megaTeamCount').addEventListener('change', renderTeamFields);
    byId('megaSetupBackBtn').addEventListener('click', leaveLocal);
    byId('createMegaConfirmBtn').addEventListener('click', createBattle);
    byId('megaJoinBackBtn').addEventListener('click', leaveLocal);
    byId('megaJoinConfirmBtn').addEventListener('click', joinSelectedTeam);
    byId('copyMegaCodeBtn').addEventListener('click', function() {
      if (window.UI && typeof UI.copyText === 'function') {
        UI.copyText(state.code || byId('megaCode').textContent, 'Código da Mega Batalha copiado.');
      }
    });
    byId('megaPinList').addEventListener('click', function(event) {
      const button = event.target.closest('[data-mega-copy-pin]');
      if (button) {
        copyTeamPin(button.dataset.megaCopyPin);
      }
    });
    byId('megaStartBtn').addEventListener('click', startBattle);
    byId('megaRevealBtn').addEventListener('click', revealCurrentQuestion);
    byId('megaNextBtn').addEventListener('click', nextQuestion);
    byId('megaEndBtn').addEventListener('click', endBattle);
    byId('megaLeaveBtn').addEventListener('click', leaveBattle);
    byId('megaOptions').addEventListener('click', function(event) {
      const button = event.target.closest('[data-mega-answer]');
      if (button) {
        selectAnswer(button.dataset.megaAnswer);
      }
    });
    byId('megaSubmitAnswerBtn').addEventListener('click', submitSelectedAnswer);
    byId('megaScoreToggle').addEventListener('click', function() {
      state.studentScoreOpen = !state.studentScoreOpen;
      renderTeamRanking();
    });
    byId('playerName').addEventListener('change', handleInviteLink);
    byId('playerName').addEventListener('keydown', function(event) {
      if (event.key === 'Enter') {
        window.setTimeout(handleInviteLink, 0);
      }
    });
  }

  function prepareInviteLink() {
    if (!state.invite) {
      return;
    }

    clearSessionStorage();
    const inputs = document.querySelectorAll('.mode-card--mega [data-code-input], #roomCodeInput');
    inputs.forEach(function(input) {
      input.value = state.invite.code;
    });

    if (window.UI && typeof UI.setConnection === 'function') {
      UI.setConnection('idle', 'Link da turma recebido');
    }

    window.setTimeout(function() {
      const name = getPlayerName();
      if (name) {
        handleInviteLink();
        return;
      }

      const nameInput = byId('playerName');
      if (nameInput) {
        nameInput.focus();
      }
      toast('Link da turma recebido. Informe seu nome para entrar automaticamente.', 'info');
    }, 450);
  }

  async function openSetup() {
    if (!isFirebaseConfigured()) {
      toast('Configure o Firebase para criar uma Mega Batalha.', 'warn');
      return;
    }

    pauseTrilhaMode();
    clearSessionStorage();
    resetState();
    renderTeamFields();
    UI.showView('megaSetup');
    UI.setConnection('idle', 'Configurando batalha');
  }

  async function createBattle() {
    if (state.busy) {
      return;
    }

    const name = getPlayerName() || 'Professor';
    const teams = getSetupTeams();
    const seconds = Math.max(20, Number(byId('megaQuestionSeconds').value || MEGA_CONFIG.questionSeconds || 45));

    if (teams.length < 2) {
      toast('Crie pelo menos 2 turmas.', 'warn');
      return;
    }

    const button = byId('createMegaConfirmBtn');
    state.busy = true;
    setHomeBusy(true);
    setButtonBusy(button, true, 'Criando batalha');
    try {
      const contexts = await getConfiguredContexts();
      cleanupAllServers(contexts).catch(function(error) {
        console.warn('Limpeza inicial da Mega Batalha ignorada:', error);
      });
      const questions = await FirebaseQuestions.load(Number(MEGA_CONFIG.totalQuestions || 10));
      if (!questions.length) {
        throw new Error('Nenhuma pergunta encontrada para a Mega Batalha.');
      }

      const code = await createUniqueCode(contexts);
      const roomId = createId('MEGA');
      const now = Date.now();
      const primaryServerId = contexts[0].server.id;
      const teamMap = {};
      teams.forEach(function(team, index) {
        const teamId = 'team' + (index + 1);
        teamMap[teamId] = {
          teamId: teamId,
          name: team.name,
          pin: team.pin,
          color: TEAM_COLORS[index % TEAM_COLORS.length],
          order: index
        };
      });

      const publicQuestions = {};
      const secretQuestions = {};
      questions.forEach(function(question, index) {
        publicQuestions[index] = {
          perguntaId: question.perguntaId,
          tipo: question.tipo,
          enunciado: question.enunciado,
          alternativas: question.alternativas
        };
        secretQuestions[index] = {
          correta: question.correta,
          explicacao: question.explicacao || ''
        };
      });

      const roomBase = {
        roomId: roomId,
        code: code,
        status: 'LOBBY',
        phase: 'LOBBY',
        hostName: name,
        createdAt: now,
        updatedAt: now,
        questionIndex: 0,
        totalQuestions: Math.min(questions.length, Number(MEGA_CONFIG.totalQuestions || 10)),
        questionSeconds: seconds,
        teams: teamMap,
        primaryServerId: primaryServerId
      };
      const sharedUpdates = {
        [path('codes', code)]: {
          roomId: roomId,
          createdAt: now,
          primaryServerId: primaryServerId
        },
        [path('questions', roomId)]: publicQuestions,
        [path('teamScores', roomId)]: makeInitialTeamScores(teamMap)
      };
      const primary = contexts[0];

      try {
        await writeMegaRoom(primary, roomBase, sharedUpdates, secretQuestions, true);
      } catch (serverError) {
        throw makeServerPermissionError(primary, serverError);
      }

      const secondaryContexts = await Promise.all(contexts.slice(1).map(async function(context) {
        try {
          await writeMegaRoom(context, roomBase, sharedUpdates, secretQuestions, false);
          return context;
        } catch (serverError) {
          console.warn('Mega Batalha criada sem ' + getServerLabel(context.server) + ':', serverError);
          return null;
        }
      }));
      const activeContexts = [primary].concat(secondaryContexts.filter(Boolean));

      enterTeacher(activeContexts, roomId, code, name);
      toast('Mega Batalha criada em ' + activeContexts.length + ' servidor(es). Compartilhe o código e os PINs das turmas.');
    } catch (error) {
      toast(error.message || String(error), 'error');
    } finally {
      state.busy = false;
      setButtonBusy(button, false);
      setHomeBusy(false);
    }
  }

  async function writeMegaRoom(context, roomBase, sharedUpdates, secretQuestions, includeSecrets) {
    const roomPayload = Object.assign({}, roomBase, {
      hostUid: context.uid,
      serverId: context.server.id
    });
    const updates = Object.assign({}, sharedUpdates);

    if (includeSecrets) {
      updates[path('secrets', roomBase.roomId)] = secretQuestions;
    }

    await withTimeout(
      set(ref(context.db, path('rooms', roomBase.roomId)), roomPayload),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao criar sala no ' + getServerLabel(context.server) + '.'
    );
    await withTimeout(
      update(ref(context.db), updates),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao gravar dados no ' + getServerLabel(context.server) + '.'
    );
  }

  async function tryJoinByCode(name, rawCode, options) {
    const code = normalizeCode(rawCode);
    options = options || {};
    if (!name || !code || !isFirebaseConfigured()) {
      return false;
    }

    try {
      const found = await findRoomFromInvite(code) || await findRoomByCode(code);
      if (!found) {
        return false;
      }

      pauseTrilhaMode();
      const roomSnap = await withTimeout(
        get(ref(found.context.db, path('rooms', found.roomId))),
        SERVER_READ_TIMEOUT_MS,
        'A sala demorou para responder. Tente novamente.'
      );
      const room = roomSnap.val();
      if (!room || room.status === 'FINISHED') {
        throw new Error('Essa Mega Batalha já foi encerrada.');
      }

      state.pendingJoin = {
        code: code,
        roomId: found.roomId,
        room: room,
        name: name
      };
      renderJoinView(room, code);
      if (tryApplyInviteToJoin(room, code)) {
        return true;
      }
      return true;
    } catch (error) {
      if (!options.silentErrors) {
        toast(error.message || String(error), 'error');
      }
      return options.returnFalseOnError ? false : true;
    }
  }

  async function joinSelectedTeam() {
    if (state.busy || !state.pendingJoin) {
      return;
    }

    const selected = document.querySelector('input[name="megaTeamChoice"]:checked');
    const pin = normalizePin(byId('megaJoinPin').value);
    const room = state.pendingJoin.room;

    if (!selected) {
      toast('Escolha sua turma.', 'warn');
      return;
    }

    const team = room.teams && room.teams[selected.value];
    if (!team || normalizePin(team.pin) !== pin) {
      toast('PIN da turma incorreto.', 'error');
      return;
    }

    state.busy = true;
    const button = byId('megaJoinConfirmBtn');
    setButtonBusy(button, true, 'Entrando');
    try {
      const context = await chooseParticipantServer(state.pendingJoin.roomId);
      const participantsSnap = await withTimeout(
        get(ref(context.db, path('participants', state.pendingJoin.roomId))),
        SERVER_READ_TIMEOUT_MS,
        'A entrada demorou para consultar a turma. Tente novamente.'
      );
      const participants = participantsSnap.val() || {};
      const teamStudents = Object.keys(participants).filter(function(uid) {
        return participants[uid] && participants[uid].role === 'student' && participants[uid].teamId === team.teamId && !participants[uid].removed;
      });

      if (teamStudents.length >= Number(MEGA_CONFIG.maxStudentsPerTeam || 60)) {
        throw new Error('Essa turma atingiu o limite de alunos neste servidor. Tente novamente.');
      }

      const now = Date.now();
      await withTimeout(
        set(ref(context.db, path('participants', state.pendingJoin.roomId, context.uid)), {
          uid: context.uid,
          name: String(state.pendingJoin.name || 'Aluno').slice(0, 40),
          role: 'student',
          teamId: team.teamId,
          teamName: team.name,
          score: 0,
          correctCount: 0,
          answeredCount: 0,
          online: true,
          joinedAt: now,
          lastSeenAt: now,
          removed: false,
          serverId: context.server.id
        }),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao entrar na turma.'
      );

      enterStudent(context, state.pendingJoin.roomId, state.pendingJoin.code, state.pendingJoin.name, team.teamId);
      clearInviteFromUrl();
      state.invite = null;
      toast('Você entrou na ' + team.name + '.');
    } catch (error) {
      toast(error.message || String(error), 'error');
    } finally {
      state.busy = false;
      setButtonBusy(button, false);
    }
  }

  function enterTeacher(contexts, roomId, code, name) {
    stopListeners();
    state.contextList = contexts;
    state.context = contexts[0];
    state.uid = contexts[0].uid;
    state.role = 'teacher';
    state.roomId = roomId;
    state.code = code;
    state.name = name;
    state.teamId = '';
    state.selectedAnswer = '';
    saveSession('teacher', roomId, code, name, '', contexts[0].server.id);
    listenTeacher();
    startHeartbeat();
    showMegaView();
  }

  function enterStudent(context, roomId, code, name, teamId) {
    stopListeners();
    state.contextList = [context];
    state.context = context;
    state.uid = context.uid;
    state.role = 'student';
    state.roomId = roomId;
    state.code = code;
    state.name = name;
    state.teamId = teamId;
    state.selectedAnswer = '';
    state.pendingJoin = null;
    parkUnusedContexts(context.server.id);
    saveSession('student', roomId, code, name, teamId, context.server.id);
    setOnline(true).catch(function(error) {
      console.warn('Presença da Mega Batalha ignorada:', error);
    });
    onDisconnect(ref(context.db, path('participants', roomId, context.uid))).update({
      online: false,
      lastSeenAt: Date.now()
    });
    listenStudent();
    startHeartbeat();
    showMegaView();
  }

  async function restoreSession() {
    const role = localStorage.getItem(STORAGE.role) || '';
    const roomId = localStorage.getItem(STORAGE.roomId) || '';
    const code = localStorage.getItem(STORAGE.code) || '';
    const name = localStorage.getItem(STORAGE.name) || '';
    const teamId = localStorage.getItem(STORAGE.teamId) || '';
    const serverId = localStorage.getItem(STORAGE.serverId) || '';

    if (!role || !roomId || !code || !isFirebaseConfigured()) {
      return;
    }

    try {
      if (role === 'teacher') {
        const contexts = await getConfiguredContexts();
        const roomSnap = await withTimeout(
          get(ref(contexts[0].db, path('rooms', roomId))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao restaurar batalha.'
        );
        if (!roomSnap.exists()) {
          clearSessionStorage();
          return;
        }
        enterTeacher(contexts, roomId, code, name || 'Professor');
        return;
      }

      const context = await getContextByServerId(serverId);
      const roomSnap = await withTimeout(
        get(ref(context.db, path('rooms', roomId))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao restaurar batalha.'
      );
      if (!roomSnap.exists()) {
        clearSessionStorage();
        return;
      }
      enterStudent(context, roomId, code, name || 'Aluno', teamId);
    } catch (error) {
      clearSessionStorage();
      console.warn('Mega Batalha anterior ignorada:', error);
    }
  }

  function listenTeacher() {
    const primary = state.contextList[0];
    state.unsubs.push(onValue(ref(primary.db, path('rooms', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.room = snapshot.val();
      if (!state.room) {
        leaveLocal();
        return;
      }
      render();
    }));
    state.unsubs.push(onValue(ref(primary.db, path('questions', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.questions = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(primary.db, path('secrets', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.secrets = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(primary.db, path('results', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.results = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(primary.db, path('teamScores', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.teamScores = snapshot.val() || {};
      render();
    }));

    state.contextList.forEach(function(context) {
      state.unsubs.push(onValue(ref(context.db, path('participants', state.roomId)), function(snapshot) {
        if (state.leaving) return;
        state.participantsByServer[context.server.id] = snapshot.val() || {};
        render();
      }));
      state.unsubs.push(onValue(ref(context.db, path('answers', state.roomId)), function(snapshot) {
        if (state.leaving) return;
        state.answersByServer[context.server.id] = snapshot.val() || {};
        render();
      }));
    });
  }

  function listenStudent() {
    const context = state.context;
    state.unsubs.push(onValue(ref(context.db, path('rooms', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.room = snapshot.val();
      if (!state.room) {
        leaveLocal();
        return;
      }
      render();
    }));
    state.unsubs.push(onValue(ref(context.db, path('questions', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.questions = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(context.db, path('results', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.results = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(context.db, path('teamScores', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.teamScores = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(context.db, path('participants', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.participantsByServer[context.server.id] = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(context.db, path('answers', state.roomId)), function(snapshot) {
      if (state.leaving) return;
      state.answersByServer[context.server.id] = snapshot.val() || {};
      render();
    }));
  }

  function render() {
    if (state.leaving || !state.room) {
      return;
    }

    showMegaView();
    updateMegaViewClasses();
    byId('megaCode').textContent = state.code || state.room.code || '0000';
    byId('megaRoleLabel').textContent = isTeacher() ? 'Professor anfitrião' : 'Aluno da Mega Batalha';
    byId('megaTitle').textContent = isTeacher() ? 'Arena Interturmas' : getTeamName(state.teamId);
    byId('megaTeamBadge').textContent = isTeacher() ? getTotalStudents() + ' alunos' : getTeamName(state.teamId);

    renderQuestion();
    renderTeacherPanel();
    renderTeamRanking();
    renderTopStudents();
    updateTimer();
  }

  function updateMegaViewClasses() {
    const view = byId('megaView');
    if (!view || !state.room) {
      return;
    }

    const phase = String(state.room.phase || state.room.status || 'LOBBY').toLowerCase();
    const scorePhaseKey = phase + ':' + Number(state.room.questionIndex || 0);
    if (state.scorePhaseKey !== scorePhaseKey) {
      state.scorePhaseKey = scorePhaseKey;
      state.studentScoreOpen = phase !== 'question';
    }

    view.classList.toggle('mega-view--teacher', isTeacher());
    view.classList.toggle('mega-view--student', !isTeacher());
    ['lobby', 'question', 'results', 'final'].forEach(function(name) {
      view.classList.toggle('mega-phase-' + name, phase === name);
    });
  }

  function renderQuestion() {
    const room = state.room;
    const index = Number(room.questionIndex || 0);
    const total = Number(room.totalQuestions || MEGA_CONFIG.totalQuestions || 10);
    const question = state.questions[index];
    const result = state.results[index];

    byId('megaProgress').textContent = 'Pergunta ' + Math.min(index + 1, total) + '/' + total;
    byId('megaResultBox').hidden = true;
    byId('megaStudentWaiting').hidden = true;
    byId('megaSubmitAnswerBtn').hidden = true;
    byId('megaSubmitAnswerBtn').disabled = true;

    if (room.status === 'LOBBY') {
      byId('megaQuestionType').textContent = 'Arena';
      byId('megaQuestionText').textContent = isTeacher()
        ? 'Compartilhe o código e os PINs. Inicie quando as turmas estiverem prontas.'
        : 'Aguardando o professor iniciar a Mega Batalha.';
      byId('megaOptions').innerHTML = '';
      return;
    }

    if (room.phase === 'FINAL') {
      const champion = getTeam(room.winnerTeamId);
      byId('megaQuestionType').textContent = 'Pódio';
      byId('megaQuestionText').textContent = champion
        ? champion.name + ' venceu a Mega Batalha!'
        : 'Mega Batalha encerrada.';
      byId('megaOptions').innerHTML = '';
      renderFinalResultBox();
      return;
    }

    if (!question) {
      byId('megaQuestionType').textContent = 'Quiz';
      byId('megaQuestionText').textContent = 'Carregando pergunta.';
      byId('megaOptions').innerHTML = '';
      return;
    }

    byId('megaQuestionType').textContent = question.tipo;
    byId('megaQuestionText').textContent = question.enunciado;

    if (!getMyCurrentAnswer() && state.selectedQuestionIndex !== index) {
      state.selectedAnswer = '';
      state.selectedQuestionIndex = index;
    }

    renderAnswerOptions(question, result);

    if (room.phase === 'QUESTION') {
      if (!isTeacher() && !getMyCurrentAnswer()) {
        byId('megaSubmitAnswerBtn').hidden = false;
        byId('megaSubmitAnswerBtn').disabled = !state.selectedAnswer;
      } else if (!isTeacher()) {
        byId('megaStudentWaiting').hidden = false;
      }
      return;
    }

    if (room.phase === 'RESULTS' && result) {
      renderResultBox(result);
    }
  }

  function renderAnswerOptions(question, result) {
    const answer = getMyCurrentAnswer();
    const secret = isTeacher() ? state.secrets[Number(state.room.questionIndex || 0)] : null;
    const correct = result && result.correta ? result.correta : (secret && secret.correta ? secret.correta : '');
    const selected = answer ? answer.answer : state.selectedAnswer;
    byId('megaOptions').innerHTML = ['A', 'B', 'C', 'D'].map(function(letter) {
      const classes = ['answer-option'];
      if (selected === letter) classes.push('is-selected');
      if (correct && correct === letter) classes.push('is-correct');
      if (correct && selected === letter && selected !== correct) classes.push('is-wrong');
      return [
        '<button class="' + classes.join(' ') + '" type="button" data-mega-answer="' + letter + '"' + (answer || isTeacher() || correct ? ' disabled' : '') + '>',
        '  <strong>' + letter + '</strong>',
        '  <span>' + escapeHtml(question.alternativas[letter] || '') + '</span>',
        '</button>'
      ].join('');
    }).join('');
  }

  function renderResultBox(result) {
    const box = byId('megaResultBox');
    const myAnswer = getMyCurrentAnswer();
    const isCorrect = myAnswer && myAnswer.answer === result.correta;
    const prefix = isTeacher()
      ? 'Resultado da rodada'
      : (isCorrect ? 'Você acertou!' : (myAnswer && myAnswer.missed ? 'Tempo esgotado. Correta: ' + result.correta : 'Resposta correta: ' + result.correta));
    const comboText = getBestComboText(result);

    box.className = 'question-feedback ' + (isCorrect || isTeacher() ? 'question-feedback--ok' : 'question-feedback--bad');
    box.innerHTML = [
      '<div class="feedback-title"><span>' + escapeHtml(result.correta) + '</span><strong>' + escapeHtml(prefix) + '</strong></div>',
      '<p>' + escapeHtml(result.explicacao || 'Resultado liberado.') + '</p>',
      comboText ? '<p><strong>' + escapeHtml(comboText) + '</strong></p>' : '',
      '<p id="megaNextCountdown" class="next-countdown">' + escapeHtml(getAutoNextText()) + '</p>'
    ].join('');
    box.hidden = false;
  }

  function renderFinalResultBox() {
    const box = byId('megaResultBox');
    const winner = getTeam(state.room.winnerTeamId);
    const hasWinner = !!winner && !!state.room.rankingRegistrado;
    box.className = 'question-feedback question-feedback--ok';
    box.innerHTML = [
      '<div class="feedback-title"><span>' + (hasWinner ? 'TOP' : 'FIM') + '</span><strong>' + (hasWinner ? 'Turma campeã' : 'Batalha encerrada') + '</strong></div>',
      '<p>' + escapeHtml(hasWinner ? winner.name : (state.room.finishReason || 'Mega Batalha encerrada.')) + '</p>'
    ].join('');
    box.hidden = false;
  }

  function renderTeacherPanel() {
    const panel = byId('megaTeacherPanel');
    panel.hidden = !isTeacher();
    if (!isTeacher() || !state.room) {
      return;
    }

    const room = state.room;
    const phase = room.phase || 'LOBBY';
    const answered = getAnsweredCount();
    const online = getOnlineStudents().length;
    byId('megaTeacherPanelTitle').textContent = phase === 'LOBBY' ? 'Sala das turmas' : 'Controle da batalha';
    byId('megaAnsweredBadge').textContent = phase === 'LOBBY'
      ? getTotalStudents() + ' alunos'
      : answered + '/' + online + ' respostas';
    byId('megaPinList').innerHTML = getTeams().map(function(team) {
      const counts = getTeamCounts(team.teamId);
      const result = getCurrentResult();
      const roundStats = result && result.teamResults ? result.teamResults[team.teamId] : null;
      const statusText = phase === 'LOBBY'
        ? counts.total + ' alunos prontos'
        : (phase === 'QUESTION'
          ? counts.answered + '/' + counts.online + ' respostas'
          : (roundStats ? roundStats.accuracy + '% acertos' : counts.total + ' alunos'));
      return [
        '<div class="mega-pin-item' + (counts.total ? ' is-ready' : '') + '">',
        '  <span style="background:' + escapeHtml(team.color || '#0b8f4d') + '"></span>',
        '  <strong>' + escapeHtml(team.name) + '<small>' + escapeHtml(statusText) + '</small></strong>',
        '  <em>PIN ' + escapeHtml(team.pin) + '</em>',
        '  <button class="copy-code-btn mega-pin-copy" type="button" data-mega-copy-pin="' + escapeHtml(team.teamId) + '">Copiar link</button>',
        '</div>'
      ].join('');
    }).join('');

    byId('megaStartBtn').hidden = phase !== 'LOBBY';
    byId('megaRevealBtn').hidden = phase !== 'QUESTION';
    byId('megaNextBtn').hidden = true;
    byId('megaEndBtn').hidden = phase === 'FINAL';
    byId('megaFlowHint').textContent = getFlowHint();
  }

  function renderTeamRanking() {
    const teams = getTeams();
    const totalStudents = getTotalStudents();
    const maxScore = Math.max(1, ...teams.map(function(team) {
      return Number((state.teamScores[team.teamId] || {}).score || 0);
    }));
    const phase = state.room ? state.room.phase || 'LOBBY' : 'LOBBY';
    const result = getCurrentResult();
    const scorePanel = byId('megaScorePanel');
    const scoreToggle = byId('megaScoreToggle');
    const scoreContent = byId('megaScoreContent');
    const isStudentQuestion = !isTeacher() && phase === 'QUESTION';

    if (scorePanel && scoreToggle && scoreContent) {
      scorePanel.classList.toggle('is-student-question', isStudentQuestion);
      scorePanel.classList.toggle('is-collapsed', isStudentQuestion && !state.studentScoreOpen);
      scoreToggle.hidden = !isStudentQuestion;
      scoreToggle.textContent = state.studentScoreOpen ? 'Ocultar desempenho das turmas' : 'Ver desempenho das turmas';
      scoreToggle.setAttribute('aria-expanded', state.studentScoreOpen ? 'true' : 'false');
      scoreContent.hidden = isStudentQuestion && !state.studentScoreOpen;
    }

    byId('megaTeamCountBadge').textContent = totalStudents + ' alunos';
    byId('megaTeamRankingList').innerHTML = teams.map(function(team) {
      const score = state.teamScores[team.teamId] || {};
      const counts = getTeamCounts(team.teamId);
      const roundStats = result && result.teamResults ? result.teamResults[team.teamId] : null;
      const combo = roundStats ? Number(roundStats.combo || 1) : Number(score.lastCombo || 1);
      const display = getTeamDisplay(team, score, counts, roundStats, phase, maxScore);
      return [
        '<div class="mega-team-row' + (team.teamId === state.teamId ? ' is-my-team' : '') + (combo > 1 ? ' has-combo' : '') + '">',
        '  <div class="mega-team-row-head">',
        '    <strong><span style="background:' + escapeHtml(team.color || '#0b8f4d') + '"></span>' + escapeHtml(team.name) + '</strong>',
        '    <em>' + escapeHtml(display.value) + '</em>',
        '  </div>',
        '  <div class="mega-team-bar"><i style="width:' + display.percent + '%; background:' + escapeHtml(team.color || '#0b8f4d') + '"></i></div>',
        '  <small>' + escapeHtml(display.detail) + '</small>',
        combo > 1 && phase === 'RESULTS' ? '  <b class="mega-combo-badge">Combo ' + combo + 'x</b>' : '',
        '</div>'
      ].join('');
    }).join('');
  }

  function getTeamDisplay(team, score, counts, roundStats, phase, maxScore) {
    if (phase === 'LOBBY') {
      const percent = Math.max(5, Math.min(100, counts.total * 6));
      return {
        percent: percent,
        value: counts.total + ' alunos',
        detail: counts.total ? counts.total + ' alunos prontos' : 'Aguardando alunos'
      };
    }

    if (phase === 'QUESTION') {
      const percent = counts.online ? Math.round((counts.answered / counts.online) * 100) : 0;
      return {
        percent: Math.max(5, percent),
        value: counts.answered + '/' + counts.online,
        detail: 'Respostas recebidas nesta pergunta'
      };
    }

    if (phase === 'RESULTS' && roundStats) {
      const missed = Number(roundStats.noAnswer || 0);
      return {
        percent: Math.max(5, Number(roundStats.accuracy || 0)),
        value: Number(roundStats.accuracy || 0) + '%',
        detail: Number(roundStats.correct || 0) + '/' + Number(roundStats.total || 0) + ' acertos' + (missed ? ' · ' + missed + ' sem resposta' : '')
      };
    }

    return {
      percent: Math.max(5, Math.round((Number(score.score || 0) / maxScore) * 100)),
      value: Number(score.score || 0) + ' pts',
      detail: counts.total + ' alunos · ' + Number(score.correct || 0) + '/' + Number(score.answered || 0) + ' acertos'
    };
  }

  function renderTopStudents() {
    const students = getStudents().sort(function(a, b) {
      if (Number(b.score || 0) !== Number(a.score || 0)) {
        return Number(b.score || 0) - Number(a.score || 0);
      }
      return Number(b.correctCount || 0) - Number(a.correctCount || 0);
    }).slice(0, 5);

    byId('megaTopStudents').innerHTML = students.length
      ? students.map(function(player, index) {
        return [
          '<div class="ranking-item ranking-item--fastest">',
          '  <span class="rank-number">' + (index + 1) + '</span>',
          '  <span><strong>' + escapeHtml(player.name) + '</strong><small>' + escapeHtml(getTeamName(player.teamId)) + ' · ' + Number(player.correctCount || 0) + ' acertos</small></span>',
          '  <strong>' + Number(player.score || 0) + ' pts</strong>',
          '</div>'
        ].join('');
      }).join('')
      : '<p class="muted-text">Aguardando alunos.</p>';
  }

  function renderJoinView(room, code) {
    state.room = room;
    byId('megaJoinCode').textContent = code;
    const teams = Object.keys(room.teams || {}).map(function(teamId) {
      return room.teams[teamId];
    }).sort(function(a, b) {
      return Number(a.order || 0) - Number(b.order || 0);
    });

    byId('megaJoinTeamCount').textContent = teams.length + ' turmas';
    byId('megaJoinPin').value = '';
    byId('megaJoinPin').disabled = false;
    byId('megaJoinTitle').textContent = 'Entrar na Mega Batalha';
    byId('megaJoinConfirmBtn').textContent = 'Entrar na turma';
    byId('megaJoinTeams').innerHTML = teams.map(function(team, index) {
      return [
        '<label class="mega-team-choice">',
        '  <input type="radio" name="megaTeamChoice" value="' + escapeHtml(team.teamId) + '"' + (index === 0 ? ' checked' : '') + '>',
        '  <span style="background:' + escapeHtml(team.color || '#0b8f4d') + '"></span>',
        '  <strong>' + escapeHtml(team.name) + '</strong>',
        '</label>'
      ].join('');
    }).join('');
    UI.showView('megaJoin');
    UI.setConnection('idle', 'Escolha sua turma');
  }

  async function handleInviteLink() {
    if (!state.invite || state.inviteProcessed || state.busy || !isFirebaseConfigured()) {
      return;
    }

    const name = getPlayerName();
    if (!name) {
      return;
    }

    state.inviteProcessed = true;
    setHomeBusy(true, null, 'Entrando');
    try {
      const joined = await withTimeout(
        tryJoinByCode(name, state.invite.code, { returnFalseOnError: true }),
        INVITE_JOIN_TIMEOUT_MS,
        'A entrada pelo link demorou demais. Toque em Entrar no card Mega Batalha ou peça um novo link.'
      );
      if (!joined) {
        state.inviteProcessed = false;
        toast('Link da Mega Batalha não encontrado ou expirado.', 'error');
      }
    } catch (error) {
      state.inviteProcessed = false;
      if (window.UI && typeof UI.setConnection === 'function') {
        UI.setConnection('warn', 'Link não entrou');
      }
      toast(error.message || String(error), 'error');
    } finally {
      setHomeBusy(false);
    }
  }

  function tryApplyInviteToJoin(room, code) {
    if (!state.invite || normalizeCode(state.invite.code) !== normalizeCode(code)) {
      return false;
    }

    const team = room.teams && room.teams[state.invite.teamId];
    if (!team || normalizePin(team.pin) !== normalizePin(state.invite.pin)) {
      toast('Este link de turma está inválido ou expirou.', 'error');
      return false;
    }

    const choice = document.querySelector('input[name="megaTeamChoice"][value="' + cssEscape(team.teamId) + '"]');
    if (choice) {
      choice.checked = true;
    }
    byId('megaJoinPin').value = team.pin;
    byId('megaJoinPin').disabled = true;
    byId('megaJoinTitle').textContent = 'Entrando na ' + team.name;
    byId('megaJoinConfirmBtn').textContent = 'Entrando pelo link';
    window.setTimeout(joinSelectedTeam, 80);
    return true;
  }

  function renderTeamFields() {
    const target = byId('megaTeamFields');
    if (!target) {
      return;
    }

    const count = Math.max(2, Math.min(Number(byId('megaTeamCount').value || 4), 4));
    const defaults = ['Turma A', 'Turma B', 'Turma C', 'Turma D'];
    target.innerHTML = defaults.slice(0, count).map(function(label, index) {
      return [
        '<label class="field mega-team-field">',
        '  <span>Nome da turma ' + (index + 1) + '</span>',
        '  <input data-mega-team-name="' + index + '" type="text" maxlength="32" value="' + label + '">',
        '</label>'
      ].join('');
    }).join('');
  }

  async function startBattle() {
    if (!isTeacher() || !state.room || state.room.phase !== 'LOBBY') {
      return;
    }

    await startQuestion(0);
  }

  async function startQuestion(index) {
    const now = Date.now();
    const seconds = Number(state.room.questionSeconds || MEGA_CONFIG.questionSeconds || 45);
    await updateAllRooms({
      status: 'RUNNING',
      phase: 'QUESTION',
      questionIndex: index,
      startedAt: state.room.startedAt || now,
      questionStartedAt: now,
      questionEndsAt: now + seconds * 1000,
      updatedAt: now
    });
  }

  async function revealCurrentQuestion() {
    if (!isTeacher() || !state.room || state.room.phase !== 'QUESTION' || state.autoClosing) {
      return;
    }

    state.autoClosing = true;
    try {
      const index = Number(state.room.questionIndex || 0);
      const secretSnap = await withTimeout(
        get(ref(state.contextList[0].db, path('secrets', state.roomId, index))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao buscar gabarito.'
      );
      const secret = secretSnap.val();
      if (!secret) {
        throw new Error('Gabarito não encontrado.');
      }

      const students = getStudents();
      const questionMs = Number(state.room.questionSeconds || MEGA_CONFIG.questionSeconds || 45) * 1000;
      const teamStats = {};
      const participantUpdates = {};
      const resultAnswers = {};
      const topStudents = [];
      getTeams().forEach(function(team) {
        teamStats[team.teamId] = {
          teamId: team.teamId,
          name: team.name,
          total: 0,
          answered: 0,
          correct: 0,
          wrong: 0,
          noAnswer: 0,
          scoreRaw: 0,
          elapsedSum: 0
        };
      });

      students.forEach(function(player) {
        const answer = getAnswerFromServer(player.serverId, index, player.uid);
        const stats = teamStats[player.teamId];
        if (!stats) {
          return;
        }

        stats.total++;
        let correct = false;
        let elapsedMs = questionMs;
        let gained = 0;
        if (answer) {
          stats.answered++;
          elapsedMs = Math.max(0, Number(answer.elapsedMs || 0));
          correct = answer.answer === secret.correta;
        } else {
          stats.noAnswer++;
        }

        if (correct) {
          const speedBonus = Math.max(0, Math.round((1 - Math.min(elapsedMs, questionMs) / questionMs) * SCORE_SPEED_MAX));
          gained = SCORE_CORRECT + speedBonus;
          stats.correct++;
          stats.scoreRaw += gained;
          stats.elapsedSum += elapsedMs;
          topStudents.push({
            uid: player.uid,
            name: player.name,
            teamId: player.teamId,
            teamName: player.teamName,
            elapsedMs: elapsedMs,
            score: gained
          });
        } else {
          stats.wrong++;
        }

        const context = getContextById(player.serverId);
        if (context) {
          const base = path('participants', state.roomId, player.uid);
          participantUpdates[context.server.id] = participantUpdates[context.server.id] || {};
          participantUpdates[context.server.id][base + '/answeredCount'] = Number(player.answeredCount || 0) + 1;
          participantUpdates[context.server.id][base + '/score'] = Number(player.score || 0) + gained;
          participantUpdates[context.server.id][base + '/correctCount'] = Number(player.correctCount || 0) + (correct ? 1 : 0);
          if (answer) {
            participantUpdates[context.server.id][path('answers', state.roomId, index, player.uid, 'correct')] = correct;
            participantUpdates[context.server.id][path('answers', state.roomId, index, player.uid, 'scoreGained')] = gained;
          } else {
            participantUpdates[context.server.id][path('answers', state.roomId, index, player.uid)] = {
              uid: player.uid,
              name: player.name,
              teamId: player.teamId,
              teamName: player.teamName,
              answer: '',
              elapsedMs: questionMs,
              submittedAt: Date.now(),
              missed: true,
              correct: false,
              scoreGained: 0
            };
          }
        }

        resultAnswers[player.uid] = {
          uid: player.uid,
          name: player.name,
          teamId: player.teamId,
          answer: answer ? answer.answer : '',
          correct: correct,
          elapsedMs: elapsedMs,
          scoreGained: gained
        };
      });

      for (const serverId of Object.keys(participantUpdates)) {
        const context = getContextById(serverId);
        if (context) {
          await update(ref(context.db), participantUpdates[serverId]);
        }
      }

      const currentScores = Object.assign({}, state.teamScores || {});
      const teamResults = {};
      Object.keys(teamStats).forEach(function(teamId) {
        const stats = teamStats[teamId];
        const accuracy = stats.total ? stats.correct / stats.total : 0;
        const combo = accuracy >= 0.85 ? 2 : (accuracy >= 0.7 ? 1.5 : 1);
        const gained = Math.round(stats.scoreRaw * combo);
        const previous = currentScores[teamId] || {};
        currentScores[teamId] = {
          teamId: teamId,
          name: stats.name,
          score: Number(previous.score || 0) + gained,
          correct: Number(previous.correct || 0) + stats.correct,
          answered: Number(previous.answered || 0) + stats.total,
          students: stats.total,
          lastCombo: combo,
          updatedAt: Date.now()
        };
        teamResults[teamId] = Object.assign({}, stats, {
          accuracy: Math.round(accuracy * 100),
          combo: combo,
          scoreGained: gained,
          averageElapsedMs: stats.correct ? Math.round(stats.elapsedSum / stats.correct) : 0
        });
      });

      topStudents.sort(function(a, b) {
        return a.elapsedMs - b.elapsedMs;
      });

      const result = {
        correta: secret.correta,
        explicacao: secret.explicacao || '',
        questionNumber: index + 1,
        questionText: (state.questions[index] && state.questions[index].enunciado) || '',
        teamResults: teamResults,
        topStudents: topStudents.slice(0, 10),
        answers: resultAnswers,
        revealedAt: Date.now()
      };

      await broadcast({
        [path('results', state.roomId, index)]: result,
        [path('teamScores', state.roomId)]: currentScores,
        [path('rooms', state.roomId, 'phase')]: 'RESULTS',
        [path('rooms', state.roomId, 'updatedAt')]: Date.now()
      });
    } catch (error) {
      toast(error.message || String(error), 'error');
    } finally {
      state.autoClosing = false;
    }
  }

  async function nextQuestion() {
    if (!isTeacher() || !state.room || state.room.phase !== 'RESULTS') {
      return;
    }

    const nextIndex = Number(state.room.questionIndex || 0) + 1;
    if (nextIndex >= Number(state.room.totalQuestions || MEGA_CONFIG.totalQuestions || 10)) {
      await finishBattle('Mega Batalha concluída.', true);
      return;
    }

    state.selectedAnswer = '';
    state.selectedQuestionIndex = nextIndex;
    await startQuestion(nextIndex);
  }

  async function endBattle() {
    if (isTeacher()) {
      await finishBattle('Mega Batalha encerrada pelo professor.', false);
    } else {
      await leaveBattle();
    }
  }

  async function finishBattle(reason, completed) {
    const winner = getWinningTeam();
    const now = Date.now();
    const canSaveRanking = !!completed
      && !!winner
      && Number(winner.score || 0) > 0
      && Number(winner.correct || 0) > 0
      && Number(state.room.questionIndex || 0) + 1 >= Number(state.room.totalQuestions || MEGA_CONFIG.totalQuestions || 10);

    if (canSaveRanking) {
      await saveMegaRanking(winner, now);
    }
    const finalWinner = canSaveRanking ? winner : null;
    await broadcast({
      [path('rooms', state.roomId, 'status')]: 'FINISHED',
      [path('rooms', state.roomId, 'phase')]: 'FINAL',
      [path('rooms', state.roomId, 'winnerTeamId')]: finalWinner ? finalWinner.teamId : '',
      [path('rooms', state.roomId, 'finishReason')]: reason || 'Mega Batalha finalizada.',
      [path('rooms', state.roomId, 'rankingRegistrado')]: canSaveRanking,
      [path('rooms', state.roomId, 'endedAt')]: now,
      [path('rooms', state.roomId, 'updatedAt')]: now,
      [path('codes', state.code)]: null
    });
  }

  async function saveMegaRanking(winner, now) {
    const context = state.contextList[0];
    const duration = Math.max(1, Math.round((now - Number(state.room.startedAt || state.room.createdAt || now)) / 1000));
    const rankingId = sanitizeFirebaseKey(['MEGA', state.roomId, winner.teamId].join('_'));
    await set(ref(context.db, 'ranking/entries/' + rankingId), {
      rankingId: rankingId,
      uid: context.uid,
      salaId: state.roomId,
      codigoSala: state.code,
      playerId: winner.teamId,
      nome: winner.name,
      modo: 'MEGA',
      pontos: Number(winner.score || 0),
      acertos: Number(winner.correct || 0),
      totalPerguntas: Number(state.room.totalQuestions || MEGA_CONFIG.totalQuestions || 10),
      duracaoSegundos: duration,
      motivoEncerramento: 'MEGA_CONCLUIDA',
      concluiu: true,
      createdAt: now,
      criadoEm: new Date(now).toISOString(),
      origem: 'mega-ranking-v1'
    });
  }

  function selectAnswer(letter) {
    if (state.role !== 'student' || !state.room || state.room.phase !== 'QUESTION' || getMyCurrentAnswer()) {
      return;
    }

    state.selectedQuestionIndex = Number(state.room.questionIndex || 0);
    state.selectedAnswer = letter;
    renderQuestion();
  }

  async function submitSelectedAnswer() {
    if (!state.selectedAnswer) {
      toast('Escolha uma alternativa antes de confirmar.', 'warn');
      return;
    }

    if (!state.context || !state.room) {
      return;
    }

    const index = Number(state.room.questionIndex || 0);
    const now = Date.now();
    const elapsedMs = Math.max(0, now - Number(state.room.questionStartedAt || now));
    const answerRef = ref(state.context.db, path('answers', state.roomId, index, state.uid));
    const selected = state.selectedAnswer;

    await runTransaction(answerRef, function(current) {
      if (current) {
        return current;
      }

      return {
        uid: state.uid,
        name: state.name,
        teamId: state.teamId,
        teamName: getTeamName(state.teamId),
        answer: selected,
        elapsedMs: elapsedMs,
        submittedAt: now
      };
    });
    renderQuestion();
  }

  async function leaveBattle() {
    if (state.leaving) {
      return;
    }

    state.leaving = true;
    if (window.UI && typeof UI.setLeaving === 'function') {
      UI.setLeaving(true);
    }
    stopListeners();
    stopHeartbeat();

    try {
      if (isTeacher() && state.room && state.room.status !== 'FINISHED') {
        await finishBattle('Mega Batalha encerrada pelo professor.', false);
      } else if (state.context && state.roomId && state.uid) {
        await setOnline(false);
      }
    } catch (error) {
      toast('Saída local concluída.', 'warn');
    }

    leaveLocal();
  }

  function leaveLocal() {
    stopListeners();
    stopHeartbeat();
    resumeAllContexts();
    clearSessionStorage();
    resetState();
    if (window.UI && typeof UI.setLeaving === 'function') {
      UI.setLeaving(false);
    }
    UI.showView('home');
    UI.setConnection('idle', 'Pronto para jogar');
  }

  function showMegaView() {
    UI.showView('mega');
    UI.setConnection('ok', getStatusText());
  }

  function updateTimer() {
    if (!state.room) {
      return;
    }

    let seconds = 0;
    if (state.room.phase === 'QUESTION') {
      seconds = Math.max(0, Math.ceil((Number(state.room.questionEndsAt || 0) - Date.now()) / 1000));
    } else if (state.room.phase === 'RESULTS') {
      seconds = getAutoNextSeconds();
    }
    byId('megaTimer').textContent = formatClock(seconds);
    updateTimeBar(seconds);
    const flowHint = byId('megaFlowHint');
    if (flowHint) {
      flowHint.textContent = getFlowHint();
    }
    const nextCountdown = byId('megaNextCountdown');
    if (nextCountdown) {
      nextCountdown.textContent = getAutoNextText();
    }

    if (!isTeacher()) {
      return;
    }

    if (state.room.phase === 'QUESTION') {
      if (allOnlineStudentsAnswered() || seconds <= 0) {
        revealCurrentQuestion();
      }
      return;
    }

    if (state.room.phase === 'RESULTS') {
      autoAdvanceAfterResults();
    }
  }

  function updateTimeBar(seconds) {
    const bar = byId('megaTimeBar');
    if (!bar) {
      return;
    }

    const total = state.room.phase === 'RESULTS'
      ? Math.max(1, Math.ceil(AUTO_NEXT_RESULTS_MS / 1000))
      : Math.max(1, Number(state.room.questionSeconds || MEGA_CONFIG.questionSeconds || 45));
    const percent = state.room.phase === 'QUESTION' || state.room.phase === 'RESULTS'
      ? Math.max(0, Math.min(100, Math.round((Number(seconds || 0) / total) * 100)))
      : 0;
    const fill = bar.querySelector('i');
    if (fill) {
      fill.style.width = percent + '%';
    }
    bar.classList.toggle('is-warning', percent > 0 && percent <= 45);
    bar.classList.toggle('is-danger', percent > 0 && percent <= 20);
  }

  async function autoAdvanceAfterResults() {
    if (state.autoAdvancing || !state.room || state.room.phase !== 'RESULTS') {
      return;
    }

    const result = state.results[Number(state.room.questionIndex || 0)];
    if (!result || Date.now() - Number(result.revealedAt || 0) < AUTO_NEXT_RESULTS_MS) {
      return;
    }

    state.autoAdvancing = true;
    try {
      await nextQuestion();
    } finally {
      state.autoAdvancing = false;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatId = window.setInterval(function() {
      setOnline(true).catch(function(error) {
        console.warn('Presença da Mega Batalha ignorada:', error);
      });
    }, Number(MEGA_CONFIG.heartbeatSeconds || 10) * 1000);
    state.timerId = window.setInterval(updateTimer, 500);
  }

  function stopHeartbeat() {
    if (state.heartbeatId) {
      window.clearInterval(state.heartbeatId);
      state.heartbeatId = null;
    }
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  async function setOnline(online) {
    if (!state.context || !state.roomId || !state.uid || isTeacher()) {
      return;
    }

    await withTimeout(
      update(ref(state.context.db, path('participants', state.roomId, state.uid)), {
        online: online,
        lastSeenAt: Date.now()
      }),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao atualizar presença.'
    );
  }

  function stopListeners() {
    state.unsubs.forEach(function(unsub) {
      if (typeof unsub === 'function') {
        unsub();
      }
    });
    state.unsubs = [];
  }

  async function updateAllRooms(values) {
    const updates = {};
    Object.keys(values).forEach(function(key) {
      updates[path('rooms', state.roomId, key)] = values[key];
    });
    await broadcast(updates);
  }

  async function broadcast(updates) {
    const results = await Promise.all(state.contextList.map(async function(context) {
      try {
        await withTimeout(
          update(ref(context.db), updates),
          SERVER_WRITE_TIMEOUT_MS,
          'Tempo limite ao atualizar ' + getServerLabel(context.server) + '.'
        );
        return true;
      } catch (error) {
        console.warn('Atualização da Mega Batalha ignorou ' + getServerLabel(context.server) + ':', error);
        return false;
      }
    }));

    if (!results.some(Boolean)) {
      throw new Error('Nenhum servidor respondeu à atualização da Mega Batalha.');
    }
  }

  async function getConfiguredContexts() {
    const servers = getConfiguredServers();
    if (!servers.length) {
      throw new Error('Nenhum servidor Firebase foi configurado.');
    }

    const results = await Promise.all(servers.map(async function(server) {
      try {
        return await getContextForServer(server);
      } catch (error) {
        console.warn('Servidor indisponível:', getServerLabel(server), error);
        return null;
      }
    }));
    const contexts = results.filter(Boolean);
    if (!contexts.length) {
      throw new Error('Nenhum servidor Firebase respondeu. Tente novamente em alguns segundos.');
    }
    return contexts;
  }

  function parkUnusedContexts(activeServerId) {
    Object.keys(state.contexts).forEach(function(serverId) {
      const context = state.contexts[serverId];
      if (context && context.db && serverId !== activeServerId) {
        goOffline(context.db);
      }
    });
  }

  function resumeAllContexts() {
    Object.keys(state.contexts).forEach(function(serverId) {
      const context = state.contexts[serverId];
      if (context && context.db) {
        goOnline(context.db);
      }
    });
  }

  async function getContextByServerId(serverId) {
    const server = getServerById(serverId);
    if (server) {
      return getContextForServer(server);
    }

    const contexts = await getConfiguredContexts();
    return contexts[0];
  }

  function getContextById(serverId) {
    return state.contextList.find(function(context) {
      return context.server.id === serverId;
    }) || null;
  }

  function getSharedApp(server) {
    const appName = 'trilha-' + server.id;
    const existing = getApps().find(function(app) {
      return app.name === appName;
    });
    return existing || initializeApp(server.firebaseConfig, appName);
  }

  async function getContextForServer(server) {
    if (!server || !server.id) {
      throw new Error('Servidor Firebase inválido.');
    }

    if (!state.contexts[server.id]) {
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
      const db = getDatabase(app);
      goOnline(db);
      state.contexts[server.id] = {
        server: server,
        app: app,
        auth: auth,
        uid: authResult.user.uid,
        db: db
      };
    } else {
      goOnline(state.contexts[server.id].db);
    }

    return state.contexts[server.id];
  }

  async function findRoomFromInvite(code) {
    if (!state.invite || !state.invite.roomId || !state.invite.serverId) {
      return null;
    }

    const server = getServerById(state.invite.serverId);
    if (!server) {
      return null;
    }

    try {
      const context = await getContextForServer(server);
      const roomSnap = await withTimeout(
        get(ref(context.db, path('rooms', state.invite.roomId))),
        SERVER_READ_TIMEOUT_MS,
        'A sala do link demorou para responder.'
      );
      const room = roomSnap.val();
      if (!room || normalizeCode(room.code) !== normalizeCode(code)) {
        return null;
      }

      return {
        context: context,
        roomId: state.invite.roomId
      };
    } catch (error) {
      console.warn('Entrada direta da Mega Batalha ignorada:', error);
      return null;
    }
  }

  async function findRoomByCode(code) {
    const servers = getConfiguredServers();
    const lookups = servers.map(async function(server) {
      try {
        const context = await getContextForServer(server);
        const codeSnap = await withTimeout(
          get(ref(context.db, path('codes', code))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao buscar código no ' + getServerLabel(server) + '.'
        );
        if (!codeSnap.exists()) {
          return null;
        }

        return {
          context: context,
          roomId: codeSnap.val().roomId
        };
      } catch (error) {
        console.warn('Busca da Mega Batalha ignorou ' + getServerLabel(server) + ':', error);
        return null;
      }
    });

    return firstTruthy(lookups);
  }

  async function chooseParticipantServer(roomId) {
    const servers = getConfiguredServers().slice().sort(function() {
      return Math.random() - 0.5;
    });
    let lastError = null;

    for (const server of servers) {
      try {
        const context = await getContextForServer(server);
        const snap = await withTimeout(
          get(ref(context.db, path('participants', roomId))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao contar participantes.'
        );
        const participants = snap.val() || {};
        const count = Object.keys(participants).filter(function(uid) {
          return participants[uid] && participants[uid].role === 'student' && !participants[uid].removed;
        }).length;

        if (count < Number(MEGA_CONFIG.maxStudentsPerTeam || 60) * Math.max(1, getTeams().length || 4)) {
          return context;
        }
      } catch (error) {
        lastError = error;
        console.warn('Servidor indisponível para entrada:', error);
      }
    }

    for (const server of servers) {
      try {
        return await getContextForServer(server);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Nenhum servidor respondeu para entrar na Mega Batalha.');
  }

  async function createUniqueCode(contexts) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = String(randomInt(10000, 99999));
      const checks = await Promise.all(contexts.map(async function(context) {
        try {
          const snap = await withTimeout(
            get(ref(context.db, path('codes', code))),
            SERVER_READ_TIMEOUT_MS,
            'Tempo limite ao conferir código.'
          );
          return snap.exists();
        } catch (error) {
          return false;
        }
      }));
      const exists = checks.some(Boolean);
      if (!exists) {
        return code;
      }
    }
    return String(randomInt(10000, 99999));
  }

  async function cleanupAllServers(contexts) {
    await Promise.all(contexts.map(function(context) {
      return withTimeout(
        cleanupServer(context),
        SERVER_READ_TIMEOUT_MS + SERVER_WRITE_TIMEOUT_MS,
        'Limpeza demorou no ' + getServerLabel(context.server) + '.'
      ).catch(function(error) {
        console.warn('Limpeza da Mega Batalha ignorou ' + getServerLabel(context.server) + ':', error);
      });
    }));
  }

  async function cleanupServer(context) {
    try {
      const roomsSnap = await withTimeout(
        get(ref(context.db, path('rooms'))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao ler salas antigas.'
      );
      const rooms = roomsSnap.val() || {};
      const now = Date.now();
      const updates = {};
      const finishedMs = minutesToMs(MEGA_CONFIG.cleanupFinishedMinutes || 5);
      const lobbyMs = minutesToMs(MEGA_CONFIG.cleanupIdleLobbyMinutes || 20);
      const runningMs = minutesToMs(MEGA_CONFIG.cleanupRunningMinutes || 90);

      Object.keys(rooms).forEach(function(roomId) {
        const room = rooms[roomId];
        if (!room) {
          return;
        }

        const age = now - Number(room.updatedAt || room.createdAt || now);
        if (room.status === 'FINISHED' && age > finishedMs) {
          updates[path('rooms', roomId)] = null;
          updates[path('participants', roomId)] = null;
          updates[path('questions', roomId)] = null;
          updates[path('secrets', roomId)] = null;
          updates[path('answers', roomId)] = null;
          updates[path('results', roomId)] = null;
          updates[path('teamScores', roomId)] = null;
          if (room.code) updates[path('codes', room.code)] = null;
          return;
        }

        if ((room.status === 'LOBBY' && age > lobbyMs) || (room.status === 'RUNNING' && age > runningMs)) {
          updates[path('rooms', roomId, 'status')] = 'FINISHED';
          updates[path('rooms', roomId, 'phase')] = 'FINAL';
          updates[path('rooms', roomId, 'finishReason')] = 'Sala encerrada por inatividade.';
          updates[path('rooms', roomId, 'updatedAt')] = now;
          if (room.code) updates[path('codes', room.code)] = null;
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
      console.warn('Limpeza da Mega Batalha ignorada:', error);
    }
  }

  function getSetupTeams() {
    const inputs = Array.from(document.querySelectorAll('[data-mega-team-name]'));
    const usedPins = {};
    return inputs.map(function(input, index) {
      let pin = '';
      do {
        pin = String(randomInt(100, 999));
      } while (usedPins[pin]);
      usedPins[pin] = true;
      return {
        name: (input.value.trim() || ('Turma ' + String.fromCharCode(65 + index))).slice(0, 32),
        pin: pin
      };
    });
  }

  function makeInitialTeamScores(teams) {
    const scores = {};
    Object.keys(teams).forEach(function(teamId) {
      scores[teamId] = {
        teamId: teamId,
        name: teams[teamId].name,
        score: 0,
        correct: 0,
        answered: 0,
        students: 0,
        lastCombo: 1
      };
    });
    return scores;
  }

  function getTeams() {
    const teams = state.room && state.room.teams ? state.room.teams : {};
    return Object.keys(teams).map(function(teamId) {
      return teams[teamId];
    }).sort(function(a, b) {
      return Number(a.order || 0) - Number(b.order || 0);
    });
  }

  function getTeam(teamId) {
    return state.room && state.room.teams ? state.room.teams[teamId] : null;
  }

  function getTeamName(teamId) {
    const team = getTeam(teamId);
    return team ? team.name : 'Turma';
  }

  function getStudents() {
    const list = [];
    Object.keys(state.participantsByServer).forEach(function(serverId) {
      const participants = state.participantsByServer[serverId] || {};
      Object.keys(participants).forEach(function(uid) {
        const player = participants[uid];
        if (player && player.role === 'student' && !player.removed) {
          list.push(Object.assign({ uid: uid, serverId: serverId }, player));
        }
      });
    });
    return list;
  }

  function getOnlineStudents() {
    return getStudents().filter(function(player) {
      return player.online !== false;
    });
  }

  function getTotalStudents() {
    return getStudents().length;
  }

  function getCurrentResult() {
    if (!state.room) {
      return null;
    }
    return state.results[Number(state.room.questionIndex || 0)] || null;
  }

  function getTeamCounts(teamId) {
    const index = state.room ? Number(state.room.questionIndex || 0) : 0;
    const students = getStudents().filter(function(player) {
      return player.teamId === teamId;
    });
    const online = students.filter(function(player) {
      return player.online !== false;
    });
    const answered = online.filter(function(player) {
      return !!getAnswerFromServer(player.serverId, index, player.uid);
    });
    return {
      total: students.length,
      online: online.length,
      answered: answered.length
    };
  }

  function getAnsweredCount() {
    if (!state.room) {
      return 0;
    }

    const index = Number(state.room.questionIndex || 0);
    return getOnlineStudents().filter(function(player) {
      return !!getAnswerFromServer(player.serverId, index, player.uid);
    }).length;
  }

  function allOnlineStudentsAnswered() {
    const online = getOnlineStudents();
    if (!online.length || !state.room) {
      return false;
    }

    const index = Number(state.room.questionIndex || 0);
    return online.every(function(player) {
      return !!getAnswerFromServer(player.serverId, index, player.uid);
    });
  }

  function getAnswerFromServer(serverId, index, uid) {
    const answers = state.answersByServer[serverId] || {};
    return answers[index] && answers[index][uid] ? answers[index][uid] : null;
  }

  function getMyCurrentAnswer() {
    if (!state.room || !state.context) {
      return null;
    }
    return getAnswerFromServer(state.context.server.id, Number(state.room.questionIndex || 0), state.uid);
  }

  function getWinningTeam() {
    return getTeams().map(function(team) {
      return Object.assign({}, team, state.teamScores[team.teamId] || {});
    }).sort(function(a, b) {
      if (Number(b.score || 0) !== Number(a.score || 0)) {
        return Number(b.score || 0) - Number(a.score || 0);
      }
      return Number(b.correct || 0) - Number(a.correct || 0);
    })[0] || null;
  }

  function getBestComboText(result) {
    const teams = result && result.teamResults ? result.teamResults : {};
    const best = Object.keys(teams).map(function(teamId) {
      return teams[teamId];
    }).sort(function(a, b) {
      return Number(b.combo || 1) - Number(a.combo || 1);
    })[0];

    if (!best || Number(best.combo || 1) <= 1) {
      return '';
    }

    return best.name + ' ativou COMBO ' + best.combo + 'x!';
  }

  function getFlowHint() {
    if (!state.room || state.room.phase === 'LOBBY') {
      return 'Compartilhe o código e os PINs de cada turma.';
    }
    if (state.room.phase === 'QUESTION') {
      return 'O resultado sai quando todos online responderem ou quando o tempo acabar. Sem resposta conta como erro.';
    }
    if (state.room.phase === 'RESULTS') {
      const seconds = getAutoNextSeconds();
      return seconds > 0
        ? 'Próxima pergunta automática em ' + seconds + 's.'
        : 'Avançando para a próxima pergunta.';
    }
    return 'Batalha finalizada.';
  }

  function getAutoNextSeconds() {
    const result = state.room && state.results
      ? state.results[Number(state.room.questionIndex || 0)]
      : null;
    if (!result || !result.revealedAt) {
      return 0;
    }

    return Math.max(0, Math.ceil((AUTO_NEXT_RESULTS_MS - (Date.now() - Number(result.revealedAt || 0))) / 1000));
  }

  function getAutoNextText() {
    if (!state.room || state.room.phase !== 'RESULTS') {
      return '';
    }

    const seconds = getAutoNextSeconds();
    const finalRound = Number(state.room.questionIndex || 0) + 1 >= Number(state.room.totalQuestions || MEGA_CONFIG.totalQuestions || 10);
    if (seconds <= 0) {
      return finalRound ? 'Preparando o pódio final.' : 'Preparando a próxima pergunta.';
    }

    return finalRound
      ? 'Pódio final em ' + seconds + 's.'
      : 'Próxima pergunta em ' + seconds + 's.';
  }

  function copyTeamPin(teamId) {
    const team = getTeam(teamId);
    if (!team || !window.UI || typeof UI.copyText !== 'function') {
      return;
    }

    const code = state.code || (state.room && state.room.code) || byId('megaCode').textContent;
    const link = buildTeamInviteLink(code, team);
    const text = [
      'Mega Batalha - ' + team.name,
      'Código: ' + code,
      'PIN da turma: ' + team.pin,
      'Link direto: ' + link
    ].join('\n');
    UI.copyText(text, 'Link, turma e PIN copiados.');
  }

  function parseInviteLink() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const code = normalizeCode(params.get('mega') || params.get('megaCode') || params.get('code') || '');
      const teamId = String(params.get('team') || params.get('turma') || '').trim();
      const pin = normalizePin(params.get('pin') || '');
      const roomId = sanitizeFirebaseKey(params.get('room') || params.get('roomId') || '');
      const serverId = String(params.get('server') || params.get('servidor') || '').trim();

      if (!code || !teamId || !pin) {
        return null;
      }

      return {
        code: code,
        teamId: teamId,
        pin: pin,
        roomId: roomId,
        serverId: serverId
      };
    } catch (error) {
      return null;
    }
  }

  function buildTeamInviteLink(code, team) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('mega', normalizeCode(code));
    url.searchParams.set('team', team.teamId);
    url.searchParams.set('pin', normalizePin(team.pin));
    if (state.roomId) {
      url.searchParams.set('room', state.roomId);
    }
    const serverId = (state.room && state.room.primaryServerId) ||
      (state.context && state.context.server ? state.context.server.id : '');
    if (serverId) {
      url.searchParams.set('server', serverId);
    }
    return url.toString();
  }

  function clearInviteFromUrl() {
    if (!state.invite || !window.history || typeof window.history.replaceState !== 'function') {
      return;
    }

    const url = new URL(window.location.href);
    ['mega', 'megaCode', 'code', 'team', 'turma', 'pin', 'room', 'roomId', 'server', 'servidor'].forEach(function(key) {
      url.searchParams.delete(key);
    });
    window.history.replaceState(null, document.title, url.pathname + url.search + url.hash);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(String(value || ''));
    }

    return String(value || '').replace(/"/g, '\\"');
  }

  function getStatusText() {
    if (!state.room || state.room.phase === 'LOBBY') {
      return 'Aguardando turmas';
    }
    if (state.room.phase === 'QUESTION') {
      return 'Pergunta ao vivo';
    }
    if (state.room.phase === 'RESULTS') {
      return 'Resultado liberado';
    }
    if (state.room.phase === 'FINAL') {
      return 'Batalha finalizada';
    }
    return 'Mega Batalha';
  }

  function saveSession(role, roomId, code, name, teamId, serverId) {
    localStorage.setItem(STORAGE.role, role);
    localStorage.setItem(STORAGE.roomId, roomId);
    localStorage.setItem(STORAGE.code, code);
    localStorage.setItem(STORAGE.name, name);
    localStorage.setItem(STORAGE.teamId, teamId || '');
    localStorage.setItem(STORAGE.serverId, serverId || '');
  }

  function clearSessionStorage() {
    Object.keys(STORAGE).forEach(function(key) {
      localStorage.removeItem(STORAGE[key]);
    });
  }

  function resetState() {
    state.context = null;
    state.contextList = [];
    state.role = '';
    state.uid = '';
    state.roomId = '';
    state.code = '';
    state.name = '';
    state.teamId = '';
    state.room = null;
    state.questions = {};
    state.secrets = {};
    state.results = {};
    state.teamScores = {};
    state.participantsByServer = {};
    state.answersByServer = {};
    state.pendingJoin = null;
    state.invite = null;
    state.inviteProcessed = false;
    state.selectedAnswer = '';
    state.selectedQuestionIndex = null;
    state.busy = false;
    state.leaving = false;
    state.autoClosing = false;
    state.autoAdvancing = false;
    state.studentScoreOpen = false;
    state.scorePhaseKey = '';
  }

  function pauseTrilhaMode() {
    if (window.App && typeof window.App.pauseForExternalMode === 'function') {
      window.App.pauseForExternalMode();
    }
  }

  function setHomeBusy(isBusy, activeButton, textWhenBusy) {
    if (window.UI && typeof UI.setHomeBusy === 'function') {
      UI.setHomeBusy(isBusy, activeButton, textWhenBusy);
    }
  }

  function setButtonBusy(button, isBusy, textWhenBusy) {
    if (!button) {
      return;
    }

    if (isBusy) {
      button.dataset.originalText = button.textContent;
      button.textContent = textWhenBusy || 'Aguarde';
      button.disabled = true;
      return;
    }

    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }

  function toast(message, type) {
    if (window.UI && UI.toast) {
      UI.toast(message, type);
    }
  }

  function isTeacher() {
    return state.role === 'teacher';
  }

  function isFirebaseConfigured() {
    return getConfiguredServers().length > 0;
  }

  function getConfiguredServers() {
    const servers = Array.isArray(MEGA_CONFIG.servers) ? MEGA_CONFIG.servers : [];
    return servers.filter(function(server) {
      const config = server && server.firebaseConfig ? server.firebaseConfig : {};
      return !!(config.apiKey &&
        config.databaseURL &&
        config.projectId &&
        config.appId &&
        String(config.apiKey).indexOf('COLE_AQUI') === -1);
    });
  }

  function getServerById(serverId) {
    return getConfiguredServers().find(function(server) {
      return server.id === serverId;
    }) || null;
  }

  function getServerLabel(server) {
    return (server && (server.label || server.name || server.id)) || 'servidor Firebase';
  }

  function makeServerPermissionError(context, error) {
    const message = error && error.message ? error.message : String(error || '');
    const denied = /permission|PERMISSION_DENIED|denied/i.test(message);
    const serverName = context && context.server
      ? (context.server.name || context.server.label || context.server.id || 'servidor Firebase')
      : 'servidor Firebase';

    if (denied) {
      return new Error('Permissão negada no ' + serverName + '. Publique as regras atualizadas em Realtime Database > Regras nesse Firebase e confirme que o login Anônimo está ativado.');
    }

    return new Error('Falha no ' + serverName + ': ' + message);
  }

  function getPlayerName() {
    return byId('playerName').value.trim();
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function path() {
    return [ROOT].concat(Array.from(arguments)).join('/');
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

  function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizePin(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 3);
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise(function(_, reject) {
      timer = window.setTimeout(function() {
        reject(new Error(message || 'Tempo limite atingido.'));
      }, timeoutMs);
    });

    return Promise.race([
      Promise.resolve(promise).finally(function() {
        if (timer) {
          window.clearTimeout(timer);
        }
      }),
      timeout
    ]);
  }

  function firstTruthy(promises) {
    return new Promise(function(resolve) {
      let pending = promises.length;
      let settled = false;

      if (!pending) {
        resolve(null);
        return;
      }

      promises.forEach(function(promise) {
        Promise.resolve(promise).then(function(value) {
          if (settled) {
            return;
          }

          if (value) {
            settled = true;
            resolve(value);
            return;
          }

          pending -= 1;
          if (!pending) {
            resolve(null);
          }
        }).catch(function() {
          if (settled) {
            return;
          }

          pending -= 1;
          if (!pending) {
            resolve(null);
          }
        });
      });
    });
  }

  function minutesToMs(minutes) {
    return Number(minutes || 0) * 60 * 1000;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
  }

  function sanitizeFirebaseKey(value) {
    return String(value || '')
      .replace(/[.#$\[\]\/]/g, '_')
      .slice(0, 160);
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
    init,
    tryJoinByCode
  };
})();

window.MegaBattle = MegaBattle;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', MegaBattle.init);
} else {
  MegaBattle.init();
}



