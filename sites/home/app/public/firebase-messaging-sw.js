// Firebase Cloud Messaging Service Worker for Home App (Life Tracker + Upkeep)
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

  // Check if this is an upkeep notification (data-only message)
  if (payload.data?.type === 'household_task_due') {
    const notificationTitle = payload.data.title || 'Household Tasks';
    const notificationOptions = {
      body: payload.data.body || 'You have tasks that need attention',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { ...payload.data, notificationType: 'upkeep' },
      tag: 'upkeep-tasks',
    };
    return self.registration.showNotification(notificationTitle, notificationOptions);
  }

  // Default: Life tracker notification
  const notificationTitle = payload.notification?.title || 'Life Tracker';
  const notificationOptions = {
    body: payload.notification?.body || 'Time for a quick check-in!',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { ...payload.data, notificationType: 'life' },
    requireInteraction: true,
    actions: [
      { action: 'respond', title: 'Respond' },
      { action: 'dismiss', title: 'Later' },
    ],
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

  // Determine URL based on notification type
  const notificationType = event.notification.data?.notificationType;
  let urlToOpen;

  if (notificationType === 'upkeep') {
    urlToOpen = new URL('/upkeep', self.location.origin).href;
  } else {
    // Default to life tracker
    urlToOpen = new URL('/life?sample=true', self.location.origin).href;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if (notificationType === 'life') {
            client.postMessage({ type: 'SAMPLE_REQUESTED' });
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
