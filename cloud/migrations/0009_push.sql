-- Notifications (Web Push). One row per browser a parent allowed; a parent can
-- have several (phone, laptop).
CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE INDEX push_subs_user ON push_subs(user_id);

-- Which alerts each parent wants: JSON { soon, signoff, offline, changed }.
-- Null means all on.
ALTER TABLE users ADD COLUMN notify TEXT;

-- Alerts already sent, so each goes out once (keys like "signoff:hh:slot:date:close").
CREATE TABLE notify_log (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);
