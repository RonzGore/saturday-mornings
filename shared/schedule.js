// Schedule maths, kept free of any screen code so it can be tested with
// `node test/schedule.test.js`. Plain ES5 for older Samsung TVs.
//
// household.library holds every show (a video, a YouTube channel or a
// playlist). profile -> channels -> slots; a slot is one block of TV time
// that plays library shows: { days: [0-6, Sunday = 0], open: "15:30",
// close: "15:45", items: [libraryId, ...] }. Different slots give different
// shows per time of day, per weekday, or the same shows all week.
(function (root) {
  // ctx = { testMinutes, appStartedAt, forceOffAir }

  function at(day, hm) {
    var p = hm.split(":");
    var d = new Date(day.getTime());
    d.setHours(parseInt(p[0], 10), parseInt(p[1], 10), 0, 0);
    return d;
  }

  function slotsOf(channel) { return channel.slots || []; }
  function playable(slot) { return slot.items && slot.items.length > 0; }

  function windowOn(slot, day) {
    if (!slot.days || slot.days.indexOf(day.getDay()) === -1) return null;
    var w = { open: at(day, slot.open), close: at(day, slot.close) };
    return w.close > w.open ? w : null;
  }

  function testSlot(profile) {
    var ch = profile.channels[0];
    if (!ch) return null;
    var s = slotsOf(ch);
    for (var i = 0; i < s.length; i++) if (playable(s[i])) return s[i];
    return null;
  }

  function testing(ctx) { return ctx && ctx.testMinutes > 0; }
  function testEnds(ctx) { return new Date(ctx.appStartedAt + ctx.testMinutes * 60000); }

  // Today's parent override for a kid, set from the phone:
  // profile.today = { date: "2026-10-19", off: true } turns the kid's TV off
  // for the rest of the day; { date, more: { slot: slotId, until: "16:40" } }
  // keeps (or brings back) one of today's slots until a later time.
  // Overrides from another day are ignored.
  function todayOf(profile, now) {
    var t = profile && profile.today;
    return t && t.date === dateKey(now) ? t : null;
  }

  function moreUntil(profile, slot, now) {
    var t = todayOf(profile, now);
    if (!t || !t.more || t.more.slot !== slot.id || !/^\d\d:\d\d$/.test(t.more.until)) return null;
    var w = windowOn(slot, now);
    return w ? at(now, t.more.until) : null;
  }

  // The slot playing on this channel right now, or null.
  function activeSlot(profile, channel, now, ctx) {
    if (ctx && ctx.forceOffAir) return null;
    if (testing(ctx)) {
      var t = testSlot(profile);
      return channel === profile.channels[0] && t && now < testEnds(ctx) ? t : null;
    }
    var today = todayOf(profile, now);
    if (today && today.off) return null;
    var s = slotsOf(channel);
    for (var i = 0; i < s.length; i++) {
      if (!playable(s[i])) continue;
      var w = windowOn(s[i], now);
      if (w && now >= w.open && now < w.close) return s[i];
    }
    // Extra time from the phone: the slot stays on (or comes back) until then.
    for (i = 0; i < s.length; i++) {
      if (!playable(s[i])) continue;
      var until = moreUntil(profile, s[i], now);
      if (until && now >= windowOn(s[i], now).open && now < until) return s[i];
    }
    return null;
  }

  // When the slot goes off air: its scheduled close, or later with extra time.
  // Pass the profile so extra time counts.
  function slotClosesAt(slot, now, ctx, profile) {
    if (testing(ctx)) return testEnds(ctx);
    var w = windowOn(slot, now);
    if (!w) return now;
    var until = moreUntil(profile, slot, now);
    return until && until > w.close ? until : w.close;
  }

  // The household's wall-clock time: a Date whose local fields read as the
  // time in the household's time zone (IANA name, e.g. "America/Vancouver"),
  // so a TV whose own zone is set wrong still keeps the family's schedule.
  // Falls back to the device clock when tz is missing or Intl can't do it
  // (very old TVs). Uses format(), not formatToParts(), for older browsers.
  function wallNow(tz, real) {
    real = real || new Date();
    if (!tz || typeof Intl === "undefined") return real;
    try {
      var s = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric"
      }).format(real);
      var m = /(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/.exec(s);
      if (!m) return real;
      return new Date(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5], +m[6], real.getMilliseconds());
    } catch (e) {
      return real;
    }
  }

  function onAirChannels(profile, now, ctx) {
    var out = [];
    for (var i = 0; i < profile.channels.length; i++) {
      if (activeSlot(profile, profile.channels[i], now, ctx)) out.push(profile.channels[i]);
    }
    return out;
  }

  // The soonest upcoming slot across a profile's channels (next 8 days).
  // Turned off for today: nothing more today.
  function nextShowing(profile, now) {
    var best = null, today = todayOf(profile, now);
    for (var d = today && today.off ? 1 : 0; d < 8; d++) {
      var day = new Date(now.getTime());
      day.setDate(day.getDate() + d);
      for (var i = 0; i < profile.channels.length; i++) {
        var s = slotsOf(profile.channels[i]);
        for (var j = 0; j < s.length; j++) {
          if (!playable(s[j])) continue;
          var w = windowOn(s[j], day);
          if (w && w.open > now && (!best || w.open < best.open)) {
            best = { channel: profile.channels[i], slot: s[j], open: w.open };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // Today's slots for the off-air card, earliest first.
  function todayGuide(profile, now) { return dayGuide(profile, now, now); }

  // One day's slots for the Channel Guide, earliest first, each marked
  // done / now / later relative to `now`.
  function dayGuide(profile, day, now) {
    var rows = [];
    for (var i = 0; i < profile.channels.length; i++) {
      var s = slotsOf(profile.channels[i]);
      for (var j = 0; j < s.length; j++) {
        var w = windowOn(s[j], day);
        if (!w || !playable(s[j])) continue;
        rows.push({
          channel: profile.channels[i], slot: s[j], open: w.open, close: w.close,
          status: now >= w.close ? "done" : now >= w.open ? "now" : "later"
        });
      }
    }
    rows.sort(function (a, b) { return a.open - b.open; });
    return rows;
  }

  // What to call a slot on screen: its own name, else its first show.
  // lib is the library as a map of id -> show.
  function slotLabel(slot, lib) {
    var first = lib && slot.items && lib[slot.items[0]];
    return slot.name || (first ? first.title : "Shows");
  }

  function libraryMap(household) {
    var m = {};
    var l = household.library || [];
    for (var i = 0; i < l.length; i++) m[l[i].id] = l[i];
    return m;
  }

  // Slots on the same day whose times overlap: the phone warns about these.
  function overlaps(channel, slot) {
    var out = [];
    var s = slotsOf(channel);
    for (var i = 0; i < s.length; i++) {
      var o = s[i];
      if (o === slot) continue;
      var sharesDay = false;
      for (var d = 0; d < slot.days.length; d++) if (o.days.indexOf(slot.days[d]) !== -1) sharesDay = true;
      if (sharesDay && slot.open < o.close && o.open < slot.close) out.push(o);
    }
    return out;
  }

  function formatTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var suffix = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + suffix;
  }

  function dayWord(target, now) {
    var a = new Date(now.getTime()); a.setHours(0, 0, 0, 0);
    var b = new Date(target.getTime()); b.setHours(0, 0, 0, 0);
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    return ["on Sunday", "on Monday", "on Tuesday", "on Wednesday",
            "on Thursday", "on Friday", "on Saturday"][target.getDay()];
  }

  function dateKey(d) {
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  // Where to start a slot's videos. Small kids like the same videos every
  // day, so "repeat" starts from the top each new day; "continue" carries on
  // through the list across days. Same-day re-entry resumes.
  function startPosition(slot, saved, now) {
    var n = slot.items.length;
    if (!saved) return { index: 0, seconds: 0 };
    if (saved.date === dateKey(now)) {
      return { index: saved.index % n, seconds: saved.seconds || 0 };
    }
    if (slot.playMode === "continue") {
      return saved.finished ? { index: (saved.index + 1) % n, seconds: 0 }
                            : { index: saved.index % n, seconds: saved.seconds || 0 };
    }
    return { index: 0, seconds: 0 };
  }

  // Older saves had one schedule per channel; turn that into a single slot.
  function migrateChannel(c) {
    if (c.slots) return c;
    return {
      id: c.id, name: c.name,
      slots: [{ id: c.id + "s", name: "", days: c.days || [], open: c.open || "15:30",
                close: c.close || "16:00", playMode: c.playMode || "repeat", videos: c.videos || [] }]
    };
  }

  // Brings any older save up to date: channels get slots, and videos pasted
  // straight into a slot move into the shared library. Changes h in place.
  function migrateHousehold(h) {
    h.library = h.library || [];
    var byYt = {};
    for (var i = 0; i < h.library.length; i++) byYt[h.library[i].type + ":" + h.library[i].ytId] = h.library[i];
    var profiles = h.profiles || [];
    for (var p = 0; p < profiles.length; p++) {
      var chs = profiles[p].channels = (profiles[p].channels || []).map(migrateChannel);
      for (var c = 0; c < chs.length; c++) {
        for (var s = 0; s < chs[c].slots.length; s++) {
          var slot = chs[c].slots[s];
          slot.items = slot.items || [];
          var vids = slot.videos || [];
          for (var v = 0; v < vids.length; v++) {
            var key = "video:" + vids[v].id;
            if (!byYt[key]) {
              byYt[key] = { id: "v" + vids[v].id.replace(/[^a-z0-9]/gi, "").slice(0, 11), type: "video", ytId: vids[v].id,
                            title: vids[v].title || "YouTube video", by: vids[v].by || "" };
              h.library.push(byYt[key]);
            }
            slot.items.push(byYt[key].id);
          }
          delete slot.videos;
        }
      }
    }
    return h;
  }

  var api = {
    windowOn: windowOn, activeSlot: activeSlot, slotClosesAt: slotClosesAt,
    onAirChannels: onAirChannels, nextShowing: nextShowing, todayGuide: todayGuide, dayGuide: dayGuide,
    slotLabel: slotLabel, libraryMap: libraryMap, migrateHousehold: migrateHousehold, overlaps: overlaps, formatTime: formatTime, dayWord: dayWord,
    dateKey: dateKey, startPosition: startPosition, migrateChannel: migrateChannel,
    todayOf: todayOf, wallNow: wallNow
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Schedule = api;
})(this);
