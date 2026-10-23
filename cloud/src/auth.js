// Parent accounts: email sign-in codes, passkeys and sessions.
import * as access from "./access.js";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { setUpNewUser, detachForDeletion } from "./family.js";
import {
  HttpError, json, now, randomId, randomToken, sha256, b64url, fromB64url,
  getCookie, cookie, isSecure, normEmail, emailOk, rateLimit, overLimit, clientIp, verifyHuman,
} from "./util.js";

const SESSION_COOKIE = "sm_session";
const SESSION_DAYS = 60;
const CODE_MINUTES = 10;

// ---------- Sessions ----------

export async function currentUser(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?"
  ).bind(await sha256(token), now()).first();
  return row || null;
}

export async function requireUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, "sign in required");
  return user;
}

async function startSession(env, request, userId, body) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), now() + SESSION_DAYS * 86400e3).run();
  return json(body, 200, { "set-cookie": cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure: isSecure(request) }) });
}

export async function signOut(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", { maxAge: 0, secure: isSecure(request) }) });
}

// Deletes the parent's account and everything tied to it: household (kids,
// channels, library) unless another parent shares it, linked TVs, passkeys, sessions, pending codes and the
// rate-limit counters keyed by their email. The parent confirms by typing
// their email address. Linked TVs lose access on their next sync.
export async function deleteAccount(env, request, user, body) {
  if (normEmail(body.confirm) !== user.email) throw new HttpError(400, "Type your email address to confirm");
  // If another parent shares the family, it stays with them.
  const hhId = await detachForDeletion(env, user);
  const db = env.DB;
  const steps = [];
  if (hhId) {
    steps.push(
      db.prepare("DELETE FROM pairings WHERE tv_id IN (SELECT id FROM tvs WHERE household_id = ?)").bind(hhId),
      db.prepare("DELETE FROM tvs WHERE household_id = ?").bind(hhId),
      db.prepare("DELETE FROM household_invites WHERE household_id = ?").bind(hhId),
      db.prepare("DELETE FROM household_members WHERE household_id = ?").bind(hhId),
      db.prepare("DELETE FROM households WHERE id = ?").bind(hhId),
    );
  }
  steps.push(
    db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM push_subs WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM challenges WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM email_codes WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM rate_limits WHERE key IN (?, ?, ?, ?)")
      .bind("send30:" + user.email, "send:" + user.email, "verify-fail:" + user.email, "link:" + user.id),
    db.prepare("DELETE FROM rate_limits WHERE key IN (?, ?, ?)").bind("invite:" + user.id, "invite-day:" + user.id, "resolve:" + user.id),
    db.prepare("DELETE FROM household_invites WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM waitlist WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM access WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  );
  await db.batch(steps);
  console.log("account deleted", user.id);
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", { maxAge: 0, secure: isSecure(request) }) });
}

async function findOrCreateUser(env, email) {
  let user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
  if (user) return user;
  if (!(await access.admitNewAccount(env, email))) throw new HttpError(403, "You're on the waiting list. We'll email you when it's your turn.");
  user = { id: randomId(16), email };
  // Every new account starts with a free month.
  await env.DB.prepare("INSERT INTO users (id, email, created_at, trial_ends_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, email, now(), now() + access.TRIAL_DAYS * 86400e3).run();
  await setUpNewUser(env, user); // their own household; invites are accepted explicitly
  return user;
}

export async function me(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ signedIn: false });
  const pk = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(user.id).first();
  // The family's free month is its owner's.
  const trial = await env.DB.prepare(
    `SELECT u.trial_ends_at AS t FROM household_members m JOIN households h ON h.id = m.household_id
     JOIN users u ON u.id = h.owner_id WHERE m.user_id = ?`
  ).bind(user.id).first();
  const av = await env.DB.prepare("SELECT avatar FROM users WHERE id = ?").bind(user.id).first();
  return json({ signedIn: true, email: user.email, passkeys: pk.n, trialEndsAt: (trial && trial.t) || null,
    admin: access.isAdmin(env, user), avatar: parseAvatar(av && av.avatar) });
}

// ---------- Profile picture ----------

const AVATAR_EMOJI = ["👩", "👨", "🧑", "👵", "👴", "🦸", "🧙", "🐻", "🦁", "🐼", "🦊", "🐸", "🌻", "⭐", "🚀", "☕"];
export const parseAvatar = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

// { kind: "photo", data: "data:image/jpeg;base64,..." } (shrunk on the phone),
// { kind: "emoji", emoji, color }, or null for initials.
export async function setAvatar(env, user, body) {
  const a = body && body.avatar;
  let v = null;
  if (a && a.kind === "photo") {
    if (typeof a.data !== "string" || a.data.length > 90000 || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(a.data)) {
      throw new HttpError(400, "That picture didn't work. Try another one.");
    }
    v = { kind: "photo", data: a.data };
  } else if (a && a.kind === "emoji") {
    if (!AVATAR_EMOJI.includes(a.emoji) || !/^#[0-9a-f]{6}$/i.test(a.color || "")) throw new HttpError(400, "Pick a picture from the list");
    v = { kind: "emoji", emoji: a.emoji, color: a.color };
  } else if (a) throw new HttpError(400, "Pick a picture");
  await env.DB.prepare("UPDATE users SET avatar = ? WHERE id = ?").bind(v ? JSON.stringify(v) : null, user.id).run();
  return json({ ok: true, avatar: v });
}

// ---------- Email codes ----------

const codeHash = (env, email, code) => sha256(`${email}:${code}:${env.CODE_PEPPER || "saturday-morning"}`);
const CODE_COOKIE = "sm_code";

// Each code is tied to the browser that asked for it (a private nonce
// cookie). Wrong guesses from anyone else land on their own rows, so they
// can't lock a parent out; brute force is capped at 5 guesses per code plus
// per-network limits.
export async function emailStart(env, request, body) {
  const email = normEmail(body.email);
  if (!emailOk(email)) throw new HttpError(400, "That doesn't look like an email address");
  const ip = clientIp(request);
  if (!(await verifyHuman(env, body.turnstile, ip))) {
    throw new HttpError(400, "We couldn't check you're a person. Please try again.");
  }
  // Per address (whatever the network) to prevent email flooding, and per
  // network on top.
  await rateLimit(env, "send30:" + email, 1, 30e3, "Please wait a few seconds before asking for another code");
  await rateLimit(env, "send:" + email, 10, 3600e3, "Too many codes requested. Try again in an hour, or sign in with a passkey.");
  await rateLimit(env, "send-ip:" + ip, 20, 3600e3, "Too many codes requested. Try again in an hour.");

  // Early access: not approved yet, so no code. They join the waiting list
  // and get a thank-you email (once).
  if (!(await access.isAllowed(env, email))) {
    await access.waitlistFromApp(env, email, (request.cf && request.cf.country) || null, ip);
    return json({ ok: true, waitlisted: true });
  }

  await env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(now()).run();
  // Rate-limit counters (keyed by email or IP address) only matter for an
  // hour; keep none longer than a day (the privacy policy says so).
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now() - 86400e3).run();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
  const nonce = randomToken();
  await env.DB.prepare("INSERT INTO email_codes (id, email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)")
    .bind(await sha256(nonce), email, await codeHash(env, email, code), now() + CODE_MINUTES * 60e3, now()).run();
  const setCookie = cookie(CODE_COOKIE, nonce, { maxAge: CODE_MINUTES * 60, secure: isSecure(request) });

  if (env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email],
        subject: `${code} is your ${env.APP_NAME} sign-in code`,
        text: `Your ${env.APP_NAME} sign-in code is ${code}\n\nIt expires in ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
        html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
          <h2 style="margin:0 0 12px">${env.APP_NAME}</h2>
          <p>Your sign-in code:</p>
          <p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:8px 0 16px">${code}</p>
          <p style="color:#666">It expires in ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p></div>`,
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("resend failed", r.status, detail);
      // Resend's test sender only delivers to the address the Resend account was created with.
      if (r.status === 403 && /testing emails|own email|verify a domain/i.test(detail)) {
        throw new HttpError(502, "Email isn't set up for this address yet. Use the email your Resend account was created with.");
      }
      throw new HttpError(502, "Couldn't send the email. Please try again.");
    }
    return json({ ok: true }, 200, { "set-cookie": setCookie });
  }
  // Local development only: no email service, so hand the code back.
  if (env.DEV_ECHO_CODES === "1") return json({ ok: true, devCode: code }, 200, { "set-cookie": setCookie });
  throw new HttpError(503, "Email sign-in isn't set up yet");
}

