// Lavorazioni video con ffmpeg, una alla volta e dopo il caricamento (tabella di marcia del 31.10.2026):
// 1) copertina e durata (miniature.js); 2) copia per la visione solo se serve davvero (due
//    file dello stesso peso non hanno senso): 1080p se il video e' piu' grande (un 4K di DiGiRec da 4 Mbit/s si
//    blocca sul telefono di un cliente) o se il browser non lo legge; un MP4 H.264 fino a 1080p si guarda
//    dall'originale, senza copia; 3) audio compresso per i sottotitoli dell'IA.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const esegui = promisify(execFile);
const TEMPO_MASSIMO = 4 * 3600 * 1000;
export const IN_ATTESA = 0;
export const PRONTA = 1;
export const FALLITA = -1;

export function creaVideo({ db, cartellaFile, cartellaVisione, cartellaAudio, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', dopoVisione = () => {}, registra = () => {} }) {
  const coda = [];
  let inCorso = false;
  let falliteDiFila = 0;

  async function misure(file) {
    const { stdout } = await esegui(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { timeout: 60000, windowsHide: true });
    const s = JSON.parse(stdout).streams?.[0] ?? {};
    return { larghezza: Number(s.width) || null, altezza: Number(s.height) || null, codec: s.codec_name || '' };
  }

  const senzaCopia = (m, id) => m.codec === 'h264' && (m.altezza ?? 0) <= 1080 && (m.larghezza ?? 0) <= 1920
    && db.prepare('SELECT tipo FROM file WHERE id = ?').get(id)?.tipo === 'video/mp4';

  // All'avvio: toglie le copie rimaste dei video che ora si guardano dall'originale. L'originale non si tocca, e se
  // manca o non si legge la copia resta.
  async function togliCopieInutili() {
    let tolte = 0;
    let byte = 0;
    for (const { id } of db.prepare("SELECT id FROM file WHERE tipo = 'video/mp4'").all()) {
      const copia = path.join(cartellaVisione, `${id}.mp4`);
      const sorgente = path.join(cartellaFile, id);
      try {
        const peso = (await fs.stat(copia)).size;
        if ((await fs.stat(sorgente)).size === 0 || !senzaCopia(await misure(sorgente), id)) continue;
        await fs.rm(copia);
        tolte++;
        byte += peso;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Copia di ${id} non tolta: ${err.message}`);
      }
    }
    if (tolte) registra('copie_tolte', '', `${tolte} ${tolte === 1 ? 'copia' : 'copie'}, ${Math.round(byte / 1e6)} MB liberati`);
    return { tolte, byte };
  }

  async function prepara(id) {
    const sorgente = path.join(cartellaFile, id);
    const destinazione = path.join(cartellaVisione, `${id}.mp4`);
    const temporanea = path.join(cartellaVisione, `${id}.tmp.mp4`);
    const m = await misure(sorgente);
    if (senzaCopia(m, id)) {
      db.prepare('UPDATE file SET visione = ?, larghezza = ?, altezza = ? WHERE id = ?').run(PRONTA, m.larghezza, m.altezza, id);
      registra('video_pronto', '', `${id.slice(0, 8)}: ${m.larghezza}×${m.altezza}, nessuna copia`);
      return;
    }
    const ricodifica = (m.altezza ?? 0) > 1080 || (m.larghezza ?? 0) > 1920 || !['h264'].includes(m.codec);
    const argomenti = ricodifica
      ? ['-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
      : ['-c', 'copy'];
    await esegui(ffmpeg, ['-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', sorgente, ...argomenti, '-movflags', '+faststart', '-f', 'mp4', temporanea], { timeout: TEMPO_MASSIMO, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    await fs.rename(temporanea, destinazione);
    db.prepare('UPDATE file SET visione = ?, larghezza = ?, altezza = ? WHERE id = ?').run(PRONTA, m.larghezza, m.altezza, id);
    registra('video_pronto', '', `${id.slice(0, 8)}: ${ricodifica ? `${m.larghezza}×${m.altezza} → 1080p` : 'avvio rapido'}`);
  }

  // Audio mono a 24 kbit/s: un'ora pesa circa 11 MB, dentro il limite di 25 MB di Groq.
  async function estraiAudio(id) {
    const destinazione = path.join(cartellaAudio, `${id}.ogg`);
    await esegui(ffmpeg, ['-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', path.join(cartellaFile, id), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', destinazione], { timeout: TEMPO_MASSIMO, windowsHide: true });
    return destinazione;
  }

  async function lavora() {
    if (inCorso) return;
    inCorso = true;
    while (coda.length) {
      const id = coda.shift();
      try {
        if (!db.prepare('SELECT 1 FROM file WHERE id = ? AND cestinato_il IS NULL').get(id)) continue;
        await prepara(id);
        falliteDiFila = 0;
        try { await dopoVisione(id); } catch (err) { console.error(`Dopo la visione di ${id}: ${err.message}`); }
      } catch (err) {
        console.error(`Copia per la visione non creata per ${id}: ${err.message}`);
        falliteDiFila++;
        db.prepare('UPDATE file SET visione = ? WHERE id = ?').run(FALLITA, id);
      }
    }
    inCorso = false;
  }

  function accoda(id) {
    if (coda.includes(id)) return;
    coda.push(id);
    lavora();
  }

  function riprendi() {
    for (const { id } of db.prepare("SELECT id FROM file WHERE visione = ? AND tipo LIKE 'video/%' AND cestinato_il IS NULL ORDER BY caricato_il").all(IN_ATTESA)) accoda(id);
  }

  return { accoda, riprendi, togliCopieInutili, estraiAudio, falliteDiFila: () => falliteDiFila, inCorso: () => inCorso || coda.length > 0 };
}
