'use strict';
// Una nota aperta: lettore, riassunto a sinistra, testo a destra. Una frase cliccata porta l'audio a quel punto.
(async () => {
  const { api, sessione, el, pulsante, avvisa, conferma } = DG;
  const id = location.pathname.split('/')[2];
  const radice = document.getElementById('nota');
  const STATI = { attesa: 'In coda: il server la prende appena può', trascrizione: 'In sincronizzazione: trascrizione in corso', riassunto: 'In sincronizzazione: riassunto in corso' };
  const tempo = (s) => { const t = Math.round(s); const mm = String(Math.floor(t / 60) % 60); const ss = String(t % 60).padStart(2, '0'); return t >= 3600 ? `${Math.floor(t / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`; };
  const data = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  await sessione();

  // Una domanda con un campo di testo, nella stessa finestra delle conferme dell'app.
  function chiedi(titolo, iniziale = '') {
    return new Promise((fatto) => {
      const d = el('dialog', 'conferma');
      const campo = el('input', 'campo-dialogo'); campo.value = iniziale; campo.setAttribute('aria-label', titolo);
      const az = el('div', 'conferma-azioni');
      const chiudi = (v) => { d.close(); d.remove(); fatto(v); };
      az.append(pulsante('Annulla', () => chiudi(null)), pulsante('Conferma', () => chiudi(campo.value.trim()), 'pulsante principale-piccolo'));
      const forma = el('form');
      forma.method = 'dialog';
      forma.addEventListener('submit', (e) => { e.preventDefault(); chiudi(campo.value.trim()); });
      forma.append(el('h2', '', titolo), campo, az);
      d.append(forma);
      d.addEventListener('cancel', (e) => { e.preventDefault(); chiudi(null); });
      document.body.append(d);
      d.showModal();
      campo.select();
    });
  }
  // Titolo e categoria, come la Modifica dei video. Solo le categorie delle note.
  async function modifica(f) {
    const { categorie } = await api('/api/categorie');
    const d = el('dialog', 'conferma');
    const titolo = el('input', 'campo-dialogo');
    titolo.value = f.titolo; titolo.maxLength = 200; titolo.required = true; titolo.setAttribute('aria-label', 'Titolo');
    const scelta = el('select', 'campo-dialogo');
    scelta.setAttribute('aria-label', 'Categoria');
    const nessuna = el('option', '', 'Senza categoria'); nessuna.value = '';
    scelta.append(nessuna);
    for (const c of categorie.filter((x) => x.sezione === 'note')) {
      const o = el('option', '', c.nome); o.value = String(c.id);
      if (c.id === f.categoriaId) o.selected = true;
      scelta.append(o);
    }
    const az = el('div', 'conferma-azioni');
    const salva = el('button', 'pulsante principale-piccolo', 'Salva'); salva.type = 'submit';
    az.append(pulsante('Annulla', () => { d.close(); d.remove(); }), salva);
    const forma = el('form');
    forma.addEventListener('submit', async (e) => {
      e.preventDefault();
      salva.disabled = true;
      try { await api(`/api/file/${id}`, { method: 'PATCH', body: { titolo: titolo.value, categoriaId: scelta.value ? Number(scelta.value) : null } }); d.close(); d.remove(); disegna(); } catch (err) { salva.disabled = false; avvisa(err.message); }
    });
    forma.append(el('h2', '', 'Modifica'), titolo, scelta, az);
    d.append(forma);
    d.addEventListener('cancel', () => d.remove());
    document.body.append(d);
    d.showModal();
  }

  let audio;
  let attesa;

  function vai(secondi) {
    if (!audio) return;
    audio.currentTime = secondi;
    audio.play().catch(() => {});
  }

  function riassunto(n) {
    const box = el('div');
    box.append(el('h2', 'gr', 'Riassunto'));
    if (n.tipoIncontro) box.append(el('p', 'piccolo tipo-incontro', n.tipoIncontro));
    for (const s of n.riassunto) {
      const sez = el('section', 'sez');
      sez.append(el('h2', '', s.titolo));
      const ul = el('ul', 'elenco-semplice');
      for (const r of s.righe) {
        const li = el('li');
        const b = el('button', 'riga-riassunto', r.testo);
        b.type = 'button';
        b.addEventListener('click', () => vai(r.secondi || 0));
        li.append(b);
        ul.append(li);
      }
      sez.append(ul);
      box.append(sez);
    }
    return box;
  }

  function testo(n, ridisegna) {
    const box = el('div');
    box.append(el('h2', 'gr', 'Testo parola per parola'));
    const strumenti = el('div', 'azioni-nota');
    strumenti.append(
      pulsante('Cerca e sostituisci', async () => {
        const da = await chiedi('Cosa cerchi?');
        if (!da) return;
        const a = await chiedi(`Con cosa sostituisco «${da}»?`, da);
        if (a === null) return;
        try { const r = await api(`/api/note/${id}`, { method: 'PATCH', body: { sostituisci: { da, a } } }); avvisa(r.cambiate ? `Cambiate ${r.cambiate} frasi.` : 'Non l\'ho trovato.'); ridisegna(); } catch (err) { avvisa(err.message); }
      }, 'pulsante piccolo'),
      pulsante('Nomi di chi parla', async () => {
        for (const chi of [...new Set(n.segmenti.map((s) => s.chi))]) {
          const a = await chiedi(`Chi è «${chi}»?`, chi);
          if (a && a !== chi) await api(`/api/note/${id}`, { method: 'PATCH', body: { rinomina: { da: chi, a } } }).catch((err) => avvisa(err.message));
        }
        ridisegna();
      }, 'pulsante piccolo'),
    );
    box.append(strumenti);
    const riq = el('div', 'riq');
    n.segmenti.forEach((s, i) => {
      const f = el('div', 'frase');
      f.dataset.inizio = s.inizio;
      const testa = el('div', 'frase-testa');
      testa.append(el('b', '', s.chi), el('span', 'num', tempo(s.inizio)));
      testa.append(pulsante('Modifica', async (e) => {
        e.stopPropagation();
        const t = await chiedi('Correggi la frase', s.testo);
        if (!t || t === s.testo) return;
        try { await api(`/api/note/${id}`, { method: 'PATCH', body: { frase: { i, testo: t } } }); ridisegna(); } catch (err) { avvisa(err.message); }
      }, 'pulsante minuscolo'));
      f.append(testa, el('div', '', s.testo));
      if (s.traduzione) f.append(el('div', 'traduzione', s.traduzione));
      f.addEventListener('click', () => vai(s.inizio));
      riq.append(f);
    });
    box.append(riq);
    return box;
  }

  function evidenzia() {
    const t = audio?.currentTime ?? 0;
    const frasi = [...document.querySelectorAll('.frase')];
    let attiva = null;
    for (const f of frasi) if (Number(f.dataset.inizio) <= t) attiva = f;
    frasi.forEach((f) => f.classList.toggle('su', f === attiva));
  }

  async function disegna() {
    let d;
    try { d = await api(`/api/note/${id}`); } catch (err) { radice.replaceChildren(el('p', 'vuoto', err.message)); return; }
    const { file: f, nota: n } = d;
    document.title = `${f.titolo} · DiGiShare`;
    if (!radice.dataset.visto) { radice.dataset.visto = '1'; api(`/api/file/${id}/visto`, { method: 'POST', body: {} }).catch(() => {}); }
    const testa = el('div', 'visione-testa');
    const sinistra = el('div');
    sinistra.append(el('h1', '', f.titolo), el('p', '', `${data.format(f.caricatoIl)}${f.durata ? ` · ${tempo(f.durata)}` : ''}`));
    const az = el('div', 'azioni-nota');
    const salva = [...[['Word', 'docx'], ['Markdown', 'md'], ['Testo', 'txt'], ['Sottotitoli', 'srt']].map(([testo, x]) => ({ testo, href: `/api/note/${id}/esporta/${x}` })), { testo: 'PDF', azione: () => window.print() }];
    az.append(pulsante('Condividi', () => DGCondividi.apri({ tipo: 'file', id, titolo: f.titolo, copertina: '', salva }), 'pulsante piccolo principale-piccolo'));
    az.append(
      pulsante('Modifica', () => modifica(f).catch((err) => avvisa(err.message)), 'pulsante piccolo'),
      pulsante('Rinomina', async () => { const t = await chiedi('Titolo', f.titolo); if (!t) return; try { await api(`/api/file/${id}`, { method: 'PATCH', body: { titolo: t } }); disegna(); } catch (err) { avvisa(err.message); } }, 'pulsante piccolo'),
      pulsante('Elimina', async () => {
        if (!await conferma(`«${f.titolo}» va nel cestino: resta lì 30 giorni, poi si cancella da solo. Sparisce anche dall'app sul telefono.`, { titolo: 'Sposta nel cestino', ok: 'Sposta nel cestino', pericolo: true })) return;
        try { await api(`/api/file/${id}`, { method: 'DELETE' }); location.href = '/?sezione=note'; } catch (err) { avvisa(err.message); }
      }, 'pulsante piccolo'),
      pulsante('Rifai', async () => { if (!await conferma('Trascrizione e riassunto si rifanno da capo: le correzioni al testo si perdono.', { titolo: 'Rifare la nota?', ok: 'Rifai' })) return; await api(`/api/note/${id}/rifai`, { method: 'POST', body: {} }); disegna(); }, 'pulsante piccolo'),
    );
    testa.append(sinistra, az);

    if (!audio) {
      audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.className = 'lettore-audio';
      audio.src = `/api/file/${id}/audio`;
      audio.addEventListener('timeupdate', evidenzia);
      const salta = Number(new URLSearchParams(location.search).get('t'));
      if (salta) audio.addEventListener('loadedmetadata', () => { audio.currentTime = salta; }, { once: true });
    }
    const corpo = [testa, audio];
    if (STATI[n.stato]) {
      const b = el('div', 'barra-lavoro'); b.setAttribute('role', 'status');
      const scorre = el('span', 'barra-scorre'); scorre.append(el('i'));
      b.append(el('span', 'barra-testo', STATI[n.stato]), scorre);
      corpo.push(b);
      clearTimeout(attesa);
      attesa = setTimeout(disegna, 5000);
    } else if (n.stato === 'errore') {
      corpo.push(el('div', 'avviso', `Non riuscita: ${n.errore || 'errore sconosciuto'}. Riprova con «Rifai».`));
    }
    if (n.segmenti.length) {
      const due = el('div', n.riassunto.length ? 'due-col' : '');
      if (n.riassunto.length) due.append(riassunto(n));
      due.append(testo(n, disegna));
      corpo.push(due);
    } else if (n.stato === 'pronta') {
      corpo.push(el('p', 'vuoto', 'In questa registrazione non si sente parlare nessuno.'));
    }
    radice.replaceChildren(...corpo);
  }
  await disegna();
})();
