// Saturday Mornings home server — runs on the Mac, no dependencies.
// Serves the TV app (/), the phone setup app (/setup/) and the settings API.
//   node home-server/server.js   then open http://<this-mac-ip>:8790/setup/ on your phone
var http = require("http");
var fs = require("fs");
var path = require("path");
var https = require("https");
var os = require("os");
var Schedule = require("../shared/schedule.js");

var PORT = process.env.PORT || 8790;
var REPO = path.join(__dirname, "..");
var DATA_FILE = path.join(__dirname, "data", "household.json");

var TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".xml": "text/xml"
};

function emptyHousehold() {
  return { version: 0, library: [], profiles: [] };
}

function readHousehold() {
  var h;
  try { h = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { return emptyHousehold(); }
  var clean = cleanHousehold(h); // also upgrades older saves
  clean.version = h.version || 0;
  clean.savedAt = h.savedAt;
  return clean;
}

function writeHousehold(h) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  var tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Only the TV app reads cross-origin (it runs from the TV, not this server),
// so CORS is allowed on GET only. Writes come from the same-origin setup page.
function send(res, status, body, type, allowCors) {
  var headers = { "Content-Type": type || "application/json", "Cache-Control": "no-store" };
  if (allowCors) headers["Access-Control-Allow-Origin"] = "*";
  res.writeHead(status, headers);
  res.end(body);
}

// Writes must come from this server's own pages: browsers always send Origin
// with a PUT, so a missing one means it wasn't our page.
function sameOrigin(req) {
  var origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

// Only answer to this computer's own names and addresses. A web page elsewhere
// can point its own domain at this computer ("DNS rebinding"); its requests
// then arrive with that domain in Host and are refused. Extra names (say, a
// router's DNS name) can be added with HOST_NAMES=name1,name2.
function knownHost(req) {
  var host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  var names = ["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase(), os.hostname().toLowerCase().replace(/\.local$/, "") + ".local"];
  (process.env.HOST_NAMES || "").split(",").forEach(function (n) { if (n.trim()) names.push(n.trim().toLowerCase()); });
  var nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) { nets[k].forEach(function (a) { names.push(a.address.toLowerCase()); }); });
  return names.indexOf(host) !== -1;
}

// Rebuilds the household from known fields only, so nothing unexpected is
// ever stored or shown on the phone or TV.
function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function idOk(v) { return typeof v === "string" && /^[a-z0-9]{1,20}$/i.test(v); }
function hmOk(v) { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
var THUMB_HOSTS = /^https:\/\/(i\d?\.ytimg\.com|yt3\.ggpht\.com|yt3\.googleusercontent\.com)\//;
var MAX_LIBRARY = 1000;

function cleanShow(it) {
  return {
    id: it.id,
    type: it.type,
    ytId: it.ytId,
    title: str(it.title, 200) || "YouTube",
    by: str(it.by, 100),
    thumb: THUMB_HOSTS.test(it.thumb) ? str(it.thumb, 500) : ""
  };
}

function cleanSlot(t, known) {
  return {
    id: t.id,
    name: str(t.name, 60),
    days: (Array.isArray(t.days) ? t.days : []).filter(function (d, i, a) {
      return d === (d | 0) && d >= 0 && d <= 6 && a.indexOf(d) === i;
    }),
    open: t.open,
    close: t.close,
    playMode: t.playMode === "continue" ? "continue" : "repeat",
    items: (Array.isArray(t.items) ? t.items : []).filter(function (id) { return known[id]; }).slice(0, 500)
  };
}

// Same rules as cloud/src/clean.js: the family's time zone, and a parent's
// override for today (off, or extra time on one slot).
function zoneOk(tz) {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 50) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
}
function cleanToday(t) {
  if (!t || typeof t.date !== "string" || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(t.date)) return undefined;
  if (t.off === true) return { date: t.date, off: true };
  if (t.more && idOk(t.more.slot) && hmOk(t.more.until)) return { date: t.date, more: { slot: t.more.slot, until: t.more.until } };
  return undefined;
}

function cleanHousehold(h) {
  if (!h || !Array.isArray(h.profiles)) throw new Error("bad shape");
  Schedule.migrateHousehold(h); // older saves: channel schedules -> slots, slot videos -> library
  var known = {};
  var library = h.library.filter(function (it) {
    var ok = it && idOk(it.id) && !known[it.id] && /^(video|channel|playlist)$/.test(it.type) &&
      typeof it.ytId === "string" && /^[\w-]{11,64}$/.test(it.ytId);
    if (ok) known[it.id] = true;
    return ok;
  }).slice(0, MAX_LIBRARY).map(cleanShow);
  return {
    timeZone: zoneOk(h.timeZone) ? h.timeZone : undefined,
    library: library,
    profiles: h.profiles.slice(0, 20).filter(function (p) { return p && idOk(p.id); }).map(function (p) {
      return {
        id: p.id,
        name: str(p.name, 40),
        emoji: str(p.emoji, 8),
        color: /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "#3554ff",
        allowSkip: p.allowSkip === true,
        today: cleanToday(p.today),
        channels: p.channels.slice(0, 20).filter(function (c) { return c && idOk(c.id); }).map(function (c) {
          return {
            id: c.id,
            name: str(c.name, 60) || "Shows",
            slots: (Array.isArray(c.slots) ? c.slots : []).slice(0, 100)
              .filter(function (t) { return t && idOk(t.id) && hmOk(t.open) && hmOk(t.close); })
              .map(function (t) { return cleanSlot(t, known); })
          };
        })
      };
    })
  };
}

// ---------- Turning a pasted YouTube link into a library show ----------

// GET a youtube.com page or API, following redirects within YouTube only.
function ytGet(url, cb, hops) {
  var u;
  try { u = new URL(url); } catch (e) { return cb(null); }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return cb(null);
  https.get(u, { headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept-Language": "en", "Cookie": "CONSENT=YES+1; SOCS=CAI"
  } }, function (r) {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (hops || 0) < 3) {
      r.resume();
      return ytGet(new URL(r.headers.location, u).toString(), cb, (hops || 0) + 1);
    }
    var buf = "";
    r.setEncoding("utf8");
    r.on("data", function (c) { buf += c; if (buf.length > 3e6) r.destroy(); });
    r.on("end", function () { cb({ status: r.statusCode, body: buf }); });
  }).on("error", function () { cb(null); });
}

