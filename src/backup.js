// Backup cifrati di DiGiShare (standard app, punti 9-11). AES-256-GCM, chiave
// derivata da DIGISHARE_AUTH_KEY. Dentro ci sono i due database (digishare.sqlite e auth.sqlite), copiati
// con l'API di backup di SQLite (copia coerente anche a caldo) e verificati prima di essere cifrati.
// I video NON entrano nel backup: pesano gigabyte e stanno gia' sul volume del server; il backup del server e'
// quello dell'utente. Il backup dell'app serve a riavere elenco, link, impostazioni e accesso.
// Il ripristino NON sostituisce i file mentre l'app gira: li prepara in `.restore-pending` e li
// installa all'avvio successivo (applyPendingRestore), cosi' nessun modulo tiene aperto un database vecchio.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';

const MAGIC = Buffer.from('DGSHBK01');
const DATABASES = ['digishare.sqlite', 'auth.sqlite'];
const NAME_RE = /^digishare-.*\.enc$/;
const MAX_FILE = 1024 * 1024 * 1024;
export const PENDING_DIR = '.restore-pending';

export const BACKUP_DEFAULTS = { enabled: true, frequency: 'weekly', dayOfWeek: 0, dayOfMonth: 1, hour: 3, minute: 0 };

export function normalizeBackupSettings(value = {}) {
  const v = { ...BACKUP_DEFAULTS, ...(value && typeof value === 'object' ? value : {}) };
  const out = {
    enabled: v.enabled !== false,
    frequency: String(v.frequency),
    dayOfWeek: Number(v.dayOfWeek), dayOfMonth: Number(v.dayOfMonth), hour: Number(v.hour), minute: Number(v.minute)
  };
  if (!['daily', 'weekly', 'monthly'].includes(out.frequency)) throw new Error('Frequenza del backup non valida.');
  if (!Number.isInteger(out.dayOfWeek) || out.dayOfWeek < 0 || out.dayOfWeek > 6) throw new Error('Giorno della settimana non valido.');
  if (!Number.isInteger(out.dayOfMonth) || out.dayOfMonth < 1 || out.dayOfMonth > 31) throw new Error('Giorno del mese non valido.');
  if (!Number.isInteger(out.hour) || out.hour < 0 || out.hour > 23) throw new Error('Ora non valida.');
  if (!Number.isInteger(out.minute) || out.minute < 0 || out.minute > 59) throw new Error('Minuti non validi.');
  return out;
}

function deriveKey(secret, salt) {
  const bytes = Buffer.from(String(secret || ''), 'base64url');
  if (bytes.length !== 32) throw new Error('DIGISHARE_AUTH_KEY non configurata o non valida.');
  return Buffer.from(hkdfSync('sha256', bytes, salt, 'digishare-backup-v1', 32));
}

async function snapshot(source, destination) {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
}

function inspect(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check');
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Database nel backup non integro.');
  } finally { db.close(); }
}

function pack(files) {
  const parts = [Buffer.from([files.length])];
  for (const { name, data } of files) {
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(2 + n.length + 8);
    head.writeUInt16BE(n.length, 0);
    n.copy(head, 2);
    head.writeBigUInt64BE(BigInt(data.length), 2 + n.length);
    parts.push(head, data);
  }
  return Buffer.concat(parts);
}

function unpack(buffer) {
  const files = [];
  let pos = 1;
  const count = buffer[0];
  for (let i = 0; i < count; i++) {
    const nameLen = buffer.readUInt16BE(pos); pos += 2;
    const name = buffer.subarray(pos, pos + nameLen).toString('utf8'); pos += nameLen;
    const size = Number(buffer.readBigUInt64BE(pos)); pos += 8;
    if (!DATABASES.includes(name) || pos + size > buffer.length) throw new Error('Contenuto inatteso nel backup.');
    files.push({ name, data: buffer.subarray(pos, pos + size) }); pos += size;
  }
  return files;
}

export async function createBackup({ dataDir, backupDir, secret, keep = 10, now = new Date() }) {
  const source = resolve(dataDir), destination = resolve(backupDir);
  if (destination === source || destination.startsWith(source + sep) || source.startsWith(destination + sep)) throw new Error('La cartella dei backup deve essere separata dai dati.');
  mkdirSync(destination, { recursive: true });
  const staging = join(destination, `.staging-${randomBytes(6).toString('hex')}`);
  mkdirSync(staging);
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let name = `digishare-${stamp}.enc`;
  for (let copy = 2; existsSync(join(destination, name)); copy++) name = `digishare-${stamp}-${copy}.enc`;
  const partial = join(destination, `.${name}.partial`), final = join(destination, name);
  try {
    const files = [];
    for (const db of DATABASES) {
      if (!existsSync(join(source, db))) continue;
      await snapshot(join(source, db), join(staging, db));
      inspect(join(staging, db));
      files.push({ name: db, data: readFileSync(join(staging, db)) });
    }
    if (!files.some(f => f.name === 'digishare.sqlite')) throw new Error('Database di DiGiShare non trovato.');
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
    const body = Buffer.concat([cipher.update(pack(files)), cipher.final()]);
    writeFileSync(partial, Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]), { mode: 0o600, flag: 'wx' });
    renameSync(partial, final);
    const all = readdirSync(destination).filter(f => NAME_RE.test(f)).map(file => ({ file, time: statSync(join(destination, file)).mtimeMs }));
    all.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file));
    for (const old of all.slice(keep)) rmSync(join(destination, old.file), { force: true });
    return final;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// Apre il file (decifra e verifica) e prepara l'installazione per il prossimo avvio.
