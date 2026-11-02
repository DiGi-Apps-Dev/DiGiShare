'use strict';
(async () => {
  const { api, sessione, peso, el: elemento, pulsante, quando, esci, conferma, avvisa } = DG;
  const PEZZO = 50 * 1000 * 1000;
  const ENDPOINT = `${location.origin}/api/caricamenti`;
  // Riprova per circa 2 ore prima di fermarsi; il conteggio riparte ogni volta che qualcosa arriva.
  const ATTESE = [0, 1000, 3000, 5000, 10000, 20000, ...Array(240).fill(30000)];
  const $ = (id) => document.getElementById(id);

  const coda = [];
  let fileCaricati = [];
  let fileCestino = [];
  let sospesi = [];
  let attesaCopertine;
  let nelCestino = false;
  let categorie = [];
  let categoriaAperta = null;
  let iaAttiva = false;
  let categoriaTrascinata = null;
  let saltaClic = false;
  let ordineCategorie = 'manuale';
  // null = tutti i file; un numero = quella categoria; 'cestino' = il cestino.
  let scelta = null;
  // Video e Note sono due sezioni separate: stesse schede per i video, un elenco semplice per le note.
  let sezione = new URLSearchParams(location.search).get('sezione') === 'note' ? 'note' : 'video';
  const diSezione = (f) => (f.tipo.startsWith('audio/') ? 'note' : 'video') === sezione;

  const io = await sessione();
  $('esci').addEventListener('click', esci);

  function durata(secondi) {
    if (!Number.isFinite(secondi)) return '';
    const s = Math.ceil(secondi);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
    return `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
  }

  function tempo(secondi) {
    const s = Math.round(secondi);
    const mm = String(Math.floor(s / 60) % 60);
    const ss = String(s % 60).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  const ICONA_PLAY = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
  const ICONA_DOC = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M6 2.5h8l4.5 4.5v14.5H6z"/><path d="M14 2.5V7h4.5"/></svg>';

  // Cosa sta facendo il server su un video appena caricato: l'utente deve vederlo, non indovinarlo (31.10.2026).
  function barraLavoro(f) {
    if (!f.tipo.startsWith('video/') || f.cestinatoIl) return null;
    const testo = f.visione === 0 ? 'In preparazione: controllo del video'
      : iaAttiva && f.ia === 0 ? 'In preparazione: sottotitoli, capitoli e riassunto' : null;
    if (testo) {
      const b = elemento('div', 'barra-lavoro');
      b.setAttribute('role', 'status');
      const scorre = elemento('span', 'barra-scorre');
      scorre.append(elemento('i'));
      b.append(elemento('span', 'barra-testo', testo), scorre);
      return b;
    }
    return f.ia === -1 ? elemento('div', 'barra-lavoro non-riuscita', 'Sottotitoli e riassunto non riusciti: riprova da «Modifica»') : null;
  }

  function copertina(f) {
    const c = elemento('div', 'copertina');
    const video = f.tipo.startsWith('video/');
    if (f.miniatura === 1) {
      const img = document.createElement('img');
      img.src = `/api/file/${f.id}/miniatura`;
      img.alt = '';
      img.loading = 'lazy';
      c.append(img);
    } else {
      c.innerHTML = video ? ICONA_PLAY : ICONA_DOC;
    }
    if (f.durata) c.append(elemento('em', '', tempo(f.durata)));
    return c;
  }

  // ---- elenco dei file e cestino ----

  const nomeCategoria = (id) => categorie.find((c) => c.id === id)?.nome ?? '';

  // «2 link attivi», «Link scaduto», «Nessun link», come nell'anteprima.
  function etichettaLink(f) {
    const l = f.link || { attivi: 0, scaduti: 0, aperture: 0 };
    const e = elemento('span', 'chip');
    if (l.attivi) { e.classList.add('buono'); e.textContent = `${l.attivi} link ${l.attivi === 1 ? 'attivo' : 'attivi'}${l.aperture ? ` · ${l.aperture} ${l.aperture === 1 ? 'apertura' : 'aperture'}` : ''}`; }
    else if (l.scaduti) { e.classList.add('attenzione'); e.textContent = l.scaduti === 1 ? 'Link scaduto' : `${l.scaduti} link scaduti`; }
    else { e.classList.add('nessuno'); e.textContent = 'Nessun link'; }
    return e;
  }

  // Guardare il proprio video dal pannello, dentro la scheda.
  // Passando col mouse su un video, dopo mezzo secondo parte muto nella copertina; uscendo si ferma.
  const conMouse = window.matchMedia('(hover: hover) and (pointer: fine)');
  const menoMovimento = window.matchMedia('(prefers-reduced-motion: reduce)');
  function anteprimaAlPassaggio(scheda, c, f) {
    if (!f.tipo.startsWith('video/') || nelCestino) return;
    let attesa = null;
    let v = null;
    const ferma = () => {
      clearTimeout(attesa);
      if (!v) return;
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      v = null;
    };
    scheda.addEventListener('mouseenter', () => {
      if (!conMouse.matches || menoMovimento.matches) return;
      attesa = setTimeout(() => {
        if (!c.isConnected || v) return;
        v = document.createElement('video');
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.className = 'anteprima-passaggio';
        v.src = `/api/file/${f.id}/video`;
        v.addEventListener('playing', () => v?.classList.add('visibile'), { once: true });
        v.addEventListener('error', ferma, { once: true });
        c.insertBefore(v, c.querySelector('em'));
        v.play().catch(() => {});
      }, 500);
    });
    scheda.addEventListener('mouseleave', ferma);
    scheda.addEventListener('ferma-anteprima', ferma);
  }

  function guarda(f, scheda) {
    scheda.dispatchEvent(new Event('ferma-anteprima'));
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true; v.className = 'anteprima-video';
    if (f.miniatura === 1) v.poster = `/api/file/${f.id}/miniatura`;
    const s = document.createElement('source'); s.src = `/api/file/${f.id}/video`; s.type = 'video/mp4'; v.append(s);
    if (f.sottotitoli === 1) { const t = document.createElement('track'); t.kind = 'subtitles'; t.srclang = 'it'; t.label = 'Italiano'; t.src = `/api/file/${f.id}/sottotitoli.vtt`; v.append(t); }
    const chiudi = pulsante('Chiudi', () => disegnaFile(), 'pulsante piccolo');
    const righe = elemento('div', 'azioni-scheda'); righe.append(chiudi);
    scheda.classList.add('in-visione');
    scheda.replaceChildren(v, elemento('div', 'nome', f.titolo), riassuntoVideo(f), capitoliVideo(f, v), righe);
  }

  // I capitoli con i minuti, come nella pagina del link: un clic porta il video a quel punto.
  function capitoliVideo(f, video) {
    const sez = elemento('section', 'capitoli');
    if (!f.capitoli?.length) return sez;
    const ol = elemento('ol');
    for (const c of f.capitoli) {
      const li = elemento('li');
      const mostra = () => {
        const b = pulsante('', () => { video.currentTime = c.secondi; video.play().catch(() => {}); video.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 'capitolo');
        b.append(elemento('span', 'num', tempo(c.secondi)), elemento('span', '', c.titolo));
        const matita = pulsante('', correggi, 'pulsante minuscolo tasto-voce');
        matita.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19l-4 1zM14 7l3 3"/></svg>';
        matita.title = 'Correggi il titolo';
        matita.setAttribute('aria-label', `Correggi il titolo del capitolo ${c.titolo}`);
        li.replaceChildren(b, matita);
      };
      const correggi = () => {
        const form = elemento('form', 'rinomina');
        const input = elemento('input');
        input.value = c.titolo;
        input.maxLength = 120;
        input.required = true;
        input.setAttribute('aria-label', 'Titolo del capitolo');
        const salva = elemento('button', 'pulsante minuscolo', 'Salva');
        salva.type = 'submit';
        form.append(input, salva, pulsante('Annulla', mostra, 'pulsante minuscolo'));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const r = await api(`/api/file/${f.id}`, { method: 'PATCH', body: { titoliCapitoli: f.capitoli.map((x) => (x === c ? input.value : x.titolo)) } });
            c.titolo = r.file.capitoli[f.capitoli.indexOf(c)].titolo;
            mostra();
          } catch (err) { avvisa(err.message); }
        });
        li.replaceChildren(form);
        input.focus();
        input.select();
      };
      mostra();
      ol.append(li);
    }
    sez.append(elemento('h2', '', 'Capitoli'), ol);
    return sez;
  }

  // Il riassunto che vede chi riceve il link: l'utente lo legge qui e lo corregge senza fermare il video (31.10.2026).
  function riassuntoVideo(f) {
    const box = elemento('section', 'riassunto');
    const mostra = () => {
      box.replaceChildren(elemento('h2', '', 'Riassunto'), elemento('p', 'descrizione', f.descrizione || (iaAttiva && f.ia === 0 ? 'In preparazione: compare appena è pronto, ricarica la pagina fra un po\'.' : 'Nessun riassunto per ora.')), pulsante('Correggi', correggi, 'pulsante piccolo'));
    };
    const correggi = () => {
      const form = elemento('form', 'modifica-file');
      const testo = elemento('textarea');
      testo.value = f.descrizione || '';
      testo.rows = 5;
      testo.maxLength = 2000;
      testo.setAttribute('aria-label', 'Riassunto');
      const salva = elemento('button', 'pulsante piccolo principale-piccolo', 'Salva');
      salva.type = 'submit';
      const righe = elemento('div', 'azioni-scheda');
      righe.append(salva, pulsante('Annulla', mostra, 'pulsante piccolo'));
      form.append(testo, righe);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api(`/api/file/${f.id}`, { method: 'PATCH', body: { descrizione: testo.value } });
          f.descrizione = r.file.descrizione;
          const nellElenco = fileCaricati.find((x) => x.id === f.id);
          if (nellElenco) nellElenco.descrizione = r.file.descrizione;
          mostra();
        } catch (err) { avvisa(err.message); }
      });
      box.replaceChildren(elemento('h2', '', 'Riassunto'), form);
      testo.focus();
    };
    mostra();
    return box;
  }

  function moduloModifica(f, scheda) {
    scheda.dispatchEvent(new Event('ferma-anteprima'));
    const form = elemento('form', 'modifica-file');
    const titolo = elemento('input');
    titolo.value = f.titolo;
    titolo.maxLength = 200;
    titolo.required = true;
    titolo.setAttribute('aria-label', 'Titolo');
    const categoria = elemento('select');
    categoria.setAttribute('aria-label', 'Categoria');
    const nessuna = elemento('option', '', 'Senza categoria');
    nessuna.value = '';
    categoria.append(nessuna);
    for (const c of categorie) {
      const o = elemento('option', '', c.nome);
      o.value = String(c.id);
      if (c.id === f.categoriaId) o.selected = true;
      categoria.append(o);
    }
    const descrizione = elemento('textarea');
    descrizione.value = f.descrizione || '';
    descrizione.rows = 3;
    descrizione.maxLength = 2000;
    descrizione.placeholder = 'Descrizione (la vede chi riceve il link)';
    descrizione.setAttribute('aria-label', 'Descrizione');
    const righe = elemento('div', 'azioni-scheda');
    const salva = elemento('button', 'pulsante piccolo', 'Salva');
    salva.type = 'submit';
    righe.append(salva, pulsante('Annulla', () => disegnaFile(), 'pulsante piccolo'));
    if (io.ia && f.tipo.startsWith('video/')) righe.append(pulsante('Rifai sottotitoli e capitoli', async (e) => { e.target.disabled = true; try { await api(`/api/file/${f.id}/ia`, { method: 'POST', body: {} }); e.target.textContent = 'In lavorazione…'; } catch (err) { avvisa(err.message); e.target.disabled = false; } }, 'pulsante piccolo'));
    form.append(titolo, categoria, descrizione, righe);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      salva.disabled = true;
      try {
        await api(`/api/file/${f.id}`, { method: 'PATCH', body: { titolo: titolo.value, categoriaId: categoria.value ? Number(categoria.value) : null, descrizione: descrizione.value } });
        await aggiornaTutto();
      } catch (err) {
        salva.disabled = false;
        avvisa(err.message);
      }
    });
    scheda.replaceChildren(copertina(f), form);
    titolo.focus();
    titolo.select();
  }

  const STATO_NOTA = { attesa: ['In sincronizzazione', 'attenzione'], trascrizione: ['In sincronizzazione', 'attenzione'], riassunto: ['In sincronizzazione', 'attenzione'], pronta: ['Pronta', 'buono'], errore: ['Non riuscita', 'attenzione'] };
  function rigaNota(f) {
    const a = elemento('a', `riga-nota${!f.vistoIl && f.nota?.stato === 'pronta' ? ' nuova' : ''}`);
    a.href = `/nota/${f.id}`;
    const icona = elemento('span', 'tile');
    icona.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/></svg>';
    const mezzo = elemento('div', 'mezzo');
    const dati = elemento('div', 'dati');
    dati.append(elemento('span', 'data', quando(f.caricatoIl)));
    if (f.durata) dati.append(elemento('span', 'durata', tempo(f.durata)));
    if (f.nota?.genere === 'idea') dati.append(elemento('span', 'genere', 'Nota vocale'));
    if (scelta === null && f.categoriaId) dati.append(elemento('span', 'categoria', nomeCategoria(f.categoriaId)));
    mezzo.append(elemento('div', 'nome', f.titolo), dati);
    const [testo, classe] = STATO_NOTA[f.nota?.stato] ?? ['Audio', 'nessuno'];
    a.append(icona, mezzo, elemento('span', `chip ${classe}`, testo));
    return a;
  }

  function disegnaSezioni(novita) {
    $('sezione-video').setAttribute('aria-pressed', String(sezione === 'video'));
    $('sezione-note').setAttribute('aria-pressed', String(sezione === 'note'));
    if (!novita) return;
    for (const [id, n] of [['nuovi-video', novita.video], ['nuove-note', novita.note]]) { $(id).hidden = !n; $(id).textContent = String(n); }
  }
  for (const s of ['video', 'note']) {
    $(`sezione-${s}`).addEventListener('click', () => {
      if (sezione === s) return;
      sezione = s; scelta = null; nelCestino = false; categoriaAperta = null;
      disegnaSezioni();
      aggiornaVista();
    });
  }

  function disegnaFile() {
    const cercato = $('cerca').value.trim().toLowerCase();
    const origine = (nelCestino ? fileCestino : fileCaricati.filter((f) => scelta === null || f.categoriaId === scelta)).filter(diSezione);
    const scelti = origine.filter((f) => `${f.titolo} ${f.nome}`.toLowerCase().includes(cercato));
    const contenitore = $('file');
    contenitore.replaceChildren();
    $('intestazione-cestino').hidden = !nelCestino;
    $('svuota-cestino').disabled = !fileCestino.length;
    $('titolo-sezione').textContent = nelCestino ? 'Cestino' : scelta === null ? (sezione === 'note' ? 'Tutte le note' : 'Tutti i video') : nomeCategoria(scelta);
    contenitore.classList.toggle('lista-note', sezione === 'note');
    document.querySelector('.vista').hidden = sezione === 'note';
    if (!scelti.length) {
      const testo = origine.length ? 'Nessun file con questo nome.' : nelCestino ? 'Il cestino è vuoto.' : scelta === null ? 'Ancora nessun file. Carica il primo.' : 'Nessun file in questa categoria.';
      contenitore.append(elemento('p', 'vuoto', testo));
      return;
    }
    for (const f of scelti) {
      if (sezione === 'note' && !nelCestino) { contenitore.append(rigaNota(f)); continue; }
      const scheda = elemento('article', `scheda${!f.vistoIl && !nelCestino ? ' nuovo' : ''}`);
      scheda.dataset.file = f.id;
      const nome = elemento('div', 'nome', f.titolo);
      nome.title = f.nome;
      const dati = elemento('div', 'dati');
      dati.append(elemento('span', 'peso', peso(f.dimensione)), elemento('span', 'data', quando(f.caricatoIl)));
      if (!nelCestino && scelta === null && f.categoriaId) dati.append(elemento('span', 'categoria', nomeCategoria(f.categoriaId)));
      if (!nelCestino) dati.append(etichettaLink(f));
      const lavoro = barraLavoro(f);
      if (lavoro) dati.append(lavoro);
      const azioni = elemento('div', 'azioni-scheda');
      if (nelCestino) {
        azioni.append(
          pulsante('Ripristina', async () => { await api(`/api/file/${f.id}/ripristina`, { method: 'POST', body: {} }); await aggiornaTutto(); }, 'pulsante piccolo'),
          pulsante('Elimina per sempre', async () => {
            if (!await conferma(`Eliminare per sempre «${f.titolo}»? Non si può annullare.`, { titolo: 'Elimina per sempre', ok: 'Elimina', pericolo: true })) return;
            await api(`/api/file/${f.id}/definitivo`, { method: 'DELETE' });
            await aggiornaTutto();
          }, 'pulsante piccolo pericolo'),
        );
      } else {
        azioni.append(pulsante('Condividi', () => DGCondividi.apri({ tipo: 'file', id: f.id, titolo: f.titolo, copertina: f.miniatura === 1 ? `/api/file/${f.id}/miniatura` : '' }, () => aggiornaFile().catch(() => {})), 'pulsante piccolo principale-piccolo'));
        if (f.tipo.startsWith('video/')) azioni.append(pulsante('Guarda', () => { guarda(f, scheda); if (!f.vistoIl) { f.vistoIl = Date.now(); api(`/api/file/${f.id}/visto`, { method: 'POST', body: {} }).then((r) => disegnaSezioni(r.novita)).catch(() => {}); scheda.classList.remove('nuovo'); } }, 'pulsante piccolo'));
        azioni.append(
          pulsante('Modifica', () => moduloModifica(f, scheda), 'pulsante piccolo'),
          pulsante('Elimina', async () => {
            if (!await conferma(`«${f.titolo}» va nel cestino: resta lì 30 giorni, poi si cancella da solo.`, { titolo: 'Sposta nel cestino', ok: 'Sposta nel cestino' })) return;
            await api(`/api/file/${f.id}`, { method: 'DELETE' });
            await aggiornaTutto();
          }, 'pulsante piccolo'),
        );
      }
      const coperta = copertina(f);
      anteprimaAlPassaggio(scheda, coperta, f);
      scheda.append(coperta, nome, dati, azioni);
      contenitore.append(scheda);
    }
  }

  function disegnaSpazio(s) {
    $('spazio-usato').textContent = peso(s.usato);
    $('spazio-libero').textContent = `Liberi sul server: ${peso(s.libero)}`;
    const quota = s.usato + s.libero > 0 ? (s.usato / (s.usato + s.libero)) * 100 : 0;
    $('spazio-misura').style.width = `${Math.max(quota, s.usato > 0 ? 2 : 0)}%`;
    $('giorni-cestino').textContent = String(s.giorniNelCestino);
  }

  // ---- categorie: elenco a sinistra, come nell'anteprima ----
  function vocePulsante(testo, quanti, attiva, azione) {
    const li = elemento('li', 'senza-tasto');
    const b = pulsante('', azione, `voce${attiva ? ' attiva' : ''}`);
    b.append(elemento('span', 'voce-nome', testo), elemento('b', 'num', String(quanti)));
    li.append(b);
    return { li, b };
  }

  // Le categorie si spostano trascinandole: col mouse basta muoverle, col dito si tiene premuto un attimo.
  function rendiTrascinabile(li) {
    const voce = li.querySelector('.voce');
    voce.addEventListener('contextmenu', (e) => { if (e.pointerType && e.pointerType !== 'mouse') e.preventDefault(); });
    voce.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const tocco = e.pointerType !== 'mouse';
      const inizio = { x: e.clientX, y: e.clientY };
      const ul = $('categorie');
      const ordine = () => [...ul.querySelectorAll('li[data-id]')].map((x) => Number(x.dataset.id));
      const prima = ordine().join();
      let attivo = false;
      const parti = () => {
        attivo = true;
        categoriaTrascinata = li;
        li.classList.add('in-trascina');
        document.body.classList.add('trascina-categoria');
        ul.classList.add('in-riordino');
        if (tocco) navigator.vibrate?.(20);
      };
      const attesa = tocco ? setTimeout(parti, 350) : null;
      const muovi = (ev) => {
        const distanza = Math.hypot(ev.clientX - inizio.x, ev.clientY - inizio.y);
        if (!attivo) {
          if (tocco && distanza > 8) { chiudi(); return; }
          if (!tocco && distanza > 5) parti();
          if (!attivo) return;
        }
        const sotto = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#categorie li[data-id]');
        if (!sotto || sotto === li) return;
        const r = sotto.getBoundingClientRect();
        const stessaRiga = Math.abs(r.top - li.getBoundingClientRect().top) < r.height / 2;
        const dopo = stessaRiga ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
        sotto.before(li);
        if (dopo) sotto.after(li);
      };
      const chiudi = () => {
        clearTimeout(attesa);
        window.removeEventListener('pointermove', muovi);
        window.removeEventListener('pointerup', fine);
        window.removeEventListener('pointercancel', fine);
      };
      const fine = async () => {
        chiudi();
        if (!attivo) return;
        categoriaTrascinata = null;
        li.classList.remove('in-trascina');
        document.body.classList.remove('trascina-categoria');
        ul.classList.remove('in-riordino');
        saltaClic = true;
        setTimeout(() => { saltaClic = false; }, 50);
        if (ordine().join() === prima) return;
        try {
          await api('/api/categorie/ordine', { method: 'PUT', body: { modo: 'manuale', ids: ordine() } });
        } catch (err) { avvisa(err.message); }
        await aggiornaFile().catch(() => {});
      };
      window.addEventListener('pointermove', muovi);
      window.addEventListener('pointerup', fine);
      window.addEventListener('pointercancel', fine);
    });
  }

  function disegnaCategorie(spazio) {
    if (categoriaTrascinata) return;
    const ul = $('categorie');
    ul.replaceChildren();
    ul.classList.toggle('con-aperta', categorie.some((c) => c.id === categoriaAperta));
    ul.append(vocePulsante(sezione === 'note' ? 'Tutte le note' : 'Tutti i video', fileCaricati.filter(diSezione).length, !nelCestino && scelta === null, () => { nelCestino = false; scelta = null; aggiornaVista(); }).li);
    for (const c of categorie.filter((x) => x.sezione === sezione)) {
      const { li } = vocePulsante(c.nome, c.quanti, !nelCestino && scelta === c.id, () => { nelCestino = false; scelta = c.id; aggiornaVista(); });
      li.classList.remove('senza-tasto');
      li.dataset.id = c.id;
      rendiTrascinabile(li);
      const aperta = categoriaAperta === c.id;
      li.classList.toggle('aperta', aperta);
      // Ogni categoria ha il suo «Modifica»: i comandi si aprono solo per quella.
      const tasto = pulsante('', () => { categoriaAperta = aperta ? null : c.id; disegnaCategorie(); }, 'pulsante minuscolo tasto-voce');
      tasto.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19l-4 1zM14 7l3 3"/></svg>';
      tasto.title = aperta ? 'Chiudi la modifica' : 'Modifica';
      tasto.setAttribute('aria-expanded', String(aperta));
      tasto.setAttribute('aria-label', `${aperta ? 'Chiudi la modifica di' : 'Modifica'} ${c.nome}`);
      li.append(tasto);
      if (aperta) {
        const strumenti = elemento('span', 'voce-strumenti');
        strumenti.append(
          pulsante('Condividi', () => DGCondividi.apri({ tipo: 'categoria', id: c.id, titolo: `Cartella «${c.nome}»` }), 'pulsante minuscolo'),
          pulsante('Rinomina', () => rinominaCategoria(c, li), 'pulsante minuscolo'),
          pulsante('Elimina', async () => {
            if (!await conferma(`I suoi ${c.quanti} file restano, senza categoria.`, { titolo: `Eliminare la categoria «${c.nome}»?`, ok: 'Elimina', pericolo: true })) return;
            await api(`/api/categorie/${c.id}`, { method: 'DELETE' });
            if (scelta === c.id) scelta = null;
            await aggiornaTutto();
          }, 'pulsante minuscolo'),
        );
        li.append(strumenti);
      }
      ul.append(li);
    }
    ul.append(vocePulsante('Cestino', fileCestino.filter(diSezione).length, nelCestino, () => { nelCestino = true; aggiornaVista(); }).li);
  }

  function rinominaCategoria(c, li) {
    const form = elemento('form', 'rinomina');
    const input = elemento('input');
    input.value = c.nome;
    input.maxLength = 60;
    input.required = true;
    input.setAttribute('aria-label', 'Nuovo nome della categoria');
    const salva = elemento('button', 'pulsante minuscolo', 'Salva');
    salva.type = 'submit';
    form.append(input, salva, pulsante('Annulla', () => aggiornaVista(), 'pulsante minuscolo'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/categorie/${c.id}`, { method: 'PUT', body: { nome: input.value } });
        await aggiornaTutto();
      } catch (err) { avvisa(err.message); }
    });
    li.replaceChildren(form);
    input.focus();
    input.select();
  }

  function aggiornaVista() {
    document.body.classList.toggle('nel-cestino', nelCestino);
    disegnaCategorie();
    disegnaFile();
  }

  async function aggiornaFile(automatico = false) {
    const [r, c, k] = await Promise.all([api('/api/file'), api('/api/cestino'), api('/api/categorie')]);
    fileCaricati = r.file;
    disegnaSezioni(r.novita);
    fileCestino = c.file;
    categorie = k.categorie;
    ordineCategorie = k.ordine;
    $('ordine-scelta').value = ordineCategorie;
    if (scelta !== null && !categorie.some((x) => x.id === scelta)) scelta = null;
    iaAttiva = Boolean(r.ia);
    disegnaSpazio(r.spazio);
    if (!automatico || !document.querySelector('#categorie .rinomina')) disegnaCategorie(r.spazio);
    // Mentre si corregge un riassunto l'aggiornamento automatico non ridisegna: si perderebbe il testo.
    // L'aggiornamento automatico non chiude quello che l'utente ha aperto: video, anteprima, modifica.
    // Il video e le correzioni in corso restano anche quando finisce un caricamento.
    if (!document.querySelector(automatico ? '.in-visione, .modifica-file, .anteprima-passaggio' : '.in-visione, .riassunto textarea, .capitoli .rinomina')) disegnaFile();
    clearTimeout(attesaCopertine);
    if (io.ffmpeg && fileCaricati.some((f) => ((f.miniatura === 0 || f.visione === 0 || (r.ia && f.ia === 0)) && f.tipo.startsWith('video/')) || ['attesa', 'trascrizione', 'riassunto'].includes(f.nota?.stato))) {
      attesaCopertine = setTimeout(() => aggiornaFile(true).catch(() => {}), 5000);
    }
    io.ia = r.ia;
  }
  const aggiornaTutto = () => Promise.allSettled([aggiornaFile(), aggiornaSospesi()]);

  // ---- griglia, elenco o cestino: la scelta griglia/elenco resta su questo dispositivo ----

  const CHIAVE_VISTA = 'digishare.vista';
  function leggiVista() {
    try {
      const salvata = localStorage.getItem(CHIAVE_VISTA);
      if (salvata === 'griglia' || salvata === 'elenco') return salvata;
    } catch { /* senza memoria del browser vale la predefinita */ }
    return matchMedia('(max-width: 900px)').matches ? 'elenco' : 'griglia';
  }

  function mettiVista(vista, salva) {
    $('file').className = vista;
    $('vista-griglia').setAttribute('aria-pressed', String(vista === 'griglia'));
    $('vista-elenco').setAttribute('aria-pressed', String(vista === 'elenco'));
    if (!salva) return;
    try {
      localStorage.setItem(CHIAVE_VISTA, vista);
    } catch { /* la scelta vale fino alla prossima apertura */ }
  }

  // ---- caricamenti rimasti a metà ----

  function urlAttivi() {
    return new Set(coda.filter((l) => l.upload?.url).map((l) => new URL(l.upload.url).pathname));
  }

  function disegnaSospesi() {
    const attivi = urlAttivi();
    const scelti = sospesi.filter((s) => !attivi.has(s.url));
    const contenitore = $('sospesi');
    contenitore.replaceChildren();
    $('sezione-sospesi').hidden = !scelti.length;
    for (const s of scelti) {
      const riga = elemento('article', 'riga-lavoro');
      const percento = Math.floor((s.ricevuti / s.dimensione) * 100);
      const misura = elemento('div', 'misura');
      const pieno = elemento('i');
      pieno.style.width = `${percento}%`;
      misura.append(pieno);
      const azioni = elemento('div', 'azioni');
      azioni.append(pulsante('Elimina', async (e) => {
        if (!await conferma(`La parte già caricata di «${s.nome}» va persa.`, { titolo: 'Eliminare il caricamento interrotto?', ok: 'Elimina', pericolo: true })) return;
        e.target.disabled = true;
        await api(s.url, { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0' } }).catch(() => {});
        await aggiornaSospesi();
      }));
      riga.append(
        elemento('div', 'nome', s.nome),
        misura,
        elemento('p', 'lavoro-stato', `Fermo al ${percento}% (${peso(s.ricevuti)} di ${peso(s.dimensione)}). Carica di nuovo questo file: riprende da lì.`),
        azioni,
      );
      contenitore.append(riga);
    }
  }

  async function aggiornaSospesi() {
    sospesi = (await api('/api/in-sospeso')).caricamenti;
    disegnaSospesi();
  }

  // ---- coda dei caricamenti ----

  function creaRiga(lavoro) {
    const riga = elemento('article', 'riga-lavoro');
    const azioni = elemento('div', 'azioni');
    lavoro.pausa = pulsante('Pausa', () => cambiaPausa(lavoro));
    lavoro.annulla = pulsante('Annulla', () => annulla(lavoro));
    azioni.append(lavoro.pausa, lavoro.annulla);
    const nome = elemento('div', 'nome', lavoro.file.name);
    nome.title = lavoro.file.name;
    const misura = elemento('div', 'misura');
    lavoro.pieno = elemento('i');
    misura.append(lavoro.pieno);
    lavoro.testo = elemento('p', 'lavoro-stato');
    lavoro.testo.setAttribute('aria-live', 'polite');
    riga.append(nome, misura, lavoro.testo, azioni);
    lavoro.riga = riga;
    $('lavori').append(riga);
    $('sezione-lavori').hidden = false;
  }

  function togliRiga(lavoro) {
    lavoro.riga.remove();
    coda.splice(coda.indexOf(lavoro), 1);
    $('sezione-lavori').hidden = !coda.length;
  }

  function scrivi(lavoro) {
    const { inviati } = lavoro;
    const totale = lavoro.file.size;
    const percento = totale ? Math.floor((inviati / totale) * 100) : 0;
    lavoro.pieno.style.width = `${percento}%`;
    const base = `${percento}% · ${peso(inviati)} di ${peso(totale)}`;
    const testi = {
      attesa: 'In attesa',
      avvio: 'Controllo se si può riprendere…',
      pausa: `In pausa · ${base}`,
      rete: `Rete caduta o server fermo: riprovo da solo · ${base}`,
      fermo: lavoro.errore,
      invio: lavoro.velocita > 0
        ? `${base} · ${peso(lavoro.velocita)}/s · mancano ${durata((totale - inviati) / lavoro.velocita)}`
        : inviati ? base : 'Sto leggendo il file: da Google Drive può volerci qualche minuto prima che la percentuale si muova.',
    };
    lavoro.testo.textContent = testi[lavoro.stato];
    lavoro.pausa.textContent = ['pausa', 'fermo'].includes(lavoro.stato) ? 'Riprendi' : 'Pausa';
    lavoro.pausa.disabled = ['attesa', 'avvio'].includes(lavoro.stato);
  }

  function misuraVelocita(lavoro, inviati) {
    const ora = performance.now();
    if (!lavoro.campione) lavoro.campione = { t: ora, byte: inviati };
    const passati = (ora - lavoro.campione.t) / 1000;
    if (passati >= 1) {
      const attuale = Math.max(0, inviati - lavoro.campione.byte) / passati;
      lavoro.velocita = lavoro.velocita ? lavoro.velocita * 0.7 + attuale * 0.3 : attuale;
      lavoro.campione = { t: ora, byte: inviati };
    }
  }

  function messaggioErrore(err) {
    const r = err.originalResponse;
    diagnosi('caricamento_fermo', String(err.message || '').slice(0, 150));
    if (!r && /read|NotReadable|NotFound|changed/i.test(String(err.message))) return 'Il telefono non riesce più a leggere il file (succede con i file su Google Drive). Scegli di nuovo il file.';
    if (!r) return 'Caricamento fermo: la rete non risponde. Premi «Riprendi» quando è tornata.';
    const stato = r.getStatus();
    if (stato === 401) return 'Accesso scaduto: rientra e carica di nuovo il file, riprenderà da dove era.';
    if (stato === 403) return 'Sessione non valida: ricarica la pagina e carica di nuovo il file, riprenderà da dove era.';
    if (stato === 413) return 'Il file è troppo grande.';
    const testo = r.getBody()?.trim();
    return testo && stato < 600 && stato !== 500 ? testo : `Il server ha dato un errore (${stato}). Premi «Riprendi» per riprovare.`;
  }

  async function avvia(lavoro) {
    lavoro.stato = 'avvio';
    scrivi(lavoro);
    let riprendi = null;
    try {
      await aggiornaSospesi();
      riprendi = sospesi.find((s) => !urlAttivi().has(s.url)
        && s.nome === lavoro.file.name
        && s.dimensione === lavoro.file.size
        && s.ultimaModifica === lavoro.file.lastModified);
    } catch { /* senza elenco si parte da zero: il caricamento stesso dirà se la rete è giù */ }

    if (riprendi) lavoro.inviati = riprendi.ricevuti;
    lavoro.upload = new tus.Upload(lavoro.file, {
      endpoint: ENDPOINT,
      uploadUrl: riprendi ? location.origin + riprendi.url : null,
      chunkSize: PEZZO,
      retryDelays: ATTESE,
      storeFingerprintForResuming: false,
      headers: { 'x-csrf-token': DG.csrf() },
      metadata: {
        filename: lavoro.file.name,
        filetype: lavoro.file.type || 'application/octet-stream',
        ultimamodifica: String(lavoro.file.lastModified),
        categoria: lavoro.categoria ? String(lavoro.categoria) : '',
      },
      onProgress(inviati) {
        lavoro.inviati = inviati;
        if (lavoro.stato !== 'pausa') lavoro.stato = 'invio';
        misuraVelocita(lavoro, inviati);
        scrivi(lavoro);
      },
      onShouldRetry(err) {
        const stato = err.originalResponse?.getStatus() ?? 0;
        if (stato >= 400 && stato < 500 && stato !== 409 && stato !== 423) return false;
        lavoro.stato = 'rete';
        lavoro.velocita = 0;
        lavoro.campione = null;
        scrivi(lavoro);
        return true;
      },
      onError(err) {
        lavoro.stato = 'fermo';
        lavoro.errore = messaggioErrore(err);
        lavoro.velocita = 0;
        lavoro.campione = null;
        scrivi(lavoro);
        prossimo();
      },
      async onSuccess() {
        togliRiga(lavoro);
        await aggiornaTutto();
        prossimo();
      },
    });
    lavoro.upload.start();
    lavoro.stato = 'invio';
    scrivi(lavoro);
    disegnaSospesi();
  }

  function cambiaPausa(lavoro) {
    if (lavoro.stato === 'pausa' || lavoro.stato === 'fermo') {
      lavoro.stato = 'invio';
      lavoro.velocita = 0;
      lavoro.campione = null;
      scrivi(lavoro);
      lavoro.upload.start();
      return;
    }
    lavoro.upload.abort();
    lavoro.stato = 'pausa';
    scrivi(lavoro);
    prossimo();
  }

  async function annulla(lavoro) {
    if (!await conferma(`«${lavoro.file.name}» non verrà caricato.`, { titolo: 'Annullare il caricamento?', ok: 'Annulla il caricamento', annulla: 'Continua', pericolo: true })) return;
    if (lavoro.upload) await lavoro.upload.abort(!!lavoro.upload.url).catch(() => {});
    togliRiga(lavoro);
    await aggiornaSospesi().catch(() => {});
    prossimo();
  }

  // Uno alla volta: due insieme si dividono la stessa linea senza finire prima.
  function prossimo() {
    if (coda.some((l) => ['avvio', 'invio', 'rete'].includes(l.stato))) return;
    const dopo = coda.find((l) => l.stato === 'attesa');
    if (dopo) avvia(dopo);
  }

  function aggiungi(elencoFile) {
    for (const file of elencoFile) {
      const lavoro = { file, stato: 'attesa', inviati: 0, velocita: 0, categoria: !nelCestino && scelta !== null ? scelta : null };
      coda.push(lavoro);
      creaRiga(lavoro);
      if (file.size === 0) {
        lavoro.stato = 'fermo';
        lavoro.errore = 'Il file è vuoto: non si può caricare.';
        lavoro.pausa.hidden = true;
      }
      scrivi(lavoro);
    }
    prossimo();
  }

  // ---- comandi della pagina ----

  // Sul telefono il file scelto puo' arrivare tardi (da Drive va prima scaricato) o non arrivare: l'utente deve vederlo,
  // e il registro dice cosa e' successo davvero, perche' dal PC non si puo' provare (31.10.2026).
  const conDito = window.matchMedia('(pointer: coarse)');
  const diagnosi = (evento, dettaglio = '') => { if (conDito.matches) api('/api/diagnosi-caricamento', { method: 'POST', body: { evento, dettaglio } }).catch(() => {}); };
  let sceltaAperta = 0;
  let tornato = 0;
  function attesaFile(mostra) {
    let riga = $('attesa-file');
    if (!mostra) {
      riga?.remove();
      $('sezione-lavori').hidden = !coda.length;
      return;
    }
    if (riga) return;
    riga = elemento('article', 'riga-lavoro');
    riga.id = 'attesa-file';
    riga.append(elemento('div', 'nome', 'Aspetto il file dal telefono'), elemento('p', 'lavoro-stato', 'Se è su Google Drive, il telefono deve prima scaricarlo e può volerci qualche minuto. Non chiudere l\'app: parte da solo.'));
    const scorre = elemento('span', 'barra-scorre');
    scorre.append(elemento('i'));
    riga.append(scorre, pulsante('Annulla', () => { sceltaAperta = 0; attesaFile(false); diagnosi('attesa_annullata', `${Math.round((Date.now() - tornato) / 1000)} s`); }, 'pulsante piccolo'));
    $('lavori').prepend(riga);
    $('sezione-lavori').hidden = false;
    $('sezione-lavori').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function apriScelta() {
    const scegli = $('scegli');
    scegli.multiple = !conDito.matches;
    sceltaAperta = Date.now();
    tornato = 0;
    diagnosi('scelta_aperta');
    scegli.click();
  }
  $('carica').addEventListener('click', apriScelta);
  $('carica-riquadro').addEventListener('click', apriScelta);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !sceltaAperta || tornato) return;
    tornato = Date.now();
    diagnosi('tornato_nella_pagina', `${Math.round((tornato - sceltaAperta) / 1000)} s`);
    // Se il file c'e' gia', «change» arriva subito; altrimenti si dice che si sta aspettando.
    setTimeout(() => { if (sceltaAperta) attesaFile(true); }, 1500);
  });
  $('scegli').addEventListener('cancel', () => {
    diagnosi('scelta_annullata', `${Math.round((Date.now() - sceltaAperta) / 1000)} s`);
    sceltaAperta = 0;
    attesaFile(false);
  });
  $('scegli').addEventListener('change', (e) => {
    const file = [...e.target.files];
    diagnosi('file_arrivato', `${file.length} file, ${file[0]?.size ?? 0} byte, ${file[0]?.type || 'senza tipo'}, dopo ${tornato ? Math.round((Date.now() - tornato) / 1000) : 0} s dal ritorno`);
    sceltaAperta = 0;
    attesaFile(false);
    aggiungi(file);
    e.target.value = '';
  });
  $('cerca').addEventListener('input', disegnaFile);
  $('vista-griglia').addEventListener('click', () => mettiVista('griglia', true));
  $('vista-elenco').addEventListener('click', () => mettiVista('elenco', true));
  $('categorie').addEventListener('click', (e) => { if (saltaClic) { e.preventDefault(); e.stopPropagation(); } }, true);
  window.addEventListener('touchmove', (e) => { if (categoriaTrascinata) e.preventDefault(); }, { passive: false });
  $('ordine-scelta').addEventListener('change', async () => {
    await api('/api/categorie/ordine', { method: 'PUT', body: { modo: $('ordine-scelta').value } });
    await aggiornaFile();
  });
  $('nuova-categoria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = $('nome-categoria').value.trim();
    if (!nome) return;
    try {
      const { id } = await api('/api/categorie', { method: 'POST', body: { sezione, nome } });
      $('nome-categoria').value = '';
      nelCestino = false;
      scelta = id;
      await aggiornaTutto();
    } catch (err) { avvisa(err.message); }
  });
  $('svuota-cestino').addEventListener('click', async () => {
    if (!await conferma(`${fileCestino.length === 1 ? 'Il file' : `I ${fileCestino.length} file`} nel cestino verranno eliminati per sempre. Non si può annullare.`, { titolo: 'Svuotare il cestino?', ok: 'Svuota', pericolo: true })) return;
    await api('/api/cestino/svuota', { method: 'POST', body: {} });
    await aggiornaTutto();
  });
  mettiVista(leggiVista(), false);

  // Il file si può lasciare ovunque: lasciato fuori dal riquadro, il browser lo aprirebbe e
  // la pagina con i caricamenti in corso andrebbe persa.
  const zona = $('trascina');
  let dentro = 0;
  const conFile = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!conFile(e)) return;
    e.preventDefault();
    dentro++;
    zona.classList.add('sopra');
  });
  window.addEventListener('dragover', (e) => {
    if (conFile(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dentro = Math.max(0, dentro - 1);
    if (!dentro) zona.classList.remove('sopra');
  });
  window.addEventListener('drop', (e) => {
    if (!conFile(e)) return;
    e.preventDefault();
    dentro = 0;
    zona.classList.remove('sopra');
    aggiungi([...e.dataTransfer.files]);
  });

  window.addEventListener('beforeunload', (e) => {
    if (coda.some((l) => ['avvio', 'invio', 'rete'].includes(l.stato))) e.preventDefault();
  });

  // Il tocco sulla notifica di un video arriva con ?file=<id>: si apre quel video, una volta sola.
  function apriDaNotifica() {
    const id = new URLSearchParams(location.search).get('file');
    if (!id) return;
    history.replaceState(null, '', '/');
    const scheda = [...$('file').children].find((s) => s.dataset.file === id);
    const guardalo = scheda && [...scheda.querySelectorAll('button')].find((b) => b.textContent === 'Guarda');
    if (!guardalo) return;
    guardalo.click();
    scheda.scrollIntoView({ block: 'start' });
  }

  aggiornaFile().then(apriDaNotifica).catch((err) => console.error(err));
  aggiornaSospesi().catch((err) => console.error(err));
})();
