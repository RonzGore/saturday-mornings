-- Fixed-window counters for rate limiting (sign-in codes, passkeys, TV linking).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
