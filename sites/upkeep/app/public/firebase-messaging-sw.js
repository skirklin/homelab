// Firebase Messaging Service Worker
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  authDomain: "upkeep.kirkl.in",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
});

const messaging = firebase.messaging();

// Handle background messages (data-only messages from Cloud Function)
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message:', payload);

  // Read from data payload (not notification payload to avoid duplicates)
  const notificationTitle = payload.data?.title || 'Upkeep Task Due';
  const notificationOptions = {
    body: payload.data?.body || 'A task needs your attention',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: 'upkeep-daily-reminder', // Use consistent tag to prevent duplicate notifications
    data: payload.data,
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  console.log('[firebase-messaging-sw.js] Notification clicked:', event);
  event.notification.close();

  // Open the app when notification is clicked
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes('upkeep') && 'focus' in client) {
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
