const Game = (function() {
  const PLAYER_COLORS = ['#e53935', '#1e88e5', '#f5a400', '#7b1fa2'];

  function isCreator(estado, playerId) {
    const players = estado && estado.jogadores ? estado.jogadores : [];
    return players.length > 0 && players[0].playerId === playerId;
  }

  function isMyTurn(estado, playerId) {
    return !!(estado &&
      estado.sala &&
      estado.sala.status === 'EM_ANDAMENTO' &&
      estado.jogadorDaVez &&
      estado.jogadorDaVez.playerId === playerId &&
      (!estado.voce || estado.voce.statusConexao === 'ONLINE') &&
      !estado.perguntaPendente);
  }

  function getMyPendingQuestion(estado, playerId) {
    if (!estado || !estado.perguntaPendente) {
      return null;
    }

    if (estado.perguntaPendente.playerId !== playerId) {
      return null;
    }

    return estado.perguntaPendente.pergunta ? estado.perguntaPendente : null;
  }

  function getPlayerColor(index) {
    return PLAYER_COLORS[index % PLAYER_COLORS.length];
  }

  function getInitials(name) {
    return String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(function(part) { return part.charAt(0).toUpperCase(); })
      .join('') || '?';
  }

  function getTokenLabel(player) {
    const name = player && player.nome ? player.nome : '?';
    return String(name).trim().charAt(0).toUpperCase() || '?';
  }

  function getTokenNumber(player) {
    return Number(player && player.ordem) + 1;
  }

  function isAdmin(estado, playerId) {
    const player = estado && estado.voce && estado.voce.playerId === playerId ? estado.voce : null;
    return !!(player && String(player.nome || '').trim().toLowerCase() === 'admin123');
  }

  function ranking(estado) {
    const players = estado && estado.jogadores ? estado.jogadores.slice() : [];
    return players.sort(function(a, b) {
      if (b.posicao !== a.posicao) {
        return b.posicao - a.posicao;
      }
      return a.ordem - b.ordem;
    });
  }

  function lastDice(estado) {
    if (estado && estado.ultimoDado && estado.ultimoDado.valor) {
      return estado.ultimoDado.valor;
    }

    const action = estado ? estado.ultimaAcao : null;
    return action && action.dado ? action.dado : '?';
  }

  return {
    PLAYER_COLORS,
    isCreator,
    isMyTurn,
    getMyPendingQuestion,
    getPlayerColor,
    getInitials,
    getTokenLabel,
    getTokenNumber,
    isAdmin,
    ranking,
    lastDice
  };
})();
