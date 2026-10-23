// Families with more than one parent. Every parent belongs to one household
// (household_members); a parent invites another adult by email, and that
// adult signs in with that email and accepts the invite (join()).
import { emptyHousehold } from "./clean.js";
import { parseAvatar } from "./auth.js";
import { HttpError, json, now, randomId, normEmail, emailOk, rateLimit } from "./util.js";

const INVITE_DAYS = 14;
// How many parents a family can have, counting invites not yet accepted
// (vars.MAX_PARENTS; unset or 0 = no limit, the default for a family's own
// station; at least 2 when set).
const maxParents = (env) => { const n = parseInt(env.MAX_PARENTS, 10) || 0; return n > 0 ? Math.max(2, n) : 1e9; };

// The household a parent belongs to: { id, role }. A parent with none (they
// left, or were removed) gets a fresh, empty one.
export async function householdOf(env, userId) {
  const m = await env.DB.prepare("SELECT household_id AS id, role FROM household_members WHERE user_id = ?").bind(userId).first();
  if (m) return m;
  return { id: await createHousehold(env, userId), role: "owner" };
}

export async function createHousehold(env, userId) {
  const id = randomId(16);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO households (id, owner_id, data, version, updated_at) VALUES (?, ?, ?, 0, ?)")
      .bind(id, userId, JSON.stringify(emptyHousehold()), now()),
    env.DB.prepare("INSERT INTO household_members (user_id, household_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .bind(userId, id, now()),
  ]);
  return id;
}

// A brand-new account always starts with its own household. Invites are
// never applied automatically: the parent accepts one explicitly (home
// screen or Account, via join()), so nobody lands in a family they didn't
// choose just because someone typed their email address.
export async function setUpNewUser(env, user) {
  return createHousehold(env, user.id);
}

// Before a parent's account is deleted: if others share the family, it stays
// with them (passing ownership on if needed). Returns the household id to
// delete outright, or null when it was handed over.
export async function detachForDeletion(env, user) {
  const m = await householdOf(env, user.id);
  const other = await env.DB.prepare(
    "SELECT user_id FROM household_members WHERE household_id = ? AND user_id != ? ORDER BY created_at LIMIT 1"
  ).bind(m.id, user.id).first();
  if (!other) return m.id;
  const steps = [
    env.DB.prepare("DELETE FROM household_members WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM household_invites WHERE household_id = ? AND invited_by = ?").bind(m.id, user.id),
    env.DB.prepare("DELETE FROM tvs WHERE household_id = ? AND linked_by = ?").bind(m.id, user.id),
  ];
  if (m.role === "owner") {
    steps.push(
      env.DB.prepare("UPDATE households SET owner_id = ? WHERE id = ?").bind(other.user_id, m.id),
      env.DB.prepare("UPDATE household_members SET role = 'owner' WHERE user_id = ?").bind(other.user_id),
    );
  }
  await env.DB.batch(steps);
  return null;
}

// Account screen: who's in the family, who's invited, and invites waiting
// for this parent from other families.
export async function family(env, user) {
  const m = await householdOf(env, user.id);
  const members = await env.DB.prepare(
    "SELECT u.email, u.avatar, m.role, m.user_id FROM household_members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.created_at"
  ).bind(m.id).all();
  const invites = await env.DB.prepare(
    "SELECT email, created_at FROM household_invites WHERE household_id = ? AND expires_at > ? ORDER BY created_at"
  ).bind(m.id, now()).all();
  const invitedTo = await env.DB.prepare(
    `SELECT i.household_id, u.email AS from_email FROM household_invites i JOIN users u ON u.id = i.invited_by
     WHERE i.email = ? AND i.expires_at > ? AND i.household_id != ?`
  ).bind(user.email, now(), m.id).all();
  return json({
    role: m.role,
    members: members.results.map((r) => ({ email: r.email, role: r.role, you: r.user_id === user.id, avatar: parseAvatar(r.avatar) })),
    invites: invites.results.map((r) => ({ email: r.email, createdAt: r.created_at })),
    invitedTo: invitedTo.results.map((r) => ({ householdId: r.household_id, from: r.from_email })),
  });
}

export async function invite(env, request, user, body) {
  const email = normEmail(body.email);
  if (!emailOk(email)) throw new HttpError(400, "That doesn't look like an email address");
  if (email === user.email) throw new HttpError(400, "That's your own email");
  await rateLimit(env, "invite:" + user.id, 10, 3600e3, "Too many invites. Try again in an hour.");
  await rateLimit(env, "invite-day:" + user.id, 20, 86400e3, "Too many invites today. Try again tomorrow.");
  const m = await householdOf(env, user.id);
  const n = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM household_members WHERE household_id = ?1) + (SELECT COUNT(*) FROM household_invites WHERE household_id = ?1 AND expires_at > ?2) AS n"
  ).bind(m.id, now()).first();
  if (n.n >= maxParents(env)) throw new HttpError(400, `A family can have up to ${maxParents(env)} parents`);
  const already = await env.DB.prepare(
    "SELECT 1 FROM household_members m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.household_id = ?"
  ).bind(email, m.id).first();
  if (already) throw new HttpError(400, "They're already in your family");
  await env.DB.prepare(
    `INSERT INTO household_invites (email, household_id, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email, household_id) DO UPDATE SET invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at`
  ).bind(email, m.id, user.id, now(), now() + INVITE_DAYS * 86400e3).run();
  const emailed = await sendInviteEmail(env, request, user.email, email);
  return json({ ok: true, emailed });
}

