// Small helpers shared by the Worker modules.

export const now = () => Date.now();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

export const error = (status, message, extra = {}) => json({ error: message, ...extra }, status);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readJson(request, limit = 3_000_000) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "too large");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "bad json"); }
}

// Random ids and secrets.
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomId(len = 12, alphabet = ALNUM) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name, value, { maxAge, secure = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (secure) c += "; Secure";
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export const isSecure = (request) => new URL(request.url).protocol === "https:";

// State-changing requests from the parent site must come from this origin.
export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "forbidden");
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

// Fixed-window rate limit. Counts atomically in D1 and throws 429 once `max`
// is exceeded within `windowMs`.
export async function rateLimit(env, key, max, windowMs, message = "Too many tries. Please wait a bit and try again.") {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
     RETURNING count`
  ).bind(key, t, windowMs).first();
  if (row && row.count > max) throw new HttpError(429, message);
}

// Like rateLimit, but answers true/false instead of throwing: for budgets where
// going over means "skip this", not "refuse the request".
export async function withinLimit(env, key, max, windowMs) {
  try { await rateLimit(env, key, max, windowMs); return true; } catch (e) { if (e instanceof HttpError) return false; throw e; }
}

// Turnstile (Cloudflare's "is this a person?" check) for forms anyone can
// submit. Only enforced once both TURNSTILE_SITE_KEY (var) and
// TURNSTILE_SECRET (secret) are set. A Turnstile outage lets people through
// (the rate limits still apply) rather than locking everyone out.
export async function verifyHuman(env, token, ip) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip && ip !== "local") form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = await r.json();
    return d.success === true;
  } catch (e) {
    console.error("turnstile unreachable", e && e.message);
    return true;
  }
}

export const clientIp = (request) => request.headers.get("cf-connecting-ip") || "local";

// Read-only check of a rate-limit counter (for budgets that only count failures).
export async function overLimit(env, key, max, windowMs) {
  const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?").bind(key).first();
  return !!row && row.window_start > now() - windowMs && row.count >= max;
}
