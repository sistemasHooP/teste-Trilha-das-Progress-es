import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const CLASSROOM_CONFIG = window.CLASSROOM_CONFIG || {};

const ClassroomChallenge = (function() {
  const ROOT = 'classroom';
  const SCORE_FASTEST = [10, 8, 7];
  const SCORE_CORRECT = 5;

  const state = {
    contexts: {},
    context: null,
    uid: '',
    role: '',
    roomId: '',
    code: '',
    name: '',
    room: null,
    participants: {},
    questions: {},
    answers: {},
    results: {},
    selectedAnswer: '',
    unsubs: [],
    heartbeatId: null,
    timerId: null,
    autoClosing: false,
    initialized: false,
    busy: false
  };

  function init() {
    if (state.initialized) {
      return;
    }

    state.initialized = true;
    bindEvents();
  }

  function bindEvents() {
    const createButton = byId('createChallengeBtn');
    const joinButton = byId('joinChallengeBtn');

    if (createButton) {
      createButton.addEventListener('click', createChallenge);
    }

    if (joinButton) {
      joinButton.addEventListener('click', joinChallenge);
    }

    byId('challengeStartBtn').addEventListener('click', startChallenge);
    byId('challengeRevealBtn').addEventListener('click', revealCurrentQuestion);
    byId('challengeNextBtn').addEventListener('click', nextQuestion);
    byId('challengeEndBtn').addEventListener('click', endChallenge);
    byId('challengeLeaveBtn').addEventListener('click', leaveChallenge);
    byId('challengeOptions').addEventListener('click', function(event) {
      const button = event.target.closest('[data-challenge-answer]');
      if (button) {
        submitAnswer(button.dataset.challengeAnswer);
      }
    });
  }

  async function createChallenge() {
    if (state.busy) {
      return;
    }

    const name = getPlayerName() || 'Professor';
    if (!isFirebaseConfigured()) {
      toast('Configure o Firebase em js/firebase-config.js para usar o Desafio da Turma.', 'warn');
      return;
    }

    const button = byId('createChallengeBtn');
    state.busy = true;
    pauseTrilhaMode();
    setHomeBusy(true, button, 'Criando desafio');
    setBusy(true, 'Criando desafio');
    try {
      const context = await chooseServer();
      await cleanupServer(context);
      const questions = await loadChallengeQuestions();
      const code = await createUniqueCode(context);
      const roomId = createId('DESAFIO');
      const now = Date.now();

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

      await set(ref(context.db, path('rooms', roomId)), {
        roomId: roomId,
        code: code,
        status: 'LOBBY',
        phase: 'LOBBY',
        hostUid: context.uid,
        hostName: name,
        createdAt: now,
        updatedAt: now,
        questionIndex: 0,
        totalQuestions: CLASSROOM_CONFIG.totalQuestions,
        questionSeconds: CLASSROOM_CONFIG.questionSeconds,
        maxStudents: CLASSROOM_CONFIG.maxStudents,
        serverId: context.server.id
      });

      const updates = {};
      updates[path('codes', code)] = {
        roomId: roomId,
        serverId: context.server.id,
        createdAt: now
      };
      updates[path('participants', roomId, context.uid)] = makeParticipant(name, 'teacher', now);
      updates[path('questions', roomId)] = publicQuestions;
      updates[path('secrets', roomId)] = secretQuestions;
      await update(ref(context.db), updates);

      await enterRoom(context, roomId, code, 'teacher', name);
      toast('Desafio criado. Compartilhe o código com a turma.');
    } catch (error) {
      toast(error.message || String(error), 'error');
    } finally {
      state.busy = false;
      setHomeBusy(false);
      setBusy(false);
    }
  }

  async function joinChallenge() {
    if (state.busy) {
      return;
    }

    const name = getPlayerName();
    const code = normalizeCode(byId('roomCodeInput').value);

    if (!name) {
      toast('Informe seu nome.', 'warn');
      return;
    }

    if (!code) {
      toast('Informe o código do desafio.', 'warn');
      return;
    }

    if (!isFirebaseConfigured()) {
      toast('Configure o Firebase em js/firebase-config.js para entrar no desafio.', 'warn');
      return;
    }

    const button = byId('joinChallengeBtn');
    state.busy = true;
    pauseTrilhaMode();
    setButtonBusy(button, true, 'Entrando');
    setBusy(true, 'Entrando no desafio');
    try {
      const found = await findRoomByCode(code);
      if (!found) {
        throw new Error('Desafio não encontrado.');
      }

      await cleanupServer(found.context);
      const roomSnap = await get(ref(found.context.db, path('rooms', found.roomId)));
      const room = roomSnap.val();
      if (!room || room.status === 'FINISHED') {
        throw new Error('Esse desafio já foi encerrado.');
      }

      const participantsSnap = await get(ref(found.context.db, path('participants', found.roomId)));
      const participants = participantsSnap.val() || {};
      const students = Object.keys(participants).filter(function(uid) {
        return participants[uid].role === 'student';
      });
      if (students.length >= (room.maxStudents || CLASSROOM_CONFIG.maxStudents)) {
        throw new Error('O desafio já atingiu o limite de alunos.');
      }

      const now = Date.now();
      await set(ref(found.context.db, path('participants', found.roomId, found.context.uid)), makeParticipant(name, 'student', now));
      await enterRoom(found.context, found.roomId, code, 'student', name);
      toast('Você entrou no Desafio da Turma.');
    } catch (error) {
      toast(error.message || String(error), 'error');
    } finally {
      state.busy = false;
      setButtonBusy(button, false);
      setBusy(false);
    }
  }

  async function tryJoinByCode(name, rawCode, options) {
    const code = normalizeCode(rawCode);
    options = options || {};

    if (state.busy) {
      return true;
    }

    if (!name || !code || !isFirebaseConfigured()) {
      return false;
    }

    state.busy = true;
    if (options.lockHome) {
      setHomeBusy(true, options.activeButton, options.busyText || 'Entrando');
    }
    setBusy(true, 'Conferindo codigo');

    try {
      const found = await findRoomByCode(code);
      if (!found) {
        return false;
      }

      pauseTrilhaMode();
      await joinFoundChallenge(found, code, name);
      toast('Voce entrou no Desafio da Turma.');
      return true;
    } catch (error) {
      toast(error.message || String(error), 'error');
      return true;
    } finally {
      state.busy = false;
      if (options.lockHome) {
        setHomeBusy(false);
      }
      setBusy(false);
    }
  }

  async function joinFoundChallenge(found, code, name) {
    await cleanupServer(found.context);
    const roomSnap = await get(ref(found.context.db, path('rooms', found.roomId)));
    const room = roomSnap.val();
    if (!room || room.status === 'FINISHED') {
      throw new Error('Esse desafio ja foi encerrado.');
    }

    const participantsSnap = await get(ref(found.context.db, path('participants', found.roomId)));
    const participants = participantsSnap.val() || {};
    const students = Object.keys(participants).filter(function(uid) {
      return participants[uid].role === 'student';
    });
    if (students.length >= (room.maxStudents || CLASSROOM_CONFIG.maxStudents)) {
      throw new Error('O desafio ja atingiu o limite de alunos.');
    }

    const now = Date.now();
    await set(ref(found.context.db, path('participants', found.roomId, found.context.uid)), makeParticipant(name, 'student', now));
    await enterRoom(found.context, found.roomId, code, 'student', name);
  }

  async function enterRoom(context, roomId, code, role, name) {
    stopListeners();
    state.context = context;
    state.uid = context.uid;
    state.role = role;
    state.roomId = roomId;
    state.code = code;
    state.name = name;
    state.selectedAnswer = '';

    await setOnline(true);
    onDisconnect(ref(context.db, path('participants', roomId, context.uid))).update({
      online: false,
      lastSeenAt: Date.now()
    });

    listenRoom();
    startHeartbeat();
    showChallengeView();
  }

  function listenRoom() {
    const db = state.context.db;
    const roomId = state.roomId;
    state.unsubs.push(onValue(ref(db, path('rooms', roomId)), function(snapshot) {
      state.room = snapshot.val();
      if (!state.room) {
        leaveLocal();
        toast('O desafio foi removido.', 'warn');
        return;
      }
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('participants', roomId)), function(snapshot) {
      state.participants = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('questions', roomId)), function(snapshot) {
      state.questions = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('answers', roomId)), function(snapshot) {
      state.answers = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('results', roomId)), function(snapshot) {
      state.results = snapshot.val() || {};
      render();
    }));
  }

  async function startChallenge() {
    if (!isTeacher()) {
      return;
    }

    const now = Date.now();
    await update(ref(state.context.db, path('rooms', state.roomId)), {
      status: 'RUNNING',
      phase: 'QUESTION',
      questionIndex: 0,
      questionStartedAt: now,
      questionEndsAt: now + (CLASSROOM_CONFIG.questionSeconds * 1000),
      updatedAt: now
    });
  }

  async function revealCurrentQuestion() {
    if (!isTeacher() || !state.room || state.room.phase !== 'QUESTION' || state.autoClosing) {
      return;
    }

    state.autoClosing = true;
    try {
      const questionIndex = Number(state.room.questionIndex || 0);
      const secretSnap = await get(ref(state.context.db, path('secrets', state.roomId, questionIndex)));
      const secret = secretSnap.val();
      if (!secret) {
        throw new Error('Gabarito da pergunta não encontrado.');
      }

      const answers = state.answers[questionIndex] || {};
      const students = getStudents();
      const correctAnswers = [];
      let answeredCount = 0;
      let correctCount = 0;
      let wrongCount = 0;

      Object.keys(answers).forEach(function(uid) {
        const participant = state.participants[uid];
        if (!participant || participant.role !== 'student') {
          return;
        }

        const answer = answers[uid];
        answeredCount++;
        const correct = answer.answer === secret.correta;
        if (correct) {
          correctCount++;
          correctAnswers.push({
            uid: uid,
            name: participant.name,
            elapsedMs: Number(answer.elapsedMs || 0)
          });
        } else {
          wrongCount++;
        }
      });

      correctAnswers.sort(function(a, b) {
        return a.elapsedMs - b.elapsedMs;
      });

      const scoreByUid = {};
      correctAnswers.forEach(function(item, index) {
        scoreByUid[item.uid] = SCORE_FASTEST[index] || SCORE_CORRECT;
      });

      const updates = {};
      Object.keys(answers).forEach(function(uid) {
        const participant = state.participants[uid];
        if (!participant || participant.role !== 'student') {
          return;
        }

        const gained = scoreByUid[uid] || 0;
        updates[path('participants', state.roomId, uid, 'score')] = Number(participant.score || 0) + gained;
        updates[path('participants', state.roomId, uid, 'answeredCount')] = Number(participant.answeredCount || 0) + 1;
        if (gained > 0) {
          updates[path('participants', state.roomId, uid, 'correctCount')] = Number(participant.correctCount || 0) + 1;
        }
        updates[path('answers', state.roomId, questionIndex, uid, 'correct')] = gained > 0;
        updates[path('answers', state.roomId, questionIndex, uid, 'scoreGained')] = gained;
      });

      const totalStudents = students.length;
      updates[path('results', state.roomId, questionIndex)] = {
        correta: secret.correta,
        explicacao: secret.explicacao || '',
        totalStudents: totalStudents,
        answeredCount: answeredCount,
        correctCount: correctCount,
        wrongCount: wrongCount,
        noAnswerCount: Math.max(0, totalStudents - answeredCount),
        best: correctAnswers.slice(0, 10).map(function(item) {
          return {
            uid: item.uid,
            name: item.name,
            elapsedMs: item.elapsedMs,
            score: scoreByUid[item.uid] || SCORE_CORRECT
          };
        }),
        revealedAt: Date.now()
      };
      updates[path('rooms', state.roomId, 'phase')] = 'RESULTS';
      updates[path('rooms', state.roomId, 'updatedAt')] = Date.now();
      await update(ref(state.context.db), updates);
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
    if (nextIndex >= Number(state.room.totalQuestions || CLASSROOM_CONFIG.totalQuestions)) {
      await finishChallenge('Desafio concluído.');
      return;
    }

    const now = Date.now();
    state.selectedAnswer = '';
    await update(ref(state.context.db, path('rooms', state.roomId)), {
      phase: 'QUESTION',
      questionIndex: nextIndex,
      questionStartedAt: now,
      questionEndsAt: now + (CLASSROOM_CONFIG.questionSeconds * 1000),
      updatedAt: now
    });
  }

  async function endChallenge() {
    if (isTeacher()) {
      await finishChallenge('Desafio encerrado pelo professor.');
    } else {
      await leaveChallenge();
    }
  }

  async function finishChallenge(message) {
    const now = Date.now();
    await update(ref(state.context.db, path('rooms', state.roomId)), {
      status: 'FINISHED',
      phase: 'FINAL',
      endedAt: now,
      updatedAt: now,
      finishReason: message || 'Desafio finalizado.'
    });
    await remove(ref(state.context.db, path('codes', state.code)));
  }

  async function submitAnswer(letter) {
    if (state.role !== 'student' || !state.room || state.room.phase !== 'QUESTION' || isCurrentUserRemoved()) {
      return;
    }

    const questionIndex = Number(state.room.questionIndex || 0);
    const answerRef = ref(state.context.db, path('answers', state.roomId, questionIndex, state.uid));
    const now = Date.now();
    const elapsedMs = Math.max(0, now - Number(state.room.questionStartedAt || now));
    const result = await runTransaction(answerRef, function(current) {
      if (current) {
        return;
      }

      return {
        uid: state.uid,
        name: state.name,
        answer: letter,
        elapsedMs: elapsedMs,
        submittedAt: now
      };
    });

    if (result.committed) {
      state.selectedAnswer = letter;
      toast('Resposta enviada.');
    } else {
      toast('Você já respondeu esta pergunta.', 'warn');
    }
    render();
  }

  function render() {
    if (!state.room) {
      return;
    }

    showChallengeView();
    byId('challengeCode').textContent = state.code || state.room.code || '0000';
    byId('challengeRoleLabel').textContent = isTeacher() ? 'Professor do desafio' : 'Aluno do desafio';
    byId('challengeTeacherPanel').hidden = !isTeacher();

    renderQuestion();
    renderTeacherPanel();
    renderRanking();
    renderParticipants();
    updateTimer();
  }

  function renderQuestion() {
    const room = state.room;
    const index = Number(room.questionIndex || 0);
    const question = state.questions[index];
    const result = state.results[index];
    const progress = Math.min(index + 1, Number(room.totalQuestions || CLASSROOM_CONFIG.totalQuestions));

    byId('challengeProgress').textContent = 'Pergunta ' + progress + '/' + (room.totalQuestions || CLASSROOM_CONFIG.totalQuestions);
    byId('challengeResultBox').hidden = true;
    byId('challengeStudentWaiting').hidden = true;

    if (isCurrentUserRemoved()) {
      byId('challengeQuestionType').textContent = 'Aviso';
      byId('challengeQuestionText').textContent = 'Você foi removido do desafio por falta de conexão.';
      byId('challengeOptions').innerHTML = '';
      return;
    }

    if (room.status === 'LOBBY') {
      byId('challengeQuestionType').textContent = 'Quiz';
      byId('challengeQuestionText').textContent = isTeacher()
        ? 'Compartilhe o código e inicie quando a turma entrar.'
        : 'Aguardando o professor iniciar o desafio.';
      byId('challengeOptions').innerHTML = '';
      return;
    }

    if (!question) {
      byId('challengeQuestionText').textContent = 'Carregando pergunta.';
      byId('challengeOptions').innerHTML = '';
      return;
    }

    byId('challengeQuestionType').textContent = question.tipo;
    byId('challengeQuestionText').textContent = question.enunciado;

    const answer = getMyCurrentAnswer();
    const isAnswerLocked = !!answer || room.phase !== 'QUESTION' || isTeacher();
    byId('challengeOptions').innerHTML = Object.keys(question.alternativas).map(function(letter) {
      const selected = answer && answer.answer === letter;
      const correct = result && result.correta === letter;
      const classes = [
        'answer-option',
        selected ? 'is-selected' : '',
        result && correct ? 'is-correct' : '',
        result && selected && !correct ? 'is-wrong' : ''
      ].filter(Boolean).join(' ');

      return [
        '<button class="' + classes + '" type="button" data-challenge-answer="' + letter + '"' + (isAnswerLocked ? ' disabled' : '') + '>',
        '  <strong>' + letter + '</strong>',
        '  <span>' + escapeHtml(question.alternativas[letter]) + '</span>',
        '</button>'
      ].join('');
    }).join('');

    if (answer && room.phase === 'QUESTION') {
      byId('challengeStudentWaiting').hidden = false;
    }

    if (room.phase === 'RESULTS' || room.phase === 'FINAL') {
      renderResult(result);
    }
  }

  function renderResult(result) {
    const box = byId('challengeResultBox');
    if (!result) {
      box.hidden = true;
      return;
    }

    const total = Number(result.totalStudents || 0);
    const correct = Number(result.correctCount || 0);
    const wrong = Number(result.wrongCount || 0);
    const noAnswer = Number(result.noAnswerCount || 0);
    const percent = total ? Math.round((correct / total) * 100) : 0;
    const best = result.best || [];

    box.hidden = false;
    box.className = 'question-feedback question-feedback--ok';
    box.innerHTML = [
      '<div class="feedback-title"><span>Resultado</span><strong>Resposta correta: ' + escapeHtml(result.correta) + '</strong></div>',
      '<p>' + escapeHtml(result.explicacao || '') + '</p>',
      '<p>Acertos: ' + correct + ' (' + percent + '%) · Erros: ' + wrong + ' · Sem resposta: ' + noAnswer + '</p>',
      best.length ? '<p>Mais rápidos: ' + best.slice(0, 3).map(function(item, index) {
        return (index + 1) + 'º ' + escapeHtml(item.name) + ' (+' + item.score + ')';
      }).join(' · ') + '</p>' : '<p>Ninguém acertou esta pergunta.</p>'
    ].join('');
  }

  function renderTeacherPanel() {
    if (!isTeacher() || !state.room) {
      return;
    }

    const room = state.room;
    const index = Number(room.questionIndex || 0);
    const answers = state.answers[index] || {};
    const result = state.results[index];
    const students = getStudents();
    const answered = Object.keys(answers).filter(function(uid) {
      return state.participants[uid] && state.participants[uid].role === 'student';
    }).length;

    byId('challengeAnsweredBadge').textContent = answered + '/' + students.length + ' respostas';
    if (result) {
      const total = Number(result.totalStudents || 0);
      byId('challengeCorrectRate').textContent = total ? Math.round((Number(result.correctCount || 0) / total) * 100) + '%' : '0%';
      byId('challengeWrongRate').textContent = total ? Math.round((Number(result.wrongCount || 0) / total) * 100) + '%' : '0%';
    } else {
      byId('challengeCorrectRate').textContent = '0%';
      byId('challengeWrongRate').textContent = '0%';
    }

    byId('challengeStartBtn').hidden = room.status !== 'LOBBY';
    byId('challengeRevealBtn').hidden = room.phase !== 'QUESTION';
    byId('challengeNextBtn').hidden = room.phase !== 'RESULTS';
    byId('challengeNextBtn').textContent = Number(room.questionIndex || 0) + 1 >= Number(room.totalQuestions || CLASSROOM_CONFIG.totalQuestions)
      ? 'Finalizar desafio'
      : 'Próxima pergunta';
  }

  function renderRanking() {
    const ranking = getStudents().sort(function(a, b) {
      if (Number(b.score || 0) !== Number(a.score || 0)) {
        return Number(b.score || 0) - Number(a.score || 0);
      }
      if (Number(b.correctCount || 0) !== Number(a.correctCount || 0)) {
        return Number(b.correctCount || 0) - Number(a.correctCount || 0);
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    byId('challengeStudentCount').textContent = ranking.length + ' alunos';
    byId('challengeRankingList').innerHTML = ranking.length
      ? ranking.slice(0, 12).map(function(player, index) {
        return [
          '<div class="ranking-item ranking-item--fastest">',
          '  <span class="rank-number">' + (index + 1) + '</span>',
          '  <span><strong>' + escapeHtml(player.name) + '</strong><small>' + Number(player.correctCount || 0) + ' acertos · ' + (player.online ? 'online' : 'offline') + '</small></span>',
          '  <strong>' + Number(player.score || 0) + ' pts</strong>',
          '</div>'
        ].join('');
      }).join('')
      : '<p class="muted-text">Aguardando alunos.</p>';
  }

  function renderParticipants() {
    const participants = Object.keys(state.participants).map(function(uid) {
      return Object.assign({ uid: uid }, state.participants[uid]);
    }).sort(function(a, b) {
      if (a.role !== b.role) {
        return a.role === 'teacher' ? -1 : 1;
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    byId('challengeParticipantsList').innerHTML = participants.map(function(player) {
      const badge = player.role === 'teacher' ? 'Professor' : (player.online ? 'Online' : 'Offline');
      const badgeClass = player.online || player.role === 'teacher' ? 'mini-badge--online' : 'mini-badge--offline';
      return [
        '<li class="player-item' + (!player.online && player.role !== 'teacher' ? ' is-disconnected' : '') + '">',
        '  <span class="player-name"><span class="player-dot"></span><span>' + escapeHtml(player.name) + '</span></span>',
        '  <span><span class="mini-badge ' + badgeClass + '">' + badge + '</span></span>',
        '</li>'
      ].join('');
    }).join('');
  }

  function updateTimer() {
    if (!state.room) {
      return;
    }

    let seconds = 0;
    if (state.room.phase === 'QUESTION') {
      seconds = Math.max(0, Math.ceil((Number(state.room.questionEndsAt || 0) - Date.now()) / 1000));
    }
    byId('challengeTimer').textContent = formatClock(seconds);

    if (isTeacher() && state.room.phase === 'QUESTION' && seconds <= 0) {
      revealCurrentQuestion();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatId = window.setInterval(function() {
      setOnline(true);
      cleanupDisconnectedStudents();
    }, (CLASSROOM_CONFIG.heartbeatSeconds || 10) * 1000);
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

  async function cleanupDisconnectedStudents() {
    if (!isTeacher() || !state.room || state.room.status === 'FINISHED') {
      return;
    }

    const cutoff = Date.now() - ((CLASSROOM_CONFIG.disconnectSeconds || 30) * 1000);
    const updates = {};
    Object.keys(state.participants).forEach(function(uid) {
      const participant = state.participants[uid];
      if (participant.role === 'student' && participant.online === false && Number(participant.lastSeenAt || 0) < cutoff) {
        updates[path('participants', state.roomId, uid, 'removed')] = true;
      }
    });

    if (Object.keys(updates).length) {
      await update(ref(state.context.db), updates);
    }
  }

  async function setOnline(online) {
    if (!state.context || !state.roomId || !state.uid) {
      return;
    }

    await update(ref(state.context.db, path('participants', state.roomId, state.uid)), {
      online: online,
      lastSeenAt: Date.now()
    });
  }

  async function leaveChallenge() {
    try {
      if (isTeacher() && state.room && state.room.status !== 'FINISHED') {
        await finishChallenge('Desafio encerrado pelo professor.');
      } else {
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
    state.context = null;
    state.uid = '';
    state.role = '';
    state.roomId = '';
    state.code = '';
    state.room = null;
    state.participants = {};
    state.questions = {};
    state.answers = {};
    state.results = {};
    state.selectedAnswer = '';
    UI.showView('home');
    UI.setConnection('idle', 'Pronto para jogar');
  }

  function stopListeners() {
    state.unsubs.forEach(function(unsub) {
      if (typeof unsub === 'function') {
        unsub();
      }
    });
    state.unsubs = [];
  }

  async function loadChallengeQuestions() {
    if (!window.ApiClient || !window.ApiClient.isConfigured()) {
      throw new Error('Configure a API do Google Apps Script para sortear perguntas.');
    }

    const data = await window.ApiClient.request('getPerguntasDesafio', {
      quantidade: CLASSROOM_CONFIG.totalQuestions
    });
    return data.perguntas || [];
  }

  async function chooseServer() {
    const contexts = await getConfiguredContexts();
    let best = null;
    let bestCount = Infinity;

    for (const context of contexts) {
      const roomsSnap = await get(ref(context.db, path('rooms')));
      const rooms = roomsSnap.val() || {};
      const activeCount = Object.keys(rooms).filter(function(roomId) {
        return rooms[roomId] && rooms[roomId].status !== 'FINISHED';
      }).length;
      if (activeCount < bestCount) {
        best = context;
        bestCount = activeCount;
      }
    }

    return best || contexts[0];
  }

  async function findRoomByCode(code) {
    const contexts = await getConfiguredContexts();
    for (const context of contexts) {
      const codeSnap = await get(ref(context.db, path('codes', code)));
      if (codeSnap.exists()) {
        return {
          context: context,
          roomId: codeSnap.val().roomId
        };
      }
    }
    return null;
  }

  async function getConfiguredContexts() {
    const servers = (CLASSROOM_CONFIG.servers || []).filter(isServerConfigured);
    if (!servers.length) {
      throw new Error('Nenhum servidor Firebase foi configurado.');
    }

    const contexts = [];
    for (const server of servers) {
      if (!state.contexts[server.id]) {
        const app = initializeApp(server.firebaseConfig, 'classroom-' + server.id);
        const auth = getAuth(app);
        const credential = await signInAnonymously(auth);
        state.contexts[server.id] = {
          server: server,
          app: app,
          auth: auth,
          uid: credential.user.uid,
          db: getDatabase(app)
        };
      }
      contexts.push(state.contexts[server.id]);
    }
    return contexts;
  }

  async function createUniqueCode(context) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = String(randomInt(10000, 99999));
      const snap = await get(ref(context.db, path('codes', code)));
      if (!snap.exists()) {
        return code;
      }
    }
    return String(randomInt(10000, 99999));
  }

  async function cleanupServer(context) {
    try {
      const roomsSnap = await get(ref(context.db, path('rooms')));
      const rooms = roomsSnap.val() || {};
      const now = Date.now();
      const updates = {};

      Object.keys(rooms).forEach(function(roomId) {
        const room = rooms[roomId];
        if (!room) {
          return;
        }

        const age = now - Number(room.updatedAt || room.createdAt || now);
        if (room.status === 'FINISHED' && age > 10 * 60 * 1000 && room.hostUid === context.uid) {
          updates[path('rooms', roomId)] = null;
          updates[path('participants', roomId)] = null;
          updates[path('questions', roomId)] = null;
          updates[path('secrets', roomId)] = null;
          updates[path('answers', roomId)] = null;
          updates[path('results', roomId)] = null;
          if (room.code) {
            updates[path('codes', room.code)] = null;
          }
        }

        if (room.status === 'LOBBY' && age > 30 * 60 * 1000 && room.hostUid === context.uid) {
          updates[path('rooms', roomId, 'status')] = 'FINISHED';
          updates[path('rooms', roomId, 'phase')] = 'FINAL';
          updates[path('rooms', roomId, 'finishReason')] = 'Sala encerrada por inatividade.';
          updates[path('rooms', roomId, 'updatedAt')] = now;
          if (room.code) {
            updates[path('codes', room.code)] = null;
          }
        }
      });

      if (Object.keys(updates).length) {
        await update(ref(context.db), updates);
      }
    } catch (error) {
      console.warn('Limpeza do servidor ignorada:', error);
    }
  }

  function getStudents() {
    return Object.keys(state.participants).map(function(uid) {
      return Object.assign({ uid: uid }, state.participants[uid]);
    }).filter(function(player) {
      return player.role === 'student' && !player.removed;
    });
  }

  function getMyCurrentAnswer() {
    if (!state.room) {
      return null;
    }
    const index = Number(state.room.questionIndex || 0);
    return state.answers[index] && state.answers[index][state.uid] ? state.answers[index][state.uid] : null;
  }

  function makeParticipant(name, role, now) {
    return {
      name: name,
      role: role,
      score: 0,
      correctCount: 0,
      answeredCount: 0,
      online: true,
      joinedAt: now,
      lastSeenAt: now,
      removed: false
    };
  }

  function isFirebaseConfigured() {
    return (CLASSROOM_CONFIG.servers || []).some(isServerConfigured);
  }

  function isServerConfigured(server) {
    const config = server && server.firebaseConfig ? server.firebaseConfig : {};
    return !!(config.apiKey &&
      config.databaseURL &&
      config.projectId &&
      config.appId &&
      String(config.apiKey).indexOf('COLE_AQUI') === -1);
  }

  function isTeacher() {
    return state.role === 'teacher';
  }

  function isCurrentUserRemoved() {
    return !!(state.participants[state.uid] && state.participants[state.uid].removed);
  }

  function getPlayerName() {
    return byId('playerName').value.trim();
  }

  function showChallengeView() {
    UI.showView('challenge');
    UI.setConnection('ok', getChallengeStatusText());
  }

  function getChallengeStatusText() {
    if (!state.room || state.room.status === 'LOBBY') {
      return 'Aguardando jogadores';
    }

    if (state.room.status === 'FINISHED' || state.room.phase === 'FINAL') {
      return 'Desafio finalizado';
    }

    if (state.room.phase === 'RESULTS') {
      return 'Resultado liberado';
    }

    if (state.room.phase === 'QUESTION') {
      return 'Pergunta em andamento';
    }

    return 'Desafio da turma';
  }

  function setBusy(isBusy, text) {
    document.body.classList.toggle('is-busy-action', isBusy);
    if (isBusy) {
      toast(text || 'Processando.');
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

  function setHomeBusy(isBusy, activeButton, textWhenBusy) {
    if (window.UI && typeof UI.setHomeBusy === 'function') {
      UI.setHomeBusy(isBusy, activeButton, textWhenBusy);
      return;
    }

    setButtonBusy(activeButton, isBusy, textWhenBusy);
  }

  function toast(message, type) {
    if (window.UI && UI.toast) {
      UI.toast(message, type);
    }
  }

  function pauseTrilhaMode() {
    if (window.App && typeof window.App.pauseForExternalMode === 'function') {
      window.App.pauseForExternalMode();
      return;
    }

    localStorage.removeItem('trilha.salaId');
    localStorage.removeItem('trilha.playerId');
  }

  function path() {
    return [ROOT].concat(Array.from(arguments)).join('/');
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeCode(code) {
    return String(code || '').trim().toUpperCase();
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

  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
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

window.ClassroomChallenge = ClassroomChallenge;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ClassroomChallenge.init);
} else {
  ClassroomChallenge.init();
}
