// Firebase Cloud Messaging Service Worker for Life Tracker
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Background message received:', payload);

  const data = payload.data || {};
  const notificationTitle = data.title || payload.notification?.title || 'Life Tracker';
  const notificationBody = data.body || payload.notification?.body || 'Time for a quick check-in!';

  // Build actions - use quick rating buttons if available, otherwise default actions
  let actions;
  if (data.quickRatingId && data.quickRatingMax) {
    const max = parseInt(data.quickRatingMax, 10);
    // Generate rating buttons (1 through max, up to 5)
    actions = [];
    for (let i = 1; i <= Math.min(max, 5); i++) {
      actions.push({ action: `rating:${data.quickRatingId}:${i}`, title: String(i) });
    }
  } else {
    actions = [
      { action: 'respond', title: 'Respond' },
      { action: 'dismiss', title: 'Later' },
    ];
  }

  const notificationOptions = {
    body: notificationBody,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: data,
    requireInteraction: true,
    actions,
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  console.log('[firebase-messaging-sw.js] Notification clicked:', event);
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  // Check if this is a quick rating action (format: "rating:questionId:value")
  let urlToOpen;
  let messageData = { type: 'SAMPLE_REQUESTED' };

  if (event.action && event.action.startsWith('rating:')) {
    const [, questionId, value] = event.action.split(':');
    // Pass quick response data to auto-submit
    urlToOpen = new URL(`/?quickResponse=${questionId}:${value}`, self.location.origin).href;
    messageData = { type: 'QUICK_RESPONSE', questionId, value: parseInt(value, 10) };
  } else {
    // Default: open with sample modal
    urlToOpen = new URL('/?sample=true', self.location.origin).href;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it and send message
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage(messageData);
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
