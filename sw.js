const CACHE_NAME = 'smart-pill-tracker-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

// Встановлення
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Активація
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Кеш
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// Повідомлення від додатку
self.addEventListener('message', (event) => {
  if (!event.data) return;

  // Показати сповіщення
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, data } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: tag || 'pill-reminder',
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        data: data || {},
        actions: [
          { action: 'taken', title: '✅ Випито' },
          { action: 'snooze', title: '⏰ +15 хв' }
        ]
      })
    );
  }

  // Перевірка ліків
  if (event.data.type === 'CHECK_DUE_MEDS') {
    event.waitUntil(checkAndNotifyDueMeds(event.data.meds || []));
  }

  // Примусова перевірка
  if (event.data.type === 'FORCE_CHECK') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'REQUEST_MEDS_CHECK' }));
      })
    );
  }
});

// Клік по сповіщенню
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action;
  const data = event.notification.data || {};

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'NOTIFICATION_ACTION',
            action,
            medId: data.medId
          });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./index.html').then((client) => {
          if (client) {
            setTimeout(() => {
              client.postMessage({
                type: 'NOTIFICATION_ACTION',
                action,
                medId: data.medId
              });
            }, 1000);
          }
        });
      }
    })
  );
});

// Перевірка протермінованих ліків
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

    // Показуємо, якщо час настав або пройшло до 3 хвилин
    if (diff >= 0 && diff <= 3) {
      await self.registration.showNotification(`💊 Час прийняти: ${med.name}`, {
        body: `${med.ruleLabel || med.rule} • ${med.time}`,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: `pill-${med.id}`,
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        data: { medId: med.id },
        actions: [
          { action: 'taken', title: '✅ Випито' },
          { action: 'snooze', title: '⏰ +15 хв' }
        ]
      });
    }
  }
}

// Periodic Background Sync (важливо для Android)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-meds') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'REQUEST_MEDS_CHECK' });
        });
      })
    );
  }
});

// Синхронізація
self.addEventListener('sync', (event) => {
  if (event.tag === 'check-meds-sync') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'REQUEST_MEDS_CHECK' }));
      })
    );
  }
});
