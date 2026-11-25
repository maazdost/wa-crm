// Lets phones and computers install TeamInbox Pro as an app ("Add to Home screen") and shows its notifications.
// Nothing is kept offline: every request still goes to the server, so people always see the latest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// A notification sent by the server: a new message, a new chat or a call.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'TeamInbox Pro', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'TeamInbox Pro', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: d.conversationId ? 'chat-' + d.conversationId : undefined, renotify: !!d.conversationId, data: { conversationId: d.conversationId || null }
  }));
});
// Tapping it opens the app on that chat.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.conversationId;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => 'focus' in c);
    if (open) { await open.focus(); if (id) open.postMessage({ openChat: Number(id) }); return; }
    await self.clients.openWindow(id ? '/?chat=' + Number(id) : '/');
  })());
});
