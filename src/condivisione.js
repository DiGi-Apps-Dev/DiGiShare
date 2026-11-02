// Link di condivisione (decisioni dell'utente del 30.10.2026): chiunque ha il link oppure solo email scelte
// (un link per persona), scadenza 1/7/30 giorni o mai, revoca, scaricamento si'/no, invio per email.
// Niente password sui link. Un link puo' aprire un file o un'intera categoria (cartella condivisa).
import { randomBytes } from 'node:crypto';

const GIORNO = 24 * 3600 * 1000;
const SCADENZE = new Set([0, 1, 7, 30]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const codiceNuovo = () => randomBytes(6).toString('base64url').replace(/[-_]/g, (c) => (c === '-' ? 'a' : 'b'));
const errore = (testo, status = 400) => Object.assign(new Error(testo), { status });

function dispositivoDa(agent = '') {
  const so = /Android/i.test(agent) ? 'Android' : /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'Mac' : 'Dispositivo';
  const browser = /SamsungBrowser/i.test(agent) ? 'Samsung Internet' : /Edg\//i.test(agent) ? 'Edge' : /Chrome\//i.test(agent) ? 'Chrome' : /Firefox\//i.test(agent) ? 'Firefox' : /Safari\//i.test(agent) ? 'Safari' : '';
  return browser ? `${so} · ${browser}` : so;
}

export function creaCondivisione({ db, posta, indirizzoPubblico, registra = () => {} }) {
  const COLONNE = 'id, codice, file_id AS fileId, categoria_id AS categoriaId, destinatario, scade_il AS scadeIl, scarica, revocato_il AS revocatoIl, creato_il AS creatoIl, aperture, ultima_apertura AS ultimaApertura';
  const adesso = () => Date.now();
  const urlDi = (codice) => `${indirizzoPubblico()}/v/${codice}`;
  const stato = (l) => (l.revocatoIl ? 'revocato' : l.scadeIl && l.scadeIl < adesso() ? 'scaduto' : 'attivo');

  function arricchisci(l) {
    const v = db.prepare('SELECT COUNT(*) AS visite, COALESCE(MAX(secondi_visti), 0) AS massimo, COALESCE(AVG(secondi_visti), 0) AS media FROM visite WHERE link_id = ?').get(l.id);
    return { ...l, scarica: Boolean(l.scarica), stato: stato(l), url: urlDi(l.codice), visite: v.visite, secondiMassimi: v.massimo, secondiMedi: v.media };
  }
  const perFile = (fileId) => db.prepare(`SELECT ${COLONNE} FROM link WHERE file_id = ? ORDER BY creato_il DESC`).all(fileId).map(arricchisci);
  const perCategoria = (id) => db.prepare(`SELECT ${COLONNE} FROM link WHERE categoria_id = ? ORDER BY creato_il DESC`).all(id).map(arricchisci);
  const trovaLink = (id) => { const l = db.prepare(`SELECT ${COLONNE} FROM link WHERE id = ?`).get(id); return l ? arricchisci(l) : null; };
  const trovaCodice = (codice) => { const l = db.prepare(`SELECT ${COLONNE} FROM link WHERE codice = ?`).get(String(codice)); return l ? arricchisci(l) : null; };

  // Etichetta del pannello: "2 link attivi", "Link scaduto", "Nessun link".
  function riepilogoFile() {
    const righe = db.prepare('SELECT file_id AS fileId, SUM(CASE WHEN revocato_il IS NULL AND (scade_il IS NULL OR scade_il >= ?) THEN 1 ELSE 0 END) AS attivi, SUM(CASE WHEN revocato_il IS NULL AND scade_il IS NOT NULL AND scade_il < ? THEN 1 ELSE 0 END) AS scaduti, SUM(aperture) AS aperture FROM link WHERE file_id IS NOT NULL GROUP BY file_id').all(adesso(), adesso());
    return Object.fromEntries(righe.map((r) => [r.fileId, { attivi: r.attivi, scaduti: r.scaduti, aperture: r.aperture }]));
  }

  function testoEmail(l, cosa) {
    const scadenza = l.scadeIl ? `Il link vale fino al ${new Date(l.scadeIl).toLocaleDateString('it-CH', { day: 'numeric', month: 'long', year: 'numeric' })}.` : 'Il link non ha scadenza.';
    return `Ti è stato condiviso ${cosa}:\n\n${l.url}\n\n${scadenza}${l.scarica ? ' Si può anche scaricare.' : ' Si guarda nel browser.'}\n\nQuesto link è solo per te: non inoltrarlo.`;
  }

  async function invia(l, titolo) {
    if (!l.destinatario) throw errore('Questo link non ha un destinatario.');
    if (!posta.configured) throw errore('Email non configurata: copia il link e mandalo tu.');
    await posta.sendTo(l.destinatario, `DiGiShare: ${titolo}`, testoEmail(l, `«${titolo}»`));
    registra('link_inviato', '', `${titolo} → ${l.destinatario}`);
  }

  // Crea un link (chiunque) o uno per ogni email (solo persone scelte).
  async function crea({ fileId = null, categoriaId = null, chi, email = [], scadenza, scarica, inviaEmail = false, titolo }, indirizzo) {
    const giorni = Number(scadenza);
    if (!SCADENZE.has(giorni)) throw errore('Scadenza non valida.');
    if (!['chiunque', 'email'].includes(chi)) throw errore('Scegli chi può aprire il link.');
    const destinatari = chi === 'email' ? [...new Set(email.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : [null];
    if (chi === 'email' && !destinatari.length) throw errore('Scrivi almeno un\'email.');
    for (const d of destinatari) if (d && !EMAIL.test(d)) throw errore(`Email non valida: ${d}`);
    const scadeIl = giorni ? adesso() + giorni * GIORNO : null;
    const creati = [];
    const inserisci = db.prepare('INSERT INTO link (codice, file_id, categoria_id, destinatario, scade_il, scarica, creato_il) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of destinatari) {
      let codice;
      for (;;) {
        codice = codiceNuovo();
        if (!db.prepare('SELECT 1 FROM link WHERE codice = ?').get(codice)) break;
      }
      const { lastInsertRowid } = inserisci.run(codice, fileId, categoriaId, d, scadeIl, scarica ? 1 : 0, adesso());
      creati.push(trovaLink(Number(lastInsertRowid)));
    }
    registra('link_creato', indirizzo, `${titolo}: ${chi === 'email' ? destinatari.join(', ') : 'chiunque ha il link'}`);
    const erroriEmail = [];
    if (inviaEmail && chi === 'email') {
      for (const l of creati) {
        try { await invia(l, titolo); } catch (err) { erroriEmail.push(`${l.destinatario}: ${err.message}`); }
      }
    }
    return { link: creati, erroriEmail };
  }

  function revoca(id, indirizzo) {
    const l = trovaLink(id);
    if (!l) return null;
    db.prepare('UPDATE link SET revocato_il = ? WHERE id = ? AND revocato_il IS NULL').run(adesso(), id);
    registra('link_revocato', indirizzo, l.destinatario || 'chiunque ha il link');
    return trovaLink(id);
  }

  function prolunga(id, indirizzo) {
    const l = trovaLink(id);
    if (!l || l.revocatoIl) return null;
    const base = Math.max(l.scadeIl || 0, adesso());
    db.prepare('UPDATE link SET scade_il = ?, promemoria_inviato = 0 WHERE id = ?').run(base + 30 * GIORNO, id);
    registra('link_prolungato', indirizzo, l.destinatario || 'chiunque ha il link');
    return trovaLink(id);
  }

  // Apertura della pagina di visione: conta e tiene traccia della visita (anonima: indirizzo e tipo di dispositivo).
  function apri(codice, { indirizzo = '', agent = '', visita = '' } = {}) {
    const l = trovaCodice(codice);
    if (!l || l.stato !== 'attivo') return { link: l, stato: l ? l.stato : 'inesistente' };
    db.prepare('UPDATE link SET aperture = aperture + 1, ultima_apertura = ? WHERE id = ?').run(adesso(), l.id);
    if (l.fileId) db.prepare('UPDATE file SET ultima_apertura = ? WHERE id = ?').run(adesso(), l.fileId);
    if (visita && /^[A-Za-z0-9_-]{8,64}$/.test(visita)) {
      db.prepare('INSERT OR IGNORE INTO visite (visita, link_id, file_id, quando, indirizzo, dispositivo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(visita, l.id, l.fileId, adesso(), String(indirizzo).slice(0, 80), dispositivoDa(agent));
    }
    return { link: l, stato: 'attivo' };
  }

  function visto(codice, visita, secondi, fileId = null) {
    const l = trovaCodice(codice);
    if (!l || !/^[A-Za-z0-9_-]{8,64}$/.test(String(visita))) return false;
    const s = Math.max(0, Math.min(Number(secondi) || 0, 24 * 3600));
    const r = db.prepare('UPDATE visite SET secondi_visti = MAX(secondi_visti, ?), file_id = COALESCE(?, file_id) WHERE visita = ? AND link_id = ?').run(s, fileId, visita, l.id);
    return r.changes > 0;
  }

  // Promemoria due giorni prima della scadenza (tabella di marcia del 31.10.2026).
  async function promemoriaScadenze(titoloDi) {
    if (!posta.configured) return 0;
    const fra = adesso() + 2 * GIORNO;
    const inScadenza = db.prepare(`SELECT ${COLONNE} FROM link WHERE revocato_il IS NULL AND promemoria_inviato = 0 AND scade_il IS NOT NULL AND scade_il > ? AND scade_il <= ?`).all(adesso(), fra);
    if (!inScadenza.length) return 0;
    const righe = inScadenza.map((l) => `• ${titoloDi(l)} — ${l.destinatario || 'chiunque ha il link'} — scade il ${new Date(l.scadeIl).toLocaleString('it-CH', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} — aperto ${l.aperture} volte`);
    await posta.send(`DiGiShare: ${inScadenza.length === 1 ? 'un link scade' : `${inScadenza.length} link scadono`} fra due giorni`,
      `${righe.join('\n')}\n\nPer prolungare di 30 giorni: apri DiGiShare, «Condividi» sul video, «Prolunga» accanto al link.\n${indirizzoPubblico()}/`);
    db.prepare(`UPDATE link SET promemoria_inviato = 1 WHERE id IN (${inScadenza.map(() => '?').join(',')})`).run(...inScadenza.map((l) => l.id));
    registra('promemoria_scadenze', '', `${inScadenza.length} link`);
    return inScadenza.length;
  }

  // Archiviazione: file mai aperti da nessuno e caricati da oltre sei mesi, segnalati una volta sola.
  async function proponiArchiviazione(peso) {
    if (!posta.configured) return 0;
    const limite = adesso() - 180 * GIORNO;
    const vecchi = db.prepare('SELECT id, titolo, dimensione FROM file WHERE cestinato_il IS NULL AND archivio_segnalato = 0 AND caricato_il < ? AND (ultima_apertura IS NULL OR ultima_apertura < ?) AND NOT EXISTS (SELECT 1 FROM link WHERE link.file_id = file.id AND aperture > 0 AND (ultima_apertura IS NULL OR ultima_apertura >= ?))').all(limite, limite, limite);
    if (!vecchi.length) return 0;
    const totale = vecchi.reduce((t, f) => t + f.dimensione, 0);
    await posta.send(`DiGiShare: ${vecchi.length} file da oltre sei mesi senza aperture`,
      `Questi file occupano ${peso(totale)} sul server e nessuno li ha aperti negli ultimi sei mesi:\n\n${vecchi.map((f) => `• ${f.titolo} (${peso(f.dimensione)})`).join('\n')}\n\nSe non servono più, mettili nel cestino da DiGiShare: si cancellano da soli dopo 30 giorni.\n${indirizzoPubblico()}/`);
    db.prepare(`UPDATE file SET archivio_segnalato = 1 WHERE id IN (${vecchi.map(() => '?').join(',')})`).run(...vecchi.map((f) => f.id));
    registra('archiviazione_proposta', '', `${vecchi.length} file`);
    return vecchi.length;
  }

  return { perFile, perCategoria, trovaLink, trovaCodice, riepilogoFile, crea, invia, revoca, prolunga, apri, visto, promemoriaScadenze, proponiArchiviazione };
}
