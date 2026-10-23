// YouTube lookups, through official endpoints only: the YouTube Data API
// (needs the YOUTUBE_API_KEY secret) and oEmbed. No youtube.com pages are
// read. Without the key, videos and playlists still resolve through oEmbed,
// but channels can't be added or refreshed.
//
// Keeping YouTube data (Developer Policies III.E.4): households store only
// YouTube IDs. Titles, channel names and thumbnails live in yt_meta with the
// time they were fetched, are attached when a household is read, are never
// served once they're 30 days old, and are refreshed daily by dailyRefresh()
// from day 20 (so a few failed runs still refresh in time), then deleted at 30.
import { rateLimit } from "./util.js";

const DAY = 86400e3;
export const META_MAX_AGE = 30 * DAY;
const META_REFRESH_AGE = 20 * DAY;
const LINK_CACHE_AGE = 7 * DAY;

export function parseLink(text) {
  text = String(text || "").trim();
  if (/^[\w-]{11}$/.test(text)) return { type: "video", id: text };
  if (/^@[\w.-]{2,100}$/.test(text)) return { type: "channel", handle: text };
  let u;
  try { u = new URL(/^https?:\/\//.test(text) ? text : "https://" + text); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.slice(1, 12);
    return /^[\w-]{11}$/.test(id) ? { type: "video", id } : null;
  }
  if (host !== "youtube.com") return null;
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return { type: "video", id: v };
  let m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
  if (m) return { type: "video", id: m[2] };
  const list = u.searchParams.get("list");
  if (list && /^[\w-]{12,64}$/.test(list)) return { type: "playlist", id: list };
  m = u.pathname.match(/^\/(@[\w.-]{2,100})/);
  if (m) return { type: "channel", handle: m[1] };
  m = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (m) return { type: "channel", channelId: m[1] };
  m = u.pathname.match(/^\/(c|user)\/([\w.-]{1,100})/);
  if (m) return { type: "channel", path: `/${m[1]}/${m[2]}`, user: m[1] === "user" ? m[2] : null };
  return null;
}

// Video, playlist and channel IDs are case-sensitive; only handles and paths are not.
const linkKey = (l) => l.type + ":" + (l.id || l.channelId || (l.handle || l.path || "").toLowerCase());
export const metaKey = (show) => show.type + ":" + show.ytId;

// A pasted link -> { ok, show: { type, ytId, title, by, thumb } }.
export async function resolveLink(env, text) {
  const link = parseLink(text);
  if (!link) return { ok: false, error: "not a YouTube link" };
  const key = linkKey(link);
  // The link cache holds only the IDs a link points to; metadata comes from yt_meta.
  const cached = await env.DB.prepare("SELECT data, created_at FROM resolve_cache WHERE key = ?").bind(key).first();
  if (cached && Date.now() - cached.created_at < LINK_CACHE_AGE) {
    const ids = JSON.parse(cached.data);
    const meta = (await getMeta(env, [metaKey(ids)])).get(metaKey(ids));
    if (meta && meta.title) return { ok: true, show: { ...ids, ...meta } };
  }
  const result = await lookup(env, link);
  if (result.ok) {
    const { type, ytId, title, by, thumb } = result.show;
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO resolve_cache (key, data, created_at) VALUES (?, ?, ?)")
        .bind(key, JSON.stringify({ type, ytId }), Date.now()),
      putMetaStmt(env, metaKey(result.show), { title, by, thumb }),
    ]);
  }
  return result;
}

async function lookup(env, link) {
  const key = env.YOUTUBE_API_KEY;
  if (link.type === "video") {
    if (!key) return viaOembed("video", link.id);
    const it = (await api(key, "videos", { part: "snippet,status", id: link.id }))?.items?.[0];
    if (!it) return { ok: false, error: "not found" };
    if (it.status && it.status.embeddable === false) return { ok: false, error: "embedding blocked" };
    return { ok: true, show: { type: "video", ytId: link.id, ...videoMeta(it) } };
  }
  if (link.type === "playlist") {
    if (!key) return viaOembed("playlist", link.id);
    const it = (await api(key, "playlists", { part: "snippet", id: link.id }))?.items?.[0];
    if (!it) return { ok: false, error: "playlist not found or private" };
    return { ok: true, show: { type: "playlist", ytId: link.id, ...playlistMeta(it) } };
  }
  if (!key) return { ok: false, error: "channels need the YouTube API key (YOUTUBE_API_KEY)" };
  const params = { part: "snippet,contentDetails" };
  if (link.handle) params.forHandle = link.handle;
  else if (link.channelId) params.id = link.channelId;
  else if (link.user) params.forUsername = link.user;
  else return { ok: false, error: "use the channel's @handle link" }; // custom /c/ URLs have no API lookup
  const it = (await api(key, "channels", params))?.items?.[0];
  if (!it) return { ok: false, error: "channel not found" };
  return { ok: true, show: { type: "channel", ytId: it.contentDetails.relatedPlaylists.uploads, ...channelMeta(it) } };
}

