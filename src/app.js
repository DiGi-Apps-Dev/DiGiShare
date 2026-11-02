import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { apriDb, leggiImpostazione, scriviImpostazione } from './db.js';
import { creaCaricamenti, PERCORSO } from './caricamenti.js';
import { creaMiniature } from './miniature.js';
import { creaVideo } from './video.js';
import { creaIa, segmentiInVtt } from './ia.js';
import { creaCondivisione } from './condivisione.js';
import { creaNote } from './note.js';
import { creaZoom } from './zoom.js';
import { creaNotifiche } from './notifiche.js';
import { createSecurity } from './sicurezza.js';
import { createMailer } from './posta.js';
import { createProxyTrust } from './proxy.js';
import { createBackup, stageRestore, applyPendingRestore, newestBackupTime, listBackups, backupOverdue, startBackupScheduler, normalizeBackupSettings, BACKUP_DEFAULTS } from './backup.js';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBBLICA = path.join(RADICE, 'public');
const LOGO = path.join(RADICE, 'assets', 'logo');
const TUS_CLIENT = path.join(RADICE, 'node_modules', 'tus-js-client', 'dist', 'tus.min.js');
export const VERSIONE_ICONE = 5;

const GB = 1000 ** 3;
const MINUTO = 60 * 1000;
const ORA = 60 * MINUTO;
const SETTE_GIORNI = 7 * 24 * ORA;
const normalizzaIp = (v) => String(v || '').replace(/^::ffff:/, '');

const INTESTAZIONI_SICUREZZA = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function leggiConfigurazione(env = process.env) {
  const cartellaDati = path.resolve(env.CARTELLA_DATI ?? path.join(RADICE, 'dati'));
  return {
    porta: Number(env.PORTA ?? 5043),
    indirizzo: env.INDIRIZZO ?? '127.0.0.1',
    cartellaDati,
    cartellaBackup: path.resolve(env.CARTELLA_BACKUP ?? path.join(RADICE, 'backups')),
    dimensioneMassima: Number(env.MASSIMO_GB ?? 50) * GB,
    margineDisco: Number(env.MARGINE_DISCO_GB ?? 5) * GB,
    chiave: env.DIGISHARE_AUTH_KEY ?? '',
    // 1 solo per la configurazione iniziale sul server; sul PC la configurazione si fa da 127.0.0.1.
    configurazioneOvunque: env.DIGISHARE_ALLOW_SETUP === '1',
    proxyFidato: (env.PROXY_FIDATO ?? '').trim(),
    ffmpeg: env.FFMPEG ?? 'ffmpeg',
    ffprobe: env.FFPROBE ?? 'ffprobe',
    // Indirizzo con cui i link escono; vuoto = quello della richiesta.
    indirizzoPubblico: (env.INDIRIZZO_PUBBLICO ?? '').replace(/\/+$/, ''),
  };
}

