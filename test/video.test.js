// Copia per la visione solo quando serve: niente doppione fino a 1080p, copia leggera sopra, originale mai toccato.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { creaVideo } from '../src/video.js';

const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'digishare-video-'));
const cartellaFile = path.join(cartella, 'file');
const cartellaVisione = path.join(cartella, 'visione');
fs.mkdirSync(cartellaFile);
fs.mkdirSync(cartellaVisione);
const db = new Database(':memory:');
db.exec("CREATE TABLE file (id TEXT PRIMARY KEY, tipo TEXT, caricato_il INTEGER DEFAULT 0, cestinato_il INTEGER, visione INTEGER DEFAULT 0, larghezza INTEGER, altezza INTEGER)");

function crea(id, larghezza, altezza, { codec = 'libx264', tipo = 'video/mp4' } = {}) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${larghezza}x${altezza}:rate=5:duration=1`, '-c:v', codec, '-pix_fmt', 'yuv420p', '-f', 'mp4', path.join(cartellaFile, id)]);
  db.prepare('INSERT INTO file (id, tipo) VALUES (?, ?)').run(id, tipo);
  return fs.readFileSync(path.join(cartellaFile, id));
}
const eventi = [];
const video = creaVideo({ db, cartellaFile, cartellaVisione, cartellaAudio: cartella, registra: (...a) => eventi.push(a) });
async function aspettaFine() {
  for (let i = 0; i < 600 && video.inCorso(); i++) await new Promise((r) => setTimeout(r, 100));
}
const copia = (id) => fs.existsSync(path.join(cartellaVisione, `${id}.mp4`));
const riga = (id) => db.prepare('SELECT visione, larghezza, altezza FROM file WHERE id = ?').get(id);

test('fino a 1080p niente copia e originale intatto, anche esattamente a 1080p', async () => {
  for (const [id, l, a] of [['a720', 1280, 720], ['a1080', 1920, 1080]]) {
    const prima = crea(id, l, a);
    video.accoda(id);
    await aspettaFine();
    assert.equal(copia(id), false, id);
    assert.deepEqual(riga(id), { visione: 1, larghezza: l, altezza: a });
    assert.ok(prima.equals(fs.readFileSync(path.join(cartellaFile, id))), 'originale identico');
  }
});

test('sopra 1080p resta la copia leggera, e anche per i formati che il browser non legge', async () => {
  crea('a4k', 2560, 1440);
  video.accoda('a4k');
  crea('mpeg', 640, 360, { codec: 'mpeg4' });
  video.accoda('mpeg');
  crea('mov', 640, 360, { tipo: 'video/quicktime' });
  video.accoda('mov');
  await aspettaFine();
  for (const id of ['a4k', 'mpeg', 'mov']) {
    assert.equal(copia(id), true, id);
    assert.equal(riga(id).visione, 1, id);
  }
});

test('all avvio toglie solo i doppioni: copia del 720p via, quella del 4K resta, originali intatti', async () => {
  fs.writeFileSync(path.join(cartellaVisione, 'a720.mp4'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(cartellaVisione, 'orfano.mp4'), Buffer.alloc(10));
  db.prepare("INSERT INTO file (id, tipo) VALUES ('senza', 'video/mp4')").run();
  fs.writeFileSync(path.join(cartellaVisione, 'senza.mp4'), Buffer.alloc(10));
  const originale = fs.readFileSync(path.join(cartellaFile, 'a720'));
  const { tolte, byte } = await video.togliCopieInutili();
  assert.equal(tolte, 1);
  assert.equal(byte, 1000);
  assert.equal(copia('a720'), false);
  assert.equal(copia('a4k'), true, 'copia del video grande');
  assert.equal(copia('mov'), true, 'copia del formato non leggibile');
  assert.equal(copia('senza'), true, 'senza originale la copia resta');
  assert.ok(originale.equals(fs.readFileSync(path.join(cartellaFile, 'a720'))));
  assert.equal((await video.togliCopieInutili()).tolte, 0, 'la seconda volta non toglie niente');
  assert.equal(eventi.filter(([tipo]) => tipo === 'copie_tolte').length, 1);
});

test.after(() => { db.close(); fs.rmSync(cartella, { recursive: true, force: true }); });
