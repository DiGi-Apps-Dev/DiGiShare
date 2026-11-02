'use strict';
// Finestra «Condividi», come nell'anteprima approvata: chi può aprire (chiunque / solo email), scadenza,
// scaricamento sì/no, link con Copia, link già creati con Revoca e Prolunga, Apri la pagina, Invia per email.
window.DGCondividi = (() => {
  const { api, el: elemento, pulsante, peso, quando, conferma } = DG;
  const SCADENZE = [['1', '1 giorno'], ['7', '7 giorni'], ['30', '30 giorni'], ['0', 'Mai']];
  let finestra;

  function chiudi() { finestra?.close(); }

  // oggetto = { tipo:'file', id, titolo, copertina, salva } oppure { tipo:'categoria', id, titolo }
  // salva, solo per le note: [{ testo, href }] da scaricare o [{ testo, azione }] da eseguire a finestra chiusa.
  async function apri(oggetto, dopo = () => {}) {
    finestra?.remove();
    finestra = document.createElement('dialog');
    finestra.className = 'condividi';
    document.body.append(finestra);
    const stato = { chi: 'chiunque', email: [], scadenza: '7', scarica: false, errore: '', ok: '' };
    const base = oggetto.tipo === 'file' ? `/api/file/${oggetto.id}/link` : `/api/categorie/${oggetto.id}/link`;
    let esistenti = []; let emailConfigurata = false; let pulsantePremuto = false; let elenco = null; let erroreElenco = '';

    async function carica() {
      const r = await api(base);
      esistenti = r.link; emailConfigurata = r.emailConfigurata;
    }

    // Finestra con i link gia' creati: scorre da sola, Condividi sotto non cambia.
    function disegnaElenco() {
      if (!elenco) {
        elenco = document.createElement('dialog');
        elenco.className = 'condividi elenco-link';
        document.body.append(elenco);
        elenco.addEventListener('close', () => { elenco.remove(); elenco = null; });
        elenco.addEventListener('click', (e) => { if (e.target === elenco) elenco.close(); });
        elenco.showModal();
      }
      const posizione = elenco.scrollTop;
      const aggiorna = async () => { await carica(); disegna(); disegnaElenco(); dopo(); };
      const azione = (fai) => async (e) => { erroreElenco = ''; try { await fai(e); } catch (err) { erroreElenco = err.message; disegnaElenco(); } };
      const testa = elemento('div', 'condividi-testa');
      const t = elemento('div'); t.append(elemento('h2', '', `Link già creati (${esistenti.length})`), elemento('p', 'nome', oggetto.titolo)); testa.append(t);
      const x = pulsante('✕', () => elenco.close(), 'pulsante piccolo'); x.setAttribute('aria-label', 'Chiudi'); testa.append(x);
      const sez = elemento('div', 'link-esistenti');
      if (erroreElenco) sez.append(Object.assign(elemento('p', 'avviso errore', erroreElenco), { role: 'alert' }));
      if (!esistenti.length) sez.append(elemento('p', 'piccolo', 'Nessun link per ora.'));
      for (const l of esistenti) {
        const r = elemento('div', `link-riga ${l.stato}`);
        const info = elemento('div', 'link-info');
        const scad = l.scadeIl ? `scade il ${quando(l.scadeIl)}` : 'non scade';
        const statoTesto = l.stato === 'attivo' ? scad : l.stato === 'scaduto' ? `scaduto il ${quando(l.scadeIl)}` : `revocato il ${quando(l.revocatoIl)}`;
        info.append(elemento('b', '', l.destinatario || 'Chiunque ha il link'), elemento('p', 'piccolo', `${statoTesto} · aperto ${l.aperture} ${l.aperture === 1 ? 'volta' : 'volte'}${l.visite ? ` · visto fino a ${Math.round(l.secondiMassimi / 60)} min` : ''}${l.scarica ? ' · scaricabile' : ''}`));
        const indirizzo = elemento('input', 'link-url'); indirizzo.readOnly = true; indirizzo.value = l.url; indirizzo.setAttribute('aria-label', 'Indirizzo del link'); indirizzo.addEventListener('focus', () => indirizzo.select());
        info.append(indirizzo);
        const az = elemento('div', 'azioni');
        if (l.stato === 'attivo') {
          az.append(pulsante('Copia', async (e) => { try { await navigator.clipboard.writeText(l.url); e.target.textContent = 'Copiato'; } catch { indirizzo.focus(); } }, 'pulsante piccolo'));
          const a = elemento('a', 'pulsante piccolo', 'Apri la pagina'); a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; az.append(a);
          if (l.destinatario && emailConfigurata) az.append(pulsante('Invia per email', azione(async (e) => { await api(`/api/link/${l.id}/invia`, { method: 'POST', body: {} }); e.target.textContent = 'Inviata'; }), 'pulsante piccolo'));
          if (l.scadeIl) az.append(pulsante('Prolunga 30 giorni', azione(async () => { await api(`/api/link/${l.id}/prolunga`, { method: 'POST', body: {} }); await aggiorna(); }), 'pulsante piccolo'));
          az.append(pulsante('Revoca', azione(async () => { if (!await conferma('Chi ha questo link non potrà più aprirlo.', { titolo: 'Revocare il link?', ok: 'Revoca', pericolo: true })) return; await api(`/api/link/${l.id}`, { method: 'DELETE' }); await aggiorna(); }), 'pulsante piccolo pericolo'));
        } else if (l.stato === 'scaduto') {
          az.append(pulsante('Prolunga 30 giorni', azione(async () => { await api(`/api/link/${l.id}/prolunga`, { method: 'POST', body: {} }); await aggiorna(); }), 'pulsante piccolo'));
        }
        r.append(info, az); sez.append(r);
      }
      const corpo = elemento('div', 'condividi-corpo'); corpo.append(sez);
      elenco.replaceChildren(testa, corpo);
      elenco.scrollTop = posizione;
    }

    function disegna() {
      finestra.replaceChildren();
      const testa = elemento('div', 'condividi-testa');
      if (oggetto.copertina) { const img = document.createElement('img'); img.src = oggetto.copertina; img.alt = ''; img.className = 'condividi-copertina'; testa.append(img); }
      const t = elemento('div'); t.append(elemento('h2', '', 'Condividi'), elemento('p', 'nome', oggetto.titolo)); testa.append(t);
      const x = pulsante('✕', chiudi, 'pulsante piccolo'); x.setAttribute('aria-label', 'Chiudi'); testa.append(x);
      const corpo = elemento('div', 'condividi-corpo');
      const messaggi = elemento('div');
      if (stato.errore) messaggi.append(Object.assign(elemento('p', 'avviso errore', stato.errore), { role: 'alert' }));
      if (stato.ok) messaggi.append(elemento('p', 'avviso ok', stato.ok));

      // chi puo' aprire
      const chi = elemento('div', 'campo'); chi.append(elemento('span', 'etichetta', 'Chi può aprire'));
      const opzioni = elemento('div', 'opzioni');
      for (const [val, tit, sot] of [['chiunque', 'Chiunque ha il link', 'Basta il link, niente registrazione'], ['email', 'Solo persone scelte', 'Un link personale per ogni email']]) {
        const b = pulsante('', () => { stato.chi = val; stato.errore = ''; disegna(); }, 'opzione');
        b.setAttribute('aria-pressed', String(stato.chi === val));
        b.append(elemento('b', '', tit), elemento('span', '', sot));
        opzioni.append(b);
      }
      chi.append(opzioni); corpo.append(messaggi, chi);

      // email
      if (stato.chi === 'email') {
        const campo = elemento('label', 'campo'); campo.append(elemento('span', 'etichetta', 'Email'));
        const scatola = elemento('div', 'email-scatola');
        for (const e of stato.email) { const tag = elemento('span', 'tag', e); tag.append(pulsante('✕', () => { stato.email = stato.email.filter((x) => x !== e); disegna(); }, 'togli')); scatola.append(tag); }
        const input = elemento('input'); input.type = 'email'; input.placeholder = 'Scrivi un\'email e premi Invio'; input.autocomplete = 'off';
        const aggiungi = () => { const v = input.value.trim().toLowerCase(); if (!v) return; if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { stato.errore = `Email non valida: ${v}`; disegna(); return; } if (!stato.email.includes(v)) stato.email.push(v); stato.errore = ''; disegna(); finestra.querySelector('.email-scatola input')?.focus(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); aggiungi(); } });
        // Ridisegnare mentre si preme un pulsante farebbe perdere il clic. Col dito l'uscita dal campo arriva subito prima
        // del clic, col mouse quando il tasto e' ancora giu': l'email si tiene subito, si ridisegna solo se nessun clic l'ha gia' fatto.
        input.addEventListener('blur', () => {
          const v = input.value.trim().toLowerCase();
          if (!v) return;
          const valida = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
          if (valida && !stato.email.includes(v)) stato.email.push(v);
          setTimeout(() => {
            if (!input.isConnected || pulsantePremuto) return;
            if (!valida) stato.errore = `Email non valida: ${v}`; else stato.errore = '';
            disegna();
          }, 120);
        });
        scatola.append(input); campo.append(scatola); corpo.append(campo);
        if (!emailConfigurata) corpo.append(elemento('p', 'piccolo', 'Email non configurata sul server: il link personale si crea lo stesso e lo copi tu.'));
      }

      // scadenza
      const sc = elemento('label', 'campo'); sc.append(elemento('span', 'etichetta', 'Scadenza del link'));
      const sel = elemento('select'); for (const [v, t2] of SCADENZE) { const o = elemento('option', '', t2); o.value = v; o.selected = stato.scadenza === v; sel.append(o); }
      sel.addEventListener('change', () => { stato.scadenza = sel.value; });
      sc.append(sel); corpo.append(sc);

      // scarica
      const riga = elemento('div', 'interruttore');
      const testo = elemento('div'); testo.append(elemento('b', '', 'Permetti di scaricare'), elemento('p', 'piccolo', stato.scarica ? 'Sulla pagina compare il pulsante Scarica.' : 'Solo visione nel browser: niente pulsante Scarica e niente tasto destro.'));
      const sw = pulsante('', () => { stato.scarica = !stato.scarica; disegna(); }, 'levetta'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(stato.scarica)); sw.setAttribute('aria-label', 'Permetti di scaricare');
      riga.append(testo, sw); corpo.append(riga);

      // azioni di creazione
      const azioni = elemento('div', 'condividi-azioni');
      const crea = async (inviaEmail) => {
        stato.errore = ''; stato.ok = '';
        try {
          const r = await api(base, { method: 'POST', body: { chi: stato.chi, email: stato.email, scadenza: Number(stato.scadenza), scarica: stato.scarica, inviaEmail } });
          await carica();
          const primo = r.link[0];
          if (stato.chi === 'chiunque' && primo) {
            try { await navigator.clipboard.writeText(primo.url); stato.ok = 'Link creato e copiato.'; } catch { stato.ok = 'Link creato: lo copi da «Link già creati».'; }
          } else {
            stato.ok = inviaEmail ? (r.erroriEmail.length ? `Link creati. Email non partite: ${r.erroriEmail.join('; ')}` : `${r.link.length === 1 ? 'Link creato e inviato' : `${r.link.length} link creati e inviati`} per email.`) : `${r.link.length === 1 ? 'Link personale creato' : `${r.link.length} link personali creati`}: li trovi in «Link già creati».`;
            stato.email = [];
          }
          dopo();
        } catch (err) { stato.errore = err.message; }
        disegna();
      };
      if (stato.chi === 'chiunque') azioni.append(pulsante('Crea il link e copialo', () => crea(false), 'pulsante principale'));
      else { azioni.append(pulsante('Crea i link', () => crea(false), 'pulsante')); if (emailConfigurata) azioni.append(pulsante('Crea e invia per email', () => crea(true), 'pulsante principale')); }
      corpo.append(azioni);
      if (stato.chi === 'email') {
        // Senza un'email questi pulsanti non possono creare niente: restano spenti e lo dicono.
        const serve = elemento('p', 'piccolo', 'Scrivi prima un\'email.');
        const campo = finestra.isConnected ? corpo.querySelector('.email-scatola input') : null;
        const controlla = () => {
          const v = campo?.value.trim() ?? '';
          const pronta = stato.email.length > 0 || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
          for (const b of azioni.querySelectorAll('button')) b.disabled = !pronta;
          serve.hidden = pronta;
        };
        campo?.addEventListener('input', controlla);
        controlla();
        corpo.append(serve);
      }

      // I link gia' creati stanno in una finestra a parte: con tanti link Condividi resterebbe enorme.
      const apriElenco = pulsante(`Link già creati (${esistenti.length})`, disegnaElenco, 'pulsante apri-elenco');
      apriElenco.disabled = !esistenti.length;
      corpo.append(apriElenco);
      if (oggetto.salva?.length) {
        const salva = elemento('div', 'campo'); salva.append(elemento('span', 'etichetta', 'Salva come'));
        const fila = elemento('div', 'azioni-nota');
        for (const s of oggetto.salva) {
          if (s.href) { const a = elemento('a', 'pulsante piccolo', s.testo); a.href = s.href; fila.append(a); } else fila.append(pulsante(s.testo, () => { chiudi(); s.azione(); }, 'pulsante piccolo'));
        }
        salva.append(fila); corpo.append(salva);
      }
      finestra.append(testa, corpo);
    }

    try { await carica(); } catch (err) { stato.errore = err.message; }
    disegna();
    finestra.addEventListener('close', () => { elenco?.close(); finestra.remove(); });
    finestra.addEventListener('pointerdown', (e) => { pulsantePremuto = Boolean(e.target.closest('button')); }, true);
    finestra.addEventListener('pointerup', () => { setTimeout(() => { pulsantePremuto = false; }, 0); }, true);
    finestra.addEventListener('click', (e) => { if (e.target === finestra) chiudi(); });
    finestra.showModal();
  }

  return { apri, chiudi, peso };
})();
