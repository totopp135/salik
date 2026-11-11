// Minimal service worker: always loads the latest version from the server,
// so updates appear immediately. Needed for Android to install the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
