// Sottotitoli, capitoli e descrizione con l'IA, in automatico dopo il caricamento (
// con le chiavi del .env). Trascrizione: Groq whisper-large-v3;
// capitoli e descrizione: Gemini → NVIDIA → Cloudflare. L'audio del video esce verso Groq.
// IA_FINTA=1 risponde con dati finti: serve SOLO alle prove automatiche.
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

const MODELLI = { gemini: 'gemini-3.1-flash-lite', nvidia: 'nvidia/nemotron-3-ultra-550b-a55b', cloudflare: '@cf/openai/gpt-oss-120b', groq: 'whisper-large-v3' };
const LIMITE_AUDIO = 24 * 1024 * 1024;
// Vocabolario dell'app: Whisper li sente storpiati («di di share»), il riassunto li deve scrivere esatti.
const NOMI_PROPRI = 'DiGiNotes, DiGiShare, DiGiRec, DiGiShot, NAS, APK, Zoom';

// Grafia sicura a prescindere dall'IA. Solo i nomi che non sono parole comuni: «posta» e «zoom» restano come sono.
const GRAFIA = { notes: 'DiGiNotes', note: 'DiGiNotes', share: 'DiGiShare', rec: 'DiGiRec', shot: 'DiGiShot' };
export const nomiGiusti = (testo) => String(testo ?? '')
  .replace(/\bdi[\s-]?gi[\s-]?(notes|note|share|rec|shot)\b/gi, (_, n) => GRAFIA[n.toLowerCase()])
  .replace(/\bnas\b/gi, 'NAS')
  .replace(/\bapk\b/gi, 'APK');

// Quello che l'utente scrive nelle Impostazioni di DiGiNotes: glossario, voci note, memoria, lingua del riassunto.
const lista = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
// Whisper tiene solo l'inizio di una frase lunga: i nomi dell'app prima, poi quelli dell'utente e il taglio.
export const promptWhisper = (c = {}, base = `Trascrizione in italiano con la punteggiatura. Nomi usati: ${NOMI_PROPRI}`) => [base, ...lista(c.glossario), ...lista(c.voci)].join(', ').slice(0, 800) + '.';
export function righeContesto(c = {}) {
  const r = [];
  if (lista(c.glossario).length) r.push(`- Altre parole da scrivere esatte: ${lista(c.glossario).join(', ')}.`);
  if (lista(c.voci).length) r.push(`- Persone che compaiono spesso: ${lista(c.voci).join(', ')}. Sono solo nomi da scrivere giusti: non dire che c'erano se dal testo non risulta.`);
  if (lista(c.memoria).length) r.push(`- Da tenere presente: ${lista(c.memoria).join(' ')}`);
  return r.length ? `${r.join('\n')}\n` : '';
}
export function lingua(c = {}) {
  if (!c.lingua || c.lingua === 'Italiano') return 'Italiano';
  if (c.lingua === 'Stessa della registrazione') return 'Il testo di ogni riga nella lingua parlata nella registrazione';
  return `Il testo di ogni riga e il titolo tradotti in ${c.lingua}, anche se la trascrizione è in un'altra lingua`;
}

