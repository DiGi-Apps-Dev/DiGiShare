// Notifiche sul telefono (Web Push). Il telefono si fa dare un indirizzo dal servizio di
// Google e ce lo lascia: è l'abbonamento. Quando una nota o un video è pronto il server firma un messaggio con le chiavi
// VAPID e lo consegna lì; a disegnare l'avviso, anche con l'app chiusa, è public/sw.js. Nessuna porta aperta.
// Le chiavi nascono da sole al primo uso e stanno nel database: se si perdono, i telefoni vanno riabbonati.
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import webpush from 'web-push';
import { leggiImpostazione, scriviImpostazione } from './db.js';

const TIMEOUT = 5000;
const MASSIMO_DISPOSITIVI = 10;

// Solo i servizi dei produttori: un abbonamento non deve poter far chiamare al server un indirizzo qualunque.
export function endpointConsentito(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 500) return false;
  try {
    const u = new URL(endpoint);
    const h = u.hostname.toLowerCase();
    const servizio = h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com' || h === 'push.apple.com' || h.endsWith('.push.apple.com');
    return servizio && u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && !u.hash;
  } catch { return false; }
}

function indirizzoPubblico(indirizzo) {
  const famiglia = net.isIP(indirizzo);
  if (famiglia === 4) {
    const [a, b, c] = indirizzo.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  return famiglia === 6 && /^[23]/.test(indirizzo) && !/^2001:0*db8:/i.test(indirizzo);
}

// Il nome del servizio deve risolversi in indirizzi pubblici, controllati al momento della connessione.
const agente = new https.Agent({
  keepAlive: false,
  maxSockets: 4,
  timeout: TIMEOUT,
  lookup(host, opzioni, callback) {
    if (typeof opzioni === 'function') { callback = opzioni; opzioni = {}; }
    if (typeof opzioni === 'number') opzioni = { family: opzioni };
    dns.lookup(host, { ...opzioni, all: true }, (errore, indirizzi) => {
      if (errore) return callback(errore);
      if (!indirizzi?.length || indirizzi.some((x) => !indirizzoPubblico(x.address))) return callback(new Error('Destinazione delle notifiche non consentita.'));
      if (opzioni?.all) return callback(null, indirizzi);
      callback(null, indirizzi[0].address, indirizzi[0].family);
    });
  },
});

// PUSH_FINTA=<cartella>: i messaggi si scrivono come file invece di partire. Serve SOLO alle prove automatiche.
function spedisciFinto(cartella) {
  fs.mkdirSync(cartella, { recursive: true });
  return async (abbonamento, carico) => {
    if (abbonamento.endpoint.includes('sparito')) throw Object.assign(new Error('sparito'), { statusCode: 410 });
    fs.writeFileSync(path.join(cartella, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ endpoint: abbonamento.endpoint, ...JSON.parse(carico) }));
  };
}

export function creaNotifiche({ db, env = process.env, indirizzo = () => '', registra = () => {} }) {
  const finta = String(env.PUSH_FINTA || '').trim();
  const spedisci = finta ? spedisciFinto(finta) : (abbonamento, carico, opzioni) => webpush.sendNotification(abbonamento, carico, opzioni);

  function chiavi() {
    let k = leggiImpostazione(db, 'push_vapid', null);
    if (!k?.publicKey || !k?.privateKey) {
      k = webpush.generateVAPIDKeys();
      scriviImpostazione(db, 'push_vapid', k);
    }
    return k;
  }

  // Il servizio vuole sapere chi firma: l'indirizzo dell'app se è https, altrimenti un mailto che non porta da nessuna parte.
  const soggetto = () => { const a = indirizzo(); return a.startsWith('https://') ? new URL(a).origin : 'mailto:digishare@example.invalid'; };

  // Non lancia mai: una notifica che non parte non deve far fallire la nota o il video che l'ha provocata.
  async function manda(righe, { titolo, testo, url }) {
    const carico = JSON.stringify({ titolo, testo, url: url || '/' });
    const k = chiavi();
    let inviate = 0;
    for (const r of righe) {
      if (!endpointConsentito(r.endpoint)) continue;
      try {
        await spedisci({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, carico, { timeout: TIMEOUT, agent: agente, vapidDetails: { subject: soggetto(), publicKey: k.publicKey, privateKey: k.privateKey } });
        db.prepare('UPDATE push_abbonamenti SET ultimo_ok = ? WHERE endpoint = ?').run(Date.now(), r.endpoint);
        inviate++;
      } catch (err) {
        // 404 e 410: quel telefono non c'è più (app tolta, permesso revocato). Senza togliere la riga si riproverebbe per sempre.
        if (err?.statusCode === 404 || err?.statusCode === 410) db.prepare('DELETE FROM push_abbonamenti WHERE endpoint = ?').run(r.endpoint);
        else registra('notifica_fallita', '', String(err?.statusCode || err?.message || 'errore').slice(0, 120));
      }
    }
    return { inviate };
  }

  const aTutti = (messaggio) => manda(db.prepare('SELECT * FROM push_abbonamenti').all(), messaggio).catch((err) => { registra('notifica_fallita', '', err.message.slice(0, 120)); return { inviate: 0 }; });

  // Solo al telefono che la chiede.
  function prova(endpoint) {
    const riga = db.prepare('SELECT * FROM push_abbonamenti WHERE endpoint = ?').get(String(endpoint ?? ''));
    return riga ? manda([riga], { titolo: 'DiGiShare', testo: 'Le notifiche funzionano.', url: '/impostazioni' }) : null;
  }

  // Lo stesso telefono che si riabbona aggiorna la sua riga: due righe vorrebbero dire due notifiche identiche.
  function abbona(corpo, dispositivo) {
    const endpoint = typeof corpo?.endpoint === 'string' ? corpo.endpoint.trim() : '';
    const p256dh = String(corpo?.keys?.p256dh ?? '').slice(0, 200);
    const auth = String(corpo?.keys?.auth ?? '').slice(0, 200);
    if (!endpointConsentito(endpoint)) throw Object.assign(new Error('Destinazione delle notifiche non consentita.'), { status: 400 });
    if (!p256dh || !auth) throw Object.assign(new Error('Abbonamento incompleto.'), { status: 400 });
    const nuovo = !db.prepare('SELECT 1 FROM push_abbonamenti WHERE endpoint = ?').get(endpoint);
    if (nuovo && db.prepare('SELECT COUNT(*) AS n FROM push_abbonamenti').get().n >= MASSIMO_DISPOSITIVI) throw Object.assign(new Error(`Ci sono già ${MASSIMO_DISPOSITIVI} dispositivi abbonati.`), { status: 429 });
    db.prepare('INSERT INTO push_abbonamenti (endpoint, p256dh, auth, dispositivo, creato_il) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth')
      .run(endpoint, p256dh, auth, String(dispositivo ?? '').slice(0, 200), Date.now());
  }

  const disdici = (endpoint) => db.prepare('DELETE FROM push_abbonamenti WHERE endpoint = ?').run(String(endpoint ?? '')).changes > 0;
  const stato = () => ({ chiave: chiavi().publicKey, abbonati: db.prepare('SELECT COUNT(*) AS n FROM push_abbonamenti').get().n });

  return { aTutti, prova, abbona, disdici, stato };
}
