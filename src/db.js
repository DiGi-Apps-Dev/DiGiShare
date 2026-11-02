import path from 'node:path';
import Database from 'better-sqlite3';

// Database dei file e delle impostazioni. L'accesso (account, sessioni, dispositivi) sta in auth.sqlite,
// gestito da sicurezza.js: cosi' un ripristino da backup non riporta indietro password e Authenticator.
export function apriDb(cartellaDati) {
  const db = new Database(path.join(cartellaDati, 'digishare.sqlite'));
  // Niente WAL: sul server il file principale deve restare aggiornato anche se si spegne di colpo.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS impostazioni (
      chiave TEXT PRIMARY KEY,
      valore TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      dimensione INTEGER NOT NULL,
      caricato_il INTEGER NOT NULL,
      durata REAL,
      miniatura INTEGER NOT NULL DEFAULT 0,
      cestinato_il INTEGER,
      titolo TEXT,
      categoria_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS categorie (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
      ordine INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codice TEXT NOT NULL UNIQUE,
      file_id TEXT,
      categoria_id INTEGER,
      destinatario TEXT,
      scade_il INTEGER,
      scarica INTEGER NOT NULL DEFAULT 0,
      revocato_il INTEGER,
      creato_il INTEGER NOT NULL,
      aperture INTEGER NOT NULL DEFAULT 0,
      ultima_apertura INTEGER,
      promemoria_inviato INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS link_file ON link (file_id);
    CREATE TABLE IF NOT EXISTS visite (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visita TEXT NOT NULL UNIQUE,
      link_id INTEGER NOT NULL,
      file_id TEXT,
      quando INTEGER NOT NULL,
      indirizzo TEXT NOT NULL DEFAULT '',
      dispositivo TEXT NOT NULL DEFAULT '',
      secondi_visti REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS visite_link ON visite (link_id);
    CREATE TABLE IF NOT EXISTS note (
      file_id TEXT PRIMARY KEY,
      genere TEXT NOT NULL DEFAULT 'appuntamento',
      stato TEXT NOT NULL DEFAULT 'attesa',
      errore TEXT,
      segmenti TEXT,
      riassunto TEXT,
      tipo_incontro TEXT,
      pulita INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS zoom_importati (
      chiave TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      importato_il INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_abbonamenti (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      dispositivo TEXT NOT NULL DEFAULT '',
      creato_il INTEGER NOT NULL,
      ultimo_ok INTEGER
    );
  `);
  const colonne = db.prepare('PRAGMA table_info(file)').all().map((c) => c.name);
  if (!colonne.includes('durata')) db.exec('ALTER TABLE file ADD COLUMN durata REAL');
  if (!colonne.includes('miniatura')) db.exec('ALTER TABLE file ADD COLUMN miniatura INTEGER NOT NULL DEFAULT 0');
  if (!colonne.includes('cestinato_il')) db.exec('ALTER TABLE file ADD COLUMN cestinato_il INTEGER');
  if (!colonne.includes('titolo')) db.exec('ALTER TABLE file ADD COLUMN titolo TEXT');
  if (!colonne.includes('categoria_id')) db.exec('ALTER TABLE file ADD COLUMN categoria_id INTEGER');
  for (const [nome, tipo] of [['descrizione', 'TEXT'], ['visione', 'INTEGER NOT NULL DEFAULT 0'], ['sottotitoli', 'INTEGER NOT NULL DEFAULT 0'], ['capitoli', 'TEXT'], ['ia', 'INTEGER NOT NULL DEFAULT 0'], ['larghezza', 'INTEGER'], ['altezza', 'INTEGER'], ['archivio_segnalato', 'INTEGER NOT NULL DEFAULT 0'], ['ultima_apertura', 'INTEGER'], ['modificato_il', 'INTEGER']]) {
    if (!colonne.includes(nome)) db.exec(`ALTER TABLE file ADD COLUMN ${nome} ${tipo}`);
  }
  db.exec('UPDATE file SET modificato_il = caricato_il WHERE modificato_il IS NULL');
  // Il numerino delle novità parte da adesso: quello che c'era già non è nuovo.
  if (!colonne.includes('visto_il')) {
    db.exec('ALTER TABLE file ADD COLUMN visto_il INTEGER');
    db.exec('UPDATE file SET visto_il = caricato_il');
  }
  if (!db.prepare('PRAGMA table_info(note)').all().some((c) => c.name === 'pulita')) db.exec('ALTER TABLE note ADD COLUMN pulita INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(categorie)').all().some((c) => c.name === 'sezione')) db.exec("ALTER TABLE categorie ADD COLUMN sezione TEXT NOT NULL DEFAULT 'video'");
  // File caricati prima dei titoli: il titolo parte dal nome senza estensione.
  db.exec("UPDATE file SET titolo = CASE WHEN nome GLOB '*.[A-Za-z0-9]*' AND instr(nome, '.') > 1 THEN substr(nome, 1, length(nome) - length(replace(nome, rtrim(nome, replace(nome, '.', '')), '')) - 1) ELSE nome END WHERE titolo IS NULL");
  // Le due categorie dell'anteprima approvata dall'utente; poi le gestisce lui.
  if (!db.prepare('SELECT 1 FROM categorie LIMIT 1').get()) {
    db.prepare('INSERT INTO categorie (nome, ordine) VALUES (?, ?), (?, ?)').run('Tutorial', 1, 'Varie', 2);
  }
  // Tabelle della prima versione (password sola, sessioni, tentativi): sostituite da auth.sqlite.
  db.exec('DROP TABLE IF EXISTS sessioni; DROP TABLE IF EXISTS tentativi;');
  db.prepare('DELETE FROM impostazioni WHERE chiave = ?').run('password');
  // Le note arrivate prima di questa correzione segnavano l'ora del caricamento.
  for (const { id, nome, caricato_il: era } of db.prepare("SELECT id, nome, caricato_il FROM file WHERE nome GLOB 'DiGiNotes-*' AND tipo LIKE 'audio/%'").all()) {
    const ora = oraRegistrazione(nome);
    if (ora && ora !== era) db.prepare('UPDATE file SET caricato_il = ? WHERE id = ?').run(ora, id);
  }
  return db;
}

// DiGiNotes scrive nel nome del file quando è stata registrata la nota: DiGiNotes-<nota>-<millisecondi>[-<pezzo>].ogg
export function oraRegistrazione(nome) {
  const ora = Number(/^DiGiNotes-\d+-(\d{13})(?:-\d+)?\.[a-z0-9]+$/i.exec(String(nome))?.[1]);
  return ora && ora <= Date.now() + 86400000 ? ora : null;
}

export function leggiImpostazione(db, chiave, predefinito) {
  const riga = db.prepare('SELECT valore FROM impostazioni WHERE chiave = ?').get(chiave);
  if (!riga) return predefinito;
  try {
    return JSON.parse(riga.valore);
  } catch {
    return predefinito;
  }
}

export function scriviImpostazione(db, chiave, valore) {
  db.prepare('INSERT INTO impostazioni (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore')
    .run(chiave, JSON.stringify(valore));
}
