'use strict';
(async () => {
  const { api, sessione, el, avviso, quando, esci, conferma } = DG;
  const $ = (id) => document.getElementById(id);
  const messaggio = $('messaggio');
  const dire = (testo, tipo = 'ok') => { avviso(messaggio, testo, tipo); window.scrollTo({ top: 0 }); };
  const protetto = (azione) => async (e) => {
    e?.preventDefault?.();
    try { await azione(); } catch (err) { dire(err.message, 'errore'); }
  };

  await sessione();
  $('esci').addEventListener('click', esci);

  // ---- notifiche ----
  const chiaveInByte = (base64) => Uint8Array.from(atob((base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function abbonamento() {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function disegnaNotifiche() {
    const stato = $('push-stato'); const interruttore = $('push-interruttore'); const prova = $('push-prova');
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      stato.textContent = 'Questo browser non riceve notifiche. Sul telefono usa l\'app installata da Chrome.';
      return;
    }
    if (Notification.permission === 'denied') {
      stato.textContent = 'Bloccate per questo sito. Si riattivano da Chrome: Impostazioni sito, Notifiche.';
      interruttore.hidden = true; prova.hidden = true;
      return;
    }
    const ab = await abbonamento();
    stato.textContent = ab ? 'Accese' : 'Spente';
    interruttore.textContent = ab ? 'Spegni' : 'Accendi';
    interruttore.hidden = false;
    prova.hidden = !ab;
  }
  $('push-interruttore').addEventListener('click', protetto(async () => {
    const ab = await abbonamento();
    if (ab) {
      await api('/api/push/disdici', { method: 'POST', body: { endpoint: ab.endpoint } });
      await ab.unsubscribe();
      dire('Notifiche spente su questo telefono.');
    } else {
      if (await Notification.requestPermission() !== 'granted') { await disegnaNotifiche(); return; }
      // La prima volta il servizio di Google può metterci qualche decina di secondi: si dice che sta lavorando.
      $('push-stato').textContent = 'Sto accendendo le notifiche…';
      const { chiave } = await api('/api/push/stato');
      const reg = await navigator.serviceWorker.ready;
      const nuovo = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chiaveInByte(chiave) });
      await api('/api/push/abbonati', { method: 'POST', body: nuovo.toJSON() });
      dire('Notifiche accese su questo telefono.');
    }
    await disegnaNotifiche();
  }));
  $('push-prova').addEventListener('click', protetto(async () => {
    const ab = await abbonamento();
    if (!ab) throw new Error('Le notifiche non sono accese su questo telefono.');
    const r = await api('/api/push/prova', { method: 'POST', body: { endpoint: ab.endpoint } });
    dire(r.inviate ? 'Notifica di prova mandata a questo telefono.' : 'Non è partita: riprova fra poco.', r.inviate ? 'ok' : 'errore');
  }));
  disegnaNotifiche().catch(() => {});

  // ---- backup ----
  const mostraCampiBackup = () => {
    const f = $('bk-frequenza').value;
    $('bk-campo-settimana').hidden = f !== 'weekly';
    $('bk-campo-mese').hidden = f !== 'monthly';
  };
  async function caricaBackup() {
    const b = await api('/api/backup');
    $('backup-ultimo').textContent = b.ultimo ? `${quando(b.ultimo)} · ${b.copie} ${b.copie === 1 ? 'copia conservata' : 'copie conservate'} in ${b.cartella}` : 'Nessun backup ancora fatto';
    const i = b.impostazioni;
    $('bk-attivo').checked = i.enabled;
    $('bk-frequenza').value = i.frequency;
    $('bk-settimana').value = String(i.dayOfWeek);
    $('bk-mese').value = i.dayOfMonth;
    $('bk-ora').value = `${String(i.hour).padStart(2, '0')}:${String(i.minute).padStart(2, '0')}`;
    mostraCampiBackup();
  }
  $('bk-frequenza').addEventListener('change', mostraCampiBackup);
  $('backup-programma').addEventListener('submit', protetto(async () => {
    const [ora, minuto] = $('bk-ora').value.split(':').map(Number);
    await api('/api/backup', { method: 'PUT', body: { enabled: $('bk-attivo').checked, frequency: $('bk-frequenza').value, dayOfWeek: Number($('bk-settimana').value), dayOfMonth: Number($('bk-mese').value), hour: ora, minute: minuto } });
    dire('Programmazione del backup salvata.');
  }));
  $('backup-ora').addEventListener('click', protetto(async () => {
    $('backup-ora').disabled = true;
    try {
      const r = await api('/api/backup/ora', { method: 'POST', body: {} });
      dire(`Backup creato: ${r.nome}`);
      await caricaBackup();
    } finally {
      $('backup-ora').disabled = false;
    }
  }));
  $('ripristino').addEventListener('submit', protetto(async () => {
    const file = $('rs-file').files[0];
    if (!file) throw new Error('Scegli il file di backup (.enc).');
    if (!await conferma(`Elenco e impostazioni di adesso saranno sostituiti da quelli di «${file.name}». Password e Authenticator restano quelli attuali. L'app si riavvia.`, { titolo: 'Importare il backup?', ok: 'Importa', pericolo: true })) return;
    const { grant } = await api('/api/backup/ripristino/autorizza', { method: 'POST', body: { password: $('rs-password').value, code: $('rs-codice').value.trim() } });
    await api('/api/backup/ripristino', { method: 'POST', headers: { 'x-restore-grant': grant, 'content-type': 'application/octet-stream' }, body: file });
    dire('Backup importato. L\'app si sta riavviando: fra qualche secondo ricarica la pagina (sul PC riapri «Apri DiGiShare»).');
  }));

  // ---- zoom ----
  function testoZoom(z) {
    if (!z.configurato) return 'Zoom non è collegato: mancano le chiavi nel .env.';
    if (z.corrente) return `Sto scaricando «${z.corrente.titolo}»${z.corrente.totale ? `: ${Math.floor(z.corrente.ricevuti / z.corrente.totale * 100)}%` : ''}`;
    if (z.inCorso) return 'Sto controllando le registrazioni…';
    const parti = [z.ultimaImportazione ? `${quando(z.ultimaImportazione)} · ${z.importati} ${z.importati === 1 ? 'registrazione importata' : 'registrazioni importate'}` : 'Nessuna registrazione importata ancora'];
    if (z.ultimoControllo) parti.push(`ultimo controllo ${quando(z.ultimoControllo)}`);
    if (z.errore) parti.push(`problema: ${z.errore}`);
    return parti.join(' · ');
  }
  let attesaZoom = null;
  async function caricaZoom() {
    const z = await api('/api/zoom');
    $('zoom-stato').textContent = testoZoom(z);
    $('zoom-importa').disabled = !z.configurato || z.inCorso;
    clearTimeout(attesaZoom);
    if (z.inCorso) attesaZoom = setTimeout(() => caricaZoom().catch(() => {}), 3000);
  }
  $('zoom-importa').addEventListener('click', protetto(async () => {
    await api('/api/zoom/importa', { method: 'POST', body: {} });
    await caricaZoom();
  }));

  // ---- accesso ----
  async function caricaDispositivi() {
    const { devices } = await api('/api/auth/devices');
    const box = $('dispositivi');
    box.replaceChildren();
    if (!devices.length) {
      box.append(el('p', 'sotto', 'Nessun dispositivo ricordato.'));
      return;
    }
    const ul = el('ul', 'elenco-semplice');
    for (const d of devices) {
      const li = el('li');
      li.append(el('b', '', d.label), el('span', '', ` · ultimo uso ${quando(d.last_used)} · scade ${quando(d.expires_at)}`));
      ul.append(li);
    }
    box.append(ul);
  }
  $('dimentica-dispositivi').addEventListener('click', protetto(async () => {
    if (!await conferma('Al prossimo accesso servirà di nuovo il codice Authenticator.', { titolo: 'Dimenticare i dispositivi ricordati?', ok: 'Dimentica' })) return;
    await api('/api/auth/devices/forget', { method: 'POST', body: {} });
    dire('Dispositivi dimenticati.');
    await caricaDispositivi();
  }));
  $('chiudi-sessioni').addEventListener('click', protetto(async () => {
    if (!await conferma('Questo dispositivo resta dentro.', { titolo: 'Chiudere tutte le altre sessioni?', ok: 'Chiudi le altre' })) return;
    await api('/api/auth/logout-all', { method: 'POST', body: {} });
    dire('Le altre sessioni sono state chiuse.');
  }));
  $('cambio-password').addEventListener('submit', protetto(async () => {
    await api('/api/auth/password', { method: 'POST', body: { currentPassword: $('cp-attuale').value, newPassword: $('cp-nuova').value, code: $('cp-codice').value.trim() } });
    $('cambio-password').reset();
    dire('Password cambiata. Le altre sessioni e i dispositivi ricordati sono stati chiusi.');
  }));

  await Promise.all([caricaBackup(), caricaZoom(), caricaDispositivi()]).catch((err) => dire(err.message, 'errore'));
})();
