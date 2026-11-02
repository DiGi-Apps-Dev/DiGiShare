'use strict';
// Accesso: configurazione iniziale, entrata, recupero password e telefono perso.
(async () => {
  const { api, el, pulsante, avviso } = DG;
  const titolo = document.getElementById('titolo');
  const spiegazione = document.getElementById('spiegazione');
  const messaggio = document.getElementById('messaggio');
  const contenuto = document.getElementById('contenuto');

  const campo = (etichetta, attributi) => {
    const label = el('label', 'campo');
    label.append(el('span', 'etichetta', etichetta));
    const input = el('input');
    Object.assign(input, attributi);
    label.append(input);
    return { label, input };
  };
  const invia = (testo, azione) => {
    const b = pulsante(testo, async () => {
      b.disabled = true;
      avviso(messaggio, '');
      try { await azione(); } catch (err) { avviso(messaggio, err.message); b.disabled = false; }
    }, 'pulsante principale');
    return b;
  };
  const link = (testo, azione) => {
    const a = el('a', 'collegamento', testo);
    a.href = '#';
    a.addEventListener('click', (e) => { e.preventDefault(); azione(); });
    return a;
  };
  const mostra = (t, s, ...nodi) => {
    titolo.textContent = t;
    spiegazione.textContent = s;
    spiegazione.hidden = !s;
    avviso(messaggio, '');
    contenuto.replaceChildren(...nodi.filter(Boolean));
    contenuto.querySelector('input')?.focus();
  };
  const entrato = () => location.replace('/');
  const invioInvia = (input, pulsanteInvio) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pulsanteInvio.click(); });
  const qrBlocco = (dati) => {
    const img = el('img', 'qr');
    img.src = dati.qrDataUrl;
    img.alt = 'Codice QR per Google Authenticator';
    img.width = 232;
    img.height = 232;
    return [el('p', '', 'Nell\'app Google Authenticator scansiona il codice QR, oppure scrivi la chiave a mano.'), img, el('div', 'segreto', dati.secret)];
  };

  // Il nome utente dell'ultimo accesso riuscito resta su questo dispositivo, per non riscriverlo ogni volta.
  const CHIAVE_UTENTE = 'digishare.utente';
  const utenteRicordato = () => { try { return localStorage.getItem(CHIAVE_UTENTE) || 'admin'; } catch { return 'admin'; } };
  const ricordaUtente = (nome) => { try { localStorage.setItem(CHIAVE_UTENTE, nome); } catch { /* senza memoria resta admin */ } };

  // Aperta da fuori (un link, a volte l'app sul telefono) il browser non manda i cookie SameSite=Strict: il server
  // manda qui anche chi e' gia' dentro. Da questa pagina i cookie partono: se la sessione c'e' si torna ai file.
  const CHIAVE_RITORNO = 'digishare-ritorno';
  let ritornoRecente = false;
  try { ritornoRecente = Date.now() - Number(sessionStorage.getItem(CHIAVE_RITORNO) || 0) < 5000; } catch { /* senza memoria si prova lo stesso */ }
  if (!ritornoRecente) {
    try {
      const io = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (io.ok) {
        try { sessionStorage.setItem(CHIAVE_RITORNO, String(Date.now())); } catch { /* facoltativo */ }
        entrato();
        return;
      }
    } catch { /* si prosegue con la pagina di accesso */ }
  }

  let stato;
  try {
    stato = await api('/api/auth/status');
  } catch {
    mostra('DiGiShare', 'Il server non risponde. Controlla che il programma sia acceso.');
    return;
  }

  function schermataConfigurazione() {
    const utente = campo('Nome utente', { autocomplete: 'username', value: 'admin', maxLength: 40 });
    const avvio = invia('Inizia', async () => {
      const inizio = await api('/api/auth/setup/start', { method: 'POST', body: { username: utente.input.value.trim() } });
      const password = campo('Scegli la password (almeno 8 caratteri)', { type: 'password', autocomplete: 'new-password', minLength: 8 });
      const codice = campo('Codice a 6 cifre mostrato da Authenticator', { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 });
      const fine = invia('Attiva ed entra', async () => {
        await api('/api/auth/setup/complete', { method: 'POST', body: { setupToken: inizio.setupToken, password: password.input.value, code: codice.input.value.trim() } });
        ricordaUtente(utente.input.value.trim());
        entrato();
      });
      invioInvia(codice.input, fine);
      mostra('Prima configurazione', `Nome utente: ${utente.input.value.trim()}.`, ...qrBlocco(inizio), password.label, codice.label, fine);
    });
    mostra('Prima configurazione', 'Solo la prima volta: scegli nome utente e password e collega Google Authenticator. Servono per entrare da ogni dispositivo.', utente.label, avvio);
  }

  function schermataEntra() {
    const utente = campo('Nome utente', { autocomplete: 'username', value: utenteRicordato() });
    const password = campo('Password', { type: 'password', autocomplete: 'current-password' });
    const codice = campo('Codice Authenticator', { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 });
    const ricorda = el('label', 'spunta');
    const casella = el('input');
    casella.type = 'checkbox';
    casella.checked = true;
    ricorda.append(casella, el('span', '', 'Ricorda questo dispositivo per 90 giorni'));
    const entra = invia('Entra', async () => {
      await api('/api/auth/login', { method: 'POST', body: { username: utente.input.value.trim(), password: password.input.value, code: codice.input.value.trim(), remember: casella.checked } });
      ricordaUtente(utente.input.value.trim());
      entrato();
    });
    [utente, password, codice].forEach((c) => invioInvia(c.input, entra));
    mostra('Entra', 'Se questo dispositivo è ricordato, il codice Authenticator si può lasciare vuoto.',
      utente.label, password.label, codice.label, ricorda, entra,
      stato.emailConfigured ? link('Password dimenticata', () => schermataRecupero('password')) : null,
      stato.emailConfigured ? link('Ho perso il telefono', () => schermataRecupero('telefono')) : null);
  }

  // Recupero via email: 'password' = nuova password, 'telefono' = nuovo Authenticator.
  function schermataRecupero(scopo) {
    const telefono = scopo === 'telefono';
    const utente = campo('Nome utente', { autocomplete: 'username', value: utenteRicordato() });
    const codice = campo('Codice ricevuto per email (8 cifre)', { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 8 });
    const nuova = campo('Nuova password (almeno 8 caratteri)', { type: 'password', autocomplete: 'new-password', minLength: 8 });
    const secondo = el('div', 'modulo');
    const richiedi = invia('Invia il codice per email', async () => {
      const r = await api('/api/auth/recovery/request', { method: 'POST', body: { username: utente.input.value.trim(), purpose: scopo } });
      avviso(messaggio, r.message, 'ok');
      richiedi.disabled = false;
    });
    const passo2 = telefono
      ? invia('Continua', async () => {
        const inizio = await api('/api/auth/recovery/phone/start', { method: 'POST', body: { username: utente.input.value.trim(), code: codice.input.value.trim() } });
        const totp = campo('Codice a 6 cifre del nuovo telefono', { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 });
        const fine = invia('Collega il nuovo telefono', async () => {
          await api('/api/auth/recovery/phone/complete', { method: 'POST', body: { resetToken: inizio.resetToken, code: totp.input.value.trim() } });
          avviso(messaggio, 'Authenticator collegato. Ora entra con la password e il nuovo codice.', 'ok');
          setTimeout(schermataEntra, 1500);
        });
        secondo.replaceChildren(...qrBlocco(inizio), totp.label, fine);
      })
      : invia('Imposta la nuova password', async () => {
        await api('/api/auth/recovery/password', { method: 'POST', body: { username: utente.input.value.trim(), code: codice.input.value.trim(), newPassword: nuova.input.value } });
        avviso(messaggio, 'Password cambiata. Ora entra con quella nuova.', 'ok');
        setTimeout(schermataEntra, 1500);
      });
    secondo.append(codice.label, telefono ? null : nuova.label, passo2);
    mostra(telefono ? 'Ho perso il telefono' : 'Password dimenticata',
      telefono ? 'Ricevi un codice per email e colleghi un nuovo Google Authenticator. Password e file non cambiano.' : 'Ricevi un codice per email e scegli una password nuova.',
      utente.label, richiedi, secondo, link('Torna all\'accesso', schermataEntra));
  }

  if (!stato.initialized && stato.setupAllowed) schermataConfigurazione();
  else if (!stato.initialized) mostra('Configurazione da fare', 'La prima configurazione si fa dal PC che fa girare DiGiShare.');
  else schermataEntra();
})();
