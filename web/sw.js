// raffaello chat — Service Worker with Web Push
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", (e) => {
  let data = { title: "raffaello", body: "新消息" };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || "raffaello", {
      body: data.body || "",
      icon: "/raffaello/chat/icons/icon-192.png",
      badge: "/raffaello/chat/icons/icon-192.png",
      tag: "raffaello-msg",
      renotify: true,
      data: { url: data.url || "/raffaello/chat/" }
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/raffaello/chat/";
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then(clients => {
      for (const c of clients) {
        if (c.url.includes("/raffaello/chat") && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", () => {});
