-- Which parent linked each TV, so a TV linked by a parent who leaves or is
-- removed from the family is unlinked with them (it may be in their home).
-- TVs linked before this change have no record and are left alone.
ALTER TABLE tvs ADD COLUMN linked_by TEXT;
