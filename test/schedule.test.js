// node test/schedule.test.js
var assert = require("assert");
var S = require("../shared/schedule.js");

function v(id) { return id; } // slots hold library ids
var lib = { d: { id: "d", type: "video", ytId: "ddddddddddd", title: "Blippi Zoo" } };

// One channel, several slots: per time of day, per weekday, and weekends.
var peppa = { id: "p", name: "Peppa time", days: [1, 2, 3, 4, 5], open: "15:30", close: "15:45", items: [v("a"), v("b"), v("c")] };
var blippiMon = { id: "bm", name: "", days: [1], open: "15:45", close: "16:00", items: [v("d")] };
var bluey = { id: "bl", name: "Bluey", days: [0, 6], open: "09:00", close: "10:00", items: [v("e")] };
var emptySlot = { id: "x", name: "Empty", days: [1, 2, 3, 4, 5], open: "15:00", close: "17:00", items: [] };
var afternoon = { id: "a", name: "Afternoon", slots: [peppa, blippiMon, bluey, emptySlot] };
var kid = { id: "k", name: "Maya", channels: [afternoon] };

var mon1535 = new Date(2026, 9, 19, 15, 35); // Monday
var mon1550 = new Date(2026, 9, 19, 15, 50);
var tue1550 = new Date(2026, 9, 20, 15, 50);
var mon1700 = new Date(2026, 9, 19, 17, 0);
var fri1700 = new Date(2026, 9, 23, 17, 0);

assert.strictEqual(S.activeSlot(kid, afternoon, mon1535, {}), peppa, "per-time slot; empty slot ignored");
assert.strictEqual(S.activeSlot(kid, afternoon, mon1550, {}), blippiMon, "Monday-only slot follows on");
assert.strictEqual(S.activeSlot(kid, afternoon, tue1550, {}), null, "Monday-only slot not on Tuesday");
assert.strictEqual(S.activeSlot(kid, afternoon, new Date(2026, 9, 19, 15, 45), {}), blippiMon, "close is exclusive, next slot starts");
assert.strictEqual(S.onAirChannels(kid, mon1700, {}).length, 0, "off after last slot");
assert.strictEqual(S.formatTime(S.slotClosesAt(peppa, mon1535, {})), "3:45 PM");

var next = S.nextShowing(kid, mon1700);
assert.strictEqual(next.slot, peppa);
assert.strictEqual(S.dayWord(next.open, mon1700), "tomorrow");
assert.strictEqual(S.nextShowing(kid, fri1700).slot, bluey, "weekend slot next after Friday");

var guide = S.todayGuide(kid, mon1550);
assert.deepStrictEqual(guide.map(function (r) { return r.status; }), ["done", "now"]);
assert.strictEqual(S.slotLabel(guide[1].slot, lib), "Blippi Zoo", "unnamed slot uses first show title");
assert.strictEqual(S.slotLabel(peppa), "Peppa time");

assert.strictEqual(S.overlaps(afternoon, peppa).length, 1, "peppa overlaps the 3-5 empty slot");
assert.deepStrictEqual(S.overlaps(afternoon, bluey), [], "weekend slot overlaps nothing");

assert.strictEqual(S.onAirChannels(kid, mon1700, { forceOffAir: true }).length, 0);
var started = mon1700.getTime();
assert.strictEqual(S.activeSlot(kid, afternoon, new Date(started + 30000), { testMinutes: 1, appStartedAt: started }), peppa, "test mode plays first playable slot");

// Start positions
var today = S.dateKey(mon1535);
var yesterday = S.dateKey(new Date(2026, 9, 18));
assert.deepStrictEqual(S.startPosition(peppa, null, mon1535), { index: 0, seconds: 0 });
assert.deepStrictEqual(S.startPosition(peppa, { date: today, index: 1, seconds: 42 }, mon1535), { index: 1, seconds: 42 }, "same day resumes");
assert.deepStrictEqual(S.startPosition(peppa, { date: yesterday, index: 2, seconds: 42 }, mon1535), { index: 0, seconds: 0 }, "repeat restarts each day");
var series = Object.assign({}, peppa, { playMode: "continue" });
assert.deepStrictEqual(S.startPosition(series, { date: yesterday, index: 1, seconds: 42 }, mon1535), { index: 1, seconds: 42 });
assert.deepStrictEqual(S.startPosition(series, { date: yesterday, index: 2, finished: true }, mon1535), { index: 0, seconds: 0 }, "continue wraps");

// Older saves: one schedule per channel, videos pasted straight into it.
var oldSave = { profiles: [{ id: "k", channels: [
  { id: "c1", name: "Old", days: [1], open: "15:30", close: "16:00", playMode: "continue",
    videos: [{ id: "M7lc1UVf-VE", title: "Test" }, { id: "M7lc1UVf-VE", title: "Test" }] }] }] };
