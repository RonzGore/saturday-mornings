// Early access. Only approved emails can sign in; everyone else lands on one
// waiting list, along with every coupon and TV-petition sign-up from
// the website (its Worker writes to the same table). Admins
// let people in by hand or in batches, and each one gets a "you're in" email.
import { HttpError, json, now, normEmail, emailOk, withinLimit } from "./util.js";

export const TRIAL_DAYS = 30;
// Where the app and the website live (APP_URL, SITE_URL in wrangler.jsonc).
const appUrl = (env) => env.APP_URL || "";
const siteUrl = (env) => env.SITE_URL || env.APP_URL || "";

// Early access is a switch (EARLY_ACCESS = "on" in wrangler.jsonc). Off, the
// default for self-hosted stations, anyone who can reach the station can sign
// in. Admins can always sign in.
export const earlyAccessOn = (env) => String(env.EARLY_ACCESS || "").toLowerCase() === "on";

// Allowed: approved, already has an account, or invited by someone who was
// approved themselves (see inviteAdmission).
export async function isAllowed(env, email) {
  if (!earlyAccessOn(env) || isAdmin(env, { email })) return true;
  const row = await env.DB.prepare(
    "SELECT 1 FROM access WHERE email = ?1 UNION SELECT 1 FROM users WHERE email = ?1 LIMIT 1"
  ).bind(email).first();
  return !!row || !!(await inviteAdmission(env, email));
}

// A family invite lets someone in during early access only when the parent
// who sent it was let in directly (approved or an admin, not invited
// themselves), and only for a few people per parent, so invites can't become
// a way round the waiting list. Returns the inviter's user id, or null.
export const INVITE_ADMISSIONS = 3;
export async function inviteAdmission(env, email) {
  const { results } = await env.DB.prepare(
    `SELECT i.invited_by AS id, u.email AS email,
            (SELECT source FROM access a WHERE a.email = u.email) AS source,
            u.invite_admissions AS used
     FROM household_invites i
     JOIN users u ON u.id = i.invited_by
     JOIN household_members m ON m.user_id = i.invited_by AND m.household_id = i.household_id
     WHERE i.email = ? AND i.expires_at > ?`
  ).bind(email, now()).all();
  for (const r of results) {
    const direct = isAdmin(env, r) || (r.source && !r.source.startsWith("invite:"));
    if (direct && r.used < INVITE_ADMISSIONS) return r.id;
  }
  return null;
}

// Called just before an account is created. Someone let in only by an invite
// takes one of the inviter's places, claimed in a single conditional update so
// two invitees signing in at the same moment can't both take the last one.
// Returns false if they can't have an account after all.
export async function admitNewAccount(env, email) {
  if (!earlyAccessOn(env) || isAdmin(env, { email })) return true;
  if (await env.DB.prepare("SELECT 1 FROM access WHERE email = ?").bind(email).first()) return true;
  const inviter = await inviteAdmission(env, email);
  if (!inviter) return false;
  const r = await env.DB.prepare("UPDATE users SET invite_admissions = invite_admissions + 1 WHERE id = ? AND invite_admissions < ?")
    .bind(inviter, INVITE_ADMISSIONS).run();
  if (!r.meta.changes) return false;
  await env.DB.prepare("INSERT OR IGNORE INTO access (email, source, added_at) VALUES (?, ?, ?)")
    .bind(email, "invite:" + inviter, now()).run();
  return true;
}

export const isAdmin = (env, user) =>
  String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((e) => e.trim()).filter(Boolean).includes(user.email);

export async function requireAdmin(env, user) {
  if (!isAdmin(env, user)) throw new HttpError(403, "Admins only");
}

