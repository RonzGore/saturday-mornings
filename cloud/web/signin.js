// Parent sign-in: passkey first, email code as the fallback / first time.
(() => {
  const $ = (id) => document.getElementById(id);
  const WA = window.SimpleWebAuthnBrowser;
  const canPasskey = !!(window.PublicKeyCredential && WA);
  const next = new URLSearchParams(location.search).get("next");
  // Only ever return to a page inside the dashboard.
  const dest = next && /^\/app\/[\w\-\/#.?=&%]*$/.test(next) ? next : "/app/";
  let email = "";
  if (new URLSearchParams(location.search).has("deleted")) $("deleted").hidden = false;

  const steps = ["step-start", "step-code", "step-waitlist", "step-passkey", "step-signed-in"];
  function show(id) { steps.forEach((s) => { $(s).hidden = s !== id; }); setError(""); }
  function setError(msg) { $("error").hidden = !msg; $("error").textContent = msg || ""; }

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  function done(result) {
    if (canPasskey && !result.passkeys) show("step-passkey");
    else location.href = dest;
  }

  // Passkey sign-in
  if (canPasskey) { $("passkey-btn").hidden = false; $("or").hidden = false; }
  $("passkey-btn").onclick = async () => {
    try {
      const { options, challengeId } = await post("/api/auth/passkey/login/options");
      const response = await WA.startAuthentication({ optionsJSON: options });
      await post("/api/auth/passkey/login/verify", { challengeId, response });
      location.href = dest;
    } catch (e) {
      if (e.name === "NotAllowedError") return; // cancelled
      setError(e.message);
    }
  };

  // Email code
  // Turnstile on the email form (only when switched on; see human.js)
  window.Human.attach($("human"));

  async function sendCode() {
    const btn = $("email-btn");
    btn.disabled = true;
    try {
      const start = async () => {
        const turnstile = await window.Human.token($("human"));
        return post("/api/auth/email/start", { email, turnstile }).finally(() => window.Human.used($("human")));
      };
      // Turnstile sometimes says no on a first try; ask once more, quietly.
      const r = await start().catch((e) => /person/.test(e.message) ? start() : Promise.reject(e));
      // Early access: not approved yet, so they're on the waiting list instead.
      if (r.waitlisted) { $("waitlist-email").textContent = email; show("step-waitlist"); btn.disabled = false; return; }
      $("sent-to").textContent = email;
      $("dev").hidden = !r.devCode;
      if (r.devCode) $("dev").textContent = "Local test mode: your code is " + r.devCode;
      show("step-code");
      $("code").value = "";
      $("code").focus();
    } catch (e) { setError(e.message); }
    btn.disabled = false;
  }
  $("email-form").onsubmit = (e) => { e.preventDefault(); email = $("email").value.trim(); sendCode(); };
  $("resend").onclick = (e) => { e.preventDefault(); sendCode(); };
  $("change").onclick = (e) => { e.preventDefault(); show("step-start"); };
  $("waitlist-back").onclick = (e) => { e.preventDefault(); show("step-start"); };
  $("code-form").onsubmit = async (e) => {
    e.preventDefault();
    try { done(await post("/api/auth/email/verify", { email, code: $("code").value })); }
    catch (err) { setError(err.message); }
  };

  // Offer a passkey after the first email sign-in
  $("add-passkey").onclick = async () => {
    try {
      const { options, challengeId } = await post("/api/auth/passkey/register/options");
      const response = await WA.startRegistration({ optionsJSON: options });
      await post("/api/auth/passkey/register/verify", { challengeId, response, label: navigator.platform || "Passkey" });
      location.href = dest;
    } catch (e) {
      if (e.name === "NotAllowedError") return;
      setError(e.message);
    }
  };
  $("skip-passkey").onclick = () => { location.href = dest; };

  $("signout").onclick = async () => { await post("/api/auth/signout"); show("step-start"); };

  // Already signed in?
  fetch("/api/me").then((r) => r.json()).then((m) => {
    if (m.signedIn) {
      if (next) { location.href = dest; return; }
      $("signed-in-as").textContent = "as " + m.email;
      show("step-signed-in");
    }
  }).catch(() => {});
})();
