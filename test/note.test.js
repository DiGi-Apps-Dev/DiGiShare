// Note di DiGiNotes su server vero con dati temporanei: l'IA è finta (IA_FINTA), l'audio passa da ffmpeg davvero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';
import { nomiGiusti, promptWhisper, righeContesto, lingua, creaIa, sezioniDaVoci, riferimentiDi, riferimentiMancanti, unisciVoci, cifreFinali, statoDegliArgomenti } from '../src/ia.js';
import { apriDb, oraRegistrazione } from '../src/db.js';
import { creaNote } from '../src/note.js';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 5191;
const BASE = `http://127.0.0.1:${PORTA}`;
let server; let cartella; let cookie; let csrf; let audio;

const chiama = async (via, opzioni = {}) => {
  const r = await fetch(`${BASE}${via}`, { ...opzioni, headers: { Cookie: cookie, 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...opzioni.headers } });
  const testo = await r.text();
  let dati; try { dati = JSON.parse(testo); } catch { dati = testo; }
  return { status: r.status, dati, r };
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
async function aspetta(id, stato = 'pronta') {
  for (let i = 0; i < 1500; i++) {
    const { dati } = await chiama(`/api/note/${id}`);
    if (dati.nota?.stato === stato) return dati;
    if (dati.nota?.stato === 'errore') throw new Error(dati.nota.errore);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Nota non pronta');
}
const fileApp = async () => (await chiama('/api/file')).dati;

before(async () => {
  cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-note-'));
  const prova = path.join(cartella, '..', `prova-${process.pid}.ogg`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus', '-b:a', '24k', prova]);
  audio = fs.readFileSync(prova);
  fs.rmSync(prova, { force: true });
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: RADICE,
    env: { ...process.env, PORTA: String(PORTA), CARTELLA_DATI: cartella, CARTELLA_BACKUP: `${cartella}-backup`, POSTA_FINTA: `${cartella}-posta`, IA_FINTA: '1', MARGINE_DISCO_GB: '0', DIGISHARE_AUTH_KEY: crypto.randomBytes(32).toString('base64url'), SECURITY_EMAIL_TO: 'prova@example.test' },
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
  for (const d of [cartella, `${cartella}-backup`, `${cartella}-posta`]) fs.rmSync(d, { recursive: true, force: true });
});

let appuntamento;

test('appuntamento: testo con chi parla, riassunto a sezioni, titolo, durata, email', async () => {
  appuntamento = await carica('DiGiNotes-1-123.ogg', 'audio/ogg', audio, { genere: 'appuntamento' });
  const { file, nota } = await aspetta(appuntamento);
  assert.equal(file.titolo, 'Rinnovo polizza');
  assert.ok(file.durata > 2);
  assert.equal(nota.genere, 'appuntamento');
  assert.equal(nota.tipoIncontro, 'Colloquio');
  assert.deepEqual(nota.segmenti.slice(0, 2).map((s) => s.chi), ['Persona 1', 'Persona 2']);
  assert.deepEqual(nota.riassunto.map((s) => s.titolo), ['Punti discussi', 'Cose da fare']);
  const mail = fs.readdirSync(`${cartella}-posta`).map((n) => JSON.parse(fs.readFileSync(path.join(`${cartella}-posta`, n), 'utf8'))).filter((m) => m.subject.startsWith('DiGiNotes'));
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /Franchigia portata a CHF 300/);
  assert.match(mail[0].text, /Benvenuti in questo tutorial/);
  assert.equal(nota.segmenti[1].traduzione, 'Oggi vediamo come installare il programma.');
  assert.match(mail[0].text, /Hoy vemos[\s\S]*Oggi vediamo/);
  assert.ok((await chiama('/api/registro')).dati.eventi.some((e) => e.kind === 'nota_email_inviata'), 'l\'esito dell\'email resta scritto');
});

test('audio pulito: dopo il testo arriva la copia pulita, l\'originale resta', async () => {
  let n;
  for (let i = 0; i < 200; i++) { ({ nota: n } = (await chiama(`/api/note/${appuntamento}`)).dati); if (n.pulita) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(n.pulita, 1);
  const leggi = async (via) => Buffer.from(await (await fetch(`${BASE}/api/file/${appuntamento}/${via}`, { headers: { Cookie: cookie } })).arrayBuffer());
  assert.ok((await leggi('audio?originale=1')).equals(audio));
  const pulito = await leggi('audio');
  assert.equal(pulito.subarray(0, 4).toString(), 'OggS');
  assert.ok(!pulito.equals(audio));
});

test('nota vocale: solo testo e titolo, niente riassunto e niente email', async () => {
  const id = await carica('DiGiNotes-2-456.ogg', 'audio/ogg', audio, { genere: 'idea' });
  const { file, nota } = await aspetta(id);
  assert.equal(file.titolo, 'Idea di prova');
  assert.equal(nota.genere, 'idea');
  assert.deepEqual(nota.riassunto, []);
  assert.ok(nota.segmenti.length);
  const mail = fs.readdirSync(`${cartella}-posta`).map((n) => JSON.parse(fs.readFileSync(path.join(`${cartella}-posta`, n), 'utf8'))).filter((m) => m.subject.includes('Idea di prova'));
  assert.equal(mail.length, 0);
});

test('glossario, voci, memoria e lingua arrivano dal telefono e finiscono nei comandi', async () => {
  const r = await chiama('/api/note/contesto', { method: 'PUT', body: JSON.stringify({ glossario: [' Ticino ', ''], voci: ['Luca'], memoria: ['Lavoro in Italia.'], lingua: 'Tedesco', altro: 'via' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dati.contesto, { glossario: ['Ticino'], voci: ['Luca'], memoria: ['Lavoro in Italia.'], lingua: 'Tedesco' });
  assert.match(promptWhisper(r.dati.contesto), /DiGiShare.*Ticino, Luca\.$/);
  assert.ok(promptWhisper({ glossario: ['x'.repeat(2000)] }).length <= 801);
  assert.match(righeContesto(r.dati.contesto), /Ticino[\s\S]*Luca[\s\S]*Lavoro in Italia/);
  assert.equal(righeContesto({}), '');
  assert.equal(lingua({}), 'Italiano');
  assert.match(lingua({ lingua: 'Tedesco' }), /tradotti in Tedesco/);
  // Una nota lavorata con il contesto salvato arriva in fondo come le altre.
  const id = await carica('DiGiNotes-9-1793547539425.ogg', 'audio/ogg', audio, { genere: 'idea' });
  const { file } = await aspetta(id);
  assert.equal(file.caricatoIl, 1793547539425, 'la data è quella della registrazione, non del caricamento');
  assert.equal(oraRegistrazione('Video Anna-Io.mp4'), null);
  assert.equal(oraRegistrazione('DiGiNotes-9-1793547539425-1.ogg'), 1793547539425);
  await chiama(`/api/file/${id}/visto`, { method: 'POST', body: '{}' });
  assert.equal((await fetch(`${BASE}/api/note/contesto`, { method: 'PUT' })).status, 401);
});

test('Gemini lavora a pezzi con gli orari in fila; se fallisce fa Whisper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-metodo-'));
  const lungo = path.join(dir, 'lungo.ogg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1300', '-c:a', 'libopus', '-b:a', '24k', lungo]);
  for (const d of ['file', 'audio', 'pulito']) fs.mkdirSync(path.join(dir, d));
  const db = apriDb(dir);
  let ko = false;
  const pezzi = [];
  const ia = {
    disponibile: true,
    trascriviParlato: async (f) => { if (ko) throw new Error('Gemini spento'); pezzi.push(f); return [{ inizio: 1, fine: 2, chi: 'Io', testo: 'ciao' }]; },
    trascrivi: async () => [{ start: 0, end: 2, text: 'da Whisper' }],
    chiParla: async (_, s) => s.map((x) => ({ ...x, chi: 'Persona 1' })),
    titoloBreve: async () => '',
  };
  const note = creaNote({ db, ia, posta: { configured: false }, cartellaFile: path.join(dir, 'file'), cartellaAudio: path.join(dir, 'audio'), cartellaPulito: path.join(dir, 'pulito'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', indirizzoPubblico: () => '' });
  const fai = async (id) => {
    fs.copyFileSync(lungo, path.join(dir, 'file', id));
    db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, modificato_il) VALUES (?, ?, ?, 1, 1, 1)').run(id, `${id}.ogg`, 'audio/ogg');
    note.accoda(id, 'idea');
    for (let i = 0; i < 600 && note.nota(id)?.pulita === 0; i++) await new Promise((r) => setTimeout(r, 100));
    return note.nota(id);
  };
  const a = await fai('a'.repeat(32));
  assert.equal(a.stato, 'pronta');
  assert.deepEqual(a.segmenti.map((s) => s.inizio), [1, 601, 1201]);
  assert.equal(pezzi.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'audio')).filter((n) => n.startsWith('parlato-')), []);
  ko = true;
  const b = await fai('b'.repeat(32));
  assert.equal(b.stato, 'pronta');
  assert.deepEqual(b.segmenti.map((s) => s.testo), ['da Whisper']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la voce dell\'utente: la persona che somiglia al campione diventa Io, anche nelle frasi corte; gli altri no', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-voce-'));
  for (const d of ['file', 'audio', 'pulito']) fs.mkdirSync(path.join(dir, d));
  const db = apriDb(dir);
  const frasi = [{ inizio: 0, fine: 1, chi: 'Io', testo: 'Chi sei?' }, { inizio: 1, fine: 2, chi: 'Luca', testo: 'Luca.' }, { inizio: 2, fine: 3, chi: 'Persona 2', testo: 'Ciao.' }];
  const ia = { disponibile: true, trascriviParlato: async () => frasi, titoloBreve: async () => '' };
  const chiesti = [];
  const nota = async (id, voci) => {
    const note = creaNote({ db, ia, posta: { configured: false }, cartellaFile: path.join(dir, 'file'), cartellaAudio: path.join(dir, 'audio'), cartellaPulito: path.join(dir, 'pulito'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', indirizzoPubblico: () => '', pulitore: async () => {}, somiglianzaVoce: voci });
    fs.writeFileSync(path.join(dir, 'file', id), audio);
    db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, modificato_il) VALUES (?, ?, ?, 1, 1, 1)').run(id, `${id}.ogg`, 'audio/ogg');
    note.accoda(id, 'idea');
    for (let i = 0; i < 300 && note.nota(id).stato !== 'pronta'; i++) await new Promise((r) => setTimeout(r, 50));
    return note.nota(id).segmenti.map((s) => s.chi);
  };
  const voce = (lista) => { let i = 0; return async (f) => { chiesti.push(f); return lista[i++]; }; };
  // Gemini aveva sbagliato: Io è la seconda persona. Il nome si sposta, e il primo prende una Persona libera.
  assert.deepEqual(await nota('a'.repeat(32), voce([0.1, 0.6, 0.2])), ['Persona 3', 'Io', 'Persona 2']);
  // Nessuno somiglia abbastanza: nessuno diventa Io.
  assert.deepEqual(await nota('b'.repeat(32), voce([0.2, 0.1, 0.2])), ['Persona 3', 'Luca', 'Persona 2']);
  // Il servizio della voce è spento: il testo resta, coi nomi di Gemini.
  assert.deepEqual(await nota('c'.repeat(32), async () => { throw new Error('spento'); }), ['Io', 'Luca', 'Persona 2']);
  assert.ok(chiesti.every((f) => f.endsWith('.wav')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'audio')).filter((n) => n.startsWith('voce-')), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una pulizia lunga non fa aspettare testo e riassunto della nota dopo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-coda-'));
  for (const d of ['file', 'audio', 'pulito']) fs.mkdirSync(path.join(dir, d));
  const db = apriDb(dir);
  const ia = { disponibile: true, trascriviParlato: async () => [{ inizio: 0, fine: 1, chi: 'Io', testo: 'ciao' }], titoloBreve: async () => '' };
  let apri;
  const porta = new Promise((r) => { apri = r; });
  const pulite = [];
  const note = creaNote({ db, ia, posta: { configured: false }, cartellaFile: path.join(dir, 'file'), cartellaAudio: path.join(dir, 'audio'), cartellaPulito: path.join(dir, 'pulito'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', indirizzoPubblico: () => '', pulitore: async (id) => { pulite.push(id); await porta; } });
  const nuova = (id) => { fs.writeFileSync(path.join(dir, 'file', id), audio); db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, modificato_il) VALUES (?, ?, ?, 1, 1, 1)').run(id, `${id}.ogg`, 'audio/ogg'); note.accoda(id, 'idea'); };
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  nuova(a);
  for (let i = 0; i < 300 && !pulite.length; i++) await new Promise((r) => setTimeout(r, 50));
  nuova(b);
  for (let i = 0; i < 300 && note.nota(b).stato !== 'pronta'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(note.nota(a).stato, 'pronta');
  assert.equal(note.nota(b).stato, 'pronta', 'la seconda nota è pronta mentre la prima si sta ancora pulendo');
  assert.deepEqual(pulite, [a], 'le pulizie restano una alla volta');
  apri();
  for (let i = 0; i < 100 && pulite.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pulite, [a, b]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la grafia dei nomi si corregge senza toccare le parole comuni', () => {
  assert.equal(nomiGiusti('collegare digishare e DigiNotes, Digi Rec e di-gi-shot al nas con l\'Apk'), 'collegare DiGiShare e DiGiNotes, DiGiRec e DiGiShot al NAS con l\'APK');
  assert.equal(nomiGiusti('la posta di zoom, il naso'), 'la posta di zoom, il naso');
});

test('il numerino: la nota pronta conta finché non si apre, il video caricato a mano no', async () => {
  let { novita } = await fileApp();
  assert.equal(novita.note, 2);
  assert.equal(novita.video, 0);
  await carica('lezione.mp4', 'video/mp4', crypto.randomBytes(2000));
  ({ novita } = await fileApp());
  assert.equal(novita.video, 0);
  const r = await chiama(`/api/file/${appuntamento}/visto`, { method: 'POST', body: '{}' });
  assert.equal(r.dati.novita.note, 1);
});

test('le categorie dei video e delle note sono separate', async () => {
  const a = await chiama('/api/categorie', { method: 'POST', body: JSON.stringify({ nome: 'Clienti', sezione: 'note' }) });
  assert.equal(a.status, 200);
  const { dati } = await chiama('/api/categorie');
  assert.equal(dati.categorie.find((c) => c.nome === 'Clienti').sezione, 'note');
  assert.equal(dati.categorie.find((c) => c.nome === 'Tutorial').sezione, 'video');
  // Un audio che arriva con una categoria dei video non ci finisce dentro.
  const tutorial = dati.categorie.find((c) => c.nome === 'Tutorial').id;
  const id = await carica('DiGiNotes-3.ogg', 'audio/ogg', audio, { categoria: String(tutorial) });
  assert.equal((await aspetta(id)).file.categoriaId, null);
});

test('correzioni: una frase, chi parla, trova e sostituisci; errori chiari', async () => {
  let r = await chiama(`/api/note/${appuntamento}`, { method: 'PATCH', body: JSON.stringify({ frase: { i: 0, testo: 'Frase corretta' } }) });
  assert.equal(r.dati.segmenti[0].testo, 'Frase corretta');
  r = await chiama(`/api/note/${appuntamento}`, { method: 'PATCH', body: JSON.stringify({ rinomina: { da: 'Persona 1', a: 'Io' } }) });
  assert.equal(r.dati.segmenti[0].chi, 'Io');
  r = await chiama(`/api/note/${appuntamento}`, { method: 'PATCH', body: JSON.stringify({ sostituisci: { da: 'FRASE', a: 'Riga' } }) });
  assert.equal(r.dati.segmenti[0].testo, 'Riga corretta');
  assert.equal(r.dati.cambiate, 1);
  r = await chiama(`/api/note/${appuntamento}`, { method: 'PATCH', body: JSON.stringify({ frase: { i: 99, testo: 'x' } }) });
  assert.equal(r.status, 400);
  r = await chiama(`/api/note/${appuntamento}`, { method: 'PATCH', body: JSON.stringify({ sostituisci: { da: '.*(', a: 'x' } }) });
  assert.equal(r.status, 200);
});

test('esporta in Markdown, testo, sottotitoli e Word', async () => {
  const leggi = async (f) => { const r = await fetch(`${BASE}/api/note/${appuntamento}/esporta/${f}`, { headers: { Cookie: cookie } }); assert.equal(r.status, 200); return Buffer.from(await r.arrayBuffer()); };
  assert.match((await leggi('md')).toString(), /^# Rinnovo polizza\n/);
  assert.match((await leggi('md')).toString(), /## Cose da fare/);
  assert.match((await leggi('txt')).toString(), /COSE DA FARE/);
  assert.match((await leggi('srt')).toString(), /00:00:00,000 --> 00:00:04,000/);
  const docx = await leggi('docx');
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  assert.ok(docx.includes('word/document.xml'));
  assert.equal((await fetch(`${BASE}/api/note/${appuntamento}/esporta/exe`, { headers: { Cookie: cookie } })).status, 404);
});

test('Chiedi risponde con la fonte; senza note pertinenti lo dice', async () => {
  let r = await chiama('/api/chiedi', { method: 'POST', body: JSON.stringify({ domanda: 'Che franchigia ho concordato?' }) });
  assert.equal(r.dati.risposta, 'CHF 300.');
  assert.ok(r.dati.fonti[0].id && r.dati.fonti[0].titolo);
  r = await chiama('/api/chiedi', { method: 'POST', body: JSON.stringify({ domanda: 'cavalli selvaggi' }) });
  assert.match(r.dati.risposta, /Non ho trovato/);
  assert.deepEqual(r.dati.fonti, []);
  r = await chiama('/api/chiedi', { method: 'POST', body: JSON.stringify({ domanda: '' }) });
  assert.equal(r.status, 400);
});

test('l\'audio si ascolta a pezzi; senza accesso niente note', async () => {
  const r = await fetch(`${BASE}/api/file/${appuntamento}/audio`, { headers: { Cookie: cookie, Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal((await fetch(`${BASE}/api/note/${appuntamento}`)).status, 401);
  assert.equal((await fetch(`${BASE}/nota/${appuntamento}`, { redirect: 'manual' })).status, 302);
});

test('il link di una nota mostra audio, riassunto e testo a chi lo riceve', async () => {
  const { dati } = await chiama(`/api/file/${appuntamento}/link`, { method: 'POST', body: JSON.stringify({ chi: 'chiunque', scadenza: 7 }) });
  const codice = dati.link[0].codice;
  const d = await (await fetch(`${BASE}/v/${codice}/dati?visita=abc`)).json();
  assert.equal(d.file.audio, true);
  assert.equal(d.file.nota.riassunto[0].titolo, 'Punti discussi');
  assert.equal((await fetch(`${BASE}/v/${codice}/f/${appuntamento}/audio`)).status, 200);
});

test('cestino ed eliminazione tolgono anche la nota', async () => {
  const id = await carica('DiGiNotes-4.ogg', 'audio/ogg', audio);
  await aspetta(id);
  assert.equal((await chiama(`/api/file/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await chiama(`/api/file/${id}/definitivo`, { method: 'DELETE' })).status, 200);
  assert.equal((await chiama(`/api/note/${id}`)).status, 404);
});

// ---- riassunto a voci ----
const voce = (tipo, argomento, testo, secondi = 1) => ({ tipo, argomento, testo, secondi });

test('le sezioni le compone il codice dal tipo: ogni voce in un posto solo', () => {
  const s = sezioniDaVoci([voce('fatto', 'Polizza', 'Il cliente trova caro il rinnovo'), voce('decisione', 'Polizza', 'Franchigia a 1000'), voce('dato', 'Polizza', 'Premio finale: 1090'), voce('dato', 'KDP', 'ACOS: 38%'), voce('azione', 'Polizza', 'Inviare il contratto'), voce('fatta', 'KDP', 'Riscritta la descrizione'), voce('prossimo', 'Polizza', 'Firma il 18 novembre')], 'Due argomenti.');
  assert.deepEqual(s.map((x) => x.titolo), ['In breve', 'Polizza: Cosa è emerso', 'Polizza: Decisioni', 'Polizza: Dati e cifre', 'KDP: Dati e cifre', 'Cose da fare', 'Cose fatte', 'Prossimo passo']);
  assert.equal(s[0].righe[1].testo, 'Polizza: aperto, restano 2 cose.');
  assert.equal(s[0].righe.length, 2);
});

test('cifre e date mancanti: il controllo le trova, comprese quelle coi separatori', () => {
  const seg = [{ testo: "Il premio è 1'240 franchi, scade il 15 dicembre, ACOS al 38%, ne parliamo la prossima settimana." }];
  const rif = riferimentiDi(seg);
  assert.deepEqual(riferimentiMancanti(rif, [voce('dato', 'A', 'Premio: 1240 franchi'), voce('dato', 'A', 'ACOS: 38%')]).sort(), ['15', 'dicembre', 'prossima settimana'].sort());
  assert.deepEqual(riferimentiMancanti(['5'], [voce('dato', 'A', 'Costo: 15')]), ['5']);
});

test('le voci sulla stessa cosa si uniscono e la più specifica decide la sezione', () => {
  const v = unisciVoci([voce('sospeso', 'A', 'Verifica pagamento fattura agosto entro la prossima settimana'), voce('pendenza', 'A', 'Fattura agosto non pagata: 85 franchi'), voce('azione', 'A', 'Mario deve comprare le scarpe'), voce('azione', 'A', 'Anna deve comprare la palla')]);
  assert.equal(v.filter((x) => x.tipo === 'pendenza').length, 1);
  assert.equal(v.filter((x) => x.tipo === 'sospeso').length, 0);
  assert.match(v.find((x) => x.tipo === 'pendenza').testo, /85 franchi.*prossima settimana/);
  assert.equal(v.filter((x) => x.tipo === 'azione').length, 2);
});

test('una cosa fatta dopo non resta da fare, anche senza il passaggio di controllo', () => {
  const v = unisciVoci([voce('azione', 'A', 'Scattare una foto', 5), voce('fatta', 'A', 'Scattata una foto', 9), voce('azione', 'A', 'Mandare il contratto', 5)]);
  assert.deepEqual(v.filter((x) => x.tipo === 'azione').map((x) => x.testo), ['Mandare il contratto']);
});

test('una data rimasta sola torna nella sua voce', () => {
  const v = unisciVoci([voce('pendenza', 'A', 'Rimborso grafico per file sbagliato: 40 euro'), voce('dato', 'A', 'Mese del file sbagliato: settembre')]);
  assert.equal(v.length, 1);
  assert.match(v[0].testo, /40 euro \(settembre\)/);
});

test('la cifra di una decisione si chiama finale, e aperto o chiuso lo decide il codice', () => {
  const v = cifreFinali([voce('decisione', 'A', "Premio a 1'090 franchi"), voce('dato', 'A', "Premio proposto: 1'090 franchi"), voce('dato', 'A', "Premio iniziale: 1'240 franchi")]);
  assert.equal(v[1].testo, "Premio finale: 1'090 franchi");
  assert.equal(v[2].testo, "Premio iniziale: 1'240 franchi");
  assert.deepEqual(statoDegliArgomenti([voce('fatta', 'A', 'x'), voce('azione', 'B', 'y')]).map((s) => s.aperto), [false, true]);
});

const SEG_PROVA = [{ inizio: 0, chi: 'Io', testo: 'Devo mandare il contratto. Devo fare la foto.' }, { inizio: 9, chi: 'Io', testo: 'Ho fatto la foto adesso.' }];
function iaConRisposte(risposte) {
  const chiamate = [];
  return { chiamate, ia: creaIa({ IA_ATTESA_RIPROVA: '1' }, { completaProva: async (prompt) => { chiamate.push(prompt); const r = risposte(prompt, chiamate.length); if (r instanceof Error) throw r; return JSON.stringify(r); } }) };
}

test('il metodo a voci: quello che risulta fatto esce da Cose da fare, In breve è scritto per ultimo', async () => {
  const { ia, chiamate } = iaConRisposte((p) => {
    if (p.startsWith('Ecco le voci di lavoro')) return { titolo: 'Contratto', tipo: 'Colloquio', in_breve: 'Resta il contratto.' };
    if (p.includes('Controllale sulla trascrizione')) return { fatte: [{ numero: 1, secondi: 9, frase: 'Ho fatto la foto adesso.' }, { numero: 0, secondi: 9, frase: 'frase inventata' }], non_compiti: [], doppioni: [] };
    return { voci: [voce('azione', 'Lavoro', 'Mandare il contratto', 0), voce('azione', 'Lavoro', 'Fare la foto', 0)] };
  });
  const r = await ia.riassumiAppuntamento(SEG_PROVA, 'x', 12);
  assert.equal(r.titolo, 'Contratto');
  assert.deepEqual(r.sezioni.find((s) => s.titolo === 'Cose da fare').righe.map((x) => x.testo), ['Mandare il contratto']);
  assert.equal(r.sezioni[0].titolo, 'In breve');
  assert.ok(chiamate.at(-1).startsWith('Ecco le voci di lavoro'));
});

test('se il primo passaggio fallisce la nota esce col metodo di prima', async () => {
  const { ia } = iaConRisposte((p) => (p.includes('Scomponila in voci') ? new Error('quota finita') : { titolo: 'Di prima', tipo: 'Colloquio', sezioni: [{ titolo: 'Punti discussi', righe: [{ testo: 'Un punto', secondi: 1 }] }] }));
  const r = await ia.riassumiAppuntamento(SEG_PROVA, 'x', 12);
  assert.deepEqual(r.sezioni.map((s) => s.titolo), ['Punti discussi']);
});

test('se fallisce un passaggio dopo il primo restano le voci, anche senza In breve', async () => {
  const { ia } = iaConRisposte((p) => (p.includes('Scomponila in voci') ? { voci: [voce('azione', 'Lavoro', 'Mandare il contratto', 0)] } : new Error('quota finita')));
  const r = await ia.riassumiAppuntamento(SEG_PROVA, 'x', 12);
  assert.deepEqual(r.sezioni.map((s) => s.titolo), ['In breve', 'Cose da fare']);
  assert.equal(r.tipo, '');
});

test('se nessun servizio risponde il riassunto dà errore, che note.js gestisce facendo uscire la nota', async () => {
  const { ia } = iaConRisposte(() => new Error('spento'));
  await assert.rejects(ia.riassumiAppuntamento(SEG_PROVA, 'x', 12));
});