export function stageRestore({ filePath, dataDir, secret }) {
  const file = resolve(filePath);
  const info = statSync(file);
  if (info.size > MAX_FILE) throw new Error('File di backup troppo grande.');
  const raw = readFileSync(file);
  const head = MAGIC.length + 16 + 12;
  if (raw.length <= head + 16) throw new Error('File di backup incompleto.');
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Formato di backup non valido.');
  const salt = raw.subarray(MAGIC.length, MAGIC.length + 16), iv = raw.subarray(MAGIC.length + 16, head);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let plain;
  try { plain = Buffer.concat([decipher.update(raw.subarray(head, raw.length - 16)), decipher.final()]); }
  catch { throw new Error('Backup non valido o creato con un\'altra chiave.'); }
  const files = unpack(plain);
  if (!files.some(f => f.name === 'digishare.sqlite')) throw new Error('Il backup non contiene il database di DiGiShare.');
  const pending = join(resolve(dataDir), PENDING_DIR);
  rmSync(pending, { recursive: true, force: true });
  mkdirSync(pending, { mode: 0o700 });
  try {
    for (const { name, data } of files) {
      writeFileSync(join(pending, name), data, { mode: 0o600 });
      inspect(join(pending, name));
    }
  } catch (error) { rmSync(pending, { recursive: true, force: true }); throw error; }
  return { files: files.map(f => f.name) };
}

// Da chiamare all'avvio, PRIMA di aprire i database. Tiene sempre le credenziali attuali (auth.sqlite):
// un backup vecchio non deve riportare indietro password o Authenticator. Solo su un'installazione
// senza account si usa quello del backup. La versione sostituita resta in `.restore-old`.
export function applyPendingRestore(dataDir) {
  const base = resolve(dataDir), pending = join(base, PENDING_DIR);
  if (!existsSync(pending)) return false;
  const old = join(base, '.restore-old');
  rmSync(old, { recursive: true, force: true });
  mkdirSync(old, { mode: 0o700 });
  const stale = name => [name, `${name}-journal`, `${name}-wal`, `${name}-shm`];
  const names = ['digishare.sqlite'];
  if (existsSync(join(pending, 'auth.sqlite')) && !existsSync(join(base, 'auth.sqlite'))) names.push('auth.sqlite');
  for (const name of names) {
    for (const f of stale(name)) if (existsSync(join(base, f))) renameSync(join(base, f), join(old, f));
    copyFileSync(join(pending, name), join(base, name));
  }
  rmSync(pending, { recursive: true, force: true });
  return true;
}

export function newestBackupTime(backupDir) {
  let newest = 0;
  try {
    for (const file of readdirSync(backupDir)) if (NAME_RE.test(file)) newest = Math.max(newest, statSync(join(backupDir, file)).mtimeMs);
  } catch { /* cartella assente: nessun backup */ }
  return newest;
}

export function listBackups(backupDir) {
  try {
    return readdirSync(backupDir).filter(f => NAME_RE.test(f)).map(file => {
      const s = statSync(join(backupDir, file));
      return { file, ts: s.mtimeMs, size: s.size };
    }).sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

export function backupOverdue({ settings = BACKUP_DEFAULTS, newestMs = 0, sinceMs = 0, now = Date.now() }) {
  if (settings.enabled === false) return false;
  const day = 86400000;
  const limit = settings.frequency === 'daily' ? 2 * day : settings.frequency === 'monthly' ? 35 * day : 9 * day;
  return now - Math.max(newestMs, sinceMs) > limit;
}

// Tocca il backup automatico? Si ragiona per giorni di calendario: passata l'ora scelta, oggi non c'e'
// ancora una copia e la frequenza lo prevede oggi. Un appuntamento mancato (server spento) si recupera.
export function backupDue({ settings = BACKUP_DEFAULTS, lastMs = 0, now = new Date() }) {
  if (settings.enabled === false) return false;
  const { frequency = 'weekly', dayOfWeek = 0, dayOfMonth = 1, hour = 3, minute = 0 } = settings;
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) return false;
  if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return false;
  const pad = n => String(n).padStart(2, '0');
  const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const planned = d => frequency === 'daily' ? true
    : frequency === 'weekly' ? d.getDay() === dayOfWeek
      : d.getDate() === Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
  const today = day(now);
  const last = lastMs ? new Date(lastMs) : null;
  if (last && day(last) === today) return false;
  if (planned(now)) return true;
  if (!last) return true;
  const cursor = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  for (let step = 0; step < 40; step++, cursor.setDate(cursor.getDate() + 1)) {
    if (day(cursor) >= today) break;
    if (planned(cursor)) return true;
  }
  return false;
}

export function startBackupScheduler({ getSettings, run, lastBackupMs = () => 0, onError = () => {}, intervalMs = 60000, clock = () => new Date() }) {
  let stopped = false, running = false, retryAfter = 0;
  async function tick() {
    if (stopped || running || Date.now() < retryAfter) return;
    running = true;
    try {
      if (!backupDue({ settings: getSettings(), lastMs: lastBackupMs(), now: clock() })) return;
      await run();
    } catch (error) {
      retryAfter = Date.now() + 6 * 3600000;
      try { await onError(error); } catch { /* l'avviso e' gia' stato tentato da run */ }
    } finally { running = false; }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}