const tempoVtt = (s) => {
  const ms = Math.round((s % 1) * 1000);
  const t = Math.floor(s);
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};
export const tempoBreve = (s) => {
  const t = Math.round(s);
  const mm = String(Math.floor(t / 60) % 60);
  const ss = String(t % 60).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

export function segmentiInVtt(segmenti) {
  const righe = ['WEBVTT', ''];
  for (const s of segmenti) {
    const testo = String(s.text ?? '').trim();
    if (!testo) continue;
    righe.push(`${tempoVtt(Number(s.start) || 0)} --> ${tempoVtt(Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 0.5))}`, testo, '');
  }
  return righe.join('\n');
}

function estraiJson(testo) {
  const raw = String(testo || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('La risposta IA non contiene JSON.');
  return JSON.parse(raw.slice(a, b + 1));
}

async function postJson(url, chiave, corpo, intestazioni = {}, timeout = 60000) {
  const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', ...(chiave ? { Authorization: `Bearer ${chiave}` } : {}), ...intestazioni }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- riassunto a voci (docs/protocollo-appuntamento.md): l'IA dà voci con un tipo, le sezioni le compone il codice ----
export const TIPI_VOCE = ['fatto', 'decisione', 'dato', 'azione', 'fatta', 'sospeso', 'pendenza', 'prossimo'];
const VOCI_APERTE = ['azione', 'sospeso', 'pendenza', 'prossimo'];
const PESO_APERTA = { pendenza: 3, prossimo: 3, sospeso: 2, azione: 1 };
const norma = (x) => String(x ?? '').toLowerCase().replace(/(\d)['’.](?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ');
const PAROLE_VUOTE = new Set('di a da in con su per tra fra il lo la i gli le un una uno e o che non si del della dei delle al alla sul sulla nel nella ha ho sono entro nuovo nuova nuove nuovi deve devo devono fare andare'.split(' '));
// Radici di quattro lettere: «verifica» e «verificare», «pagata» e «pagamento» sono la stessa cosa.
const radici = (x) => new Set((norma(x).match(/[\p{L}\d'.,]{3,}/gu) || []).map((w) => w.replace(/[.,]+$/, '')).filter((w) => !PAROLE_VUOTE.has(w)).map((w) => w.slice(0, 4)));
const inComune = (a, b) => { const ra = radici(a); const rb = radici(b); const n = [...ra].filter((w) => rb.has(w)).length; return { n, quota: n / Math.max(1, Math.min(ra.size, rb.size)) }; };
const stessaCosa = (a, b, quota) => { const c = inComune(a, b); return c.n >= 2 && c.quota >= quota; };
const senzaPunto = (x) => String(x).replace(/[.\s]+$/, '');
const RIFERIMENTI = /\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,']\d+)*\b|\b(?:lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)\b|\b(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b|\b(?:prossima settimana|prossimo mese|domani|dopodomani)\b/gi;

export function pulisciVoci(voci) {
  const visti = new Set();
  return (Array.isArray(voci) ? voci : []).filter((v) => TIPI_VOCE.includes(v?.tipo) && String(v.testo ?? '').trim())
    .map((v) => ({ tipo: v.tipo, argomento: nomiGiusti(v.argomento ?? '').trim().slice(0, 80) || 'Generale', testo: nomiGiusti(v.testo).replace(/\s+/g, ' ').trim().slice(0, 800), secondi: Math.max(0, Number(v.secondi) || 0) }))
    .filter((v) => { const k = norma(v.testo); if (visti.has(k)) return false; visti.add(k); return true; });
}
// Ogni data, scadenza e cifra detta nella trascrizione. I numeri scritti a parole non si vedono.
export function riferimentiDi(segmenti) {
  const tutti = new Set();
  for (const s of segmenti) for (const m of norma(s.traduzione || s.testo).match(RIFERIMENTI) || []) tutti.add(m.trim());
  return [...tutti];
}
export function riferimentiMancanti(riferimenti, voci) {
  const testo = norma(voci.map((v) => v.testo).join(' | '));
  return riferimenti.filter((r) => !new RegExp(`(^|[^\\d])${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\d])`, 'i').test(testo));
}
const cifreDi = (x) => norma(x).match(/\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)*\b/g)?.map((m) => m.trim()) || [];
export const cifreSenzaDato = (voci) => riferimentiMancanti([...new Set(voci.filter((v) => v.tipo === 'decisione').flatMap((v) => cifreDi(v.testo)))], voci.filter((v) => v.tipo === 'dato'));
// Le voci sulla stessa cosa diventano una: la più specifica decide la sezione (una fattura non pagata è una pendenza).
export function unisciVoci(voci) {
  const fuori = [];
  // Una cosa fatta dopo il momento in cui era da fare non resta da fare: vale anche se il passaggio di controllo non ha risposto.
  const fatte = voci.filter((v) => v.tipo === 'fatta');
  for (const v of voci) {
    if (v.tipo === 'azione' && fatte.some((f) => f.secondi >= v.secondi && stessaCosa(f.testo, v.testo, 0.5))) continue;
    if (!VOCI_APERTE.includes(v.tipo)) { fuori.push({ ...v }); continue; }
    const uguale = fuori.find((x) => VOCI_APERTE.includes(x.tipo) && stessaCosa(x.testo, v.testo, x.tipo === 'azione' && v.tipo === 'azione' ? 0.75 : 0.4));
    if (!uguale) { fuori.push({ ...v }); continue; }
    const vince = PESO_APERTA[v.tipo] > PESO_APERTA[uguale.tipo] ? v : uguale;
    const perde = vince === v ? uguale : v;
    const contenuta = inComune(vince.testo, perde.testo).quota === 1;
    const lunga = vince.testo.length >= perde.testo.length ? vince.testo : perde.testo;
    Object.assign(uguale, { tipo: vince.tipo, testo: contenuta ? lunga : `${senzaPunto(vince.testo)}. ${senzaPunto(perde.testo)}.`, secondi: Math.min(v.secondi, uguale.secondi) });
  }
  // Una data rimasta da sola («settembre») torna nella voce a cui appartiene.
  return fuori.filter((d) => {
    if (d.tipo !== 'dato' || /\d/.test(d.testo)) return true;
    const casa = fuori.find((x) => x !== d && x.tipo !== 'dato' && x.tipo !== 'fatto' && stessaCosa(x.testo, d.testo, 0.4));
    if (!casa) return true;
    casa.testo = `${senzaPunto(casa.testo)} (${d.testo.split(':').pop().trim()})`;
    return false;
  });
}
// La cifra che risulta da una decisione si chiama «finale», mai «proposta».
export function cifreFinali(voci) {
  const decise = new Set(voci.filter((v) => v.tipo === 'decisione').flatMap((v) => cifreDi(v.testo)));
  return voci.map((v) => (v.tipo === 'dato' && cifreDi(v.testo).some((c) => decise.has(c)) ? { ...v, testo: v.testo.replace(/\b(?:propost|concordat)[oa]\b/gi, 'finale') } : v));
}
export function statoDegliArgomenti(voci) {
  return [...new Set(voci.map((v) => v.argomento))].map((argomento) => {
    const aperte = voci.filter((v) => v.argomento === argomento && VOCI_APERTE.includes(v.tipo));
    return { argomento, aperto: aperte.length > 0, resta: aperte.map((v) => senzaPunto(v.testo)) };
  });
}
// Stessa forma di sempre (titolo e righe): sito, app, email, esportazioni e Chiedi non cambiano.
export function sezioniDaVoci(voci, inBreve = '') {
  const riga = ({ testo, secondi }) => ({ testo, secondi });
  const sezioni = [];
  const stato = statoDegliArgomenti(voci).filter((s) => s.aperto).map((s) => ({ testo: `${s.argomento}: aperto, ${s.resta.length === 1 ? 'resta 1 cosa' : `restano ${s.resta.length} cose`}.`, secondi: 0 }));
  const breve = [...(String(inBreve).trim() ? [{ testo: nomiGiusti(inBreve).replace(/\s+/g, ' ').trim().slice(0, 800), secondi: 0 }] : []), ...stato];
  if (breve.length) sezioni.push({ titolo: 'In breve', righe: breve });
  const nomi = [...new Set(voci.filter((v) => ['fatto', 'decisione', 'dato'].includes(v.tipo)).map((v) => v.argomento))];
  for (const nome of nomi) {
    for (const [tipo, titolo] of [['fatto', 'Cosa è emerso'], ['decisione', 'Decisioni'], ['dato', 'Dati e cifre']]) {
      const righe = voci.filter((v) => v.argomento === nome && v.tipo === tipo).map(riga);
      if (righe.length) sezioni.push({ titolo: `${nome}: ${titolo}`, righe });
    }
  }
  for (const [tipo, titolo] of [['azione', 'Cose da fare'], ['fatta', 'Cose fatte'], ['sospeso', 'In sospeso'], ['pendenza', 'Pendenze'], ['prossimo', 'Prossimo passo']]) {
    const righe = voci.filter((v) => v.tipo === tipo).map(riga);
    if (righe.length) sezioni.push({ titolo, righe });
  }
  return sezioni;
}

export function creaIa(env = process.env, { completaProva = null } = {}) {
  const finta = env.IA_FINTA === '1';
  const fornitori = [];
  if (env.GEMINI_API_KEY) fornitori.push({ nome: 'Gemini', async run(prompt) {
    const r = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL || MODELLI.gemini)}:generateContent`, null, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }, { 'x-goog-api-key': env.GEMINI_API_KEY }, 180000);
    return r.candidates?.[0]?.content?.parts?.filter((p) => typeof p.text === 'string').map((p) => p.text).join('') || '';
  } });
  if (env.NVIDIA_API_KEY) fornitori.push({ nome: 'NVIDIA', async run(prompt) {
    const r = await postJson('https://integrate.api.nvidia.com/v1/chat/completions', env.NVIDIA_API_KEY, { model: env.NVIDIA_MODEL || MODELLI.nvidia, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 8192, stream: false, chat_template_kwargs: { enable_thinking: false } }, {}, 120000);
    return r.choices?.[0]?.message?.content || '';
  } });
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) fornitori.push({ nome: 'Cloudflare', async run(prompt) {
    const r = await postJson(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`, env.CLOUDFLARE_API_TOKEN, { model: env.CLOUDFLARE_MODEL || MODELLI.cloudflare, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 8192 }, {}, 180000);
    return r.choices?.[0]?.message?.content || '';
  } });

  const trascrizioneDisponibile = finta || Boolean(env.GROQ_API_KEY);
  const testoDisponibile = finta || fornitori.length > 0;

  async function trascrivi(fileAudio, contesto = {}) {
    if (finta) {
      return [{ start: 0, end: 4, text: 'Benvenuti in questo tutorial di DiGiRec.' }, { start: 4, end: 9, text: 'Oggi vediamo come installare il programma.' }, { start: 9, end: 12, text: 'Poi passiamo alle opzioni.' }];
    }
    const { size } = await fs.stat(fileAudio);
    if (size > LIMITE_AUDIO) throw new Error(`Audio troppo lungo per la trascrizione (${Math.round(size / 1e6)} MB, limite 24).`);
    const form = new FormData();
    form.append('model', env.GROQ_TRANSCRIPTION_MODEL || MODELLI.groq);
    form.append('language', 'it');
    form.append('response_format', 'verbose_json');
    // Whisper scrive come ha sentito: la frase di partenza gli insegna i nomi giusti e la punteggiatura.
    form.append('prompt', env.GROQ_PROMPT || promptWhisper(contesto));
    form.append('file', await openAsBlob(fileAudio), path.basename(fileAudio));
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`Groq HTTP ${r.status}`);
    const dati = await r.json();
    return (dati.segments || []).map((s) => ({ start: s.start, end: s.end, text: nomiGiusti(s.text) }));
  }

  async function completa(prompt) {
    if (completaProva) return completaProva(prompt);
    if (finta) return JSON.stringify({ descrizione: 'Come installare DiGiRec e vedere le prime opzioni.', capitoli: [{ secondi: 0, titolo: 'Benvenuto' }, { secondi: 4, titolo: 'Installazione' }, { secondi: 9, titolo: 'Opzioni' }] });
    const errori = [];
    for (const f of fornitori) {
      try {
        const testo = await f.run(prompt);
        if (!testo.trim()) throw new Error('risposta vuota');
        return testo;
      } catch (err) { errori.push(`${f.nome}: ${err.message}`); }
    }
    throw new Error(`Nessun servizio IA ha risposto (${errori.join('; ')}).`);
  }

  // Capitoli e descrizione dalla trascrizione (con i tempi): si tagliano le trascrizioni lunghissime.
  async function capitoliEDescrizione(segmenti, titolo, durata) {
    const righe = segmenti.map((s) => `[${tempoBreve(Number(s.start) || 0)}] ${String(s.text).trim()}`).join('\n');
    const testo = righe.length > 40000 ? `${righe.slice(0, 40000)}\n[…]` : righe;
    const prompt = `Sei l'assistente di un'app italiana che condivide video tutorial. Ecco la trascrizione con i tempi del video «${titolo}» (durata ${tempoBreve(durata || 0)}):\n\n${testo}\n\nRispondi SOLO con un JSON così: {"descrizione": "...", "capitoli": [{"secondi": 0, "titolo": "..."}]}.\n- descrizione: 1-2 frasi in italiano, chiare, che dicono cosa impara chi guarda; niente emoji.\n- capitoli: da 3 a 12 voci, in ordine, "secondi" è l'inizio del capitolo preso dai tempi della trascrizione (il primo a 0), "titolo" massimo 6 parole in italiano. Per video sotto i 2 minuti bastano 2-3 capitoli.`;
    const dati = estraiJson(await completa(prompt));
    const capitoli = (Array.isArray(dati.capitoli) ? dati.capitoli : [])
      .map((c) => ({ secondi: Math.max(0, Math.floor(Number(c.secondi) || 0)), titolo: String(c.titolo || '').replace(/\s+/g, ' ').trim().slice(0, 80) }))
      .filter((c) => c.titolo && (!durata || c.secondi < durata))
      .sort((a, b) => a.secondi - b.secondi)
      .filter((c, i, arr) => i === 0 || c.secondi > arr[i - 1].secondi)
      .slice(0, 12);
    return { descrizione: String(dati.descrizione || '').replace(/\s+/g, ' ').trim().slice(0, 600), capitoli };
  }

  // ---- note di DiGiNotes ----
  const SEZIONI = ['Progetti', 'Punti discussi', 'Dati e cifre', 'Cose da fare', 'Cose fatte', 'In sospeso', 'Pendenze'];
  const conTempi = (segmenti) => segmenti.map((s) => `[${Math.round(Number(s.inizio) || 0)}] ${s.chi && s.chi !== 'Voce' ? `${s.chi}: ` : ''}${s.traduzione || s.testo}`).join('\n');

  // Il metodo di prima, a sezioni fisse: è la riserva se il metodo a voci non riesce.
  async function riassuntoASezioni(segmenti, titolo, durata, contesto = {}) {
    if (finta) return { titolo: 'Rinnovo polizza', tipo: 'Colloquio', sezioni: [{ titolo: 'Punti discussi', righe: [{ testo: 'Franchigia portata a CHF 300.', secondi: 4 }] }, { titolo: 'Cose da fare', righe: [{ testo: 'Marco: inviare il contratto.', secondi: 9 }] }] };
    const testo = conTempi(segmenti);
    // Le azioni concrete stanno in Cose da fare anche quando riguardano un progetto: anche se il progetto è nominato.
    const prompt = `Sei un assistente di lavoro. Ecco la trascrizione di un incontro (durata ${tempoBreve(durata || 0)}): ogni riga inizia con il secondo della registrazione.\n\n${testo.slice(0, 400000)}\n\nFai un indice di lavoro, non una trascrizione accorciata. Rispondi SOLO con un JSON così: {"titolo":"...","tipo":"...","sezioni":[{"titolo":"...","righe":[{"testo":"...","secondi":0}]}]}.\n- titolo: massimo 8 parole, dice di cosa si è parlato.\n- tipo: riconoscilo tu: colloquio, sopralluogo, riunione, telefonata o altro.\n- sezioni, solo queste e in quest'ordine: ${SEZIONI.join(', ')}. Una sezione senza contenuto non si scrive.\n- Progetti: progetti, pratiche o persone di cui si è parlato. Dati e cifre: importi, date, scadenze e numeri esatti come detti. Cose da fare: chi fa cosa e per quando, se detto. Cose fatte: già fatto o concluso. In sospeso: aspetta una risposta o una decisione. Pendenze: debiti, pagamenti, documenti o impegni rimasti aperti.\n- Progetti contiene solo il nome del progetto o della pratica: un'azione concreta da compiere va in Cose da fare anche se riguarda un progetto.\n- Conta com'è finita: se chi parla dice che una cosa è già fatta, anche dopo averla nominata come da fare, va in Cose fatte e non in Cose da fare. Mai la stessa cosa in tutte e due.\n- Nomi propri, da scrivere esatti: ${NOMI_PROPRI}. La trascrizione può storpiarli («di di share», «share» per DiGiShare): se dal discorso è chiaro quale nome è, scrivilo giusto.\n${righeContesto(contesto)}- secondi: il secondo in cui se ne parla, preso dalla trascrizione.\n- Non inventare niente: quello che non è stato detto non si scrive. Se un nome o una cifra non si capisce, dillo.\n- I titoli delle sezioni restano in italiano, esatti come sopra.\n- ${lingua(contesto)}, frasi brevi, niente commenti e niente emoji.`;
    const d = estraiJson(await completa(prompt));
    const pulisci = (t, n) => nomiGiusti(t).replace(/\s+/g, ' ').trim().slice(0, n);
    const sezioni = SEZIONI.map((nome) => {
      const trovata = (Array.isArray(d.sezioni) ? d.sezioni : []).find((x) => pulisci(x.titolo, 60).toLowerCase() === nome.toLowerCase());
      const righe = (Array.isArray(trovata?.righe) ? trovata.righe : []).map((r) => ({ testo: pulisci(r.testo, 800), secondi: Math.max(0, Number(r.secondi) || 0) })).filter((r) => r.testo);
      return { titolo: nome, righe };
    }).filter((x) => x.righe.length);
    if (!sezioni.length) throw new Error('Il riassunto è vuoto.');
    return { titolo: pulisci(d.titolo, 120), tipo: pulisci(d.tipo, 40), sezioni };
  }

    const regoleVoci = (contesto) => `Ogni voce è un oggetto {"tipo":"...","argomento":"...","testo":"...","secondi":0} e ha un tipo, uno solo:
- fatto: un fatto o un'opinione venuti fuori. Senza cifre, senza azioni, senza decisioni.
- decisione: una scelta presa davvero fra più possibilità. Può citare la sua cifra, che ha comunque anche la sua voce dato. La cifra che risulta da una decisione si chiama «finale», mai «proposta» (per esempio «Premio finale: 100 franchi»). Un'azione da compiere non è una decisione.
- dato: una sola cifra, data o scadenza, con il suo nome giusto che dica a cosa si riferisce. Ogni numero detto ha la sua voce dato.
- azione: qualcosa ancora da fare, con chi e per quando se è stato detto.
- fatta: qualcosa già fatto o concluso. Se chi parla dice che una cosa è fatta, è fatta anche se prima era da fare.
- sospeso: aspetta una risposta o una scelta non ancora presa, con il motivo e la data se detti.
- pendenza: un debito, un pagamento, un documento o un impegno dovuto da altri o verso altri, con importo e scadenza se detti.
- prossimo: il prossimo appuntamento o contatto, con giorno e ora.
Ogni informazione sta in una voce sola: non scrivere la stessa cosa con due tipi. Una fattura o un debito da controllare è una sola voce pendenza, con importo e scadenza nella stessa voce.
argomento: il nome del progetto, della pratica o del tema, preso dal discorso. Stesso argomento, stesso nome identico.
secondi: il secondo in cui se ne parla, preso dalla trascrizione.
Non inventare niente: se un nome o una cifra non si capisce, dillo. Nomi propri, da scrivere esatti: ${NOMI_PROPRI}. La trascrizione può storpiarli: se dal discorso è chiaro quale nome è, scrivilo giusto.
${righeContesto(contesto)}${lingua(contesto)}, frasi brevi, niente commenti e niente emoji.`;
  const chiediVoci = async (prompt) => { const d = estraiJson(await completa(prompt)); return Array.isArray(d) ? d : d.voci; };
  // Un servizio occupato spesso torna dopo poco: i passaggi di rifinitura ci riprovano una volta.
  const conRiprova = async (lavoro) => { try { return await lavoro(); } catch { await new Promise((r) => setTimeout(r, env.IA_ATTESA_RIPROVA ? Number(env.IA_ATTESA_RIPROVA) : 20000)); return lavoro(); } };

  async function riassumiAppuntamento(segmenti, titolo, durata, contesto = {}) {
    if (finta && !completaProva) return riassuntoASezioni(segmenti, titolo, durata, contesto);
    const testo = conTempi(segmenti).slice(0, 400000);
    let voci;
    try {
      voci = pulisciVoci(await chiediVoci(`Ecco la trascrizione di un incontro (durata ${tempoBreve(durata || 0)}): ogni riga inizia con il secondo della registrazione.\n\n${testo}\n\nScomponila in voci. Non è una trascrizione accorciata: è un indice di lavoro, che vale per qualsiasi materia. Rispondi SOLO con un JSON così: {"voci":[...]}.\n${regoleVoci(contesto)}`));
      if (!voci.length) throw new Error('nessuna voce');
    } catch {
      // Quota finita o risposta sbagliata: la nota esce lo stesso, col metodo di prima.
      return riassuntoASezioni(segmenti, titolo, durata, contesto);
    }
    // I passaggi dopo migliorano e basta: se uno fallisce si tiene quello che c'è.
    const rif = riferimentiDi(segmenti);
    try {
      const mancano = riferimentiMancanti(rif, voci);
      if (mancano.length) voci = pulisciVoci([...voci, ...await conRiprova(() => chiediVoci(`Ecco la trascrizione di un incontro:\n\n${testo}\n\nEcco le voci già estratte:\n${JSON.stringify(voci)}\n\nQueste cifre e date sono nella trascrizione ma in nessuna voce: ${mancano.join(' | ')}.\nScrivi SOLO le voci per queste, ognuna con il suo tipo e la cifra o data scritta esatta come detta. Se una data completa una voce già estratta, riscrivi quella voce intera con la data dentro, con lo stesso tipo. Se è solo un conteggio detto per provare il microfono, non scrivere niente. Rispondi SOLO con un JSON così: {"voci":[...]}.\n${regoleVoci(contesto)}`))]);
    } catch { /* restano le voci di prima */ }
    try {
      const senza = cifreSenzaDato(voci);
      if (senza.length) voci = pulisciVoci([...voci, ...await conRiprova(() => chiediVoci(`Ecco la trascrizione di un incontro:\n\n${testo}\n\nEcco le voci già estratte:\n${JSON.stringify(voci)}\n\nQueste cifre compaiono nelle decisioni ma in nessuna voce dato: ${senza.join(' | ')}.\nScrivi SOLO una voce di tipo dato per ognuna, con il nome giusto che dica a cosa si riferisce. Rispondi SOLO con un JSON così: {"voci":[...]}.\n${regoleVoci(contesto)}`))]);
    } catch { /* restano le voci di prima */ }
    try {
      const daControllare = voci.filter((v) => ['azione', 'fatta', 'sospeso', 'pendenza'].includes(v.tipo));
      if (daControllare.length) {
        const esito = await conRiprova(async () => estraiJson(await completa(`Ecco la trascrizione di un incontro:\n\n${testo}\n\nEcco le voci estratte, numerate:\n${daControllare.map((v, i) => `${i}: [${v.tipo}, secondo ${Math.round(v.secondi)}] ${v.testo}`).join('\n')}\n\nControllale sulla trascrizione. Rispondi SOLO con un JSON così: {"fatte":[{"numero":0,"secondi":0,"frase":"..."}],"non_compiti":[{"numero":0,"frase":"..."}],"doppioni":[[0,1]]}.\n- fatte: solo le voci azione per cui più avanti chi parla dice chiaramente di averle fatte. secondi e frase: dove lo dice, copiati dalla trascrizione. Se non lo dice, l'azione non va qui.\n- non_compiti: solo le voci azione che sono una battuta o un'indicazione al volo a chi è presente mentre si registra (per esempio «parla senza urlare»). frase: copiata dalla trascrizione. Tutto il resto che qualcuno dice di dover fare è un compito vero, anche se detto di sfuggita. Nel dubbio non segnalarla.\n- doppioni: coppie di voci dello stesso tipo che dicono la stessa identica cosa. Due azioni diverse sulla stessa cosa, come spegnere e riaccendere, non sono doppioni.`)));
        const nelTesto = (f) => { const x = norma(f).slice(0, 30); return x && norma(testo).includes(x); };
        const via = new Set();
        for (const x of Array.isArray(esito.fatte) ? esito.fatte : []) { const v = daControllare[Number(x.numero)]; if (v?.tipo === 'azione' && Number(x.secondi) > v.secondi && nelTesto(x.frase)) via.add(v); }
        for (const x of Array.isArray(esito.non_compiti) ? esito.non_compiti : []) { const v = daControllare[Number(x.numero)]; if (v?.tipo === 'azione' && nelTesto(x.frase)) via.add(v); }
        for (const c of Array.isArray(esito.doppioni) ? esito.doppioni : []) { const [p, s] = [daControllare[Number(c?.[0])], daControllare[Number(c?.[1])]]; if (p && s && p !== s && p.tipo === s.tipo) via.add(p.testo.length >= s.testo.length ? s : p); }
        voci = voci.filter((v) => !via.has(v));
      }
    } catch { /* restano le voci di prima */ }
    voci = cifreFinali(unisciVoci(voci));
    // In breve si scrive per ultimo, dalle voci rimaste.
    let breve = {};
    try {
      breve = await conRiprova(async () => estraiJson(await completa(`Ecco le voci di lavoro di un incontro:\n${JSON.stringify(voci.map(({ tipo, argomento, testo: t }) => ({ tipo, argomento, testo: t })))}\n\nRispondi SOLO con un JSON così: {"titolo":"...","tipo":"...","in_breve":"..."}.\n- titolo: massimo 8 parole. tipo: colloquio, sopralluogo, riunione, telefonata o altro.\n- in_breve: due o tre frasi, solo da queste voci: di cosa si è parlato e a che punto è. Una cosa con una firma, un invio o una conferma ancora da fare non è conclusa.\n- ${lingua(contesto)}, niente commenti e niente emoji.`)));
    } catch { /* senza In breve la nota vale lo stesso */ }
    const pulisci = (t, n) => nomiGiusti(t).replace(/\s+/g, ' ').trim().slice(0, n);
    return { titolo: pulisci(breve.titolo, 120), tipo: pulisci(breve.tipo, 40), sezioni: sezioniDaVoci(voci, breve.in_breve) };
  }

  async function titoloBreve(segmenti) {
    if (finta) return 'Idea di prova';
    const d = estraiJson(await completa(`Ecco una nota vocale:\n\n${conTempi(segmenti).slice(0, 20000)}\n\nRispondi SOLO con un JSON così: {"titolo":"..."}: massimo 6 parole in italiano, dice di cosa parla. Non inventare niente.`));
    return nomiGiusti(d.titolo).replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  // Il metodo delle note: Gemini ascolta l'audio e scrive direttamente chi dice cosa 
  //. Un pezzo alla volta, al massimo 10 minuti: lo spezza note.js. Se fallisce, note.js usa Whisper.
  async function trascriviParlato(fileAudio, contesto = {}, durata = 0) {
    if (finta) return [{ inizio: 0, fine: 4, chi: 'Persona 1', testo: 'Benvenuti in questo tutorial di DiGiRec.' }, { inizio: 4, fine: 9, chi: 'Persona 2', testo: 'Hoy vemos cómo instalar el programa.', traduzione: 'Oggi vediamo come installare il programma.' }, { inizio: 9, fine: 12, chi: 'Persona 1', testo: 'Poi passiamo alle opzioni.' }];
    if (!env.GEMINI_API_KEY) throw new Error('Gemini non configurato.');
    const prompt = `Trascrivi parola per parola questa registrazione, senza riassumere e senza correggere. Ogni frase si scrive nella lingua in cui è detta, senza tradurla. Se una frase non è in italiano, in "traduzione" metti la sua traduzione italiana; se è in italiano, lascia "traduzione" vuoto. Ogni volta che cambia chi parla, inizia una riga nuova. Rispondi SOLO con JSON: {"frasi":[{"inizio":0,"chi":"Io","testo":"...","traduzione":""}]}. "inizio" è il secondo in cui inizia la frase${durata ? `: la registrazione dura ${Math.round(durata)} secondi, nessun orario può superarli` : ''}.
Chi registra è di solito la voce più vicina al microfono: quando parla scrivi "Io". Gli altri: se dicono il proprio nome o vengono chiamati per nome usa il nome, altrimenti Persona 2, Persona 3. La stessa persona ha sempre lo stesso nome.
Nomi da scrivere esatti: ${[NOMI_PROPRI, ...lista(contesto.glossario), ...lista(contesto.voci)].join(', ')}.
Non inventare: se una parola non si capisce scrivi [incomprensibile].`;
    const dati = (await fs.readFile(fileAudio)).toString('base64');
    const r = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL || MODELLI.gemini)}:generateContent`, null, { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/ogg', data: dati } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { frasi: { type: 'ARRAY', items: { type: 'OBJECT', properties: { inizio: { type: 'NUMBER' }, chi: { type: 'STRING' }, testo: { type: 'STRING' }, traduzione: { type: 'STRING' } }, required: ['inizio', 'chi', 'testo'] } } }, required: ['frasi'] }, temperature: 0 } }, { 'x-goog-api-key': env.GEMINI_API_KEY }, 300000);
    const d = estraiJson(r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '');
    if (!Array.isArray(d.frasi)) throw new Error('Gemini non ha dato le frasi.');
    const secondi = (v) => (typeof v === 'string' && v.includes(':') ? v.split(':').reduce((a, x) => a * 60 + Number(x), 0) : Number(v)) || 0;
    const frasi = d.frasi.map((f) => ({ inizio: Math.max(0, secondi(f.inizio)), chi: String(f.chi ?? '').trim().slice(0, 60) || 'Voce', testo: nomiGiusti(f.testo).replace(/\s+/g, ' ').trim(), ...(String(f.traduzione ?? '').trim() ? { traduzione: nomiGiusti(f.traduzione).replace(/\s+/g, ' ').trim() } : {}) })).filter((f) => f.testo).sort((a, b) => a.inizio - b.inizio);
    // Provato: a volte gli orari vanno oltre la fine. Si riportano in proporzione, così la riga porta vicino al punto giusto.
    const ultimo = frasi.at(-1)?.inizio ?? 0;
    // Provato su 10 minuti: Gemini può fermarsi molto prima della fine senza dirlo. Meglio il testo intero di Whisper.
    if (durata > 120 && ultimo < durata * 0.6) throw new Error(`Gemini si è fermato a ${Math.round(ultimo)} s su ${Math.round(durata)}.`);
    const scala = durata && ultimo >= durata ? (durata * 0.98) / ultimo : 1;
    const giusti = frasi.map((f) => ({ ...f, inizio: f.inizio * scala }));
    return giusti.map((f, i) => ({ ...f, fine: giusti[i + 1]?.inizio ?? (durata || f.inizio) }));
  }

  // Chi parla, solo se Whisper ha fatto il testo: lo fa Gemini ascoltando l'audio. Oltre i 18 MB (circa 100 minuti) non si manda in linea e il testo resta senza nomi.
  async function chiParla(fileAudio, segmenti, contesto = {}) {
    if (finta) return segmenti.map((s, i) => ({ ...s, chi: i % 2 ? 'Persona 2' : 'Persona 1' }));
    if (!env.GEMINI_API_KEY) return segmenti;
    const { size } = await fs.stat(fileAudio);
    if (size > 18 * 1024 * 1024) return segmenti;
    const elenco = segmenti.map((s, i) => `${i}|${Math.round(s.inizio)}|${s.testo}`).join('\n');
    const prompt = `Ascolta questa registrazione e dimmi chi dice ogni frase. Le frasi sono: numero|secondo|testo.\n\n${elenco}\n\nRispondi SOLO con un JSON così: {"voci":[{"i":0,"chi":"Persona 1"}]}, una voce per ogni frase. Usa «Persona 1», «Persona 2» eccetera; se qualcuno dice il proprio nome o viene chiamato per nome, usa il nome. La stessa persona ha sempre lo stesso nome.${lista(contesto.voci).length ? ` Nomi che compaiono spesso, da scrivere così: ${lista(contesto.voci).join(', ')}.` : ''}`;
    const dati = (await fs.readFile(fileAudio)).toString('base64');
    const r = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL || MODELLI.gemini)}:generateContent`, null, { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/ogg', data: dati } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }, { 'x-goog-api-key': env.GEMINI_API_KEY }, 300000);
    // Gemini a volte manda direttamente l'elenco, senza {"voci": ...}: vanno bene tutti e due.
    const grezzo = String(r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const d = JSON.parse(grezzo);
    const voci = new Map((Array.isArray(d) ? d : Array.isArray(d.voci) ? d.voci : []).map((v) => [Number(v.i), String(v.chi ?? '').trim().slice(0, 60)]));
    return segmenti.map((s, i) => ({ ...s, chi: voci.get(i) || s.chi }));
  }

  async function rispondi(domanda, contesto) {
    if (finta) return { risposta: 'CHF 300.', fonti: [{ nota: 1, secondi: 4 }] };
    const d = estraiJson(await completa(`Sei un assistente. Rispondi alla domanda usando SOLO queste note. Tra parentesi quadre c'è il secondo della registrazione.\n\n${contesto.slice(0, 200000)}\n\nDomanda: ${domanda}\n\nRispondi SOLO con un JSON così: {"risposta":"...","fonti":[{"nota":1,"secondi":0}]}. Se la risposta non c'è, dillo e non inventare. Italiano, frasi brevi.`));
    return { risposta: String(d.risposta ?? '').trim().slice(0, 4000), fonti: Array.isArray(d.fonti) ? d.fonti : [] };
  }

  return { trascrizioneDisponibile, testoDisponibile, disponibile: trascrizioneDisponibile && testoDisponibile, trascrivi, capitoliEDescrizione, riassumiAppuntamento, titoloBreve, trascriviParlato, chiParla, rispondi, fornitori: fornitori.map((f) => f.nome) };
}
