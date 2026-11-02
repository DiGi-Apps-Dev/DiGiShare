// Importazione da Zoom contro uno Zoom finto: server vero, dati temporanei, nessuna chiamata a Zoom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';
import { spezzoniDa } from '../src/zoom.js';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 5190;
const BASE = `http://127.0.0.1:${PORTA}`;
const VIDEO = crypto.randomBytes(200 * 1024);
const IERI = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const finto = { riunioni: [], chiamate: [], scaricamenti: 0, rispostaVideo: null, tokenRifiutato: false, autorizzazioniAltrove: [] };
let zoom; let fuori; let server; let cartella; let cookie; let csrf;
let indirizzoZoom; let indirizzoFuori;

const fileMp4 = (id, extra = {}) => ({ id, file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'completed', recording_start: IERI, file_size: VIDEO.length, download_url: `${indirizzoZoom}/rec/download/${id}`, ...extra });
const riunione = (uuid, recording_files, topic = 'Lezione di prova') => ({ uuid, topic, start_time: IERI, recording_files });

async function chiamaApp(via, opzioni = {}) {
  const r = await fetch(`${BASE}${via}`, { ...opzioni, headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...opzioni.headers } });
  return { status: r.status, dati: await r.json() };
}
async function importa() {
  const { status } = await chiamaApp('/api/zoom/importa', { method: 'POST', body: '{}' });
  assert.equal(status, 200);
  for (let i = 0; i < 300; i++) {
    const { dati } = await chiamaApp('/api/zoom');
    if (!dati.inCorso) return dati;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Importazione non finita');
}
const fileApp = async () => (await chiamaApp('/api/file')).dati.file;

before(async () => {
  zoom = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    finto.chiamate.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.pathname === '/oauth/token') {
      if (finto.tokenRifiutato) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"reason":"Invalid client_id or client_secret"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'token-finto', expires_in: 3600 }));
    }
    if (req.headers.authorization !== 'Bearer token-finto') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"message":"Invalid access token."}'); }
    if (u.pathname.startsWith('/v2/users/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ meetings: finto.riunioni }));
    }
    if (u.pathname.startsWith('/rec/download/')) {
      finto.scaricamenti++;
      if (finto.rispostaVideo) return finto.rispostaVideo(res);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO.length });
      return res.end(VIDEO);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => zoom.listen(0, '127.0.0.1', r));
  indirizzoZoom = `http://127.0.0.1:${zoom.address().port}`;
  fuori = http.createServer((req, res) => {
    finto.autorizzazioniAltrove.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(VIDEO);
  });
  await new Promise((r) => fuori.listen(0, '127.0.0.1', r));
  indirizzoFuori = `http://localhost:${fuori.address().port}`;

  cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-zoom-'));
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: RADICE,
    env: {
      ...process.env, PORTA: String(PORTA), CARTELLA_DATI: cartella, CARTELLA_BACKUP: `${cartella}-backup`, POSTA_FINTA: `${cartella}-posta`, IA_FINTA: '1', MARGINE_DISCO_GB: '0',
      DIGISHARE_AUTH_KEY: crypto.randomBytes(32).toString('base64url'),
      ZOOM_ACCOUNT_ID: 'conto', ZOOM_CLIENT_ID: 'cliente', ZOOM_CLIENT_SECRET: 'segreto', ZOOM_UTENTE: 'prova@example.com',
      ZOOM_API: `${indirizzoZoom}/v2`, ZOOM_OAUTH: `${indirizzoZoom}/oauth/token`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/stato`)).ok) break; } catch { /* non ancora su */ }
    if (i > 900) throw new Error('Il server non è partito');
    await new Promise((r) => setTimeout(r, 100));
  }
  const post = (via, corpo) => fetch(`${BASE}${via}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const inizio = await (await post('/api/auth/setup/start', { username: 'prova' })).json();
  const r = await post('/api/auth/setup/complete', { setupToken: inizio.setupToken, password: 'password-di-prova', code: authenticator.generate(inizio.secret) });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie()[0].split(';')[0];
  ({ csrf } = await r.json());
});

after(async () => {
  server?.kill('SIGKILL');
  zoom?.close();
  fuori?.close();
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [cartella, `${cartella}-backup`, `${cartella}-posta`]) fs.rmSync(d, { recursive: true, force: true });
});

test('sceglie un video per spezzone, la vista migliore, e aspetta quelli in lavorazione', () => {
  const prima = '2026-10-30T10:00:00Z';
  const dopo = '2026-10-30T11:00:00Z';
  const s = spezzoniDa(riunione('u', [
    { id: 'a', file_type: 'M4A', recording_type: 'audio_only', status: 'completed', download_url: 'x', recording_start: prima },
    { id: 'b', file_type: 'MP4', recording_type: 'gallery_view', status: 'completed', download_url: 'x', recording_start: prima },
    { id: 'c', file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'completed', download_url: 'x', recording_start: prima },
    { id: 'd', file_type: 'MP4', recording_type: 'shared_screen_with_speaker_view', status: 'processing', download_url: 'x', recording_start: dopo },
    { id: 'e', file_type: 'MP4', recording_type: 'gallery_view', status: 'completed', download_url: 'x', recording_start: dopo },
  ]));
  assert.deepEqual(s.map((x) => x.file.id), ['c']);
  assert.equal(s[0].parte, 1);
});

