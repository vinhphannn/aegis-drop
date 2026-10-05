-- Match keyset pagination's deterministic (timestamp, public ID) ordering.
DROP INDEX items_recent;
CREATE INDEX items_recent ON items(pending_delete, created_at DESC, id DESC);