// Adds someone to the waiting list (or updates their row). Returns the row.
export async function joinWaitlist(env, email, source, { tvs = [], country = null } = {}) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO waitlist (email, source, tvs, country, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(email) DO UPDATE SET country = COALESCE(?4, country), updated_at = ?5`
  ).bind(email, source, JSON.stringify(tvs), country, t).run();
  return env.DB.prepare("SELECT email, thanked_at, released_at FROM waitlist WHERE email = ?").bind(email).first();
}

// ---------- Emails ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function letter(env, title, paragraphs, button) {
  return `<div style="background:#E9E1CC;padding:24px 12px;font-family:-apple-system,Helvetica,Arial,sans-serif;color:#23252F">
  <div style="max-width:460px;margin:auto;background:#F7F2E6;border:2px solid #23252F;border-radius:18px;overflow:hidden">
    <div style="background:#23252F;color:#F7F2E6;padding:14px 20px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Saturday Mornings</div>
    <div style="height:8px;background:linear-gradient(90deg,#c0c0c0 0 14%,#c0c000 14% 28%,#00c0c0 28% 42%,#00c000 42% 56%,#c000c0 56% 70%,#c00000 70% 84%,#0000c0 84%)"></div>
    <div style="padding:22px 22px 8px">
      <h2 style="margin:0 0 12px;font-size:24px;line-height:1.2">${esc(title)}</h2>
      ${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5">${p}</p>`).join("")}
      ${button ? `<p style="margin:18px 0 22px"><a href="${button.href}" style="display:inline-block;background:#FFD84A;color:#23252F;border:2px solid #23252F;padding:13px 22px;border-radius:14px;text-decoration:none;font-weight:800;letter-spacing:.06em;text-transform:uppercase">${esc(button.label)}</a></p>` : ""}
    </div>
  </div>
  <p style="max-width:460px;margin:12px auto 0;font-size:12px;color:#4A4A55;text-align:center">Saturday Mornings · <a href="${siteUrl(env)}" style="color:#4A4A55">${esc(siteUrl(env).replace(/^https?:\/\//, ""))}</a> · Reply to this email with any question, or to come off the list.</p>
</div>`;
}

function thanksEmail(env, to) {
  const text = [
    "Thanks for your interest in Saturday Mornings!",
    "We're letting families in a few at a time while we get everything just right. You're on the waiting list, and we'll email you as soon as your channel is ready, with your first month free.",
    "Didn't sign up? You can ignore this email.",
    "- Saturday Mornings",
  ];
  return {
    from: env.EMAIL_FROM, to: [to], reply_to: env.REPLY_TO || undefined,
    subject: "You're on the Saturday Mornings waiting list",
    text: text.join("\n\n"),
    html: letter(env, "You're on the list!", [
      "Thanks for your interest in Saturday Mornings.",
      "We're letting families in a few at a time while we get everything just right. You're on the waiting list, and we'll email you as soon as your channel is ready, <b>with your first month free</b>.",
      `<span style="color:#4A4A55">Didn't sign up? You can ignore this email.</span>`,
    ]),
  };
}

function youreInEmail(env, to) {
  const text = [
    "Good news: it's your turn!",
    `Your Saturday Mornings channel is ready. Sign in at ${appUrl(env)} with this email address (${to}) and set up your kids' channels: the shows, the times, and the TV.`,
    `Your first month is free.`,
    "Tip: add it to your phone's home screen and it works like an app. iPhone: Safari > Share > Add to Home Screen. Android: Chrome > menu > Install app.",
    "- Saturday Mornings",
  ];
  return {
    from: env.EMAIL_FROM, to: [to], reply_to: env.REPLY_TO || undefined,
    subject: "You're in! Your Saturday Mornings channel is ready",
    text: text.join("\n\n"),
    html: letter(env, "You're in!", [
      "Good news: it's your turn. Your Saturday Mornings channel is ready.",
      `Sign in with this email address (<b>${esc(to)}</b>) and set up your kids' channels: the shows, the times, and the TV. <b>Your first month is free.</b>`,
    ], { href: appUrl(env), label: "Open Saturday Mornings" }) +
      `<p style="max-width:460px;margin:0 auto;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;color:#4A4A55;text-align:center;padding:0 12px 24px">Tip: add it to your home screen and it works like an app. iPhone: Safari › Share › Add to Home Screen. Android: Chrome › ⋮ › Install app.</p>`,
  };
}

// Sends up to 100 emails per call (Resend's batch API). Returns how many went.
async function sendAll(env, messages) {
  if (!messages.length) return 0;
  if (!env.RESEND_API_KEY) { console.log("email (no Resend key):", messages.map((m) => `${m.to[0]}: ${m.subject}`).join("; ")); return 0; }
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(chunk),
    });
    if (r.ok) sent += chunk.length;
    else console.error("batch email failed", r.status, (await r.text()).slice(0, 300));
  }
  return sent;
}

// Thank-you emails go to addresses anyone can type, so they're capped: a few
// per network a day, and a few hundred a day in all. Over the cap, people
// still join the list; the cron thanks them once there's room.
const THANKS_PER_DAY = 300;
const THANKS_PER_IP_PER_DAY = 5;
const DAY = 86400e3;

// Someone not yet approved tried to sign in: put them on the list and thank
// them, once.
export async function waitlistFromApp(env, email, country, ip) {
  const row = await joinWaitlist(env, email, "app", { country });
  if (row.thanked_at) return;
  if (!(await withinLimit(env, "thanks-ip:" + ip, THANKS_PER_IP_PER_DAY, DAY))) return;
  if (!(await withinLimit(env, "thanks:all", THANKS_PER_DAY, DAY))) return;
  if (await sendAll(env, [thanksEmail(env, email)])) {
    await env.DB.prepare("UPDATE waitlist SET thanked_at = ? WHERE email = ?").bind(now(), email).run();
  }
}

