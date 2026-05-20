import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const FirebaseQuestions = (function() {
  const ROOT = 'gameQuestions';
  const LOCAL_QUESTIONS_URL = 'data/questions.json?v=20260517-questions1';
  const state = {
    contexts: null,
    cachedLocal: null
  };

  function isConfigured() {
    return getServers().length > 0;
  }

  async function load(limit) {
    const amount = Number(limit || 30);

    if (isConfigured()) {
      try {
        const firebaseQuestions = await loadFromFirebase(amount);
        if (firebaseQuestions.length) {
          return firebaseQuestions;
        }
      } catch (error) {
        console.warn('Banco de perguntas Firebase indisponivel:', error);
      }
    }

    return loadFromLocal(amount);
  }

  async function loadFromFirebase(limit) {
    const contexts = await getConfiguredContexts();

    for (const context of contexts) {
      const snapshot = await get(ref(context.db, ROOT + '/items'));
      const questions = normalizeCollection(snapshot.val());
      if (questions.length) {
        return pickQuestions(questions, limit);
      }
    }

    return [];
  }

  async function loadFromLocal(limit) {
    const questions = await getLocalQuestions();
    return pickQuestions(questions, limit);
  }

  async function importLocalToFirebase() {
    const questions = await getLocalQuestions();
    if (!questions.length) {
      throw new Error('Nenhuma pergunta encontrada em data/questions.json.');
    }

    const contexts = await getConfiguredContexts();
    const now = Date.now();
    const questionMap = {};
    const meta = {
      total: questions.length,
      version: '2026-05-17',
      updatedAt: now,
      updatedAtIso: new Date(now).toISOString()
    };

    questions.forEach(function(question) {
      questionMap[sanitizeId(question.perguntaId)] = question;
    });

    for (const context of contexts) {
      await set(ref(context.db, ROOT + '/items'), questionMap);
      await set(ref(context.db, ROOT + '/meta'), meta);
    }

    return {
      total: questions.length,
      servers: contexts.map(function(context) {
        return context.server.label || context.server.id;
      })
    };
  }

  async function getLocalQuestions() {
    if (state.cachedLocal) {
      return state.cachedLocal;
    }

    const response = await fetch(LOCAL_QUESTIONS_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Nao foi possivel carregar data/questions.json.');
    }

    const data = await response.json();
    state.cachedLocal = normalizeCollection(data.questions || []);
    return state.cachedLocal;
  }

  async function getConfiguredContexts() {
    if (state.contexts) {
      return state.contexts;
    }

    const servers = getServers();
    if (!servers.length) {
      throw new Error('Firebase nÃ£o configurado.');
    }

    const contexts = [];
    for (const server of servers) {
      const app = getSharedApp(server);
      const auth = getAuth(app);
      const user = auth.currentUser || (await signInAnonymously(auth)).user;
      contexts.push({
        server: server,
        app: app,
        auth: auth,
        uid: user.uid,
        db: getDatabase(app)
      });
    }

    state.contexts = contexts;
    return contexts;
  }

  function getSharedApp(server) {
    const appName = 'trilha-' + server.id;
    const existing = getApps().find(function(app) {
      return app.name === appName;
    });
    return existing || initializeApp(server.firebaseConfig, appName);
  }

  function getServers() {
    const config = window.CLASSROOM_CONFIG || {};
    const servers = Array.isArray(config.servers) ? config.servers : [];
    return servers.filter(function(server) {
      const firebaseConfig = server && server.firebaseConfig ? server.firebaseConfig : {};
      return !!(firebaseConfig.apiKey &&
        firebaseConfig.databaseURL &&
        firebaseConfig.projectId &&
        firebaseConfig.appId &&
        String(firebaseConfig.apiKey).indexOf('COLE_AQUI') === -1);
    });
  }

  function normalizeCollection(value) {
    const raw = Array.isArray(value) ? value : Object.keys(value || {}).map(function(key) {
      return value[key];
    });

    return raw.map(normalizeQuestion).filter(function(question) {
      return question && question.ativa !== false;
    });
  }

  function normalizeQuestion(question) {
    if (!question || !question.perguntaId) {
      return null;
    }

    const alternativas = question.alternativas || {};
    return {
      perguntaId: String(question.perguntaId),
      tipo: String(question.tipo || '').toUpperCase(),
      enunciado: String(question.enunciado || ''),
      alternativas: {
        A: String(alternativas.A || question.alternativaA || ''),
        B: String(alternativas.B || question.alternativaB || ''),
        C: String(alternativas.C || question.alternativaC || ''),
        D: String(alternativas.D || question.alternativaD || '')
      },
      correta: String(question.correta || '').trim().toUpperCase().charAt(0),
      explicacao: String(question.explicacao || ''),
      ativa: question.ativa !== false
    };
  }

  function pickQuestions(questions, limit) {
    const amount = Math.max(1, Math.min(Number(limit || 30), questions.length));
    return shuffle(questions.slice()).slice(0, amount);
  }

  function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = items[i];
      items[i] = items[j];
      items[j] = temp;
    }
    return items;
  }

  function sanitizeId(value) {
    return String(value || '')
      .replace(/[.#$\[\]\/]/g, '_')
      .slice(0, 120);
  }

  return {
    isConfigured,
    load,
    loadFromFirebase,
    loadFromLocal,
    importLocalToFirebase
  };
})();

window.FirebaseQuestions = FirebaseQuestions;

export { FirebaseQuestions };
