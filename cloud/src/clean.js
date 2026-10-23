// Rebuilds a household from known fields only, so nothing unexpected is ever
// stored or shown on a phone or TV. Same rules as the Mac server, except that
// shows keep only their YouTube IDs.
import Schedule from "../../shared/schedule.js";

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const idOk = (v) => typeof v === "string" && /^[a-z0-9]{1,20}$/i.test(v);
const hmOk = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const MAX_LIBRARY = 1000;

export const emptyHousehold = () => ({ library: [], profiles: [] });

// Only IDs are stored. Titles, channel names and thumbnails are YouTube data
// with a 30-day limit, so they live in yt_meta and are attached on read
// (see youtube.js withMeta).
function cleanShow(it) {
  return { id: it.id, type: it.type, ytId: it.ytId };
}

function cleanSlot(t, known) {
  return {
    id: t.id,
    name: str(t.name, 60),
    days: (Array.isArray(t.days) ? t.days : []).filter((d, i, a) => d === (d | 0) && d >= 0 && d <= 6 && a.indexOf(d) === i),
    open: t.open,
    close: t.close,
    playMode: t.playMode === "continue" ? "continue" : "repeat",
    items: (Array.isArray(t.items) ? t.items : []).filter((id) => known[id]).slice(0, 500),
  };
}

// The family's time zone, an IANA name like "America/Vancouver".
function zoneOk(tz) {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 50) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// A parent's override for today (see Schedule.todayOf): off for the day, or
// extra time on one slot.
function cleanToday(t) {
  if (!t || typeof t.date !== "string" || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(t.date)) return {};
  if (t.off === true) return { today: { date: t.date, off: true } };
  if (t.more && idOk(t.more.slot) && hmOk(t.more.until)) return { today: { date: t.date, more: { slot: t.more.slot, until: t.more.until } } };
  return {};
}

export function cleanHousehold(h) {
  if (!h || !Array.isArray(h.profiles)) throw new Error("bad shape");
  Schedule.migrateHousehold(h);
  const known = {};
  const library = h.library
    .filter((it) => {
      const ok = it && idOk(it.id) && !known[it.id] && /^(video|channel|playlist)$/.test(it.type) &&
        typeof it.ytId === "string" && /^[\w-]{11,64}$/.test(it.ytId);
      if (ok) known[it.id] = true;
      return ok;
    })
    .slice(0, MAX_LIBRARY)
    .map(cleanShow);
  return {
    ...(zoneOk(h.timeZone) ? { timeZone: h.timeZone } : {}),
    library,
    profiles: h.profiles.slice(0, 20).filter((p) => p && idOk(p.id)).map((p) => ({
      id: p.id,
      name: str(p.name, 40),
      emoji: str(p.emoji, 8),
      color: /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "#3554ff",
      allowSkip: p.allowSkip === true,
      ...cleanToday(p.today),
      channels: p.channels.slice(0, 20).filter((c) => c && idOk(c.id)).map((c) => ({
        id: c.id,
        name: str(c.name, 60) || "Shows",
        slots: (Array.isArray(c.slots) ? c.slots : []).slice(0, 100)
          .filter((t) => t && idOk(t.id) && hmOk(t.open) && hmOk(t.close))
          .map((t) => cleanSlot(t, known)),
      })),
    })),
  };
}
