-- More than one parent per family. Each parent belongs to exactly one
-- household; households.owner_id stays as the owner (the parent who set it
-- up, or whoever it passed to when the owner deleted their account).
CREATE TABLE household_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- 'owner' or 'parent'
  created_at INTEGER NOT NULL
);
CREATE INDEX household_members_household ON household_members(household_id);

INSERT INTO household_members (user_id, household_id, role, created_at)
  SELECT owner_id, id, 'owner', updated_at FROM households;

-- A parent invites another adult by email. The invite is used when that
-- email signs in (new account), or accepted from Account (existing one).
CREATE TABLE household_invites (
  email TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL,           -- users.id
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (email, household_id)
);
