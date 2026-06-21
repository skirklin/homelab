/**
 * Web Push service worker — GENERATED, DO NOT EDIT BY HAND.
 *
 * Source of truth: packages/backend/src/notification-types.ts
 * Regenerate:      pnpm --filter @homelab/backend gen:push-sw
 *
 * The same file is written verbatim into every app that ships a push SW
 * (home / upkeep / life). The lockstep test
 * (packages/backend/src/notification-types.test.ts) fails if any checked-in
 * copy drifts from the registry.
 *
 * Routing is data-driven from ROUTING below: each `data.type` maps to its
 * notification options (tag / requireInteraction / quick-rating actions) and a
 * click destination. A type that isn't in ROUTING (or a payload with no type)
 * falls back to the generic `data.url` deep link — same as a registered
 * { click: "url" } type — so an un-registered sender degrades gracefully
 * instead of crashing.
 */

const ROUTING = {
  "household_task_due": {
    "tag": "upkeep-tasks",
    "click": {
      "kind": "fixed",
      "path": "/upkeep"
    }
  },
  "task_attention": {
    "click": {
      "kind": "url"
    }
  },
  "life_tracker_sample": {
    "requireInteraction": true,
    "quickRatingActions": true,
    "click": {
      "kind": "sample",
      "path": "/life?sample=true"
    }
  },
  "life_reminder": {
    "tag": "life-reminder",
    "click": {
      "kind": "url"
    }
  },
  "travel_morning": {
    "click": {
      "kind": "url"
    }
  },
  "travel_evening": {
    "click": {
      "kind": "url"
    }
  }
};

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  const title = data.title || "Notification";
  const route = ROUTING[data.type];
  const options = {
    body: data.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: data,
  };

  if (route) {
    if (route.tag) options.tag = route.tag;
    if (route.requireInteraction) options.requireInteraction = true;
    if (route.quickRatingActions) {
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
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") {
    return;
  }

  const data = event.notification.data || {};
  const route = ROUTING[data.type];
  let urlToOpen;
  let messageData = null;

  // Quick rating action from the life sampler (format: "rating:trackableId:value").
  // Independent of the type's click config — any type that rendered rating
  // actions routes the tapped button the same way.
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
  // Registered click destination.
  else if (route && route.click && route.click.kind === "fixed") {
    urlToOpen = new URL(route.click.path, self.location.origin).href;
  }
  else if (route && route.click && route.click.kind === "sample") {
    urlToOpen = new URL(route.click.path, self.location.origin).href;
    messageData = { type: "SAMPLE_REQUESTED" };
  }
  // Default (registered { click: "url" } types AND unregistered/typeless
  // payloads): resolve the deep link the sender passed in `data.url` against
  // THIS SW's origin so a (now relative) link always opens on the origin the
  // user is signed in on — PocketBase auth is per-origin, so an absolute
  // cross-origin URL would cold-load an empty session (presents as sign-out).
  else if (data.url) {
    urlToOpen = new URL(data.url, self.location.origin).href;
  }
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
