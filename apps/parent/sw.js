// Saturday Mornings: service worker for the installed parent app (/app/).
// Keeps the app shell on the phone so it opens instantly and still shows
// something without a connection. Network first, so a new version always
// arrives when online; the cache is only the fallback. Family data (/api/…)
// is never cached: it always comes fresh from the server.
const CACHE = "sm-app-v6";
const SHELL = [
  "./", "setup.css", "setup.js", "manifest.json",
  "fonts/fonts.css", "fonts/ibm-plex-sans.woff2", "fonts/oswald.woff2", "fonts/vt323.woff2",
  "../js/schedule.js", "../js/webauthn.js", "../assets/logo.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const nav = e.request.mode === "navigate";
  const cached = () => caches.match(nav ? "./" : e.request, { ignoreSearch: true });
  e.respondWith(
    fetch(e.request)
      .then(async (res) => {
        if (res.ok && (SHELL_PATHS.has(url.pathname) || nav)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(nav ? "./" : e.request, copy));
        }
        // A server hiccup: open the copy on the phone rather than an error page.
        if (res.status >= 500) return (await cached()) || res;
        return res;
      })
      .catch(async () => (await cached()) || Response.error())
  );
});

const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));

// ---------- Notifications ----------
// The server sends { title, body, tag, url, actions, more } (see cloud/src/push.js).
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(m.title || "Saturday Mornings", {
    body: m.body || "",
    icon: "icon-192.png",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    actions: Array.isArray(m.actions) ? m.actions.slice(0, 2) : [],
    data: { url: m.url || "./", more: m.more || null },
  }));
});

const clock = (hm) => {
  const [h, min] = String(hm || "").split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  // "+10 min" right from the notification (where the phone shows buttons).
  if (e.action === "more" && d.more) {
    e.waitUntil(fetch("/api/more-time", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(d.more),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return self.registration.showNotification(r.ok ? `+10 minutes on ${j.kid} TV` : "Couldn't add the time", {
        body: r.ok ? `It stays on until ${clock(j.until)}.` : (j.error || "Open Saturday Mornings to try again."),
        icon: "icon-192.png", tag: "more-time",
      });
    }).catch(() => {}));
    return;
  }
  const target = new URL(d.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) {
        if ("navigate" in c) c.navigate(target).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
