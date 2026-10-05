-- Pre-deployment reset: old plaintext text rows are intentionally discarded.
-- Preserve existing file metadata, no file encryption/compatibility changes.
CREATE TABLE items_encrypted (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  text_envelope TEXT,
  file_key TEXT UNIQUE,
  file_name TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 +
    CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ),
  pending_delete INTEGER NOT NULL DEFAULT 0 CHECK (pending_delete IN (0, 1)),
  CHECK (
    (type = 'text' AND text_envelope IS NOT NULL AND length(text_envelope) BETWEEN 216 AND 87598
      AND file_key IS NULL AND file_name IS NULL AND mime_type IS NULL)
    OR
    (type = 'file' AND text_envelope IS NULL AND file_key IS NOT NULL AND file_name IS NOT NULL AND mime_type IS NOT NULL)
  )
);
INSERT INTO items_encrypted (id, type, file_key, file_name, mime_type, size, created_at, pending_delete)
  SELECT id, type, file_key, file_name, mime_type, size, created_at, pending_delete FROM items WHERE type = 'file';
DROP TABLE items;
ALTER TABLE items_encrypted RENAME TO items;
CREATE INDEX items_recent ON items(pending_delete, created_at DESC, id DESC);
