-- YouTube's Developer Policies (III.E.4) allow keeping titles, channel names
-- and thumbnails for at most 30 days before they're refreshed or deleted. So
-- households now store only YouTube IDs, and the metadata lives here, one row
-- per show, with the time it was fetched. A daily cron refreshes rows in use
-- and deletes anything older than 30 days.
CREATE TABLE yt_meta (
  key TEXT PRIMARY KEY,            -- "<type>:<ytId>", e.g. "video:dQw4w9WgXcQ"
  title TEXT,                      -- NULL: YouTube says it's gone or private
  by_name TEXT,
  thumb TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX yt_meta_fetched ON yt_meta(fetched_at);

-- Link lookups now cache only the link -> IDs mapping (no titles).
DELETE FROM resolve_cache;