export async function emailVerify(env, request, body) {
  const email = normEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "");
  await rateLimit(env, "verify-ip:" + clientIp(request), 30, 900e3);
  // Per-address budget of wrong guesses across all codes (correct codes never
  // count). Brute force stays hopeless; worst case an attacker pauses email
  // sign-in for an hour, while passkeys keep working.
  const failKey = "verify-fail:" + email;
  const nonce = getCookie(request, CODE_COOKIE);
  if (!nonce) throw new HttpError(400, "That code has expired. Ask for a new one.");
  // Spend one guess atomically before comparing (5 per code, even in parallel).
  const row = await env.DB.prepare(
    "UPDATE email_codes SET attempts = attempts + 1 WHERE id = ? AND email = ? AND attempts < 5 AND expires_at > ? RETURNING code_hash, attempts"
  ).bind(await sha256(nonce), email, now()).first();
  if (!row) throw new HttpError(400, "That code has expired or had too many tries. Ask for a new one.");
  // The first try on a fresh code is never blocked by the per-address budget,
  // so others' wrong guesses can't stop a parent who types it right.
  if (row.attempts > 1 && (await overLimit(env, failKey, 20, 3600e3))) {
    throw new HttpError(429, "Too many wrong codes for this email. Try again in an hour, or sign in with a passkey.");
  }
  if ((await codeHash(env, email, code)) !== row.code_hash) {
    await rateLimit(env, failKey, 1e9, 3600e3); // count the wrong guess
    throw new HttpError(400, "That code isn't right");
  }

  await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
  if (!(await access.isAllowed(env, email))) throw new HttpError(403, "You're on the waiting list. We'll email you when it's your turn.");
  const user = await findOrCreateUser(env, email);
  const pk = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").bind(user.id).first();
  const res = await startSession(env, request, user.id, { ok: true, email: user.email, passkeys: pk.n });
  res.headers.append("set-cookie", cookie(CODE_COOKIE, "", { maxAge: 0, secure: isSecure(request) }));
  return res;
}

