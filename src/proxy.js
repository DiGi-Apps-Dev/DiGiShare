import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const normalize = value => String(value || '').replace(/^::ffff:/, '');

// Riconosce il proxy (nginx) dal suo nome nella rete Docker. La fiducia scade
// anche se una risoluzione DNS resta bloccata.
export function createProxyTrust({ hostname, lookup = dnsLookup, refreshMs = 10000, timeoutMs = 2000, now = Date.now, onWarning = message => console.warn(message) }) {
  let addresses = new Set();
  let validUntil = 0;
  let pending = null;
  let closed = false;
  let warned = false;
  function refresh() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      let timeout;
      try {
        const records = await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs); })
        ]);
        if (closed) return;
        const resolved = records.map(record => normalize(record.address)).filter(address => isIP(address));
        if (!resolved.length) throw new Error('No proxy address');
        addresses = new Set(resolved);
        validUntil = now() + refreshMs;
        warned = false;
      } catch {
        addresses.clear();
        validUntil = 0;
        if (!closed && !warned) onWarning('DiGiShare: proxy non risolto; intestazioni inoltrate non fidate. Nuovo tentativo automatico.');
        warned = true;
      } finally { clearTimeout(timeout); }
    })().finally(() => { pending = null; });
    return pending;
  }
  const ready = refresh();
  const timer = setInterval(refresh, Math.max(1, Math.floor(refreshMs / 2)));
  timer.unref();
  return {
    ready, refresh,
    has: address => !closed && now() < validUntil && addresses.has(normalize(address)),
    close() { closed = true; clearInterval(timer); addresses.clear(); }
  };
}
