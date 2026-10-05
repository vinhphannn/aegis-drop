CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  text_content TEXT,
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
    (type = 'text' AND text_content IS NOT NULL AND file_key IS NULL AND file_name IS NULL AND mime_type IS NULL)
    OR
    (type = 'file' AND text_content IS NULL AND file_key IS NOT NULL AND file_name IS NOT NULL AND mime_type IS NOT NULL)
  )
);
CREATE INDEX items_recent ON items(pending_delete, created_at DESC);