// ---------- Search ----------
//
// search.list costs 100 quota units (a lookup costs 1) against a default of
// 10,000 a day, so: the app searches only when a parent submits, results are
// cached for 6 hours, each parent gets 30 searches a day and everyone together
// 80, leaving room for adding shows and the daily refresh. Results are only
// shown; a show a parent adds goes through resolveLink like a pasted link.

const SEARCH_CACHE_AGE = 6 * 3600e3;
const SEARCH_PER_PARENT = 30;
const SEARCH_PER_DAY = 80;
const SEARCH_TYPES = ["video", "channel", "playlist"];
const NO_SEARCH = "Search isn't set up yet. You can still paste a link, or share one from the YouTube app.";
const SEARCH_LIMIT = "That's a lot of searching for one day. Try again tomorrow, or paste a link or share one from the YouTube app.";

// q: what the parent typed; type: video | channel | playlist.
// -> { ok, results: [{ type, ytId, title, by, thumb, link }] } | { ok: false, error }
export async function searchShows(env, request, user, q, type) {
  q = String(q || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);
  if (!SEARCH_TYPES.includes(type)) type = "video";
  if (!q) return { ok: true, results: [] };
  const region = /^[A-Z]{2}$/.test(request.cf?.country || "") ? request.cf.country : "";
  const key = [type, region, q].join(":");
  const cached = await env.DB.prepare("SELECT data, created_at FROM search_cache WHERE key = ?").bind(key).first();
  if (cached && Date.now() - cached.created_at < SEARCH_CACHE_AGE) return { ok: true, results: JSON.parse(cached.data) };

  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) return { ok: false, error: NO_SEARCH };
  // Only searches that reach YouTube count.
  await rateLimit(env, "search:" + user.id, SEARCH_PER_PARENT, DAY, SEARCH_LIMIT);
  await rateLimit(env, "search:all", SEARCH_PER_DAY, DAY, SEARCH_LIMIT);

  const params = { part: "snippet", q, type, maxResults: 20, safeSearch: "strict",
    fields: "items(id,snippet(title,channelTitle,thumbnails))" };
  if (type === "video") params.videoEmbeddable = "true";
  if (region) params.regionCode = region;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  let r;
  try { r = await fetch(url); } catch { return { ok: false, error: "Couldn't reach YouTube. Try again in a minute." }; }
  if (!r.ok) {
    const err = (await r.json().catch(() => null))?.error || {};
    const reason = (err.errors?.[0]?.reason || "") + " " + (err.message || "");
    console.error("search.list", r.status, reason);
    if (/quotaExceeded|dailyLimitExceeded/.test(reason)) return { ok: false, error: "Search is resting until tomorrow (YouTube's daily limit). You can still paste a link, or share one from the YouTube app." };
    if (/keyInvalid|keyExpired|API key|accessNotConfigured|Blocked|forbidden/.test(reason)) return { ok: false, error: NO_SEARCH };
    return { ok: false, error: "YouTube search isn't answering. Try again in a minute." };
  }
  const items = (await r.json()).items || [];
  // YouTube sometimes slips a channel into a video search; keep only the type asked for.
  const results = items.map(searchResult).filter((r) => r && r.type === type);
  await env.DB.prepare("INSERT OR REPLACE INTO search_cache (key, data, created_at) VALUES (?, ?, ?)")
    .bind(key, JSON.stringify(results), Date.now()).run();
  return { ok: true, results };
}

// search.list (unlike videos.list) sends titles HTML-escaped, e.g. "Kids&#39;".
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
const unescapeHtml = (s) => String(s || "").replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] !== "#" ? ENTITIES[e.toLowerCase()] ?? m
    : String.fromCodePoint(parseInt(e[1].toLowerCase() === "x" ? e.slice(2) : e.slice(1), e[1].toLowerCase() === "x" ? 16 : 10)));

