// Notifications for parents: subscriptions, which alerts each parent wants,
// and the four alerts themselves.
//   soon     "Maya TV comes on in 10 minutes"        (cron, every minute)
//   signoff  "Maya TV just signed off" + "+10 min"   (cron)
//   offline  "Living room TV isn't tuned in" while a show is on or about to start (cron)
//   changed  "Sam changed Maya TV"                 (when another parent saves; at most every 10 min)
import Schedule from "../../shared/schedule.js";
import { HttpError, json, now, withinLimit } from "./util.js";
import { vapid, send } from "./webpush.js";

const KINDS = ["soon", "signoff", "offline", "changed"];
const ALL_ON = { soon: true, signoff: true, offline: true, changed: true };
const prefsOf = (text) => { try { return { ...ALL_ON, ...(text ? JSON.parse(text) : {}) }; } catch { return { ...ALL_ON }; } };

// ---------- API ----------

export async function publicKey(env) {
  const v = await vapid(env);
  return json({ key: v ? v.publicKey : null });
}

export async function subscribe(env, request, user, body) {
  const s = body && body.subscription;
  const endpoint = s && String(s.endpoint || "");
  const keys = (s && s.keys) || {};
  // Real push services only (Chrome/Android, Safari, Firefox, Edge on
  // Windows), named exactly, so this can't make the Worker call anything else.
  let host = "";
  try { host = new URL(endpoint).hostname; } catch {}
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 600 ||
      !/^(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/.test(host)) {
    throw new HttpError(400, "That browser's push service isn't supported");
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || "") || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth || "")) {
    throw new HttpError(400, "That subscription looks broken. Try again.");
  }
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(user.id).first();
  if (n.n >= 10) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at LIMIT 1)").bind(user.id).run();
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`
  ).bind(endpoint, user.id, keys.p256dh, keys.auth, String(request.headers.get("user-agent") || "").slice(0, 160), now()).run();
  return json({ ok: true });
}

export async function unsubscribe(env, user, body) {
  await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").bind(String((body && body.endpoint) || ""), user.id).run();
  return json({ ok: true });
}

export async function getPrefs(env, user) {
  const row = await env.DB.prepare("SELECT notify, (SELECT COUNT(*) FROM push_subs WHERE user_id = ?1) AS devices FROM users WHERE id = ?1").bind(user.id).first();
  return json({ prefs: prefsOf(row && row.notify), devices: (row && row.devices) || 0, ready: !!env.VAPID_PRIVATE_JWK });
}

export async function setPrefs(env, user, body) {
  const p = {};
  for (const k of KINDS) p[k] = !!(body && body.prefs && body.prefs[k]);
  await env.DB.prepare("UPDATE users SET notify = ? WHERE id = ?").bind(JSON.stringify(p), user.id).run();
  return json({ ok: true, prefs: p });
}

export async function test(env, user) {
  const sent = await toUsers(env, [user.id], null, {
    title: "Saturday Mornings", body: "Notifications are on. You'll hear from the station here.", tag: "test", url: "/app/#/account",
  });
  if (!sent) throw new HttpError(400, "No device is set up for notifications yet");
  return json({ ok: true, sent });
}

// ---------- sending ----------

// Sends to every device of these parents that wants this kind (kind null:
// always). Removes devices whose browser has unsubscribed. Returns how many went.
async function toUsers(env, userIds, kind, msg) {
  if (!userIds.length || !env.VAPID_PRIVATE_JWK) return 0;
  const rows = (await env.DB.prepare(
    `SELECT s.endpoint, s.p256dh, s.auth, u.notify FROM push_subs s JOIN users u ON u.id = s.user_id
     WHERE s.user_id IN (SELECT value FROM json_each(?))`
  ).bind(JSON.stringify(userIds)).all()).results.filter((r) => !kind || prefsOf(r.notify)[kind]);
  let sent = 0;
  await Promise.all(rows.map(async (s) => {
    try {
      const status = await send(env, s, msg, { ttl: kind === "soon" ? 900 : 3600, urgency: kind === "offline" ? "high" : "normal" });
      if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
      else if (status < 300) { sent++; await env.DB.prepare("UPDATE push_subs SET last_ok_at = ? WHERE endpoint = ?").bind(now(), s.endpoint).run(); }
    } catch (e) { console.error("push", e && e.message); }
  }));
  return sent;
}

// True the first time a key is seen (so each alert goes out once).
async function firstTime(env, key) {
  const r = await env.DB.prepare("INSERT INTO notify_log (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, now()).run();
  return r.meta.changes > 0;
}

const tvName = (p) => `${p.name || "Kid"} TV`;
const label = (t, lib) => Schedule.slotLabel(t, lib);
const firstName = (email) => {
  const w = String(email || "").split("@")[0].split(/[._\-+]+/)[0] || "Someone";
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// ---------- every minute ----------

export async function cron(env) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const anyone = await env.DB.prepare("SELECT 1 FROM push_subs LIMIT 1").first();
  if (!anyone) return;
  const real = new Date();
  await env.DB.prepare("DELETE FROM notify_log WHERE sent_at < ?").bind(now() - 3 * 86400e3).run();
  // Only families where someone has a device set up.
  const homes = (await env.DB.prepare(
    `SELECT h.id, h.data FROM households h WHERE EXISTS (
       SELECT 1 FROM household_members m JOIN push_subs s ON s.user_id = m.user_id WHERE m.household_id = h.id)`
  ).all()).results;
  for (const row of homes) {
    try { await checkHome(env, row, real); } catch (e) { console.error("notify home", row.id, e && e.message); }
  }
}

async function checkHome(env, row, real) {
  let h; try { h = JSON.parse(row.data); } catch { return; }
  Schedule.migrateHousehold(h);
  const nowW = Schedule.wallNow(h.timeZone, real);
  const date = Schedule.dateKey(nowW);
  const lib = Schedule.libraryMap(h);
  const parents = (await env.DB.prepare("SELECT user_id FROM household_members WHERE household_id = ?").bind(row.id).all()).results.map((r) => r.user_id);
  let showTime = null; // a kid's show is on, or starts within 10 minutes

  for (const p of h.profiles || []) {
    const today = Schedule.todayOf(p, nowW);
    for (const c of p.channels || []) {
      for (const t of c.slots || []) {
        if (!t.items || !t.items.length) continue;
        const w = Schedule.windowOn(t, nowW);
        if (!w) continue;
        const toOpen = (w.open - nowW) / 60e3;
        const close = Schedule.slotClosesAt(t, nowW, null, p);
        const onNow = Schedule.activeSlot(p, c, nowW, null) === t;
        if (onNow || (toOpen > 0 && toOpen <= 10)) showTime = showTime || { p, t };

        // Coming on soon (not if the kid's TV is off for today)
        if (toOpen > 0 && toOpen <= 10 && !(today && today.off) && await firstTime(env, `soon:${row.id}:${t.id}:${date}`)) {
          await toUsers(env, parents, "soon", {
            title: `${tvName(p)} comes on in ${Math.max(1, Math.round(toOpen))} minutes`,
            body: `${label(t, lib)} starts at ${Schedule.formatTime(w.open)}.`,
            tag: `soon-${p.id}`, url: `/app/#/k/${p.id}`,
          });
        }
        // Just signed off (at the real close, extra time included)
        const since = (nowW - close) / 60e3;
        if (since >= 0 && since < 5 && !(today && today.off) && await firstTime(env, `signoff:${row.id}:${t.id}:${date}:${hm(close)}`)) {
          await toUsers(env, parents, "signoff", {
            title: `${tvName(p)} just signed off`,
            body: `${label(t, lib)} is over for today. Need a few more minutes?`,
            tag: `signoff-${p.id}`, url: `/app/#/k/${p.id}`,
            actions: [{ action: "more", title: "+10 min" }],
            more: { profile: p.id, slot: t.id },
          });
        }
      }
    }
  }

  // A TV that hasn't checked in while a show is on (or about to start).
  if (showTime) {
    const tvs = (await env.DB.prepare("SELECT id, name, created_at, last_seen_at FROM tvs WHERE household_id = ?").bind(row.id).all()).results;
    for (const tv of tvs) {
      const quiet = now() - (tv.last_seen_at || tv.created_at);
      if (quiet < 12 * 60e3 || now() - tv.created_at < 15 * 60e3) continue;
      if (!(await firstTime(env, `offline:${tv.id}:${tv.last_seen_at || 0}`))) continue;
      const seen = tv.last_seen_at ? `since ${Schedule.formatTime(Schedule.wallNow(h.timeZone, new Date(tv.last_seen_at)))}` : "yet";
      await toUsers(env, parents, "offline", {
        title: `${tv.name} isn't tuned in`,
        body: `${tvName(showTime.p)} is on air soon or now, but this TV hasn't checked in ${seen}. Is it switched on, with Saturday Mornings open?`,
        tag: `offline-${tv.id}`, url: "/app/#/tvs",
      });
    }
  }
}

