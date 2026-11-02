// Service worker: rende l'app installabile come app vera (WebAPK) invece che come scorciatoia (ricetta
// pwa-icona-samsung.md) e disegna le notifiche, anche con l'app chiusa. Nessuna cache: l'app arriva sempre dal server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  // Un messaggio rotto dà un avviso generico: il telefono si è già svegliato, tacere sarebbe peggio.
  let d = { titolo: 'DiGiShare', testo: '', url: '/' };
  try { d = { ...d, ...e.data.json() }; } catch { /* resta quello generico */ }
  // Niente tag: una notifica per ogni elemento pronto, la seconda non cancella la prima.
  e.waitUntil(self.registration.showNotification(d.titolo, {
    body: d.testo,
    icon: '/notifica-icona.png',
    // Nella barra di stato Android tiene solo la trasparenza: serve una sagoma bianca, non l'icona a colori.
    badge: '/notifica-badge.png',
    data: { url: d.url || '/' },
  }));
});

// Il tocco apre proprio quell'elemento: se l'app è già aperta la porta lì, altrimenti apre una finestra.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dove = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    for (const c of await clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      try {
        const finestra = await c.navigate(dove);
        return await (finestra ?? c).focus();
      } catch { /* questa finestra non si lascia spostare: si prova con la prossima */ }
    }
    return clients.openWindow(dove);
  })());
});
