-- Early access: only approved emails can sign in. Everyone else, and every
-- coupon or TV-petition sign-up on saturdaymornings.tv, joins one waiting list
-- here, and is let in in batches.

-- Emails allowed to sign in. source: existing | manual | batch
CREATE TABLE access (
  email TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- The waiting list: one row per email, from the website (coupon, petition) or
-- from trying to sign in to the app.
CREATE TABLE waitlist (
  email TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- site | app
  tvs TEXT NOT NULL DEFAULT '[]',    -- JSON array of TVs they want (website)
  country TEXT,                      -- Cloudflare's 2-letter country, if known
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  thanked_at INTEGER,                -- "you're on the list" email sent
  released_at INTEGER,               -- let in (added to access)
  batch TEXT                         -- which release let them in
);
CREATE INDEX waitlist_waiting ON waitlist(released_at, created_at);
CREATE INDEX waitlist_thank ON waitlist(thanked_at);

-- A free first month for every new account (null: no trial, e.g. founders).
ALTER TABLE users ADD COLUMN trial_ends_at INTEGER;

-- Everyone who already has an account keeps it.
INSERT INTO access (email, source, added_at) SELECT email, 'existing', created_at FROM users;
