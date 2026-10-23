// Web Push, on the Worker's own WebCrypto: no outside service, no library.
// Each message is encrypted for one browser (RFC 8291, "aes128gcm") and the
// request is signed with our VAPID key (RFC 8292), so the phone's push service
// (Apple, Google, Mozilla) delivers it without ever reading it.
//
// The one secret, VAPID_PRIVATE_JWK, is an ECDSA P-256 private key as JSON
// (make one with `node scripts/vapid.mjs`). The public half is derived from it.
import { b64url, fromB64url } from "./util.js";

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// The VAPID key pair from the secret; the public key in the raw 65-byte form
// browsers want as applicationServerKey.
let cached = null;
export async function vapid(env) {
  if (!env.VAPID_PRIVATE_JWK) return null;
  if (cached && cached.src === env.VAPID_PRIVATE_JWK) return cached;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const publicRaw = concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
  cached = { src: env.VAPID_PRIVATE_JWK, key, publicKey: b64url(publicRaw) };
  return cached;
}

// "vapid t=<JWT>, k=<public key>" for one push service.
async function vapidHeader(env, endpoint) {
  const v = await vapid(env);
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || (env.REPLY_TO ? `mailto:${env.REPLY_TO}` : "mailto:admin@example.com"),
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${v.publicKey}`;
}

// RFC 8291: encrypt `payload` (bytes) for a subscription's p256dh and auth keys.
export async function encrypt(sub, payload) {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

// Sends one notification. Returns the push service's status: 201 is delivered
// to the service; 404/410 mean the browser has unsubscribed.
export async function send(env, sub, message, { ttl = 3600, urgency = "normal", topic } = {}) {
  const body = await encrypt(sub, enc.encode(JSON.stringify(message)));
  const headers = {
    authorization: await vapidHeader(env, sub.endpoint),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttl),
    urgency,
  };
  if (topic) headers.topic = topic; // a newer message with the same topic replaces an undelivered one
  const r = await fetch(sub.endpoint, { method: "POST", headers, body });
  if (r.status >= 400 && r.status !== 404 && r.status !== 410) console.error("push failed", r.status, (await r.text()).slice(0, 200));
  return r.status;
}
