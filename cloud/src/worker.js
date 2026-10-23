// Saturday Mornings: Cloudflare Worker. Static files (parent site, TV app)
// come from ./public; everything under /api/ is handled here.
import { json, error, HttpError, readJson, assertSameOrigin, now, rateLimit, withinLimit, clientIp } from "./util.js";
import * as auth from "./auth.js";
import * as access from "./access.js";
import * as push from "./push.js";
import Schedule from "../../shared/schedule.js";
import * as tv from "./tv.js";
import * as family from "./family.js";
import { cleanHousehold } from "./clean.js";
import { resolveLink, searchShows, withMeta, dailyRefresh } from "./youtube.js";
import { thumb } from "./thumb.js";

async function getHousehold(env, user) {
  const m = await family.householdOf(env, user.id);
  const row = await env.DB.prepare("SELECT id, data, version FROM households WHERE id = ?").bind(m.id).first();
  return { id: row.id, version: row.version, ...JSON.parse(row.data) };
}

async function putHousehold(env, user, body, ctx) {
  const current = await getHousehold(env, user);
  // The same budget of YouTube lookups as GET /api/household (see there).
  const gate = () => withinLimit(env, "meta-inline:" + current.id, 30, 3600e3);
  // Another phone saved since this one loaded: refuse rather than overwrite.
  if (typeof body.baseVersion === "number" && body.baseVersion !== current.version) {
    const { id, ...rest } = current;
    return json(await withMeta(env, rest, { refresh: "inline", gate }), 409);
  }
  let clean;
  try { clean = cleanHousehold(body); } catch { throw new HttpError(400, "bad shape"); }
  const version = current.version + 1;
  const r = await env.DB.prepare("UPDATE households SET data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?")
    .bind(JSON.stringify(clean), version, now(), current.id, current.version).run();
  if (!r.meta.changes) {
    const { id, ...rest } = await getHousehold(env, user);
    return json(await withMeta(env, rest, { refresh: "inline", gate }), 409);
  }
  // Let the family's other parents know (at most every 10 minutes).
  if (ctx) ctx.waitUntil(push.changed(env, user, current.id, current, clean).catch((e) => console.error("notify changed", e)));
  return json(await withMeta(env, { version, ...clean }));
}

// "+10 min" from a sign-off notification (or anywhere): keeps one of today's
// programmes on 10 more minutes, the same override the app's own button sets.
async function moreTime(env, user, body, ctx) {
  const current = await getHousehold(env, user);
  const p = (current.profiles || []).find((x) => x.id === String(body.profile || ""));
  const t = p && (p.channels || []).flatMap((c) => c.slots || []).find((x) => x.id === String(body.slot || ""));
  if (!t) throw new HttpError(404, "That programme isn't in your family");
  const nowW = Schedule.wallNow(current.timeZone, new Date());
  if (!Schedule.windowOn(t, nowW)) throw new HttpError(400, "That programme isn't on today");
  const close = Schedule.slotClosesAt(t, nowW, null, p);
  const from = Math.max(nowW.getTime(), close.getTime());
  const until = new Date(Math.min(from + 10 * 60e3, new Date(nowW).setHours(23, 59, 0, 0)));
  const hm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
  p.today = { date: Schedule.dateKey(nowW), more: { slot: t.id, until: hm } };
  const { id, version, ...h } = current;
  const res = await putHousehold(env, user, { ...h, baseVersion: version }, ctx);
  if (res.status !== 200) throw new HttpError(409, "Someone just changed the schedule. Try again.");
  return json({ ok: true, until: hm, kid: p.name });
}

