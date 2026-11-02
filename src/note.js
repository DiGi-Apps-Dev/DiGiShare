// Note: gli audio di DiGiNotes. Stessa idea dei video di Zoom: arriva il file, il server lavora da solo una nota alla volta,
// e a lavoro finito parte l'email. Stati: attesa, trascrizione, riassunto, pronta, errore.
// Appuntamento: testo con chi parla e riassunto ordinato. Idea: solo testo e titolo.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { zipSync } from './zip.js';
import { tempoBreve } from './ia.js';

const esegui = promisify(execFile);
const LIMITE_GROQ = 24 * 1024 * 1024;
const BYTE_AL_SECONDO = 3000; // 24 kbit/s
const SOGLIA_VOCE = 0.35; // misurata su registrazioni vere
const SECONDI_VOCE = 60; // per riconoscere una persona bastano i suoi primi 60 secondi
const PEZZO_GEMINI = 600; // secondi: un pezzo corto sta nella richiesta e la risposta non si tronca
const VUOTE = new Set(['della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'sono', 'cosa', 'come', 'quando', 'dove', 'perché', 'quale', 'quali', 'quanto', 'questa', 'questo', 'devo', 'fare', 'detto', 'hanno', 'abbiamo', 'anche', 'allora']);

// Pulizia dell'audio, dopo testo e riassunto perché sul server è lenta: prima si toglie il rumore con DeepFilterNet
// (se DEEPFILTER punta al programma), poi si schiarisce e si alza la voce con ffmpeg. L'originale resta in dati/file;
// chi ascolta riceve la copia pulita in dati/pulito appena è pronta.
const CATENA_VOCE = 'highpass=f=90,lowpass=f=7600,equalizer=f=220:t=q:w=1.2:g=-2,equalizer=f=3000:t=q:w=1.5:g=4,acompressor=threshold=-24dB:ratio=3:attack=8:release=120:makeup=4,speechnorm=e=6:r=0.0001:l=1,alimiter=limit=0.95';

export function creaNote({ db, ia, posta, cartellaFile, cartellaAudio, cartellaPulito, ffmpeg, ffprobe, deepFilter = '', indirizzoPubblico, registra = () => {}, notifica = async () => {}, pulitore = null, somiglianzaVoce = null }) {
  const coda = [];
  let inCorso = false;
  // La pulizia ha una coda sua: sul server può durare ore, e testo, riassunto ed email di una nota nuova non la aspettano.
  const codaPulizia = [];
  let pulendo = false;
  async function giraPulizia() {
    if (pulendo) return;
    pulendo = true;
    try {
      while (codaPulizia.length) await (pulitore ?? pulisci)(codaPulizia.shift());
    } finally {
      pulendo = false;
    }
  }
  function accodaPulizia(id) {
    if (!codaPulizia.includes(id)) codaPulizia.push(id);
    giraPulizia().catch((err) => registra('nota_pulizia_fallita', '', err.message.slice(0, 120)));
  }

  const riga = (id) => db.prepare('SELECT file_id AS fileId, genere, stato, errore, segmenti, riassunto, tipo_incontro AS tipoIncontro, pulita FROM note WHERE file_id = ?').get(id) ?? null;
  const leggi = (r) => (r ? { ...r, segmenti: JSON.parse(r.segmenti || '[]'), riassunto: JSON.parse(r.riassunto || '[]') } : null);
  const nota = (id) => leggi(riga(id));
  const imposta = (id, stato, errore = null) => db.prepare('UPDATE note SET stato = ?, errore = ? WHERE file_id = ?').run(stato, errore, id);

  // Glossario, voci, memoria e lingua dalle Impostazioni di DiGiNotes: valgono per le note che partono da qui in poi.
  const pulisciLista = (v, massimo) => (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim().slice(0, massimo)).filter(Boolean).slice(0, 200);
  function impostaContesto(corpo) {
    const c = { glossario: pulisciLista(corpo?.glossario, 100), voci: pulisciLista(corpo?.voci, 60), memoria: pulisciLista(corpo?.memoria, 1000), lingua: String(corpo?.lingua ?? 'Italiano').trim().slice(0, 40) || 'Italiano' };
    db.prepare('INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore').run('note_contesto', JSON.stringify(c));
    return c;
  }
  function contesto() {
    try { return JSON.parse(db.prepare('SELECT valore FROM impostazioni WHERE chiave = ?').get('note_contesto')?.valore ?? '{}'); } catch { return {}; }
  }

  function accoda(id, genere) {
    db.prepare('INSERT OR IGNORE INTO note (file_id, genere, stato) VALUES (?, ?, ?)').run(id, genere === 'idea' ? 'idea' : 'appuntamento', 'attesa');
    if (!coda.includes(id)) coda.push(id);
    gira();
  }
  function rifai(id) {
    imposta(id, 'attesa');
    if (!coda.includes(id)) coda.push(id);
    gira();
  }
  // Dopo un riavvio del server il lavoro interrotto riparte da capo: l'audio è al sicuro.
  function riprendi() {
    for (const { file_id: id } of db.prepare("SELECT n.file_id FROM note n JOIN file f ON f.id = n.file_id WHERE n.stato IN ('attesa', 'trascrizione', 'riassunto') AND f.cestinato_il IS NULL").all()) {
      imposta(id, 'attesa');
      if (!coda.includes(id)) coda.push(id);
    }
    // Una pulizia interrotta da un riavvio riparte da capo.
    for (const { file_id: id } of db.prepare("SELECT n.file_id FROM note n JOIN file f ON f.id = n.file_id WHERE n.stato = 'pronta' AND n.pulita = 0 AND f.cestinato_il IS NULL").all()) accodaPulizia(id);
    gira();
  }
  async function gira() {
    if (inCorso || !ia.disponibile) return;
    inCorso = true;
    try {
      while (coda.length) {
        const id = coda.shift();
        await lavora(id).catch((err) => {
          console.error(`Nota ${id}: ${err.message}`);
          imposta(id, 'errore', err.message.slice(0, 200));
          registra('nota_fallita', '', err.message.slice(0, 120));
        });
      }
    } finally {
      inCorso = false;
    }
  }

  async function durataDi(file) {
    const { stdout } = await esegui(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  }

  // Oltre il limite di Groq si spezza: circa 2 ore a pezzo, e gli orari si rimettono in fila dopo.
  async function trascriviTutto(audio, id, ctx) {
    if (fs.statSync(audio).size <= LIMITE_GROQ) return ia.trascrivi(audio, ctx);
    const secondi = Math.floor((LIMITE_GROQ * 0.95) / BYTE_AL_SECONDO);
    const modello = path.join(cartellaAudio, `nota-${id}-%03d.ogg`);
    await esegui(ffmpeg, ['-y', '-v', 'error', '-i', audio, '-f', 'segment', '-segment_time', String(secondi), '-c', 'copy', modello], { timeout: 600000 });
    const pezzi = fs.readdirSync(cartellaAudio).filter((n) => n.startsWith(`nota-${id}-`)).sort();
    const tutti = [];
    try {
      for (let i = 0; i < pezzi.length; i++) {
        for (const s of await ia.trascrivi(path.join(cartellaAudio, pezzi[i]), ctx)) tutti.push({ ...s, start: s.start + i * secondi, end: s.end + i * secondi });
      }
    } finally {
      for (const n of pezzi) fs.rmSync(path.join(cartellaAudio, n), { force: true });
    }
    return tutti;
  }

  // Il metodo normale: Gemini scrive chi dice cosa, pezzo per pezzo, e gli orari si rimettono in fila dopo.
  async function trascriviConGemini(audio, id, durata, ctx) {
    if (durata <= PEZZO_GEMINI) return ia.trascriviParlato(audio, ctx, durata);
    const modello = path.join(cartellaAudio, `parlato-${id}-%03d.ogg`);
    await esegui(ffmpeg, ['-y', '-v', 'error', '-i', audio, '-f', 'segment', '-segment_time', String(PEZZO_GEMINI), '-c', 'copy', modello], { timeout: 600000 });
    const pezzi = fs.readdirSync(cartellaAudio).filter((n) => n.startsWith(`parlato-${id}-`)).sort();
    const tutti = [];
    try {
      for (let i = 0; i < pezzi.length; i++) {
        const scarto = i * PEZZO_GEMINI;
        for (const s of await ia.trascriviParlato(path.join(cartellaAudio, pezzi[i]), ctx, Math.min(PEZZO_GEMINI, durata - scarto))) tutti.push({ ...s, inizio: s.inizio + scarto, fine: s.fine + scarto });
      }
    } finally {
      for (const n of pezzi) fs.rmSync(path.join(cartellaAudio, n), { force: true });
    }
    return tutti;
  }

  async function conWhisper(audio, id, ctx, genere) {
    const grezzi = await trascriviTutto(audio, id, ctx);
    let segmenti = grezzi.map((s) => ({ inizio: Number(s.start) || 0, fine: Number(s.end) || 0, chi: 'Voce', testo: String(s.text ?? '').trim() })).filter((s) => s.testo);
    if (segmenti.length && genere === 'appuntamento') {
      try {
        segmenti = await ia.chiParla(audio, segmenti, ctx);
      } catch (err) {
        // Il testo vale anche senza nomi: si segnala e si va avanti.
        registra('nota_chi_parla', '', err.message.slice(0, 120));
      }
    }
    return segmenti;
  }

  // La voce di chi registra (facoltativa): Gemini separa le persone, qui si guarda quale somiglia al campione. Vale per tutta la persona,
  // così anche le sue frasi corte, troppo brevi per riconoscerle da sole, prendono il nome giusto.
  async function conLaVoceDiChiRegistra(audio, id, segmenti, durata) {
    if (!somiglianzaVoce || !segmenti.length) return segmenti;
    const pezzi = new Map();
    segmenti.forEach((s, i) => {
      const fine = segmenti[i + 1]?.inizio ?? durata;
      const g = pezzi.get(s.chi) ?? { lista: [], secondi: 0 };
      if (g.secondi < SECONDI_VOCE && fine > s.inizio) { g.lista.push([s.inizio, fine]); g.secondi += fine - s.inizio; }
      pezzi.set(s.chi, g);
    });
    const punti = new Map();
    let n = 0;
    for (const [chi, { lista }] of pezzi) {
      if (!lista.length) continue;
      const nome = `voce-${id}-${n++}.wav`;
      const file = path.join(cartellaAudio, nome);
      try {
        const filtro = lista.map(([a, b]) => `between(t,${a},${b})`).join('+');
        await esegui(ffmpeg, ['-y', '-v', 'error', '-i', audio, '-af', `aselect='${filtro}',asetpts=N/SR/TB`, '-ac', '1', '-ar', '16000', file], { timeout: 600000 });
        punti.set(chi, await somiglianzaVoce(nome));
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    const [migliore, valore] = [...punti].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))[0] ?? [];
    const chiRegistra = valore >= SOGLIA_VOCE ? migliore : null;
    const nomi = new Set(segmenti.map((s) => s.chi));
    let altro = 2;
    while (nomi.has(`Persona ${altro}`)) altro++;
    return segmenti.map((s) => {
      if (s.chi === chiRegistra) return { ...s, chi: 'Io' };
      // Gemini ha chiamato «Io» una voce che non è quella del campione: non si lascia quel nome a un altro.
      return s.chi === 'Io' ? { ...s, chi: `Persona ${altro}` } : s;
    });
  }

  async function lavora(id) {
    const f = db.prepare('SELECT nome, COALESCE(titolo, nome) AS titolo FROM file WHERE id = ? AND cestinato_il IS NULL').get(id);
    const n = riga(id);
    if (!f || !n) return;
    const audio = path.join(cartellaAudio, `nota-${id}.ogg`);
    try {
      imposta(id, 'trascrizione');
      await esegui(ffmpeg, ['-y', '-v', 'error', '-i', path.join(cartellaFile, id), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', audio], { timeout: 3600000 });
      const durata = await durataDi(audio);
      db.prepare('UPDATE file SET durata = ? WHERE id = ?').run(durata, id);
      const ctx = contesto();
      let segmenti;
      try {
        segmenti = await trascriviConGemini(audio, id, durata, ctx);
      } catch (err) {
        registra('nota_gemini_fallito', '', err.message.slice(0, 120));
        segmenti = await conWhisper(audio, id, ctx, n.genere);
      }
      try {
        segmenti = await conLaVoceDiChiRegistra(audio, id, segmenti, durata);
      } catch (err) {
        // Il testo vale anche senza nome giusto: si segnala e si va avanti.
        registra('nota_voce_fallita', '', err.message.slice(0, 120));
      }
      db.prepare('UPDATE note SET segmenti = ? WHERE file_id = ?').run(JSON.stringify(segmenti), id);

      const titoloCambiato = f.titolo !== f.nome.replace(/\.[a-z0-9]{1,5}$/i, '');
      imposta(id, 'riassunto');
      let titolo = f.titolo;
      if (segmenti.length && n.genere === 'appuntamento') {
        const r = await ia.riassumiAppuntamento(segmenti, f.titolo, durata, ctx);
        db.prepare('UPDATE note SET riassunto = ?, tipo_incontro = ? WHERE file_id = ?').run(JSON.stringify(r.sezioni), r.tipo, id);
        if (r.titolo && !titoloCambiato) titolo = r.titolo;
      } else if (segmenti.length && !titoloCambiato) {
        titolo = (await ia.titoloBreve(segmenti).catch(() => '')) || titolo;
      }
      db.prepare('UPDATE file SET titolo = ?, ia = 1, modificato_il = ? WHERE id = ?').run(titolo, Date.now(), id);
      imposta(id, 'pronta');
      registra('nota_pronta', '', `${titolo}: ${segmenti.length} frasi`);
      await notifica({ titolo: 'Nota pronta', testo: titolo, url: `/nota/${id}` });
      // L'esito dell'email si scrive sempre: inviata con la risposta del server di posta, o fallita con l'errore.
      if (n.genere === 'appuntamento' && posta.configured) await avvisa(id).then((esito) => registra('nota_email_inviata', '', `${titolo}: ${esito?.response ?? 'accettata'}`.slice(0, 160))).catch((err) => registra('nota_email_fallita', '', err.message.slice(0, 120)));
    } finally {
      fs.rmSync(audio, { force: true });
    }
    accodaPulizia(id);
  }

  const filePulito = (id) => path.join(cartellaPulito, `${id}.ogg`);
  async function pulisci(id) {
    const lavoro = path.join(cartellaAudio, `pulizia-${id}`);
    fs.mkdirSync(lavoro, { recursive: true });
    try {
      let entrata = path.join(cartellaFile, id);
      if (deepFilter) {
        const wav = path.join(lavoro, 'entrata.wav');
        const fatto = path.join(lavoro, 'fatto');
        fs.mkdirSync(fatto);
        await esegui(ffmpeg, ['-y', '-v', 'error', '-i', entrata, '-vn', '-ac', '1', '-ar', '48000', wav], { timeout: 3600000 });
        // Con priorità bassa: sul server girano le altre app. La copia ha lo stesso nome dell'entrata, quindi va in un'altra cartella.
        await esegui('nice', ['-n', '10', deepFilter, '-o', fatto, wav], { timeout: 6 * 3600000, maxBuffer: 1 << 24 });
        entrata = path.join(fatto, 'entrata.wav');
      }
      const temp = path.join(lavoro, 'uscita.ogg');
      await esegui(ffmpeg, ['-y', '-v', 'error', '-i', entrata, '-vn', '-ac', '1', '-af', CATENA_VOCE, '-c:a', 'libopus', '-b:a', '48k', temp], { timeout: 3600000 });
      fs.renameSync(temp, filePulito(id));
      db.prepare('UPDATE note SET pulita = 1 WHERE file_id = ?').run(id);
    } catch (err) {
      // Il testo c'è comunque e si ascolta l'originale.
      db.prepare('UPDATE note SET pulita = -1 WHERE file_id = ?').run(id);
      registra('nota_pulizia_fallita', '', err.message.slice(0, 120));
    } finally {
      fs.rmSync(lavoro, { recursive: true, force: true });
    }
  }
  const audioDa = (id) => (riga(id)?.pulita === 1 && fs.existsSync(filePulito(id)) ? filePulito(id) : null);

  const titoloDi = (id) => db.prepare('SELECT COALESCE(titolo, nome) AS t FROM file WHERE id = ?').get(id)?.t ?? 'Nota';

  function comeTesto(id, { markdown = false } = {}) {
    const n = nota(id);
    const t = titoloDi(id);
    const righe = [markdown ? `# ${t}` : t, ''];
    for (const s of n.riassunto) {
      righe.push(markdown ? `## ${s.titolo}` : s.titolo.toUpperCase());
      for (const r of s.righe) righe.push(`- ${r.testo}`);
      righe.push('');
    }
    if (n.segmenti.length) {
      righe.push(markdown ? '## Testo' : 'TESTO', '');
      for (const s of n.segmenti) {
        righe.push(markdown ? `**${s.chi}** (${tempoBreve(s.inizio)}): ${s.testo}\n` : `[${tempoBreve(s.inizio)}] ${s.chi}: ${s.testo}`);
        if (s.traduzione) righe.push(markdown ? `*${s.traduzione}*\n` : `    ${s.traduzione}`);
      }
    }
    return righe.join('\n');
  }

  // Come Zoom: finito il lavoro arriva l'email con riassunto e testo.
  async function avvisa(id) {
    const base = indirizzoPubblico();
    return posta.send(`DiGiNotes: ${titoloDi(id)}`, `${comeTesto(id)}\n\nApri la nota: ${base}/nota/${id}`);
  }

  const tempoSrt = (s) => { const ms = Math.round(s * 1000); const p = (x, n = 2) => String(x).padStart(n, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  function esporta(id, formato) {
    const n = nota(id);
    if (formato === 'md') return { corpo: Buffer.from(comeTesto(id, { markdown: true })), tipo: 'text/markdown; charset=utf-8', estensione: 'md' };
    if (formato === 'txt') return { corpo: Buffer.from(comeTesto(id)), tipo: 'text/plain; charset=utf-8', estensione: 'txt' };
    if (formato === 'srt') return { corpo: Buffer.from(n.segmenti.map((s, i) => `${i + 1}\n${tempoSrt(s.inizio)} --> ${tempoSrt(s.fine > s.inizio ? s.fine : s.inizio + 3)}\n${s.chi}: ${s.testo}\n`).join('\n')), tipo: 'application/x-subrip', estensione: 'srt' };
    if (formato === 'docx') {
      const x = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const par = comeTesto(id).split('\n').map((r) => `<w:p><w:r><w:t xml:space="preserve">${x(r)}</w:t></w:r></w:p>`).join('');
      const corpo = zipSync({
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${par}</w:body></w:document>`,
      });
      return { corpo, tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', estensione: 'docx' };
    }
    return null;
  }

  const errore = (testo, status) => Object.assign(new Error(testo), { status });
  // Le correzioni dell'utente: una frase, i nomi di chi parla, trova e sostituisci. Nessuna tocca l'audio.
  function modifica(id, { frase, rinomina, sostituisci }, indirizzo) {
    const n = nota(id);
    if (!n) return null;
    const seg = n.segmenti;
    let cambiate = 0;
    if (frase) {
      const s = seg[Number(frase.i)];
      const t = String(frase.testo ?? '').replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (!s) throw errore('Frase non trovata: ricarica la pagina.', 400);
      if (!t) throw errore('La frase non può essere vuota.', 400);
      if (s.testo !== t) delete s.traduzione; // la traduzione era della frase di prima
      s.testo = t;
      cambiate = 1;
    }
    if (rinomina) {
      const a = String(rinomina.a ?? '').trim().slice(0, 60);
      if (!a) throw errore('Scrivi il nome.', 400);
      for (const s of seg) if (s.chi === rinomina.da) { s.chi = a; cambiate++; }
    }
    if (sostituisci) {
      const da = String(sostituisci.da ?? '');
      if (!da) throw errore('Scrivi cosa cercare.', 400);
      const re = new RegExp(da.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const s of seg) { const nuovo = s.testo.replace(re, String(sostituisci.a ?? '')); if (nuovo !== s.testo) { s.testo = nuovo; cambiate++; } }
    }
    db.prepare('UPDATE note SET segmenti = ? WHERE file_id = ?').run(JSON.stringify(seg), id);
    db.prepare('UPDATE file SET modificato_il = ? WHERE id = ?').run(Date.now(), id);
    registra('nota_modificata', indirizzo, titoloDi(id));
    return { ...nota(id), cambiate };
  }

  // Chiedi: l'IA del server risponde leggendo solo le frasi più vicine alla domanda e i riassunti di quelle note.
  async function chiedi(domanda, notaId) {
    const d = String(domanda ?? '').trim().slice(0, 1000);
    if (!d) throw errore('Scrivi una domanda.', 400);
    const parole = [...new Set((d.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => w.length > 3 && !VUOTE.has(w)))];
    const righe = db.prepare(`SELECT n.file_id AS id, COALESCE(f.titolo, f.nome) AS titolo, n.segmenti, n.riassunto FROM note n JOIN file f ON f.id = n.file_id WHERE f.cestinato_il IS NULL AND n.stato = 'pronta'${notaId ? ' AND n.file_id = ?' : ''} ORDER BY f.caricato_il DESC`).all(...(notaId ? [notaId] : []));
    const candidati = [];
    for (const r of righe) {
      const seg = JSON.parse(r.segmenti || '[]');
      const trovate = seg.map((s) => ({ s, punti: parole.filter((p) => s.testo.toLowerCase().includes(p)).length })).filter((x) => x.punti);
      const punti = trovate.reduce((a, x) => a + x.punti, 0) + parole.filter((p) => r.riassunto?.toLowerCase().includes(p)).length * 2 + parole.filter((p) => r.titolo.toLowerCase().includes(p)).length * 2;
      if (punti || notaId) candidati.push({ id: r.id, titolo: r.titolo, punti, riassunto: JSON.parse(r.riassunto || '[]'), frasi: trovate.sort((a, b) => b.punti - a.punti).slice(0, 30).sort((a, b) => a.s.inizio - b.s.inizio).map((x) => x.s) });
    }
    candidati.sort((a, b) => b.punti - a.punti);
    const scelti = candidati.slice(0, 6);
    if (!scelti.length) return { risposta: 'Non ho trovato niente su questo nelle tue note.', fonti: [] };
    const contesto = scelti.map((c, i) => `NOTA ${i + 1}: «${c.titolo}»\n${c.riassunto.map((s) => `${s.titolo}: ${s.righe.map((x) => x.testo).join('; ')}`).join('\n')}\n${c.frasi.map((s) => `[${Math.round(s.inizio)}] ${s.chi}: ${s.testo}`).join('\n')}`).join('\n\n');
    const r = await ia.rispondi(d, contesto);
    const fonti = (r.fonti ?? []).map((x) => { const c = scelti[Number(x.nota) - 1]; return c ? { id: c.id, titolo: c.titolo, secondi: Math.max(0, Number(x.secondi) || 0) } : null; }).filter(Boolean);
    return { risposta: r.risposta, fonti };
  }

  function cerca(q) {
    const t = String(q ?? '').toLowerCase().trim();
    if (!t) return [];
    const out = [];
    for (const r of db.prepare("SELECT n.file_id AS id, n.segmenti FROM note n JOIN file f ON f.id = n.file_id WHERE f.cestinato_il IS NULL AND n.stato = 'pronta'").all()) {
      const s = JSON.parse(r.segmenti || '[]').find((x) => x.testo.toLowerCase().includes(t));
      if (s) out.push({ id: r.id, frase: s.testo, secondi: s.inizio });
    }
    return out;
  }

  return { audioDa, accoda, rifai, riprendi, nota, esporta, modifica, chiedi, cerca, comeTesto, impostaContesto, contesto };
}