// ---------- Passkeys ----------

// Passkeys are tied to an RP ID. On our own domain that's RP_ID (the parent
// domain, e.g. your-domain.com); anywhere else (workers.dev, localhost)
// it's the page's hostname. The origin is always the exact page origin.
const rp = (request, env) => {
  const u = new URL(request.url);
  const base = env && env.RP_ID;
  const own = base && (u.hostname === base || u.hostname.endsWith("." + base));
  return { rpID: own ? base : u.hostname, origin: u.origin };
};

async function saveChallenge(env, challenge, userId) {
  const id = randomId(20);
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now()).run();
  await env.DB.prepare("INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, challenge, userId || null, now() + 5 * 60e3).run();
  return id;
}

async function takeChallenge(env, id) {
  const row = await env.DB.prepare("SELECT challenge, user_id, expires_at FROM challenges WHERE id = ?").bind(String(id || "")).first();
  await env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(String(id || "")).run();
  if (!row || row.expires_at < now()) throw new HttpError(400, "That took too long. Please try again.");
  return row;
}

export async function passkeyRegisterOptions(env, request) {
  const user = await requireUser(env, request);
  const { rpID } = rp(request, env);
  const existing = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(user.id).all();
  const options = await generateRegistrationOptions({
    rpName: env.APP_NAME,
    rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.results.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return json({ options, challengeId: await saveChallenge(env, options.challenge, user.id) });
}

export async function passkeyRegisterVerify(env, request, body) {
  const user = await requireUser(env, request);
  const ch = await takeChallenge(env, body.challengeId);
  if (ch.user_id !== user.id) throw new HttpError(400, "Please try again");
  const { rpID, origin } = rp(request, env);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) { throw new HttpError(400, "Couldn't verify that passkey"); }
  if (!v.verified) throw new HttpError(400, "Couldn't verify that passkey");
  const c = v.registrationInfo.credential;
  // A credential id belongs to one account: never let another account's
  // registration take over (or wipe) an existing passkey row.
  const taken = await env.DB.prepare("SELECT user_id FROM passkeys WHERE id = ?").bind(c.id).first();
  if (taken && taken.user_id !== user.id) throw new HttpError(400, "That passkey is already in use");
  await env.DB.prepare(
    "INSERT OR REPLACE INTO passkeys (id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(c.id, user.id, b64url(c.publicKey), c.counter || 0, JSON.stringify(c.transports || []),
    String(body.label || "Passkey").slice(0, 60), now()).run();
  return json({ ok: true });
}

export async function passkeyLoginOptions(env, request) {
  await rateLimit(env, "passkey-ip:" + clientIp(request), 60, 900e3);
  const { rpID } = rp(request, env);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  return json({ options, challengeId: await saveChallenge(env, options.challenge, null) });
}

export async function passkeyLoginVerify(env, request, body) {
  const ch = await takeChallenge(env, body.challengeId);
  const credId = body.response && body.response.id;
  const pk = await env.DB.prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?").bind(String(credId || "")).first();
  if (!pk) throw new HttpError(400, "That passkey isn't registered here. Sign in with an email code instead.");
  const { rpID, origin } = rp(request, env);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: pk.id, publicKey: fromB64url(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
      requireUserVerification: false,
    });
  } catch (e) { throw new HttpError(400, "Couldn't verify that passkey"); }
  if (!v.verified) throw new HttpError(400, "Couldn't verify that passkey");
  await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(v.authenticationInfo.newCounter, now(), pk.id).run();
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(pk.user_id).first();
  return startSession(env, request, user.id, { ok: true, email: user.email, passkeys: 1 });
}