function oembedFor(pageUrl, cb) {
  ytGet("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(pageUrl), function (r) {
    if (!r) return cb({ ok: false });
    if (r.status !== 200) return cb({ ok: false, status: r.status });
    try { cb({ ok: true, data: JSON.parse(r.body) }); } catch (e) { cb({ ok: false }); }
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// What kind of link is this? Returns { type, id } or { type: "channel", path }.
function parseLink(text) {
  text = String(text || "").trim();
  if (/^[\w-]{11}$/.test(text)) return { type: "video", id: text };
  if (/^@[\w.-]{2,100}$/.test(text)) return { type: "channel", path: "/" + text };
  var u;
  try { u = new URL(/^https?:\/\//.test(text) ? text : "https://" + text); } catch (e) { return null; }
  var host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    var short = u.pathname.slice(1, 12);
    return /^[\w-]{11}$/.test(short) ? { type: "video", id: short } : null;
  }
  if (host !== "youtube.com") return null;
  var v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return { type: "video", id: v };
  var m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
  if (m) return { type: "video", id: m[2] };
  var list = u.searchParams.get("list");
  if (list && /^[\w-]{12,64}$/.test(list)) return { type: "playlist", id: list };
  m = u.pathname.match(/^\/(@[\w.-]{2,100}|channel\/UC[\w-]{22}|c\/[\w.-]{1,100}|user\/[\w.-]{1,100})/);
  if (m) return { type: "channel", path: "/" + m[1] };
  return null;
}

function resolveLink(text, cb) {
  var link = parseLink(text);
  if (!link) return cb({ ok: false, error: "not a YouTube link" });

  if (link.type === "video") {
    return oembedFor("https://www.youtube.com/watch?v=" + link.id, function (o) {
      if (!o.ok) return cb({ ok: false, error: o.status === 401 || o.status === 403 ? "embedding blocked" : "not found" });
      cb({ ok: true, show: { type: "video", ytId: link.id, title: o.data.title, by: o.data.author_name,
                             thumb: "https://i.ytimg.com/vi/" + link.id + "/mqdefault.jpg" } });
    });
  }

  if (link.type === "playlist") {
    return oembedFor("https://www.youtube.com/playlist?list=" + link.id, function (o) {
      if (!o.ok) return cb({ ok: false, error: "playlist not found or private" });
      cb({ ok: true, show: { type: "playlist", ytId: link.id, title: o.data.title, by: o.data.author_name,
                             thumb: o.data.thumbnail_url } });
    });
  }

  // Channel: read the channel page for its ID, name and picture, then play
  // its uploads playlist (the channel ID with UC swapped for UU).
  ytGet("https://www.youtube.com" + link.path, function (r) {
    if (!r || r.status !== 200) return cb({ ok: false, error: "channel not found" });
    var idm = r.body.match(/"externalId":"(UC[\w-]{22})"/) ||
              r.body.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/) ||
              r.body.match(/\/channel\/(UC[\w-]{22})/);
    if (!idm) return cb({ ok: false, error: "channel not found" });
    var title = r.body.match(/<meta property="og:title" content="([^"]*)"/);
    var img = r.body.match(/<meta property="og:image" content="([^"]*)"/);
    cb({ ok: true, show: {
      type: "channel", ytId: "UU" + idm[1].slice(2),
      title: title ? decodeEntities(title[1]) : "YouTube channel", by: "Channel",
      thumb: img ? decodeEntities(img[1]) : ""
    } });
  });
}

