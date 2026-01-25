// Firebase Cloud Messaging Service Worker for Upkeep (standalone)
// Note: When embedded in home app, the home app's service worker handles notifications.
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  authDomain: "upkeep.kirkl.in",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
});

const messaging = firebase.messaging();
const DEBUG = false;

// Handle background messages (data-only messages from Cloud Function)
messaging.onBackgroundMessage((payload) => {
  if (DEBUG) console.log('[firebase-messaging-sw.js] Background message received:', payload);

  const data = payload.data || {};
  const notificationOptions = {
    body: data.body || 'A task needs your attention',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: 'upkeep-daily-reminder',
    data: { ...data, notificationType: 'upkeep' },
  };

  return self.registration.showNotification(
    data.title || 'Upkeep Task Due',
    notificationOptions
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  if (DEBUG) console.log('[firebase-messaging-sw.js] Notification clicked:', event);
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise, open a new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
