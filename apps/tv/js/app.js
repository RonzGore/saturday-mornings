// Saturday Mornings: TV app. Profiles each have their own channels, each channel
// plays its YouTube lineup only during its hours, then the station signs off.
// Plain ES5 so it runs on older Samsung TVs.
(function () {
  var cfg = window.SATURDAY_TV;
  var S = window.Schedule;
  var ctx = { testMinutes: cfg.testMinutes, appStartedAt: Date.now(), forceOffAir: cfg.forceOffAir };
  var SERVER = location.protocol.indexOf("http") === 0 ? location.origin : cfg.server;

  // Script errors go to the Worker's logs in cloud mode (a few per launch).
  var reports = 0;
  window.onerror = function (message, source, line) {
    if (!CLOUD || reports++ >= 5) return;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", SERVER + "/api/report", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({ where: "tv", message: String(message), source: String(source), line: line }));
    } catch (e) {}
  };

  // The time in the family's time zone (set from the parent's phone), so the
  // schedule is right even if the TV's own zone is wrong. Test mode on the
  // Mac uses the real clock.
  function clock() {
    return cfg.testMinutes > 0 ? new Date() : S.wallNow(household && household.timeZone);
  }
  // Cloud mode (served by Cloudflare at /tv/): this TV links to a family with
  // a pairing code and then reads its channels with its own token.
  var CLOUD = cfg.mode === "cloud";
  var pairTimer = null;

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412,
    CH_UP: 427, CH_DOWN: 428
  };

  var household = null;
  var LIB = {}; // library: id -> show
  var screen = "boot"; // setup | picker | guide | ident | playing | offair
  var profile = null;
  var channel = null;
  var slot = null; // the time slot playing on the channel
  var index = 0;
  var pickerFocus = 0;   // which channel card; -1 = the Channels Guide button

  var player = null;
  var playerReady = false;
  var pendingStart = null;
  var paused = false;

  var controlsOpen = false;
  var controlsFocus = 1;
  var controlsTimer = null;
  var identTimer = null;

  function $(id) { return document.getElementById(id); }
  function debug(msg) { $("debug").textContent = msg || ""; }

  function show(id) {
    var all = ["setup", "picker", "guide", "ident", "player-screen", "offair"];
    for (var i = 0; i < all.length; i++) {
      $(all[i]).className = "screen" + (all[i] === id ? "" : " hidden");
    }
    renderNet();
  }

  // ---------- Storage (may be unavailable; never required) ----------

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function posKey() { return "pos:" + profile.id + ":" + slot.id; }

  function savePosition(finished) {
    if (!profile || !slot || !playerReady) return;
    var seconds = 0;
    try { seconds = finished ? 0 : Math.floor(player.getCurrentTime() || 0); } catch (e) {}
    save(posKey(), { date: S.dateKey(clock()), index: index, seconds: seconds, finished: !!finished });
  }

  // ---------- Sync with the phone setup ----------

  function getJSON(url, ok, fail, token) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status !== 200) return fail && fail(xhr.status);
      try { ok(JSON.parse(xhr.responseText)); } catch (e) { if (fail) fail(); }
    };
    xhr.onerror = xhr.ontimeout = function () { if (fail) fail(); };
    xhr.send();
  }

  function postJSON(url, ok, fail) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status !== 200) return fail && fail(xhr.status);
      try { ok(JSON.parse(xhr.responseText)); } catch (e) { if (fail) fail(); }
    };
    xhr.onerror = xhr.ontimeout = function () { if (fail) fail(); };
    xhr.send("{}");
  }

  function sync() {
    if (CLOUD && !load("tvToken")) { if (screen !== "setup") showPairing(); return; }
    getJSON(SERVER + (CLOUD ? "/api/tv/household" : "/api/household"), function (h) {
      netNotice(false);
      var changed = !household || h.version !== household.version;
      household = S.migrateHousehold(h);
      LIB = S.libraryMap(household);
      save("household", h);
      save("householdAt", Date.now());
      if (changed) onHouseholdChanged();
    }, function (status) {
      if (CLOUD && status === 401) { save("tvToken", null); household = null; showPairing(); return; }
      if (!status) netNotice(true); // no answer at all: the TV is offline
      if (!household) {
        household = S.migrateHousehold(cachedHousehold() || { version: -1, profiles: [] });
        LIB = S.libraryMap(household);
        onHouseholdChanged();
      }
    }, CLOUD ? load("tvToken") : null);
  }

  // The last household seen, for starting up offline. YouTube titles and
  // thumbnails may be kept 30 days at most, so after that only IDs are used.
  function cachedHousehold() {
    var h = load("household");
    if (!h || Date.now() - (load("householdAt") || 0) < 30 * 86400e3) return h;
    for (var i = 0; i < (h.library || []).length; i++) {
      var it = h.library[i];
      h.library[i] = { id: it.id, type: it.type, ytId: it.ytId, title: "", by: "", thumb: "" };
    }
    save("household", h);
    return h;
  }

  // While offline the TV keeps to the schedule it last saw; this notice says
  // why videos may not load. Cleared by the next successful sync. Nothing may
  // be drawn over the YouTube player, so while playing it shows in the
  // controls under the shrunken player instead.
  var offline = false;
  function netNotice(on) { offline = on; renderNet(); }
  function renderNet() {
    var onPlayer = !$("player-screen").className.match(/hidden/);
    $("net-notice").className = offline && !onPlayer ? "net-notice" : "net-notice hidden";
    if (onPlayer && screen === "playing") playerNote(offline ? "No internet connection · trying again" : "");
  }
  window.addEventListener("offline", function () { netNotice(true); });
  window.addEventListener("online", function () { sync(); });

  function onHouseholdChanged() {
    var profiles = household.profiles || [];
    if (!profiles.length) { showSetup(); return; }
    clearTimeout(pairTimer);
    if (profile) {
      profile = findById(profiles, profile.id);
      if (!profile) { showPicker(); return; }
      if (channel) channel = findById(profile.channels, channel.id);
      if (channel && slot) slot = findById(channel.slots, slot.id);
      if (screen === "offair") showOffAir();
      return;
    }
    if (screen === "boot" || screen === "setup") {
      if (profiles.length === 1) enterProfile(profiles[0]); else showPicker();
    } else if (screen === "picker") {
      renderPicker();
    }
  }

  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ---------- Setup screen ----------

  // ---------- Cloud: link this TV ----------

  function showPairing() {
    screen = "setup";
    profile = null; channel = null; slot = null;
    stopPlayer();
    clearTimeout(pairTimer);
    $("setup-title").textContent = "Link this TV";
    $("setup-steps").innerHTML =
      "<li>On your phone, open <b>" + esc(location.host) + "</b> and sign in</li>" +
      "<li>Go to <b>Your TVs › Link a TV</b> (or scan the code)</li>" +
      "<li>Enter the code below</li>";
    $("setup-code").textContent = "· · · · · ·";
    $("setup-url").textContent = "";
    $("setup-wait").textContent = "Getting a code…";
    show("setup");
    screenSaver(true);
    // A code shown before the app last closed (say, Android updating its web
    // engine mid-link) is picked up again, so a parent who already typed it in
    // isn't asked for a new one.
    var pending = load("pairing");
    if (pending && pending.code && pending.poll && Date.now() - pending.at < 3600e3) {
      getJSON(SERVER + "/api/tv/pair/status?code=" + pending.code + "&poll=" + encodeURIComponent(pending.poll), function (r) {
        if (r.status === "linked") { save("pairing", null); save("tvToken", r.token); household = null; screen = "boot"; sync(); }
        else if (r.status === "pending") showCode(pending);
        else { save("pairing", null); newCode(); }
      }, function () { save("pairing", null); newCode(); });
    } else newCode();
  }

  function newCode() {
    postJSON(SERVER + "/api/tv/pair/start", function (p) {
      p.at = Date.now(); p.until = Date.now() + p.expiresIn * 1000;
      save("pairing", p);
      showCode(p);
    }, function () {
      $("setup-wait").textContent = "Can't reach Saturday Mornings. Is the TV online? Retrying…";
      pairTimer = setTimeout(showPairing, 10000);
    });
  }

  function showCode(p) {
    if (screen !== "setup") return;
    $("setup-code").textContent = p.code.slice(0, 3) + "-" + p.code.slice(3);
    $("setup-wait").textContent = "This screen changes as soon as the TV is linked.";
    try {
      var qr = qrcode(0, "M");
      qr.addData(location.origin + "/app/#/link/" + p.code);
      qr.make();
      $("setup-qr").innerHTML = qr.createImgTag(12, 4);
    } catch (e) {}
    pollPairing(p, p.until);
  }

  function pollPairing(p, until) {
    pairTimer = setTimeout(function () {
      if (screen !== "setup") return;
      if (Date.now() > until) { save("pairing", null); showPairing(); return; }
      getJSON(SERVER + "/api/tv/pair/status?code=" + p.code + "&poll=" + encodeURIComponent(p.poll), function (r) {
        if (r.status === "linked") { save("pairing", null); save("tvToken", r.token); household = null; screen = "boot"; sync(); }
        else if (r.status === "expired") { save("pairing", null); showPairing(); }
        else pollPairing(p, until);
      }, function () { pollPairing(p, until); });
    }, 3000);
  }

  function showSetup() {
    if (CLOUD) {
      // Linked, but the family hasn't added any kids yet.
      screen = "setup";
      $("setup-title").textContent = "Almost there";
      $("setup-steps").innerHTML = "<li>This TV is linked</li><li>On your phone, add your kids and their shows</li><li>They'll appear here within 30 seconds</li>";
      $("setup-code").textContent = "";
      $("setup-qr").innerHTML = "";
      $("setup-url").textContent = location.host + "/app/";
      $("setup-wait").textContent = "";
      show("setup");
      return;
    }
    screen = "setup";
    profile = null; channel = null; slot = null;
    stopPlayer();
    // A phone can't open "localhost", so point it at the Mac's network address.
    var base = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? cfg.server : SERVER;
    var url = base + "/setup/";
    $("setup-url").textContent = url.replace(/^https?:\/\//, "");
    try {
      var qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      $("setup-qr").innerHTML = qr.createImgTag(12, 4);
    } catch (e) {}
    show("setup");
    screenSaver(true);
  }

  // ---------- Channel picker ----------
  // Each kid is a TV channel (CH 1, CH 2…) showing what's on right now,
  // rather than a profile avatar.

  function showPicker() {
    stopPlayer();
    screen = "picker";
    profile = null; channel = null; slot = null;
    if (pickerFocus >= household.profiles.length) pickerFocus = 0;
    renderPicker();
    show("picker");
    screenSaver(true);
  }

  // Crescent moon and a few stars for off-air channel cards.
  var MOON = '<svg class="ch-moon" viewBox="0 0 120 120"><path d="M78 14a46 46 0 1 0 28 76 40 40 0 1 1-28-76z" fill="#FFE9A8"/>' +
    '<circle cx="22" cy="26" r="3" fill="#fff" opacity=".8"/><circle cx="104" cy="18" r="2.5" fill="#fff" opacity=".6"/>' +
    '<circle cx="12" cy="88" r="2" fill="#fff" opacity=".5"/></svg>';

  // In cloud mode thumbnails come through the Worker's cache (/api/thumb), so
  // a whole guide's worth of images doesn't trip YouTube's rate limit.
  function thumbSrc(u) {
    return u && CLOUD ? SERVER + "/api/thumb?u=" + encodeURIComponent(u) : u || "";
  }

  function thumbOf(sl) {
    var show0 = sl && LIB[sl.items[0]];
    return show0 && show0.thumb ? thumbSrc(show0.thumb) : "";
  }

  function renderPicker() {
    var profiles = household.profiles, now = clock(), html = "";
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      var live = S.onAirChannels(p, now, ctx);
      var onSlot = live.length ? S.activeSlot(p, live[0], now, ctx) : null;
      var next = onSlot ? null : S.nextShowing(p, now);
      var color = /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "#4b6bff";
      var top;
      if (onSlot) {
        var thumb = thumbOf(onSlot);
        top = (thumb ? '<img src="' + esc(thumb) + '" alt="">' : "") + '<span class="ch-live">● ON AIR</span>';
      } else {
        // Off air: no picture, just a quiet night sky in the kid's colour.
        top = '<div class="ch-rest" style="background:linear-gradient(160deg,' + color + ' -40%,#141b4d 55%,#0a0f33 100%)">' +
          MOON + '<div class="ch-rest-title">Off air</div>' +
          '<div class="ch-rest-when">' + (next ? "Back " + S.dayWord(next.open, now) + " · " + S.formatTime(next.open) : "Nothing scheduled") + "</div></div>";
      }
      var status = onSlot
        ? esc(S.slotLabel(onSlot, LIB)) + " · until " + S.formatTime(S.slotClosesAt(onSlot, now, ctx, p))
        : next ? "Next: " + esc(S.slotLabel(next.slot, LIB)) : "Add shows on the phone";
      html += '<div class="ch-card' + (onSlot ? " on" : " off") + (i === pickerFocus ? " focused" : "") + '">' +
        '<div class="ch-thumb">' + top + '<span class="ch-num">CH ' + (i + 1) + "</span></div>" +
        '<div class="ch-body"><div class="ch-name"><span class="ch-emoji" style="background:' + color + '">' +
          esc(p.emoji || "🙂") + "</span>" + esc(p.name) + " TV</div>" +
        '<div class="ch-status">' + status + "</div></div></div>";
    }
    $("picker-row").innerHTML = html;
    $("guide-btn").className = "guide-btn" + (pickerFocus === -1 ? " focused" : "");
    $("picker-clock").textContent = S.formatTime(now);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- Tuning ----------

  function enterProfile(p, preferredChannel) {
    profile = p;
    tuneIn(preferredChannel || null);
  }

  // handoff: true when one slot ends and the next begins straight away.
  function tuneIn(preferred, handoff) {
    var now = clock();
    var live = S.onAirChannels(profile, now, ctx);
    if (!live.length) { showOffAir(); return; }
    channel = preferred && live.indexOf(preferred) !== -1 ? preferred : live[0];
    slot = S.activeSlot(profile, channel, now, ctx);
    var pos = S.startPosition(slot, load(posKey()), now);
    index = pos.index;
    var sub = handoff ? "Up next: " + S.slotLabel(slot, LIB)
                      : greeting() + ", " + profile.name + "!  ·  " + S.slotLabel(slot, LIB);
    showIdent(profile.name + " TV", sub, handoff ? 3000 : 3500, function () {
      playVideo(pos.seconds);
    });
  }

  function slotStillOn() {
    return !!profile && !!channel && !!slot && S.activeSlot(profile, channel, clock(), ctx) === slot;
  }

  // The current slot is over: hand off to the next slot, or sign off.
  function slotEnded() {
    savePosition(false);
    stopPlayer();
    if (S.onAirChannels(profile, clock(), ctx).length) tuneIn(channel, true);
    else showOffAir();
  }

  function switchChannel(step) {
    var live = S.onAirChannels(profile, clock(), ctx);
    if (live.length < 2) return;
    savePosition(false);
    var i = live.indexOf(channel);
    var next = live[(i + step + live.length) % live.length];
    stopPlayer();
    tuneIn(next);
  }

  function greeting() {
    var h = clock().getHours();
    return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }

  function showIdent(title, sub, ms, then) {
    screen = "ident";
    hideControls();
    pausePlayer();
    $("ident-name").textContent = title;
    $("ident-sub").textContent = sub;
    show("ident");
    clearTimeout(identTimer);
    identTimer = setTimeout(then, ms);
  }

  // ---------- Playback ----------
  // A slot plays library shows in order. A video plays once; a channel or
  // playlist plays one of its videos per turn and remembers where it got to.

  var listMode = false;    // current show is a channel/playlist
  var listIndex = 0;       // which of its videos we asked for
  var listStarted = false; // that video has actually started

  function currentShow() { return LIB[slot.items[index % slot.items.length]] || null; }

  function itemKey(show) { return "ipos:" + slot.id + ":" + show.id; }

  function itemPos(show) {
    var saved = load(itemKey(show));
    if (!saved) return 0;
    if (slot.playMode !== "continue" && saved.date !== S.dateKey(clock())) return 0;
    return saved.index || 0;
  }

  function saveItemPos(show, i) {
    save(itemKey(show), { date: S.dateKey(clock()), index: i >= 200 ? 0 : i }); // embeds list up to 200
  }

  // A channel's "UU…" uploads list includes vertical Shorts and live
  // streams; YouTube's "UULF…" list has its full-length videos only.
  function listId(show) {
    return show.type === "channel" && /^UU[\w-]{22}$/.test(show.ytId) ? "UULF" + show.ytId.slice(2) : show.ytId;
  }

  function playVideo(startSeconds) {
    if (!slotStillOn()) { slotEnded(); return; }
    screen = "playing";
    paused = false;
    show("player-screen");
    screenSaver(false);
    if (playerReady) loadCurrent(startSeconds);
    else if (window.YT && YT.Player) { pendingStart = startSeconds || 0; if (!player) createPlayer(); }
    else pendingStart = startSeconds || 0;
    openControls(4000);
  }

  function loadCurrent(startSeconds) {
    var s = currentShow();
    if (!s) { advance(false); return; }
    listMode = s.type !== "video";
    // Without a stop first, the embed can keep playing the previous list.
    try { player.stopVideo(); } catch (e) {}
    if (!listMode) {
      player.loadVideoById({ videoId: s.ytId, startSeconds: startSeconds || 0 });
    } else {
      listIndex = itemPos(s);
      listStarted = false;
      player.loadPlaylist({ list: listId(s), listType: "playlist", index: listIndex, startSeconds: startSeconds || 0 });
    }
  }

  function advance(byKid) {
    var s = currentShow();
    if (s && listMode) saveItemPos(s, listIndex + 1);
    savePosition(true);
    index = (index + 1) % slot.items.length;
    if (!slotStillOn()) { slotEnded(); return; }
    if (byKid) { playVideo(0); return; }
    var next = currentShow();
    showIdent(profile.name + " TV", "Up next: " + (next ? next.title : ""), 3000, function () { playVideo(0); });
  }

  function togglePause() {
    if (!playerReady || screen !== "playing") return;
    if (paused) player.playVideo(); else player.pauseVideo();
  }

  function stopPlayer() {
    clearTimeout(identTimer);
    hideControls();
    if (player && playerReady) { try { player.stopVideo(); } catch (e) {} }
  }

  // Before anything else takes the screen: a hidden player must not keep playing.
  function pausePlayer() {
    if (player && playerReady) { try { player.pauseVideo(); } catch (e) {} }
  }

  function createPlayer() {
    var vars = { autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1,
                 playsinline: 1, enablejsapi: 1, iv_load_policy: 3, fs: 0, cc_load_policy: 0 };
    if (location.protocol.indexOf("http") === 0) vars.origin = location.origin;
    player = new YT.Player("player", {
      width: 1920, height: 1080, playerVars: vars,
      events: {
        onReady: function () {
          playerReady = true;
          if (screen === "playing") { loadCurrent(pendingStart || 0); pendingStart = null; }
        },
        onStateChange: function (e) {
          if (screen !== "playing") return;
          if (listMode) {
            // The embed moves on to the channel's next video by itself; treat
            // that as this show's turn being over.
            var idx = -1;
            try { idx = player.getPlaylistIndex(); } catch (err) {}
            if (e.data === YT.PlayerState.PLAYING && idx === listIndex) listStarted = true;
            else if (listStarted && idx >= 0 && idx !== listIndex) {
              listIndex = idx - 1; // advance() saves listIndex + 1 = the video it moved to
              player.pauseVideo();
              advance(false);
              return;
            }
          }
          if (e.data === YT.PlayerState.PLAYING) { paused = false; if (!offline) playerNote(""); }
          // A new video may bring captions back (some channels switch them on): keep the family's choice.
          if (e.data === YT.PlayerState.PLAYING) {
            var vid = "";
            try { vid = player.getVideoData().video_id; } catch (err) {}
            if (vid !== ccVideo) { ccVideo = vid; captionsSoon(); }
          }
          if (e.data === YT.PlayerState.PAUSED) paused = true;
          if (e.data === YT.PlayerState.ENDED) {
            if (listMode) listIndex = -1; // end of the whole list: start it over next time
            advance(false);
            return;
          }
          renderControls();
          if (paused) openControls(0); else scheduleHide(4000);
        },
        onPlaybackQualityChange: function () { renderQuality(); },
        onApiChange: function () { applyCaptions(); },
        onError: function (e) {
          // 2 bad id · 5 html5 error · 100 removed · 101/150 owner blocks embedding · 152/153 player config
          var s = currentShow();
          playerNote("Can't play \"" + (s ? s.title : "this video") + "\" · skipping");
          setTimeout(function () { if (screen === "playing") advance(false); }, 4000);
        }
      }
    });
  }

  function loadYouTubeApi() {
    window.onYouTubeIframeAPIReady = function () {
      if (pendingStart !== null && screen === "playing" && !player) createPlayer();
    };
    var s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = function () { debug("Could not reach YouTube. Is the TV online?"); };
    document.head.appendChild(s);
  }

  // ---------- Controls ----------
  // YouTube allows nothing drawn over its player, so the controls never sit
  // on top of it: opening them shrinks the player into a frame (still far
  // above the 200x200 minimum) with the controls underneath.

  // Captions start off every time the app opens and for every new video;
  // the CC button turns them on for as long as the app stays open.
  var ccOn = false, ccVideo = "";
  // YouTube loads its captions part a moment after a video starts, and it
  // remembers if captions were ever switched on, so "off" is applied again once
  // that part has loaded (onApiChange) and a few seconds into each video.
  function applyCaptions() {
    if (!player || !playerReady) return;
    try {
      if (ccOn) { player.loadModule("captions"); player.setOption("captions", "reload", true); return; }
      player.setOption("captions", "track", {});
      player.unloadModule("captions");
    } catch (e) {}
  }
  function captionsSoon() {
    applyCaptions();
    setTimeout(applyCaptions, 1500);
    setTimeout(applyCaptions, 5000);
  }

  // What YouTube is actually playing. Quality can't be chosen from an embed
  // (YouTube picks it from the screen size and the connection), but it can be
  // read, so the Quality button shows it.
  var QUALITY = { tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p",
                  hd1440: "1440p", hd2160: "4K", highres: "4K+" };
  var qualityUntil = 0;
  function renderQuality() {
    var el = $("c-quality");
    if (Date.now() > qualityUntil) { el.textContent = ""; return; }
    var q = "", best = "";
    try { q = player.getPlaybackQuality(); } catch (e) {}
    try { best = (player.getAvailableQualityLevels() || []).filter(function (l) { return QUALITY[l]; })[0] || ""; } catch (e) {}
    el.textContent = "Quality: " + (QUALITY[q] || "choosing…") + (QUALITY[best] && best !== q ? " (this video goes up to " + QUALITY[best] + ")" : "");
  }

  var note = "";
  function playerNote(msg) {
    if (msg === note) return;
    note = msg;
    $("c-note").textContent = msg;
    if (msg) openControls(0);
    else if (controlsOpen) scheduleHide(4000);
  }

  function buttons() {
    var all = $("c-buttons").getElementsByTagName("button");
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].style.display !== "none") out.push(all[i]);
    return out;
  }

  function openControls(hideAfter) {
    if (screen !== "playing") return;
    $("btn-next").style.display = profile.allowSkip ? "" : "none";
    if (!controlsOpen) controlsFocus = 1;
    controlsOpen = true;
    $("controls").className = "controls";
    $("player-screen").className = "screen framed";
    renderControls();
    scheduleHide(hideAfter === undefined ? 5000 : hideAfter);
  }

  function scheduleHide(ms) {
    clearTimeout(controlsTimer);
    if (ms > 0 && !paused && !note) controlsTimer = setTimeout(hideControls, ms);
  }

  function hideControls() {
    clearTimeout(controlsTimer);
    controlsOpen = false;
    $("controls").className = "controls hidden";
    if ($("player-screen").className === "screen framed") $("player-screen").className = "screen";
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function renderControls() {
    if (!controlsOpen || !slot) return;
    var cs = currentShow();
    var next = LIB[slot.items[(index + 1) % slot.items.length]];
    var playing = "";
    try { playing = listMode && player.getVideoData ? player.getVideoData().title : ""; } catch (e) {}
    // For a channel, show the episode's own title and say which channel it's from.
    $("c-channel").textContent = channel.name + (listMode && cs ? " · " + cs.title : slot.name ? " · " + slot.name : "");
    $("c-ends").textContent = (paused ? "❚❚ Paused · " : "") + "On until " + S.formatTime(S.slotClosesAt(slot, clock(), ctx, profile));
    $("c-title").textContent = playing || (cs ? cs.title : "");
    $("c-next").textContent = slot.items.length > 1 && next ? "Up next: " + next.title : "";
    $("btn-toggle").textContent = paused ? "▶ Play" : "❚❚ Pause";
    $("btn-cc").textContent = ccOn ? "CC On" : "CC Off";
    renderQuality();
    var cur = 0, dur = 0;
    try { cur = player.getCurrentTime(); dur = player.getDuration(); } catch (e) {}
    $("c-time").textContent = fmt(cur) + " / " + fmt(dur);
    $("c-progress").style.width = (dur ? Math.min(100, cur / dur * 100) : 0) + "%";
    var b = buttons();
    if (controlsFocus >= b.length) controlsFocus = b.length - 1;
    for (var i = 0; i < b.length; i++) b[i].className = i === controlsFocus ? "focused" : "";
  }

  function pressButton() {
    var act = buttons()[controlsFocus].getAttribute("data-act");
    if (act === "toggle") togglePause();
    if (act === "restart" && playerReady) { player.seekTo(0, true); player.playVideo(); }
    if (act === "next" && profile.allowSkip) advance(true);
    if (act === "guide") { openGuide("playing"); return; }
    if (act === "cc") { ccOn = !ccOn; applyCaptions(); renderControls(); }
    if (act === "quality") { qualityUntil = Date.now() + 8000; renderControls(); scheduleHide(8000); return; }
    scheduleHide(5000);
  }

  // ---------- Off air ----------

  function signOff() {
    if (slot) savePosition(false);
    stopPlayer();
    showOffAir();
  }

  function showOffAir() {
    pausePlayer();
    screen = "offair";
    if (!profile) { showPicker(); return; }
    var now = clock();
    $("offair-name").textContent = profile.name + " TV";
    var next = S.nextShowing(profile, now);
    $("offair-next").textContent = next
      ? "Next: " + S.slotLabel(next.slot, LIB) + " · " + S.dayWord(next.open, now) + " at " + S.formatTime(next.open)
      : "No shows scheduled yet";
    var rows = S.todayGuide(profile, now), html = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<li class="' + r.status + '"><span>' + S.formatTime(r.open) + "</span> " + esc(S.slotLabel(r.slot, LIB)) +
        (r.status === "done" ? " ✓" : "") + "</li>";
    }
    $("offair-guide").innerHTML = rows.length ? "<li class=\"head\">Today</li>" + html : "";
    $("offair-bye").textContent = "Bye bye, " + profile.name + "! 👋";
    show("offair");
    screenSaver(true);
  }

  // ---------- Channels Guide ----------
  // TV listings: one row per kid's channel, a timeline of the day with each
  // time slot as a block (thumbnail, name, times), off-air gaps, a "now"
  // line. Up from the first row reaches the day tabs (today + 6 days).

  var G_START = 6, G_END = 23;           // hours shown, 6 AM – 11 PM
  var G_PX = 380;                        // pixels per hour (a half-hour block stays readable)
  var G_VIEW = 1920 - 320;               // visible timeline width
  var guideFrom = "picker";              // screen to return to
  var gDay = 0;                          // 0 = today … 6
  var gRow = 0, gCol = 0;                // focused block; gRow -1 = day tabs
  var gRows = [];                        // [{ profile, blocks: [dayGuide rows] }]
  var gScroll = 0;

  function guideDate() {
    var d = clock();
    d.setDate(d.getDate() + gDay);
    return d;
  }

  function openGuide(from) {
    guideFrom = from;
    if (from === "playing" && playerReady) { try { player.pauseVideo(); } catch (e) {} }
    hideControls();
    screen = "guide";
    gDay = 0; gRow = 0; gCol = -1;
    buildGuide();
    focusNearest(clock());
    renderGuide();
    show("guide");
  }

  function closeGuide() {
    if (guideFrom === "playing" && profile && slot && slotStillOn()) {
      screen = "playing";
      show("player-screen");
      try { player.playVideo(); } catch (e) {}
      openControls();
    } else if (guideFrom === "offair" && profile) {
      showOffAir();
    } else {
      showPicker();
    }
  }

  function buildGuide() {
    var day = guideDate(), now = clock();
    gRows = [];
    for (var i = 0; i < household.profiles.length; i++) {
      var p = household.profiles[i];
      gRows.push({ profile: p, blocks: S.dayGuide(p, day, now) });
    }
  }

  function minutesOf(d) { return d.getHours() * 60 + d.getMinutes(); }
  function xOf(d) { return (minutesOf(d) - G_START * 60) / 60 * G_PX; }

  // Focus the block in gRow closest to a time (or the first one).
  function focusNearest(t) {
    if (gRow < 0) return;
    var blocks = gRows[gRow] ? gRows[gRow].blocks : [];
    gCol = blocks.length ? 0 : -1;
    var best = Infinity;
    for (var i = 0; i < blocks.length; i++) {
      var d = Math.abs(minutesOf(blocks[i].open) - minutesOf(t));
      if (minutesOf(blocks[i].open) <= minutesOf(t) && minutesOf(t) < minutesOf(blocks[i].close)) d = -1;
      if (d < best) { best = d; gCol = i; }
    }
  }

  function focusedBlock() {
    return gRow >= 0 && gRows[gRow] && gCol >= 0 ? gRows[gRow].blocks[gCol] : null;
  }

  function hourLabel(h) { return (h % 12 || 12) + (h < 12 || h === 24 ? " AM" : " PM"); }

  function renderGuide() {
    var now = clock(), html = "", i, j;
    for (i = 0; i < 7; i++) {
      var d = clock(); d.setDate(d.getDate() + i);
      var label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
      html += '<span class="g-day' + (i === gDay ? " active" : "") + (gRow === -1 && i === gDay ? " focused" : "") + '">' + label + "</span>";
    }
    $("g-days").innerHTML = html;
    $("guide-clock").textContent = S.formatTime(now);

    html = "";
    for (i = G_START; i <= G_END; i++) {
      html += '<span class="g-hour" style="left:' + (i - G_START) * G_PX + 'px">' + hourLabel(i) + "</span>";
    }
    $("g-hours").innerHTML = html;

    var labels = "", rows = "";
    for (i = 0; i < gRows.length; i++) {
      var p = gRows[i].profile;
      var color = /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "#4b6bff";
      labels += '<div class="g-label' + (i === gRow ? " current" : "") + '"><span class="g-ch">CH ' + (i + 1) + '</span>' +
        '<span class="g-emoji" style="background:' + color + '">' + esc(p.emoji || "🙂") + '</span><span class="g-name">' + esc(p.name) + " TV</span></div>";
      rows += '<div class="g-row">';
      var blocks = gRows[i].blocks;
      if (!blocks.length) rows += '<div class="g-empty' + (i === gRow ? " focused" : "") + '">Off air all day</div>';
      for (j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        var left = xOf(b.open), width = Math.max(xOf(b.close) - left - 8, 150);
        var thumb = thumbOf(b.slot);
        rows += '<div class="g-block ' + b.status + (i === gRow && j === gCol ? " focused" : "") + '" style="left:' + left + "px;width:" + width + 'px">' +
          (thumb ? '<img src="' + esc(thumb) + '" alt="">' : "") +
          '<div class="g-btext"><div class="g-btitle">' + esc(S.slotLabel(b.slot, LIB)) + "</div>" +
          '<div class="g-btime">' + S.formatTime(b.open) + " – " + S.formatTime(b.close) +
          (b.status === "now" && gDay === 0 ? ' <span class="g-onnow">ON NOW</span>' : "") + "</div></div></div>";
      }
      rows += "</div>";
    }
    $("g-labels").innerHTML = labels;
    $("g-rows").innerHTML = rows;

    var nowX = xOf(now);
    $("g-now").style.display = gDay === 0 && nowX >= 0 && nowX <= (G_END - G_START) * G_PX ? "block" : "none";
    $("g-now").style.left = nowX + "px";

    // Keep the focused block in view; on today, also keep "now" in view when both fit.
    var fb = focusedBlock();
    var target = fb ? xOf(fb.open) : (gDay === 0 ? nowX : xOf(new Date(2000, 0, 1, 15)));
    if (target < gScroll + 80 || target > gScroll + G_VIEW - 420) {
      gScroll = Math.max(0, target - 300);
      if (gDay === 0 && nowX < target && target - nowX < G_VIEW - 500) gScroll = Math.max(0, nowX - 120);
    }
    gScroll = Math.min(gScroll, (G_END - G_START) * G_PX - G_VIEW + 40);
    $("g-track").style.transform = "translateX(" + (-gScroll) + "px)";

    renderGuideDetail(fb, now);
  }

  function renderGuideDetail(b, now) {
    if (gRow === -1) { $("g-detail").innerHTML = '<div class="gd-info"><div class="gd-title">Pick a day</div><div class="gd-time">◀ ▶ to change day · ▼ back to the listings</div></div>'; return; }
    var p = gRows[gRow] && gRows[gRow].profile;
    if (!b) { $("g-detail").innerHTML = '<div class="gd-info"><div class="gd-title">' + esc(p ? p.name + " TV" : "") + ' is off air all day</div></div>'; return; }
    var when = b.status === "now" && gDay === 0 ? '<span class="gd-live">● ON NOW · OK to watch</span>'
      : b.status === "done" && gDay === 0 ? "Finished"
      : "Starts " + S.dayWord(b.open, now) + " at " + S.formatTime(b.open);
    var shows = "";
    for (var i = 0; i < b.slot.items.length && i < 5; i++) {
      var sh = LIB[b.slot.items[i]];
      if (!sh) continue;
      shows += '<div class="gd-show ' + esc(sh.type) + '">' + (sh.thumb ? '<img src="' + esc(thumbSrc(sh.thumb)) + '" alt="">' : "<i></i>") +
        "<span>" + esc(sh.title) + "</span></div>";
    }
    $("g-detail").innerHTML =
      '<div class="gd-info"><div class="gd-title">' + esc(S.slotLabel(b.slot, LIB)) + "</div>" +
      '<div class="gd-time">' + esc(p.name) + " TV · " + S.formatTime(b.open) + " – " + S.formatTime(b.close) + " · " + when + "</div></div>" +
      '<div class="gd-shows">' + shows + "</div>";
  }

  function guideKey(k) {
    if (k === KEY.BACK) { closeGuide(); return; }
    var fb = focusedBlock();
    var refTime = fb ? fb.open : clock();
    if (gRow === -1) {
      if (k === KEY.LEFT && gDay > 0) { gDay--; buildGuide(); }
      if (k === KEY.RIGHT && gDay < 6) { gDay++; buildGuide(); }
      if (k === KEY.DOWN || k === KEY.ENTER) { gRow = 0; focusNearest(gDay === 0 ? clock() : new Date(2000, 0, 1, 15)); }
    } else if (k === KEY.UP) {
      if (gRow === 0) gRow = -1; else { gRow--; focusNearest(refTime); }
    } else if (k === KEY.DOWN) {
      if (gRow < gRows.length - 1) { gRow++; focusNearest(refTime); }
    } else if (k === KEY.LEFT) {
      if (gCol > 0) gCol--;
    } else if (k === KEY.RIGHT) {
      if (fb && gCol < gRows[gRow].blocks.length - 1) gCol++;
    } else if (k === KEY.ENTER) {
      if (fb && fb.status === "now" && gDay === 0) {
        if (guideFrom === "playing") { savePosition(false); stopPlayer(); }
        enterProfile(gRows[gRow].profile, fb.channel);
        return;
      }
    }
    renderGuide();
  }

  // ---------- Remote ----------

  // On a Samsung TV this page runs inside the installed launcher's frame;
  // only the launcher may close the app or touch the screensaver, so ask it.
  var EMBEDDED = window.parent !== window;

  function tellLauncher(msg) {
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  // The Android TV app (apps/android-tv) opens this page directly and offers
  // a small bridge for the same two jobs.
  var ANDROID = window.SaturdayAndroid || null;

  function exitApp() {
    if (ANDROID) { try { ANDROID.exit(); } catch (e) {} return; }
    if (EMBEDDED) { tellLauncher({ type: "exit" }); return; }
    try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
  }

  // Back on a top-level screen asks first (a Samsung store requirement).
  // "Stay" has focus, so a stray Back-then-OK doesn't close the app.
  var exitOpen = false, exitFocus = 0;
  function askExit() {
    exitOpen = true; exitFocus = 0;
    $("exit-dialog").className = "exit-dialog";
    renderExit();
  }
  function renderExit() {
    $("exit-stay").className = exitFocus === 0 ? "focused" : "";
    $("exit-close").className = exitFocus === 1 ? "focused" : "";
  }
  function exitKey(k) {
    if (k === KEY.LEFT || k === KEY.RIGHT) { exitFocus = 1 - exitFocus; renderExit(); return; }
    if (k === KEY.ENTER && exitFocus === 1) { exitApp(); return; }
    if (k === KEY.ENTER || k === KEY.BACK) { exitOpen = false; $("exit-dialog").className = "exit-dialog hidden"; }
  }

  function registerKeys() {
    try {
      tizen.tvinputdevice.registerKeyBatch(["MediaPlayPause", "MediaPlay", "MediaPause",
        "MediaStop", "MediaFastForward", "MediaRewind", "ChannelUp", "ChannelDown"]);
    } catch (e) {}
  }

  // Mac keyboard stand-ins for previewing: Esc = Back, Space = Play/Pause,
  // PageUp/PageDown = channel up/down.
  function keyOf(e) {
    if (e.keyCode === 27 || e.keyCode === 8) return KEY.BACK;
    if (e.keyCode === 32) return KEY.PLAYPAUSE;
    if (e.keyCode === 33) return KEY.CH_UP;
    if (e.keyCode === 34) return KEY.CH_DOWN;
    return e.keyCode;
  }

  document.addEventListener("keydown", function (e) {
    var k = keyOf(e);
    if (k === KEY.BACK || k === 32 || k === 8) e.preventDefault();
    handleKey(k);
  });

  // Keys the launcher caught (when focus sat on it rather than this frame).
  window.addEventListener("message", function (e) {
    if (e.source === window.parent && e.data && e.data.type === "key") handleKey(keyOf({ keyCode: e.data.keyCode }));
  });

  function handleKey(k) {
    if (exitOpen) { exitKey(k); return; }

    if (screen === "setup") { if (k === KEY.BACK) askExit(); return; }

    if (screen === "picker") {
      var n = household.profiles.length;
      if (pickerFocus === -1) {
        if (k === KEY.UP) pickerFocus = 0;
        if (k === KEY.ENTER) { openGuide("picker"); return; }
      } else {
        if (k === KEY.LEFT) pickerFocus = (pickerFocus - 1 + n) % n;
        if (k === KEY.RIGHT) pickerFocus = (pickerFocus + 1) % n;
        if (k === KEY.DOWN) pickerFocus = -1;
        if (k === KEY.ENTER) { enterProfile(household.profiles[pickerFocus]); return; }
      }
      if (k === KEY.BACK) { askExit(); return; }
      renderPicker();
      return;
    }

    if (screen === "guide") { guideKey(k); return; }

    if (screen === "offair") {
      if (k === KEY.ENTER) openGuide("offair");
      if (k === KEY.BACK) showPicker();
      return;
    }

    if (screen === "ident") {
      if (k === KEY.BACK) showPicker();
      return;
    }

    if (screen === "playing") {
      if (k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) {
        if ((k === KEY.PLAY && !paused) || (k === KEY.PAUSE && paused)) return;
        togglePause(); openControls(); return;
      }
      if (k === KEY.FF && profile.allowSkip) { advance(true); return; }
      if (k === KEY.CH_UP) { switchChannel(1); return; }
      if (k === KEY.CH_DOWN) { switchChannel(-1); return; }

      if (!controlsOpen) {
        if (k === KEY.BACK) { savePosition(false); showPicker(); return; }
        if (k === KEY.ENTER || k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN) openControls();
        return;
      }
      var b = buttons();
      if (k === KEY.LEFT) controlsFocus = Math.max(0, controlsFocus - 1);
      if (k === KEY.RIGHT) controlsFocus = Math.min(b.length - 1, controlsFocus + 1);
      if (k === KEY.ENTER) { pressButton(); return; }
      if (k === KEY.BACK || k === KEY.DOWN) { hideControls(); return; }
      renderControls();
      scheduleHide(5000);
    }
  }

  // ---------- Samsung bits ----------

  function screenSaver(on) {
    if (ANDROID) { try { ANDROID.keepScreenOn(!on); } catch (e) {} return; }
    if (EMBEDDED) { tellLauncher({ type: "screensaver", on: on }); return; }
    try {
      var ac = window.webapis && window.webapis.appcommon;
      if (!ac) return;
      ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_ON
                           : ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
    } catch (e) {}
  }

  // On the TV the window is exactly 1920x1080. In a Mac browser window,
  // shrink the whole screen to fit so the preview looks like the TV.
  function fitToWindow() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    document.body.style.transformOrigin = "0 0";
    document.body.style.transform = s < 1 ? "scale(" + s + ")" : "";
  }

  // ---------- Clock ----------

  function tick() {
    var now = clock();
    if ((screen === "playing" || screen === "ident") && slot && !slotStillOn()) {
      slotEnded();
    } else if (screen === "offair" && profile && S.onAirChannels(profile, now, ctx).length) {
      tuneIn(null);
    } else if (screen === "playing") {
      savePosition(false);
    } else if (screen === "picker") {
      renderPicker(); // keep the clock and on-air badges fresh
    } else if (screen === "guide") {
      buildGuide();
      renderGuide();
    }
  }

  window.addEventListener("resize", fitToWindow);
  fitToWindow();
  registerKeys();
  loadYouTubeApi();
  sync();
  setInterval(sync, (cfg.syncSeconds || 30) * 1000);
  setInterval(tick, 5000);
  setInterval(renderControls, 500);
})();
