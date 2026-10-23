-- How many people each parent has let past the waiting list with a family
-- invite (see src/access.js). Only ever counts up: deleting an account or
-- cancelling an invite doesn't hand the place back.
ALTER TABLE users ADD COLUMN invite_admissions INTEGER NOT NULL DEFAULT 0;
