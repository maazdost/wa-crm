// Lets phones and computers install TeamInbox Pro as an app ("Add to Home screen").
// Nothing is kept offline: every request still goes to the server, so people always see the latest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