async function api(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request);

  // Health check used by the TV launcher.
  if (path === "/api/health") return json({ ok: true }, 200, { "access-control-allow-origin": "*" });

  // Script errors from the parent app and the TV, so problems show up in the
  // Worker's logs (Workers Logs / `wrangler tail`) instead of in reviews.
  if (path === "/api/report" && method === "POST") {
    await rateLimit(env, "report-ip:" + clientIp(request), 30, 3600e3);
    const b = await readJson(request, 4000);
    const s = (v, n) => String(v ?? "").slice(0, n);
    console.error("client error", JSON.stringify({ where: s(b.where, 20), message: s(b.message, 300), source: s(b.source, 200), line: Number(b.line) || 0, ua: s(request.headers.get("user-agent"), 160) }));
    return new Response(null, { status: 204 });
  }

  // Public settings for the sign-in page (the Turnstile site key, if on).
  if (path === "/api/config" && method === "GET") {
    return json({ turnstile: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null });
  }

  // Accounts
  if (path === "/api/me" && method === "GET") return auth.me(env, request);
  if (path === "/api/auth/email/start" && method === "POST") return auth.emailStart(env, request, await readJson(request));
  if (path === "/api/auth/email/verify" && method === "POST") return auth.emailVerify(env, request, await readJson(request));
  if (path === "/api/auth/passkey/register/options" && method === "POST") return auth.passkeyRegisterOptions(env, request);
  if (path === "/api/auth/passkey/register/verify" && method === "POST") return auth.passkeyRegisterVerify(env, request, await readJson(request));
  if (path === "/api/auth/passkey/login/options" && method === "POST") return auth.passkeyLoginOptions(env, request);
  if (path === "/api/auth/passkey/login/verify" && method === "POST") return auth.passkeyLoginVerify(env, request, await readJson(request));
  if (path === "/api/auth/signout" && method === "POST") return auth.signOut(env, request);

  // TV side (no parent session)
  if (path === "/api/tv/pair/start" && method === "POST") return tv.pairStart(env, request);
  if (path === "/api/tv/pair/status" && method === "GET") return tv.pairStatus(env, url);
  if (path === "/api/tv/household" && method === "GET") return tv.tvHousehold(env, request, ctx);

  // Parent side
  const user = await auth.requireUser(env, request);
  if (path === "/api/household" && method === "GET") {
    const { id, ...h } = await getHousehold(env, user);
    // Looking up shows YouTube hasn't described yet spends the shared daily
    // quota, so each family gets a budget of inline lookups.
    const gate = () => withinLimit(env, "meta-inline:" + id, 30, 3600e3);
    return json(await withMeta(env, h, { refresh: "inline", gate }));
  }
  if (path === "/api/me/avatar" && method === "PUT") return auth.setAvatar(env, user, await readJson(request, 120_000));
  if (path === "/api/household" && method === "PUT") return putHousehold(env, user, await readJson(request), ctx);
  // Notifications
  if (path === "/api/push/key" && method === "GET") return push.publicKey(env);
  if (path === "/api/push/subscribe" && method === "POST") return push.subscribe(env, request, user, await readJson(request, 4000));
  if (path === "/api/push/subscribe" && method === "DELETE") return push.unsubscribe(env, user, await readJson(request, 4000));
  if (path === "/api/push/prefs" && method === "GET") return push.getPrefs(env, user);
  if (path === "/api/push/prefs" && method === "PUT") return push.setPrefs(env, user, await readJson(request, 2000));
  if (path === "/api/push/test" && method === "POST") {
    await rateLimit(env, "push-test:" + user.id, 5, 3600e3, "That's enough tests for now. Try again in a while.");
    return push.test(env, user);
  }
  if (path === "/api/more-time" && method === "POST") {
    await rateLimit(env, "more:" + user.id, 30, 3600e3);
    return moreTime(env, user, await readJson(request, 2000), ctx);
  }
  if (path === "/api/family" && method === "GET") return family.family(env, user);
  if (path === "/api/family/invite" && method === "POST") return family.invite(env, request, user, await readJson(request));
  if (path === "/api/family/invite" && method === "DELETE") return family.cancelInvite(env, user, await readJson(request));
  if (path === "/api/family/join" && method === "POST") return family.join(env, user, await readJson(request));
  if (path === "/api/family/remove" && method === "POST") return family.remove(env, user, await readJson(request));
  if (path === "/api/family/leave" && method === "POST") return family.leave(env, user);
  if (path === "/api/account" && method === "DELETE") return auth.deleteAccount(env, request, user, await readJson(request));
  if (path === "/api/resolve" && method === "GET") {
    // Each new link costs YouTube quota shared by every family.
    await rateLimit(env, "resolve:" + user.id, 300, 86400e3, "That's a lot of shows for one day. Try again tomorrow.");
    await rateLimit(env, "resolve:all", 5000, 86400e3, "Adding shows is resting for today. Try again tomorrow.");
    return json(await resolveLink(env, (url.searchParams.get("link") || "").slice(0, 500)));
  }
  if (path === "/api/search" && method === "GET") {
    return json(await searchShows(env, request, user, (url.searchParams.get("q") || "").slice(0, 200), url.searchParams.get("type")));
  }
  // Early access admin (ADMIN_EMAILS only): the waiting list and releases.
  if (path.startsWith("/api/admin")) {
    await access.requireAdmin(env, user);
    if (path === "/api/admin" && method === "GET") return access.adminState(env);
    if (path === "/api/admin/approve" && method === "POST") return access.adminApprove(env, await readJson(request));
    if (path === "/api/admin/release" && method === "POST") return access.adminRelease(env, await readJson(request));
  }
  if (path === "/api/tvs" && method === "GET") return tv.listTvs(env, user);
  if (path === "/api/tvs/link" && method === "POST") return tv.linkTv(env, request, user, await readJson(request));
  const m = path.match(/^\/api\/tvs\/([a-z0-9]{1,20})$/);
  if (m && method === "DELETE") return tv.removeTv(env, user, m[1]);
  if (m && method === "PATCH") return tv.renameTv(env, user, m[1], await readJson(request));

  return error(404, "not found");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // YouTube thumbnails, cached (no session needed: the TV and the parent app both use it).
    if (url.pathname === "/api/thumb" && (request.method === "GET" || request.method === "HEAD")) {
      try { return await thumb(request, ctx, url); }
      catch (e) { console.error(e); return error(502, "thumbnail unavailable"); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-methods": "GET",
          "access-control-allow-headers": "authorization", "access-control-max-age": "86400",
        } });
      }
      try {
        return await api(request, env, url, ctx);
      } catch (e) {
        if (e instanceof HttpError) return error(e.status, e.message);
        console.error(e);
        return error(500, "Something went wrong");
      }
    }
    return env.ASSETS.fetch(request);
  },

  // Crons (see triggers in wrangler.jsonc). Daily: refresh YouTube titles and
  // thumbnails in use, delete any older than 30 days. Every minute: thank new
  // waiting-list sign-ups from the website, and send parents' notifications.
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(access.thankPending(env));
      ctx.waitUntil(push.cron(env).catch((e) => console.error("notify cron", e)));
    }
    else ctx.waitUntil(dailyRefresh(env));
  },
};
