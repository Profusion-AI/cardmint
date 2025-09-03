// Simple banner showing API and WebSocket connection targets
(() => {
  try {
    const style = document.createElement('style');
    style.textContent = `
      .cm-banner { position: fixed; bottom: 8px; right: 8px; background: rgba(17,24,39,0.85); color: #e5e7eb; font: 12px/1.2 system-ui, sans-serif; padding: 6px 8px; border-radius: 6px; z-index: 99999; }
      .cm-banner b { color: #93c5fd; }
      .cm-banner .ok { color: #34d399; }
      .cm-banner .warn { color: #f59e0b; }
      .cm-banner .err { color: #f87171; }
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.className = 'cm-banner';
    el.textContent = 'CardMint: resolving...';
    document.body.appendChild(el);

    const apiCandidates = [];
    const loc = window.location;
    // Prefer same-origin API
    apiCandidates.push(`${loc.protocol}//${loc.hostname}${loc.port ? ':'+loc.port : ''}`);
    // Common dev API
    if (loc.port && loc.port.startsWith('517')) {
      apiCandidates.push(`${loc.protocol}//${loc.hostname}:3000`);
      apiCandidates.push(`${loc.protocol}//${loc.hostname}:3001`);
      apiCandidates.push(`${loc.protocol}//${loc.hostname}:3002`);
    }

    const wsProto = loc.protocol === 'https:' ? 'wss' : 'ws';
    const wsCandidates = [];
    // Use meta tag if present
    const metaWs = document.querySelector('meta[name="ws-url"]')?.getAttribute('content');
    if (metaWs) wsCandidates.push(metaWs);
    // Heuristics
    wsCandidates.push(`${wsProto}://${loc.hostname}:3001`);
    wsCandidates.push(`${wsProto}://${loc.hostname}:3002`);
    wsCandidates.push(`${wsProto}://${loc.hostname}:3003`);

    const tryFetch = async (url) => {
      try { const r = await fetch(url, { method: 'GET' }); return r.ok; } catch { return false; }
    };

    (async () => {
      // Resolve API
      let apiBase = null;
      for (const base of apiCandidates) {
        if (await tryFetch(`${base}/api/health`)) { apiBase = base; break; }
      }
      if (!apiBase) apiBase = apiCandidates[0];

      // Resolve WS
      let wsUrl = null;
      for (const w of wsCandidates) {
        try {
          const ws = new WebSocket(w);
          const done = new Promise((res) => {
            ws.onopen = () => { ws.close(); res(true); };
            ws.onerror = () => res(false); ws.onclose = () => {};
          });
          const ok = await Promise.race([done, new Promise(r => setTimeout(() => r(false), 600))]);
          if (ok) { wsUrl = w; break; }
        } catch {}
      }

      el.innerHTML = `API: <b>${apiBase}</b> • WS: <b>${wsUrl || 'auto'}</b>`;
    })();
  } catch {}
})();

