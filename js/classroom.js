import { FirebaseQuestions } from './firebase-questions.js?v=20260520-link1';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
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
  const AUTO_NEXT_RESULTS_MS = 8000;
  const SERVER_CONNECT_TIMEOUT_MS = 9000;
  const SERVER_READ_TIMEOUT_MS = 6000;
  const SERVER_WRITE_TIMEOUT_MS = 8000;

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
    selectedQuestionIndex: null,
    unsubs: [],
    heartbeatId: null,
    timerId: null,
    autoClosing: false,
    autoAdvancing: false,
    initialized: false,
    busy: false,
    leaving: false
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
    byId('copyChallengeCodeBtn').addEventListener('click', function() {
      const code = state.code || (state.room && state.room.code) || byId('challengeCode').textContent;
      if (window.UI && typeof UI.copyText === 'function') {
        UI.copyText(code, 'Código do desafio copiado.');
      }
    });
    byId('challengeSubmitAnswerBtn').addEventListener('click', submitSelectedAnswer);
    byId('challengeOptions').addEventListener('click', function(event) {
      const button = event.target.closest('[data-challenge-answer]');
      if (button) {
        selectAnswer(button.dataset.challengeAnswer);
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
      cleanupServer(context).catch(function(error) {
        console.warn('Limpeza inicial do Desafio ignorada:', error);
      });
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

      await withTimeout(
        set(ref(context.db, path('rooms', roomId)), {
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
        }),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao criar desafio no ' + getServerLabel(context.server) + '.'
      );

      const updates = {};
      updates[path('codes', code)] = {
        roomId: roomId,
        serverId: context.server.id,
        createdAt: now
      };
      updates[path('participants', roomId, context.uid)] = makeParticipant(name, 'teacher', now);
      updates[path('questions', roomId)] = publicQuestions;
      updates[path('secrets', roomId)] = secretQuestions;
      await withTimeout(
        update(ref(context.db), updates),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao gravar desafio no ' + getServerLabel(context.server) + '.'
      );

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

      cleanupServer(found.context).catch(function(error) {
        console.warn('Limpeza ao entrar no Desafio ignorada:', error);
      });
      const roomSnap = await withTimeout(
        get(ref(found.context.db, path('rooms', found.roomId))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao abrir desafio.'
      );
      const room = roomSnap.val();
      if (!room || room.status === 'FINISHED') {
        throw new Error('Esse desafio já foi encerrado.');
      }

      const participantsSnap = await withTimeout(
        get(ref(found.context.db, path('participants', found.roomId))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao ler participantes.'
      );
      const participants = participantsSnap.val() || {};
      const students = Object.keys(participants).filter(function(uid) {
        return participants[uid].role === 'student';
      });
      if (students.length >= (room.maxStudents || CLASSROOM_CONFIG.maxStudents)) {
        throw new Error('O desafio já atingiu o limite de alunos.');
      }

      const now = Date.now();
      await withTimeout(
        set(ref(found.context.db, path('participants', found.roomId, found.context.uid)), makeParticipant(name, 'student', now)),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao entrar no desafio.'
      );
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
    setBusy(true, 'Conferindo código');

    try {
      const found = await findRoomByCode(code);
      if (!found) {
        return false;
      }

      pauseTrilhaMode();
      const joined = await joinFoundChallenge(found, code, name);
      if (!joined) {
        return false;
      }
      toast('Você entrou no Desafio da Turma.');
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
    cleanupServer(found.context).catch(function(error) {
      console.warn('Limpeza ao entrar no Desafio ignorada:', error);
    });
    const roomSnap = await withTimeout(
      get(ref(found.context.db, path('rooms', found.roomId))),
      SERVER_READ_TIMEOUT_MS,
      'Tempo limite ao abrir desafio.'
    );
    const room = roomSnap.val();
    if (!room || room.status === 'FINISHED') {
      return false;
    }

    const participantsSnap = await withTimeout(
      get(ref(found.context.db, path('participants', found.roomId))),
      SERVER_READ_TIMEOUT_MS,
      'Tempo limite ao ler participantes.'
    );
    const participants = participantsSnap.val() || {};
    const students = Object.keys(participants).filter(function(uid) {
      return participants[uid].role === 'student';
    });
    if (students.length >= (room.maxStudents || CLASSROOM_CONFIG.maxStudents)) {
      throw new Error('O desafio ja atingiu o limite de alunos.');
    }

    const now = Date.now();
    await withTimeout(
      set(ref(found.context.db, path('participants', found.roomId, found.context.uid)), makeParticipant(name, 'student', now)),
      SERVER_WRITE_TIMEOUT_MS,
      'Tempo limite ao entrar no desafio.'
    );
    await enterRoom(found.context, found.roomId, code, 'student', name);
    return true;
  }

  async function enterRoom(context, roomId, code, role, name) {
    stopListeners();
    state.leaving = false;
    state.context = context;
    state.uid = context.uid;
    state.role = role;
    state.roomId = roomId;
    state.code = code;
    state.name = name;
    state.selectedAnswer = '';
    resetChallengeLobbyScreen();

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
      if (state.leaving) {
        return;
      }
      state.room = snapshot.val();
      if (!state.room) {
        leaveLocal();
        toast('O desafio foi removido.', 'warn');
        return;
      }
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('participants', roomId)), function(snapshot) {
      if (state.leaving) {
        return;
      }
      state.participants = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('questions', roomId)), function(snapshot) {
      if (state.leaving) {
        return;
      }
      state.questions = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('answers', roomId)), function(snapshot) {
      if (state.leaving) {
        return;
      }
      state.answers = snapshot.val() || {};
      render();
    }));
    state.unsubs.push(onValue(ref(db, path('results', roomId)), function(snapshot) {
      if (state.leaving) {
        return;
      }
      state.results = snapshot.val() || {};
      render();
    }));
  }

  async function startChallenge() {
    if (!isTeacher()) {
      return;
    }

    const now = Date.now();
    state.selectedAnswer = '';
    state.selectedQuestionIndex = 0;
    await update(ref(state.context.db, path('rooms', state.roomId)), {
      status: 'RUNNING',
      phase: 'QUESTION',
      questionIndex: 0,
      startedAt: now,
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
      const onlineStudents = getOnlineStudents();
      const question = state.questions[questionIndex] || {};
      const correctAnswers = [];
      const answeredStudentIds = {};
      let answeredCount = 0;
      let correctCount = 0;
      let explicitWrongCount = 0;

      Object.keys(answers).forEach(function(uid) {
        const participant = state.participants[uid];
        if (!participant || participant.role !== 'student' || participant.removed) {
          return;
        }

        const answer = answers[uid];
        answeredStudentIds[uid] = true;
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
          explicitWrongCount++;
        }
      });

      const missedStudents = students.filter(function(player) {
        return !answeredStudentIds[player.uid];
      });
      const noAnswerCount = missedStudents.length;
      const wrongCount = explicitWrongCount + noAnswerCount;

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
        if (!participant || participant.role !== 'student' || participant.removed) {
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

      missedStudents.forEach(function(player) {
        updates[path('participants', state.roomId, player.uid, 'answeredCount')] = Number(player.answeredCount || 0) + 1;
        updates[path('answers', state.roomId, questionIndex, player.uid)] = {
          uid: player.uid,
          name: player.name,
          answer: '',
          elapsedMs: Math.max(0, Date.now() - Number(state.room.questionStartedAt || Date.now())),
          submittedAt: Date.now(),
          correct: false,
          scoreGained: 0,
          missed: true
        };
      });

      const totalStudents = students.length;
      updates[path('results', state.roomId, questionIndex)] = {
        correta: secret.correta,
        explicacao: secret.explicacao || '',
        questionNumber: questionIndex + 1,
        questionText: question.enunciado || '',
        totalStudents: totalStudents,
        totalOnlineStudents: onlineStudents.length,
        answeredCount: answeredCount,
        correctCount: correctCount,
        wrongCount: wrongCount,
        noAnswerCount: noAnswerCount,
        noAnswerCountsAsWrong: true,
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
    state.selectedQuestionIndex = nextIndex;
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
    if (isTeacher()) {
      await saveChallengeRanking(now);
    }
    await update(ref(state.context.db, path('rooms', state.roomId)), {
      status: 'FINISHED',
      phase: 'FINAL',
      endedAt: now,
      updatedAt: now,
      finishReason: message || 'Desafio finalizado.'
    });
    await remove(ref(state.context.db, path('codes', state.code)));
  }

  async function saveChallengeRanking(now) {
    const students = getStudents().filter(function(player) {
      return Number(player.score || 0) > 0 || Number(player.correctCount || 0) > 0;
    }).sort(function(a, b) {
      if (Number(b.score || 0) !== Number(a.score || 0)) {
        return Number(b.score || 0) - Number(a.score || 0);
      }
      if (Number(b.correctCount || 0) !== Number(a.correctCount || 0)) {
        return Number(b.correctCount || 0) - Number(a.correctCount || 0);
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    if (!students.length) {
      return;
    }

    const winner = students[0];
    const duration = Math.max(1, Math.round((now - Number(state.room.startedAt || state.room.createdAt || now)) / 1000));
    const rankingId = sanitizeFirebaseKey(['CLASSROOM', state.roomId, winner.uid].join('_'));

    await set(ref(state.context.db, 'ranking/entries/' + rankingId), {
      rankingId: rankingId,
      uid: state.uid,
      salaId: state.roomId || '',
      codigoSala: state.code || '',
      playerId: winner.uid || '',
      nome: String(winner.name || 'Aluno').slice(0, 40),
      modo: 'CLASSROOM',
      pontos: Number(winner.score || 0),
      acertos: Number(winner.correctCount || 0),
      totalPerguntas: Number(state.room.totalQuestions || CLASSROOM_CONFIG.totalQuestions || 10),
      duracaoSegundos: duration,
      motivoEncerramento: 'DESAFIO_CONCLUIDO',
      concluiu: true,
      createdAt: now,
      criadoEm: new Date(now).toISOString(),
      origem: 'classroom-ranking-v1'
    });
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
      state.selectedAnswer = '';
      state.selectedQuestionIndex = null;
      toast('Resposta enviada.');
    } else {
      toast('Você já respondeu esta pergunta.', 'warn');
    }
    render();
  }

  function selectAnswer(letter) {
    if (state.role !== 'student' || !state.room || state.room.phase !== 'QUESTION' || getMyCurrentAnswer() || isCurrentUserRemoved()) {
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

    const letter = state.selectedAnswer;
    await submitAnswer(letter);
  }

  function render() {
    if (state.leaving || !state.room) {
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
    byId('challengeSubmitAnswerBtn').hidden = true;
    byId('challengeSubmitAnswerBtn').disabled = true;

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
    if (!answer && state.selectedQuestionIndex !== index) {
      state.selectedAnswer = '';
      state.selectedQuestionIndex = index;
    }
    const selectedAnswer = answer ? answer.answer : state.selectedAnswer;
    const isAnswerLocked = !!answer || room.phase !== 'QUESTION' || isTeacher();
    byId('challengeOptions').innerHTML = Object.keys(question.alternativas).map(function(letter) {
      const selected = selectedAnswer === letter;
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

    const submitButton = byId('challengeSubmitAnswerBtn');
    submitButton.hidden = isTeacher() || room.phase !== 'QUESTION' || !!answer;
    submitButton.disabled = !state.selectedAnswer || !!answer || room.phase !== 'QUESTION';

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
    const wrong = getResultWrongTotal(result);
    const noAnswer = Number(result.noAnswerCount || 0);
    const percent = total ? Math.round((correct / total) * 100) : 0;
    const best = result.best || [];

    box.hidden = false;
    box.className = 'question-feedback question-feedback--ok';
    box.innerHTML = [
      '<div class="feedback-title"><span>Resultado</span><strong>Resposta correta: ' + escapeHtml(result.correta) + '</strong></div>',
      '<p>' + escapeHtml(result.explicacao || '') + '</p>',
      '<p>Acertos: ' + correct + ' (' + percent + '%) · Erros: ' + wrong + (noAnswer ? ' (' + noAnswer + ' sem resposta)' : '') + '</p>',
      best.length ? '<p>Mais rápidos: ' + best.slice(0, 3).map(function(item, index) {
        return (index + 1) + 'º ' + escapeHtml(item.name) + ' (+' + item.score + ')';
      }).join(' · ') + '</p>' : '<p>Ninguém acertou esta pergunta.</p>',
      '<p id="challengeNextCountdown" class="next-countdown">' + escapeHtml(getAutoNextText()) + '</p>'
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
    const onlineStudents = getOnlineStudents();
    const answeredOnline = onlineStudents.filter(function(player) {
      return !!answers[player.uid];
    }).length;
    const inLobby = room.status === 'LOBBY';

    byId('challengeControlTitle').textContent = inLobby ? 'Sala da turma' : 'Controle';
    byId('challengeAnsweredBadge').hidden = inLobby;
    byId('challengeQuestionStats').hidden = inLobby;
    byId('challengeOverallStats').hidden = inLobby;
    byId('challengeAnsweredBadge').textContent = answeredOnline + '/' + onlineStudents.length + ' online';
    if (result) {
      const total = Number(result.totalStudents || 0);
      byId('challengeCorrectRate').textContent = total ? Math.round((Number(result.correctCount || 0) / total) * 100) + '%' : '0%';
      byId('challengeWrongRate').textContent = total ? Math.round((getResultWrongTotal(result) / total) * 100) + '%' : '0%';
    } else {
      byId('challengeCorrectRate').textContent = '0%';
      byId('challengeWrongRate').textContent = '0%';
    }

    renderOverallStats();
    renderFlowHint();

    byId('challengeStartBtn').hidden = room.status !== 'LOBBY';
    byId('challengeRevealBtn').hidden = room.phase !== 'QUESTION';
    byId('challengeNextBtn').hidden = room.phase !== 'RESULTS';
    byId('challengeEndBtn').hidden = inLobby;
    if (room.phase === 'RESULTS') {
      const seconds = getAutoNextSeconds();
      byId('challengeNextBtn').textContent = Number(room.questionIndex || 0) + 1 >= Number(room.totalQuestions || CLASSROOM_CONFIG.totalQuestions)
        ? (seconds > 0 ? 'Finaliza em ' + seconds + 's' : 'Finalizar desafio')
        : (seconds > 0 ? 'Próxima em ' + seconds + 's' : 'Próxima pergunta');
    } else {
      byId('challengeNextBtn').textContent = 'Próxima pergunta';
    }
  }

  function renderOverallStats() {
    const results = Object.keys(state.results || {}).map(function(index) {
      return Object.assign({ index: Number(index) }, state.results[index]);
    }).filter(function(result) {
      return result && result.revealedAt;
    });

    let totalCorrect = 0;
    let totalWrong = 0;
    let totalNoAnswer = 0;

    results.forEach(function(result) {
      totalCorrect += Number(result.correctCount || 0);
      totalWrong += getResultWrongTotal(result);
      totalNoAnswer += Number(result.noAnswerCount || 0);
    });

    const total = totalCorrect + totalWrong;
    byId('challengeOverallCorrectRate').textContent = total ? Math.round((totalCorrect / total) * 100) + '%' : '0%';
    byId('challengeOverallWrongRate').textContent = total ? Math.round((totalWrong / total) * 100) + '%' : '0%';
    byId('challengeOverallCorrectText').textContent = totalCorrect + ' acertos';
    byId('challengeOverallWrongText').textContent = totalWrong + ' erros' + (totalNoAnswer ? ' (' + totalNoAnswer + ' sem resposta)' : '');

    const best = getQuestionExtreme(results, 'correct');
    const hard = getQuestionExtreme(results, 'wrong');
    byId('challengeBestQuestion').textContent = best ? formatQuestionExtreme(best, 'acertos') : 'Aguardando resultados.';
    byId('challengeHardQuestion').textContent = hard ? formatQuestionExtreme(hard, 'erros') : 'Aguardando resultados.';
  }

  function getQuestionExtreme(results, kind) {
    if (!results.length) {
      return null;
    }

    return results.slice().sort(function(a, b) {
      const aTotal = Math.max(1, Number(a.totalStudents || 0));
      const bTotal = Math.max(1, Number(b.totalStudents || 0));
      const aValue = kind === 'correct' ? Number(a.correctCount || 0) : getResultWrongTotal(a);
      const bValue = kind === 'correct' ? Number(b.correctCount || 0) : getResultWrongTotal(b);
      const rateDiff = (bValue / bTotal) - (aValue / aTotal);
      if (rateDiff !== 0) {
        return rateDiff;
      }
      return Number(a.index || 0) - Number(b.index || 0);
    })[0];
  }

  function formatQuestionExtreme(result, label) {
    const actualTotal = Number(result.totalStudents || 0);
    if (actualTotal <= 0) {
      return 'Pergunta ' + (Number(result.questionNumber || result.index + 1)) + ': sem respostas';
    }

    const total = Math.max(1, actualTotal);
    const value = label === 'acertos'
      ? Number(result.correctCount || 0)
      : getResultWrongTotal(result);
    const percent = Math.round((value / total) * 100);
    return 'Pergunta ' + (Number(result.questionNumber || result.index + 1)) + ': ' + percent + '% de ' + label + ' (' + value + '/' + total + ')';
  }

  function getResultWrongTotal(result) {
    if (!result) {
      return 0;
    }

    const wrong = Number(result.wrongCount || 0);
    const noAnswer = Number(result.noAnswerCount || 0);
    return result.noAnswerCountsAsWrong ? wrong : wrong + noAnswer;
  }

  function renderFlowHint() {
    const hint = byId('challengeFlowHint');
    if (!hint || !state.room) {
      return;
    }

    const room = state.room;
    if (room.status === 'LOBBY') {
      hint.textContent = 'Inicie quando os alunos entrarem na sala.';
      return;
    }

    if (room.phase === 'QUESTION') {
      const online = getOnlineStudents();
      const answered = getAnsweredOnlineCount();
      hint.textContent = online.length
        ? 'Resultado automático quando ' + answered + '/' + online.length + ' alunos online responderem.'
        : 'Aguardando alunos online. Você pode mostrar o resultado manualmente.';
      return;
    }

    if (room.phase === 'RESULTS') {
      const seconds = getAutoNextSeconds();
      const nextButton = byId('challengeNextBtn');
      if (nextButton) {
        nextButton.textContent = Number(room.questionIndex || 0) + 1 >= Number(room.totalQuestions || CLASSROOM_CONFIG.totalQuestions)
          ? (seconds > 0 ? 'Finaliza em ' + seconds + 's' : 'Finalizar desafio')
          : (seconds > 0 ? 'Próxima em ' + seconds + 's' : 'Próxima pergunta');
      }
      hint.textContent = seconds > 0
        ? 'Próxima pergunta automática em ' + seconds + 's. O botão continua disponível para adiantar.'
        : 'Avançando para a próxima pergunta.';
      return;
    }

    hint.textContent = 'Desafio finalizado.';
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
    const finalRound = Number(state.room.questionIndex || 0) + 1 >= Number(state.room.totalQuestions || CLASSROOM_CONFIG.totalQuestions);
    if (seconds <= 0) {
      return finalRound ? 'Finalizando o desafio.' : 'Preparando a próxima pergunta.';
    }

    return finalRound
      ? 'Resultado final em ' + seconds + 's.'
      : 'Próxima pergunta em ' + seconds + 's.';
  }

  function renderRanking() {
    const panel = byId('challengeRankingPanel');
    if (panel && state.room) {
      panel.hidden = state.room.status === 'LOBBY';
    }

    if (state.room && state.room.status === 'LOBBY') {
      byId('challengeStudentCount').textContent = getStudents().length + ' alunos';
      byId('challengeRankingList').innerHTML = '';
      return;
    }

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
    } else if (state.room.phase === 'RESULTS') {
      seconds = getAutoNextSeconds();
    }
    byId('challengeTimer').textContent = formatClock(seconds);

    const nextCountdown = byId('challengeNextCountdown');
    if (nextCountdown) {
      nextCountdown.textContent = getAutoNextText();
    }

    if (!isTeacher()) {
      return;
    }

    renderFlowHint();

    if (state.room.phase === 'QUESTION') {
      if (allOnlineStudentsAnswered()) {
        revealCurrentQuestion();
        return;
      }

      if (seconds <= 0) {
        revealCurrentQuestion();
      }
      return;
    }

    if (state.room.phase === 'RESULTS') {
      autoAdvanceAfterResults();
    }
  }

  function allOnlineStudentsAnswered() {
    const onlineStudents = getOnlineStudents();
    if (!onlineStudents.length || !state.room) {
      return false;
    }

    const answers = state.answers[Number(state.room.questionIndex || 0)] || {};
    return onlineStudents.every(function(player) {
      return !!answers[player.uid];
    });
  }

  function getAnsweredOnlineCount() {
    if (!state.room) {
      return 0;
    }

    const answers = state.answers[Number(state.room.questionIndex || 0)] || {};
    return getOnlineStudents().filter(function(player) {
      return !!answers[player.uid];
    }).length;
  }

  async function autoAdvanceAfterResults() {
    if (state.autoAdvancing || !state.room || state.room.phase !== 'RESULTS') {
      return;
    }

    const result = state.results[Number(state.room.questionIndex || 0)];
    if (!result || !result.revealedAt) {
      return;
    }

    if (Date.now() - Number(result.revealedAt || 0) < AUTO_NEXT_RESULTS_MS) {
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
        console.warn('Presença do Desafio ignorada:', error);
      });
      cleanupDisconnectedStudents().catch(function(error) {
        console.warn('Limpeza de alunos desconectados ignorada:', error);
      });
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
      await withTimeout(
        update(ref(state.context.db), updates),
        SERVER_WRITE_TIMEOUT_MS,
        'Tempo limite ao limpar alunos desconectados.'
      );
    }
  }

  async function setOnline(online) {
    if (!state.context || !state.roomId || !state.uid) {
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

  async function leaveChallenge() {
    if (state.leaving) {
      return;
    }

    state.leaving = true;
    state.busy = true;
    if (window.UI && typeof UI.setLeaving === 'function') {
      UI.setLeaving(true);
    }
    resetChallengeLobbyScreen();
    UI.showView('home');
    setHomeBusy(true, null);
    UI.setConnection('idle', 'Saindo do desafio');
    stopListeners();
    stopHeartbeat();

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
    state.selectedQuestionIndex = null;
    state.leaving = false;
    state.busy = false;
    resetChallengeLobbyScreen();
    setHomeBusy(false);
    if (window.UI && typeof UI.setLeaving === 'function') {
      UI.setLeaving(false);
    }
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
    const questions = await FirebaseQuestions.load(CLASSROOM_CONFIG.totalQuestions);
    if (!questions.length) {
      throw new Error('Nenhuma pergunta encontrada no Firebase.');
    }
    return questions;
  }

  async function chooseServer() {
    const contexts = await getConfiguredContexts();
    const candidates = await Promise.all(contexts.map(async function(context) {
      cleanupServer(context).catch(function(error) {
        console.warn('Limpeza do Desafio ignorada:', error);
      });
      try {
        const roomsSnap = await withTimeout(
          get(ref(context.db, path('rooms'))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao contar desafios.'
        );
        const rooms = roomsSnap.val() || {};
        const activeCount = Object.keys(rooms).filter(function(roomId) {
          return rooms[roomId] && rooms[roomId].status !== 'FINISHED';
        }).length;
        return { context: context, activeCount: activeCount };
      } catch (error) {
        console.warn('Contagem de desafios ignorada:', getServerLabel(context.server), error);
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
      try {
        const codeSnap = await withTimeout(
          get(ref(context.db, path('codes', code))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao buscar código.'
        );
        if (codeSnap.exists()) {
          return {
            context: context,
            roomId: codeSnap.val().roomId
          };
        }
      } catch (error) {
        console.warn('Busca de desafio ignorou servidor:', getServerLabel(context.server), error);
      }
    }
    return null;
  }

  async function getConfiguredContexts() {
    const servers = (CLASSROOM_CONFIG.servers || []).filter(isServerConfigured);
    if (!servers.length) {
      throw new Error('Nenhum servidor Firebase foi configurado.');
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
          console.warn('Servidor do Desafio indisponível:', getServerLabel(server), error);
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

  function getSharedApp(server) {
    const appName = 'trilha-' + server.id;
    const existing = getApps().find(function(app) {
      return app.name === appName;
    });
    return existing || initializeApp(server.firebaseConfig, appName);
  }

  async function createUniqueCode(context) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = String(randomInt(10000, 99999));
      try {
        const snap = await withTimeout(
          get(ref(context.db, path('codes', code))),
          SERVER_READ_TIMEOUT_MS,
          'Tempo limite ao conferir código.'
        );
        if (!snap.exists()) {
          return code;
        }
      } catch (error) {
        return code;
      }
    }
    return String(randomInt(10000, 99999));
  }

  async function cleanupServer(context) {
    try {
      const roomsSnap = await withTimeout(
        get(ref(context.db, path('rooms'))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao ler desafios antigos.'
      );
      const rooms = roomsSnap.val() || {};
      const codesSnap = await withTimeout(
        get(ref(context.db, path('codes'))),
        SERVER_READ_TIMEOUT_MS,
        'Tempo limite ao ler códigos antigos.'
      );
      const codes = codesSnap.val() || {};
      const now = Date.now();
      const markUpdates = {};
      const dataDeleteUpdates = {};
      const roomDeleteUpdates = {};
      const finishedMs = minutesToMs(CLASSROOM_CONFIG.cleanupFinishedMinutes || 10);
      const lobbyMs = minutesToMs(CLASSROOM_CONFIG.cleanupIdleLobbyMinutes || 30);
      const runningMs = minutesToMs(CLASSROOM_CONFIG.cleanupRunningMinutes || 90);

      Object.keys(rooms).forEach(function(roomId) {
        const room = rooms[roomId];
        if (!room) {
          return;
        }

        const age = now - Number(room.updatedAt || room.createdAt || now);

        if (room.status === 'FINISHED' && age > finishedMs) {
          dataDeleteUpdates[path('participants', roomId)] = null;
          dataDeleteUpdates[path('questions', roomId)] = null;
          dataDeleteUpdates[path('secrets', roomId)] = null;
          dataDeleteUpdates[path('answers', roomId)] = null;
          dataDeleteUpdates[path('results', roomId)] = null;
          roomDeleteUpdates[path('rooms', roomId)] = null;
          if (room.code) {
            dataDeleteUpdates[path('codes', room.code)] = null;
          }
          return;
        }

        if (room.status === 'LOBBY' && age > lobbyMs) {
          markRoomAsFinished(markUpdates, roomId, room, now, 'Sala encerrada por inatividade.');
          return;
        }

        if (room.status === 'RUNNING' && age > runningMs) {
          markRoomAsFinished(markUpdates, roomId, room, now, 'Desafio encerrado por inatividade.');
        }
      });

      Object.keys(codes).forEach(function(code) {
        const roomId = codes[code] && codes[code].roomId;
        const room = roomId ? rooms[roomId] : null;
        if (!room || room.status === 'FINISHED') {
          dataDeleteUpdates[path('codes', code)] = null;
        }
      });

      if (Object.keys(markUpdates).length) {
        await withTimeout(
          update(ref(context.db), markUpdates),
          SERVER_WRITE_TIMEOUT_MS,
          'Tempo limite ao marcar desafios antigos.'
        );
      }

      if (Object.keys(dataDeleteUpdates).length) {
        await withTimeout(
          update(ref(context.db), dataDeleteUpdates),
          SERVER_WRITE_TIMEOUT_MS,
          'Tempo limite ao limpar dados antigos.'
        );
      }

      if (Object.keys(roomDeleteUpdates).length) {
        await withTimeout(
          update(ref(context.db), roomDeleteUpdates),
          SERVER_WRITE_TIMEOUT_MS,
          'Tempo limite ao apagar desafios antigos.'
        );
      }
    } catch (error) {
      console.warn('Limpeza do servidor ignorada:', error);
    }
  }

  function markRoomAsFinished(updates, roomId, room, now, reason) {
    updates[path('rooms', roomId, 'status')] = 'FINISHED';
    updates[path('rooms', roomId, 'phase')] = 'FINAL';
    updates[path('rooms', roomId, 'finishReason')] = reason;
    updates[path('rooms', roomId, 'updatedAt')] = now;
    updates[path('rooms', roomId, 'endedAt')] = now;
    if (room.code) {
      updates[path('codes', room.code)] = null;
    }
  }

  function minutesToMs(minutes) {
    return Number(minutes || 0) * 60 * 1000;
  }

  function getStudents() {
    return Object.keys(state.participants).map(function(uid) {
      return Object.assign({ uid: uid }, state.participants[uid]);
    }).filter(function(player) {
      return player.role === 'student' && !player.removed;
    });
  }

  function getOnlineStudents() {
    return getStudents().filter(function(player) {
      return player.online !== false;
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

  function getServerLabel(server) {
    return (server && (server.label || server.name || server.id)) || 'servidor Firebase';
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
    if (!state.room) {
      resetChallengeLobbyScreen();
    }
    UI.showView('challenge');
    UI.setConnection('ok', getChallengeStatusText());
  }

  function resetChallengeLobbyScreen() {
    const rankingPanel = byId('challengeRankingPanel');
    const teacherPanel = byId('challengeTeacherPanel');
    const questionStats = byId('challengeQuestionStats');
    const overallStats = byId('challengeOverallStats');
    const answeredBadge = byId('challengeAnsweredBadge');
    const revealButton = byId('challengeRevealBtn');
    const nextButton = byId('challengeNextBtn');
    const endButton = byId('challengeEndBtn');
    const startButton = byId('challengeStartBtn');
    const controlTitle = byId('challengeControlTitle');
    const rankingList = byId('challengeRankingList');
    const studentCount = byId('challengeStudentCount');
    const resultBox = byId('challengeResultBox');
    const waitingBox = byId('challengeStudentWaiting');
    const flowHint = byId('challengeFlowHint');
    const progress = byId('challengeProgress');
    const timer = byId('challengeTimer');
    const questionType = byId('challengeQuestionType');
    const questionText = byId('challengeQuestionText');
    const options = byId('challengeOptions');
    const submitButton = byId('challengeSubmitAnswerBtn');
    const participants = byId('challengeParticipantsList');

    if (rankingPanel) rankingPanel.hidden = true;
    if (teacherPanel) teacherPanel.hidden = !isTeacher();
    if (questionStats) questionStats.hidden = true;
    if (overallStats) overallStats.hidden = true;
    if (answeredBadge) answeredBadge.hidden = true;
    if (revealButton) revealButton.hidden = true;
    if (nextButton) nextButton.hidden = true;
    if (endButton) endButton.hidden = true;
    if (startButton) startButton.hidden = !isTeacher();
    if (controlTitle) controlTitle.textContent = 'Sala da turma';
    if (rankingList) rankingList.innerHTML = '';
    if (studentCount) studentCount.textContent = '0 alunos';
    if (resultBox) resultBox.hidden = true;
    if (waitingBox) waitingBox.hidden = true;
    if (flowHint) flowHint.textContent = 'Inicie quando os alunos entrarem na sala.';
    if (progress) progress.textContent = 'Pergunta 1/' + (CLASSROOM_CONFIG.totalQuestions || 10);
    if (timer) timer.textContent = '00:00';
    if (questionType) questionType.textContent = 'Quiz';
    if (questionText) questionText.textContent = isTeacher()
      ? 'Compartilhe o código e inicie quando a turma entrar.'
      : 'Aguardando o professor iniciar o desafio.';
    if (options) options.innerHTML = '';
    if (submitButton) {
      submitButton.hidden = true;
      submitButton.disabled = true;
    }
    if (participants) participants.innerHTML = '';
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

  function sanitizeFirebaseKey(value) {
    return String(value || '')
      .replace(/[.#$\[\]\/]/g, '_')
      .slice(0, 160);
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



