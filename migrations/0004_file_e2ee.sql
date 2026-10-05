-- Retire plaintext file metadata. Queue old R2 keys for normal ownership-safe cleanup.
CREATE TABLE items_opaque (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  envelope TEXT,
  file_key TEXT UNIQUE,
  ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size >= 0),
  created_at INTEGER NOT NULL DEFAULT (
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 +
    CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  ),
  pending_delete INTEGER NOT NULL DEFAULT 0 CHECK (pending_delete IN (0, 1)),
  CHECK (
    (type = 'text' AND envelope IS NOT NULL AND length(envelope) BETWEEN 216 AND 87598 AND file_key IS NULL)
    OR
    (type = 'file' AND file_key IS NOT NULL AND (
      (envelope IS NOT NULL AND length(envelope) BETWEEN 243 AND 6039 AND ciphertext_size BETWEEN 92 AND 104859692)
      OR (pending_delete = 1 AND envelope IS NULL AND ciphertext_size = 0)
    ))
  )
);
INSERT INTO items_opaque (id, type, envelope, file_key, ciphertext_size, created_at, pending_delete)
  SELECT id, type, text_envelope, file_key, CASE WHEN type = 'text' THEN size ELSE 0 END,
    created_at, CASE WHEN type = 'file' THEN 1 ELSE pending_delete END FROM items;
DROP TABLE items;
ALTER TABLE items_opaque RENAME TO items;
CREATE INDEX items_recent ON items(pending_delete, created_at DESC, id DESC);
