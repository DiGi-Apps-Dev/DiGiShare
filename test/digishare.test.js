import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tus from 'tus-js-client';
import { authenticator } from 'otplib';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'password-di-prova';
const CHIAVE = crypto.randomBytes(32).toString('base64url');
let porta = 5150;
const processi = new Set();
process.on('exit', () => { for (const p of processi) p.kill('SIGKILL'); });

function avviaServer(cartella, altro = {}) {
  const p = porta;
  const figlio = spawn(process.execPath, ['src/server.js'], {
    cwd: RADICE,
    env: {
      ...process.env, PORTA: String(p), CARTELLA_DATI: cartella, CARTELLA_BACKUP: path.join(cartella, '..', `${path.basename(cartella)}-backup`),
      MARGINE_DISCO_GB: '0', DIGISHARE_AUTH_KEY: CHIAVE, POSTA_FINTA: path.join(cartella, '..', `${path.basename(cartella)}-posta`), IA_FINTA: '1', ...altro,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  figlio.stderr.on('data', (d) => { figlio.errori = (figlio.errori || '') + d; });
  processi.add(figlio);
  return attendi(`http://127.0.0.1:${p}`).then((base) => ({ base, figlio, porta: p, cartella }));
}

async function attendi(base) {
  // Dal PC node_modules sta sulla cartella di rete del NAS: l'avvio può chiedere decine di secondi.
  for (let i = 0; i < 900; i++) {
    try {
      if ((await fetch(`${base}/stato`)).ok) return base;
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Il server non è partito');
}

function ferma(s) {
  return new Promise((r) => {
    if (s.figlio.exitCode !== null) return r();
    s.figlio.once('exit', r);
    s.figlio.kill('SIGKILL');
  });
}

const nuovaCartella = () => fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-prova-'));
const cartellaPosta = (s) => path.join(s.cartella, '..', `${path.basename(s.cartella)}-posta`);
const cartellaBackup = (s) => path.join(s.cartella, '..', `${path.basename(s.cartella)}-backup`);

// Un codice Authenticator vale una volta sola e il server rifiuta i passi già usati: fra una prova e l'altra
// si usa il passo successivo (accettato, finestra ±1) oppure si aspetta il prossimo.
const passiUsati = new Map();
async function codice(secret) {
  for (;;) {
    const adesso = Math.floor(Date.now() / 30000);
    const ultimo = passiUsati.get(secret) ?? -1;
    if (adesso > ultimo) { passiUsati.set(secret, adesso); return authenticator.generate(secret); }
    if (adesso === ultimo) { passiUsati.set(secret, adesso + 1); return authenticator.clone({ epoch: Date.now() + 30000 }).generate(secret); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const cookieDa = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]);
const post = (base, via, corpo, intestazioni = {}) => fetch(`${base}${via}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...intestazioni }, body: JSON.stringify(corpo) });

async function entra(base, { username = 'admin', password = PASSWORD, secret, remember = false, cookieDispositivo = '' } = {}) {
  const code = secret ? await codice(secret) : '';
  const r = await post(base, '/api/auth/login', { username, password, code, remember }, cookieDispositivo ? { Cookie: cookieDispositivo } : {});
  const cookies = cookieDa(r);
  const dati = await r.json().catch(() => ({}));
  const sessione = cookies.find((c) => c.includes('-session=')) || cookies.find((c) => c.startsWith('DiGiShare'));
  const dispositivo = cookies.find((c) => c.includes('-device='));
  return { r, cookie: sessione, dispositivo, csrf: dati.csrf, dati };
}

const conSessione = (s) => ({ Cookie: s.cookie, 'x-csrf-token': s.csrf });

async function configura(base) {
  const inizio = await (await post(base, '/api/auth/setup/start', { username: 'prova' })).json();
  assert.ok(inizio.secret && inizio.qrDataUrl.startsWith('data:image/png'));
  const r = await post(base, '/api/auth/setup/complete', { setupToken: inizio.setupToken, password: PASSWORD, code: await codice(inizio.secret) });
  assert.equal(r.status, 200);
  const { csrf } = await r.json();
  return { secret: inizio.secret, cookie: cookieDa(r)[0], csrf };
}

function carica(base, sessione, dati, opzioni = {}) {
  return new Promise((resolve, reject) => {
    const up = new tus.Upload(dati, {
      endpoint: `${base}/api/caricamenti`,
      chunkSize: 64 * 1024,
      retryDelays: null,
      headers: conSessione(sessione),
      metadata: { filename: 'prova.mp4', filetype: 'video/mp4', ultimamodifica: '123' },
      onSuccess: () => resolve(up),
      onError: reject,
      ...opzioni,
    });
    up.start();
  });
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const elenco = async (s, via = '/api/file') => (await fetch(`${s.base}${via}`, { headers: { Cookie: sessione.cookie } })).json();
async function ultimaEmail(s) {
  const dir = cartellaPosta(s);
  const file = fs.readdirSync(dir).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}
const emailInviate = (s) => (fs.existsSync(cartellaPosta(s)) ? fs.readdirSync(cartellaPosta(s)).map((f) => JSON.parse(fs.readFileSync(path.join(cartellaPosta(s), f), 'utf8'))) : []);

let s; let cartella; let sessione; let secret;

before(async () => {
  cartella = nuovaCartella();
  s = await avviaServer(cartella);
});
after(async () => {
  for (const p of processi) p.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [cartella, cartellaBackup(s), cartellaPosta(s)]) fs.rmSync(d, { recursive: true, force: true });
});

test('senza accesso non si vede né si carica niente, e le intestazioni di sicurezza ci sono', async () => {
  const pagina = await fetch(`${s.base}/`, { redirect: 'manual' });
  assert.equal(pagina.status, 302);
  assert.equal(pagina.headers.get('location'), '/accesso');
  assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(pagina.headers.get('cache-control'), 'no-store');
  assert.equal(pagina.headers.get('x-frame-options'), 'DENY');
  for (const via of ['/api/file', '/api/in-sospeso', '/api/backup', '/api/registro', '/api/auth/me']) {
    assert.equal((await fetch(`${s.base}${via}`)).status, 401, via);
  }
  const tusPost = await fetch(`${s.base}/api/caricamenti`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '10' } });
  assert.equal(tusPost.status, 401);
  const manifest = await fetch(`${s.base}/manifest.json`);
  assert.equal(manifest.headers.get('cache-control'), 'no-store');
  assert.equal((await manifest.json()).icons.length, 3);
  assert.equal((await fetch(`${s.base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${s.base}/icona-mask-512-v5.png`)).status, 200);
});

test('prima configurazione: nome utente, password e Authenticator, una volta sola', async () => {
  const stato = await (await fetch(`${s.base}/api/auth/status`)).json();
  assert.deepEqual(stato, { initialized: false, setupAllowed: true, emailConfigured: true });
  const corta = await post(s.base, '/api/auth/setup/start', { username: 'prova' }).then((r) => r.json());
  const r = await post(s.base, '/api/auth/setup/complete', { setupToken: corta.setupToken, password: 'corta', code: await codice(corta.secret) });
  assert.equal(r.status, 400);
  ({ secret, ...sessione } = await configura(s.base));
  assert.match(sessione.cookie, /DiGiShare-session=/);
  const dopo = await (await fetch(`${s.base}/api/auth/status`)).json();
  assert.equal(dopo.initialized, true);
  assert.equal(dopo.setupAllowed, false);
  assert.equal((await post(s.base, '/api/auth/setup/start', { username: 'altro' })).status, 403);
  const me = await (await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).json();
  assert.equal(me.username, 'prova');
  assert.ok(me.csrf);
});

test('entra con password e Authenticator; il dispositivo ricordato non richiede più il codice', async () => {
  const sbagliato = await entra(s.base, { username: 'prova', password: 'sbagliata-di-prova', secret });
  assert.equal(sbagliato.r.status, 400);
  const utenteInesistente = await entra(s.base, { username: 'nessuno', secret });
  assert.equal(utenteInesistente.r.status, 400);
  const senzaCodice = await post(s.base, '/api/auth/login', { username: 'prova', password: PASSWORD, code: '' });
  assert.equal(senzaCodice.status, 400, 'senza codice e senza dispositivo ricordato non si entra');

  const ok = await entra(s.base, { username: 'prova', secret, remember: true });
  assert.equal(ok.r.status, 200, JSON.stringify(ok.dati));
  assert.match(ok.r.headers.getSetCookie().find((c) => c.includes('-session=')), /HttpOnly/i);
  assert.ok(ok.dispositivo, 'cookie del dispositivo separato dalla sessione');
  assert.match(ok.dispositivo, /DiGiShare-device=/);
  const intestazione = ok.r.headers.getSetCookie().find((c) => c.includes('-device='));
  assert.match(intestazione, /Max-Age=7776000/, '90 giorni pieni');

  const ricordato = await post(s.base, '/api/auth/login', { username: 'prova', password: PASSWORD, code: '' }, { Cookie: ok.dispositivo });
  assert.equal(ricordato.status, 200, 'con il dispositivo ricordato basta la password');
  const dispositivi = await (await fetch(`${s.base}/api/auth/devices`, { headers: { Cookie: sessione.cookie } })).json();
  assert.equal(dispositivi.devices.length, 1);
  sessione.dispositivo = ok.dispositivo;
});

test('senza token anti-CSRF e da un altro sito non si scrive', async () => {
  const senzaToken = await fetch(`${s.base}/api/auth/logout-all`, { method: 'POST', headers: { Cookie: sessione.cookie } });
  assert.equal(senzaToken.status, 403);
  const altroSito = await fetch(`${s.base}/api/caricamenti`, {
    method: 'POST', headers: { ...conSessione(sessione), Origin: 'https://cattivo.example', 'Tus-Resumable': '1.0.0', 'Upload-Length': '10' },
  });
  assert.equal(altroSito.status, 403);
  const proxy = await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: { ...conSessione(sessione), Origin: 'http://127.0.0.1:8446' } });
  assert.equal(proxy.status, 200, 'stesso nome con porta diversa, come dietro il proxy');
  const rientro = await entra(s.base, { username: 'prova', cookieDispositivo: sessione.dispositivo });
  assert.equal(rientro.r.status, 200, JSON.stringify(rientro.dati));
  sessione = { ...rientro, dispositivo: sessione.dispositivo };
});

test('il caricamento arriva intero e compare in elenco', async () => {
  const dati = crypto.randomBytes(300 * 1024);
  const up = await carica(s.base, sessione, dati, { metadata: { filename: '..\\..\\sub/prova.mp4', filetype: 'video/mp4' } });
  const id = up.url.split('/').pop();
  assert.equal(sha(fs.readFileSync(path.join(cartella, 'file', id))), sha(dati));
  const { file, spazio } = await elenco(s);
  assert.equal(file.length, 1);
  assert.equal(file[0].nome, 'prova.mp4', 'il nome non contiene cartelle');
  assert.equal(file[0].dimensione, dati.length);
  assert.equal(spazio.usato, dati.length);
  assert.ok(spazio.libero > 0);
  const { eventi } = await elenco(s, '/api/registro');
  assert.ok(eventi.some((e) => e.kind === 'file_caricato' && e.detail === 'prova.mp4'));
});

test('un file finito non si può cancellare con tus; GET non scarica; non si esce dalla cartella', async () => {
  const dati = crypto.randomBytes(10 * 1024);
  const up = await carica(s.base, sessione, dati);
  const head = await fetch(up.url, { method: 'HEAD', headers: { Cookie: sessione.cookie, 'Tus-Resumable': '1.0.0' } });
  assert.equal(head.headers.get('upload-offset'), String(dati.length));
  const del = await fetch(up.url, { method: 'DELETE', headers: { ...conSessione(sessione), 'Tus-Resumable': '1.0.0' } });
  assert.equal(del.status, 400);
  assert.equal((await fetch(up.url, { headers: { Cookie: sessione.cookie } })).status, 405);
  const fuori = await fetch(`${s.base}/api/caricamenti/..%2F..%2Fdigishare.sqlite`, { method: 'HEAD', headers: { Cookie: sessione.cookie, 'Tus-Resumable': '1.0.0' } });
  assert.notEqual(fuori.status, 200);
});

test('riprende da dove era dopo l\'interruzione e dopo la morte del server; sessione e blocco restano', async () => {
  const dati = crypto.randomBytes(4 * 1024 * 1024);
  let url;
  await new Promise((resolve, reject) => {
    const up = new tus.Upload(dati, {
      endpoint: `${s.base}/api/caricamenti`, chunkSize: 256 * 1024, retryDelays: null, headers: conSessione(sessione),
      metadata: { filename: 'lungo.mp4', filetype: 'video/mp4', ultimamodifica: '42' },
      onChunkComplete(_, inviati) { if (inviati >= 1024 * 1024) { url = up.url; up.abort().then(resolve, reject); } },
      onError: reject, onSuccess: () => reject(new Error('doveva interrompersi')),
    });
    up.start();
  });
  const { caricamenti } = await elenco(s, '/api/in-sospeso');
  assert.equal(caricamenti.length, 1);
  assert.equal(caricamenti[0].nome, 'lungo.mp4');
  assert.ok(caricamenti[0].ricevuti >= 1024 * 1024);

  await ferma(s);
  porta++;
  s = await avviaServer(cartella);
  assert.equal((await fetch(`${s.base}/api/file`, { headers: { Cookie: sessione.cookie } })).status, 200, 'la sessione resta dopo il riavvio');

  const nuovoUrl = `${s.base}/api/caricamenti/${url.split('/').pop()}`;
  let primoProgresso = null;
  const up = await carica(s.base, sessione, dati, { uploadUrl: nuovoUrl, chunkSize: 256 * 1024, onProgress(n) { primoProgresso ??= n; } });
  assert.equal(up.url.split('/').pop(), url.split('/').pop());
  assert.ok(primoProgresso >= caricamenti[0].ricevuti, 'non è ripartito da zero');
  assert.equal(sha(fs.readFileSync(path.join(cartella, 'file', url.split('/').pop()))), sha(dati));
  assert.equal((await elenco(s, '/api/in-sospeso')).caricamenti.length, 0);
});

test('cestino: elimina, ripristina, elimina per sempre, svuota', async () => {
  const prima = await elenco(s);
  const f = prima.file.find((x) => x.nome === 'lungo.mp4');
  const cestinato = await fetch(`${s.base}/api/file/${f.id}`, { method: 'DELETE', headers: conSessione(sessione) });
  assert.equal(cestinato.status, 200, await cestinato.text());
  assert.ok(!(await elenco(s)).file.some((x) => x.id === f.id), 'sparito dall\'elenco');
  const cestino = await elenco(s, '/api/cestino');
  assert.equal(cestino.file.length, 1);
  assert.equal(cestino.spazio.nelCestino, 1);
  assert.ok(fs.existsSync(path.join(cartella, 'file', f.id)), 'il file è ancora sul disco');
  assert.equal((await fetch(`${s.base}/api/file/${f.id}/ripristina`, { method: 'POST', headers: conSessione(sessione) })).status, 200);
  assert.ok((await elenco(s)).file.some((x) => x.id === f.id), 'ripristinato');
  await fetch(`${s.base}/api/file/${f.id}`, { method: 'DELETE', headers: conSessione(sessione) });
  assert.equal((await fetch(`${s.base}/api/file/${f.id}/definitivo`, { method: 'DELETE', headers: conSessione(sessione) })).status, 200);
  assert.equal(fs.existsSync(path.join(cartella, 'file', f.id)), false);
  assert.equal(fs.existsSync(path.join(cartella, 'file', `${f.id}.json`)), false);
  const altro = (await elenco(s)).file[0];
  await fetch(`${s.base}/api/file/${altro.id}`, { method: 'DELETE', headers: conSessione(sessione) });
  assert.equal((await fetch(`${s.base}/api/cestino/svuota`, { method: 'POST', headers: conSessione(sessione) })).status, 200);
  assert.equal((await elenco(s, '/api/cestino')).file.length, 0);
  assert.equal(fs.existsSync(path.join(cartella, 'file', altro.id)), false);
});

test('rifiuta file vuoti, senza nome, a lunghezza ignota e troppo grandi', async () => {
  const base = { ...conSessione(sessione), 'Tus-Resumable': '1.0.0' };
  const nome = `filename ${Buffer.from('a.mp4').toString('base64')}`;
  const prova = (h) => fetch(`${s.base}/api/caricamenti`, { method: 'POST', headers: { ...base, ...h } });
  assert.equal((await prova({ 'Upload-Length': '0', 'Upload-Metadata': nome })).status, 400);
  assert.equal((await prova({ 'Upload-Length': '10' })).status, 400);
  assert.equal((await prova({ 'Upload-Defer-Length': '1', 'Upload-Metadata': nome })).status, 400);
  assert.equal((await prova({ 'Upload-Length': String(51 * 1000 ** 3), 'Upload-Metadata': nome })).status, 413);
});

test('backup cifrato: programmazione, backup ora, importa con password e Authenticator, credenziali conservate', async () => {
  const stato = await elenco(s, '/api/backup');
  assert.deepEqual(stato.impostazioni, { enabled: true, frequency: 'weekly', dayOfWeek: 0, dayOfMonth: 1, hour: 3, minute: 0 });
  // stato.ultimo non si controlla: senza copie il primo backup automatico parte entro un minuto dall'avvio.
  const put = await fetch(`${s.base}/api/backup`, { method: 'PUT', headers: { ...conSessione(sessione), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, frequency: 'daily', dayOfWeek: 1, dayOfMonth: 1, hour: 4, minute: 30 }) });
  assert.equal(put.status, 200);
  assert.equal((await elenco(s, '/api/backup')).impostazioni.hour, 4);

  const dati = crypto.randomBytes(5000);
  const up = await carica(s.base, sessione, dati, { metadata: { filename: 'da-salvare.mp4', filetype: 'video/mp4' } });
  const id = up.url.split('/').pop();
  const ora = await (await fetch(`${s.base}/api/backup/ora`, { method: 'POST', headers: conSessione(sessione) })).json();
  assert.match(ora.nome, /^digishare-\d{8}-\d{6}\.enc$/);
  const fileBackup = path.join(cartellaBackup(s), ora.nome);
  const contenuto = fs.readFileSync(fileBackup);
  assert.equal(contenuto.subarray(0, 8).toString(), 'DGSHBK01');
  assert.equal(contenuto.includes(Buffer.from('da-salvare.mp4')), false, 'il contenuto è cifrato');

  // Dopo il backup il file finisce nel cestino: il ripristino deve riportarlo in elenco.
  await fetch(`${s.base}/api/file/${id}`, { method: 'DELETE', headers: conSessione(sessione) });
  const codiceSbagliato = await post(s.base, '/api/backup/ripristino/autorizza', { password: PASSWORD, code: '000000' }, conSessione(sessione));
  assert.equal(codiceSbagliato.status, 400);
  const { grant } = await (await post(s.base, '/api/backup/ripristino/autorizza', { password: PASSWORD, code: await codice(secret) }, conSessione(sessione))).json();
  const uscita = new Promise((r) => s.figlio.once('exit', r));
  const importa = await fetch(`${s.base}/api/backup/ripristino`, { method: 'POST', headers: { ...conSessione(sessione), 'x-restore-grant': grant, 'content-type': 'application/octet-stream' }, body: contenuto });
  assert.equal(importa.status, 200);
  assert.equal((await importa.json()).riavvio, true);
  await uscita;
  assert.ok(fs.existsSync(path.join(cartella, '.restore-pending')));

  porta++;
  s = await avviaServer(cartella);
  assert.equal(fs.existsSync(path.join(cartella, '.restore-pending')), false, 'installato all\'avvio');
  const dopo = await elenco(s);
  assert.ok(dopo.file.some((x) => x.id === id), 'il file è tornato in elenco');
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).status, 200, 'sessione e credenziali conservate');
  assert.ok(emailInviate(s).some((m) => /backup ripristinato/i.test(m.subject)));
});

test('cambio password: servono password attuale e codice; le altre sessioni cadono', async () => {
  const altra = await entra(s.base, { username: 'prova', cookieDispositivo: sessione.dispositivo });
  assert.equal(altra.r.status, 200, JSON.stringify(altra.dati));
  const senzaCodice = await post(s.base, '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'nuova-password-1', code: '000000' }, conSessione(sessione));
  assert.equal(senzaCodice.status, 400);
  const ok = await post(s.base, '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'nuova-password-1', code: await codice(secret) }, conSessione(sessione));
  assert.equal(ok.status, 200, await ok.text());
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: altra.cookie } })).status, 401, 'l\'altra sessione è chiusa');
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).status, 200, 'chi ha cambiato resta dentro');
  const vecchia = await post(s.base, '/api/auth/login', { username: 'prova', password: PASSWORD, code: '' }, { Cookie: sessione.dispositivo });
  assert.equal(vecchia.status, 400, 'la vecchia password non vale più e i dispositivi sono dimenticati');
  assert.ok(emailInviate(s).some((m) => /password cambiata/i.test(m.subject)));
  const nuova = await entra(s.base, { username: 'prova', password: 'nuova-password-1', secret, remember: true });
  assert.equal(nuova.r.status, 200, JSON.stringify(nuova.dati));
  sessione = { ...nuova };
});

test('password dimenticata via email: codice di 10 minuti, poi password nuova', async () => {
  const prima = emailInviate(s).length;
  const r = await post(s.base, '/api/auth/recovery/request', { username: 'prova', purpose: 'password' });
  assert.equal(r.status, 200);
  const inesistente = await post(s.base, '/api/auth/recovery/request', { username: 'nessuno', purpose: 'password' });
  assert.equal(inesistente.status, 200, 'stessa risposta per non svelare i nomi utente');
  const email = emailInviate(s).slice(prima).find((m) => /codice per la password/i.test(m.subject));
  const codiceEmail = email.text.match(/\b(\d{8})\b/)[1];
  const sbagliato = await post(s.base, '/api/auth/recovery/password', { username: 'prova', code: '00000000', newPassword: 'password-recuperata' });
  assert.equal(sbagliato.status, 400);
  const ok = await post(s.base, '/api/auth/recovery/password', { username: 'prova', code: codiceEmail, newPassword: 'password-recuperata' });
  assert.equal(ok.status, 200);
  const riuso = await post(s.base, '/api/auth/recovery/password', { username: 'prova', code: codiceEmail, newPassword: 'altra-ancora' });
  assert.equal(riuso.status, 400, 'il codice è monouso');
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).status, 401, 'tutte le sessioni chiuse');
  sessione = await entra(s.base, { username: 'prova', password: 'password-recuperata', secret, remember: true });
  assert.equal(sessione.r.status, 200);
});

test('telefono perso: codice via email, nuovo Authenticator, il vecchio non vale più', async () => {
  const prima = emailInviate(s).length;
  await post(s.base, '/api/auth/recovery/request', { username: 'prova', purpose: 'telefono' });
  const email = emailInviate(s).slice(prima).find((m) => /telefono perso/i.test(m.subject));
  const codiceEmail = email.text.match(/\b(\d{8})\b/)[1];
  const inizio = await (await post(s.base, '/api/auth/recovery/phone/start', { username: 'prova', code: codiceEmail })).json();
  assert.ok(inizio.secret && inizio.resetToken);
  const fine = await post(s.base, '/api/auth/recovery/phone/complete', { resetToken: inizio.resetToken, code: await codice(inizio.secret) });
  assert.equal(fine.status, 200);
  const vecchio = await entra(s.base, { username: 'prova', password: 'password-recuperata', secret });
  assert.equal(vecchio.r.status, 400, 'il vecchio telefono non entra');
  secret = inizio.secret;
  sessione = await entra(s.base, { username: 'prova', password: 'password-recuperata', secret, remember: true });
  assert.equal(sessione.r.status, 200);
});

test('esci da tutti i dispositivi tiene dentro chi lo chiede; il registro è consultabile', async () => {
  const altra = await entra(s.base, { username: 'prova', password: 'password-recuperata', cookieDispositivo: sessione.dispositivo });
  assert.equal((await fetch(`${s.base}/api/auth/logout-all`, { method: 'POST', headers: conSessione(sessione) })).status, 200);
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: altra.cookie } })).status, 401);
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).status, 200);
  const { eventi } = await elenco(s, '/api/registro');
  const tipi = new Set(eventi.map((e) => e.kind));
  for (const t of ['login_riuscito', 'login_fallito', 'password_cambiata', 'password_recuperata', 'authenticator_reimpostato', 'sessioni_chiuse', 'backup_creato', 'backup_ripristinato', 'file_cestinato', 'file_eliminato']) assert.ok(tipi.has(t), t);
  assert.ok(eventi.every((e) => !JSON.stringify(e).includes('password-recuperata')), 'niente password nel registro');
});

test('dopo 5 password sbagliate blocca per IP e per nome utente; il blocco resta dopo il riavvio', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await entra(s.base, { username: 'prova', password: 'sbagliata-di-prova', secret })).r.status, 400);
  const bloccato = await post(s.base, '/api/auth/login', { username: 'prova', password: 'password-recuperata', code: '' }, { Cookie: sessione.dispositivo });
  assert.equal(bloccato.status, 429, 'bloccato anche con la password giusta');
  assert.equal((await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: sessione.cookie } })).status, 200, 'le sessioni aperte restano');
  await ferma(s);
  porta++;
  s = await avviaServer(cartella);
  const ancora = await post(s.base, '/api/auth/login', { username: 'prova', password: 'password-recuperata', code: '' }, { Cookie: sessione.dispositivo });
  assert.equal(ancora.status, 429, 'il blocco è su disco');
  assert.ok(emailInviate(s).some((m) => /tentativo di accesso/i.test(m.subject)));
});

test('l\'app avvisa quando ha un problema: disco sotto il margine', async () => {
  const { creaApp, leggiConfigurazione } = await import('../src/app.js');
  const dir = nuovaCartella();
  const posta = path.join(dir, 'posta');
  const env = { CARTELLA_DATI: dir, CARTELLA_BACKUP: path.join(dir, 'backup'), DIGISHARE_AUTH_KEY: CHIAVE, POSTA_FINTA: posta, MARGINE_DISCO_GB: '999999' };
  const istanza = await creaApp(leggiConfigurazione(env), env);
  try {
    const problema = await istanza.controllaSalute();
    assert.match(problema, /restano solo/);
    const email = fs.readdirSync(posta).map((f) => JSON.parse(fs.readFileSync(path.join(posta, f), 'utf8')));
    assert.ok(email.some((m) => /ha un problema/.test(m.subject)));
    assert.equal(istanza.sicurezza.events().some((e) => e.kind === 'app_ferma'), true);
  } finally {
    istanza.chiudi();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('senza chiave il server non parte; sul NAS la configurazione iniziale si apre solo con DIGISHARE_ALLOW_SETUP=1', async () => {
  const dir = nuovaCartella();
  porta++;
  const senza = spawn(process.execPath, ['src/server.js'], { cwd: RADICE, env: { ...process.env, PORTA: String(porta), CARTELLA_DATI: dir, DIGISHARE_AUTH_KEY: '' }, stdio: 'ignore' });
  const codiceUscita = await new Promise((r) => senza.once('exit', r));
  assert.equal(codiceUscita, 1);
  porta++;
  const chiuso = await avviaServer(dir, { INDIRIZZO: '127.0.0.1' });
  // Da questo PC (127.0.0.1 senza proxy) la configurazione è aperta anche senza la variabile.
  assert.equal((await (await fetch(`${chiuso.base}/api/auth/status`)).json()).setupAllowed, true);
  await ferma(chiuso);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('categorie: proposta automatica, nuova, rinomina, elimina; titolo e categoria del file si cambiano', async () => {
  // Viene dopo il blocco per troppi tentativi: si usa la sessione già aperta, che resta valida.
  const sess = sessione;
  const h = conSessione(sess);
  const { categorie } = await (await fetch(`${s.base}/api/categorie`, { headers: h })).json();
  assert.deepEqual(categorie.map((c) => c.nome), ['Tutorial', 'Varie']);
  const tutorial = categorie[0].id;
  const upParola = await carica(s.base, sess, crypto.randomBytes(2000), { metadata: { filename: 'Tutorial DiGiRec installazione.mp4', filetype: 'video/mp4' } });
  const upScelta = await carica(s.base, sess, crypto.randomBytes(2000), { metadata: { filename: 'Presentazione.pdf', filetype: 'application/pdf', categoria: String(categorie[1].id) } });
  const upSimile = await carica(s.base, sess, crypto.randomBytes(2000), { metadata: { filename: 'Presentazione seconda parte.pdf', filetype: 'application/pdf' } });
  const upNiente = await carica(s.base, sess, crypto.randomBytes(2000), { metadata: { filename: 'zzz.bin', filetype: 'application/octet-stream' } });
  const { file } = await (await fetch(`${s.base}/api/file`, { headers: h })).json();
  const trova = (up) => file.find((f) => f.id === up.url.split('/').pop());
  assert.equal(trova(upParola).categoriaId, tutorial, 'parola nel titolo');
  assert.equal(trova(upParola).titolo, 'Tutorial DiGiRec installazione', 'titolo senza estensione');
  assert.equal(trova(upScelta).categoriaId, categorie[1].id, 'categoria aperta al caricamento');
  assert.equal(trova(upSimile).categoriaId, categorie[1].id, 'stessa prima parola di un file già in categoria');
  assert.equal(trova(upNiente).categoriaId, null);

  const nuova = await post(s.base, '/api/categorie', { nome: '  Clienti  ' }, h);
  assert.equal(nuova.status, 200);
  const { id } = await nuova.json();
  assert.equal((await post(s.base, '/api/categorie', { nome: 'clienti' }, h)).status, 409, 'doppione, anche con maiuscole diverse');
  assert.equal((await post(s.base, '/api/categorie', { nome: '   ' }, h)).status, 400);
  const mod = await fetch(`${s.base}/api/file/${trova(upNiente).id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ titolo: 'Fattura <b>ottobre</b>', categoriaId: id }) });
  assert.equal(mod.status, 200);
  const dopo = (await mod.json()).file;
  assert.equal(dopo.titolo, 'Fattura <b>ottobre</b>', 'il titolo resta testo: lo protegge la pagina');
  assert.equal(dopo.categoriaId, id);
  assert.equal((await fetch(`${s.base}/api/file/${trova(upNiente).id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ titolo: '' }) })).status, 400);
  assert.equal((await fetch(`${s.base}/api/file/${trova(upNiente).id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ categoriaId: 99999 }) })).status, 400);
  assert.equal((await fetch(`${s.base}/api/categorie/${id}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Lavori clienti' }) })).status, 200);
  assert.equal((await fetch(`${s.base}/api/categorie/${id}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Varie' }) })).status, 409);
  const conteggi = (await (await fetch(`${s.base}/api/categorie`, { headers: h })).json()).categorie;
  assert.equal(conteggi.find((c) => c.id === id).quanti, 1);
  assert.equal((await fetch(`${s.base}/api/categorie/${id}`, { method: 'DELETE', headers: h })).status, 200);
  const rimasti = (await (await fetch(`${s.base}/api/file`, { headers: h })).json()).file;
  assert.equal(rimasti.find((f) => f.id === trova(upNiente).id).categoriaId, null, 'il file resta, senza categoria');
  const { eventi } = await (await fetch(`${s.base}/api/registro`, { headers: h })).json();
  for (const t of ['categoria_creata', 'categoria_rinominata', 'categoria_eliminata', 'file_modificato']) assert.ok(eventi.some((e) => e.kind === t), t);
});

// ---- condivisione, visione, 1080p, IA (IA_FINTA), promemoria e archiviazione ----
async function videoDiProva() {
  const file = path.join(os.tmpdir(), `digishare-video-prova-${process.pid}.mp4`);
  if (!fs.existsSync(file)) {
    const { execFile } = await import('node:child_process');
    await new Promise((res, rej) => execFile('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true }, (e) => (e ? rej(e) : res())));
  }
  return fs.readFileSync(file);
}
const aspetta = async (cond, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await cond(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } throw new Error('tempo scaduto'); };

test('condivisione: link per chiunque, pagina di visione, video a pezzi, niente scaricamento se non permesso, revoca', async () => {
  const h = conSessione(sessione);
  const dati = await videoDiProva();
  const up = await carica(s.base, sessione, dati, { metadata: { filename: 'Tutorial condivisione.mp4', filetype: 'video/mp4' } });
  const id = up.url.split('/').pop();
  const pronto = await aspetta(async () => (await elenco(s)).file.find((f) => f.id === id && f.visione === 1 && f.ia === 1));
  assert.equal(pronto.sottotitoli, 1, "sottotitoli dall'IA finta");
  assert.ok(pronto.capitoli.length >= 2, 'capitoli dentro la durata del video');
  assert.match(pronto.descrizione, /DiGiRec/);
  assert.equal(fs.existsSync(path.join(cartella, 'visione', `${id}.mp4`)), false, 'niente doppione per un MP4 H.264 fino a 1080p');
  assert.equal(fs.existsSync(path.join(cartella, 'audio', `${id}.ogg`)), false, 'audio tolto dopo la trascrizione');

  // titoli dei capitoli corretti a mano: i minuti non cambiano
  const patch = (body) => fetch(`${s.base}/api/file/${id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const titoli = pronto.capitoli.map((c) => c.titolo);
  titoli[1] = 'Titolo corretto';
  const corretto = await patch({ titoliCapitoli: titoli });
  assert.equal(corretto.status, 200);
  const doppo = (await corretto.json()).file;
  assert.equal(doppo.capitoli[1].titolo, 'Titolo corretto');
  assert.deepEqual(doppo.capitoli.map((c) => c.secondi), pronto.capitoli.map((c) => c.secondi));
  assert.equal(doppo.descrizione, pronto.descrizione, 'il riassunto non cambia');
  assert.equal((await patch({ titoliCapitoli: ['solo uno'] })).status, 400, 'numero di capitoli sbagliato');
  assert.equal((await patch({ titoliCapitoli: titoli.map(() => ' ') })).status, 400, 'titolo vuoto');

  const vietato = await post(s.base, `/api/file/${id}/link`, { chi: 'chiunque', scadenza: 2, scarica: false }, h);
  assert.equal(vietato.status, 400, 'scadenza fuori da 1/7/30/mai');
  const r = await post(s.base, `/api/file/${id}/link`, { chi: 'chiunque', scadenza: 7, scarica: false }, h);
  const testoR = await r.text();
  assert.equal(r.status, 200, testoR);
  const { link } = JSON.parse(testoR);
  assert.equal(link.length, 1);
  assert.match(link[0].url, new RegExp(`^${s.base}/v/[A-Za-z0-9]{8}$`));
  assert.ok(link[0].scadeIl > Date.now() + 6.9 * 24 * 3600 * 1000);
  const codice = link[0].codice;
  const dopo = (await elenco(s)).file.find((f) => f.id === id);
  assert.deepEqual(dopo.link, { attivi: 1, scaduti: 0, aperture: 0 });

  // chi riceve il link: niente sessione
  const pagina = await fetch(`${s.base}/v/${codice}`);
  assert.equal(pagina.status, 200);
  const testoPagina = await pagina.text();
  assert.match(testoPagina, /visione\.js/);
  const icona = testoPagina.match(/property="og:image" content="([^"]+)"/);
  assert.ok(icona, 'anteprima per WhatsApp presente');
  assert.equal((await fetch(icona[1])).status, 200, 'l\'immagine dell\'anteprima si apre senza sessione');
  assert.equal((await elenco(s)).file.find((f) => f.id === id).link.aperture, 0, 'l\'anteprima non conta come apertura');
  const d = await (await fetch(`${s.base}/v/${codice}/dati?visita=abcdefgh12345678`)).json();
  assert.equal(d.tipo, 'file');
  assert.equal(d.scarica, false);
  assert.equal(d.file.titolo, 'Tutorial condivisione');
  assert.ok(d.file.capitoli.length >= 2);
  assert.equal(d.file.sottotitoli, true);
  const pezzo = await fetch(`${s.base}/v/${codice}/f/${id}/video`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(pezzo.status, 206, 'il video si manda a pezzi (Range)');
  assert.equal(pezzo.headers.get('content-type'), 'video/mp4');
  assert.equal((await pezzo.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${s.base}/v/${codice}/f/${id}/scarica`)).status, 403, 'scaricamento non permesso');
  assert.equal((await fetch(`${s.base}/v/${codice}/f/${id}/copertina`)).status, 200);
  const vtt = await fetch(`${s.base}/v/${codice}/f/${id}/sottotitoli.vtt`);
  assert.equal(vtt.status, 200);
  assert.match(await vtt.text(), /^WEBVTT/);
  const visto = await fetch(`${s.base}/v/${codice}/visto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visita: 'abcdefgh12345678', secondi: 5.5, file: id }) });
  assert.equal(visto.status, 204);
  const stat = await (await fetch(`${s.base}/api/link/${link[0].id}/visite`, { headers: h })).json();
  assert.equal(stat.link.aperture, 1);
  assert.equal(stat.visite.length, 1);
  assert.equal(stat.visite[0].secondiVisti, 5.5);

  const altroFile = (await elenco(s)).file.find((f) => f.id !== id);
  assert.equal((await fetch(`${s.base}/v/${codice}/f/${altroFile.id}/video`)).status, 404, 'il link apre solo il suo file');
  assert.equal((await fetch(`${s.base}/api/link/${link[0].id}`, { method: 'DELETE', headers: h })).status, 200);
  const revocato = await fetch(`${s.base}/v/${codice}/dati`);
  assert.equal(revocato.status, 410);
  assert.equal((await revocato.json()).stato, 'revocato');
  assert.equal((await fetch(`${s.base}/v/${codice}/f/${id}/video`)).status, 410);
  assert.equal((await fetch(`${s.base}/v/ZZZZZZZZ/dati`)).status, 404);
});

test('condivisione: link personali per email, scaricamento permesso, scadenza, prolunga, cartella condivisa', async () => {
  const h = conSessione(sessione);
  const f = (await elenco(s)).file.find((x) => x.titolo === 'Tutorial condivisione');
  const prima = emailInviate(s).length;
  const r = await post(s.base, `/api/file/${f.id}/link`, { chi: 'email', email: ['Mario@Esempio.it', 'luca@esempio.it', 'mario@esempio.it'], scadenza: 1, scarica: true, inviaEmail: true }, h);
  const testoR = await r.text();
  assert.equal(r.status, 200, testoR);
  const { link, erroriEmail } = JSON.parse(testoR);
  assert.equal(link.length, 2, 'un link per persona, senza doppioni');
  assert.deepEqual(erroriEmail, []);
  const email = emailInviate(s).slice(prima);
  assert.equal(email.length, 2);
  assert.ok(email.some((m) => m.to === 'mario@esempio.it' && m.text.includes(link.find((l) => l.destinatario === 'mario@esempio.it').url)));
  assert.equal((await post(s.base, `/api/file/${f.id}/link`, { chi: 'email', email: ['non-valida'], scadenza: 7, scarica: false }, h)).status, 400);
  const sc = await fetch(`${s.base}/v/${link[0].codice}/f/${f.id}/scarica`);
  assert.equal(sc.status, 200, 'scaricamento permesso');
  assert.match(sc.headers.get('content-disposition'), /attachment/);
  assert.equal((await elenco(s)).file.find((x) => x.id === f.id).link.attivi, 2);

  // scadenza passata: il link non apre piu'; Prolunga lo rimette per 30 giorni
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(cartella, 'digishare.sqlite'));
  db.prepare('UPDATE link SET scade_il = ? WHERE id = ?').run(Date.now() - 1000, link[1].id);
  db.close();
  const scaduto = await fetch(`${s.base}/v/${link[1].codice}/dati`);
  assert.equal(scaduto.status, 410);
  assert.equal((await scaduto.json()).stato, 'scaduto');
  assert.equal((await elenco(s)).file.find((x) => x.id === f.id).link.scaduti, 1);
  const pro = await (await fetch(`${s.base}/api/link/${link[1].id}/prolunga`, { method: 'POST', headers: h })).json();
  assert.ok(pro.link.scadeIl > Date.now() + 29 * 24 * 3600 * 1000);
  assert.equal((await fetch(`${s.base}/v/${link[1].codice}/dati`)).status, 200);
  const invio = await fetch(`${s.base}/api/link/${link[1].id}/invia`, { method: 'POST', headers: h });
  assert.equal(invio.status, 200);

  // cartella condivisa
  const { categorie } = await (await fetch(`${s.base}/api/categorie`, { headers: h })).json();
  const tutorial = categorie.find((c) => c.nome === 'Tutorial');
  await fetch(`${s.base}/api/file/${f.id}`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ categoriaId: tutorial.id }) });
  const rc = await post(s.base, `/api/categorie/${tutorial.id}/link`, { chi: 'chiunque', scadenza: 0, scarica: false }, h);
  const testoRc = await rc.text();
  assert.equal(rc.status, 200, testoRc);
  const cart = JSON.parse(testoRc).link[0];
  assert.equal(cart.scadeIl, null, 'mai');
  const dc = await (await fetch(`${s.base}/v/${cart.codice}/dati`)).json();
  assert.equal(dc.tipo, 'cartella');
  assert.equal(dc.nome, 'Tutorial');
  assert.ok(dc.file.some((x) => x.id === f.id));
  assert.equal((await fetch(`${s.base}/v/${cart.codice}/f/${f.id}/video`, { headers: { Range: 'bytes=0-9' } })).status, 206);
  const fuoriCartella = (await elenco(s)).file.find((x) => x.categoriaId !== tutorial.id);
  assert.equal((await fetch(`${s.base}/v/${cart.codice}/f/${fuoriCartella.id}/video`)).status, 404, "un file di un'altra categoria non si apre");
  const { eventi } = await elenco(s, '/api/registro');
  for (const t of ['link_creato', 'link_inviato', 'link_revocato', 'link_prolungato', 'video_pronto', 'ia_completata']) assert.ok(eventi.some((e) => e.kind === t), t);
});

test('promemoria due giorni prima della scadenza e proposta di archiviazione dei file mai aperti', async () => {
  const { creaApp, leggiConfigurazione } = await import('../src/app.js');
  const dir = nuovaCartella();
  const posta = path.join(dir, 'posta');
  const env = { CARTELLA_DATI: dir, CARTELLA_BACKUP: path.join(dir, 'backup'), DIGISHARE_AUTH_KEY: CHIAVE, POSTA_FINTA: posta, MARGINE_DISCO_GB: '0', FFMPEG: 'programma-inesistente', FFPROBE: 'programma-inesistente' };
  const istanza = await creaApp(leggiConfigurazione(env), env);
  try {
    const adesso = Date.now();
    istanza.db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, titolo) VALUES (?, ?, ?, ?, ?, ?)').run('a'.repeat(32), 'vecchio.mp4', 'video/mp4', 5e9, adesso - 200 * 24 * 3600 * 1000, 'Video vecchio mai aperto');
    istanza.db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, titolo) VALUES (?, ?, ?, ?, ?, ?)').run('b'.repeat(32), 'nuovo.mp4', 'video/mp4', 1e9, adesso - 10 * 24 * 3600 * 1000, 'Video nuovo');
    const { link } = await istanza.condivisione.crea({ fileId: 'a'.repeat(32), chi: 'chiunque', scadenza: 1, scarica: false, titolo: 'Video vecchio mai aperto' }, '');
    const { link: lontano } = await istanza.condivisione.crea({ fileId: 'b'.repeat(32), chi: 'chiunque', scadenza: 30, scarica: false, titolo: 'Video nuovo' }, '');
    assert.equal(await istanza.condivisione.promemoriaScadenze(() => 'Video vecchio mai aperto'), 1, 'solo quello che scade entro due giorni');
    assert.equal(await istanza.condivisione.promemoriaScadenze(() => 'x'), 0, 'una volta sola');
    const email = () => fs.readdirSync(posta).map((f) => JSON.parse(fs.readFileSync(path.join(posta, f), 'utf8')));
    const prom = email().find((m) => /scade fra due giorni/.test(m.subject));
    assert.ok(prom && prom.text.includes('Video vecchio mai aperto') && /Prolunga/.test(prom.text));
    assert.ok(link[0] && lontano[0]);
    assert.equal(await istanza.condivisione.proponiArchiviazione((b) => `${(b / 1e9).toFixed(1)} GB`), 1, 'solo il file vecchio mai aperto');
    const arch = email().find((m) => /senza aperture/.test(m.subject));
    assert.ok(arch && arch.text.includes('Video vecchio mai aperto') && !arch.text.includes('Video nuovo'));
    assert.equal(await istanza.condivisione.proponiArchiviazione(() => ''), 0, 'segnalato una volta sola');
  } finally {
    istanza.chiudi();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