export async function creaApp(config, env = process.env) {
  const cartellaFile = path.join(config.cartellaDati, 'file');
  const cartellaMiniature = path.join(config.cartellaDati, 'miniature');
  const cartellaVisione = path.join(config.cartellaDati, 'visione');
  const cartellaAudio = path.join(config.cartellaDati, 'audio');
  const cartellaSottotitoli = path.join(config.cartellaDati, 'sottotitoli');
  const cartellaPulito = path.join(config.cartellaDati, 'pulito');
  for (const c of [cartellaFile, cartellaMiniature, cartellaVisione, cartellaAudio, cartellaSottotitoli, cartellaPulito]) fs.mkdirSync(c, { recursive: true });
  // Un ripristino chiesto dall'app si installa qui, prima che qualunque database sia aperto.
  const ripristinato = applyPendingRestore(config.cartellaDati);

  const db = apriDb(config.cartellaDati);
  const posta = createMailer(env);
  const sicurezza = createSecurity({ dataDir: config.cartellaDati, secret: config.chiave, secure: false, allowSetup: true, mailer: posta });
  const proxy = config.proxyFidato ? createProxyTrust({ hostname: config.proxyFidato, onWarning: (m) => console.warn(m) }) : null;
  if (ripristinato) sicurezza.log('backup_ripristinato', '', "installato all'avvio");

  const registraEvento = (tipo, indirizzo, dettaglio) => sicurezza.log(tipo, indirizzo, dettaglio);
  const ia = creaIa(env);
  let indirizzoRichiesta = `http://${config.indirizzo}:${config.porta}`;
  const indirizzoPubblico = () => config.indirizzoPubblico || indirizzoRichiesta;
  const condivisione = creaCondivisione({ db, posta, indirizzoPubblico, registra: registraEvento });
  const notifiche = creaNotifiche({ db, env, indirizzo: indirizzoPubblico, registra: registraEvento });

  // Dopo la copia per la visione: sottotitoli, capitoli e descrizione con l'IA (se le chiavi ci sono).
  async function lavoraIa(id) {
    if (!ia.disponibile) return;
    const f = db.prepare('SELECT durata, titolo, descrizione, ia FROM file WHERE id = ? AND cestinato_il IS NULL').get(id);
    if (!f || f.ia === 1) return;
    let audio;
    try {
      audio = await video.estraiAudio(id);
      const segmenti = await ia.trascrivi(audio);
      if (!segmenti.length) throw new Error('trascrizione vuota');
      fs.writeFileSync(path.join(cartellaSottotitoli, `${id}.vtt`), segmentiInVtt(segmenti));
      const { descrizione, capitoli } = await ia.capitoliEDescrizione(segmenti, f.titolo, f.durata);
      db.prepare('UPDATE file SET sottotitoli = 1, capitoli = ?, descrizione = CASE WHEN COALESCE(descrizione, \'\') = \'\' THEN ? ELSE descrizione END, ia = 1 WHERE id = ?').run(JSON.stringify(capitoli), descrizione, id);
      registraEvento('ia_completata', '', `${f.titolo}: ${capitoli.length} capitoli`);
    } catch (err) {
      console.error(`IA su ${id}: ${err.message}`);
      db.prepare('UPDATE file SET ia = -1 WHERE id = ?').run(id);
      registraEvento('ia_fallita', '', `${f.titolo}: ${err.message.slice(0, 120)}`);
    } finally {
      if (audio) fs.rmSync(audio, { force: true });
    }
  }
  // Il video è pronto quando è finito anche il lavoro dell'IA, riuscito o no: si può guardare comunque.
  async function videoFinito(id) {
    try {
      await lavoraIa(id);
    } finally {
      const f = db.prepare('SELECT titolo FROM file WHERE id = ? AND cestinato_il IS NULL').get(id);
      if (f) await notifiche.aTutti({ titolo: 'Video pronto', testo: f.titolo, url: `/?file=${id}` });
    }
  }
  const note = creaNote({ db, ia, posta, cartellaFile, cartellaAudio, cartellaPulito, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, deepFilter: env.DEEPFILTER ?? '', indirizzoPubblico, registra: registraEvento, notifica: notifiche.aTutti, somiglianzaVoce: env.VOCE_URL ? async (file) => {
    const r = await fetch(env.VOCE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }), signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`Voce HTTP ${r.status}`);
    return (await r.json()).somiglianza;
  } : null });
  const video = creaVideo({ db, cartellaFile, cartellaVisione, cartellaAudio, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, dopoVisione: videoFinito, registra: registraEvento });
  const miniature = creaMiniature({ db, cartellaFile, cartellaMiniature, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, dopo: video.accoda });
  const caricamenti = creaCaricamenti({
    db, cartellaFile, cartellaMiniature, dimensioneMassima: config.dimensioneMassima, margineDisco: config.margineDisco,
    dopoRegistrazione: miniature.accoda, dopoAudio: (id, metadati) => note.accoda(id, metadati?.genere), registra: registraEvento,
    altriFileDi: (id) => [path.join(cartellaVisione, `${id}.mp4`), path.join(cartellaAudio, `${id}.ogg`), path.join(cartellaSottotitoli, `${id}.vtt`), path.join(cartellaPulito, `${id}.ogg`)],
  });
  const ffmpegPresente = await miniature.strumentiPresenti();
  if (!ffmpegPresente) console.warn('DiGiShare: ffmpeg o ffprobe non trovati, i video restano senza copertina.');

  // ---- indirizzo del client e cookie sicuri: solo il proxy fidato puo' dire chi c'e' dietro ----
  const dalProxy = (req) => Boolean(proxy?.has(normalizzaIp(req.socket.remoteAddress)));
  function indirizzoClient(req) {
    const remoto = normalizzaIp(req.socket.remoteAddress);
    if (dalProxy(req)) {
      const vero = normalizzaIp(req.headers['x-real-ip']);
      if (isIP(vero)) return vero;
    }
    return remoto;
  }
  const richiestaSicura = (req) => dalProxy(req) && req.headers['x-forwarded-proto'] === 'https';
  const daQuestoPc = (req) => ['127.0.0.1', '::1'].includes(normalizzaIp(req.socket.remoteAddress)) && !dalProxy(req);
  const cookieDi = (req, nome) => String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${nome}=`))?.slice(nome.length + 1) || '';
  const aggiungiCookie = (res, valori) => res.append('Set-Cookie', (Array.isArray(valori) ? valori : [valori]).filter(Boolean));

  // ---- backup (standard app, punti 9-11 e 14) ----
  const impostazioniBackup = () => { try { return normalizeBackupSettings(leggiImpostazione(db, 'backup', {})); } catch { return { ...BACKUP_DEFAULTS }; } };
  const avvisa = (oggetto, testo) => { if (posta.configured) posta.send(oggetto, testo).catch(() => {}); };
  let backupInCorso = false;
  async function backupAdesso() {
    if (backupInCorso) throw new Error('Un backup è già in corso.');
    backupInCorso = true;
    try {
      return await createBackup({ dataDir: config.cartellaDati, backupDir: config.cartellaBackup, secret: config.chiave });
    } catch (err) {
      sicurezza.log('backup_fallito', '', err.message);
      avvisa('DiGiShare: backup fallito', `Backup non riuscito: ${err.message}`);
      throw err;
    } finally {
      backupInCorso = false;
    }
  }
  const avviatoIl = Date.now();
  let ultimoAvvisoRitardo = 0;
  function controllaRitardoBackup() {
    const inRitardo = backupOverdue({ settings: impostazioniBackup(), newestMs: newestBackupTime(config.cartellaBackup), sinceMs: avviatoIl, now: Date.now() });
    if (!inRitardo || Date.now() - ultimoAvvisoRitardo < 24 * ORA) return;
    ultimoAvvisoRitardo = Date.now();
    sicurezza.log('backup_in_ritardo');
    avvisa('DiGiShare: backup non eseguito', 'Il backup automatico di DiGiShare non risulta eseguito nei tempi previsti. Controlla le impostazioni di backup o creane uno a mano.');
  }
  const permessiRipristino = new Map();

  // ---- l'app smette di funzionare (punto 15): dopo alcuni intoppi di fila, non al primo ----
  let scrittureFallite = 0;
  let ultimoAvvisoFermo = 0;
  async function controllaSalute() {
    const adesso = Date.now();
    try {
      scriviImpostazione(db, 'battito', adesso);
      scrittureFallite = 0;
    } catch {
      scrittureFallite++;
    }
    let problema = '';
    if (scrittureFallite >= 3) problema = 'il database non accetta più scritture';
    else if (miniature.falliteDiFila() >= 5) problema = 'le copertine dei video falliscono una dopo l\'altra (ffmpeg)';
    else {
      try {
        const { libero } = await caricamenti.spazioDisco();
        if (libero < config.margineDisco) problema = `sul server restano solo ${(libero / GB).toFixed(1)} GB: i caricamenti vengono rifiutati`;
      } catch {
        problema = 'la cartella dei file non è raggiungibile';
      }
    }
    if (!problema || adesso - ultimoAvvisoFermo < 6 * ORA) return problema;
    ultimoAvvisoFermo = adesso;
    sicurezza.log('app_ferma', '', problema);
    avvisa('DiGiShare: l\'app ha un problema', `DiGiShare ha un problema: ${problema}.`);
    return problema;
  }

  await caricamenti.recupera();
  if (ffmpegPresente) { miniature.riprendi(); video.riprendi(); video.togliCopieInutili().catch((err) => console.error(`Copie: ${err.message}`)); }
  if (ia.disponibile && ffmpegPresente) note.riprendi();
  if (ia.disponibile && ffmpegPresente) for (const { id } of db.prepare("SELECT id FROM file WHERE visione = 1 AND ia = 0 AND tipo LIKE 'video/%' AND cestinato_il IS NULL").all()) videoFinito(id).catch(() => {});
  await caricamenti.pulisciInterrotti(SETTE_GIORNI);
  await caricamenti.svuotaCestinoVecchio();
  const zoom = creaZoom({ db, env, cartellaFile, caricamenti, margineDisco: config.margineDisco, registra: registraEvento, avvisa });
  await zoom.pulisciParziali();
  const programmatore = startBackupScheduler({ getSettings: impostazioniBackup, run: async () => { await backupAdesso(); sicurezza.log('backup_creato', '', 'automatico'); }, lastBackupMs: () => newestBackupTime(config.cartellaBackup) });
  const timer = [
    setInterval(() => {
      caricamenti.pulisciInterrotti(SETTE_GIORNI).catch((err) => console.error('Pulizia dei caricamenti interrotti:', err.message));
      caricamenti.svuotaCestinoVecchio().catch((err) => console.error('Svuotamento del cestino:', err.message));
    }, ORA),
    setInterval(controllaRitardoBackup, ORA),
    setInterval(() => controllaSalute().catch(() => {}), 5 * MINUTO),
    setInterval(() => {
      condivisione.promemoriaScadenze((l) => db.prepare('SELECT COALESCE(titolo, nome) AS t FROM file WHERE id = ?').get(l.fileId)?.t ?? db.prepare('SELECT nome FROM categorie WHERE id = ?').get(l.categoriaId)?.nome ?? 'link').catch((err) => console.error('Promemoria scadenze:', err.message));
      condivisione.proponiArchiviazione((b) => `${(b / GB).toFixed(1)} GB`).catch((err) => console.error('Archiviazione:', err.message));
    }, 6 * ORA),
    ...(zoom.configurato ? [setTimeout(() => zoom.avvia(), MINUTO), setInterval(() => zoom.avvia(), 30 * MINUTO)] : []),
  ];
  timer.forEach((t) => t.unref());

  // ---- l'app ----
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'weak');
  app.use((req, res, next) => {
    res.set(INTESTAZIONI_SICUREZZA);
    res.set('Cache-Control', 'no-store');
    // Senza INDIRIZZO_PUBBLICO i link si costruiscono con l'indirizzo con cui l'utente apre il pannello.
    if (!config.indirizzoPubblico && req.headers.host) indirizzoRichiesta = `${richiestaSicura(req) ? 'https' : 'http'}://${req.headers.host}`;
    next();
  });
  // Anti-CSRF: origine della richiesta. Dietro il proxy l'Host puo' arrivare con o senza :8446, si confronta il solo nome.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Origine non consentita.' });
    const origine = req.headers.origin;
    if (!origine) return next();
    try {
      if (new URL(origine).hostname === new URL(`http://${req.headers.host}`).hostname) return next();
    } catch { /* origine non valida */ }
    res.status(403).json({ error: 'Origine non consentita.' });
  });
  const json = express.json({ limit: '64kb' });
  const ID_VALIDO = /^[0-9a-f]{32}$/;

  app.get('/stato', (req, res) => res.json({ ok: true, app: 'digishare' }));

  // ---- accesso: rotte pubbliche ----
  const statoAccesso = (req) => ({
    initialized: sicurezza.initialized(),
    setupAllowed: sicurezza.setupAllowed() && (config.configurazioneOvunque || daQuestoPc(req)),
    emailConfigured: posta.configured,
  });
  app.get('/api/auth/status', (req, res) => res.json(statoAccesso(req)));
  app.post('/api/auth/setup/start', json, async (req, res, next) => {
    try {
      if (!statoAccesso(req).setupAllowed) return res.status(403).json({ error: 'La configurazione iniziale si fa dal PC che fa girare DiGiShare.' });
      res.json(await sicurezza.startSetup(req.body?.username || 'admin'));
    } catch (err) { next(err); }
  });
  app.post('/api/auth/setup/complete', json, async (req, res, next) => {
    try {
      if (!statoAccesso(req).setupAllowed) return res.status(403).json({ error: 'Configurazione iniziale non disponibile.' });
      const r = await sicurezza.completeSetup(req.body, indirizzoClient(req), richiestaSicura(req));
      aggiungiCookie(res, r.cookie);
      res.json({ csrf: r.csrf });
    } catch (err) { next(err); }
  });
  app.post('/api/auth/login', json, async (req, res, next) => {
    try {
      const on = richiestaSicura(req);
      const r = await sicurezza.login(req.body, indirizzoClient(req), cookieDi(req, sicurezza.cookieNames(on).device), String(req.headers['user-agent'] || ''), on);
      aggiungiCookie(res, r.deviceCookie ? [r.cookie, r.deviceCookie] : r.cookie);
      res.json({ csrf: r.csrf });
    } catch (err) { next(err); }
  });
  app.post('/api/auth/recovery/request', json, async (req, res, next) => {
    try { res.json(await sicurezza.requestRecovery(req.body, indirizzoClient(req))); } catch (err) { next(err); }
  });
  app.post('/api/auth/recovery/password', json, async (req, res, next) => {
    try { await sicurezza.resetPassword(req.body, indirizzoClient(req)); res.json({ ok: true }); } catch (err) { next(err); }
  });
  app.post('/api/auth/recovery/phone/start', json, async (req, res, next) => {
    try { res.json(await sicurezza.startPhoneReset(req.body, indirizzoClient(req))); } catch (err) { next(err); }
  });
  app.post('/api/auth/recovery/phone/complete', json, async (req, res, next) => {
    try { await sicurezza.completePhoneReset(req.body, indirizzoClient(req)); res.json({ ok: true }); } catch (err) { next(err); }
  });

  // ---- pagina di visione: pubblica, raggiungibile solo con il codice del link ----
  const CODICE = /^[A-Za-z0-9]{6,16}$/;
  const fileDelLink = (l, fileId) => {
    if (l.fileId) return fileId && fileId !== l.fileId ? null : caricamenti.conCapitoli(caricamenti.trova(l.fileId));
    const f = fileId && ID_VALIDO.test(fileId) ? caricamenti.conCapitoli(caricamenti.trova(fileId)) : null;
    return f && f.categoriaId === l.categoriaId && !f.cestinatoIl ? f : null;
  };
  const linkAttivo = (req, res) => {
    if (!CODICE.test(req.params.codice)) { res.status(404).end(); return null; }
    const l = condivisione.trovaCodice(req.params.codice);
    if (!l || l.stato !== 'attivo') { res.status(l ? 410 : 404).json({ error: l ? 'Link scaduto o revocato.' : 'Link inesistente.', stato: l ? l.stato : 'inesistente' }); return null; }
    return l;
  };
  const datiNota = (f) => { if (!f.tipo.startsWith('audio/')) return null; const n = note.nota(f.id); return n?.stato === 'pronta' ? { riassunto: n.riassunto, segmenti: n.segmenti } : null; };
  const datiPubblici = (f) => ({ nota: datiNota(f), audio: f.tipo.startsWith('audio/'), id: f.id, titolo: f.titolo, descrizione: f.descrizione, durata: f.durata, dimensione: f.dimensione, tipo: f.tipo, video: f.tipo.startsWith('video/'), copertina: f.miniatura === 1, sottotitoli: f.sottotitoli === 1, capitoli: f.capitoli, caricatoIl: f.caricatoIl, pronto: f.visione === 1 });
  app.get('/v/:codice', (req, res) => {
    if (!CODICE.test(req.params.codice)) return res.status(404).send('Non trovato');
    // Anteprima di WhatsApp e simili: vogliono un indirizzo completo per l'immagine. Non conta come apertura del link.
    const base = (config.indirizzoPubblico || indirizzoRichiesta).replace(/["<>&]/g, '');
    const anteprima = `<meta property="og:type" content="website">
<meta property="og:site_name" content="DiGiShare">
<meta property="og:title" content="DiGiShare">
<meta property="og:image" content="${base}/icona-192-v${VERSIONE_ICONE}.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="192">
<meta property="og:image:height" content="192">`;
    res.type('html').send(fs.readFileSync(path.join(PUBBLICA, 'visione.html'), 'utf8').replace('<title>DiGiShare</title>', `<title>DiGiShare</title>\n${anteprima}`));
  });
  app.get('/v/:codice/dati', (req, res) => {
    if (!CODICE.test(req.params.codice)) return res.status(404).json({ error: 'Link inesistente.', stato: 'inesistente' });
    const { link: l, stato } = condivisione.apri(req.params.codice, { indirizzo: indirizzoClient(req), agent: String(req.headers['user-agent'] || ''), visita: String(req.query.visita || '') });
    if (stato !== 'attivo') return res.status(l ? 410 : 404).json({ error: l ? 'Link scaduto o revocato.' : 'Link inesistente.', stato });
    if (l.fileId) {
      const f = fileDelLink(l);
      if (!f || f.cestinatoIl) return res.status(410).json({ error: 'Il file non c\'è più.', stato: 'rimosso' });
      return res.json({ tipo: 'file', scarica: l.scarica, file: datiPubblici(f) });
    }
    const categoria = db.prepare('SELECT nome FROM categorie WHERE id = ?').get(l.categoriaId);
    if (!categoria) return res.status(410).json({ error: 'La cartella non c\'è più.', stato: 'rimosso' });
    res.json({ tipo: 'cartella', nome: categoria.nome, scarica: l.scarica, file: caricamenti.elencoCategoria(l.categoriaId).map(datiPubblici) });
  });
  app.post('/v/:codice/visto', express.json({ limit: '2kb' }), (req, res) => {
    if (!CODICE.test(req.params.codice)) return res.status(404).end();
    condivisione.visto(req.params.codice, req.body?.visita, req.body?.secondi, ID_VALIDO.test(req.body?.file ?? '') ? req.body.file : null);
    res.status(204).end();
  });
  const servi = (res, file, opzioni = {}) => res.sendFile(file, { acceptRanges: true, cacheControl: false, ...opzioni }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  app.get('/v/:codice/f/:fileId/video', (req, res) => {
    const l = linkAttivo(req, res); if (!l) return;
    const f = fileDelLink(l, req.params.fileId);
    if (!f || !f.tipo.startsWith('video/')) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    // La copia leggera se c'è (video più grandi di 1080p); altrimenti l'originale.
    const pronto = path.join(cartellaVisione, `${f.id}.mp4`);
    if (f.visione === 1 && fs.existsSync(pronto)) return servi(res, pronto, { headers: { 'Content-Type': 'video/mp4' } });
    servi(res, path.join(cartellaFile, f.id), { headers: { 'Content-Type': f.tipo } });
  });
  app.get('/v/:codice/f/:fileId/audio', (req, res) => {
    const l = linkAttivo(req, res); if (!l) return;
    const f = fileDelLink(l, req.params.fileId);
    if (!f || !f.tipo.startsWith('audio/')) return res.status(404).end();
    res.set('Cache-Control', 'private, no-cache');
    const pulito = note.audioDa(f.id);
    servi(res, pulito ?? path.join(cartellaFile, f.id), { headers: { 'Content-Type': pulito ? 'audio/ogg' : f.tipo } });
  });
  app.get('/v/:codice/f/:fileId/scarica', (req, res) => {
    const l = linkAttivo(req, res); if (!l) return;
    const f = fileDelLink(l, req.params.fileId);
    if (!f) return res.status(404).end();
    if (!l.scarica) return res.status(403).json({ error: 'Lo scaricamento non è permesso per questo link.' });
    res.set('Cache-Control', 'private, no-cache');
    res.download(path.join(cartellaFile, f.id), f.nome, { headers: { 'Content-Type': f.tipo } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.get('/v/:codice/f/:fileId/copertina', (req, res) => {
    const l = linkAttivo(req, res); if (!l) return;
    const f = fileDelLink(l, req.params.fileId);
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    servi(res, path.join(cartellaMiniature, `${f.id}.jpg`));
  });
  app.get('/v/:codice/f/:fileId/sottotitoli.vtt', (req, res) => {
    const l = linkAttivo(req, res); if (!l) return;
    const f = fileDelLink(l, req.params.fileId);
    if (!f || f.sottotitoli !== 1) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    servi(res, path.join(cartellaSottotitoli, `${f.id}.vtt`), { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
  });

  // ---- da qui serve la sessione, e per scrivere anche il token anti-CSRF ----
  function serveSessione(req, res, next) {
    req.sessione = sicurezza.current(req, richiestaSicura(req));
    if (!req.sessione) return res.status(401).json({ error: 'Accedi per continuare.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== req.sessione.csrf) {
      return res.status(403).json({ error: 'Sessione non valida. Ricarica la pagina.' });
    }
    next();
  }
  app.use('/api', serveSessione);

  app.get('/api/auth/me', (req, res) => res.json({ csrf: req.sessione.csrf, ...sicurezza.profile(), ffmpeg: ffmpegPresente }));
  app.post('/api/auth/logout', (req, res) => {
    aggiungiCookie(res, sicurezza.logout(req.sessione, indirizzoClient(req), richiestaSicura(req)));
    res.json({ ok: true });
  });
  app.post('/api/auth/logout-all', (req, res) => { sicurezza.logoutAll(req.sessione, indirizzoClient(req)); res.json({ ok: true }); });
  app.get('/api/auth/devices', (req, res) => res.json({ devices: sicurezza.listDevices() }));
  app.post('/api/auth/devices/forget', (req, res) => {
    aggiungiCookie(res, sicurezza.forgetDevices(indirizzoClient(req), richiestaSicura(req)));
    res.json({ ok: true });
  });
  app.post('/api/auth/password', json, async (req, res, next) => {
    try { await sicurezza.changePassword(req.body, req.sessione, indirizzoClient(req)); res.json({ ok: true }); } catch (err) { next(err); }
  });
  app.get('/api/registro', (req, res) => res.json({ eventi: sicurezza.events(200) }));

  // ---- caricamenti tus: solo creazione, stato, invio e annullamento ----
  const gestisciTus = (req, res, next) => {
    if (!['HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).end();
    delete req.headers['x-http-method-override'];
    caricamenti.tus.handle(req, res).catch(next);
  };
  app.all(PERCORSO, gestisciTus);
  app.all(`${PERCORSO}/:id`, gestisciTus);

  app.get('/api/in-sospeso', async (req, res, next) => {
    try { res.json({ caricamenti: await caricamenti.inSospeso() }); } catch (err) { next(err); }
  });
  app.get('/api/file', async (req, res, next) => {
    try {
      // Copre anche il file arrivato tutto mentre cadeva la connessione, prima di essere registrato.
      await caricamenti.recupera();
      const link = condivisione.riepilogoFile();
      const statoNota = Object.fromEntries(db.prepare('SELECT file_id AS id, stato, genere FROM note').all().map((n) => [n.id, n]));
      res.json({ novita: caricamenti.novita(), file: caricamenti.elencoFile().map((f) => ({ ...f, nota: statoNota[f.id] ?? null, link: link[f.id] ?? { attivi: 0, scaduti: 0, aperture: 0 } })), spazio: await caricamenti.riepilogo(), ia: ia.disponibile, indirizzoPubblico: indirizzoPubblico() });
    } catch (err) { next(err); }
  });
  app.get('/api/categorie', (req, res) => res.json({ categorie: caricamenti.elencoCategorie(), ordine: caricamenti.modoOrdine() }));
  app.put('/api/categorie/ordine', json, (req, res, next) => {
    try { caricamenti.impostaOrdine(req.body?.modo, req.body?.ids, indirizzoClient(req)); res.json({ ok: true }); } catch (err) { next(err); }
  });
  app.post('/api/categorie/:id/sposta', json, (req, res) => {
    if (!caricamenti.spostaCategoria(Number(req.params.id), req.body?.verso === 'su' ? 'su' : 'giu', indirizzoClient(req))) return res.status(404).json({ error: 'Categoria non trovata.' });
    res.json({ ok: true });
  });
  app.post('/api/categorie', json, (req, res, next) => {
    try { res.json({ id: caricamenti.creaCategoria(req.body?.nome, indirizzoClient(req), req.body?.sezione) }); } catch (err) { next(err); }
  });
  app.put('/api/categorie/:id', json, (req, res, next) => {
    try {
      if (!caricamenti.rinominaCategoria(Number(req.params.id), req.body?.nome, indirizzoClient(req))) return res.status(404).json({ error: 'Categoria non trovata.' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  app.delete('/api/categorie/:id', (req, res) => {
    if (!caricamenti.eliminaCategoria(Number(req.params.id), indirizzoClient(req))) return res.status(404).json({ error: 'Categoria non trovata.' });
    res.json({ ok: true });
  });
  app.get('/api/cestino', async (req, res, next) => {
    try { res.json({ file: caricamenti.elencoCestino(), spazio: await caricamenti.riepilogo() }); } catch (err) { next(err); }
  });
  app.get('/api/file/:id/miniatura', (req, res) => {
    if (!ID_VALIDO.test(req.params.id)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(cartellaMiniature, `${req.params.id}.jpg`), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
  app.patch('/api/file/:id', json, (req, res, next) => {
    try {
      const f = ID_VALIDO.test(req.params.id) && caricamenti.modificaFile(req.params.id, { titolo: req.body?.titolo, categoriaId: req.body?.categoriaId, descrizione: req.body?.descrizione, titoliCapitoli: req.body?.titoliCapitoli }, indirizzoClient(req));
      if (!f) return res.status(404).json({ error: 'File non trovato.' });
      res.json({ file: f });
    } catch (err) { next(err); }
  });
  // Guardare il proprio video dal pannello: stessa copia della pagina di visione.
  app.get('/api/file/:id/video', (req, res) => {
    const f = ID_VALIDO.test(req.params.id) && caricamenti.trova(req.params.id);
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    const pronto = path.join(cartellaVisione, `${f.id}.mp4`);
    if (f.visione === 1 && fs.existsSync(pronto)) return servi(res, pronto, { headers: { 'Content-Type': 'video/mp4' } });
    servi(res, path.join(cartellaFile, f.id), { headers: { 'Content-Type': f.tipo } });
  });
  app.get('/api/file/:id/sottotitoli.vtt', (req, res) => {
    if (!ID_VALIDO.test(req.params.id)) return res.status(404).end();
    servi(res, path.join(cartellaSottotitoli, `${req.params.id}.vtt`), { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
  });
  app.post('/api/file/:id/ia', async (req, res, next) => {
    try {
      const f = ID_VALIDO.test(req.params.id) && caricamenti.trova(req.params.id);
      if (!f) return res.status(404).json({ error: 'File non trovato.' });
      if (!ia.disponibile) return res.status(400).json({ error: 'IA non configurata: mancano le chiavi nel .env.' });
      if (f.visione !== 1) return res.status(409).json({ error: 'Il video è ancora in lavorazione: riprova fra poco.' });
      db.prepare('UPDATE file SET ia = 0 WHERE id = ?').run(f.id);
      lavoraIa(f.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---- condivisione ----
  const titoloDi = (fileId) => caricamenti.trova(fileId)?.titolo ?? 'file';
  app.post('/api/file/:id/visto', (req, res) => {
    if (!ID_VALIDO.test(req.params.id) || !caricamenti.trova(req.params.id)) return res.status(404).json({ error: 'File non trovato.' });
    caricamenti.segnaVisto(req.params.id);
    res.json({ novita: caricamenti.novita() });
  });
  app.get('/api/file/:id/audio', (req, res) => {
    const f = ID_VALIDO.test(req.params.id) && caricamenti.trova(req.params.id);
    if (!f || !f.tipo.startsWith('audio/')) return res.status(404).json({ error: 'Audio non trovato.' });
    // ?originale=1: il file come è arrivato; senza, la copia pulita appena c'è.
    const pulito = req.query.originale ? null : note.audioDa(f.id);
    res.set('Cache-Control', 'private, no-cache');
    servi(res, pulito ?? path.join(cartellaFile, f.id), { headers: { 'Content-Type': pulito ? 'audio/ogg' : f.tipo } });
  });
  // ---- note: lo stesso per il sito e per l'app DiGiNotes ----
  const notaEsiste = (req, res) => {
    const f = ID_VALIDO.test(req.params.id) && caricamenti.trova(req.params.id);
    if (!f || !note.nota(f.id)) { res.status(404).json({ error: 'Nota non trovata.' }); return null; }
    return f;
  };
  app.put('/api/note/contesto', json, (req, res) => res.json({ contesto: note.impostaContesto(req.body) }));
  app.get('/api/note/:id', (req, res) => {
    const f = notaEsiste(req, res); if (!f) return;
    res.json({ file: f, nota: note.nota(f.id) });
  });
  app.patch('/api/note/:id', json, (req, res, next) => {
    try {
      const f = notaEsiste(req, res); if (!f) return;
      res.json(note.modifica(f.id, req.body ?? {}, indirizzoClient(req)));
    } catch (err) { next(err); }
  });
  app.post('/api/note/:id/rifai', (req, res) => {
    const f = notaEsiste(req, res); if (!f) return;
    if (!ia.disponibile) return res.status(503).json({ error: 'Le chiavi IA non sono configurate.' });
    note.rifai(f.id);
    res.json({ ok: true });
  });
  app.get('/api/note/:id/esporta/:formato', (req, res) => {
    const f = notaEsiste(req, res); if (!f) return;
    const e = note.esporta(f.id, req.params.formato);
    if (!e) return res.status(404).json({ error: 'Formato sconosciuto.' });
    const nome = encodeURIComponent(`${f.titolo}.${e.estensione}`.replace(/[\\/:*?"<>|]/g, ' '));
    res.set({ 'Content-Type': e.tipo, 'Content-Disposition': `attachment; filename*=UTF-8''${nome}`, 'Cache-Control': 'private, no-cache' }).send(e.corpo);
  });
  app.post('/api/chiedi', json, async (req, res, next) => {
    try {
      if (!ia.testoDisponibile) return res.status(503).json({ error: 'Le chiavi IA non sono configurate.' });
      const id = req.body?.nota && ID_VALIDO.test(req.body.nota) ? req.body.nota : null;
      res.json(await note.chiedi(req.body?.domanda, id));
    } catch (err) { next(err); }
  });
  app.get('/api/cerca-note', (req, res) => res.json({ risultati: note.cerca(req.query.q) }));

  app.get('/api/file/:id/link', (req, res) => {
    if (!ID_VALIDO.test(req.params.id) || !caricamenti.trova(req.params.id)) return res.status(404).json({ error: 'File non trovato.' });
    res.json({ link: condivisione.perFile(req.params.id), emailConfigurata: posta.configured });
  });
  app.post('/api/file/:id/link', json, async (req, res, next) => {
    try {
      const f = ID_VALIDO.test(req.params.id) && caricamenti.trova(req.params.id);
      if (!f || f.cestinatoIl) return res.status(404).json({ error: 'File non trovato.' });
      res.json(await condivisione.crea({ fileId: f.id, chi: req.body?.chi, email: Array.isArray(req.body?.email) ? req.body.email : [], scadenza: req.body?.scadenza ?? 7, scarica: Boolean(req.body?.scarica), inviaEmail: Boolean(req.body?.inviaEmail), titolo: f.titolo }, indirizzoClient(req)));
    } catch (err) { next(err); }
  });
  app.get('/api/categorie/:id/link', (req, res) => {
    if (!db.prepare('SELECT 1 FROM categorie WHERE id = ?').get(Number(req.params.id))) return res.status(404).json({ error: 'Categoria non trovata.' });
    res.json({ link: condivisione.perCategoria(Number(req.params.id)), emailConfigurata: posta.configured });
  });
  app.post('/api/categorie/:id/link', json, async (req, res, next) => {
    try {
      const c = db.prepare('SELECT id, nome FROM categorie WHERE id = ?').get(Number(req.params.id));
      if (!c) return res.status(404).json({ error: 'Categoria non trovata.' });
      res.json(await condivisione.crea({ categoriaId: c.id, chi: req.body?.chi, email: Array.isArray(req.body?.email) ? req.body.email : [], scadenza: req.body?.scadenza ?? 7, scarica: Boolean(req.body?.scarica), inviaEmail: Boolean(req.body?.inviaEmail), titolo: `cartella «${c.nome}»` }, indirizzoClient(req)));
    } catch (err) { next(err); }
  });
  app.delete('/api/link/:id', (req, res) => {
    const l = condivisione.revoca(Number(req.params.id), indirizzoClient(req));
    if (!l) return res.status(404).json({ error: 'Link non trovato.' });
    res.json({ link: l });
  });
  app.post('/api/link/:id/prolunga', (req, res) => {
    const l = condivisione.prolunga(Number(req.params.id), indirizzoClient(req));
    if (!l) return res.status(404).json({ error: 'Link non trovato o revocato.' });
    res.json({ link: l });
  });
  app.post('/api/link/:id/invia', async (req, res, next) => {
    try {
      const l = condivisione.trovaLink(Number(req.params.id));
      if (!l || l.stato !== 'attivo') return res.status(404).json({ error: 'Link non trovato o non più attivo.' });
      await condivisione.invia(l, l.fileId ? titoloDi(l.fileId) : `cartella «${db.prepare('SELECT nome FROM categorie WHERE id = ?').get(l.categoriaId)?.nome ?? ''}»`);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  app.get('/api/link/:id/visite', (req, res) => {
    const l = condivisione.trovaLink(Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'Link non trovato.' });
    res.json({ link: l, visite: db.prepare('SELECT quando, dispositivo, secondi_visti AS secondiVisti, file_id AS fileId FROM visite WHERE link_id = ? ORDER BY quando DESC LIMIT 200').all(l.id) });
  });

  app.delete('/api/file/:id', (req, res) => {
    const f = ID_VALIDO.test(req.params.id) && caricamenti.cestina(req.params.id, indirizzoClient(req));
    if (!f) return res.status(404).json({ error: 'File non trovato.' });
    res.json({ ok: true });
  });
  app.post('/api/file/:id/ripristina', (req, res) => {
    const f = ID_VALIDO.test(req.params.id) && caricamenti.ripristina(req.params.id, indirizzoClient(req));
    if (!f) return res.status(404).json({ error: 'File non trovato nel cestino.' });
    res.json({ ok: true });
  });
  app.delete('/api/file/:id/definitivo', async (req, res, next) => {
    try {
      const f = ID_VALIDO.test(req.params.id) && await caricamenti.eliminaDefinitivamente(req.params.id, indirizzoClient(req));
      if (!f) return res.status(404).json({ error: 'File non trovato nel cestino.' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  app.post('/api/cestino/svuota', async (req, res, next) => {
    try {
      for (const f of caricamenti.elencoCestino()) await caricamenti.eliminaDefinitivamente(f.id, indirizzoClient(req));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Cosa succede al pulsante Carica sul telefono: non si puo' provare dal PC. Solo tipo di evento e numeri, mai il nome del file.
  app.post('/api/diagnosi-caricamento', json, (req, res) => {
    const evento = String(req.body?.evento || '').replace(/[^a-z_]/g, '').slice(0, 40);
    if (!evento) return res.status(400).json({ error: 'Evento mancante.' });
    registraEvento(`telefono_${evento}`, indirizzoClient(req), String(req.body?.dettaglio || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 160));
    res.json({ ok: true });
  });

  // ---- notifiche sul telefono ----
  app.get('/api/push/stato', (req, res) => res.json(notifiche.stato()));
  app.post('/api/push/abbonati', json, (req, res, next) => {
    try {
      notifiche.abbona(req.body, req.headers['user-agent']);
      registraEvento('notifiche_accese', indirizzoClient(req));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  app.post('/api/push/disdici', json, (req, res) => {
    if (notifiche.disdici(req.body?.endpoint)) registraEvento('notifiche_spente', indirizzoClient(req));
    res.json({ ok: true });
  });
  app.post('/api/push/prova', json, async (req, res, next) => {
    try {
      const r = await notifiche.prova(req.body?.endpoint);
      if (!r) return res.status(400).json({ error: 'Questo telefono non risulta abbonato: spegni e riaccendi le notifiche.' });
      res.json(r);
    } catch (err) { next(err); }
  });

  // ---- registrazioni Zoom ----
  app.get('/api/zoom', (req, res) => res.json(zoom.stato()));
  app.post('/api/zoom/importa', (req, res) => {
    if (!zoom.configurato) return res.status(400).json({ error: 'Zoom non è collegato: mancano le chiavi nel .env.' });
    zoom.avvia();
    res.json(zoom.stato());
  });

  // ---- backup ----
  app.get('/api/backup', (req, res) => res.json({
    impostazioni: impostazioniBackup(), ultimo: newestBackupTime(config.cartellaBackup) || null,
    copie: listBackups(config.cartellaBackup).length, inCorso: backupInCorso, cartella: config.cartellaBackup,
  }));
  app.put('/api/backup', json, (req, res, next) => {
    try {
      scriviImpostazione(db, 'backup', normalizeBackupSettings(req.body));
      sicurezza.log('backup_programmazione_modificata', indirizzoClient(req));
      res.json({ ok: true, impostazioni: impostazioniBackup() });
    } catch (err) { next(err); }
  });
  app.post('/api/backup/ora', async (req, res, next) => {
    try {
      const file = await backupAdesso();
      sicurezza.log('backup_creato', indirizzoClient(req));
      res.json({ ok: true, nome: path.basename(file), ultimo: newestBackupTime(config.cartellaBackup) });
    } catch (err) { next(err); }
  });
  app.post('/api/backup/ripristino/autorizza', json, async (req, res, next) => {
    try {
      await sicurezza.confirmSensitive(req.body, indirizzoClient(req));
      const permesso = randomBytes(32).toString('base64url');
      permessiRipristino.set(permesso, { tokenHash: req.sessione.tokenHash, indirizzo: indirizzoClient(req), scade: Date.now() + 2 * MINUTO });
      res.json({ grant: permesso });
    } catch (err) { next(err); }
  });
  app.post('/api/backup/ripristino', async (req, res, next) => {
    const chiavePermesso = String(req.headers['x-restore-grant'] || '');
    const permesso = permessiRipristino.get(chiavePermesso);
    permessiRipristino.delete(chiavePermesso);
    if (!permesso || permesso.tokenHash !== req.sessione.tokenHash || permesso.indirizzo !== indirizzoClient(req) || permesso.scade < Date.now()) {
      return res.status(403).json({ error: 'Conferma di ripristino scaduta.' });
    }
    const temporaneo = path.join(config.cartellaDati, `.upload-${randomBytes(6).toString('hex')}`);
    try {
      const uscita = createWriteStream(temporaneo, { mode: 0o600 });
      let byte = 0;
      for await (const pezzo of req) {
        byte += pezzo.length;
        if (byte > 512 * 1024 * 1024) throw Object.assign(new Error('Backup troppo grande.'), { status: 413 });
        if (!uscita.write(pezzo)) await new Promise((r) => uscita.once('drain', r));
      }
      await new Promise((r, j) => uscita.end((e) => (e ? j(e) : r())));
      if (!byte) throw new Error('Seleziona un file di backup.');
      stageRestore({ filePath: temporaneo, dataDir: config.cartellaDati, secret: config.chiave });
      sicurezza.log('backup_ripristinato', indirizzoClient(req), 'preparato: si installa al riavvio');
      avvisa('DiGiShare: backup ripristinato', `I dati di DiGiShare vengono ripristinati da un backup (richiesta da ${indirizzoClient(req)}). L'app si riavvia e le credenziali attuali restano quelle di adesso.`);
      res.json({ ok: true, riavvio: true });
      setTimeout(() => process.exit(0), 700);
    } catch (err) {
      next(err);
    } finally {
      fs.rmSync(temporaneo, { force: true });
    }
  });

  // ---- pagine e file statici ----
  const haSessione = (req) => Boolean(sicurezza.current(req, richiestaSicura(req)));
  app.get('/', (req, res) => (haSessione(req) ? res.sendFile(path.join(PUBBLICA, 'pannello.html')) : res.redirect('/accesso')));
  app.get('/nota/:id', (req, res) => (haSessione(req) ? res.sendFile(path.join(PUBBLICA, 'nota.html')) : res.redirect('/accesso')));
  app.get('/impostazioni', (req, res) => (haSessione(req) ? res.sendFile(path.join(PUBBLICA, 'impostazioni.html')) : res.redirect('/accesso')));
  app.get('/accesso', (req, res) => (haSessione(req) ? res.redirect('/') : res.sendFile(path.join(PUBBLICA, 'accesso.html'))));

  // PWA: manifest e service worker sempre freschi, icone con la versione nel nome.
  app.get('/manifest.json', (req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'DiGiShare', short_name: 'DiGiShare', description: 'Video, file e note sul tuo server',
      start_url: '/', scope: '/', display: 'standalone', orientation: 'any', background_color: '#141317', theme_color: '#141317',
      icons: [
        { src: `/icona-192-v${VERSIONE_ICONE}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/icona-512-v${VERSIONE_ICONE}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/icona-mask-512-v${VERSIONE_ICONE}.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });
  app.get('/sw.js', (req, res) => res.sendFile(path.join(PUBBLICA, 'sw.js')));
  const conCache = (res) => res.set('Cache-Control', 'public, max-age=86400');
  const icone = {
    [`/icona-192-v${VERSIONE_ICONE}.png`]: 'icona-any-192.png',
    [`/icona-512-v${VERSIONE_ICONE}.png`]: 'icona-any-512.png',
    [`/icona-mask-512-v${VERSIONE_ICONE}.png`]: 'icona-maskable-512.png',
    '/apple-touch-icon.png': 'apple-touch-icon-180.png',
    '/notifica-icona.png': 'icona-any-192.png',
    '/notifica-badge.png': 'badge-96.png',
  };
  for (const [rotta, file] of Object.entries(icone)) app.get(rotta, (req, res) => { conCache(res); res.sendFile(path.join(LOGO, 'pwa', file)); });
  app.get('/vendor/tus.min.js', (req, res) => { conCache(res); res.sendFile(TUS_CLIENT); });
  app.get('/logo/simbolo.svg', (req, res) => { conCache(res); res.sendFile(path.join(LOGO, 'digishare-simbolo.svg')); });
  app.get('/logo/completo.svg', (req, res) => { conCache(res); res.sendFile(path.join(LOGO, 'digishare.svg')); });
  app.get('/favicon.ico', (req, res) => { conCache(res); res.sendFile(path.join(LOGO, 'digishare.ico')); });
  app.use('/risorse', express.static(path.join(PUBBLICA, 'risorse'), { cacheControl: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const stato = err.status ?? err.status_code ?? (/Troppi tentativi/.test(err.message) ? 429 : err.expose === false ? 500 : 400);
    if (stato >= 500) console.error(err);
    res.status(stato).json({ error: stato >= 500 ? 'Qualcosa è andato storto sul server.' : (err.message || 'Errore.') });
  });

  function chiudi() {
    timer.forEach(clearInterval);
    zoom.ferma();
    programmatore.stop();
    proxy?.close();
    sicurezza.close();
    posta.close();
    db.close();
  }
  return { app, db, sicurezza, chiudi, controllaSalute, backupAdesso, condivisione, ia };
}
