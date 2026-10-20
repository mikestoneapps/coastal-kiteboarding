// Service worker for push alerts only. No fetch handler and no cache, so it never serves a stale page:
// GitHub Pages keeps deploying index.html exactly as before. See alerts/ for what sends the pushes.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// A push with no payload, or one we can't read, still shows a notification: Safari drops the subscription of an app that
// receives pushes without showing anything, so the generic line below is better than silence.
const TITLE = "Bistué Boarding", GENERIC = "Bistué Boarding: open the app for today's outlook";
function parsePush(data) {
  if (!data) return {};
  try { const d = data.json(); return d && typeof d === "object" ? d : { body: String(d) }; }
  catch (_) { try { const t = data.text(); return t ? { body: t } : {}; } catch (__) { return {}; } }
}
self.addEventListener("push", e => {
  const d = parsePush(e.data);
  let url; try { url = new URL(d.url || "./", self.registration.scope).href; } catch (_) { url = self.registration.scope; }
  e.waitUntil(self.registration.showNotification(d.title || TITLE, {
    body: d.body || GENERIC, icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || "bb", renotify: true, data: { url }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const c = list.find(w => w.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ type: "open", url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
