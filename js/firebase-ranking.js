import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  query,
  orderByChild,
  limitToFirst
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const FirebaseRanking = (function() {
  const ROOT = 'ranking/entries';
  const state = {
    contexts: {}
  };

  function isConfigured() {
    return getServer() !== null;
  }

  async function load(limit) {
    return loadMode(limit);
  }

  async function loadMode(limit, mode) {
    const contexts = await getConfiguredContexts();
    const requestedLimit = Math.max(1, Math.min(Number(limit || 5), 20));
    const normalizedMode = mode ? String(mode).toUpperCase() : '';
    let entries = [];

    for (const context of contexts) {
      entries = entries.concat(await loadEntries(context, 90));
    }

    return entries.filter(function(item) {
      return isRankableEntry(item) && (!normalizedMode || String(item.modo || '').toUpperCase() === normalizedMode);
    }).sort(function(a, b) {
      const sortDiff = getSortValue(a) - getSortValue(b);
      if (sortDiff !== 0) {
        return sortDiff;
      }
      return Number(a.createdAt || 0) - Number(b.createdAt || 0);
    }).slice(0, requestedLimit);
  }

  async function loadByCategories(limit) {
    const contexts = await getConfiguredContexts();
    const requestedLimit = Math.max(1, Math.min(Number(limit || 3), 10));
    const groups = {
      race: [],
      solo: [],
      classroom: [],
      mega: []
    };
    let entries = [];

    for (const context of contexts) {
      entries = entries.concat(await loadEntries(context, 120));
    }

    entries.filter(isRankableEntry).sort(function(a, b) {
      const sortDiff = getSortValue(a) - getSortValue(b);
      if (sortDiff !== 0) {
        return sortDiff;
      }
      return Number(a.createdAt || 0) - Number(b.createdAt || 0);
    }).forEach(function(item) {
      const key = getModeGroup(item.modo);
      if (groups[key] && groups[key].length < requestedLimit) {
        groups[key].push(item);
      }
    });

    return groups;
  }

  function isRankableEntry(item) {
    if (!item || item.concluiu !== true || String(item.nome || '').toLowerCase() === 'admin123') {
      return false;
    }

    if (getModeGroup(item.modo) === 'classroom' || getModeGroup(item.modo) === 'mega') {
      return Number(item.pontos || 0) > 0 || Number(item.acertos || 0) > 0;
    }

    return item.motivoEncerramento === 'VITORIA_PERGUNTA' &&
      Number(item.duracaoSegundos || 0) > 0;
  }

  async function loadAllUnsafe(limit) {
    const contexts = await getConfiguredContexts();
    let entries = [];
    for (const context of contexts) {
      entries = entries.concat(await loadEntries(context, Math.max(1, Math.min(Number(limit || 20), 60))));
    }

    return entries.sort(function(a, b) {
      const durationDiff = Number(a.duracaoSegundos || 999999) - Number(b.duracaoSegundos || 999999);
      if (durationDiff !== 0) {
        return durationDiff;
      }
      return Number(a.createdAt || 0) - Number(b.createdAt || 0);
    });
  }

  function getModeGroup(mode) {
    const normalized = String(mode || '').toUpperCase();
    if (normalized === 'SOLO') {
      return 'solo';
    }
    if (normalized === 'CLASSROOM' || normalized === 'DESAFIO') {
      return 'classroom';
    }
    if (normalized === 'MEGA') {
      return 'mega';
    }
    return 'race';
  }

  function getSortValue(item) {
    if (getModeGroup(item.modo) === 'classroom' || getModeGroup(item.modo) === 'mega') {
      return (999999 - Number(item.pontos || 0) * 1000) + Number(item.duracaoSegundos || 0) / 100000;
    }

    return Number(item.duracaoSegundos || 999999);
  }

  async function saveResult(estado) {
    if (!isRankableState(estado)) {
      return false;
    }

    const winner = estado.vencedor;
    const name = String(winner.nome || '').trim();
    if (!name || name.toLowerCase() === 'admin123') {
      return false;
    }

    const room = estado.sala;
    const context = await getContext(room.serverId || '');
    const mode = String(room.modo || 'MULTI').toUpperCase();
    const duration = Math.max(0, Number(room.tempoDecorridoSegundos || 0));
    const rankingId = sanitizeId([mode, room.salaId, winner.playerId].join('_'));
    const createdAt = Date.now();

    await set(ref(context.db, ROOT + '/' + rankingId), {
      rankingId: rankingId,
      uid: context.uid,
      salaId: room.salaId || '',
      codigoSala: room.codigoSala || '',
      playerId: winner.playerId || '',
      nome: name.slice(0, 40),
      modo: mode,
      duracaoSegundos: duration,
      motivoEncerramento: room.motivoEncerramento || '',
      concluiu: true,
      createdAt: createdAt,
      criadoEm: new Date(createdAt).toISOString(),
      origem: 'firebase-ranking-v1'
    });

    return true;
  }

  function isRankableState(estado) {
    if (!estado || !estado.sala || !estado.vencedor) {
      return false;
    }

    const room = estado.sala;
    return room.status === 'ENCERRADA' &&
      room.motivoEncerramento === 'VITORIA_PERGUNTA' &&
      Number(room.tempoDecorridoSegundos || 0) > 0;
  }

  async function loadEntries(context, maxItems) {
    const rankingQuery = query(
      ref(context.db, ROOT),
      orderByChild('duracaoSegundos'),
      limitToFirst(maxItems)
    );
    const snapshot = await get(rankingQuery);
    const value = snapshot.val() || {};
    return Object.keys(value).map(function(key) {
      return Object.assign({ rankingId: key, serverId: context.server.id }, value[key]);
    });
  }

  async function getContext(serverId) {
    const contexts = await getConfiguredContexts();
    if (!serverId) {
      return contexts[0];
    }
    return contexts.find(function(context) {
      return context.server.id === serverId;
    }) || contexts[0];
  }

  async function getConfiguredContexts() {
    const servers = getConfiguredServers();
    if (!servers.length) {
      throw new Error('Ranking Firebase não configurado.');
    }

    const contexts = [];
    for (const server of servers) {
      if (!state.contexts[server.id]) {
        const app = getSharedApp(server);
        const auth = getAuth(app);
        const user = auth.currentUser || (await signInAnonymously(auth)).user;
        state.contexts[server.id] = {
          server: server,
          app: app,
          auth: auth,
          uid: user.uid,
          db: getDatabase(app)
        };
      }
      contexts.push(state.contexts[server.id]);
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

  function getServer() {
    return getConfiguredServers()[0] || null;
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

  function sanitizeId(value) {
    return String(value || '')
      .replace(/[.#$\[\]\/]/g, '_')
      .slice(0, 160);
  }

  return {
    isConfigured,
    load,
    loadMode,
    loadByCategories,
    loadAllUnsafe,
    saveResult
  };
})();

window.FirebaseRanking = FirebaseRanking;
