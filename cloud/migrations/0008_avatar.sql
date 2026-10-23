-- A parent's picture in the app: their own photo (a small JPEG, shrunk on the
-- phone), or an emoji on a colour. JSON; null means initials.
ALTER TABLE users ADD COLUMN avatar TEXT;
