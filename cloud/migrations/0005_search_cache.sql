-- YouTube search results (search.list costs 100 of the 10,000 daily quota
-- units), cached per normalized query + type + region for 6 hours. The daily
-- cron deletes expired rows, so no result is kept anywhere near YouTube's
-- 30-day limit.
CREATE TABLE search_cache (
  key TEXT PRIMARY KEY,            -- "<type>:<region>:<query>", e.g. "video:CA:peppa pig"
  data TEXT NOT NULL,              -- JSON [{ type, ytId, title, by, thumb, link }]
  created_at INTEGER NOT NULL
);
CREATE INDEX search_cache_created ON search_cache(created_at);
