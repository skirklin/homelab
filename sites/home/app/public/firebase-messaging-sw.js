// Firebase Cloud Messaging Service Worker for Home App
// Handles notifications for all embedded apps: Life Tracker, Upkeep, etc.
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

const DEBUG = false;

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  if (DEBUG) console.log('[firebase-messaging-sw.js] Background message received:', payload);

  const data = payload.data || {};

  // Upkeep notifications
  if (data.type === 'household_task_due') {
    const notificationOptions = {
      body: data.body || 'You have tasks that need attention',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { ...data, notificationType: 'upkeep' },
      tag: 'upkeep-tasks',
    };
    return self.registration.showNotification(
      data.title || 'Household Tasks',
      notificationOptions
    );
  }

  // Life tracker notifications
  if (data.type === 'life_tracker_sample') {
    // Build actions - use quick rating buttons if available
    let actions;
    if (data.quickRatingId && data.quickRatingMax) {
      const max = parseInt(data.quickRatingMax, 10);
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
      body: data.body || 'Time for a quick check-in!',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { ...data, notificationType: 'life' },
      requireInteraction: true,
      actions,
    };
    return self.registration.showNotification(
      data.title || 'Life Tracker',
      notificationOptions
    );
  }

  // Default notification (legacy format)
  const notificationTitle = payload.notification?.title || 'Notification';
  const notificationOptions = {
    body: payload.notification?.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { ...data, notificationType: 'unknown' },
  };
  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  if (DEBUG) console.log('[firebase-messaging-sw.js] Notification clicked:', event);
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const notificationType = event.notification.data?.notificationType;
  let urlToOpen;
  let messageData = null;

  // Handle quick rating action from life tracker (format: "rating:questionId:value")
  if (event.action && event.action.startsWith('rating:')) {
    const [, questionId, value] = event.action.split(':');
    urlToOpen = new URL(`/life?quickResponse=${questionId}:${value}`, self.location.origin).href;
    messageData = { type: 'QUICK_RESPONSE', questionId, value: parseInt(value, 10) };
  }
  // Upkeep notification
  else if (notificationType === 'upkeep') {
    urlToOpen = new URL('/upkeep', self.location.origin).href;
  }
  // Life tracker notification (default respond action)
  else if (notificationType === 'life') {
    urlToOpen = new URL('/life?sample=true', self.location.origin).href;
    messageData = { type: 'SAMPLE_REQUESTED' };
  }
  // Default
  else {
    urlToOpen = new URL('/', self.location.origin).href;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, navigate to correct page, then focus
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // Navigate to the target URL so the right app page loads
          if ('navigate' in client) {
            return client.navigate(urlToOpen).then((c) => {
              if (messageData && c) {
                c.postMessage(messageData);
              }
              return c ? c.focus() : undefined;
            });
          }
          if (messageData) {
            client.postMessage(messageData);
          }
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
