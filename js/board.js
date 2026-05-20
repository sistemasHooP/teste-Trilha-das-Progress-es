const Board = (function() {
  let lastPositions = {};

  const POSITIONS = [
    { x: 6, y: 88 },
    { x: 14, y: 88 },
    { x: 23, y: 88 },
    { x: 32, y: 88 },
    { x: 41, y: 88 },
    { x: 50, y: 88 },
    { x: 59, y: 88 },
    { x: 68, y: 88 },
    { x: 77, y: 88 },
    { x: 87, y: 85 },
    { x: 93, y: 76 },
    { x: 91, y: 62 },
    { x: 83, y: 53 },
    { x: 74, y: 49 },
    { x: 65, y: 49 },
    { x: 56, y: 49 },
    { x: 47, y: 49 },
    { x: 38, y: 49 },
    { x: 29, y: 49 },
    { x: 20, y: 49 },
    { x: 11, y: 46 },
    { x: 6, y: 35 },
    { x: 9, y: 21 },
    { x: 18, y: 14 },
    { x: 27, y: 14 },
    { x: 36, y: 14 },
    { x: 45, y: 14 },
    { x: 54, y: 14 },
    { x: 63, y: 14 },
    { x: 72, y: 14 },
    { x: 82, y: 14 }
  ];

  const SPECIALS = {
    8: { label: '-2', className: 'board-cell-node--red', title: 'Volte 2 casas', text: 'Quem cair aqui volta 2 casas automaticamente.' },
    13: { label: 'BONUS', className: 'board-cell-node--bonus', title: 'Desafio bÃ´nus', text: 'Quem acertar a pergunta avanÃ§a 1 casa extra. Se errar, permanece onde estava antes de rolar o dado.' },
    16: { label: 'TROCA', className: 'board-cell-node--bonus', title: 'Trocar pergunta', text: 'Quem cair aqui pode trocar a pergunta uma Ãºnica vez antes de responder. NÃ£o troca com outro jogador.' },
    19: { label: 'PAUSA', className: 'board-cell-node--skip', title: 'Fique uma rodada sem jogar', text: 'Quem cair aqui perde a prÃ³xima vez em que o turno chegar nele.' },
    22: { label: '-2', className: 'board-cell-node--red', title: 'Volte 2 casas', text: 'Quem cair aqui volta 2 casas automaticamente.' },
    26: { label: '+2', className: 'board-cell-node--yellow', title: 'Avance 2 casas', text: 'Quem acertar a pergunta desta casa avanÃ§a 2 casas automaticamente.' },
    29: { label: 'TROCA', className: 'board-cell-node--bonus', title: 'Trocar pergunta', text: 'Quem cair aqui pode trocar a pergunta uma Ãºnica vez antes de responder. NÃ£o troca com outro jogador.' },
    30: { label: 'FIM', className: 'board-cell-node--finish', title: 'Chegada', text: 'Para vencer, precisa tirar o nÃºmero exato no dado e acertar a pergunta da chegada.' }
  };

  function render(container, estado) {
    const players = estado && estado.jogadores ? estado.jogadores : [];
    const movedIds = getMovedIds(players, lastPositions);
    const path = buildPath();
    const cells = POSITIONS.map(function(position, index) {
      return renderCell(index, position, players, movedIds);
    }).join('');

    container.innerHTML = [
      '<div class="board-map-container">',
      '  <svg class="board-track-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">',
      '    <path d="' + path + '" class="track-line-bg"></path>',
      '    <path d="' + path + '" class="track-line-fg"></path>',
      '  </svg>',
      cells,
      '</div>'
    ].join('');

    lastPositions = players.reduce(function(map, player) {
      map[player.playerId] = Number(player.posicao);
      return map;
    }, {});
  }

  function buildPath() {
    return POSITIONS.map(function(position, index) {
      return (index === 0 ? 'M ' : 'L ') + position.x + ' ' + position.y;
    }).join(' ');
  }

  function renderCell(position, coords, players, movedIds) {
    const special = SPECIALS[position];
    const hasLanding = players.some(function(player) {
      return Number(player.posicao) === position && movedIds[player.playerId];
    });
    const classes = [getCellClass(position, special)];
    const label = special ? '<span class="cell-icon">' + escapeHtml(special.label) + '</span>' : '';

    if (hasLanding) {
      classes.push('board-cell-node--landed');
    }

    return [
      '<button class="' + classes.join(' ') + '" type="button" style="left:' + coords.x + '%; top:' + coords.y + '%;" data-position="' + position + '" aria-label="Casa ' + position + '">',
      '  <span class="cell-number">' + position + '</span>',
      label,
      '  <span class="cell-pins-container">' + renderPins(players, position, movedIds) + '</span>',
      '</button>'
    ].join('');
  }

  function getCellClass(position, special) {
    if (position === 0) {
      return 'board-cell-node board-cell-node--start';
    }

    if (special) {
      return 'board-cell-node ' + special.className;
    }

    if (position % 2 === 0) {
      return 'board-cell-node board-cell-node--dark';
    }

    return 'board-cell-node';
  }

  function renderPins(players, position, movedIds) {
    return players
      .filter(function(player) { return Number(player.posicao) === position; })
      .map(function(player) {
        const color = Game.getPlayerColor(player.ordem);
        const label = Game.getTokenLabel(player);
        const number = Game.getTokenNumber(player);
        const movedClass = movedIds[player.playerId] ? ' pin--moved' : '';

        return [
          '<span class="pin' + movedClass + '" title="' + escapeHtml(player.nome) + '" style="background:' + color + '">',
          '  <span class="pin-letter">' + escapeHtml(label) + '</span>',
          '  <span class="pin-number">' + number + '</span>',
          '</span>'
        ].join('');
      })
      .join('');
  }

  function getMovedIds(players, previousPositions) {
    return players.reduce(function(map, player) {
      const previous = previousPositions[player.playerId];
      const current = Number(player.posicao);
      if (typeof previous === 'number' && previous !== current) {
        map[player.playerId] = true;
      }
      return map;
    }, {});
  }

  function getHouseInfo(position) {
    const number = Number(position);
    const special = SPECIALS[number];

    if (special) {
      return {
        position: number,
        title: special.title,
        text: special.text,
        special: true
      };
    }

    if (number >= 1 && number < 30) {
      return {
        position: number,
        title: 'Casa comum',
        text: 'O jogador sÃ³ avanÃ§a para esta casa se acertar a pergunta. Se errar, permanece onde estava antes de rolar o dado.',
        special: false
      };
    }

    return {
      position: number,
      title: 'InÃ­cio',
      text: 'Todos comeÃ§am antes da casa 1.',
      special: false
    };
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
    render,
    getHouseInfo
  };
})();
