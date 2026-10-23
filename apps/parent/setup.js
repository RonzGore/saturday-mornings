// Saturday Mornings: the parent app ("the family remote").
//
// Edits the household: a shared show library, and kids whose TV channel is a
// week of named programmes. Each programme is a block of TV time (days, a start
// and an end) with a lineup of shows that take turns.
//
// Storage keeps the original shape (profile → channels → slots) because the
// TV reads it. The screens never show that middle "channels" layer: a kid IS a
// channel (CH 1 Maya TV, exactly like the TV), and a kid's programmes are all
// the slots across its stored channels. New programmes go into the first one.
//
// On Cloudflare it lives at /app/ behind a parent sign-in and also manages
// TVs, family and account. On the Mac it's /setup/ with no accounts.
(() => {
  const S = window.Schedule;
  const API = "/api/household";
  const CLOUD = location.pathname.startsWith("/app");
  // Thumbnails go through the Worker's cache on Cloudflare (YouTube's image
  // host rate-limits bursts).
  const thumbSrc = (u) => (CLOUD ? `/api/thumb?u=${encodeURIComponent(u)}` : u);
  const WA = window.SimpleWebAuthnBrowser;
  const EMOJIS = ["🦁", "🐼", "🦊", "🐸", "🐵", "🦄", "🐯", "🐨", "🐙", "🦖", "🚀", "⚽"];
  const COLORS = ["#3554ff", "#ff6b3d", "#18a957", "#c040ff", "#ff3d7f", "#0aa5c2"];
  const COLOR_NAMES = ["Blue", "Orange", "Green", "Purple", "Pink", "Teal"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const BAR_COLORS = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  const MAX_LIBRARY = 1000;

  let household = { library: [], profiles: [] };
  let saveTimer = null;
  let saving = false; // a save is on its way to the server
  let selectedDay = new Date().getDay();
  let tvCache = null; // [{...tv}] once fetched (cloud)

  const $ = (sel) => document.querySelector(sel);
  const view = $("#view");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const color = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : COLORS[0]);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const go = (hash) => { location.hash = hash; };
  const count = (n, word, plural) => `${n} ${n === 1 ? word : plural || word + "s"}`;
  const phoneZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } };
  const clock = () => S.wallNow(household.timeZone);
  const bars = (cls) => `<div class="bars ${cls || ""}" aria-hidden="true">${BAR_COLORS.map((c) => `<i style="background:${c}"></i>`).join("")}</div>`;

  const ICON = {
    chev: `<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4 L13 10 L7 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    channels: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 2 L12 6 L16 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    guide: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9 H21 M9 9 V21" stroke="currentColor" stroke-width="2"/></svg>`,
    shows: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
    tvs: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21 H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7 H20 M4 17 H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="7" r="2.6" fill="var(--face-2)" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="17" r="2.6" fill="var(--face-2)" stroke="currentColor" stroke-width="2"/></svg>`,
    account: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21 C4 16 8 14 12 14 C16 14 20 16 20 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    up: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 12 L10 7 L15 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    more: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="4.5" r="1.9" fill="currentColor"/><circle cx="10" cy="10" r="1.9" fill="currentColor"/><circle cx="10" cy="15.5" r="1.9" fill="currentColor"/></svg>`,
    x: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5 L15 15 M15 5 L5 15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    pencil: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 L5 12 L13 4 L16 7 L8 15 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  };

  // Script errors go to the Worker's logs (cloud only, a few per visit).
  let reports = 0;
  if (CLOUD) window.addEventListener("error", (e) => {
    if (reports++ >= 5) return;
    fetch("/api/report", { method: "POST", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ where: "app", message: e.message, source: e.filename, line: e.lineno }) }).catch(() => {});
  });

  // ---------- Data ----------

  async function load() {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (CLOUD && r.status === 401) {
        location.href = "/?next=" + encodeURIComponent(location.pathname + location.hash);
        return new Promise(() => {});
      }
      household = await r.json();
      household.profiles = household.profiles || [];
      S.migrateHousehold(household);
    } catch (e) {
      view.innerHTML = `<div class="card"><b>Can't reach the station.</b><p class="sub">${CLOUD
        ? "Check your internet connection and try again."
        : "Is the Saturday Mornings server running on the Mac, and is this phone on the same Wi-Fi?"}</p>
        <button class="btn primary" id="retry">Try again</button></div>`;
      $("#retry").addEventListener("click", () => location.reload());
      throw e;
    }
  }

  function setSaved(text, bad) { const s = $("#saved"); s.textContent = text; s.classList.toggle("bad", !!bad); }

  function save() {
    setSaved("SAVING…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      saving = true;
      try {
        const r = await fetch(API, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseVersion: household.version || 0, timeZone: household.timeZone, library: household.library, profiles: household.profiles })
        });
        if (r.status === 409) {
          // Someone else saved first: take their version and redraw.
          household = S.migrateHousehold(await r.json());
          route();
          toast("Updated from another phone. Redo your last change.");
          setSaved("");
          return;
        }
        if (!r.ok) throw new Error();
        household.version = (await r.json()).version;
        setSaved("SAVED ✓");
        setTimeout(() => { if (!saveTimer && $("#saved").textContent === "SAVED ✓") setSaved(""); }, 2500);
      } catch (e) {
        setSaved("NOT SAVED", true);
        toast(CLOUD ? "Not saved: check your connection." : "Not saved: check the Wi-Fi.");
      } finally { saving = false; }
    }, 500);
  }

  // An in-app "are you sure?" box. Installed web apps often block the
  // browser's own confirm(), so every question goes through this instead.
  function ask(message, ok = "OK", danger = false) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "ask";
      d.innerHTML = `<p>${esc(message)}</p><div class="ask-actions">
        <button type="button" class="btn small" value="no">Cancel</button>
        <button type="button" class="btn small ${danger ? "danger" : "primary"}" value="yes">${esc(ok)}</button></div>`;
      const done = (v) => { d.close(); d.remove(); resolve(v); };
      d.querySelectorAll("button").forEach((b) => b.onclick = () => done(b.value === "yes"));
      d.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
      d.addEventListener("click", (e) => { if (e.target === d) done(false); }); // tap outside
      document.body.appendChild(d);
      d.showModal();
      d.querySelector("[value=yes]").focus();
    });
  }

  // An in-app menu: a short list of choices (same box as ask). Resolves to
  // the chosen value, or null for Cancel / tap outside.
  function choose(title, options) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "ask";
      d.innerHTML = `<p><b>${esc(title)}</b></p><div class="ask-menu">
        ${options.map((o) => `<button type="button" class="btn small" value="${esc(o.value)}" ${o.disabled ? "disabled" : ""}>${esc(o.label)}</button>`).join("")}
        <button type="button" class="btn small ghost" value="">Cancel</button></div>`;
      const done = (v) => { d.close(); d.remove(); resolve(v || null); };
      d.querySelectorAll("button").forEach((b) => b.onclick = () => done(b.value));
      d.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
      d.addEventListener("click", (e) => { if (e.target === d) done(null); });
      document.body.appendChild(d);
      d.showModal();
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  const byId = (list, id) => (list || []).find((x) => x.id === id);
  const lib = () => S.libraryMap(household);
  const label = (t) => S.slotLabel(t, lib());
  const chNum = (p) => household.profiles.indexOf(p) + 1;
  const tvName = (p) => `${p.name || "Kid"} TV`;

  // All of a kid's programmes, wherever they're stored.
  const programmes = (p) => p.channels.flatMap((c) => c.slots.map((t) => ({ c, t })));
  const findProgramme = (p, id) => programmes(p).find((x) => x.t.id === id);
  function homeChannel(p) {
    if (!p.channels.length) p.channels.push({ id: uid(), name: `${p.name || "Kid"}'s shows`, slots: [] });
    return p.channels[0];
  }
  // Programmes of this kid that share a day and overlap in time with t.
  function clashes(p, t) {
    return programmes(p).map((x) => x.t).filter((o) => o !== t && o.days.some((d) => t.days.includes(d)) && t.open < o.close && o.open < t.close);
  }

  function newProfile() {
    const n = household.profiles.length;
    const p = { id: uid(), name: "", emoji: EMOJIS[n % EMOJIS.length], color: COLORS[n % COLORS.length], allowSkip: false, channels: [] };
    household.profiles.push(p);
    return p;
  }

  const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const toHM = (min) => { min = Math.max(0, Math.min(min, 23 * 60 + 59)); return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); };

  // A new programme on a day, starting where that day's last one ends.
  function newProgramme(p, day) {
    const c = homeChannel(p);
    const sameDay = programmes(p).map((x) => x.t).filter((t) => t.days.includes(day));
    let start = sameDay.length ? Math.max(...sameDay.map((t) => toMin(t.close))) : toMin("15:30");
    start = Math.min(start, 23 * 60 + 29);
    const t = { id: uid(), name: "", days: [day], open: toHM(start), close: toHM(start + 30), playMode: "repeat", items: [] };
    c.slots.push(t);
    return t;
  }

  // ---------- Labels ----------

  function daysLabel(days) {
    const d = [...days].sort().join(",");
    if (d === "1,2,3,4,5") return "Weekdays";
    if (d === "0,6") return "Weekends";
    if (days.length === 7) return "Every day";
    if (!days.length) return "No days picked";
    if (days.length === 1) return DAY_NAMES[days[0]] + "s";
    return WEEK.filter((i) => days.includes(i)).map((i) => DAYS[i]).join(", ");
  }
  const hm2date = (hm) => { const [h, m] = hm.split(":").map(Number); return new Date(2000, 0, 1, h, m); };
  const timeLabel = (hm) => S.formatTime(hm2date(hm));
  const span = (t) => `${timeLabel(t.open)} – ${timeLabel(t.close)}`;
  // "8:00–8:45" with AM/PM once when both share it: "3:30–4:30 PM".
  function shortSpan(t) {
    const a = timeLabel(t.open), b = timeLabel(t.close);
    const [at, am] = a.split(" "), [bt, bm] = b.split(" ");
    return am === bm ? `${at}–${bt} ${bm}` : `${a}–${b}`;
  }
  const minutes = (t) => Math.max(0, toMin(t.close) - toMin(t.open));
  function lengthLabel(m) {
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : (h === 1 ? "1 hour" : `${h} hours`);
  }
  const KIND = { channel: "Channel", playlist: "Playlist", video: "Video" };
  const coverImg = (show, cls) => show && show.thumb
    ? `<img class="${cls || "cover"}" src="${esc(thumbSrc(show.thumb))}" alt="${esc(show.title)}" loading="lazy">`
    : `<span class="${cls || "cover"}" aria-hidden="true"></span>`;

  // ---------- Frame ----------

  function chrome(title, backTo, opts = {}) {
    $("#title").textContent = title;
    const back = $("#back");
    back.hidden = !backTo;
    back.onclick = () => go(backTo);
    $("#logo").style.display = backTo ? "none" : "";
    const badge = $("#ch-badge");
    badge.hidden = !opts.badge; badge.textContent = opts.badge || "";
    $("#top-extra").innerHTML = opts.extra || "";
    document.body.classList.toggle("no-tabs", opts.tabs === false);
    renderTabs(opts.tab);
    document.title = title === "Saturday Mornings" ? title : `${title} · Saturday Mornings`;
    window.scrollTo(0, 0);
  }

  function renderTabs(current) {
    const tabs = [["channels", "#/", "Channels", ICON.channels], ["guide", "#/guide", "Guide", ICON.guide], ["shows", "#/library", "Shows", ICON.shows]];
    if (CLOUD) tabs.push(["tvs", "#/tvs", "TVs", ICON.tvs]);
    $("#tabbar").innerHTML = tabs.map(([key, href, name, icon]) =>
      `<a class="tab" href="${href}" ${key === current ? 'aria-current="page"' : ""}>${icon}<span>${name}</span></a>`).join("");
  }

  // A parent's picture: their photo, an emoji on a colour, or their initials.
  let meInfo = null; // /api/me, loaded at start (cloud)
  const FACE_EMOJI = ["👩", "👨", "🧑", "👵", "👴", "🦸", "🧙", "🐻", "🦁", "🐼", "🦊", "🐸", "🌻", "⭐", "🚀", "☕"];
  function initials(email) {
    const parts = String(email || "?").split("@")[0].split(/[._\-+]+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }
  function faceHtml(av, email, cls = "") {
    if (av && av.kind === "photo") return `<span class="face ${cls}" aria-hidden="true"><img src="${esc(av.data)}" alt=""></span>`;
    if (av && av.kind === "emoji") return `<span class="face ${cls}" style="background:${esc(av.color)}" aria-hidden="true">${esc(av.emoji)}</span>`;
    let h = 0; for (const c of String(email || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="face initials ${cls}" style="background:${COLORS[h % COLORS.length]}" aria-hidden="true">${esc(initials(email))}</span>`;
  }
  const accountKey = () => !CLOUD ? "" : meInfo
    ? `<a class="face-key" href="#/account" aria-label="Account and family">${faceHtml(meInfo.avatar, meInfo.email)}</a>`
    : `<a class="icon-key" href="#/account" aria-label="Account and family">${ICON.account}</a>`;
  const stepsBar = (n, of) => `<div class="steps" aria-label="Step ${n} of ${of}">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</div>`;

  // ---------- Adding shows ----------

  // Resolves pasted links (videos, channels, playlists) into library shows, a
  // few at a time. If a programme is given, the shows go into it too.
  async function addShows(text, slot, progress) {
    const links = text.split(/[\s,]+/).filter(Boolean);
    const errors = { blocked: 0, notFound: 0, notLink: 0, full: 0, handle: 0, noChannels: 0 };
    const known = new Map(household.library.map((it) => [it.type + ":" + it.ytId, it]));
    const shows = [];
    let done = 0, added = 0;
    const queue = links.slice();
    async function worker() {
      while (queue.length) {
        const link = queue.shift();
        let r = { ok: false, error: "not found" };
        try { r = await (await fetch(`/api/resolve?link=${encodeURIComponent(link)}`)).json(); } catch (e) {}
        done++;
        if (progress) progress(done, links.length);
        if (!r.ok) {
          if (r.error === "embedding blocked") errors.blocked++;
          else if (r.error === "not a YouTube link") errors.notLink++;
          else if (/@handle/.test(r.error || "")) errors.handle++;
          else if (/API key/.test(r.error || "")) errors.noChannels++;
          else errors.notFound++;
          continue;
        }
        let show = known.get(r.show.type + ":" + r.show.ytId);
        if (!show) {
          if (household.library.length >= MAX_LIBRARY) { errors.full++; continue; }
          show = Object.assign({ id: uid() }, r.show);
          household.library.push(show);
          known.set(show.type + ":" + show.ytId, show);
          added++;
        }
        if (slot && !slot.items.includes(show.id)) slot.items.push(show.id);
        if (!shows.includes(show)) shows.push(show);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    save();
    const msgs = [];
    if (errors.blocked) msgs.push(`${errors.blocked} video${errors.blocked > 1 ? "s don't" : " doesn't"} allow playing in other apps`);
    if (errors.notFound) msgs.push(`${errors.notFound} couldn't be found`);
    if (errors.notLink) msgs.push(`${errors.notLink} ${errors.notLink > 1 ? "aren't YouTube links" : "isn't a YouTube link"}`);
    if (errors.handle) msgs.push("for a channel, use its @handle link (Share on the channel page)");
    if (errors.noChannels) msgs.push("channels can't be added right now; add some of its videos or playlists instead");
    if (errors.full) msgs.push(`library is full (${MAX_LIBRARY})`);
    return { added, shows, errors: msgs };
  }

  function removeFromLibrary(show) {
    household.library = household.library.filter((x) => x !== show);
    household.profiles.forEach((p) => p.channels.forEach((c) => c.slots.forEach((t) => {
      t.items = t.items.filter((id) => id !== show.id);
    })));
    save();
  }

  // YouTube search (cloud). Each search costs part of the day's YouTube quota,
  // so it runs when the parent taps Search, never while typing. Kept across
  // redraws.
  const find = { q: "", type: "channel", results: null, error: "" };
  const FIND_TYPES = [["channel", "Channels"], ["video", "Videos"], ["playlist", "Playlists"]];

  // The one way in: search (cloud), your library, or paste a link.
  // slot = add into this programme; null = add to the library only.
  function addShowsPanel(slot, opts = {}) {
    const tab = addTab.tab === "library" || !CLOUD ? "library" : "search";
    return `
      ${CLOUD ? `<div class="seg" role="group" aria-label="Where to find shows">
        <button type="button" data-addtab="search" aria-pressed="${tab === "search"}">Search YouTube</button>
        <button type="button" data-addtab="library" aria-pressed="${tab === "library"}">${slot ? `Your library (${household.library.length})` : `Your shows (${household.library.length})`}</button>
      </div>` : ""}
      <div id="add-body"></div>
      <details class="more" id="paste-more" ${!CLOUD && !household.library.length ? "open" : ""}>
        <summary>Have a YouTube link? Paste it</summary>
        <div class="card">
          <label class="vh" for="paste">YouTube links</label>
          <textarea id="paste" rows="3" placeholder="Paste YouTube links: videos, channels or playlists. One or many."></textarea>
          <button class="btn" id="add">Add</button>
          <p class="hint">In the YouTube app, tap <b>Share › Copy link</b>.${opts.hint ? " " + opts.hint : ""}</p>
          <p class="hint" id="paste-status" hidden></p>
        </div>
      </details>`;
  }
  const addTab = { tab: "search" };

  function wireAddShows(slot, rerender, onChange) {
    view.querySelectorAll("[data-addtab]").forEach((b) => b.onclick = () => { addTab.tab = b.dataset.addtab; rerender(); });
    const body = $("#add-body");
    const tab = addTab.tab === "library" || !CLOUD ? "library" : "search";
    if (tab === "search") renderSearch(body, slot, onChange); else renderLibraryPicker(body, slot, onChange);
    $("#add").onclick = async () => {
      const text = $("#paste").value;
      if (!text.trim()) return;
      const btn = $("#add");
      btn.disabled = true;
      const r = await addShows(text, slot, (d, n) => { btn.textContent = `Adding ${d} of ${n}…`; });
      btn.disabled = false; btn.textContent = "Add"; $("#paste").value = "";
      const st = $("#paste-status");
      st.hidden = false;
      st.className = r.errors.length ? "error" : "hint";
      st.textContent = `Added ${count(r.shows.length, "show")}.` + (r.errors.length ? " " + r.errors.join("; ") + "." : "");
      if (r.shows.length) { onChange(); renderInto(); }
    };
    function renderInto() { if (tab === "search") renderSearch(body, slot, onChange); else renderLibraryPicker(body, slot, onChange); }
  }

  function renderSearch(box, slot, onChange) {
    box.innerHTML = `
      <form class="find" id="find" role="search">
        <label class="vh" for="find-q">Search YouTube shows</label>
        <input type="search" id="find-q" value="${esc(find.q)}" placeholder="Search YouTube shows" enterkeyhint="search" autocomplete="off">
        <button class="btn dark" id="find-go">Search</button>
      </form>
      <div class="seg" role="group" aria-label="Kind of show">${FIND_TYPES.map(([t, name]) =>
        `<button type="button" data-ftype="${t}" aria-pressed="${t === find.type}">${name}</button>`).join("")}</div>
      <div id="find-results"></div>`;
    const out = $("#find-results");
    const draw = () => {
      if (find.error) { out.innerHTML = `<p class="error">${esc(find.error)}</p>`; return; }
      if (!find.results) {
        out.innerHTML = `<p class="hint">${find.type === "channel"
          ? "Tip: a whole channel (like Peppa Pig) plays a different full episode each time."
          : find.type === "playlist" ? "A playlist plays one video each time, in order." : "A single video plays the same video each time."}</p>`;
        return;
      }
      const known = new Map(household.library.map((it) => [it.type + ":" + it.ytId, it]));
      out.innerHTML = find.results.length ? `<ul class="results" aria-label="Results">${find.results.map((r, i) => {
        const have = known.get(r.type + ":" + r.ytId);
        const inIt = have && (slot ? slot.items.includes(have.id) : true);
        return `<li class="result">
          <span class="frame ${r.type === "channel" ? "round" : ""}">${r.thumb ? `<img src="${esc(thumbSrc(r.thumb))}" alt="" loading="lazy">` : ""}</span>
          <span class="grow"><b>${esc(r.title)}</b><span class="sub">${esc(KIND[r.type] || "")}${r.by && r.type !== "channel" ? " · " + esc(r.by) : ""}</span></span>
          <button type="button" class="add-key ${inIt ? "added" : ""}" data-fadd="${i}" aria-label="${inIt ? "Remove " : "Add "}${esc(r.title)}">${inIt ? "✓ Added" : "Add"}</button>
        </li>`;
      }).join("")}</ul>` : `<div class="empty">Nothing found. Try other words.</div>`;
      out.querySelectorAll("[data-fadd]").forEach((b) => b.onclick = async () => {
        const r = find.results[Number(b.dataset.fadd)];
        const have = household.library.find((it) => it.type === r.type && it.ytId === r.ytId);
        if (have && slot && slot.items.includes(have.id)) { // tap again: take it out of this programme
          slot.items = slot.items.filter((id) => id !== have.id); save(); onChange(); draw(); return;
        }
        if (have && !slot) return; // already in the library
        b.disabled = true; b.textContent = "Adding…";
        const res = await addShows(r.link, slot);
        if (!res.shows.length) {
          b.outerHTML = `<span class="fail">${esc(res.errors.join("; ") || "Couldn't add")}</span>`;
          return;
        }
        onChange(); draw();
      });
    };
    const search = async () => {
      find.q = $("#find-q").value.trim();
      if (!find.q) return;
      $("#find-q").blur(); // put the phone keyboard away so the results show
      out.innerHTML = `<div class="empty mono" style="font-size:22px">SEARCHING…</div>`;
      try {
        const r = await call("GET", `/api/search?type=${find.type}&q=${encodeURIComponent(find.q)}`);
        find.results = r.ok ? r.results : null;
        find.error = r.ok ? "" : r.error;
      } catch (e) { find.results = null; find.error = e.message; }
      draw();
    };
    $("#find").onsubmit = (e) => { e.preventDefault(); search(); };
    box.querySelectorAll("[data-ftype]").forEach((b) => b.onclick = () => {
      find.type = b.dataset.ftype;
      box.querySelectorAll("[data-ftype]").forEach((x) => x.setAttribute("aria-pressed", x === b));
      find.results = null; find.error = "";
      if ($("#find-q").value.trim()) search(); else draw();
    });
    draw();
  }

  // Library shows, newest first; with a programme, taps put shows in or out.
  let libraryQuery = "";
  function renderLibraryPicker(box, slot, onChange) {
    const filterBox = household.library.length > 8
      ? `<label class="vh" for="libq">Filter your shows</label><input type="search" id="libq" placeholder="Filter ${household.library.length} shows" value="${esc(libraryQuery)}" autocomplete="off" style="margin-bottom:12px">` : "";
    box.innerHTML = `${filterBox}<div class="lib-grid" id="grid"></div>
      ${slot ? "" : `<p class="hint">Tap a show to remove it from your library.</p>`}`;
    const grid = () => {
      const q = libraryQuery.trim().toLowerCase();
      const list = household.library.slice().reverse().filter((it) => !q || (it.title + " " + (it.by || "")).toLowerCase().includes(q));
      $("#grid").innerHTML = list.map((it) => {
        const on = slot && slot.items.includes(it.id);
        return `<button type="button" class="show-card" data-show="${esc(it.id)}" ${slot ? `aria-pressed="${!!on}"` : ""} aria-label="${slot ? (on ? "Take out " : "Put in ") : "Remove "}${esc(it.title)}">
          <span class="frame">${it.thumb ? `<img src="${esc(thumbSrc(it.thumb))}" alt="" loading="lazy">` : ""}</span>
          ${it.type !== "video" ? `<span class="kind">${KIND[it.type]}</span>` : ""}
          ${slot ? `<span class="mark" aria-hidden="true">${on ? "✓" : "+"}</span>` : ""}
          <span class="title">${esc(it.title)}</span></button>`;
      }).join("") || `<div class="empty" style="grid-column:1/-1">${household.library.length ? "No matches." : CLOUD ? "No shows yet. Search YouTube to add some." : "No shows yet. Paste some links below."}</div>`;
      view.querySelectorAll("[data-show]").forEach((b) => b.onclick = async () => {
        const show = byId(household.library, b.dataset.show);
        if (!show) return;
        if (slot) {
          slot.items = slot.items.includes(show.id) ? slot.items.filter((x) => x !== show.id) : [...slot.items, show.id];
          save(); onChange(); grid();
        } else if (await ask(`Remove "${show.title}" from your shows? It also comes out of any programmes.`, "Remove", true)) {
          removeFromLibrary(show); onChange(); grid();
        }
      });
    };
    const q = $("#libq");
    if (q) q.addEventListener("input", (e) => { libraryQuery = e.target.value; grid(); });
    grid();
  }

  // ---------- Screens: Channels (home) ----------

  async function home() {
    chrome("Saturday Mornings", null, { tab: "channels", extra: accountKey() });
    // Drop kids abandoned halfway through setting up.
    household.profiles = household.profiles.filter((p) => p.name || programmes(p).length);
    const ps = household.profiles;
    if (!ps.length) {
      view.innerHTML = `
        <div class="hero">
          <div class="tv-art" aria-hidden="true"><div class="ant"></div><div class="box"><div class="scr">${bars()}</div>
            <span class="knob" style="top:24px;background:var(--sun)"></span><span class="knob" style="top:50px;background:#1E9BD7"></span></div></div>
          <h1>Your station is off air</h1>
          <p class="lead">Give each kid their own TV channel. You pick the shows and the times. When time's up, the station signs off. Not you.</p>
        </div>
        <button class="btn primary" id="start">Set up the first channel</button>
        <div id="invites"></div>`;
      $("#start").onclick = () => { const p = newProfile(); go(`#/new/${p.id}`); };
      showInvites();
      return;
    }
    const now = clock();
    const L = lib();
    const status = ps.map((p) => {
      const live = S.onAirChannels(p, now, {});
      const onSlot = live.length ? S.activeSlot(p, live[0], now, {}) : null;
      return { p, onSlot, next: S.nextShowing(p, now), today: S.todayOf(p, now) };
    });
    const onNow = status.filter((s) => s.onSlot);
    const soonest = status.filter((s) => s.next && !s.onSlot).sort((a, b) => a.next.open - b.next.open)[0];
    const firstShow = (t) => L[t.items[0]];

    let panel;
    if (onNow.length) {
      const s = onNow[0], show = firstShow(s.onSlot);
      panel = `
        <div class="now-row">
          <span class="tv-mini">${show && show.thumb ? `<img src="${esc(thumbSrc(show.thumb))}" alt="">` : ""}<span class="live-tag">LIVE</span></span>
          <span class="what"><span>On air · CH ${chNum(s.p)}</span><b>${esc(label(s.onSlot))}</b></span>
        </div>
        <div class="lcd">
          ${onNow.map((o) => `<div class="row"><div class="l1">NOW ON CH ${chNum(o.p)}</div>
            <div class="l2">${esc(tvName(o.p))} · ${esc(label(o.onSlot))}</div>
            <div class="l3">UNTIL ${S.formatTime(S.slotClosesAt(o.onSlot, now, {}, o.p))}</div></div>`).join("")}
        </div>`;
    } else {
      panel = `<div class="lcd"><div class="l1">ALL CHANNELS OFF AIR</div>
        ${soonest ? `<div class="l2">NEXT: ${esc(tvName(soonest.p))}</div>
          <div class="l3">${esc(label(soonest.next.slot))} · ${S.dayWord(soonest.next.open, now).toUpperCase()} ${S.formatTime(soonest.next.open)}</div>`
        : `<div class="l2">NOTHING SCHEDULED</div><div class="l3">ADD A PROGRAMME TO A CHANNEL</div>`}</div>`;
    }

    view.innerHTML = `
      <div id="invites"></div>
      <section class="panel" aria-label="What's on now">
        <div class="panel-head"><span>The station</span><span class="${onNow.length ? "on" : ""}">${onNow.length ? "● On air" : "Off air"}</span></div>
        ${panel}
        ${bars()}
      </section>
      <div id="tv-status"></div>
      <h2>Channels</h2>
      ${status.map(({ p, onSlot, next, today }) => {
        const shown = onSlot || (next && next.slot);
        const show = shown && firstShow(shown);
        const line = today && today.off ? "Turned off for today"
          : onSlot ? `<span class="on-dot"></span>On air · ${esc(label(onSlot))}`
          : next ? `Next: ${esc(label(next.slot))} · ${S.dayWord(next.open, now)} ${S.formatTime(next.open)}`
          : programmes(p).length ? "Add shows to a programme" : "No programmes yet";
        return `<a class="key" href="#/k/${esc(p.id)}">
            <span class="ch-badge">CH ${chNum(p)}</span>
            <span class="avatar" style="background:${color(p.color)}" aria-hidden="true">${esc(p.emoji)}</span>
            <span class="grow"><b>${esc(tvName(p))}</b><span class="sub">${line}</span></span>
            ${show ? coverImg(show) : ""}${ICON.chev}</a>
          ${todayControls(p, now, onSlot)}`;
      }).join("")}
      <button class="btn ghost" id="add-kid">+ New channel for another kid</button>
      <h2>Shows</h2>
      <a class="key" href="#/library">
        <span class="avatar" style="background:var(--face);color:var(--sun)" aria-hidden="true">${ICON.shows.replace("<svg", '<svg width="24" height="24"')}</span>
        <span class="grow"><b>Show library</b><span class="sub">${count(household.library.length, "show")}: channels, playlists and videos</span></span>${ICON.chev}</a>
      <p class="hint" style="text-align:center">Changes reach the TV within 30 seconds.</p>`;
    wireTodayControls();
    $("#add-kid").onclick = () => { const p = newProfile(); go(`#/new/${p.id}`); };
    showInvites();
    if (CLOUD) tvStatus($("#tv-status"));
  }

  // The red light: no TV linked yet. Green: a TV checked in recently.
  async function tvStatus(box) {
    try { tvCache = (await call("GET", "/api/tvs")).tvs; } catch (e) { return; }
    if (!box.isConnected) return;
    if (!tvCache.length) {
      box.innerHTML = `<a class="key status-key" href="#/link"><span class="led"></span>
        <span class="grow"><b>No TV linked yet</b><span class="sub">Your channels need a TV to play on</span></span><span class="pill">Link</span></a>`;
      return;
    }
    const fresh = tvCache.filter((t) => t.last_seen_at && Date.now() - t.last_seen_at < 10 * 60e3);
    const t = fresh[0] || tvCache[0];
    box.innerHTML = `<a class="key" href="#/tvs"><span class="led ${fresh.length ? "green" : "dim"}"></span>
      <span class="grow"><b>${tvCache.length === 1 ? esc(t.name) : count(tvCache.length, "TV") + " linked"}</b>
      <span class="sub">${fresh.length ? "Tuned in · seen " + ago(t.last_seen_at) : "Last seen " + ago(t.last_seen_at)}</span></span>${ICON.chev}</a>`;
  }

  // Invites from another parent wait here until accepted (never automatic).
  async function showInvites() {
    if (!CLOUD) return;
    let fam;
    try { fam = await call("GET", "/api/family"); } catch (e) { return; }
    const box = $("#invites");
    if (!box || !fam.invitedTo.length) return;
    box.innerHTML = fam.invitedTo.map((i) => `<div class="card">
      <b>${esc(i.from)} invited you to their family</b>
      <p class="sub">Join to manage the same kids, shows and TVs.${household.profiles.length ? ` What you've set up here (${count(household.profiles.length, "kid")}) will be replaced.` : ""}</p>
      <button class="btn primary" data-join="${esc(i.householdId)}">Join their family</button></div>`).join("");
    box.querySelectorAll("[data-join]").forEach((b) => b.onclick = async () => {
      if (household.profiles.length && !(await ask("Join their family? What you've set up here will be deleted.", "Join", true))) return;
      try { await call("POST", "/api/family/join", { householdId: b.dataset.join }); location.href = "/app/"; }
      catch (e) { toast(e.message); }
    });
  }

  // ---------- Today's overrides: extra time, or off for the rest of the day ----------

  const EXTRA_MINUTES = 10;

  // The programme to give extra time to: the one on now, or one that ended in
  // the last hour (extra time then brings it back on).
  function extraSlot(p, now, onSlot) {
    if (onSlot) return onSlot;
    let best = null;
    for (const { t } of programmes(p)) {
      const w = S.windowOn(t, now);
      if (!w || !t.items.length) continue;
      const ended = S.slotClosesAt(t, now, {}, p);
      if (ended <= now && now - ended < 3600e3 && (!best || ended > best.ended)) best = { t, ended };
    }
    return best && best.t;
  }

  function todayControls(p, now, onSlot) {
    const today = S.todayOf(p, now);
    if (today && today.off) return `<div class="today"><button class="chip" data-on="${esc(p.id)}">Turn back on</button></div>`;
    const t = extraSlot(p, now, onSlot);
    if (!t) return "";
    return `<div class="today">
      <button class="chip" data-more="${esc(p.id)}" data-slot="${esc(t.id)}">+${EXTRA_MINUTES} min${onSlot ? "" : ` of ${esc(label(t))}`}</button>
      ${onSlot ? `<button class="chip" data-off="${esc(p.id)}">Off for today</button>` : ""}
    </div>`;
  }

  function wireTodayControls() {
    const done = (msg) => { save(); home(); toast(msg); };
    view.querySelectorAll("[data-more]").forEach((b) => b.onclick = () => {
      const p = byId(household.profiles, b.dataset.more), now = clock();
      const x = findProgramme(p, b.dataset.slot);
      if (!x) return;
      const from = Math.max(now, S.slotClosesAt(x.t, now, {}, p));
      const until = new Date(from + EXTRA_MINUTES * 60e3);
      // Extra time ends at midnight at the latest.
      const hm = until.getDate() !== now.getDate() ? "23:59" : toHM(until.getHours() * 60 + until.getMinutes());
      p.today = { date: S.dateKey(now), more: { slot: x.t.id, until: hm } };
      done(`+${EXTRA_MINUTES} minutes on ${tvName(p)}`);
    });
    view.querySelectorAll("[data-off]").forEach((b) => b.onclick = () => {
      const p = byId(household.profiles, b.dataset.off);
      p.today = { date: S.dateKey(clock()), off: true };
      done(`${tvName(p)} is off for today`);
    });
    view.querySelectorAll("[data-on]").forEach((b) => b.onclick = () => {
      const p = byId(household.profiles, b.dataset.on);
      delete p.today;
      done(`${tvName(p)} is back on`);
    });
  }

  // ---------- Screens: Guide (every channel, one day) ----------

  function guideScreen() {
    chrome("TV guide", null, { tab: "guide", extra: accountKey() });
    const render = () => {
      const now = clock();
      const day = new Date(now.getTime());
      day.setDate(day.getDate() + ((selectedDay - now.getDay() + 7) % 7));
      const L = lib();
      const isToday = selectedDay === now.getDay();
      view.innerHTML = `
        ${dayKeys((i) => household.profiles.some((p) => S.dayGuide(p, dayFor(i), now).length))}
        <div class="day-head"><h2>${isToday ? "Today" : DAY_NAMES[selectedDay]}</h2><span class="sub">${household.profiles.length ? count(household.profiles.length, "channel") : ""}</span></div>
        ${household.profiles.map((p) => {
          const rows = S.dayGuide(p, day, now);
          return `<section class="card" aria-label="${esc(tvName(p))}">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
              <span class="ch-badge">CH ${chNum(p)}</span><span class="avatar" style="width:36px;height:36px;font-size:20px;background:${color(p.color)}" aria-hidden="true">${esc(p.emoji)}</span>
              <b style="flex:1">${esc(tvName(p))}</b><a class="link-btn" href="#/k/${esc(p.id)}">Edit</a></div>
            ${rows.map((r) => `<div class="line-item">
              <span class="time-chip" style="font-size:20px">${shortSpan(r.slot)}</span>
              <span class="grow"><b>${esc(label(r.slot))}</b><span class="sub">${isToday ? (r.status === "now" ? '<span class="on-dot"></span>On air now' : r.status === "done" ? "Done for today" : "Later today") : daysLabel(r.slot.days)}</span></span>
              ${coverImg(L[r.slot.items[0]])}</div>`).join("") || `<div class="gap-row" style="margin:6px 0">${bars("strip")} Off air all day</div>`}
          </section>`;
        }).join("") || `<div class="empty">No channels yet. Set one up on the Channels tab.</div>`}`;
      wireDayKeys(render);
    };
    render();
  }

  const dayFor = (i) => { const now = clock(); const d = new Date(now.getTime()); d.setDate(d.getDate() + ((i - now.getDay() + 7) % 7)); return d; };
  function dayKeys(hasShows) {
    const today = new Date().getDay();
    return `<div class="days" role="group" aria-label="Day">${WEEK.map((i) => `<button type="button" class="day ${i === 0 || i === 6 ? "we" : ""}" data-tab="${i}" aria-pressed="${i === selectedDay}" aria-label="${DAY_NAMES[i]}">
      ${DAYS[i].toUpperCase()}${i === today ? "<small>today</small>" : ""}${hasShows && hasShows(i) ? '<i class="has" aria-hidden="true"></i>' : ""}</button>`).join("")}</div>`;
  }
  function wireDayKeys(render) {
    view.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { selectedDay = Number(b.dataset.tab); render(); });
  }

  // ---------- Screens: one kid's channel (the week) ----------

  function channelScreen(p) {
    chrome(tvName(p), "#/", { badge: `CH ${chNum(p)}`, tab: "channels",
      extra: `<a class="icon-key" href="#/k/${esc(p.id)}/settings" aria-label="Channel settings">${ICON.gear}</a>` });
    const render = () => {
      const now = clock();
      const day = selectedDay;
      const L = lib();
      const all = programmes(p).map((x) => x.t);
      const list = all.filter((t) => t.days.includes(day)).sort((a, b) => a.open.localeCompare(b.open));
      const total = list.reduce((m, t) => m + minutes(t), 0);
      const isToday = day === now.getDay();
      const nowHM = toHM(now.getHours() * 60 + now.getMinutes());
      let html = "", prevClose = null;
      list.forEach((t) => {
        if (prevClose && t.open > prevClose) html += `<div class="gap-row">${bars("strip")} Off air ${timeLabel(prevClose)} – ${timeLabel(t.open)}</div>`;
        const live = isToday && t.open <= nowHM && nowHM < t.close && t.items.length;
        const shows = t.items.map((id) => L[id]).filter(Boolean);
        const clash = clashes(p, t);
        html += `<a class="cassette" href="#/k/${esc(p.id)}/s/${esc(t.id)}">
          <span class="label">
            <span class="top">${live ? `<span class="led" style="width:9px;height:9px"></span><span class="tag live">On air now</span>` : `<span class="tag">${esc(daysLabel(t.days))}</span>`}
              <span style="flex:1"></span>${live ? esc(daysLabel(t.days)) : t.playMode === "continue" ? "Continues like a series" : ""}</span>
            <span class="mid"><span class="name">${esc(t.name || label(t))}</span><span class="time-chip">${shortSpan(t)}</span></span>
            ${shows.length ? `<span class="lineup">${shows.slice(0, 4).map((s) => coverImg(s)).join("")}
                <span class="more">${count(shows.length, "show")}${shows.length > 1 ? "<br>take turns" : ""}</span></span>`
              : `<span class="warn">No shows yet: it stays off air. Tap to add some.</span>`}
            ${clash.length ? `<span class="warn">Overlaps ${esc(clash.map((o) => o.name || label(o)).join(", "))}</span>` : ""}
          </span></a>`;
        prevClose = !prevClose || t.close > prevClose ? t.close : prevClose;
      });
      view.innerHTML = `
        ${dayKeys((i) => all.some((t) => t.days.includes(i) && t.items.length))}
        <div class="day-head"><h2>${isToday ? "Today" : DAY_NAMES[day]} on ${esc(tvName(p))}</h2>
          <span class="sub">${total ? lengthLabel(total) + " of TV" : ""}</span></div>
        ${html ? html + `<div class="gap-row">${bars("strip")} Signs off at ${timeLabel(prevClose)}. Goodnight!</div>`
          : `<div class="card flat empty">${bars("strip")}<p style="margin:10px 0 0">Nothing on ${DAY_NAMES[day]}: the TV stays off air.</p></div>`}
        <div class="sticky-bar"><button class="btn primary" id="add-prog">+ New programme${list.length ? "" : " on " + DAY_NAMES[day]}</button></div>`;
      wireDayKeys(render);
      $("#add-prog").onclick = () => { const t = newProgramme(p, day); save(); go(`#/k/${p.id}/s/${t.id}`); };
    };
    render();
  }

  // Channel settings: who's watching, skip, remove.
  function kidFields(p) {
    return `
      <div style="display:flex;gap:14px;align-items:center">
        <span class="avatar big" style="background:${color(p.color)}" aria-hidden="true">${esc(p.emoji)}</span>
        <label class="field" style="flex:1;margin:0"><span>Kid's name</span>
          <input type="text" id="kid-name" value="${esc(p.name)}" placeholder="e.g. Maya" autocomplete="off" autocapitalize="words"></label>
      </div>
      <p class="hint" id="tv-name-hint">The channel is called <b>${esc(tvName(p))}</b> on the TV.</p>
      <div class="emojis" role="group" aria-label="Picture">${EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-pressed="${e === p.emoji}">${e}</button>`).join("")}</div>
      <div class="colors" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-color="${c}" aria-pressed="${c === p.color}" style="background:${c}" aria-label="${COLOR_NAMES[i]}"></button>`).join("")}</div>`;
  }
  function wireKid(p, rerender) {
    $("#kid-name").addEventListener("input", (e) => {
      p.name = e.target.value.trim(); save();
      const h = $("#tv-name-hint"); if (h) h.innerHTML = `The channel is called <b>${esc(tvName(p))}</b> on the TV.`;
    });
    view.querySelectorAll("[data-emoji]").forEach((b) => b.onclick = () => { p.emoji = b.dataset.emoji; save(); rerender(); });
    view.querySelectorAll("[data-color]").forEach((b) => b.onclick = () => { p.color = b.dataset.color; save(); rerender(); });
  }

  function settingsScreen(p) {
    chrome("Channel settings", `#/k/${p.id}`, { badge: `CH ${chNum(p)}`, tabs: false });
    const render = () => {
      view.innerHTML = `
        <div class="card">${kidFields(p)}</div>
        <div class="card switch-row">
          <div class="grow"><b>Can skip to the next show</b><div class="sub">Off: the remote can only pause. On: it can also skip.</div></div>
          <label class="switch"><span class="vh">Can skip to the next show</span><input type="checkbox" id="skip" ${p.allowSkip ? "checked" : ""}><i></i></label>
        </div>
        <button class="btn primary" id="done">Done</button>
        <button class="btn danger" id="del">Remove ${esc(tvName(p))}</button>`;
      wireKid(p, render);
      $("#skip").onchange = (e) => { p.allowSkip = e.target.checked; save(); };
      $("#done").onclick = () => go(`#/k/${p.id}`);
      $("#del").onclick = async () => {
        if (!(await ask(`Remove ${tvName(p)} and all its programmes?`, "Remove", true))) return;
        household.profiles = household.profiles.filter((x) => x !== p); save(); go("#/");
      };
    };
    render();
  }

  // ---------- Screens: a programme (the VCR timer) ----------

  const QUICK = ["07:00", "08:00", "15:30", "19:30"];
  const LENGTHS = [30, 45, 60, 90];
  const NAME_IDEAS = ["Morning cartoons", "After school", "Bedtime stories", "Saturday special"];

  const MIN_LEN = 5;
  function setTimes(t, open, len) {
    let o = toMin(open);
    len = Math.max(MIN_LEN, Math.min(len, 6 * 60));
    if (o + len > 23 * 60 + 59) o = 23 * 60 + 59 - len; // keep the end on the same day
    t.open = toHM(o); t.close = toHM(o + len);
  }
  // Moves the off-air time and keeps the start, at least 5 minutes later.
  function setClose(t, close) {
    const o = toMin(t.open);
    t.close = toHM(Math.max(o + MIN_LEN, Math.min(toMin(close), 23 * 60 + 59)));
  }

  // One row of the timer: − key, the time (tap it for the phone's own time
  // picker, exact to the minute), + key. Tap a key for 1 minute; hold it and
  // it repeats, then speeds up to 5-minute jumps.
  function timerRow(which, hm, title) {
    return `<div class="timer-row">
        <button type="button" class="timer-step" data-step="${which}" data-dir="-1" aria-label="${title} 1 minute earlier">−</button>
        <label class="lcd timer-lcd ${which}"><span class="cap">${title}</span><span class="big">${timeLabel(hm)}</span>
          <input type="time" class="time-pick" data-pick="${which}" value="${hm}" aria-label="${title}, exact time"></label>
        <button type="button" class="timer-step" data-step="${which}" data-dir="1" aria-label="${title} 1 minute later">+</button>
      </div>`;
  }

  function timerFields(p, t) {
    const len = minutes(t);
    return `
      <section class="timer" aria-label="When it comes on">
        <div class="panel-head"><span>Timer</span><span class="on">${lengthLabel(len)} on air</span></div>
        ${timerRow("open", t.open, "On air")}
        ${timerRow("close", t.close, "Off air")}
        <p class="timer-hint">Tap a time to set it exactly. Tap − + for a minute, hold to go faster.</p>
        <div class="quick" role="group" aria-label="Quick start times">${QUICK.map((q) => `<button type="button" class="chip" data-quick="${q}" aria-pressed="${q === t.open}">${timeLabel(q).toLowerCase()}</button>`).join("")}</div>
      </section>
      <span class="label">On air for</span>
      <div class="lengths" role="group" aria-label="How long">${LENGTHS.map((m) => `<button type="button" class="chip" data-len="${m}" aria-pressed="${m === len}">${m < 60 ? m + " min" : m === 60 ? "1 hr" : "1½ hr"}</button>`).join("")}</div>
      <div class="day-head" style="margin-top:8px"><span class="label" style="margin:0">Which days</span><span class="sub">${daysLabel(t.days)}</span></div>
      <div class="days" role="group" aria-label="Which days">${WEEK.map((i) => `<button type="button" class="day ${i === 0 || i === 6 ? "we" : ""}" data-day="${i}" aria-pressed="${t.days.includes(i)}" aria-label="${DAY_NAMES[i]}">${DAYS[i][0]}</button>`).join("")}</div>
      <div class="chips" style="margin:-4px 0 16px"><button type="button" class="chip" data-preset="1,2,3,4,5">Weekdays</button><button type="button" class="chip" data-preset="0,6">Weekends</button><button type="button" class="chip" data-preset="0,1,2,3,4,5,6">Every day</button></div>
      ${clashes(p, t).length ? `<p class="error">Overlaps ${esc(clashes(p, t).map((o) => `${o.name || label(o)} (${daysLabel(o.days)} ${span(o)})`).join(", "))}. The TV plays the earlier one.</p>` : ""}
      ${t.days.length ? "" : `<p class="error">Pick at least one day, or this programme never comes on.</p>`}`;
  }

  function wireTimer(t, rerender) {
    const len = () => minutes(t);
    const commit = () => { save(); rerender(); };
    // Moving the start keeps the length; moving the end changes it.
    const nudge = (which, mins) => {
      if (which === "open") setTimes(t, toHM(Math.max(0, toMin(t.open) + mins)), len());
      else setClose(t, toHM(toMin(t.close) + mins));
    };
    // While a key is held only the read-outs change; the screen redraws and
    // saves on release, so the key under the finger stays put.
    const paint = () => {
      view.querySelector(".timer-lcd.open .big").textContent = timeLabel(t.open);
      view.querySelector(".timer-lcd.close .big").textContent = timeLabel(t.close);
      view.querySelector(".timer .panel-head .on").textContent = lengthLabel(len()) + " on air";
    };
    view.querySelectorAll("[data-step]").forEach((b) => {
      const which = b.dataset.step, dir = Number(b.dataset.dir);
      let timer = null, ticks = 0;
      const step = () => {
        ticks++;
        if (ticks <= 8) nudge(which, dir);
        else { // past the first few: jump to the next 5-minute mark
          const cur = toMin(which === "open" ? t.open : t.close);
          nudge(which, dir > 0 ? 5 - (cur % 5) : -((cur % 5) || 5));
        }
        paint();
      };
      const stop = () => {
        if (timer === null) return;
        clearTimeout(timer); timer = null; commit();
      };
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        ticks = 0; step();
        const again = () => { timer = setTimeout(() => { step(); again(); }, ticks < 8 ? 160 : 220); };
        timer = setTimeout(again, 400);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, stop));
      b.addEventListener("contextmenu", (e) => e.preventDefault());
      // Keyboard: Enter/Space is one minute.
      b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nudge(which, dir); commit(); } });
    });
    view.querySelectorAll("[data-pick]").forEach((inp) => {
      inp.addEventListener("click", () => { try { inp.showPicker(); } catch (e) {} });
      inp.addEventListener("change", () => {
        if (!/^\d\d:\d\d$/.test(inp.value)) return;
        if (inp.dataset.pick === "open") setTimes(t, inp.value, len()); else setClose(t, inp.value);
        commit();
      });
    });
    view.querySelectorAll("[data-quick]").forEach((b) => b.onclick = () => { setTimes(t, b.dataset.quick, len()); commit(); });
    view.querySelectorAll("[data-len]").forEach((b) => b.onclick = () => { setTimes(t, t.open, Number(b.dataset.len)); commit(); });
    view.querySelectorAll("[data-day]").forEach((b) => b.onclick = () => {
      const d = Number(b.dataset.day);
      t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d];
      commit();
    });
    view.querySelectorAll("[data-preset]").forEach((b) => b.onclick = () => { t.days = b.dataset.preset.split(",").map(Number); commit(); });
  }

  function nameField(t) {
    return `<label class="field"><span>Name it</span>
      <input type="text" id="prog-name" value="${esc(t.name)}" placeholder="e.g. Morning cartoons" autocomplete="off" autocapitalize="sentences"></label>
      ${t.name ? "" : `<div class="chips" style="margin:-6px 0 16px" role="group" aria-label="Name ideas">${NAME_IDEAS.map((n) => `<button type="button" class="chip" data-name="${esc(n)}" style="text-transform:none;letter-spacing:0;font:600 14px var(--text)">${esc(n)}</button>`).join("")}</div>`}`;
  }
  function wireName(t, rerender) {
    $("#prog-name").addEventListener("input", (e) => { t.name = e.target.value.trim(); save(); });
    view.querySelectorAll("[data-name]").forEach((b) => b.onclick = () => { t.name = b.dataset.name; save(); rerender(); });
  }

  function lineupCard(p, t, addHash) {
    const L = lib();
    const shows = t.items.map((id) => L[id]).filter(Boolean);
    return `<div class="card">
      ${shows.map((show, i) => `<div class="line-item">
        ${coverImg(show)}
        <span class="grow"><b>${esc(show.title)}</b><span class="sub">${show.type === "channel" ? "Channel · a new episode each turn" : show.type === "playlist" ? "Playlist · the next video each turn" : "Video"}</span></span>
        <span class="tools">
          <button type="button" class="mini-key" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Play ${esc(show.title)} earlier">${ICON.up}</button>
          ${shows.length > 2 ? `<button type="button" class="mini-key" data-move="${i}" aria-label="Move ${esc(show.title)}">${ICON.more}</button>` : ""}
          <button type="button" class="mini-key" data-remove="${i}" aria-label="Take ${esc(show.title)} out">${ICON.x}</button>
        </span></div>`).join("") || `<div class="empty">No shows yet: this programme stays off air.</div>`}
      <a class="btn ${shows.length ? "" : "primary"}" href="${esc(addHash)}">+ Add shows</a>
    </div>`;
  }
  function wireLineup(t, rerender) {
    view.querySelectorAll("[data-up]").forEach((b) => b.onclick = () => {
      const i = Number(b.dataset.up);
      [t.items[i - 1], t.items[i]] = [t.items[i], t.items[i - 1]];
      save(); rerender();
    });
    view.querySelectorAll("[data-move]").forEach((b) => b.onclick = async () => {
      const i = Number(b.dataset.move), last = t.items.length - 1;
      const show = lib()[t.items[i]];
      const to = await choose(show ? show.title : "Move", [
        { value: "top", label: "Move to top", disabled: i === 0 },
        { value: "down", label: "Move down one", disabled: i === last },
        { value: "bottom", label: "Move to bottom", disabled: i === last },
      ]);
      if (!to) return;
      const [id] = t.items.splice(i, 1);
      if (to === "top") t.items.unshift(id);
      else if (to === "bottom") t.items.push(id);
      else t.items.splice(i + 1, 0, id);
      save(); rerender();
      toast(to === "top" ? "Moved to the top" : to === "bottom" ? "Moved to the bottom" : "Moved down");
    });
    view.querySelectorAll("[data-remove]").forEach((b) => b.onclick = () => { t.items.splice(Number(b.dataset.remove), 1); save(); rerender(); });
  }

  function programmeScreen(p, x) {
    const { c, t } = x;
    chrome(t.name || "Programme", `#/k/${p.id}`, { badge: `CH ${chNum(p)}`, tabs: false });
    const render = () => {
      view.innerHTML = `
        ${nameField(t)}
        ${timerFields(p, t)}
        <h2>Lineup${t.items.length > 1 ? ": they take turns" : ""}</h2>
        ${lineupCard(p, t, `#/k/${p.id}/s/${t.id}/add`)}
        <h2>Each time it comes on</h2>
        <div class="card">
          <label class="radio"><input type="radio" name="mode" value="repeat" ${t.playMode !== "continue" ? "checked" : ""}>
            <span><b>Start from the top</b><span class="sub" style="display:block">The same shows each day. Little ones love rewatching.</span></span></label>
          <label class="radio"><input type="radio" name="mode" value="continue" ${t.playMode === "continue" ? "checked" : ""}>
            <span><b>Continue where we left off</b><span class="sub" style="display:block">Picks up from the next show, like a series.</span></span></label>
        </div>
        <div class="sticky-bar"><button class="btn primary" id="save">Save programme</button></div>
        <button class="btn danger" id="del">Delete this programme</button>`;
      wireName(t, render);
      wireTimer(t, render);
      wireLineup(t, render);
      view.querySelectorAll("input[name=mode]").forEach((r) => r.onchange = () => { t.playMode = r.value; save(); });
      $("#save").onclick = () => { save(); go(`#/k/${p.id}`); toast(`${t.name || label(t)} saved`); };
      $("#del").onclick = async () => {
        if (!(await ask(`Delete ${t.name || "this programme"}?`, "Delete", true))) return;
        c.slots = c.slots.filter((s) => s !== t); save(); go(`#/k/${p.id}`);
      };
      $("#title").textContent = t.name || "Programme";
    };
    render();
  }

  // Add shows into one programme (search, library, or paste).
  function addScreen(p, x, backTo, opts = {}) {
    const { t } = x;
    chrome(opts.title || "Add shows", backTo, { badge: `CH ${chNum(p)}`, tabs: false });
    if (!CLOUD) addTab.tab = "library";
    const render = () => {
      view.innerHTML = `
        ${opts.top || ""}
        <p class="sub" style="margin:0 4px 10px">Into <b>${esc(t.name || label(t))}</b> on ${esc(tvName(p))}, ${esc(daysLabel(t.days))} ${shortSpan(t)}</p>
        ${addShowsPanel(t, { hint: "New shows also go into your show library." })}
        <div class="sticky-bar" id="bar"></div>`;
      const bar = () => {
        const n = t.items.length;
        $("#bar").innerHTML = n
          ? `<button type="button" class="count-bar" id="done"><span class="n">${n}</span><span class="t">${count(n, "show")} in ${esc(t.name || "this programme")}</span><span class="go">${opts.doneLabel || "Done"}</span></button>`
          : `<p class="hint" style="text-align:center;margin:8px 0">Tap Add on a show. Shows in a programme take turns.</p>${opts.skip ? `<button class="btn ghost" id="done">${opts.skip}</button>` : ""}`;
        const d = $("#done"); if (d) d.onclick = () => (opts.onDone ? opts.onDone() : go(backTo));
      };
      wireAddShows(t, render, bar);
      bar();
    };
    render();
  }

  // ---------- Screens: Shows (the library) ----------

  function libraryScreen() {
    chrome("Show library", null, { tab: "shows", extra: accountKey() });
    // Open on the family's own shows, with their covers; search when there are none.
    addTab.tab = !CLOUD || household.library.length ? "library" : "search";
    const render = () => {
      view.innerHTML = `<p class="lead" style="margin-bottom:12px">${count(household.library.length, "show")} your family can put on any channel.</p>
        ${addShowsPanel(null, { hint: `Up to ${MAX_LIBRARY} shows.` })}`;
      wireAddShows(null, render, () => {});
    };
    render();
  }

  // ---------- Set-up: a new channel, step by step ----------

  const STARTERS = [
    { name: "After school", days: [1, 2, 3, 4, 5], open: "15:30", len: 60 },
    { name: "Morning cartoons", days: [1, 2, 3, 4, 5], open: "08:00", len: 45 },
    { name: "Saturday special", days: [6], open: "07:30", len: 90 },
    { name: "Bedtime stories", days: [0, 1, 2, 3, 4, 5, 6], open: "19:30", len: 30 },
  ];
  const SETUP_STEPS = CLOUD ? 4 : 3;

  function wizardKid(p) {
    chrome("New channel", "#/", { tabs: false });
    const render = () => {
      view.innerHTML = `${stepsBar(1, SETUP_STEPS)}<h1>Who's watching?</h1>
        <p class="lead">Each kid gets their own channel, with their own shows and times.</p>
        <div class="card">${kidFields(p)}</div>
        <p class="error" id="err" hidden>Add a name first.</p>
        <button class="btn primary" id="next">Next: when it's on</button>`;
      wireKid(p, render);
      $("#next").onclick = () => {
        if (!p.name) { $("#err").hidden = false; $("#kid-name").focus(); return; }
        if (!programmes(p).length) {
          const t = newProgramme(p, 1);
          Object.assign(t, { name: STARTERS[0].name, days: [...STARTERS[0].days] });
          setTimes(t, STARTERS[0].open, STARTERS[0].len);
        }
        save(); go(`#/new/${p.id}/time`);
      };
    };
    render();
  }

  function wizardTime(p) {
    const t = programmes(p)[0].t;
    chrome(tvName(p), `#/new/${p.id}`, { tabs: false, badge: `CH ${chNum(p)}` });
    const render = () => {
      view.innerHTML = `${stepsBar(2, SETUP_STEPS)}<h1>When is it on?</h1>
        <p class="lead">Start with a ready-made programme, then tune it. You can add more later.</p>
        <div class="chips" style="margin-bottom:16px" role="group" aria-label="Ready-made programmes">${STARTERS.map((st, i) => {
          const on = st.name === t.name && st.days.join() === [...t.days].sort().join() && st.open === t.open && st.len === minutes(t);
          return `<button type="button" class="chip" data-starter="${i}" aria-pressed="${on}" style="text-transform:none;letter-spacing:0;font:700 14px var(--text)">${st.name}</button>`;
        }).join("")}</div>
        ${nameField(t)}
        ${timerFields(p, t)}
        <button class="btn primary" id="next" ${t.days.length ? "" : "disabled"}>Next: pick the shows</button>`;
      wireName(t, render);
      wireTimer(t, render);
      view.querySelectorAll("[data-starter]").forEach((b) => b.onclick = () => {
        const st = STARTERS[Number(b.dataset.starter)];
        t.name = st.name; t.days = [...st.days]; setTimes(t, st.open, st.len);
        save(); render();
      });
      $("#next").onclick = () => go(`#/new/${p.id}/shows`);
    };
    render();
  }

  function wizardShows(p) {
    const x = programmes(p)[0];
    addScreen(p, x, `#/new/${p.id}/time`, {
      title: "Pick the shows",
      top: `${stepsBar(3, SETUP_STEPS)}<h1>What does ${esc(p.name)} watch?</h1>`,
      doneLabel: "Next",
      onDone: () => go(CLOUD ? `#/new/${p.id}/tv` : `#/new/${p.id}/ready`),
    });
  }

  async function wizardTV(p) {
    chrome("Link your TV", `#/new/${p.id}/shows`, { tabs: false });
    view.innerHTML = `<div class="empty mono" style="font-size:22px">CHECKING…</div>`;
    let tvs = [];
    try { tvs = (await call("GET", "/api/tvs")).tvs; } catch (e) {}
    if (tvs.length) return go(`#/new/${p.id}/ready`); // already linked: nothing to do
    linkForm({ top: `${stepsBar(4, SETUP_STEPS)}`, after: () => go(`#/new/${p.id}/ready`), skip: () => go(`#/new/${p.id}/ready`) });
  }

  function wizardReady(p) {
    chrome("On the air", "#/", { tabs: false });
    const t = programmes(p)[0] && programmes(p)[0].t;
    const L = lib();
    view.innerHTML = `
      <div class="hero">
        <div class="tv-art" aria-hidden="true"><div class="ant"></div><div class="box"><div class="scr"><span style="font-size:13px">CH ${chNum(p)}</span><span class="code" style="font-size:34px">${esc(tvName(p)).toUpperCase()}</span></div>
          <span class="knob" style="top:24px;background:var(--sun)"></span><span class="knob" style="top:50px;background:#1E9BD7"></span></div></div>
        <h1>${esc(tvName(p))} is ready</h1>
        <p class="lead">It comes on by itself at the times you set, and signs off when time's up.</p>
      </div>
      ${t ? `<div class="cassette" style="pointer-events:none"><span class="label">
        <span class="top"><span class="tag">${esc(daysLabel(t.days))}</span></span>
        <span class="mid"><span class="name">${esc(t.name || label(t))}</span><span class="time-chip">${shortSpan(t)}</span></span>
        <span class="lineup">${t.items.map((id) => L[id]).filter(Boolean).slice(0, 4).map((s) => coverImg(s)).join("")}</span></span></div>` : ""}
      <div class="card"><b>On the TV remote</b>
        <p class="sub" style="margin:6px 0 0">OK shows the controls · Play/Pause pauses<br>CH ▲▼ switches between channels on now · Back goes to “Who's watching?”</p></div>
      <a class="btn primary" href="#/k/${esc(p.id)}">See ${esc(tvName(p))}'s week</a>
      <a class="btn ghost" href="#/">Back to all channels</a>`;
  }

  // ---------- Shared from the YouTube app ----------

  // The app is installable with a Web Share Target (manifest.json): sharing
  // from the YouTube app opens /app/?text=…&url=…. The link moves into the hash
  // before anything loads, so it survives the sign-in redirect.
  function takeShare() {
    const q = new URLSearchParams(location.search);
    if (!["text", "url", "title"].some((k) => q.has(k))) return;
    const m = [q.get("url"), q.get("text"), q.get("title")].join(" ")
      .match(/(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\/\S+/i);
    history.replaceState(null, "", location.pathname + "#/share/" + encodeURIComponent(m ? m[0] : ""));
  }

  async function shareScreen(link) {
    chrome("Add a show", "#/", { tabs: false });
    const fail = (msg) => {
      view.innerHTML = `<div class="card"><b>Couldn't add that</b><p class="sub">${esc(msg)}</p></div><a class="btn primary" href="#/">OK</a>`;
    };
    if (!link) return fail("That doesn't look like a YouTube link. In the YouTube app, tap Share on a video, channel or playlist, then pick Saturday Mornings.");
    view.innerHTML = `<div class="empty mono" style="font-size:22px">ADDING…</div>`;
    const r = await addShows(link, null);
    const show = r.shows[0];
    if (!show) return fail((r.errors.join("; ") || "Something went wrong") + ".");
    const all = household.profiles.flatMap((p) => programmes(p).map(({ t }) => ({ p, t })));
    const render = () => {
      view.innerHTML = `
        <div class="result" style="margin-bottom:14px"><span class="frame ${show.type === "channel" ? "round" : ""}">${show.thumb ? `<img src="${esc(thumbSrc(show.thumb))}" alt="">` : ""}</span>
          <span class="grow"><b>${esc(show.title)}</b><span class="sub">${r.added ? "Added to your show library" : "Already in your show library"}</span></span></div>
        ${all.length ? `<h2>Put it on a channel</h2>
          ${all.map(({ p, t }, i) => {
            const on = t.items.includes(show.id);
            return `<button type="button" class="key" data-share="${i}" aria-pressed="${on}">
              <span class="ch-badge">CH ${chNum(p)}</span>
              <span class="grow"><b>${esc(t.name || label(t))}</b><span class="sub">${esc(tvName(p))} · ${daysLabel(t.days)} ${shortSpan(t)}</span></span>
              <span class="add-key ${on ? "added" : ""}" aria-hidden="true">${on ? "✓ In" : "Add"}</span></button>`;
          }).join("")}`
          : `<p class="hint">Set up a channel to put it on.</p>`}
        <a class="btn primary" href="#/">Done</a>`;
      view.querySelectorAll("[data-share]").forEach((b) => b.onclick = () => {
        const { t } = all[Number(b.dataset.share)];
        t.items = t.items.includes(show.id) ? t.items.filter((x) => x !== show.id) : [...t.items, show.id];
        save(); render();
      });
    };
    render();
  }

  // ---------- Cloud: TVs and account ----------

  async function call(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = "/?next=" + encodeURIComponent(location.pathname + location.hash); throw new Error("sign in"); }
    if (!r.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  function ago(ms) {
    if (!ms) return "never";
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " days ago";
  }

  async function tvsScreen() {
    chrome("Your TVs", null, { tab: "tvs", extra: accountKey() });
    view.innerHTML = `<div class="empty mono" style="font-size:22px">TUNING IN…</div>`;
    const got = await call("GET", "/api/tvs");
    let tvs = got.tvs;
    const maxTvs = got.max || 0;
    tvCache = tvs;
    // Rename and unlink happen on the card itself: installed web apps often
    // block the browser's own prompt() and confirm() boxes.
    let open = null; // { id, mode: "rename" | "unlink" }
    const render = () => {
      view.innerHTML = `
        <p class="lead">Every linked TV shows all your channels.</p>
        ${tvs.map((t) => {
          const fresh = t.last_seen_at && Date.now() - t.last_seen_at < 10 * 60e3;
          const mode = open && open.id === t.id ? open.mode : null;
          return `<div class="key tv-key" style="cursor:default">
            <div class="tv-row">
              <span class="led ${fresh ? "green" : "dim"}"></span>
              <span class="grow"><b>${esc(t.name)}</b><span class="sub">${fresh ? "Tuned in" : "Seen " + ago(t.last_seen_at)} · linked ${new Date(t.created_at).toLocaleDateString()}</span></span>
              ${mode ? "" : `<button type="button" class="mini-key" data-rename="${esc(t.id)}" aria-label="Rename ${esc(t.name)}">${ICON.pencil}</button>
              <button type="button" class="mini-key" data-unlink="${esc(t.id)}" aria-label="Unlink ${esc(t.name)}">${ICON.x}</button>`}
            </div>
            ${mode === "rename" ? `<div class="tv-edit">
              <label class="vh" for="tv-name">Name this TV</label>
              <input type="text" id="tv-name" value="${esc(t.name)}" maxlength="40" autocomplete="off">
              <p class="error" id="tv-err" hidden></p>
              <div class="tv-actions"><button type="button" class="btn small" data-cancel>Cancel</button><button type="button" class="btn small primary" data-save="${esc(t.id)}">Save</button></div>
            </div>` : ""}
            ${mode === "unlink" ? `<div class="tv-edit">
              <p class="sub" style="margin:0 0 10px">Unlink <b>${esc(t.name)}</b>? It stops showing your channels and goes back to showing a code.</p>
              <p class="error" id="tv-err" hidden></p>
              <div class="tv-actions"><button type="button" class="btn small" data-cancel>Keep it</button><button type="button" class="btn small danger" data-confirm-unlink="${esc(t.id)}">Unlink</button></div>
            </div>` : ""}
          </div>`;
        }).join("") || `<div class="key status-key" style="cursor:default"><span class="led"></span><span class="grow"><b>No TV linked yet</b><span class="sub">Open Saturday Mornings on your TV to get a code</span></span></div>`}
        ${maxTvs ? `<p class="sub" style="text-align:center;margin:14px 0 0">${tvs.length} of ${maxTvs} TVs linked</p>` : ""}
        ${maxTvs && tvs.length >= maxTvs
          ? `<p class="hint" style="text-align:center">That's the most a family can link. Unlink one to add another.</p>`
          : `<a class="btn primary" href="#/link">+ Link a TV</a>`}`;
      const fail = (e) => { const el = $("#tv-err"); if (el) { el.textContent = e.message || "Something went wrong"; el.hidden = false; } };
      view.querySelectorAll("[data-rename]").forEach((b) => b.onclick = () => {
        open = { id: b.dataset.rename, mode: "rename" }; render();
        const i = $("#tv-name"); i.focus(); i.select();
        i.addEventListener("keydown", (e) => { if (e.key === "Enter") view.querySelector("[data-save]").click(); });
      });
      view.querySelectorAll("[data-unlink]").forEach((b) => b.onclick = () => { open = { id: b.dataset.unlink, mode: "unlink" }; render(); });
      view.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = () => { open = null; render(); });
      view.querySelectorAll("[data-save]").forEach((b) => b.onclick = async () => {
        const name = $("#tv-name").value.trim();
        if (!name) return fail(new Error("Give the TV a name"));
        b.disabled = true;
        try {
          await call("PATCH", "/api/tvs/" + b.dataset.save, { name });
          tvs = tvs.map((t) => t.id === b.dataset.save ? { ...t, name: name.slice(0, 40) } : t);
          tvCache = tvs; open = null; render(); toast("TV renamed");
        } catch (e) { b.disabled = false; fail(e); }
      });
      view.querySelectorAll("[data-confirm-unlink]").forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try {
          await call("DELETE", "/api/tvs/" + b.dataset.confirmUnlink);
          tvs = tvs.filter((t) => t.id !== b.dataset.confirmUnlink);
          tvCache = tvs; open = null; render(); toast("TV unlinked");
        } catch (e) { b.disabled = false; fail(e); }
      });
    };
    render();
  }

  // The link form, used on its own and as the last set-up step.
  function linkForm({ code, top, after, skip }) {
    const shown = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    view.innerHTML = `
      ${top || ""}
      <div class="hero">
        <div class="tv-art" aria-hidden="true"><div class="ant"></div><div class="box"><div class="scr">YOUR TV SHOWS<span class="code" id="art-code">${shown ? esc(shown) : "??????"}</span></div>
          <span class="knob" style="top:24px;background:var(--sun)"></span><span class="knob" style="top:50px;background:#1E9BD7"></span></div></div>
        <p class="lead" style="margin-top:16px">Open <b>Saturday Mornings</b> on your TV. Type the code it shows. Just once.</p>
      </div>
      <label class="field"><span>Code from the TV</span>
        <div class="code-box"><input type="text" id="code" value="${esc(shown)}" maxlength="6" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="······"></div></label>
      <label class="field"><span>Name this TV</span><input type="text" id="tvname" value="Living room TV" autocomplete="off"></label>
      ${shown ? `<p class="hint" style="margin-top:0">⚠️ Only link a TV that's in front of you. Check this code is the one on its screen: a linked TV can see your family's channels and schedule.</p>` : ""}
      <p class="error" id="err" hidden></p>
      <button class="btn primary" id="go">Link this TV</button>
      <p class="hint" style="text-align:center">Or point your phone's camera at the QR code on the TV.</p>
      ${skip ? `<button class="btn ghost" id="skip">I'll link the TV later</button>` : ""}`;
    const input = $("#code");
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      $("#art-code").textContent = input.value || "??????";
    });
    if (skip) $("#skip").onclick = skip;
    $("#go").onclick = async () => {
      const btn = $("#go");
      btn.disabled = true;
      try {
        await call("POST", "/api/tvs/link", { code: input.value, name: $("#tvname").value });
        tvCache = null;
        if (after) { toast("TV linked! Your channels appear in a few seconds."); return after(); }
        view.innerHTML = `<div class="hero"><div class="tv-art" aria-hidden="true"><div class="ant"></div><div class="box"><div class="scr">${bars()}</div>
            <span class="knob" style="top:24px;background:var(--sun)"></span><span class="knob" style="top:50px;background:#1E9BD7"></span></div></div>
          <h1>TV linked</h1><p class="lead">Look at your TV: your channels appear in a few seconds.</p></div>
          <a class="btn primary" href="#/tvs">Done</a>`;
      } catch (e) { btn.disabled = false; $("#err").hidden = false; $("#err").textContent = e.message; }
    };
  }

  function linkScreen(code) {
    chrome("Link a TV", "#/tvs", { tabs: false });
    linkForm({ code });
  }

  // ---------- Notifications (this device) ----------

  const NOTIFY_ROWS = [
    ["soon", "Coming on soon", "10 minutes before a programme starts"],
    ["signoff", "Signed off", "When a channel signs off, with a +10 min button"],
    ["offline", "TV not tuned in", "A show is on, but a TV hasn't checked in"],
    ["changed", "Schedule changed", "When another parent changes channels or shows"],
  ];
  const keyBytes = (b64) => {
    const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  async function notifyCard() {
    const box = $("#notify-card");
    if (!box) return;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported) {
      box.innerHTML = ios && !standalone
        ? `<b>Add the app to your Home Screen first</b><p class="sub" style="margin:4px 0 0">On iPhone, notifications work once Saturday Mornings is on your Home Screen. In Safari tap Share, then Add to Home Screen, and open it from there.</p>`
        : `<b>Not available in this browser</b><p class="sub" style="margin:4px 0 0">Try Chrome, or the app on your phone.</p>`;
      return;
    }
    let pr, reg, sub;
    try {
      // The service worker delivers notifications; some browsers (private
      // windows, some embedded browsers) never start one.
      const ready = Promise.race([navigator.serviceWorker.ready,
        new Promise((_, no) => setTimeout(() => no(new Error("This browser didn't start the app's background worker. Open the installed app, or try Chrome or Safari.")), 6000))]);
      [pr, reg] = await Promise.all([call("GET", "/api/push/prefs"), ready]);
      sub = await reg.pushManager.getSubscription();
    } catch (e) { box.innerHTML = `<b>Couldn't check notifications</b><p class="sub" style="margin:4px 0 0">${esc(e.message)}</p>`; return; }
    if (!pr.ready) { box.innerHTML = `<b>Coming soon</b><p class="sub" style="margin:4px 0 0">Notifications aren't switched on for this station yet.</p>`; return; }
    const fail = (e) => { const el = $("#notify-err"); if (el) { el.textContent = e.message || String(e); el.hidden = false; } };
    if (!sub) {
      const denied = Notification.permission === "denied";
      box.innerHTML = `<b>Get a nudge from the station</b>
        <p class="sub" style="margin:4px 0 12px">Before shows start, when they sign off, if a TV isn't tuned in, and when another parent changes the schedule.</p>
        ${denied ? `<p class="error" style="margin:0">Notifications are blocked for this app. Allow them in your phone's or browser's settings, then come back here.</p>`
          : `<button class="btn primary" id="notify-on">🔔 Turn on notifications</button>`}
        <p class="error" id="notify-err" hidden></p>`;
      const on = $("#notify-on");
      if (on) on.onclick = async () => {
        on.disabled = true;
        try {
          if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications weren't allowed. You can allow them in settings.");
          const { key } = await call("GET", "/api/push/key");
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
          await call("POST", "/api/push/subscribe", { subscription: s.toJSON() });
          toast("Notifications on");
          notifyCard();
        } catch (e) { on.disabled = false; fail(e); }
      };
      return;
    }
    box.innerHTML = `
      <div class="notify-head"><span class="led green"></span><b>On for this device</b></div>
      ${NOTIFY_ROWS.map(([k, t, d]) => `<div class="switch-row notify-row">
        <div class="grow"><b>${t}</b><div class="sub">${d}</div></div>
        <label class="switch"><span class="vh">${t}</span><input type="checkbox" data-notify="${k}" ${pr.prefs[k] ? "checked" : ""}><i></i></label></div>`).join("")}
      <p class="hint" style="margin:10px 0 12px">These choices are yours; the other parents pick their own.</p>
      <div class="tv-actions"><button type="button" class="btn small" id="notify-test">Send a test</button><button type="button" class="btn small" id="notify-off">Turn off here</button></div>
      <p class="error" id="notify-err" hidden></p>`;
    view.querySelectorAll("[data-notify]").forEach((c) => c.onchange = async () => {
      const prefs = {};
      view.querySelectorAll("[data-notify]").forEach((x) => { prefs[x.dataset.notify] = x.checked; });
      try { await call("PUT", "/api/push/prefs", { prefs }); setSaved("SAVED ✓"); setTimeout(() => setSaved(""), 1500); } catch (e) { fail(e); }
    });
    $("#notify-test").onclick = async () => {
      try { await call("POST", "/api/push/test"); toast("Test sent: it should pop up in a moment"); } catch (e) { fail(e); }
    };
    $("#notify-off").onclick = async () => {
      try {
        await call("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
        toast("Notifications off on this device");
        notifyCard();
      } catch (e) { fail(e); }
    };
  }

  // A photo becomes a small square JPEG on the phone (about 10 KB), so it's
  // quick to save and to show everywhere.
  async function shrinkPhoto(file, size = 192) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      return c.toDataURL("image/jpeg", 0.82);
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- Cloud: early access (admins only) ----------

  async function adminScreen() {
    chrome("Early access", "#/account", { tabs: false });
    view.innerHTML = `<div class="empty mono" style="font-size:22px">TUNING IN…</div>`;
    let st;
    try { st = await call("GET", "/api/admin"); }
    catch (e) { view.innerHTML = `<div class="card"><b>Admins only</b><p class="sub">${esc(e.message)}</p></div>`; return; }
    let size = Math.min(100, st.waiting.total) || 10, order = "first";
    const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const render = () => {
      view.innerHTML = `
        <section class="panel">
          <div class="panel-head"><span>Early access</span><span class="on">${st.waiting.total ? "Queue open" : "Queue empty"}</span></div>
          <div class="lcd admin-lcd">
            <div><span class="big">${st.waiting.total}</span><span class="cap">waiting</span></div>
            <div><span class="big">${st.approved}</span><span class="cap">let in</span></div>
            <div><span class="big">${st.accounts}</span><span class="cap">accounts</span></div>
          </div>
          <p class="admin-split">${st.waiting.site} from the website · ${st.waiting.app} tried the app</p>
        </section>

        <h2>Let the next batch in</h2>
        <div class="card">
          <p class="sub" style="margin-top:0">They're added to early access and get a “You're in, first month free” email.</p>
          <div class="lengths" role="group" aria-label="How many">${[10, 50, 100, 250].map((n) => `<button type="button" class="chip" data-size="${n}" aria-pressed="${n === size}">${n}</button>`).join("")}</div>
          <label class="field"><span>How many</span><input type="number" id="size" min="1" max="1000" inputmode="numeric" value="${size}"></label>
          <div class="seg" role="group" aria-label="Who goes first">
            <button type="button" data-order="first" aria-pressed="${order === "first"}">First come</button>
            <button type="button" data-order="random" aria-pressed="${order === "random"}">At random</button>
          </div>
          <button class="btn primary" id="release" ${st.waiting.total ? "" : "disabled"}>Let ${Math.min(size, st.waiting.total)} in</button>
        </div>

        <h2>Let someone in by email</h2>
        <div class="card">
          <label class="field"><span>Emails</span><textarea id="emails" rows="3" placeholder="friend@example.com, another@example.com" autocapitalize="off" spellcheck="false"></textarea></label>
          <label class="check"><input type="checkbox" id="notify" checked> Send them the “You're in” email</label>
          <button class="btn" id="approve">Let them in</button>
          <p class="error" id="adm-err" hidden></p>
        </div>

        <h2>Waiting (${st.waiting.total})</h2>
        ${st.queue.length ? `<div class="card admin-list">${st.queue.map((w) => `<div class="member"><div class="grow"><span style="overflow-wrap:anywhere">${esc(w.email)}</span>
            <div class="sub">${w.source === "site" ? "Website" : "Tried the app"} · ${when(w.created_at)}${w.tvs.length ? " · " + esc(w.tvs.join(", ")) : ""}${w.country ? " · " + esc(w.country) : ""}${w.thanked_at ? "" : " · thank-you pending"}</div></div></div>`).join("")}
          ${st.waiting.total > st.queue.length ? `<p class="hint">Showing the first ${st.queue.length}.</p>` : ""}</div>`
          : `<p class="hint">Nobody's waiting right now.</p>`}

        ${st.batches.length ? `<h2>Batches</h2><div class="card admin-list">${st.batches.map((b) => `<div class="member"><div class="grow">${esc(b.batch)}<div class="sub">${count(b.n, "family", "families")} let in</div></div></div>`).join("")}</div>` : ""}`;
      const sizeIn = $("#size");
      const setSize = (n) => { size = Math.max(1, Math.min(1000, n | 0)); render(); };
      view.querySelectorAll("[data-size]").forEach((b) => b.onclick = () => setSize(Number(b.dataset.size)));
      sizeIn.onchange = () => setSize(Number(sizeIn.value));
      view.querySelectorAll("[data-order]").forEach((b) => b.onclick = () => { order = b.dataset.order; render(); });
      const fail = (e) => { const el = $("#adm-err"); el.textContent = e.message; el.hidden = false; };
      $("#release").onclick = async () => {
        const n = Math.min(size, st.waiting.total);
        if (!(await ask(`Let ${count(n, "family", "families")} in (${order === "random" ? "picked at random" : "first come, first served"}) and email each of them?`, `Let ${n} in`))) return;
        $("#release").disabled = true;
        try {
          const r = await call("POST", "/api/admin/release", { count: n, order });
          toast(`${r.released} let in · ${r.emailed} emailed`);
          adminScreen();
        } catch (e) { fail(e); $("#release").disabled = false; }
      };
      $("#approve").onclick = async () => {
        const emails = $("#emails").value.split(/[\s,;]+/).filter(Boolean);
        if (!emails.length) return fail(new Error("Add at least one email address"));
        $("#approve").disabled = true;
        try {
          const r = await call("POST", "/api/admin/approve", { emails, notify: $("#notify").checked });
          toast(`${r.approved} let in${r.emailed ? ` · ${r.emailed} emailed` : ""}`);
          adminScreen();
        } catch (e) { fail(e); $("#approve").disabled = false; }
      };
    };
    render();
  }

  async function accountScreen() {
    chrome("Account", "#/", { tabs: false });
    const [me, fam] = await Promise.all([call("GET", "/api/me"), call("GET", "/api/family")]);
    const shared = fam.members.length > 1;
    const owner = fam.role === "owner";
    const zone = household.timeZone || "", here = phoneZone();
    view.innerHTML = `
      <div class="key me-key" style="cursor:default">${faceHtml(me.avatar, me.email, "big")}
        <span class="grow"><b style="overflow-wrap:anywhere">${esc(me.email)}</b><span class="sub">Signed in</span>
          <button type="button" class="btn small" id="face-edit">${me.avatar ? "Change picture" : "Add a picture"}</button></span></div>
      <section class="card face-picker" id="face-picker" hidden>
        <b>Your picture</b>
        <p class="sub" style="margin:2px 0 12px">Shown to the other grown-ups in your family. Kids never see it.</p>
        <label class="btn primary face-photo">📷 Take or choose a photo<input type="file" id="face-file" accept="image/*" class="vh"></label>
        <span class="label" style="margin-top:14px">Or an emoji</span>
        <div class="emojis" role="group" aria-label="Emoji">${FACE_EMOJI.map((e) => `<button type="button" data-face="${e}" aria-pressed="${!!(me.avatar && me.avatar.emoji === e)}">${e}</button>`).join("")}</div>
        <div class="colors" role="group" aria-label="Colour">${COLORS.map((c, i) => `<button type="button" data-facecolor="${c}" aria-pressed="${(me.avatar && me.avatar.color ? me.avatar.color : COLORS[0]) === c}" style="background:${c}" aria-label="${COLOR_NAMES[i]}"></button>`).join("")}</div>
        <button type="button" class="btn ghost" id="face-initials" style="margin-top:14px">Use my initials (${esc(initials(me.email))})</button>
        <p class="error" id="face-err" hidden></p>
      </section>
      ${me.trialEndsAt ? (() => {
        const days = Math.ceil((me.trialEndsAt - Date.now()) / 86400e3);
        return `<div class="key trial-key" style="cursor:default"><span class="trial-badge" aria-hidden="true">FREE</span>
          <span class="grow"><b>${days > 0 ? `Free month: ${count(days, "day")} left` : "Your free month is over"}</b>
          <span class="sub">${days > 0 ? `Until ${new Date(me.trialEndsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}. Enjoy every feature.` : "Thanks for trying Saturday Mornings."}</span></span></div>`;
      })() : ""}
      ${me.admin ? `<a class="key" href="#/admin"><span class="trial-badge" style="background:var(--red);color:#fff" aria-hidden="true">ADMIN</span>
        <span class="grow"><b>Early access</b><span class="sub">The waiting list, and letting families in</span></span>${ICON.chev || ""}</a>` : ""}

      ${fam.invitedTo.map((i) => `<div class="card">
        <b>${esc(i.from)} invited you to their family</b>
        <p class="sub">${household.profiles.length && !shared
          ? `Joining replaces what you've set up here (${count(household.profiles.length, "kid")}, your show library and linked TVs).`
          : "You'll both manage the same kids, shows and TVs."}</p>
        <button class="btn primary" data-join="${esc(i.householdId)}">Join their family</button></div>`).join("")}

      <h2>Family</h2>
      <div class="card">
        ${fam.members.map((m) => `<div class="member">${faceHtml(m.avatar, m.email, "sm")}<div class="grow" style="overflow-wrap:anywhere">${esc(m.email)}${m.you ? " (you)" : ""}
            <div class="sub">${m.role === "owner" ? "Owner" : "Parent"}</div></div>
          ${owner && !m.you ? `<button class="btn small danger" data-remove="${esc(m.email)}">Remove</button>` : ""}</div>`).join("")}
        ${fam.invites.map((i) => `<div class="member"><div class="grow">${esc(i.email)}<div class="sub">Invited · not joined yet</div></div>
          <button class="btn small danger" data-cancel="${esc(i.email)}">Cancel</button></div>`).join("")}
        <label class="field" style="margin-top:12px"><span>Invite another parent</span>
          <input type="email" id="inv-email" placeholder="their@email.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <button class="btn" id="inv-go">Send invite</button>
        <p class="hint">They sign in with that email, tap Join, and then manage the same kids, shows and TVs.</p>
        <p class="error" id="fam-err" hidden></p>
        ${!owner ? `<button class="btn danger" id="leave">Leave this family</button>` : ""}
      </div>

      <h2>Notifications</h2>
      <div class="card" id="notify-card"><p class="sub" style="margin:0">Checking this device…</p></div>

      <h2>Time zone</h2>
      <div class="card">
        <b>${esc(zone || "Not set")}</b>
        <p class="sub">Shows start and end by this clock on every TV.</p>
        ${here && here !== zone ? `<button class="btn" id="tz-here">Use this phone's time zone (${esc(here)})</button>` : ""}
      </div>

      <h2>Sign-in</h2>
      <div class="card">
        <b>Passkeys</b>
        <p class="sub">${me.passkeys ? count(me.passkeys, "passkey") + " set up. Sign in with Face ID, Touch ID or your fingerprint." : "None yet. Add one to sign in without codes."}</p>
        ${WA && window.PublicKeyCredential ? `<button class="btn" id="addpk">Add a passkey on this device</button>` : ""}
        <p class="error" id="err" hidden></p>
      </div>
      <a class="key" href="mailto:CONTACT_EMAIL?subject=${encodeURIComponent("Saturday Mornings help")}">
        <span class="avatar" style="background:var(--key)" aria-hidden="true">✉️</span>
        <span class="grow"><b>Help and feedback</b><span class="sub">Email us. We read everything.</span></span>${ICON.chev}</a>
      <button class="btn dark" id="signout">Sign out</button>
      <details class="more" id="del">
        <summary>Delete account</summary>
        <div class="card">
          <p class="sub">${shared
            ? "Deletes your account and sign-in. Your kids' channels, show library and TVs stay with the other parents in your family."
            : "Deletes your account, your kids' channels, your show library and every linked TV, for good. Linked TVs go back to showing a link code."}</p>
          <label class="field"><span>Type ${esc(me.email)} to confirm</span>
            <input type="email" id="del-email" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <button class="btn danger" id="del-go" disabled>Delete my account</button>
          <p class="error" id="del-err" hidden></p>
        </div>
      </details>
      <p class="legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/security">Security</a></p>`;

    const famErr = (e) => { $("#fam-err").hidden = false; $("#fam-err").textContent = e.message; };
    $("#inv-go").onclick = async () => {
      try {
        const r = await call("POST", "/api/family/invite", { email: $("#inv-email").value });
        await accountScreen();
        toast(r.emailed ? "Invite sent" : "Invite saved");
      } catch (e) { famErr(e); }
    };
    view.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = async () => {
      try { await call("DELETE", "/api/family/invite", { email: b.dataset.cancel }); accountScreen(); } catch (e) { famErr(e); }
    });
    view.querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
      if (!(await ask(`Remove ${b.dataset.remove} from your family? They'll no longer see your kids' channels, and any TV they linked is unlinked.`, "Remove", true))) return;
      try {
        const r = await call("POST", "/api/family/remove", { email: b.dataset.remove });
        tvCache = null;
        if (r.tvsUnlinked) toast(`Removed. ${count(r.tvsUnlinked, "TV")} they linked ${r.tvsUnlinked === 1 ? "was" : "were"} unlinked.`);
        accountScreen();
      } catch (e) { famErr(e); }
    });
    view.querySelectorAll("[data-join]").forEach((b) => b.onclick = async () => {
      if (household.profiles.length && !shared && !(await ask("Join their family? What you've set up here will be deleted.", "Join", true))) return;
      try { await call("POST", "/api/family/join", { householdId: b.dataset.join }); location.href = "/app/"; } catch (e) { famErr(e); }
    });
    notifyCard();

    // Your picture
    let faceColor = (me.avatar && me.avatar.color) || COLORS[0];
    const faceErr = (m) => { const e = $("#face-err"); e.textContent = m || ""; e.hidden = !m; };
    const setFace = async (avatar) => {
      try {
        const r = await call("PUT", "/api/me/avatar", { avatar });
        meInfo = { ...(meInfo || me), avatar: r.avatar };
        toast("Picture saved");
        accountScreen();
      } catch (e) { faceErr(e.message); }
    };
    $("#face-edit").onclick = () => {
      const p = $("#face-picker"); p.hidden = !p.hidden;
      if (!p.hidden) p.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    view.querySelectorAll("[data-face]").forEach((b) => b.onclick = () => setFace({ kind: "emoji", emoji: b.dataset.face, color: faceColor }));
    view.querySelectorAll("[data-facecolor]").forEach((b) => b.onclick = () => {
      faceColor = b.dataset.facecolor;
      view.querySelectorAll("[data-facecolor]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      if (me.avatar && me.avatar.kind === "emoji") setFace({ kind: "emoji", emoji: me.avatar.emoji, color: faceColor });
    });
    $("#face-initials").onclick = () => setFace(null);
    $("#face-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { await setFace({ kind: "photo", data: await shrinkPhoto(f) }); }
      catch (err) { faceErr("That picture didn't work. Try another one."); }
    };

    const leave = $("#leave");
    if (leave) leave.onclick = async () => {
      if (!(await ask("Leave this family? Any TV you linked is unlinked, and you'll start over with your own, empty setup.", "Leave", true))) return;
      try { await call("POST", "/api/family/leave"); location.href = "/app/"; } catch (e) { famErr(e); }
    };
    const tz = $("#tz-here");
    if (tz) tz.onclick = () => { household.timeZone = here; save(); accountScreen(); };
    const add = $("#addpk");
    if (add) add.onclick = async () => {
      try {
        const { options, challengeId } = await call("POST", "/api/auth/passkey/register/options");
        const response = await WA.startRegistration({ optionsJSON: options });
        await call("POST", "/api/auth/passkey/register/verify", { challengeId, response, label: navigator.platform || "Passkey" });
        await accountScreen(); toast("Passkey added");
      } catch (e) { if (e.name !== "NotAllowedError") { $("#err").hidden = false; $("#err").textContent = e.message; } }
    };
    $("#signout").onclick = async () => { await call("POST", "/api/auth/signout"); location.href = "/"; };
    const delEmail = $("#del-email"), delGo = $("#del-go");
    delEmail.oninput = () => { delGo.disabled = delEmail.value.trim().toLowerCase() !== me.email; };
    delGo.onclick = async () => {
      delGo.disabled = true;
      try {
        await call("DELETE", "/api/account", { confirm: delEmail.value });
        location.href = "/?deleted=1";
      } catch (e) { delGo.disabled = false; $("#del-err").hidden = false; $("#del-err").textContent = e.message; }
    };
  }

  // ---------- Router ----------

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const p = byId(household.profiles, parts[1]);
    if (parts[0] === "new" && p) {
      if (parts[2] === "ready") return wizardReady(p);
      if (parts[2] === "tv" && CLOUD) return wizardTV(p);
      if (parts[2] === "shows" && programmes(p).length) return wizardShows(p);
      if (parts[2] === "time" && programmes(p).length) return wizardTime(p);
      return wizardKid(p);
    }
    if (parts[0] === "k" && p) {
      if (parts[2] === "settings") return settingsScreen(p);
      const x = parts[2] === "s" && findProgramme(p, parts[3]);
      if (x && parts[4] === "add") return addScreen(p, x, `#/k/${p.id}/s/${x.t.id}`);
      if (x) return programmeScreen(p, x);
      return channelScreen(p);
    }
    // Links from before the redesign: #/p/<kid>/c/<channel>/s/<slot>[/pick]
    if (parts[0] === "p" && p) {
      const x = parts[5] && findProgramme(p, parts[5]);
      return go(x ? `#/k/${p.id}/s/${x.t.id}${parts[6] === "pick" ? "/add" : ""}` : `#/k/${p.id}`);
    }
    if (parts[0] === "done" && p) return go(`#/new/${p.id}/ready`);
    if (parts[0] === "guide") return guideScreen();
    if (parts[0] === "library") return libraryScreen();
    if (parts[0] === "share") {
      let link = "";
      try { link = decodeURIComponent(parts.slice(1).join("/")); } catch (e) {}
      return shareScreen(link);
    }
    if (CLOUD && parts[0] === "tvs") return tvsScreen();
    if (CLOUD && parts[0] === "link") return linkScreen(parts[1]);
    if (CLOUD && parts[0] === "account") return accountScreen();
    if (CLOUD && parts[0] === "admin") return adminScreen();
    home();
  }

  window.addEventListener("hashchange", route);
  // Coming back to the app: pick up changes made on another phone. Never while
  // a save is pending or on its way (that read could predate it), at most every
  // 15 seconds, and only a newer version than ours.
  let lastCheck = 0;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || saveTimer || saving || !household) return;
    if (Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    try {
      const fresh = await (await fetch(API, { cache: "no-store" })).json();
      if (saveTimer || saving) return;
      if ((fresh.version || 0) > (household.version || 0)) { household = S.migrateHousehold(fresh); route(); }
    } catch (e) {}
  });
  takeShare();
  if (CLOUD) fetch("/api/me").then((r) => r.json()).then((m) => {
    if (!m.signedIn) return;
    meInfo = m;
    const k = document.querySelector("#top-extra .icon-key");
    if (k) k.outerHTML = accountKey(); // the picture arrived after the screen
  }).catch(() => {});
  load().then(() => {
    // A new family takes the time zone of the first phone that opens it.
    if (!household.timeZone && phoneZone()) { household.timeZone = phoneZone(); save(); }
    route();
  });
  // Installable app: the service worker keeps the app shell on the phone.
  if (CLOUD && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
