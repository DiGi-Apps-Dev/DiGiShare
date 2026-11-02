import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { oraRegistrazione } from './db.js';

export const PERCORSO = '/api/caricamenti';
const TIPO_VALIDO = /^[\w.+-]+\/[\w.+-]+$/;
const GIORNI_NEL_CESTINO = 30;

function pulisciNome(nome) {
  const base = String(nome ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 255);
}
const pulisciTesto = (t, max = 200) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const titoloDaNome = (nome) => nome.replace(/\.[a-z0-9]{1,5}$/i, '') || nome;
const parole = (t) => pulisciTesto(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

// I file stanno nella stessa cartella di tus, con accanto il loro .json: se la risposta finale va
// persa e il browser richiede lo stato, trova il caricamento completo e non lo ricomincia da zero.
export function creaCaricamenti({ db, cartellaFile, cartellaMiniature, dimensioneMassima, margineDisco, dopoRegistrazione, dopoAudio, registra: registraEvento = () => {}, altriFileDi = () => [] }) {
  const store = new FileStore({ directory: cartellaFile });

  async function spazioDisco() {
    const s = await fs.statfs(cartellaFile);
    return { libero: s.bavail * s.bsize, totale: s.blocks * s.bsize };
  }

  async function registra(id, dimensione, metadati, data) {
    const handle = await fs.open(path.join(cartellaFile, id), 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const tipo = TIPO_VALIDO.test(metadati?.filetype ?? '') ? metadati.filetype : 'application/octet-stream';
    const nome = pulisciNome(metadati?.filename) || 'senza nome';
    // Il titolo scritto dall'utente in DiGiNotes prima di inviare; senza, parte dal nome e poi lo decide l'IA.
    const titolo = pulisciNome(metadati?.titolo) || titoloDaNome(nome);
    // Un video caricato a mano non è una novità per chi l'ha caricato; una nota lo è quando è pronta.
    const audio = tipo.startsWith('audio/');
    const esito = db.prepare('INSERT OR IGNORE INTO file (id, nome, tipo, dimensione, caricato_il, titolo, categoria_id, modificato_il, visto_il) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, nome, tipo, dimensione, (audio && oraRegistrazione(nome)) || data, titolo, proponiCategoria(titolo, Number(metadati?.categoria) || null, audio ? 'note' : 'video'), data, audio ? null : data);
    if (esito.changes) registraEvento('file_caricato', '', nome);
    if (tipo.startsWith('video/')) dopoRegistrazione?.(id);
    if (audio) dopoAudio?.(id, metadati);
  }

  // Un file gia' nella cartella, arrivato da fuori (Zoom). `dentro` scrive nella stessa transazione:
  // se si spegne qui in mezzo, il file non risulta ne' in elenco ne' importato.
  function registraEsterno({ id, nome, tipo, dimensione, titolo, categoriaId }, dentro = () => {}) {
    const data = Date.now();
    const pulito = pulisciNome(nome) || 'senza nome';
    db.transaction(() => {
      db.prepare('INSERT INTO file (id, nome, tipo, dimensione, caricato_il, titolo, categoria_id, modificato_il) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, pulito, tipo, dimensione, data, pulisciTesto(titolo) || titoloDaNome(pulito), categoriaId, data);
      dentro();
    })();
    registraEvento('file_importato', '', pulito);
    if (tipo.startsWith('video/')) dopoRegistrazione?.(id);
  }

  const tus = new Server({
    path: PERCORSO,
    datastore: store,
    relativeLocation: true,
    maxSize: dimensioneMassima,
    allowedOrigins: [],
    disableTerminationForFinishedUploads: true,
    async onUploadCreate(req, upload) {
      if (upload.sizeIsDeferred || !upload.size) throw { status_code: 400, body: 'Il file è vuoto.\n' };
      if (!pulisciNome(upload.metadata?.filename)) throw { status_code: 400, body: 'Manca il nome del file.\n' };
      const { libero } = await spazioDisco();
      if (upload.size + margineDisco > libero) throw { status_code: 507, body: 'Sul server non c\'è abbastanza spazio per questo file.\n' };
      return { metadata: upload.metadata };
    },
    async onUploadFinish(req, upload) {
      await registra(upload.id, upload.size, upload.metadata, Date.now());
      return {};
    },
  });

  async function schede() {
    const nomi = await fs.readdir(cartellaFile);
    const elenco = [];
    for (const nome of nomi) {
      if (!nome.endsWith('.json')) continue;
      const id = nome.slice(0, -5);
      try {
        const info = JSON.parse(await fs.readFile(path.join(cartellaFile, nome), 'utf8'));
        const { size: ricevuti } = await fs.stat(path.join(cartellaFile, id));
        elenco.push({ id, info, ricevuti });
      } catch (err) {
        if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      }
    }
    return elenco;
  }

  // Dopo uno spegnimento di colpo: un file arrivato tutto ma non ancora in elenco viene registrato.
  async function recupera() {
    let recuperati = 0;
    for (const { id, info, ricevuti } of await schede()) {
      if (ricevuti !== info.size) continue;
      if (db.prepare('SELECT 1 FROM file WHERE id = ?').get(id)) continue;
      await registra(id, info.size, info.metadata, Date.parse(info.creation_date) || Date.now());
      recuperati++;
    }
    return recuperati;
  }

  // Non si usa deleteExpired di FileStore: confronta la dimensione con un valore che resta a 0 e
  // cancellerebbe anche i file completi.
  async function pulisciInterrotti(eta) {
    const limite = Date.now() - eta;
    let tolti = 0;
    for (const { id, info, ricevuti } of await schede()) {
      if (ricevuti >= info.size) continue;
      if (Date.parse(info.creation_date) > limite) continue;
      await store.remove(id);
      tolti++;
    }
    return tolti;
  }

  async function inSospeso() {
    const elenco = [];
    for (const { id, info, ricevuti } of await schede()) {
      if (ricevuti >= info.size) continue;
      elenco.push({
        id,
        url: `${PERCORSO}/${id}`,
        nome: pulisciNome(info.metadata?.filename),
        dimensione: info.size,
        ricevuti,
        ultimaModifica: Number(info.metadata?.ultimamodifica) || 0,
        iniziato: Date.parse(info.creation_date) || 0,
      });
    }
    return elenco.sort((a, b) => b.iniziato - a.iniziato);
  }

  // ---- categorie: proposta automatica, poi decide l'utente ----
  // Ordine delle categorie: a mano (frecce), alfabetico o per ultima modifica dei file dentro.
  const MODI_ORDINE = ['manuale', 'alfabetico', 'recenti'];
  const modoOrdine = () => { const m = db.prepare('SELECT valore FROM impostazioni WHERE chiave = ?').get('ordine_categorie')?.valore; try { return MODI_ORDINE.includes(JSON.parse(m)) ? JSON.parse(m) : 'manuale'; } catch { return 'manuale'; } };
  function elencoCategorie() {
    const righe = db.prepare('SELECT c.id, c.nome, c.ordine, c.sezione, (SELECT COUNT(*) FROM file f WHERE f.categoria_id = c.id AND f.cestinato_il IS NULL) AS quanti, (SELECT MAX(COALESCE(f.modificato_il, f.caricato_il)) FROM file f WHERE f.categoria_id = c.id AND f.cestinato_il IS NULL) AS ultimaModifica FROM categorie c').all();
    const modo = modoOrdine();
    const confronta = modo === 'alfabetico' ? (a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' })
      : modo === 'recenti' ? (a, b) => (b.ultimaModifica ?? 0) - (a.ultimaModifica ?? 0) || a.ordine - b.ordine
        : (a, b) => a.ordine - b.ordine || a.nome.localeCompare(b.nome, 'it');
    return righe.sort(confronta).map((c) => ({ ...c, modo }));
  }
  function impostaOrdine(modo, ids, indirizzo) {
    if (!MODI_ORDINE.includes(modo)) throw errore('Ordine non valido.', 400);
    db.transaction(() => {
      db.prepare('INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore').run('ordine_categorie', JSON.stringify(modo));
      if (Array.isArray(ids)) ids.forEach((id, i) => db.prepare('UPDATE categorie SET ordine = ? WHERE id = ?').run(i + 1, Number(id)));
    })();
    registraEvento('categorie_riordinate', indirizzo, modo);
  }
  function spostaCategoria(id, verso, indirizzo) {
    const elenco = db.prepare('SELECT id FROM categorie ORDER BY ordine, nome').all().map((c) => c.id);
    const i = elenco.indexOf(Number(id));
    if (i < 0) return false;
    const j = verso === 'su' ? i - 1 : i + 1;
    if (j < 0 || j >= elenco.length) return true;
    [elenco[i], elenco[j]] = [elenco[j], elenco[i]];
    impostaOrdine('manuale', elenco, indirizzo);
    return true;
  }
  const categoriaEsiste = (id, sezione) => id != null && Boolean(db.prepare(`SELECT 1 FROM categorie WHERE id = ?${sezione ? ' AND sezione = ?' : ''}`).get(...(sezione ? [id, sezione] : [id])));
  // 1) la categoria aperta quando si carica; 2) una categoria il cui nome compare nel titolo;
  // 3) la categoria dell'ultimo file con la stessa prima parola; 4) nessuna.
  // Le categorie dei video e quelle delle note sono separate: una nota non finisce in «Tutorial».
  function proponiCategoria(titolo, scelta, sezione = 'video') {
    if (categoriaEsiste(scelta, sezione)) return scelta;
    const p = parole(titolo);
    for (const c of elencoCategorie()) if (c.sezione === sezione && p.includes(c.nome.toLowerCase())) return c.id;
    if (p.length) {
      const simile = db.prepare("SELECT f.categoria_id FROM file f JOIN categorie c ON c.id = f.categoria_id WHERE c.sezione = ? AND f.cestinato_il IS NULL AND lower(f.titolo) LIKE ? ORDER BY f.caricato_il DESC LIMIT 1").get(sezione, `${p[0]}%`);
      if (simile) return simile.categoria_id;
    }
    return null;
  }
  const errore = (testo, status) => Object.assign(new Error(testo), { status });
  function creaCategoria(nome, indirizzo, sezione = 'video') {
    const n = pulisciTesto(nome, 60);
    if (!n) throw errore('Scrivi il nome della categoria.', 400);
    if (db.prepare('SELECT 1 FROM categorie WHERE nome = ?').get(n)) throw errore('Esiste già una categoria con questo nome.', 409);
    const { ordine } = db.prepare('SELECT COALESCE(MAX(ordine), 0) + 1 AS ordine FROM categorie').get();
    const { lastInsertRowid } = db.prepare('INSERT INTO categorie (nome, ordine, sezione) VALUES (?, ?, ?)').run(n, ordine, sezione === 'note' ? 'note' : 'video');
    registraEvento('categoria_creata', indirizzo, n);
    return Number(lastInsertRowid);
  }
  function rinominaCategoria(id, nome, indirizzo) {
    const n = pulisciTesto(nome, 60);
    if (!n) throw errore('Scrivi il nome della categoria.', 400);
    if (db.prepare('SELECT id FROM categorie WHERE nome = ? AND id <> ?').get(n, id)) throw errore('Esiste già una categoria con questo nome.', 409);
    const r = db.prepare('UPDATE categorie SET nome = ? WHERE id = ?').run(n, id);
    if (r.changes) registraEvento('categoria_rinominata', indirizzo, n);
    return r.changes > 0;
  }
  function eliminaCategoria(id, indirizzo) {
    const c = db.prepare('SELECT nome FROM categorie WHERE id = ?').get(id);
    if (!c) return false;
    db.transaction(() => {
      db.prepare('UPDATE file SET categoria_id = NULL WHERE categoria_id = ?').run(id);
      db.prepare('DELETE FROM categorie WHERE id = ?').run(id);
    })();
    registraEvento('categoria_eliminata', indirizzo, c.nome);
    return true;
  }
  function modificaFile(id, { titolo, categoriaId, descrizione, titoliCapitoli }, indirizzo) {
    const f = trova(id);
    if (!f) return null;
    const t = titolo === undefined ? f.titolo : pulisciTesto(titolo);
    if (!t) throw errore('Il titolo non può essere vuoto.', 400);
    const c = categoriaId === undefined ? f.categoriaId : (categoriaId === null ? null : Number(categoriaId));
    if (c !== null && !categoriaEsiste(c)) throw errore('Categoria non trovata.', 400);
    const d = descrizione === undefined ? f.descrizione : String(descrizione ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);
    // Dei capitoli si cambiano solo i titoli: i minuti restano quelli trovati dall'IA.
    let capitoli = f.capitoli;
    if (titoliCapitoli !== undefined) {
      const attuali = conCapitoli(f).capitoli;
      if (!Array.isArray(titoliCapitoli) || titoliCapitoli.length !== attuali.length) throw errore('I capitoli non corrispondono: ricarica la pagina.', 400);
      const nuovi = titoliCapitoli.map((x) => pulisciTesto(x, 120));
      if (nuovi.some((x) => !x)) throw errore('Il titolo del capitolo non può essere vuoto.', 400);
      capitoli = JSON.stringify(attuali.map((x, i) => ({ ...x, titolo: nuovi[i] })));
    }
    db.prepare('UPDATE file SET titolo = ?, categoria_id = ?, descrizione = ?, capitoli = ?, modificato_il = ? WHERE id = ?').run(t, c, d, capitoli, Date.now(), id);
    registraEvento('file_modificato', indirizzo, t);
    return conCapitoli(trova(id));
  }

  const COLONNE = "id, nome, tipo, dimensione, caricato_il AS caricatoIl, durata, miniatura, cestinato_il AS cestinatoIl, COALESCE(titolo, nome) AS titolo, categoria_id AS categoriaId, COALESCE(descrizione, '') AS descrizione, visione, sottotitoli, capitoli, ia, larghezza, altezza, ultima_apertura AS ultimaApertura, visto_il AS vistoIl";
  function elencoFile() {
    return db.prepare(`SELECT ${COLONNE} FROM file WHERE cestinato_il IS NULL ORDER BY caricato_il DESC`).all().map(conCapitoli);
  }
  function elencoCestino() {
    return db.prepare(`SELECT ${COLONNE} FROM file WHERE cestinato_il IS NOT NULL ORDER BY cestinato_il DESC`).all().map(conCapitoli);
  }
  const elencoCategoria = (categoriaId) => db.prepare(`SELECT ${COLONNE} FROM file WHERE cestinato_il IS NULL AND categoria_id = ? ORDER BY caricato_il DESC`).all(categoriaId).map(conCapitoli);
  function trova(id) {
    return db.prepare(`SELECT ${COLONNE} FROM file WHERE id = ?`).get(id) ?? null;
  }
  function conCapitoli(f) {
    if (!f) return f;
    let capitoli = [];
    try { capitoli = f.capitoli ? JSON.parse(f.capitoli) : []; } catch { capitoli = []; }
    return { ...f, capitoli };
  }

  // ---- cestino (standard app, punto 12): niente sparisce subito ----
  function cestina(id, indirizzo) {
    const f = trova(id);
    if (!f || f.cestinatoIl) return null;
    db.prepare('UPDATE file SET cestinato_il = ? WHERE id = ?').run(Date.now(), id);
    registraEvento('file_cestinato', indirizzo, f.nome);
    return f;
  }
  function ripristina(id, indirizzo) {
    const f = trova(id);
    if (!f || !f.cestinatoIl) return null;
    db.prepare('UPDATE file SET cestinato_il = NULL WHERE id = ?').run(id);
    registraEvento('file_ripristinato', indirizzo, f.nome);
    return f;
  }
  async function eliminaDefinitivamente(id, indirizzo) {
    const f = trova(id);
    if (!f || !f.cestinatoIl) return null;
    for (const p of [path.join(cartellaFile, id), path.join(cartellaFile, `${id}.json`), path.join(cartellaMiniature, `${id}.jpg`), ...altriFileDi(id)]) {
      // Su Windows un file aperto da ffmpeg (copertina in corso) non si cancella subito: si riprova per qualche secondo.
      for (let tentativo = 0; ; tentativo++) {
        try {
          await fs.rm(p, { force: true });
          break;
        } catch (err) {
          if (!['EBUSY', 'EPERM'].includes(err.code) || tentativo >= 20) throw err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    db.prepare('DELETE FROM note WHERE file_id = ?').run(id);
    db.prepare('DELETE FROM file WHERE id = ?').run(id);
    registraEvento('file_eliminato', indirizzo, f.nome);
    return f;
  }
  async function svuotaCestinoVecchio() {
    const limite = Date.now() - GIORNI_NEL_CESTINO * 24 * 3600 * 1000;
    const vecchi = db.prepare('SELECT id FROM file WHERE cestinato_il IS NOT NULL AND cestinato_il < ?').all(limite);
    for (const { id } of vecchi) await eliminaDefinitivamente(id, '');
    return vecchi.length;
  }

  // Il numerino su Video e Note: cosa non è ancora stato aperto. Una nota conta solo quando è pronta.
  function segnaVisto(id) {
    db.prepare('UPDATE file SET visto_il = ? WHERE id = ? AND visto_il IS NULL').run(Date.now(), id);
  }
  function novita() {
    const video = db.prepare("SELECT COUNT(*) AS n FROM file WHERE visto_il IS NULL AND cestinato_il IS NULL AND tipo NOT LIKE 'audio/%'").get().n;
    const note = db.prepare("SELECT COUNT(*) AS n FROM file f JOIN note x ON x.file_id = f.id WHERE f.visto_il IS NULL AND f.cestinato_il IS NULL AND x.stato = 'pronta'").get().n;
    return { video, note };
  }

  async function riepilogo() {
    const { usato } = db.prepare('SELECT COALESCE(SUM(dimensione), 0) AS usato FROM file').get();
    const { nelCestino } = db.prepare('SELECT COUNT(*) AS nelCestino FROM file WHERE cestinato_il IS NOT NULL').get();
    return { usato, nelCestino, giorniNelCestino: GIORNI_NEL_CESTINO, ...(await spazioDisco()) };
  }

  return { tus, registraEsterno, recupera, pulisciInterrotti, inSospeso, elencoFile, elencoCestino, trova, cestina, ripristina, eliminaDefinitivamente, svuotaCestinoVecchio, riepilogo, spazioDisco, elencoCategorie, creaCategoria, rinominaCategoria, eliminaCategoria, impostaOrdine, spostaCategoria, modoOrdine, modificaFile, elencoCategoria, conCapitoli, segnaVisto, novita };
}
