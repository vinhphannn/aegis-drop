# AEGIS Drop — Phase 4B.2

A small React + TypeScript clipboard with a Cloudflare Worker, D1 and private R2.
Text and files are encrypted/decrypted in the browser with an independently generated local
vault. The Worker/D1 receive opaque envelopes and R2 stores only encrypted file objects
on the active path. The current browser fallback is explicitly limited to 8 MiB. Pairing, recovery UI, realtime and Google auth
are not implemented. Keep this browser's local vault data to read its text again.

See [Phase 4B.2 file/image E2EE and smoke test](docs/phase4b2-file-e2ee.md).
## Install and local development

Use Node.js 22 or newer.

```sh
npm install
npm run build
npm run db:migrate:local
npm run dev:worker -- --local-protocol https
```

Before starting, configure local authentication as described in
[Phase 3 authentication](docs/phase3-auth.md). Open `https://localhost:8787` for the built frontend and Worker on the same origin.
Wrangler uses **local** D1/R2 in `.wrangler/state`; this does not create cloud
resources or require real account IDs. Restarting preserves that local data.
`wrangler.jsonc` contains a placeholder D1 UUID suitable for local development.

For frontend hot reload on `http://localhost:5173`, stop the HTTPS Worker first.
Run the HTTP Worker and Vite in two terminals:

```sh
# Terminal 1 (backend, local D1/R2)
npm run dev:worker -- --local-protocol http --ip 127.0.0.1 --port 8787
# Terminal 2 (frontend)
npm run dev -- --host localhost --port 5173 --strictPort
```

Open `http://localhost:5173`. Vite proxies `/api` to the **HTTP** Worker at
`127.0.0.1:8787`, translating only same-origin Origin headers to the backend origin.
Do not run an HTTPS Worker behind this HTTP proxy. Secure-cookie behavior on
HTTP localhost depends on browser support; the HTTPS Worker is the reference
local authentication flow. Do not use Vite alone: it requires the Worker and migration.
`npm run preview` previews the frontend build only; use Wrangler to preview the
complete app. Rebuild the frontend before testing it directly on port 8787.

On startup the app checks the session. Enter your access key once to unlock this
device. **Sign out** clears its session cookie and displayed history, retaining enrollment.
Create/unlock the local vault to use the app; **Lock vault** clears active plaintext
without signing out. Reload requires local vault unlock again.

Type/paste text, click **Send text** or Ctrl/Cmd + Enter, paste an image into the
text box, drop files on the composer, or use **Add files**. Enter adds a newline.
Copy text, download files, and delete items from the list. Verified PNG/JPEG images within preview byte/pixel bounds show local previews. Copy requires localhost or HTTPS. The server list loads on startup
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
Only `/api/*` is routed through the Worker first. Every authenticated device shares
this one list. Configure the two authentication secrets and login rate limiting
before deployment; see [Phase 3 authentication](docs/phase3-auth.md). These commands change real account resources; they are documented
for the owner to execute and have not been run remotely here.

## Files and API

- `src/model.ts`: shared discriminated TextItem/FileItem model and limits.
- `src/api/dropApi.ts`: frontend HTTP transport, including binary uploads.
- `src/store.ts`: server-list cache, loading/busy/error state, mutation + refresh.
- `worker/index.ts`: routing, validation, streaming upload and attachment download.
- `worker/storage.ts`: D1 keyset pagination, insertion, explicit-delete cleanup retries.
- `worker/auth.ts`: access-key verification, signed cookies, origin checks.
- `src/auth.ts` / `src/AuthGate.tsx`: session state and minimal unlock screen.
- `migrations/0001_items.sql`: the single items table.
- `migrations/0002_history_index.sql`: indexed timestamp/ID history ordering.
- `wrangler.jsonc`: Worker, static assets, D1/R2 binding configuration.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /api/auth/login` | JSON `{ "accessKey": "..." }` | sets session cookie |
| `GET /api/auth/session` | session cookie | `{ "authenticated": true or false }` |
| `POST /api/auth/logout` | session cookie | clears cookie |
| `GET /api/items?limit=5&cursor=...` | optional limit/cursor | `{ "items": [...], "nextCursor": "..." or null }` |
| `POST /api/items/text` | JSON `{ "id": "<client UUIDv4>", "envelope": "<canonical base64url>" }` | 201 `{ "ok": true }` |
| `POST /api/items/file` | opaque envelope prefix + encrypted object + headers below | 201 `{ "ok": true }` |
| `GET /api/items/:id/file` | none | streamed attachment |
| `DELETE /api/items/:id` | none | `{ "ok": true }` |

All item/list/upload/download/delete routes require a valid cookie; otherwise
they return 401 before accessing D1 or R2. Authentication responses are no-store.
Non-GET mutations reject foreign Origin and cross-site/same-site Fetch Metadata.
No cross-origin API access or CORS preflight support is configured.

Errors return `{ "error": "..." }` with a 4xx/5xx status. Missing items return
404; invalid IDs/payloads return 400; unsupported text content types return 415;
size limits return 413. API responses are not cached. There is no CORS policy for
other origins: the frontend uses the same origin or Vite's development proxy.

Encrypted file upload headers:

- `X-Item-Id`: canonical client UUIDv4, bound by the encrypted envelope.
- `X-Ciphertext-Size`: exact AGF1 object byte count, excluding the envelope prefix.
- `Content-Type`: always `application/octet-stream`.

Body is u32be(envelope byte length), binary AGD1 file envelope, then the frozen
AGF1 object. No plaintext filename/MIME/byte count is sent. R2 keys remain fresh
server-generated UUIDs. FixedLengthStream validates/streams the encrypted object.
The backend allows 104,859,692 ciphertext bytes (100 MiB plaintext plus frozen
framing); current browser upload/download fallback is **8 MiB plaintext maximum**.
It is bounded RAM, not an OPFS or large-file streaming claim. Zero-byte files work.

Downloads return generic ciphertext attachments named by item ID with nosniff,
sandbox CSP and no-store. The browser authenticates manifest, every chunk and EOF
before exposing the original file. HTML/SVG remain downloads, never previews.
PNG/JPEG preview requires <=2 MiB, <=4 million pixels and <=8192 per dimension;
at most four cached previews, <=8 MiB total encoded bytes. Lock/delete/refresh
release local URLs; nothing is persisted as an item cache in browser storage.

## Schema, history, and failure ordering

The active **items** table contains `id`, `type`, `envelope`, `file_key`,
`ciphertext_size`, `created_at` and `pending_delete`. No plaintext filename, MIME,
text or plaintext byte-count column remains. Ciphertext length still reveals nearly
exact file size under the frozen unpadded framing. Server ordering/cursors remain
`created_at DESC, id DESC`.

Migration 0003 discards pre-E2EE text. Migration 0004 preserves encrypted text,
removes plaintext file metadata, and hides/queues old file keys for normal R2 cleanup.
Legacy files are not converted or exposed through a plaintext compatibility path.
Apply migrations locally before starting this version. Historical migration schemas
are not the active storage model. Old SQLite pages/backups/orphan objects are not
claimed securely erased by this schema change.

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

Phase 3 configuration, security assumptions, session limitations, and deployment
requirements are documented in [phase3-auth.md](docs/phase3-auth.md).