var h = S.migrateHousehold(oldSave);
var slot = h.profiles[0].channels[0].slots[0];
assert.strictEqual(h.library.length, 1, "duplicate videos share one library show");
assert.strictEqual(h.library[0].type, "video");
assert.ok(/^[a-z0-9]+$/i.test(h.library[0].id), "library id is alphanumeric");
assert.deepStrictEqual(slot.items, [h.library[0].id, h.library[0].id]);
assert.strictEqual(slot.playMode, "continue");
assert.strictEqual(slot.videos, undefined);
assert.strictEqual(S.migrateHousehold(h).library.length, 1, "migrating twice changes nothing");

// Channel Guide: any day, statuses relative to now
var sat = new Date(2026, 9, 24, 12, 0);
var satRows = S.dayGuide(kid, sat, mon1550);
assert.deepStrictEqual(satRows.map(function (r) { return r.slot.id; }), ["bl"], "Saturday shows the weekend slot only");
assert.strictEqual(satRows[0].status, "later", "a future day is all 'later'");

// Parent overrides for today, set from the phone.
var offKid = { id: "k", name: "Maya", channels: [afternoon], today: { date: "2026-10-19", off: true } };
assert.strictEqual(S.activeSlot(offKid, afternoon, mon1535, {}), null, "off for today: nothing on");
assert.strictEqual(S.nextShowing(offKid, new Date(2026, 9, 19, 9, 0)).open.getDate(), 20, "off for today: next is tomorrow");
assert.strictEqual(S.activeSlot(offKid, afternoon, new Date(2026, 9, 20, 15, 35), {}), peppa, "off only for that day");

var moreKid = { id: "k", name: "Maya", channels: [afternoon], today: { date: "2026-10-19", more: { slot: "bm", until: "16:10" } } };
assert.strictEqual(S.activeSlot(moreKid, afternoon, new Date(2026, 9, 19, 16, 5), {}), blippiMon, "extra time keeps the slot on");
assert.strictEqual(S.activeSlot(moreKid, afternoon, new Date(2026, 9, 19, 16, 10), {}), null, "extra time ends");
assert.strictEqual(S.formatTime(S.slotClosesAt(blippiMon, new Date(2026, 9, 19, 15, 50), {}, moreKid)), "4:10 PM", "close moves with extra time");
assert.strictEqual(S.formatTime(S.slotClosesAt(blippiMon, new Date(2026, 9, 19, 15, 50), {})), "4:00 PM", "no profile: scheduled close");
assert.strictEqual(S.activeSlot(moreKid, afternoon, new Date(2026, 9, 20, 15, 50), {}), null, "yesterday's extra time is ignored");
assert.strictEqual(S.activeSlot(moreKid, afternoon, new Date(2026, 9, 19, 15, 0), {}), null, "extra time doesn't start a slot early");

// Household time zone: wall-clock time in the family's zone, across the
// daylight saving change (Los Angeles falls back on Sunday 2026-11-01; British
// Columbia now stays on daylight time, so Vancouver no longer makes a good test).
var before = S.wallNow("America/Los_Angeles", new Date(Date.UTC(2026, 9, 31, 16, 0)));
var after = S.wallNow("America/Los_Angeles", new Date(Date.UTC(2026, 10, 1, 16, 0)));
assert.strictEqual(before.getHours() + ":" + before.getDate(), "9:31", "PDT is UTC-7");
assert.strictEqual(after.getHours() + ":" + after.getDate(), "8:1", "PST is UTC-8 after the change");
assert.strictEqual(S.wallNow("Asia/Kolkata", new Date(Date.UTC(2026, 9, 19, 23, 0))).getHours(), 4, "other zones too");
assert.strictEqual(S.wallNow("", new Date(5)).getTime(), 5, "no zone: device clock");
assert.strictEqual(S.wallNow("Not/AZone", new Date(5)).getTime(), 5, "bad zone: device clock");

// Slots keep their wall-clock times on the change-over day.
var sunMorning = { id: "sm", days: [0], open: "09:00", close: "10:00", items: ["e"] };
var w = S.windowOn(sunMorning, new Date(2026, 10, 1, 12, 0));
assert.strictEqual(w.open.getHours() + "-" + w.close.getHours(), "9-10", "fall-back Sunday keeps 9 to 10");
w = S.windowOn(sunMorning, new Date(2026, 2, 8, 12, 0));
assert.strictEqual(w.open.getHours() + "-" + w.close.getHours(), "9-10", "spring-forward Sunday keeps 9 to 10");

console.log("schedule tests passed");