// Only the apps' own public files are served — never data/, .git or the server.
// Each public path maps into the repository; no path part may start with a dot.
var PUBLIC = /^\/(index\.html|launch\.html|icon\.png|(js|css|setup|assets)(\/[\w-][\w.-]*)+)$/;
var ROUTES = [
  ["/js/schedule.js", "shared/schedule.js"],
  ["/index.html", "apps/tv/index.html"],
  ["/launch.html", "apps/tv-samsung/launch.html"],
  ["/icon.png", "apps/tv-samsung/icon.png"],
  ["/js/", "apps/tv/js/"],
  ["/css/", "apps/tv/css/"],
  ["/assets/", "shared/assets/"],
  ["/setup/", "apps/parent/"]
];

function repoFile(urlPath) {
  for (var i = 0; i < ROUTES.length; i++) {
    var from = ROUTES[i][0];
    if (urlPath === from || (from.slice(-1) === "/" && urlPath.indexOf(from) === 0)) {
      return path.join(REPO, ROUTES[i][1] + urlPath.slice(from.length));
    }
  }
  return null;
}

function serveStatic(req, res) {
  var urlPath;
  try { urlPath = decodeURIComponent(req.url.split("?")[0]); }
  catch (e) { return send(res, 400, "Bad request", "text/plain"); }
  // "/setup" without the slash would make the page's relative links miss.
  if (urlPath === "/setup") {
    res.writeHead(301, { Location: "/setup/" });
    return res.end();
  }
  if (urlPath === "/" || urlPath === "/setup/") {
    urlPath = urlPath === "/" ? "/index.html" : "/setup/index.html";
  }
  if (!PUBLIC.test(urlPath)) return send(res, 404, "Not found", "text/plain");
  var file = repoFile(urlPath);
  if (!file) return send(res, 404, "Not found", "text/plain");
  fs.readFile(file, function (err, buf) {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(file)] || "application/octet-stream");
  });
}

http.createServer(function (req, res) {
  if (process.env.LOG) console.log(new Date().toISOString().slice(11, 19), req.socket.remoteAddress, req.method, req.url.slice(0, 120));
  var u = req.url.split("?");
  if (!knownHost(req)) return send(res, 421, "Unknown host", "text/plain");

  if (u[0] === "/api/health") return send(res, 200, JSON.stringify({ ok: true }), null, true);
  if (u[0] === "/api/household" && req.method === "GET") {
    return send(res, 200, JSON.stringify(readHousehold()));
  }
  if (u[0] === "/api/household" && req.method === "PUT") {
    if (!sameOrigin(req)) return send(res, 403, JSON.stringify({ error: "forbidden" }));
    var body = "";
    req.on("data", function (c) { body += c; if (body.length > 3e6) req.destroy(); });
    req.on("end", function () {
      try {
        var input = JSON.parse(body);
        var current = readHousehold();
        // Another phone saved since this one loaded: refuse rather than overwrite.
        if (typeof input.baseVersion === "number" && input.baseVersion !== (current.version || 0)) {
          return send(res, 409, JSON.stringify(current));
        }
        var h = cleanHousehold(input);
        h.version = (current.version || 0) + 1;
        h.savedAt = new Date().toISOString();
        writeHousehold(h);
        send(res, 200, JSON.stringify(h));
      } catch (e) { send(res, 400, JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (u[0] === "/api/resolve" && req.method === "GET") {
    var q = new URLSearchParams(u[1] || "").get("link") || "";
    return resolveLink(q.slice(0, 500), function (r) { send(res, 200, JSON.stringify(r)); });
  }
  serveStatic(req, res);
}).listen(PORT, function () {
  var ips = [];
  var nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) {
    nets[k].forEach(function (n) { if (n.family === "IPv4" && !n.internal) ips.push(n.address); });
  });
  console.log("Saturday Mornings server running");
  ips.forEach(function (ip) {
    console.log("  Phone setup:  http://" + ip + ":" + PORT + "/setup/");
    console.log("  TV preview:   http://" + ip + ":" + PORT + "/");
  });
});
