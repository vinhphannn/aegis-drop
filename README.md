# AEGIS Drop — Phase 2

A small React + TypeScript clipboard with a Cloudflare Worker API, D1 metadata,
and private R2 file storage. One shared persistent history; no accounts, authentication,
encryption, realtime, PWA, or pairing yet. Text and files are currently plaintext.
Anyone able to access a deployed API can read, upload, and delete items. Keep
Phase 2 local until you deliberately choose to expose it; don't use it for secrets.

## Install and local development

Use Node.js 22 or newer.

```sh
npm install
npm run build
npm run db:migrate:local
npm run dev:worker
```

Open `http://localhost:8787` for the built frontend and Worker on the same origin.
Wrangler uses **local** D1/R2 in `.wrangler/state`; this does not create cloud
resources or require real account IDs. Restarting preserves that local data.
`wrangler.jsonc` contains a placeholder D1 UUID suitable for local development.

For frontend hot reload, leave the Worker running and use a second terminal:

```sh
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). Vite proxies `/api` to
`127.0.0.1:8787`. Do not use Vite alone: it requires the Worker and migration.
`npm run preview` previews the frontend build only; use Wrangler to preview the
complete app. Rebuild the frontend before testing it directly on port 8787.

Type/paste text, click **Send text** or Ctrl/Cmd + Enter, paste an image into the
text box, drop files on the composer, or use **Add files**. Enter adds a newline.
Copy text, download files, and delete items from the list. Supported raster images
show previews. Copy requires localhost or HTTPS. The server list loads on startup
and after mutations (newest five); **Refresh** restarts at the newest page and
fetches changes made by another device. **Load older** appends five more items,
without duplicates, until the end of history. Failed pages preserve loaded items
and can be retried. History is never fetched automatically in full.
Multiple selected files upload sequentially. Equal timestamps are ordered by ID.
There is no polling or automatic cross-device notification.

## Cloudflare setup and deployment (owner-run commands)

No real Cloudflare resources have been created by this implementation. When you
choose to deploy, sign into your own account and run:

```sh
npx wrangler login
npx wrangler d1 create aegis-drop
npx wrangler r2 bucket create aegis-drop-files
```

Update `wrangler.jsonc` using the returned D1 `database_id` and your bucket name.
Keep the bindings **DB**, **FILES**, and **ASSETS** unchanged. An account ID is not
needed in the checked-in example; select your account through Wrangler. Do not
commit tokens or credentials. Keep R2 private; no public bucket URL is needed.
The Worker serves files through its binding, not the R2 public hosting feature.

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

`npm run deploy` builds the frontend and deploys the Worker with static assets.
Only `/api/*` is routed through the Worker first. Every deployed visitor shares
this one list. These commands change real account resources; they are documented
for the owner to execute and have not been run remotely here.

## Files and API

- `src/model.ts`: shared discriminated TextItem/FileItem model and limits.
- `src/api/dropApi.ts`: frontend HTTP transport, including binary uploads.
- `src/store.ts`: server-list cache, loading/busy/error state, mutation + refresh.
- `worker/index.ts`: routing, validation, streaming upload and attachment download.
- `worker/storage.ts`: D1 keyset pagination, insertion, explicit-delete cleanup retries.
- `migrations/0001_items.sql`: the single items table.
- `migrations/0002_history_index.sql`: indexed timestamp/ID history ordering.
- `wrangler.jsonc`: Worker, static assets, D1/R2 binding configuration.

| Endpoint | Request | Success |
| --- | --- | --- |
| `GET /api/items?limit=5&cursor=...` | optional limit/cursor | `{ "items": [...], "nextCursor": "..." or null }` |
| `POST /api/items/text` | JSON `{ "text": "..." }` | 201 `{ "ok": true }` |
| `POST /api/items/file` | raw binary body + headers below | 201 `{ "ok": true }` |
| `GET /api/items/:id/file` | none | streamed attachment |
| `DELETE /api/items/:id` | none | `{ "ok": true }` |

Errors return `{ "error": "..." }` with a 4xx/5xx status. Missing items return
404; invalid IDs/payloads return 400; unsupported text content types return 415;
size limits return 413. API responses are not cached. There is no CORS policy for
other origins: the frontend uses the same origin or Vite's development proxy.

File upload headers:

- `X-File-Name`: `encodeURIComponent(originalFilename)` (maximum 1024 characters).
- `X-File-Size`: exact nonnegative byte count.
- `Content-Type`: original MIME type, or `application/octet-stream`.

The backend limit is **100 MiB (104,857,600 bytes)** per file. `Content-Length`,
when supplied, must agree with the declared size. Workers' `FixedLengthStream`
also verifies actual bytes, including requests without Content-Length, and streams
to R2 without buffering the entire file or base64 conversion. Zero-byte files
are accepted. Text is limited to 64 KiB UTF-8; JSON request bodies are bounded too.
The storage layer does not inspect binary contents and can later hold opaque
ciphertext. Phase 4 will need to evolve client serialization and metadata.

R2 keys are generated UUIDs (`items/<uuid>`), never user filenames. Downloads
preserve the original MIME and filename (including UTF-8 names) and always use
`Content-Disposition: attachment`, `nosniff`, and sandbox CSP. HTML/SVG are not
previewed by the UI. Raster image previews use the same download endpoint.

## Schema, history, and failure ordering

The **items** table contains `id`, `type` (`text` or `file`), `text_content`,
`file_key`, `file_name`, `mime_type`, `size`, `created_at`, and `pending_delete`.
Checks enforce type-specific fields and nonnegative sizes. `created_at` comes
from D1's clock. Ordering is `created_at DESC, id DESC`, including timestamp ties.
Migration 0002 updates the index without changing existing rows or migration 0001.

Text and files persist until explicitly deleted. Insertion performs one INSERT;
there is no automatic retention, eviction, storage quota, or content indexing.
GET defaults to five items, accepts integer limits 1–50, and uses an indexed keyset
predicate rather than OFFSET. One extra row determines whether another page exists.
The opaque versioned base64url cursor carries the last timestamp and public item ID,
not SQL, rowid, or an offset. It is validated, but is not a secret or authorization
credential. Pass it unchanged; a deleted boundary item does not invalidate it.
New items above the boundary appear on Refresh rather than repeat in older pages.
Pagination is a live traversal, not a snapshot: concurrent explicit deletes may
remove items, and clock rollback/backdated inserts can appear below a boundary.

Explicit delete atomically marks a row `pending_delete`, immediately hiding it
from list/download APIs. Cleanup processes up to ten pending rows per request,
removes R2 objects first, then physically deletes their D1 records. The tombstone
retains the object key until deletion succeeds; it remains useful without retention.
Existing pending deletions from earlier versions finish cleanup; previously evicted
items cannot be restored by this change.

File `size` metadata remains in D1, allowing a future logical-byte aggregate.
No `/api/storage` endpoint or bucket-wide scan was added. A whole-history SUM is
not needed for this change and would not measure billing-exact GB-month usage.

Failed R2 or metadata deletion is logged; pending rows remain hidden and retry
on later list/create/delete requests. No background service is required. If the
app receives no further requests, pending cleanup waits. Concurrent mutations are
independent inserts; pagination has deterministic ties. API consumers
can still race an explicit deletion while downloading and receive 404.

File bytes are written to R2 before inserting metadata. A failed D1 insertion
preserves prior items. Compensation deletes the new object only after confirming
that no D1 row owns its key; an uncertain acknowledgement or ownership read
preserves the bytes rather than risking deletion of a committed file. This
is not a distributed transaction: process termination between R2 and D1, or a
failed ownership read or rollback deletion, can leave an unreferenced object requiring
manual cleanup. Confirmed mutation success clears the submitted draft even when
its subsequent refresh fails; the UI reports that refresh problem separately.
No automatic retry of uploads is performed. After a mutation
fails, the frontend attempts to reconcile the list; an uncertain network failure
may still have committed server-side, so refresh before retrying.

## Verification

```sh
npm run build
npm run typecheck:worker
npm test
npx wrangler deploy --dry-run --outdir /tmp/aegis-drop-worker-dry-run
```

Tests use Node's built-in runner and Miniflare/workerd with real local D1 SQLite
and R2 bindings. They cover persistent mixed history, concurrent timestamp ties, paginated
traversal, deleted boundaries/new arrivals, limits/cursors, binary roundtrip,
attachment headers, zero-byte files, 100 MiB streaming, size mismatches, validation,
explicit deletion, insertion failures, lost acknowledgements, and deferred cleanup. Failure tests
inject D1 triggers or an R2 delete error while executing the real storage logic.
The remote-store test runs the real API abstraction against a controlled HTTP
transport to check authoritative refresh, manual pagination, deduplication, retries,
and request/error behavior.

Integration tests need permission to bind loopback sockets. Local tests and dry
runs do not verify a production deployment. Browser clipboard, image rendering,
file dialogs/downloads and visual desktop/mobile layout still need browser QA.

The [Phase 2 audit](docs/phase2-audit.md) records reproduced failures, fixes,
test coverage, and unresolved architectural limitations. Local 100 MiB acceptance
is not proof of account/edge acceptance or Free-plan CPU/heap compliance; see
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