// One search.list item -> a result with the link the add flow resolves.
function searchResult(it) {
  const id = it.id || {}, sn = it.snippet || {};
  const base = { title: unescapeHtml(sn.title).slice(0, 200), by: unescapeHtml(sn.channelTitle).slice(0, 100), thumb: thumbOf(sn) };
  if (id.videoId) return { type: "video", ytId: id.videoId, ...base, link: id.videoId };
  if (id.playlistId) return { type: "playlist", ytId: id.playlistId, ...base, link: "https://www.youtube.com/playlist?list=" + id.playlistId };
  // A channel show's ytId is its uploads list "UU…"; the channel is "UC…".
  if (/^UC[\w-]{22}$/.test(id.channelId || "")) return { type: "channel", ytId: "UU" + id.channelId.slice(2), ...base, by: "Channel", link: "https://www.youtube.com/channel/" + id.channelId };
  return null;
}

// ---------- Official endpoints ----------

async function api(key, path, params) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

const thumbOf = (sn) => (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.high || sn.thumbnails.default) || {}).url || "";
const videoMeta = (it) => ({ title: it.snippet.title, by: it.snippet.channelTitle, thumb: thumbOf(it.snippet) });
const playlistMeta = videoMeta;
const channelMeta = (it) => ({ title: it.snippet.title, by: "Channel", thumb: thumbOf(it.snippet) });

const OEMBED_PAGE = { video: "https://www.youtube.com/watch?v=", playlist: "https://www.youtube.com/playlist?list=" };

// oEmbed: { ok, meta } | { ok: false, gone } (gone: YouTube says it's missing or private).
async function oembed(type, id) {
  let r;
  try {
    r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(OEMBED_PAGE[type] + id));
  } catch { return { ok: false }; }
  if (!r.ok) return { ok: false, status: r.status, gone: r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404 };
  try {
    const o = await r.json();
    const thumb = type === "video" ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : o.thumbnail_url || "";
    return { ok: true, meta: { title: o.title, by: o.author_name, thumb } };
  } catch { return { ok: false }; }
}

async function viaOembed(type, id) {
  const o = await oembed(type, id);
  if (o.ok) return { ok: true, show: { type, ytId: id, ...o.meta } };
  if (type === "playlist") return { ok: false, error: "playlist not found or private" };
  return { ok: false, error: o.status === 401 || o.status === 403 ? "embedding blocked" : "not found" };
}

// Fresh metadata for many shows. Returns Map key -> meta, or key -> null when
// YouTube says the show is gone or private. Keys it couldn't check (network,
// quota, no API key for a channel) are left out.
async function fetchMeta(env, shows) {
  const out = new Map();
  const key = env.YOUTUBE_API_KEY;
  const byType = { video: [], playlist: [], channel: [] };
  for (const s of shows) if (byType[s.type]) byType[s.type].push(s.ytId);

  if (key) {
    const kinds = [
      ["video", "videos", (id) => id, videoMeta],
      ["playlist", "playlists", (id) => id, playlistMeta],
      // A channel show's ytId is its uploads list "UU…"; the channel is "UC…".
      ["channel", "channels", (id) => "UC" + id.slice(2), channelMeta],
    ];
    for (const [type, path, toApiId, toMeta] of kinds) {
      const ids = byType[type];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const d = await api(key, path, { part: "snippet", id: chunk.map(toApiId).join(",") });
        if (!d || !Array.isArray(d.items)) continue;
        const found = new Map(d.items.map((it) => [it.id, it]));
        for (const id of chunk) {
          const it = found.get(toApiId(id));
          out.set(type + ":" + id, it ? toMeta(it) : null);
        }
      }
    }
    return out;
  }

  // No API key: oEmbed, a few at a time. Channels can't be checked.
  const queue = [...byType.video.map((id) => ["video", id]), ...byType.playlist.map((id) => ["playlist", id])];
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (queue.length) {
      const [type, id] = queue.shift();
      const o = await oembed(type, id);
      if (o.ok) out.set(type + ":" + id, o.meta);
      else if (o.gone) out.set(type + ":" + id, null);
    }
  }));
  return out;
}

// ---------- yt_meta ----------

const putMetaStmt = (env, key, meta) =>
  env.DB.prepare("INSERT OR REPLACE INTO yt_meta (key, title, by_name, thumb, fetched_at) VALUES (?, ?, ?, ?, ?)")
    .bind(key, meta ? String(meta.title || "").slice(0, 200) || "YouTube" : null,
      meta ? String(meta.by || "").slice(0, 100) : null, meta ? String(meta.thumb || "").slice(0, 500) : null, Date.now());

