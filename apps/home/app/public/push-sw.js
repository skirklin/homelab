/**
 * Web Push service worker for Home App.
 * Handles push notifications for all embedded apps: Life Tracker, Upkeep, etc.
 * Replaces the old Firebase Cloud Messaging service worker.
 */

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  const title = data.title || "Notification";
  const options = {
    body: data.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: data,
  };

  // Upkeep notifications — tag to collapse duplicates
  if (data.type === "household_task_due") {
    options.tag = "upkeep-tasks";
  }

  // Life tracker notifications — support quick rating actions
  if (data.type === "life_tracker_sample") {
    options.requireInteraction = true;
    if (data.quickRatingId && data.quickRatingMax) {
      const max = parseInt(data.quickRatingMax, 10);
      options.actions = [];
      for (let i = 1; i <= Math.min(max, 5); i++) {
        options.actions.push({
          action: "rating:" + data.quickRatingId + ":" + i,
          title: String(i),
        });
      }
    } else {
      options.actions = [
        { action: "respond", title: "Respond" },
        { action: "dismiss", title: "Later" },
      ];
    }
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") {
    return;
  }

  const data = event.notification.data || {};
  let urlToOpen;
  let messageData = null;

  // Handle quick rating action from life tracker (format: "rating:questionId:value")
  if (event.action && event.action.startsWith("rating:")) {
    const parts = event.action.split(":");
    const questionId = parts[1];
    const value = parts[2];
    urlToOpen = new URL(
      "/life?quickResponse=" + questionId + ":" + value,
      self.location.origin
    ).href;
    messageData = {
      type: "QUICK_RESPONSE",
      questionId: questionId,
      value: parseInt(value, 10),
    };
  }
  // Upkeep notification
  else if (data.type === "household_task_due") {
    urlToOpen = new URL("/upkeep", self.location.origin).href;
  }
  // Life tracker notification (default respond action)
  else if (data.type === "life_tracker_sample") {
    urlToOpen = new URL("/life?sample=true", self.location.origin).href;
    messageData = { type: "SAMPLE_REQUESTED" };
  }
  // URL provided in the notification payload
  else if (data.url) {
    urlToOpen = data.url;
  }
  // Default
  else {
    urlToOpen = new URL("/", self.location.origin).href;
  }

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // If app is already open, navigate and focus
        for (const client of clientList) {
          if (
            client.url.includes(self.location.origin) &&
            "focus" in client
          ) {
            if ("navigate" in client) {
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
