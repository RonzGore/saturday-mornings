-- Email codes are now tied to the browser that requested them (a cookie
-- nonce), so someone else's wrong guesses can't lock a parent out.
DROP TABLE email_codes;
CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,            -- SHA-256 of the browser's nonce cookie
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
CREATE INDEX email_codes_email ON email_codes(email);
