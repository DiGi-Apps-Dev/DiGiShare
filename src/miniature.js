import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const esegui = promisify(execFile);
const TEMPO_MASSIMO = 120 * 1000;

export const IN_ATTESA = 0;
export const PRONTA = 1;
export const FALLITA = -1;

// Una alla volta e fuori dal caricamento: un video da 4K non deve rallentare chi sta caricando.
export function creaMiniature({ db, cartellaFile, cartellaMiniature, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', dopo = () => {} }) {
  const coda = [];
  let inCorso = false;
  // Fallimenti di fila: se ffmpeg sparisce dal container lo si vede da qui (punto 15 dello standard).
  let falliteDiFila = 0;

  async function misuraDurata(file) {
    const { stdout } = await esegui(ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { timeout: TEMPO_MASSIMO, windowsHide: true });
    const durata = Number(stdout.trim());
    return Number.isFinite(durata) && durata > 0 ? durata : null;
  }

  async function genera(id) {
    const file = path.join(cartellaFile, id);
    const destinazione = path.join(cartellaMiniature, `${id}.jpg`);
    const temporanea = `${destinazione}.tmp.jpg`;
    const durata = await misuraDurata(file);
    // Un fotogramma a un decimo del video, per evitare le dissolvenze iniziali.
    const punto = durata ? Math.min(durata * 0.1, 60) : 0;
    await esegui(ffmpeg, [
      '-v', 'error', '-y', '-protocol_whitelist', 'file', '-ss', String(punto), '-i', file,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', temporanea,
    ], { timeout: TEMPO_MASSIMO, windowsHide: true });
    await fs.rename(temporanea, destinazione);
    db.prepare('UPDATE file SET durata = ?, miniatura = ? WHERE id = ?').run(durata, PRONTA, id);
  }

  async function lavora() {
    if (inCorso) return;
    inCorso = true;
    while (coda.length) {
      const id = coda.shift();
      try {
        await genera(id);
        falliteDiFila = 0;
        dopo(id);
      } catch (err) {
        console.error(`Copertina non creata per ${id}: ${err.message}`);
        falliteDiFila++;
        db.prepare('UPDATE file SET miniatura = ? WHERE id = ?').run(FALLITA, id);
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
    const mancanti = db.prepare("SELECT id FROM file WHERE miniatura = ? AND tipo LIKE 'video/%' AND cestinato_il IS NULL").all(IN_ATTESA);
    for (const { id } of mancanti) accoda(id);
  }

  async function strumentiPresenti() {
    try {
      await esegui(ffmpeg, ['-version'], { timeout: 10000, windowsHide: true });
      await esegui(ffprobe, ['-version'], { timeout: 10000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  return { accoda, riprendi, strumentiPresenti, falliteDiFila: () => falliteDiFila };
}
