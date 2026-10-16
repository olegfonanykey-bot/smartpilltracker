const CACHE_NAME = 'smart-pill-tracker-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, data } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: tag || 'pill-reminder',
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200],
        data: data || {},
        actions: [
          { action: 'taken', title: '✅ Випито' },
          { action: 'snooze', title: '⏰ +15 хв' }
        ]
      })
    );
  }
  if (event.data?.type === 'CHECK_DUE_MEDS') {
    event.waitUntil(checkAndNotifyDueMeds(event.data.meds || []));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action;
  const data = event.notification.data || {};

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_ACTION', action, medId: data.medId });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./index.html').then((client) => {
          if (client) {
            setTimeout(() => {
              client.postMessage({ type: 'NOTIFICATION_ACTION', action, medId: data.medId });
            }, 800);
          }
        });
      }
    })
  );
});

async function checkAndNotifyDueMeds(meds) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  for (const med of meds) {
    if (med.takenToday) continue;
    let targetMinutes;
    if (med.snoozeUntil) {
      const snooze = new Date(med.snoozeUntil);
      if (snooze > now) continue;
      targetMinutes = snooze.getHours() * 60 + snooze.getMinutes();
    } else {
      const [h, m] = med.time.split(':').map(Number);
      targetMinutes = h * 60 + m;
    }
    const diff = currentMinutes - targetMinutes;
    if (diff >= 0 && diff <= 2) {
      await self.registration.showNotification(`💊 Час прийняти: ${med.name}`, {
        body: `${med.ruleLabel || med.rule} • ${med.time}`,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: `pill-${med.id}`,
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        data: { medId: med.id },
        actions: [
          { action: 'taken', title: '✅ Випито' },
          { action: 'snooze', title: '⏰ +15 хв' }
        ]
      });
    }
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-meds') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'REQUEST_MEDS_CHECK' }));
      })
    );
  }
});
