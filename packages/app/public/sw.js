/* Awalé service worker — push notifications for async play.
   Scaffold: active once the app registers it (src/lib/push.ts) and VAPID keys
   are configured. Payload: { title, body, url }. */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    /* non-JSON payload */
  }
  const title = data.title || "Awalé";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Your turn to play.",
      icon: "/assets/seed.png",
      badge: "/assets/seed.png",
      data: { url: data.url || "/" },
      tag: data.tag || "awale-turn",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