test('la sezione risponde solo con la sessione', async () => {
  assert.equal((await fetch(`${BASE}/api/zoom`)).status, 401);
  const { status, dati } = await chiamaApp('/api/zoom');
  assert.equal(status, 200);
  assert.equal(dati.configurato, true);
  assert.equal(dati.importati, 0);
  assert.ok(!JSON.stringify(dati).includes('segreto'));
});

test('importa il video nella categoria Zoom, intero, e la seconda volta non lo riscarica', async () => {
  finto.riunioni = [riunione('uuid/1==', [fileMp4('f1'), { id: 'f2', file_type: 'M4A', recording_type: 'audio_only', status: 'completed', recording_start: IERI, file_size: 5, download_url: `${indirizzoZoom}/rec/download/f2` }])];
  const stato = await importa();
  assert.equal(stato.errore, '');
  assert.equal(stato.importati, 1);
  assert.equal(finto.scaricamenti, 1, 'solo l\'MP4');
  const elenco = await fileApp();
  assert.equal(elenco.length, 1);
  assert.match(elenco[0].titolo, /^Lezione di prova · \d\d\.\d\d\.\d{4}$/);
  assert.equal(elenco[0].tipo, 'video/mp4');
  assert.equal(elenco[0].dimensione, VIDEO.length);
  assert.ok(fs.readFileSync(path.join(cartella, 'file', elenco[0].id)).equals(VIDEO));
  const { dati: { categorie } } = await chiamaApp('/api/categorie');
  assert.equal(categorie.find((c) => c.id === elenco[0].categoriaId)?.nome, 'Zoom');
  // Il numerino: un video arrivato da Zoom è una novità finché non si apre.
  assert.equal((await chiamaApp('/api/file')).dati.novita.video, 1);
  const visto = await chiamaApp(`/api/file/${elenco[0].id}/visto`, { method: 'POST', body: '{}' });
  assert.equal(visto.dati.novita.video, 0);

  // Storico: la prima volta 13 richieste da un mese; dalla seconda solo l'ultimo mese.
  const elenchi = () => finto.chiamate.filter((c) => c.includes('/recordings')).length;
  assert.equal(elenchi(), 13);
  assert.ok(finto.chiamate.find((c) => c.includes('/recordings')).includes('/users/prova%40example.com/'));
  await importa();
  assert.equal(elenchi(), 14);
  assert.equal(finto.scaricamenti, 1, 'niente doppioni');
});

test('un file eliminato dall\'utente non torna al giro dopo', async () => {
  const [f] = await fileApp();
  assert.equal((await chiamaApp(`/api/file/${f.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await chiamaApp(`/api/file/${f.id}/definitivo`, { method: 'DELETE' })).status, 200);
  await importa();
  assert.equal(finto.scaricamenti, 1);
  assert.equal((await fileApp()).length, 0);
});

test('video incompleto o pagina al posto del video: niente in elenco, nessun parziale, si riprova e riesce', async () => {
  finto.riunioni = [riunione('uuid-2', [fileMp4('g1')], 'Seconda')];
  finto.rispostaVideo = (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>accedi</html>'); };
  let stato = await importa();
  assert.match(stato.errore, /pagina invece del video/);
  finto.rispostaVideo = (res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(VIDEO.subarray(0, 1000)); };
  stato = await importa();
  assert.match(stato.errore, /incompleto/);
  assert.equal((await fileApp()).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(cartella, 'file')).filter((n) => n.endsWith('.zoom-parziale')), []);

  finto.rispostaVideo = null;
  stato = await importa();
  assert.equal(stato.errore, '');
  assert.equal((await fileApp()).length, 1);
});

test('il token non esce mai verso un indirizzo che non è di Zoom', async () => {
  const prima = finto.autorizzazioniAltrove.length;
  finto.riunioni = [riunione('uuid-3', [fileMp4('h1', { download_url: `${indirizzoFuori}/video` })], 'Terza')];
  const stato = await importa();
  assert.match(stato.errore, /non suo/);
  assert.equal(finto.autorizzazioniAltrove.length, prima);
  finto.riunioni = [];
  await importa();
});

test('chiavi rifiutate: errore chiaro, email dopo tre controlli di fila, nessuna chiave nel registro', async () => {
  // Il token valido in memoria va fatto scadere: Zoom finto lo rifiuta e l'app ne chiede un altro.
  finto.tokenRifiutato = true;
  finto.riunioni = [];
  const tokenVero = zoom.listeners('request')[0];
  zoom.removeAllListeners('request');
  zoom.on('request', (req, res) => {
    if (req.url.startsWith('/oauth/token')) return tokenVero(req, res);
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"Invalid access token."}');
  });
  let stato;
  for (let i = 0; i < 3; i++) stato = await importa();
  assert.match(stato.errore, /rifiutato le chiavi/);
  const posta = `${cartella}-posta`;
  const email = fs.readdirSync(posta).map((f) => JSON.parse(fs.readFileSync(path.join(posta, f), 'utf8')));
  assert.ok(email.some((e) => /Zoom ferma/.test(JSON.stringify(e))));
  const { dati: { eventi } } = await chiamaApp('/api/registro');
  assert.ok(eventi.some((e) => e.kind === 'zoom_fallito'));
  assert.ok(!JSON.stringify(eventi).includes('segreto'));
  zoom.removeAllListeners('request');
  zoom.on('request', tokenVero);
  finto.tokenRifiutato = false;
  stato = await importa();
  assert.equal(stato.errore, '');
  const { dati: { eventi: dopo } } = await chiamaApp('/api/registro');
  assert.ok(dopo.some((e) => e.kind === 'zoom_ripresa'));
});