// Re-fetches and stores metadata; shows YouTube calls gone are stored as such.
export async function refreshMeta(env, shows) {
  const fresh = await fetchMeta(env, shows);
  const stmts = [...fresh].map(([key, meta]) => putMetaStmt(env, key, meta));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return fresh;
}

// Map key -> { title, by, thumb } (title null = gone), only for rows under 30 days old.
async function getMeta(env, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const rows = await env.DB.prepare(
    "SELECT key, title, by_name, thumb FROM yt_meta WHERE key IN (SELECT value FROM json_each(?)) AND fetched_at > ?"
  ).bind(JSON.stringify(keys), Date.now() - META_MAX_AGE).all();
  for (const r of rows.results) out.set(r.key, { title: r.title, by: r.by_name || "", thumb: r.thumb || "" });
  return out;
}

const FALLBACK = { video: "YouTube video", playlist: "YouTube playlist", channel: "YouTube channel" };

// Attaches titles, channel names and thumbnails to a household's library.
// refresh: "inline" fetches missing ones before answering (parent app),
// "background" fetches them after (TV), with ctx, if gate() allows; anything
// else doesn't.
export async function withMeta(env, h, { refresh, ctx, gate } = {}) {
  const library = Array.isArray(h.library) ? h.library : [];
  const keys = [...new Set(library.map(metaKey))];
  const meta = await getMeta(env, keys);
  const missing = library.filter((s, i, a) => !meta.has(metaKey(s)) && a.findIndex((x) => metaKey(x) === metaKey(s)) === i).slice(0, 300);
  if (missing.length && refresh === "inline" && (!gate || await gate())) {
    for (const [k, v] of await refreshMeta(env, missing)) meta.set(k, v && { title: v.title, by: v.by || "", thumb: v.thumb || "" });
  } else if (missing.length && refresh === "background" && ctx && (!gate || await gate())) {
    ctx.waitUntil(refreshMeta(env, missing).catch((e) => console.error("meta refresh", e)));
  }
  return {
    ...h,
    library: library.map((s) => {
      const m = meta.get(metaKey(s));
      if (m && m.title) return { ...s, title: m.title, by: m.by, thumb: m.thumb };
      if (m === undefined) return { ...s, title: FALLBACK[s.type] || "YouTube", by: "", thumb: "" }; // not fetched yet
      return { ...s, title: "Not available on YouTube", by: "", thumb: "", unavailable: true };
    }),
  };
}

// ---------- Daily cron ----------

const META_FIELDS = ["title", "by", "thumb"];

export async function dailyRefresh(env) {
  const t = Date.now();
  await env.DB.prepare("DELETE FROM resolve_cache WHERE created_at < ?").bind(t - LINK_CACHE_AGE).run();
  await env.DB.prepare("DELETE FROM search_cache WHERE created_at < ?").bind(t - SEARCH_CACHE_AGE).run();

  // Every show any family uses. Households saved before yt_meta existed still
  // carry titles and thumbnails; strip them (only if nobody saved meanwhile).
  const used = new Map();
  const homes = await env.DB.prepare("SELECT id, data, version FROM households").all();
  for (const row of homes.results) {
    let h;
    try { h = JSON.parse(row.data); } catch { continue; }
    const library = Array.isArray(h.library) ? h.library : [];
    for (const s of library) if (s && s.type && s.ytId) used.set(metaKey(s), { type: s.type, ytId: s.ytId });
    if (library.some((s) => s && META_FIELDS.some((f) => f in s))) {
      h.library = library.map(({ title, by, thumb, ...ids }) => ids);
      await env.DB.prepare("UPDATE households SET data = ? WHERE id = ? AND version = ?")
        .bind(JSON.stringify(h), row.id, row.version).run();
    }
  }

  // Refresh what's in use and missing or 20+ days old, then delete anything past 30.
  const rows = await env.DB.prepare("SELECT key, fetched_at FROM yt_meta").all();
  const fetchedAt = new Map(rows.results.map((r) => [r.key, r.fetched_at]));
  const due = [...used].filter(([k]) => !(fetchedAt.get(k) > t - META_REFRESH_AGE)).map(([, s]) => s);
  const fresh = due.length ? await refreshMeta(env, due) : new Map();
  const expired = await env.DB.prepare("DELETE FROM yt_meta WHERE fetched_at < ?").bind(t - META_MAX_AGE).run();
  console.log(`yt_meta: ${used.size} in use, ${due.length} due, ${fresh.size} refreshed, ${expired.meta.changes} expired`);
}
