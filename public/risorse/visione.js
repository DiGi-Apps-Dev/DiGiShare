'use strict';
// Pagina di chi riceve il link: video nel browser, titolo, descrizione, capitoli, sottotitoli, Scarica solo se
// permesso (con «no» niente pulsante e niente tasto destro; chi è esperto può comunque salvarlo, l'utente lo sa).
(async () => {
  const codice = location.pathname.split('/')[2];
  const radice = document.getElementById('visione');
  const numero = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
  const data = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  const el = (tag, classe, testo) => { const e = document.createElement(tag); if (classe) e.className = classe; if (testo !== undefined) e.textContent = testo; return e; };
  const peso = (b) => (b >= 1e9 ? `${numero.format(b / 1e9)} GB` : b >= 1e6 ? `${numero.format(b / 1e6)} MB` : `${numero.format(b / 1e3)} KB`);
  const tempo = (s) => { const t = Math.round(s); const mm = String(Math.floor(t / 60) % 60); const ss = String(t % 60).padStart(2, '0'); return t >= 3600 ? `${Math.floor(t / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`; };
  // Una visita = questa apertura della pagina: serve solo a contare quanto si è guardato.
  const visita = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now())).slice(0, 32);

  const fermo = (titolo, testo) => {
    radice.replaceChildren(el('div', 'scheda-accesso scheda-fermo'));
    const s = radice.firstChild;
    const img = el('img', 'logo-grande'); img.src = '/logo/completo.svg?v=5'; img.alt = ''; img.width = 104; img.height = 104;
    s.append(img, el('h1', '', titolo), el('p', '', testo));
  };

  let dati;
  try {
    const r = await fetch(`/v/${encodeURIComponent(codice)}/dati?visita=${visita}`);
    dati = await r.json().catch(() => ({}));
    if (!r.ok) {
      const testi = { scaduto: ['Link scaduto', 'Questo link non è più valido. Chiedi a chi te l\'ha mandato di crearne uno nuovo.'], revocato: ['Link ritirato', 'Chi aveva condiviso questo contenuto lo ha ritirato.'], rimosso: ['Contenuto non disponibile', 'Il file non c\'è più.'] };
      const [t, s] = testi[dati.stato] || ['Link non valido', 'Controlla di aver copiato tutto l\'indirizzo.'];
      return fermo(t, s);
    }
  } catch {
    return fermo('Il server non risponde', 'Riprova fra qualche minuto.');
  }

  const prefisso = (f) => `/v/${encodeURIComponent(codice)}/f/${f.id}`;
  let segnala = null;
  function lettore(f) {
    if (f.audio) {
      const a = document.createElement('audio');
      a.controls = true; a.preload = 'metadata'; a.className = 'lettore-audio'; a.src = `${prefisso(f)}/audio`;
      if (!dati.scarica) { a.setAttribute('controlsList', 'nodownload'); a.addEventListener('contextmenu', (e) => e.preventDefault()); }
      return { box: a, video: a };
    }
    const box = el('div', 'lettore');
    if (!f.video) {
      const s = el('div', 'solo-file');
      s.append(el('p', 'trascina-titolo', f.titolo), el('p', 'piccolo', `${peso(f.dimensione)} · ${f.tipo}`));
      if (dati.scarica) { const a = el('a', 'pulsante principale', 'Scarica'); a.href = `${prefisso(f)}/scarica`; s.append(a); } else s.append(el('p', '', 'Per questo file lo scaricamento non è permesso.'));
      box.append(s);
      return box;
    }
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'metadata';
    if (f.copertina) v.poster = `${prefisso(f)}/copertina`;
    if (!dati.scarica) { v.setAttribute('controlsList', 'nodownload'); v.addEventListener('contextmenu', (e) => e.preventDefault()); }
    const sorgente = document.createElement('source'); sorgente.src = `${prefisso(f)}/video`; sorgente.type = 'video/mp4'; v.append(sorgente);
    if (f.sottotitoli) { const t = document.createElement('track'); t.kind = 'subtitles'; t.srclang = 'it'; t.label = 'Italiano'; t.src = `${prefisso(f)}/sottotitoli.vtt`; v.append(t); }
    box.append(v);
    // Quanto è stato visto: il massimo raggiunto, mandato ogni 15 s e all'uscita.
    let massimo = 0; let ultimoInvio = 0;
    const invia = (forza) => {
      if (!massimo || (!forza && Date.now() - ultimoInvio < 15000)) return;
      ultimoInvio = Date.now();
      const corpo = JSON.stringify({ visita, secondi: Math.round(massimo), file: f.id });
      if (forza && navigator.sendBeacon) navigator.sendBeacon(`/v/${encodeURIComponent(codice)}/visto`, new Blob([corpo], { type: 'application/json' }));
      else fetch(`/v/${encodeURIComponent(codice)}/visto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo, keepalive: true }).catch(() => {});
    };
    v.addEventListener('timeupdate', () => { massimo = Math.max(massimo, v.currentTime); invia(false); });
    v.addEventListener('pause', () => invia(true));
    segnala = () => invia(true);
    return { box, video: v };
  }

  function dettaglio(f, contenitore) {
    const r = lettore(f);
    const box = r.box || r; const video = r.video;
    const testa = el('div', 'visione-testa');
    const sinistra = el('div');
    sinistra.append(el('h1', '', f.titolo), el('p', 'piccolo', `${f.durata ? `${tempo(f.durata)} · ` : ''}${peso(f.dimensione)} · condiviso il ${data.format(f.caricatoIl)}`));
    testa.append(sinistra);
    if (dati.scarica && (f.video || f.audio)) { const a = el('a', 'pulsante', `↓ Scarica (${peso(f.dimensione)})`); a.href = `${prefisso(f)}/scarica`; testa.append(a); }
    contenitore.replaceChildren(box, testa);
    if (f.descrizione) contenitore.append(el('p', 'descrizione', f.descrizione));
    if (f.video && f.capitoli?.length && video) {
      const sez = el('section', 'capitoli');
      sez.append(el('h2', '', 'Capitoli'));
      const ol = el('ol');
      for (const c of f.capitoli) {
        const li = el('li');
        const b = el('button', 'capitolo'); b.type = 'button';
        b.append(el('span', 'num', tempo(c.secondi)), el('span', '', c.titolo));
        b.addEventListener('click', () => { video.currentTime = c.secondi; video.play().catch(() => {}); window.scrollTo({ top: 0, behavior: 'smooth' }); });
        li.append(b); ol.append(li);
      }
      sez.append(ol); contenitore.append(sez);
    }
    if (f.nota) {
      for (const s of f.nota.riassunto) {
        const sez = el('section', 'sez');
        sez.append(el('h2', '', s.titolo));
        const ul = el('ul', 'elenco-semplice');
        for (const r of s.righe) { const li = el('li'); const b = el('button', 'riga-riassunto', r.testo); b.type = 'button'; b.addEventListener('click', () => { video.currentTime = r.secondi || 0; video.play().catch(() => {}); }); li.append(b); ul.append(li); }
        sez.append(ul); contenitore.append(sez);
      }
      if (f.nota.segmenti.length) {
        const t = el('section', 'sez');
        t.append(el('h2', '', 'Testo'));
        const riq = el('div', 'riq');
        for (const s of f.nota.segmenti) {
          const x = el('div', 'frase');
          const testa = el('div', 'frase-testa');
          testa.append(el('b', '', s.chi), el('span', 'num', tempo(s.inizio)));
          x.append(testa, el('div', '', s.testo));
          x.addEventListener('click', () => { video.currentTime = s.inizio; video.play().catch(() => {}); });
          riq.append(x);
        }
        t.append(riq); contenitore.append(t);
      }
    }
    if (f.video && !f.pronto) contenitore.append(el('p', 'piccolo', 'Il video è ancora in preparazione: si vede già, ma può partire più lentamente.'));
  }

  radice.replaceChildren();
  if (dati.tipo === 'file') {
    document.title = `${dati.file.titolo} · DiGiShare`;
    dettaglio(dati.file, radice);
  } else {
    document.title = `${dati.nome} · DiGiShare`;
    radice.classList.add('cartella');
    const corrente = el('div', 'visione-corrente');
    const elenco = el('aside', 'visione-elenco');
    elenco.append(el('h2', '', dati.nome));
    if (!dati.file.length) elenco.append(el('p', 'piccolo', 'La cartella è vuota.'));
    const voci = [];
    for (const f of dati.file) {
      const b = el('button', 'voce-video'); b.type = 'button';
      const cop = el('div', 'copertina');
      if (f.copertina) { const img = document.createElement('img'); img.src = `${prefisso(f)}/copertina`; img.alt = ''; img.loading = 'lazy'; cop.append(img); }
      if (f.durata) cop.append(el('em', '', tempo(f.durata)));
      b.append(cop, el('span', 'nome', f.titolo));
      b.addEventListener('click', () => { if (segnala) segnala(); voci.forEach((x) => x.classList.remove('attiva')); b.classList.add('attiva'); dettaglio(f, corrente); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      voci.push(b); elenco.append(b);
    }
    radice.append(corrente, elenco);
    if (dati.file.length) { voci[0].classList.add('attiva'); dettaglio(dati.file[0], corrente); }
  }
  window.addEventListener('pagehide', () => { if (segnala) segnala(); });
})();
