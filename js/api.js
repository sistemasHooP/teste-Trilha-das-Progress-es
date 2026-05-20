const ApiClient = (function() {
  function isConfigured() {
    return CONFIG.API_URL &&
      CONFIG.API_URL.indexOf('COLE_AQUI') === -1 &&
      /^https?:\/\//.test(CONFIG.API_URL);
  }

  async function request(action, payload) {
    if (!isConfigured()) {
      throw new Error('Cole a URL do Web App do Google Apps Script em js/config.js.');
    }

    const body = Object.assign({}, payload || {}, { action });
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(CONFIG.API_URL, {
        method: 'POST',
        redirect: 'follow',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error('O backend nÃ£o retornou JSON vÃ¡lido.');
      }

      if (response.ok && data.success) {
        return data;
      }

      const message = data.error || 'Erro na comunicaÃ§Ã£o com o backend.';
      if (attempt < maxAttempts && /ocupado|bloqueio|lock|processando/i.test(message)) {
        await wait(450 * attempt);
        continue;
      }

      throw new Error(message);
    }

    throw new Error('Erro na comunicaÃ§Ã£o com o backend.');
  }

  function wait(ms) {
    return new Promise(function(resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  return {
    isConfigured,
    request
  };
})();

window.ApiClient = ApiClient;
