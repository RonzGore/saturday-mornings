-- Saturday Morning: parents, their sign-in methods, their household, and TVs.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Passkeys (WebAuthn credentials). id is the credential id (base64url).
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,           -- base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                    -- JSON array
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- One pending sign-in code per email; only a hash is stored.
CREATE TABLE email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

-- WebAuthn challenges, single use, short-lived.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

-- Sessions: id is the SHA-256 of the cookie token.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A family's kids, channels, slots and show library, as one JSON document.
CREATE TABLE households (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Paired TVs. token_hash is the SHA-256 of the TV's secret token.
CREATE TABLE tvs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX tvs_household ON tvs(household_id);

-- Pairing codes shown on an unlinked TV.
CREATE TABLE pairings (
  code TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  tv_id TEXT,
  token TEXT,                         -- handed to the TV once, then cleared
  expires_at INTEGER NOT NULL
);

-- Cache of resolved YouTube links (titles, thumbnails).
CREATE TABLE resolve_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