// ---------- when a parent saves ----------

// Tells the family's other parents what changed, at most every 10 minutes.
export async function changed(env, user, householdId, before, after) {
  const others = (await env.DB.prepare("SELECT user_id FROM household_members WHERE household_id = ? AND user_id != ?")
    .bind(householdId, user.id).all()).results.map((r) => r.user_id);
  if (!others.length) return;
  const key = (p) => JSON.stringify({ n: p.name, e: p.emoji, c: p.channels, t: p.today, s: p.allowSkip });
  const was = new Map((before.profiles || []).map((p) => [p.id, key(p)]));
  const names = (after.profiles || []).filter((p) => was.get(p.id) !== key(p)).map(tvName);
  const removed = (before.profiles || []).filter((p) => !(after.profiles || []).some((q) => q.id === p.id)).length;
  const lib = JSON.stringify((before.library || []).map((s) => s.id)) !== JSON.stringify((after.library || []).map((s) => s.id));
  if (!names.length && !removed && !lib) return;
  if (!(await withinLimit(env, "notify-changed:" + householdId, 1, 10 * 60e3))) return;
  const what = names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? " and more" : "") : removed ? "the channels" : "the show library";
  await toUsers(env, others, "changed", {
    title: `${firstName(user.email)} changed ${what}`,
    body: "Open Saturday Mornings to see the new schedule.",
    tag: `changed-${householdId}`, url: "/app/#/",
  });
}

// A TV was linked to the family: the other parents hear about it, so a TV
// nobody recognises (say, linked from a code someone else sent) gets noticed
// and unlinked from Your TVs.
export async function tvLinked(env, user, householdId, name) {
  const others = (await env.DB.prepare("SELECT user_id FROM household_members WHERE household_id = ? AND user_id != ?")
    .bind(householdId, user.id).all()).results.map((r) => r.user_id);
  await toUsers(env, others, "changed", {
    title: `${firstName(user.email)} linked a TV: ${name}`,
    body: "Don't recognise it? Unlink it in Your TVs.",
    tag: `tv-linked-${householdId}`, url: "/app/#/tvs",
  });
}