export async function cancelInvite(env, user, body) {
  const m = await householdOf(env, user.id);
  await env.DB.prepare("DELETE FROM household_invites WHERE email = ? AND household_id = ?").bind(normEmail(body.email), m.id).run();
  return json({ ok: true });
}

// A parent accepts an invite. Their current household is deleted if they're
// its only parent (the app warns them first if it has anything in it); otherwise they just
// leave it. The owner of a family others share must remove them first.
export async function join(env, user, body) {
  const target = String(body.householdId || "");
  // The invite only counts while whoever sent it is still in that family.
  const inv = await env.DB.prepare(
    `SELECT i.household_id FROM household_invites i
     JOIN household_members m ON m.user_id = i.invited_by AND m.household_id = i.household_id
     WHERE i.email = ? AND i.household_id = ? AND i.expires_at > ?`
  ).bind(user.email, target, now()).first();
  if (!inv) throw new HttpError(400, "That invite has expired. Ask for a new one.");
  const m = await householdOf(env, user.id);
  const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM household_members WHERE household_id = ? AND user_id != ?")
    .bind(m.id, user.id).first();
  if (others.n && m.role === "owner") throw new HttpError(400, "Other parents share your family. Remove them first, then join.");
  const steps = [];
  if (!others.n) {
    steps.push(
      env.DB.prepare("DELETE FROM pairings WHERE tv_id IN (SELECT id FROM tvs WHERE household_id = ?)").bind(m.id),
      env.DB.prepare("DELETE FROM tvs WHERE household_id = ?").bind(m.id),
      env.DB.prepare("DELETE FROM household_invites WHERE household_id = ?").bind(m.id),
      env.DB.prepare("DELETE FROM household_members WHERE household_id = ?").bind(m.id),
      env.DB.prepare("DELETE FROM households WHERE id = ?").bind(m.id),
    );
  } else {
    // Leaving a family others still share: the same as leave(). Their invites
    // and the TVs they linked there go with them.
    steps.push(
      env.DB.prepare("DELETE FROM household_members WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM household_invites WHERE household_id = ? AND invited_by = ?").bind(m.id, user.id),
      env.DB.prepare("DELETE FROM tvs WHERE household_id = ? AND linked_by = ?").bind(m.id, user.id),
    );
  }
  steps.push(
    env.DB.prepare("INSERT INTO household_members (user_id, household_id, role, created_at) VALUES (?, ?, 'parent', ?)").bind(user.id, target, now()),
    env.DB.prepare("DELETE FROM household_invites WHERE email = ? AND household_id = ?").bind(user.email, target),
  );
  await env.DB.batch(steps);
  return json({ ok: true });
}

// The owner removes another parent. They keep their account and start over
// with an empty household next time they open the app.
export async function remove(env, user, body) {
  const m = await householdOf(env, user.id);
  if (m.role !== "owner") throw new HttpError(403, "Only the family's owner can remove a parent");
  const target = await env.DB.prepare(
    "SELECT m.user_id FROM household_members m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.household_id = ?"
  ).bind(normEmail(body.email), m.id).first();
  if (!target || target.user_id === user.id) throw new HttpError(400, "They're not in your family");
  const tvs = await theirTvs(env, m.id, target.user_id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM household_members WHERE user_id = ?").bind(target.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.user_id),
    // Invites they sent to this family go with them, and so do the TVs they linked.
    env.DB.prepare("DELETE FROM household_invites WHERE household_id = ? AND invited_by = ?").bind(m.id, target.user_id),
    tvs.step,
  ]);
  return json({ ok: true, tvsUnlinked: tvs.n });
}

// TVs a departing parent linked go with them: one may well be in their own
// home. Returns the statements, and how many TVs that is.
async function theirTvs(env, householdId, userId) {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tvs WHERE household_id = ? AND linked_by = ?").bind(householdId, userId).first()).n;
  return { n, step: env.DB.prepare("DELETE FROM tvs WHERE household_id = ? AND linked_by = ?").bind(householdId, userId) };
}

// A parent who isn't the owner leaves the family.
export async function leave(env, user) {
  const m = await householdOf(env, user.id);
  if (m.role === "owner") throw new HttpError(400, "You own this family. Delete your account instead, and it passes to the other parent.");
  const tvs = await theirTvs(env, m.id, user.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM household_members WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM household_invites WHERE household_id = ? AND invited_by = ?").bind(m.id, user.id),
    tvs.step,
  ]);
  return json({ ok: true, tvsUnlinked: tvs.n });
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sendInviteEmail(env, request, fromEmail, to) {
  if (!env.RESEND_API_KEY) return false;
  const [fromH, toH] = [escHtml(fromEmail), escHtml(to)];
  const site = new URL(request.url).origin;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: `${fromEmail} invited you to ${env.APP_NAME}`,
      text: `${fromEmail} invited you to help manage your kids' TV channels on ${env.APP_NAME}.\n\nSign in at ${site} with this email address (${to}) within ${INVITE_DAYS} days, then tap Join.`,
      html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
        <h2 style="margin:0 0 12px">${env.APP_NAME}</h2>
        <p><b>${fromH}</b> invited you to help manage your kids' TV channels.</p>
        <p><a href="${site}" style="display:inline-block;background:#3554ff;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Sign in to join</a></p>
        <p style="color:#666">After signing in, tap Join to accept.</p>
        <p style="color:#666">Use this email address (${toH}) within ${INVITE_DAYS} days.</p></div>`,
    }),
  });
  if (!r.ok) console.error("invite email failed", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}
