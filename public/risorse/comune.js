'use strict';
// Pezzi comuni alle pagine: chiamate al server con il token anti-CSRF, numeri e date in italiano.
window.DG = (() => {
  const numero = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const dataOra = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  let csrf = '';

  async function api(indirizzo, opzioni = {}) {
    const intestazioni = { ...(opzioni.headers || {}) };
    if (csrf) intestazioni['x-csrf-token'] = csrf;
    let corpo = opzioni.body;
    if (corpo !== undefined && !(corpo instanceof Blob) && typeof corpo !== 'string') {
      intestazioni['content-type'] = 'application/json';
      corpo = JSON.stringify(corpo);
    }
    const r = await fetch(indirizzo, { ...opzioni, headers: intestazioni, body: corpo, credentials: 'same-origin' });
    if (r.status === 401) {
      location.replace('/accesso');
      throw new Error('Accedi per continuare.');
    }
    const testo = await r.text();
    let dati = {};
    try { dati = testo ? JSON.parse(testo) : {}; } catch { dati = { error: testo }; }
    if (!r.ok) throw new Error(dati.error || `Errore ${r.status}`);
    return dati;
  }

  async function sessione() {
    const io = await api('/api/auth/me');
    csrf = io.csrf;
    return io;
  }

  function peso(byte) {
    if (byte >= 1e9) return `${numero.format(byte / 1e9)} GB`;
    if (byte >= 1e6) return `${numero.format(byte / 1e6)} MB`;
    if (byte >= 1e3) return `${numero.format(byte / 1e3)} KB`;
    return `${byte} byte`;
  }

  function el(tag, classe, testo) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (testo !== undefined) e.textContent = testo;
    return e;
  }

  function pulsante(testo, azione, classe = 'pulsante') {
    const b = el('button', classe, testo);
    b.type = 'button';
    b.addEventListener('click', azione);
    return b;
  }

  function avviso(contenitore, testo, tipo = 'errore') {
    contenitore.replaceChildren();
    if (!testo) return;
    const p = el('p', `avviso ${tipo}`, testo);
    p.setAttribute('role', tipo === 'errore' ? 'alert' : 'status');
    contenitore.append(p);
  }

  // Finestre di conferma e di avviso con la grafica dell'app, al posto di quelle di Windows.
  function finestra({ titolo, testo, ok = 'Ok', annulla = 'Annulla', pericolo = false, soloAvviso = false }) {
    return new Promise((risolvi) => {
      const d = document.createElement('dialog');
      d.className = 'conferma';
      const t = el('h2', '', titolo);
      const p = el('p', '', testo);
      const azioni = el('div', 'conferma-azioni');
      const chiudi = (esito) => { d.close(); d.remove(); risolvi(esito); };
      const bOk = pulsante(ok, () => chiudi(true), `pulsante conferma-ok${pericolo ? ' pericolo' : ' principale-piccolo'}`);
      if (!soloAvviso) azioni.append(pulsante(annulla, () => chiudi(false), 'pulsante conferma-annulla'));
      azioni.append(bOk);
      d.append(t, p, azioni);
      d.addEventListener('cancel', (e) => { e.preventDefault(); chiudi(false); });
      d.addEventListener('click', (e) => { if (e.target === d) chiudi(false); });
      document.body.append(d);
      d.showModal();
      (soloAvviso ? bOk : azioni.firstChild).focus();
    });
  }
  const conferma = (testo, opzioni = {}) => finestra({ titolo: opzioni.titolo || 'Confermi?', testo, ok: opzioni.ok || 'Sì', annulla: opzioni.annulla || 'Annulla', pericolo: Boolean(opzioni.pericolo) });
  const avvisa = (testo, titolo = 'Attenzione') => finestra({ titolo, testo, ok: 'Ok', soloAvviso: true });

  async function esci() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* si esce comunque */ }
    location.replace('/accesso');
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  return { api, sessione, peso, el, pulsante, avviso, conferma, avvisa, esci, quando: (t) => dataOra.format(typeof t === 'string' ? new Date(t) : t), csrf: () => csrf };
})();
