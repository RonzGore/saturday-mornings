// Thumbnail proxy: GET /api/thumb?u=<YouTube image URL>. YouTube's image hosts
// answer 429 when a TV or phone asks for a whole library of thumbnails at
// once; going through here, each image is fetched from YouTube once and then
// served from Cloudflare's cache (custom domain only: the Cache API does
// nothing on *.workers.dev) and from the browser's own cache.
//
// Only YouTube's image hosts are allowed, redirects included, so this can't be
// used as an open proxy.
const HOSTS = /^(i\d?\.ytimg\.com|yt3\.ggpht\.com|yt3\.googleusercontent\.com)$/;
const MAX_BYTES = 2 * 1024 * 1024;
// 23 days fresh + 7 stale: no cached copy outlives YouTube's 30-day limit.
const KEEP = "public, max-age=1987200, stale-while-revalidate=604800";

function allowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOSTS.test(u.hostname)) return null;
  u.hash = "";
  return u;
}

const fail = (status, maxAge) => new Response(null, { status, headers: {
  "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
  "access-control-allow-origin": "*",
} });

async function fetchUpstream(target) {
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetch(target.href, { redirect: "manual", headers: { accept: "image/*" } });
    if (r.status < 300 || r.status >= 400) return r;
    target = allowed(new URL(r.headers.get("location") || "", target).href);
    if (!target) return null;
  }
  return null;
}

export async function thumb(request, ctx, url) {
  const raw = url.searchParams.get("u") || "";
  const target = raw.length <= 500 && allowed(raw);
  if (!target) return fail(400, 0);

  // One cache entry per image, whatever else is on the query string.
  const key = new Request(`${url.origin}/api/thumb?u=${encodeURIComponent(target.href)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-thumb-cache", "hit");
    return res;
  }

  const r = await fetchUpstream(target);
  if (!r) return fail(400, 0);
  // Missing images stay missing for a while; rate limits and outages are retried.
  if (r.status === 404) return fail(404, 3600);
  if (!r.ok) return fail(502, 0);
  const type = r.headers.get("content-type") || "";
  if (!type.startsWith("image/") || Number(r.headers.get("content-length") || 0) > MAX_BYTES) return fail(502, 0);

  const body = await r.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return fail(502, 0);
  const res = new Response(body, { headers: {
    "content-type": type,
    "cache-control": KEEP,
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  } });
  ctx.waitUntil(cache.put(key, res.clone()));
  res.headers.set("x-thumb-cache", "miss");
  return res;
}
