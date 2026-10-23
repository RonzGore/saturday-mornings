// TVs: an unlinked TV shows a short code; a signed-in parent enters it on the
// website; the TV then gets its own secret token for reading the household.
import { householdOf } from "./family.js";
import { HttpError, json, now, randomId, randomToken, sha256, rateLimit, clientIp } from "./util.js";
import { withMeta } from "./youtube.js";
import * as push from "./push.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const PAIR_MINUTES = 15;
// How many TVs a family can link at once (vars.MAX_TVS; unset or 0 = no
// limit, the default for a family's own station). A hosted service sets it so
// one account can't run a room full of screens. Unlinking a TV frees its place.
export const maxTvs = (env) => Math.max(0, parseInt(env.MAX_TVS, 10) || 0);
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function pairStart(env, request) {
  await rateLimit(env, "pair-ip:" + clientIp(request), 60, 3600e3);
  await env.DB.prepare("DELETE FROM pairings WHERE expires_at < ?").bind(now()).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now() - 86400e3).run();
  const code = randomId(6, CODE_ALPHABET);
  const poll = randomToken();
  await env.DB.prepare("INSERT INTO pairings (code, poll_hash, expires_at) VALUES (?, ?, ?)")
    .bind(code, await sha256(poll), now() + PAIR_MINUTES * 60e3).run();
  return json({ code, poll, expiresIn: PAIR_MINUTES * 60 });
}

export async function pairStatus(env, url) {
  const code = normCode(url.searchParams.get("code"));
  const poll = url.searchParams.get("poll") || "";
  const row = await env.DB.prepare("SELECT poll_hash, token, expires_at FROM pairings WHERE code = ?").bind(code).first();
  if (!row || row.poll_hash !== (await sha256(poll))) throw new HttpError(404, "unknown code");
  if (row.token) {
    await env.DB.prepare("DELETE FROM pairings WHERE code = ?").bind(code).run(); // hand over once
    return json({ status: "linked", token: row.token });
  }
  if (row.expires_at < now()) return json({ status: "expired" });
  return json({ status: "pending" });
}


export async function linkTv(env, request, user, body) {
  // Codes are 6 characters from 31 (~887 million); these limits keep guessing
  // someone else's TV hopeless.
  await rateLimit(env, "link:" + user.id, 10, 3600e3);
  await rateLimit(env, "link-ip:" + clientIp(request), 20, 3600e3);
  const code = normCode(body.code);
  const row = await env.DB.prepare("SELECT code, tv_id, expires_at FROM pairings WHERE code = ?").bind(code).first();
  if (!row || row.expires_at < now()) throw new HttpError(400, "That code isn't valid. Check the TV, it shows a new code every 15 minutes.");
  if (row.tv_id) throw new HttpError(400, "That TV is already linked");
  const hh = await householdOf(env, user.id);
  const max = maxTvs(env) || 1e9;
  const full = () => new HttpError(400, `A family can link up to ${max} TVs. Unlink one in Your TVs to add another.`);
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM tvs WHERE household_id = ?").bind(hh.id).first()).n;
  if ((await count()) >= max) throw full();
  const token = randomToken();
  const tv = { id: randomId(12), name: String(body.name || "TV").trim().slice(0, 40) || "TV" };
  // Two parents typing the same code at once: the batch runs as one
  // transaction, and only the first one finds the code still free.
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tvs (id, household_id, token_hash, name, created_at, linked_by)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairings WHERE code = ? AND tv_id IS NULL AND expires_at >= ?)
         AND (SELECT COUNT(*) FROM tvs WHERE household_id = ?) < ?`
    ).bind(tv.id, hh.id, await sha256(token), tv.name, now(), user.id, code, now(), hh.id, max),
    env.DB.prepare("UPDATE pairings SET tv_id = ?, token = ? WHERE code = ? AND tv_id IS NULL AND EXISTS (SELECT 1 FROM tvs WHERE id = ?)")
      .bind(tv.id, token, code, tv.id),
  ]);
  if (!ins.meta.changes) throw (await count()) >= max ? full() : new HttpError(400, "That TV is already linked");
  try { await push.tvLinked(env, user, hh.id, tv.name); } catch (e) { console.log("tv-linked push failed", e.message); }
  return json({ ok: true, tv });
}

export async function listTvs(env, user) {
  const hh = await householdOf(env, user.id);
  const rows = await env.DB.prepare("SELECT id, name, created_at, last_seen_at FROM tvs WHERE household_id = ? ORDER BY created_at")
    .bind(hh.id).all();
  return json({ tvs: rows.results, max: maxTvs(env) });
}

export async function removeTv(env, user, id) {
  const hh = await householdOf(env, user.id);
  const r = await env.DB.prepare("DELETE FROM tvs WHERE id = ? AND household_id = ?").bind(id, hh.id).run();
  if (!r.meta.changes) throw new HttpError(404, "That TV isn't linked to your family");
  return json({ ok: true });
}

export async function renameTv(env, user, id, body) {
  const hh = await householdOf(env, user.id);
  const name = String(body.name || "").trim().slice(0, 40);
  if (!name) throw new HttpError(400, "Give the TV a name");
  const r = await env.DB.prepare("UPDATE tvs SET name = ? WHERE id = ? AND household_id = ?").bind(name, id, hh.id).run();
  if (!r.meta.changes) throw new HttpError(404, "That TV isn't linked to your family");
  return json({ ok: true });
}

// What a linked TV reads every half minute.
export async function tvHousehold(env, request, ctx) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new HttpError(401, "not linked");
  const row = await env.DB.prepare(
    "SELECT t.id, t.last_seen_at, t.household_id, h.data, h.version FROM tvs t JOIN households h ON h.id = t.household_id WHERE t.token_hash = ?"
  ).bind(await sha256(token)).first();
  if (!row) throw new HttpError(401, "not linked");
  if (!row.last_seen_at || now() - row.last_seen_at > 5 * 60e3) {
    await env.DB.prepare("UPDATE tvs SET last_seen_at = ? WHERE id = ?").bind(now(), row.id).run();
  }
  // Shows YouTube data hasn't been fetched for yet are fetched after
  // answering, at most once every 10 minutes per family.
  const gate = () => rateLimit(env, "meta:" + row.household_id, 1, 10 * 60e3).then(() => true, () => false);
  const h = await withMeta(env, { version: row.version, ...JSON.parse(row.data) }, { refresh: "background", ctx, gate });
  return json(h, 200, { "access-control-allow-origin": "*" });
}
