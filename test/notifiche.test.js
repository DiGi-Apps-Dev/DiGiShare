// Notifiche sul telefono su server vero con dati temporanei: i messaggi non partono, finiscono in file (PUSH_FINTA).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';
import { endpointConsentito } from '../src/notifiche.js';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 5193;
const BASE = `http://127.0.0.1:${PORTA}`;
const TELEFONO = 'https://fcm.googleapis.com/fcm/send/telefono-di-prova';
const ABBONAMENTO = { endpoint: TELEFONO, keys: { p256dh: 'chiave', auth: 'segreto' } };
let server; let cartella; let cookie; let csrf; let fuori;

const chiama = async (via, metodo = 'GET', corpo) => {
  const r = await fetch(`${BASE}${via}`, { method: metodo, headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const testo = await r.text();
  let dati; try { dati = JSON.parse(testo); } catch { dati = testo; }
  return { status: r.status, dati };
};
const b64 = (t) => Buffer.from(t).toString('base64');
async function carica(nome, tipo, corpo, extra = {}) {
  const meta = Object.entries({ filename: nome, filetype: tipo, ...extra }).map(([k, v]) => `${k} ${b64(v)}`).join(',');
  const c = await fetch(`${BASE}/api/caricamenti`, { method: 'POST', headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(corpo.length), 'Upload-Metadata': meta, Origin: BASE } });
  assert.equal(c.status, 201);
  const dove = new URL(c.headers.get('location'), BASE).href;
  const p = await fetch(dove, { method: 'PATCH', headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', Origin: BASE }, body: corpo });
  assert.equal(p.status, 204);
  return dove.split('/').pop();
}
const messaggi = () => (fs.existsSync(fuori) ? fs.readdirSync(fuori).map((n) => JSON.parse(fs.readFileSync(path.join(fuori, n), 'utf8'))) : []);
async function aspettaMessaggio(url) {
  for (let i = 0; i < 1800; i++) {
    const m = messaggi().filter((x) => x.url === url);
    if (m.length) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Nessuna notifica per ${url}`);
}

before(async () => {
  cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-notifiche-'));
  fuori = `${cartella}-push`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: RADICE,
    env: { ...process.env, PORTA: String(PORTA), CARTELLA_DATI: cartella, CARTELLA_BACKUP: `${cartella}-backup`, POSTA_FINTA: `${cartella}-posta`, PUSH_FINTA: fuori, IA_FINTA: '1', MARGINE_DISCO_GB: '0', DIGISHARE_AUTH_KEY: crypto.randomBytes(32).toString('base64url'), SECURITY_EMAIL_TO: 'prova@example.test' },
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
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [cartella, fuori, `${cartella}-backup`, `${cartella}-posta`]) fs.rmSync(d, { recursive: true, force: true });
});

test('solo i servizi dei produttori possono ricevere', () => {
  assert.equal(endpointConsentito(TELEFONO), true);
  for (const e of ['http://fcm.googleapis.com/x', 'https://10.0.0.1/x', 'https://fcm.googleapis.com.cattivo.test/x', 'https://u:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', '', null]) assert.equal(endpointConsentito(e), false, String(e));
});

test('le rotte vogliono la sessione; la chiave VAPID nasce una volta sola e la privata non esce', async () => {
  assert.equal((await fetch(`${BASE}/api/push/stato`)).status, 401);
  const a = await chiama('/api/push/stato');
  const b = await chiama('/api/push/stato');
  assert.equal(a.status, 200);
  assert.match(a.dati.chiave, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(a.dati.chiave, b.dati.chiave);
  assert.deepEqual(Object.keys(a.dati).sort(), ['abbonati', 'chiave']);
});

test('abbonarsi: destinazioni estranee rifiutate, lo stesso telefono non si conta due volte', async () => {
  assert.equal((await chiama('/api/push/abbonati', 'POST', { endpoint: 'https://10.0.0.1/x', keys: ABBONAMENTO.keys })).status, 400);
  assert.equal((await chiama('/api/push/abbonati', 'POST', { endpoint: TELEFONO })).status, 400);
  assert.equal((await chiama('/api/push/abbonati', 'POST', ABBONAMENTO)).status, 200);
  assert.equal((await chiama('/api/push/abbonati', 'POST', ABBONAMENTO)).status, 200);
  assert.equal((await chiama('/api/push/stato')).dati.abbonati, 1);
});

test('la prova va al telefono che la chiede, e solo se è abbonato', async () => {
  assert.equal((await chiama('/api/push/prova', 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/altro' })).status, 400);
  const r = await chiama('/api/push/prova', 'POST', { endpoint: TELEFONO });
  assert.equal(r.dati.inviate, 1);
  assert.equal(messaggi().at(-1).testo, 'Le notifiche funzionano.');
});

test('una nota pronta manda una notifica che apre quella nota, col titolo scritto dall\'utente', async () => {
  const prova = path.join(os.tmpdir(), `notifica-${process.pid}.ogg`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus', '-b:a', '24k', prova]);
  const audio = fs.readFileSync(prova);
  fs.rmSync(prova, { force: true });
  const id = await carica('DiGiNotes-7-1793548358821.ogg', 'audio/ogg', audio, { genere: 'appuntamento', titolo: 'Visita al cantiere' });
  const [m, ...altri] = await aspettaMessaggio(`/nota/${id}`);
  assert.equal(altri.length, 0);
  assert.equal(m.titolo, 'Nota pronta');
  assert.equal(m.testo, 'Visita al cantiere');
  assert.equal(m.endpoint, TELEFONO);
  assert.equal((await chiama(`/api/note/${id}`)).dati.file.titolo, 'Visita al cantiere');
});

test('senza titolo scritto dall\'utente il titolo lo decide l\'IA', async () => {
  const prova = path.join(os.tmpdir(), `notifica2-${process.pid}.ogg`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus', '-b:a', '24k', prova]);
  const audio = fs.readFileSync(prova);
  fs.rmSync(prova, { force: true });
  const id = await carica('DiGiNotes-8-1793548358822.ogg', 'audio/ogg', audio, { genere: 'appuntamento', titolo: '' });
  const [m] = await aspettaMessaggio(`/nota/${id}`);
  assert.notEqual(m.testo, 'DiGiNotes-8-1793548358822');
});

test('un video pronto manda una notifica che apre quel video; se il telefono non c\'è più si toglie', async () => {
  const prova = path.join(os.tmpdir(), `notifica-${process.pid}.mp4`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', prova]);
  const video = fs.readFileSync(prova);
  fs.rmSync(prova, { force: true });
  assert.equal((await chiama('/api/push/abbonati', 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/sparito', keys: ABBONAMENTO.keys })).status, 200);
  const id = await carica('riunione.mp4', 'video/mp4', video);
  const [m] = await aspettaMessaggio(`/?file=${id}`);
  assert.equal(m.titolo, 'Video pronto');
  assert.equal(m.testo, 'riunione');
  assert.equal((await chiama('/api/push/stato')).dati.abbonati, 1);
});

test('spegnere: il telefono esce dall\'elenco', async () => {
  assert.equal((await chiama('/api/push/disdici', 'POST', { endpoint: TELEFONO })).status, 200);
  assert.equal((await chiama('/api/push/stato')).dati.abbonati, 0);
});

test('il service worker disegna l\'avviso e il tocco apre proprio quell\'elemento', async () => {
  const eventi = {}; const mostrate = []; const aperte = []; let finestre = [];
  const contesto = {
    URL,
    self: { addEventListener: (n, f) => { eventi[n] = f; }, skipWaiting() {}, location: { origin: 'https://digishare.test' }, registration: { showNotification: async (t, o) => { mostrate.push({ t, o }); } } },
    clients: { claim: async () => {}, matchAll: async () => finestre, openWindow: async (u) => { aperte.push(u); } },
  };
  contesto.addEventListener = contesto.self.addEventListener;
  vm.runInNewContext(fs.readFileSync(path.join(RADICE, 'public', 'sw.js'), 'utf8'), contesto);

  let attesa;
  eventi.push({ data: { json: () => ({ titolo: 'Nota pronta', testo: 'Cantiere', url: '/nota/abc' }) }, waitUntil: (p) => { attesa = p; } });
  await attesa;
  assert.equal(mostrate[0].t, 'Nota pronta');
  assert.equal(mostrate[0].o.body, 'Cantiere');
  assert.equal(mostrate[0].o.data.url, '/nota/abc');
  assert.equal(mostrate[0].o.tag, undefined);
  assert.equal((await fetch(`${BASE}${mostrate[0].o.icon}`)).status, 200);
  assert.equal((await fetch(`${BASE}${mostrate[0].o.badge}`)).status, 200);

  eventi.push({ data: { json: () => { throw new Error('rotto'); } }, waitUntil: (p) => { attesa = p; } });
  await attesa;
  assert.equal(mostrate[1].t, 'DiGiShare');

  const tocca = async () => { eventi.notificationclick({ notification: { close() {}, data: { url: '/nota/abc' } }, waitUntil: (p) => { attesa = p; } }); await attesa; };
  await tocca();
  assert.deepEqual(aperte, ['https://digishare.test/nota/abc']);
  const portate = []; let davanti = 0;
  finestre = [{ navigate: async (u) => { portate.push(u); return { focus: async () => { davanti++; } }; } }];
  await tocca();
  assert.deepEqual(portate, ['https://digishare.test/nota/abc']);
  assert.equal(davanti, 1);
  assert.equal(aperte.length, 1);
});
