// Accesso con password + Authenticator (TOTP): modulo collaudato.
// Cambiano solo il nome dell'app, la chiave e i testi;
// la logica di blocco, sessioni, dispositivi ricordati e recupero e' identica e non va divergere.
// Nota per gli audit: le sessioni sono su disco in auth.sqlite (token casuale, impronta nel database),
// non con express-session: e' la stessa scelta delle altre due app, decisa prima di questa.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

const APP = 'DiGiShare';
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SESSION_MS = 30 * 86400000;
const DEVICE_MS = 90 * 86400000;
const CODE_MS = 10 * 60000;
const BLOCK_MS = 15 * 60000;
const SETUP_MS = 10 * 60000;

function keyFromEnv(value) {
  const bytes = Buffer.from(String(value || ''), 'base64url');
  if (bytes.length !== 32) throw new Error('DIGISHARE_AUTH_KEY non valida (servono 32 byte in base64url).');
  return bytes;
}
export function seal(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64url')).join('.');
}
function unseal(key, text) {
  const [iv, tag, body] = text.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
function otpStep(secret, code, lastStep = -1) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const now = Date.now();
  const delta = authenticator.clone({ epoch: now, window: 1 }).checkDelta(code, secret);
  if (delta === null) return null;
  const step = Math.floor(now / 30000) + delta;
  return step > lastStep ? step : null;
}
function parseCookie(req, name) {
  return String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
function deviceName(agent = '') {
  const os = /Android/i.test(agent) ? 'Android' : /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'Mac' : 'Dispositivo';
  const browser = /SamsungBrowser/i.test(agent) ? 'Samsung Internet' : /Edg\//i.test(agent) ? 'Edge' : /Chrome\//i.test(agent) ? 'Chrome' : /Firefox\//i.test(agent) ? 'Firefox' : /Safari\//i.test(agent) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

export function createSecurity({ dataDir, secret, secure = false, allowSetup = true, mailer = null }) {
  const key = keyFromEnv(secret);
  const recoveryKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'digishare-recovery-v1', 32));
  const db = new Database(join(dataDir, 'auth.sqlite'));
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts_v2 (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS sessions_v2 (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trusted_devices (token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_attempts (scope TEXT NOT NULL, subject TEXT NOT NULL, failures INTEGER NOT NULL, window_start INTEGER NOT NULL, blocked_until INTEGER NOT NULL, PRIMARY KEY(scope,subject));
    CREATE TABLE IF NOT EXISTS email_codes (purpose TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_totp (token_hash TEXT PRIMARY KEY, secret_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY, happened_at TEXT NOT NULL, kind TEXT NOT NULL, address TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  `);
  const fakeHash = bcrypt.hashSync(`fake-${token()}`, 12);
  const names = on => ({ session: on ? `__Host-${APP}` : `${APP}-session`, device: on ? `__Host-${APP}-device` : `${APP}-device` });
  let pendingSetup = null;

  const account = () => db.prepare('SELECT * FROM accounts_v2 WHERE id=1').get() || null;
  const initialized = () => Boolean(account());
  const setupAllowed = () => allowSetup && !initialized();
  function cookie(name, value, maxAge, on = secure) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; ${on ? 'Secure; ' : ''}Max-Age=${maxAge}`;
  }
  function log(kind, address = '', detail = '') {
    db.prepare('INSERT INTO security_events (happened_at,kind,address,detail) VALUES (?,?,?,?)').run(new Date().toISOString(), kind, String(address).slice(0, 80), String(detail).slice(0, 200));
  }
  async function alert(subject, message) {
    if (!mailer?.configured) return;
    try { await mailer.send(subject, message); }
    catch { log('email_avviso_fallita'); }
  }
  function rateKey(username = '') { return String(username).trim().toLowerCase().slice(0, 64); }
  function prune() {
    const now = Date.now();
    db.prepare('DELETE FROM sessions_v2 WHERE expires_at<?').run(now);
    db.prepare('DELETE FROM trusted_devices WHERE expires_at<?').run(now);
    db.prepare('DELETE FROM pending_totp WHERE expires_at<?').run(now);
    db.prepare('DELETE FROM auth_attempts WHERE blocked_until<? AND window_start<?').run(now, now - BLOCK_MS);
  }
  try { prune(); } catch { /* la pulizia non deve fermare l'avvio */ }
  const pruneTimer = setInterval(() => { try { prune(); } catch { clearInterval(pruneTimer); } }, 6 * 3600000);
  pruneTimer.unref();
  function blocked(scope, subject) {
    const row = db.prepare('SELECT blocked_until FROM auth_attempts WHERE scope=? AND subject=?').get(scope, subject);
    return Boolean(row && row.blocked_until > Date.now());
  }
  function failures(scope, subject) {
    const now = Date.now();
    const row = db.prepare('SELECT failures,window_start FROM auth_attempts WHERE scope=? AND subject=?').get(scope, subject);
    const within = row && now - row.window_start < BLOCK_MS;
    const count = within ? row.failures + 1 : 1;
    db.prepare('INSERT INTO auth_attempts (scope,subject,failures,window_start,blocked_until) VALUES (?,?,?,?,?) ON CONFLICT(scope,subject) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start,blocked_until=excluded.blocked_until').run(scope, subject, count, within ? row.window_start : now, count >= 5 ? now + BLOCK_MS : 0);
    return count;
  }
  function clearAttempts(scope, subject) { db.prepare('DELETE FROM auth_attempts WHERE scope=? AND subject=?').run(scope, subject); }
  function checkAttempts(address, username, phase, skipUser = false) {
    if (blocked(`${phase}_ip`, address) || (!skipUser && blocked(`${phase}_user`, rateKey(username)))) throw new Error('Troppi tentativi. Riprova tra 15 minuti.');
  }
  function failAttempts(address, username, phase) {
    failures(`${phase}_ip`, address);
    failures(`${phase}_user`, rateKey(username));
  }
  function clearPair(address, username, phase) {
    clearAttempts(`${phase}_ip`, address);
    clearAttempts(`${phase}_user`, rateKey(username));
  }
  async function verifyPassword(password, row) {
    if (typeof password !== 'string') return false;
    if (!row) { await bcrypt.compare(password, fakeHash); return false; }
    return bcrypt.compare(password, row.password_hash);
  }
  function checkNewPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('Scegli una password di almeno 8 caratteri.');
  }
  function makeSession(on = secure) {
    const raw = token(), csrf = token(), now = Date.now();
    db.prepare('INSERT INTO sessions_v2 (token_hash,csrf,created_at,expires_at) VALUES (?,?,?,?)').run(digest(raw), csrf, now, now + SESSION_MS);
    return { cookie: cookie(names(on).session, raw, SESSION_MS / 1000, on), csrf, tokenHash: digest(raw) };
  }
  function current(req, on = secure) {
    const raw = parseCookie(req, names(on).session);
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(raw)) return null;
    const row = db.prepare('SELECT csrf,expires_at FROM sessions_v2 WHERE token_hash=?').get(digest(raw));
    return row && row.expires_at > Date.now() ? { csrf: row.csrf, tokenHash: digest(raw) } : null;
  }
  function clearSessionCookie(on = secure) { return cookie(names(on).session, '', 0, on); }
  async function qr(secretValue, username) {
    const otpauthUrl = authenticator.keyuri(username, APP, secretValue);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 232, margin: 2, errorCorrectionLevel: 'M' });
    return { otpauthUrl, qrDataUrl };
  }
  async function startSetup(username = 'admin') {
    if (!setupAllowed()) throw new Error('Configurazione iniziale non disponibile.');
    const normalized = String(username).trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(normalized)) throw new Error('Nome utente non valido.');
    pendingSetup = { token: token(), username: normalized, secret: authenticator.generateSecret(), expiresAt: Date.now() + SETUP_MS, failures: 0 };
    return { setupToken: pendingSetup.token, secret: pendingSetup.secret, ...await qr(pendingSetup.secret, normalized) };
  }
  async function completeSetup({ setupToken, password, code }, address = '', on = secure) {
    if (!setupAllowed() || !pendingSetup || setupToken !== pendingSetup.token || pendingSetup.expiresAt <= Date.now()) throw new Error('Configurazione scaduta. Ricomincia.');
    checkNewPassword(password);
    const step = otpStep(pendingSetup.secret, code);
    if (step === null) {
      if (++pendingSetup.failures >= 5) pendingSetup = null;
      throw new Error('Codice Authenticator non valido.');
    }
    const hash = await bcrypt.hash(password, 12);
    db.transaction(() => {
      if (initialized()) throw new Error('Account già configurato.');
      db.prepare('INSERT INTO accounts_v2 (id,username,password_hash,totp_secret,last_step) VALUES (1,?,?,?,?)').run(pendingSetup.username, hash, seal(key, pendingSetup.secret), step);
      log('authenticator_attivato', address);
    })();
    pendingSetup = null;
    await alert(`${APP}: Authenticator attivato`, `L'accesso a ${APP} è stato configurato.`);
    return makeSession(on);
  }
  function deviceKnown(raw) {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(String(raw))) return false;
    const row = db.prepare('SELECT expires_at FROM trusted_devices WHERE token_hash=?').get(digest(raw));
    return Boolean(row && row.expires_at > Date.now());
  }
  function trusted(raw) {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(String(raw))) return false;
    const row = db.prepare('SELECT expires_at FROM trusted_devices WHERE token_hash=?').get(digest(raw));
    if (!row || row.expires_at <= Date.now()) return false;
    db.prepare('UPDATE trusted_devices SET last_used=? WHERE token_hash=?').run(Date.now(), digest(raw));
    return true;
  }
  function rememberDevice(userAgent, on = secure) {
    const raw = token(), now = Date.now();
    db.prepare('INSERT INTO trusted_devices (token_hash,label,created_at,last_used,expires_at) VALUES (?,?,?,?,?)').run(digest(raw), deviceName(userAgent), now, now, now + DEVICE_MS);
    return cookie(names(on).device, raw, DEVICE_MS / 1000, on);
  }
  async function login({ username = 'admin', password, code, remember = false }, address, deviceCookie = '', userAgent = '', on = secure) {
    const name = rateKey(username), row = account();
    const knownDevice = deviceKnown(deviceCookie);
    checkAttempts(address, name, 'login', knownDevice);
    const matchUser = row && row.username.toLowerCase() === name;
    const validPassword = await verifyPassword(password, matchUser ? row : null);
    if (!validPassword) {
      failAttempts(address, name, 'login');
      log('login_fallito', address);
      await alert(`${APP}: tentativo di accesso`, `Tentativo di accesso a DiGiShare con password errata da ${address}.`);
      throw new Error('Credenziali non valide.');
    }
    checkAttempts(address, name, 'mfa', knownDevice);
    const deviceValid = trusted(deviceCookie);
    const step = deviceValid ? null : otpStep(unseal(key, row.totp_secret), code, row.last_step);
    if (!deviceValid && step === null) {
      failAttempts(address, name, 'mfa');
      log('codice_errato', address);
      await alert(`${APP}: codice Authenticator errato`, `Tentativo con codice errato da ${address}.`);
      throw new Error('Credenziali non valide.');
    }
    db.transaction(() => {
      if (step !== null) {
        const result = db.prepare('UPDATE accounts_v2 SET last_step=? WHERE id=1 AND last_step<?').run(step, step);
        if (result.changes !== 1) throw new Error('Codice Authenticator già usato.');
      }
      clearPair(address, name, 'login');
      clearPair(address, name, 'mfa');
      log('login_riuscito', address, deviceValid ? 'dispositivo ricordato' : 'Authenticator');
    })();
    const result = makeSession(on);
    if (remember && !deviceValid) result.deviceCookie = rememberDevice(userAgent, on);
    await alert(`${APP}: nuovo accesso`, `Accesso riuscito da ${address} (${deviceName(userAgent)}).`);
    return result;
  }
  function logout(authSession, address = '', on = secure) {
    db.prepare('DELETE FROM sessions_v2 WHERE token_hash=?').run(authSession.tokenHash);
    log('logout', address);
    return cookie(names(on).session, '', 0, on);
  }
  function logoutAll(authSession, address = '') {
    db.prepare('DELETE FROM sessions_v2 WHERE token_hash<>?').run(authSession.tokenHash);
    log('sessioni_chiuse', address);
    void alert(`${APP}: sessioni chiuse`, `Le altre sessioni di ${APP} sono state chiuse.`);
  }
  function listDevices() { return db.prepare('SELECT token_hash AS id,label,created_at,last_used,expires_at FROM trusted_devices ORDER BY last_used DESC').all(); }
  function forgetDevices(address = '', on = secure) {
    db.prepare('DELETE FROM trusted_devices').run();
    log('dispositivi_revocati', address);
    void alert(`${APP}: dispositivi revocati`, `I dispositivi ricordati di ${APP} sono stati revocati.`);
    return cookie(names(on).device, '', 0, on);
  }
  async function changePassword({ currentPassword, code, newPassword }, authSession, address = '') {
    checkNewPassword(newPassword);
    const row = account();
    checkAttempts(address, row.username, 'change');
    if (!await verifyPassword(currentPassword, row)) {
      failAttempts(address, row.username, 'change');
      log('cambio_password_fallito', address);
      await alert(`${APP}: tentativo cambio password`, 'È stato tentato un cambio password non riuscito.');
      throw new Error('Credenziali non valide.');
    }
    const step = otpStep(unseal(key, row.totp_secret), code, row.last_step);
    if (step === null) {
      failAttempts(address, row.username, 'change');
      log('cambio_password_fallito', address);
      await alert(`${APP}: tentativo cambio password`, 'È stato tentato un cambio password non riuscito.');
      throw new Error('Credenziali non valide.');
    }
    const hash = await bcrypt.hash(newPassword, 12);
    db.transaction(() => {
      const consumed = db.prepare('UPDATE accounts_v2 SET last_step=?,password_hash=? WHERE id=1 AND last_step<?').run(step, hash, step);
      if (consumed.changes !== 1) throw new Error('Codice Authenticator già usato.');
      db.prepare('DELETE FROM sessions_v2 WHERE token_hash<>?').run(authSession.tokenHash);
      db.prepare('DELETE FROM trusted_devices').run();
      clearPair(address, row.username, 'change');
      log('password_cambiata', address);
    })();
    await alert(`${APP}: password cambiata`, `La password di ${APP} è stata cambiata. Tutte le altre sessioni sono state chiuse.`);
  }
  function recoveryHash(purpose, code) { return createHash('sha256').update(recoveryKey).update(`${purpose}:${code}`).digest('hex'); }
  async function requestRecovery({ username, purpose = 'password' }, address = '') {
    if (!['password', 'telefono'].includes(purpose)) throw new Error('Tipo di recupero non valido.');
    if (!mailer?.configured) throw new Error('Email di recupero non configurata.');
    const name = rateKey(username), row = account();
    checkAttempts(address, name, 'recovery');
    if (blocked('recovery_request_ip', address) || blocked('recovery_request_user', name)) throw new Error('Troppi tentativi. Riprova tra 15 minuti.');
    failAttempts(address, name, 'recovery_request');
    const response = { message: 'Se il nome utente è corretto, riceverai un codice via email.' };
    if (!row || row.username.toLowerCase() !== name) return response;
    const previous = db.prepare('SELECT sent_at FROM email_codes WHERE purpose=?').get(purpose);
    if (previous && Date.now() - previous.sent_at < 60000) return response;
    const code = String(randomInt(0, 100000000)).padStart(8, '0');
    const now = Date.now();
    db.prepare('INSERT INTO email_codes (purpose,code_hash,expires_at,failures,sent_at) VALUES (?,?,?,?,?) ON CONFLICT(purpose) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,failures=0,sent_at=excluded.sent_at').run(purpose, recoveryHash(purpose, code), now + CODE_MS, 0, now);
    try { await mailer.send(`${APP}: codice ${purpose === 'password' ? 'per la password' : 'telefono perso'}`, `Il tuo codice ${APP} è ${code}. Scade tra 10 minuti. Se non l'hai richiesto, ignora questa email.`); }
    catch { db.prepare('DELETE FROM email_codes WHERE purpose=? AND sent_at=?').run(purpose, now); throw new Error('Invio email non riuscito. Riprova.'); }
    log('codice_recupero_inviato', address, purpose);
    return response;
  }
  function consumeRecovery({ username, code, purpose = 'password' }, address) {
    const row = account(), name = rateKey(username);
    checkAttempts(address, name, 'recovery');
    const codeRow = db.prepare('SELECT * FROM email_codes WHERE purpose=?').get(purpose);
    const expected = recoveryHash(purpose, String(code));
    const valid = row && row.username.toLowerCase() === name && codeRow && codeRow.expires_at > Date.now() && /^\d{8}$/.test(String(code)) && timingSafeEqual(Buffer.from(codeRow.code_hash), Buffer.from(expected));
    if (!valid) {
      failAttempts(address, name, 'recovery');
      log('codice_recupero_errato', address, purpose);
      throw new Error('Codice non valido o scaduto.');
    }
    db.prepare('DELETE FROM email_codes WHERE purpose=?').run(purpose);
    clearPair(address, name, 'recovery');
    return row;
  }
  async function resetPassword(input, address = '') {
    checkNewPassword(input.newPassword);
    const row = consumeRecovery({ ...input, purpose: 'password' }, address);
    const hash = await bcrypt.hash(input.newPassword, 12);
    db.transaction(() => {
      db.prepare('UPDATE accounts_v2 SET password_hash=? WHERE id=1').run(hash);
      db.prepare('DELETE FROM sessions_v2').run();
      db.prepare('DELETE FROM trusted_devices').run();
      log('password_recuperata', address);
    })();
    await alert(`${APP}: password recuperata`, `La password dell'account ${row.username} è stata ripristinata.`);
  }
  async function startPhoneReset(input, address = '') {
    const row = consumeRecovery({ ...input, purpose: 'telefono' }, address);
    const raw = token(), secret = authenticator.generateSecret();
    db.prepare('DELETE FROM pending_totp').run();
    db.prepare('INSERT INTO pending_totp (token_hash,secret_cipher,expires_at) VALUES (?,?,?)').run(digest(raw), seal(key, secret), Date.now() + CODE_MS);
    log('telefono_recupero_avviato', address);
    return { resetToken: raw, secret, ...await qr(secret, row.username) };
  }
  async function completePhoneReset({ resetToken, code }, address = '') {
    const row = account();
    checkAttempts(address, row?.username || '', 'phone');
    const pending = db.prepare('SELECT * FROM pending_totp WHERE token_hash=?').get(digest(String(resetToken || '')));
    if (!pending || pending.expires_at <= Date.now()) { failAttempts(address, row?.username || '', 'phone'); throw new Error('Configurazione scaduta. Richiedi un nuovo codice email.'); }
    const secret = unseal(key, pending.secret_cipher);
    const step = otpStep(secret, code);
    if (step === null) { failAttempts(address, row?.username || '', 'phone'); throw new Error('Codice Authenticator non valido.'); }
    db.transaction(() => {
      db.prepare('UPDATE accounts_v2 SET totp_secret=?,last_step=? WHERE id=1').run(seal(key, secret), step);
      db.prepare('DELETE FROM pending_totp').run();
      db.prepare('DELETE FROM sessions_v2').run();
      db.prepare('DELETE FROM trusted_devices').run();
      log('authenticator_reimpostato', address);
    })();
    clearPair(address, row.username, 'phone');
    await alert(`${APP}: Authenticator reimpostato`, `Google Authenticator per ${APP} è stato reimpostato. Tutte le sessioni sono state chiuse.`);
  }
  async function confirmSensitive({ password, code }, address = '') {
    const row = account();
    if (!row) throw new Error('Account non configurato.');
    checkAttempts(address, row.username, 'sensitive');
    const validPassword = await verifyPassword(password, row);
    const step = validPassword ? otpStep(unseal(key, row.totp_secret), code, row.last_step) : null;
    if (step === null) {
      failAttempts(address, row.username, 'sensitive');
      log('operazione_sensibile_rifiutata', address);
      throw new Error('Password o codice Authenticator non validi.');
    }
    const result = db.prepare('UPDATE accounts_v2 SET last_step=? WHERE id=1 AND last_step<?').run(step, step);
    if (result.changes !== 1) throw new Error('Codice Authenticator già usato.');
    clearPair(address, row.username, 'sensitive');
  }
  function events(limit = 100) { return db.prepare('SELECT id,happened_at,kind,address,detail FROM security_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 100, 1), 500)); }
  function profile() { return { username: account()?.username || '', emailConfigured: Boolean(mailer?.configured) }; }
  function close() { db.close(); }
  return { initialized, setupAllowed, startSetup, completeSetup, login, current, clearSessionCookie, logout, logoutAll, listDevices, forgetDevices, deviceKnown, changePassword, requestRecovery, resetPassword, startPhoneReset, completePhoneReset, confirmSensitive, events, log, profile, cookieNames: names, close };
}
