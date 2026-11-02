// Crea il file .env sul PC se manca, con una chiave DIGISHARE_AUTH_KEY nuova.
// Con Docker il .env nasce da .env.example: questo script non lo tocca se esiste.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(radice, '.env');
if (fs.existsSync(file)) {
  const testo = fs.readFileSync(file, 'utf8');
  if (/^DIGISHARE_AUTH_KEY=\S+/m.test(testo)) process.exit(0);
  fs.appendFileSync(file, `\nDIGISHARE_AUTH_KEY=${randomBytes(32).toString('base64url')}\n`);
  console.log('Aggiunta DIGISHARE_AUTH_KEY al file .env esistente.');
  process.exit(0);
}
fs.writeFileSync(file, [
  '# DiGiShare sul PC. Non copiare questo file in chat.',
  '# Persa questa chiave, i backup non si riaprono e l\'Authenticator va riconfigurato.',
  `DIGISHARE_AUTH_KEY=${randomBytes(32).toString('base64url')}`,
  '',
  '# Email per gli avvisi di sicurezza, recupero password e backup (stessa casella delle altre app).',
  '# Senza queste righe l\'app funziona, ma «Password dimenticata» e «Telefono perso» restano spenti.',
  '#SECURITY_EMAIL_TO=',
  '#SMTP_HOST=',
  '#SMTP_PORT=465',
  '#SMTP_USER=',
  '#SMTP_FROM=',
  '#SMTP_PASS=',
  '',
].join('\n'), { mode: 0o600 });
console.log('Creato il file .env con una chiave nuova.');