// Every minute (cron): thank website sign-ups that haven't had their email yet.
export async function thankPending(env) {
  const rows = (await env.DB.prepare(
    `SELECT w.email FROM waitlist w WHERE w.thanked_at IS NULL AND w.released_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM access a WHERE a.email = w.email)
     ORDER BY w.created_at LIMIT 20`
  ).all()).results;
  if (!rows.length) return;
  // Each email counts against the daily cap; stop when it's used up.
  const allowed = [];
  for (const r of rows) { if (!(await withinLimit(env, "thanks:all", THANKS_PER_DAY, DAY))) break; allowed.push(r); }
  rows.length = 0; rows.push(...allowed);
  if (!rows.length) return;
  if (!(await sendAll(env, rows.map((r) => thanksEmail(env, r.email))))) return;
  const t = now();
  await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE waitlist SET thanked_at = ? WHERE email = ?").bind(t, r.email)));
}

// ---------- Admin ----------

export async function adminState(env) {
  const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const waitingSql = "FROM waitlist w WHERE w.released_at IS NULL AND NOT EXISTS (SELECT 1 FROM access a WHERE a.email = w.email)";
  const [approved, waiting, released, accounts] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM access"),
    one(`SELECT COUNT(*) AS n, SUM(w.source = 'site') AS site, SUM(w.source = 'app') AS app ${waitingSql}`),
    one("SELECT COUNT(*) AS n FROM waitlist WHERE released_at IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM users"),
  ]);
  const queue = (await env.DB.prepare(`SELECT w.email, w.source, w.tvs, w.country, w.created_at, w.thanked_at ${waitingSql} ORDER BY w.created_at LIMIT 100`).all()).results;
  const batches = (await env.DB.prepare(
    "SELECT batch, COUNT(*) AS n, MAX(released_at) AS at FROM waitlist WHERE batch IS NOT NULL GROUP BY batch ORDER BY at DESC LIMIT 10"
  ).all()).results;
  const recent = (await env.DB.prepare("SELECT email, source, added_at FROM access ORDER BY added_at DESC LIMIT 20").all()).results;
  return json({
    approved: approved.n, accounts: accounts.n, released: released.n,
    waiting: { total: waiting.n || 0, site: waiting.site || 0, app: waiting.app || 0 },
    queue: queue.map((r) => ({ ...r, tvs: JSON.parse(r.tvs || "[]") })), batches, recent,
  });
}

async function letIn(env, emails, source, batch) {
  const t = now();
  await env.DB.batch(emails.flatMap((e) => [
    env.DB.prepare("INSERT INTO access (email, source, added_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(e, source, t),
    env.DB.prepare("UPDATE waitlist SET released_at = ?, batch = ? WHERE email = ? AND released_at IS NULL").bind(t, batch, e),
  ]));
}

// Approve emails by hand (friends, testers). notify: send the "you're in" email.
export async function adminApprove(env, body) {
  const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map(normEmail))].filter(emailOk).slice(0, 500);
  if (!emails.length) throw new HttpError(400, "Add at least one email address");
  const batch = "manual " + new Date().toISOString().slice(0, 16).replace("T", " ");
  await letIn(env, emails, "manual", batch);
  const emailed = body.notify ? await sendAll(env, emails.map((e) => youreInEmail(env, e))) : 0;
  return json({ ok: true, approved: emails.length, emailed });
}

// Let the next N people in: first come, first served, or picked at random.
export async function adminRelease(env, body) {
  const count = Math.max(1, Math.min(1000, Number(body.count) | 0));
  const order = body.order === "random" ? "RANDOM()" : "w.created_at";
  const rows = (await env.DB.prepare(
    `SELECT w.email FROM waitlist w WHERE w.released_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM access a WHERE a.email = w.email)
     ORDER BY ${order} LIMIT ?`
  ).bind(count).all()).results;
  if (!rows.length) throw new HttpError(400, "Nobody is waiting");
  const emails = rows.map((r) => r.email);
  const batch = "batch " + new Date().toISOString().slice(0, 16).replace("T", " ");
  for (let i = 0; i < emails.length; i += 40) await letIn(env, emails.slice(i, i + 40), "batch", batch);
  const emailed = await sendAll(env, emails.map((e) => youreInEmail(env, e)));
  return json({ ok: true, released: emails.length, emailed, batch });
}
