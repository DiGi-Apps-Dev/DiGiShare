// Importazione delle registrazioni Zoom: app Server-to-Server OAuth di sola lettura,
// chiavi nel .env. Ogni 30 minuti si guarda l'elenco e si scarica solo cio' che non e' ancora stato importato.
// Cio' che si scarica finisce fra i file normali, quindi segue copertina, copia 1080p e IA come un caricamento.
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { leggiImpostazione, scriviImpostazione } from './db.js';

const GIORNO = 24 * 3600 * 1000;
const GIORNI_PER_RICHIESTA = 29; // Zoom accetta al massimo un mese per richiesta.
const RICHIESTE_STORICO = 13; // La prima volta si va indietro di circa 12 mesi.
const FALLIMENTI_PER_AVVISO = 3;
const ORE_FRA_AVVISI = 24;
const ESTENSIONE_PARZIALE = '.zoom-parziale';
// Il video completo per primo. Per ogni spezzone Zoom puo' produrre piu' viste: se ne tiene una sola.
const VISTE = ['shared_screen_with_speaker_view(CC)', 'shared_screen_with_speaker_view', 'shared_screen_with_gallery_view', 'speaker_view', 'active_speaker', 'gallery_view', 'shared_screen'];

const rango = (f) => { const i = VISTE.indexOf(f.recording_type); return i < 0 ? VISTE.length : i; };
const giornoUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const due = (n) => String(n).padStart(2, '0');

// Una riunione fermata e ripresa ha piu' spezzoni, ognuno con il suo inizio: ogni spezzone e' un video.
// Se la vista migliore e' ancora in lavorazione su Zoom lo spezzone si salta e si riprova al giro dopo.
export function spezzoniDa(riunione) {
  const gruppi = new Map();
  for (const f of riunione.recording_files ?? []) {
    if (String(f.file_type).toUpperCase() !== 'MP4' || f.deleted_time) continue;
    const inizio = f.recording_start || riunione.start_time || '';
    if (!gruppi.has(inizio)) gruppi.set(inizio, []);
    gruppi.get(inizio).push(f);
  }
  const inizi = [...gruppi.keys()].sort();
  return inizi.map((inizio, i) => {
    const file = [...gruppi.get(inizio)].sort((a, b) => rango(a) - rango(b))[0];
    return { chiave: `${riunione.uuid}|${inizio}`, inizio, file, parte: inizi.length > 1 ? i + 1 : 0 };
  }).filter((s) => s.file.status === 'completed' && s.file.download_url);
}

