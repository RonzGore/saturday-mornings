// Turnstile, Cloudflare's "is this a person?" check, for forms anyone can
// submit. It only switches on when the server hands out a site key
// (GET /api/config). "interaction-only": most people never see it; the box
// appears only when Cloudflare isn't sure.
//   Human.attach(el)      put a widget in this element
//   await Human.token(el) the token to send with the form (undefined when off)
//   Human.used(el)        tokens are single-use: get a fresh one for next time
window.Human = (() => {
  const widgets = new Map();
  let ready = null;
  function load() {
    if (ready) return ready;
    ready = fetch("/api/config").then((r) => r.json()).then((c) => {
      if (!c.turnstile) return null;
      return new Promise((resolve) => {
        window.__humanLoaded = () => resolve(c.turnstile);
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__humanLoaded";
        s.async = true;
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }).catch(() => null);
    return ready;
  }
  async function attach(el) {
    const key = await load();
    if (!key || !el || widgets.has(el)) return;
    const w = { id: null, token: null, waiting: [] };
    w.id = window.turnstile.render(el, {
      sitekey: key, size: "flexible", appearance: "interaction-only", "refresh-expired": "auto",
      callback: (t) => { w.token = t; w.waiting.splice(0).forEach((f) => f(t)); },
      "expired-callback": () => { w.token = null; },
      "error-callback": () => { w.token = null; },
    });
    widgets.set(el, w);
  }
  async function token(el) {
    const key = await load();
    const w = widgets.get(el);
    if (!key || !w) return undefined;
    if (w.token) return w.token;
    return Promise.race([new Promise((r) => w.waiting.push(r)), new Promise((r) => setTimeout(() => r(undefined), 15000))]);
  }
  function used(el) {
    const w = widgets.get(el);
    if (!w) return;
    w.token = null;
    try { window.turnstile.reset(w.id); } catch (e) {}
  }
  return { attach, token, used };
})();