function nomi(riunione, spezzone) {
  const data = new Date(spezzone.inizio || riunione.start_time || Date.now());
  const argomento = String(riunione.topic ?? '').trim() || 'Riunione Zoom';
  const parte = spezzone.parte ? ` (parte ${spezzone.parte})` : '';
  return {
    titolo: `${argomento}${parte} · ${due(data.getDate())}.${due(data.getMonth() + 1)}.${data.getFullYear()}`,
    nome: `${argomento}${parte} ${data.getFullYear()}-${due(data.getMonth() + 1)}-${due(data.getDate())}.mp4`.replace(/[\\/:*?"<>|]/g, ' '),
  };
}

export function creaZoom({ db, env, cartellaFile, caricamenti, margineDisco, registra = () => {}, avvisa = () => {} }) {
  const accountId = (env.ZOOM_ACCOUNT_ID ?? '').trim();
  const clientId = (env.ZOOM_CLIENT_ID ?? '').trim();
  const clientSecret = (env.ZOOM_CLIENT_SECRET ?? '').trim();
  const utente = (env.ZOOM_UTENTE ?? '').trim();
  const configurato = Boolean(accountId && clientId && clientSecret && utente);
  // ZOOM_API e ZOOM_OAUTH servono solo alle prove, che parlano con uno Zoom finto.
  const api = (env.ZOOM_API ?? 'https://api.zoom.us/v2').replace(/\/+$/, '');
  const oauth = env.ZOOM_OAUTH ?? 'https://zoom.us/oauth/token';

  const chiusura = new AbortController();
  let token = null;
  let tokenScade = 0;
  let inCorso = false;
  let corrente = null;
  let falliteDiFila = 0;
  let ultimoAvviso = 0;

  const statoSalvato = () => leggiImpostazione(db, 'zoom_stato', {});
  const salvaStato = (modifiche) => scriviImpostazione(db, 'zoom_stato', { ...statoSalvato(), ...modifiche });

  // Il token va solo a Zoom, qualunque indirizzo arrivi nella risposta.
  function indirizzoDiZoom(indirizzo) {
    const u = new URL(indirizzo);
    if (u.origin === new URL(api).origin) return true;
    return u.protocol === 'https:' && (u.hostname === 'zoom.us' || u.hostname.endsWith('.zoom.us'));
  }

  async function chiediToken() {
    if (token && Date.now() < tokenScade) return token;
    const risposta = await fetch(oauth, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'account_credentials', account_id: accountId }),
      signal: AbortSignal.any([chiusura.signal, AbortSignal.timeout(60000)]),
    });
    const dati = await risposta.json().catch(() => ({}));
    if (!risposta.ok || !dati.access_token) throw new Error(`Zoom ha rifiutato le chiavi del .env (${risposta.status}).`);
    token = dati.access_token;
    tokenScade = Date.now() + (Number(dati.expires_in) || 3600) * 1000 - 60000;
    return token;
  }

  async function chiamaApi(percorso, ancora = true) {
    const risposta = await fetch(`${api}${percorso}`, {
      headers: { Authorization: `Bearer ${await chiediToken()}` },
      signal: AbortSignal.any([chiusura.signal, AbortSignal.timeout(60000)]),
    });
    if (risposta.status === 401 && ancora) { token = null; return chiamaApi(percorso, false); }
    const dati = await risposta.json().catch(() => ({}));
    if (!risposta.ok) throw new Error(`Zoom ha risposto ${risposta.status}: ${dati.message ?? 'errore'}`);
    return dati;
  }

  async function elencaRiunioni(giornate) {
    const riunioni = new Map();
    let fine = Date.now() + GIORNO;
    for (let r = 0; r < giornate; r++) {
      const inizio = fine - GIORNI_PER_RICHIESTA * GIORNO;
      let pagina = '';
      do {
        const parametri = new URLSearchParams({ from: giornoUtc(inizio), to: giornoUtc(fine), page_size: '100' });
        if (pagina) parametri.set('next_page_token', pagina);
        const dati = await chiamaApi(`/users/${encodeURIComponent(utente)}/recordings?${parametri}`);
        for (const m of dati.meetings ?? []) riunioni.set(m.uuid, m);
        pagina = dati.next_page_token ?? '';
      } while (pagina);
      fine = inizio - GIORNO;
    }
    // Dalla piu' vecchia, cosi' nell'elenco di DiGiShare la piu' recente resta in cima.
    return [...riunioni.values()].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  }

  function categoria() {
    const salvata = leggiImpostazione(db, 'zoom_categoria', null);
    const tutte = caricamenti.elencoCategorie();
    if (tutte.some((c) => c.id === salvata)) return salvata;
    const id = tutte.find((c) => c.nome.toLowerCase() === 'zoom')?.id ?? caricamenti.creaCategoria('Zoom', '');
    scriviImpostazione(db, 'zoom_categoria', id);
    return id;
  }

  async function scarica(riunione, spezzone) {
    const { file } = spezzone;
    const { titolo, nome } = nomi(riunione, spezzone);
    if (!indirizzoDiZoom(file.download_url)) throw new Error('Zoom ha indicato un indirizzo di scaricamento non suo.');
    const { libero } = await caricamenti.spazioDisco();
    if ((Number(file.file_size) || 0) + margineDisco > libero) throw new Error('Sul server non c\'è abbastanza spazio.');

    corrente = { titolo, ricevuti: 0, totale: Number(file.file_size) || 0 };
    const id = randomBytes(16).toString('hex');
    const parziale = path.join(cartellaFile, `${id}${ESTENSIONE_PARZIALE}`);
    const destinazione = path.join(cartellaFile, id);
    try {
      // Il redirect di Zoom porta allo scaricamento vero: fetch non vi ripete il token, perche' cambia origine.
      const risposta = await fetch(file.download_url, { headers: { Authorization: `Bearer ${await chiediToken()}` }, signal: chiusura.signal });
      if (!risposta.ok || !risposta.body) throw new Error(`Scaricamento rifiutato da Zoom (${risposta.status}).`);
      if (String(risposta.headers.get('content-type')).includes('text/html')) throw new Error('Zoom ha risposto con una pagina invece del video.');
      const atteso = Number(risposta.headers.get('content-length')) || 0;
      if (atteso) corrente.totale = atteso;
      await pipeline(Readable.fromWeb(risposta.body), async function* (sorgente) {
        for await (const pezzo of sorgente) { corrente.ricevuti += pezzo.length; yield pezzo; }
      }, createWriteStream(parziale, { flags: 'wx' }));
      const ricevuti = corrente.ricevuti;
      if (!ricevuti || (atteso && ricevuti !== atteso) || ricevuti < (Number(file.file_size) || 0) * 0.99) throw new Error('Il video è arrivato incompleto.');
      const handle = await fs.open(parziale, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(parziale, destinazione);
      caricamenti.registraEsterno({ id, nome, tipo: 'video/mp4', dimensione: ricevuti, titolo, categoriaId: categoria() }, () => {
        db.prepare('INSERT INTO zoom_importati (chiave, file_id, importato_il) VALUES (?, ?, ?)').run(spezzone.chiave, id, Date.now());
      });
    } catch (err) {
      await fs.rm(parziale, { force: true }).catch(() => {});
      throw err;
    } finally {
      corrente = null;
    }
  }

  function esitoCiclo(errori) {
    const adesso = Date.now();
    if (!errori.length) {
      if (falliteDiFila) registra('zoom_ripresa', '', 'importazione di nuovo a posto');
      falliteDiFila = 0;
      salvaStato({ ultimoControllo: adesso, ultimoRiuscito: adesso, errore: '' });
      return;
    }
    falliteDiFila++;
    salvaStato({ ultimoControllo: adesso, errore: errori[0] });
    if (falliteDiFila === 1) registra('zoom_fallito', '', errori[0]);
    if (falliteDiFila >= FALLIMENTI_PER_AVVISO && adesso - ultimoAvviso >= ORE_FRA_AVVISI * 3600 * 1000) {
      ultimoAvviso = adesso;
      registra('zoom_fallito', '', `${falliteDiFila} controlli di fila: ${errori[0]}`);
      avvisa('DiGiShare: importazione da Zoom ferma', `Le registrazioni Zoom non arrivano più in DiGiShare: ${errori[0]}`);
    }
  }

  // Un giro completo. Un video che fallisce non ferma gli altri e si riprova al giro dopo.
  async function controlla() {
    if (!configurato || inCorso) return false;
    inCorso = true;
    const errori = [];
    try {
      const giaFatto = db.prepare('SELECT 1 FROM zoom_importati WHERE chiave = ?');
      const storicoCompleto = Boolean(statoSalvato().storicoCompleto);
      for (const riunione of await elencaRiunioni(storicoCompleto ? 1 : RICHIESTE_STORICO)) {
        for (const spezzone of spezzoniDa(riunione).filter((s) => !giaFatto.get(s.chiave))) {
          try {
            await scarica(riunione, spezzone);
          } catch (err) {
            if (chiusura.signal.aborted) throw err;
            errori.push(`«${nomi(riunione, spezzone).titolo}»: ${err.message}`);
          }
        }
      }
      // Lo storico si considera finito solo senza errori: dopo si guarda solo l'ultimo mese.
      if (!errori.length) salvaStato({ storicoCompleto: true });
    } catch (err) {
      if (chiusura.signal.aborted) return false;
      errori.push(err.message);
    } finally {
      inCorso = false;
    }
    esitoCiclo(errori);
    return true;
  }

  function avvia() {
    if (!configurato || inCorso) return false;
    controlla().catch((err) => console.error('Importazione da Zoom:', err.message));
    return true;
  }

  // Uno spegnimento a meta' scaricamento lascia un file parziale che nessuno riprenderebbe.
  async function pulisciParziali() {
    for (const nome of await fs.readdir(cartellaFile)) {
      if (nome.endsWith(ESTENSIONE_PARZIALE)) await fs.rm(path.join(cartellaFile, nome), { force: true });
    }
  }

  function stato() {
    const s = statoSalvato();
    const { importati, ultima } = db.prepare('SELECT COUNT(*) AS importati, MAX(importato_il) AS ultima FROM zoom_importati').get();
    return { configurato, inCorso, corrente, importati, ultimaImportazione: ultima, ultimoControllo: s.ultimoControllo ?? null, ultimoRiuscito: s.ultimoRiuscito ?? null, errore: s.errore ?? '' };
  }

  return { configurato, controlla, avvia, stato, pulisciParziali, ferma: () => chiusura.abort() };
}
