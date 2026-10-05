# Phase 4B.2: operational file/image E2EE

The frozen file manifest/chunk protocol is unchanged. File helpers now accept the
existing non-extractable vault HKDF key. Raw M is never returned to UI/transport.
Filename, MIME and plaintext count are authenticated encrypted manifest fields.

## Active path

Selected/pasted/dropped File -> sequential 1 MiB File slices -> fresh single-use
file encryption operation -> frozen ciphertext Blob -> POST. The deliberately
bounded first-operational fallback permits at most **8 MiB plaintext per file**;
it collects ciphertext only within that hard cap. Uploads are serialized. No
request-body stream/OPFS support is assumed and no automatic upload retry occurs.
A failed operation must resend its frozen Blob or create a fresh item/key; never
reuse an encryption handle with changed input.

Upload body: u32be envelope length + binary AGD1 envelope + frozen AGF1 object.
Headers carry only X-Item-Id, X-Ciphertext-Size and application/octet-stream.
The Worker bounds/parses the prefix, checks envelope ID/kind/version and AGF1
header/hash binding, then streams the object through byte counting/FixedLengthStream
to a fresh server-generated R2 key. D1 is inserted after R2 succeeds. Lost-ack/
uncertain-ownership compensation and pending-delete cleanup rules are preserved.
An early R2 failure explicitly cancels the unused readable stream and request
reader as well as the producer, avoiding a blocked prefix write.

Active D1: id, type, envelope, file_key, ciphertext_size, created_at, pending_delete.
No filename, MIME, plaintext count or text body column exists. Public ciphertext
length still reveals nearly exact plaintext length under the unpadded frozen
format. R2 contains the AGF1 ciphertext object without plaintext HTTP metadata.
Download HTTP headers are generic binary/opaque ID attachment, nosniff, sandbox CSP,
no-store. The server validates public framing, not secret AEAD/content authenticity.

Client list opens each manifest separately. A damaged/wrong-vault/unsupported
manifest gets a failure card with Delete available. Download fetches ciphertext
with an AbortSignal, checks expected ciphertext length, splits transport blocks
to bounded crypto-source views and decrypts sequentially. Only successful completion
of all tags, records and exact EOF creates a plaintext Blob. No partial output
is exposed. Failure/cancellation clears accumulated scratch and releases readers;
lock invalidates root capabilities and clears the active item/URL cache.
Concurrent downloads reserve at most 8 MiB plaintext in total and at most four
operations. Download save URLs use application/octet-stream even for HTML/SVG;
the original authenticated filename is used only locally for saving.

PNG/JPEG local preview follows full decryption, <=2 MiB encoded bytes, <=4 million
declared pixels and <=8192 per dimension. APNG is excluded. At most four previews
and 8 MiB encoded preview bytes are cached. Other raster formats remain download
cards; HTML/SVG never preview. Preview URLs are released on delete/disposal/lock;
the last save URL is retained until another save or lock, avoiding immediate
revocation after click. Browser-native download completion/physical memory wiping
cannot be guaranteed by JavaScript. No persistent browser item cache is added.

## Limits and verification

Backend retains the 100 MiB plaintext-equivalent ceiling: 104,859,692 object bytes,
plus envelope transport overhead. A real local streamed encryption/upload/decryption
test checks that ceiling without collecting the whole file. This is not a production
account-edge or browser-100-MiB claim. Browser disk-backed large-file paths remain
gated; no unbounded buffering fallback exists. Native browser network/Blob/decode
RSS is not measured in this environment. Real browser file dialogs/rendering/save
behavior require the manual test below.

Migration 0004 preserves encrypted text, retires old plaintext file rows from the
active list and queues their opaque R2 keys for normal ownership-safe cleanup.
Old metadata columns are removed. Legacy bytes finish deletion on later requests;
unowned pre-existing R2 orphans and historical SQLite pages/backups are not claimed
securely erased. No plaintext compatibility path is retained.

Tests exercise actual app crypto/API -> real workerd D1/R2 -> client verification,
small/empty/chunk boundary/multiple-chunk files, Unicode filename, PNG/binary,
metadata/content leak checks, wrong vault, manifest/object corruption, reorder,
duplicate/missing/trailing/truncated chunks, cancellation, single-use failures,
bounded fallbacks, object URL cleanup, delete, rollback/lost ACK and text E2EE.

## Local commands

Use your existing ignored `.dev.vars` and local access key. No cloud resources or
separate D1/R2 daemon are required. The frontend and HTTP backend are already
running for this task. For a fresh start:

```sh
npm install
npm run build
npm run db:migrate:local
# Terminal 1
npm run dev:worker -- --local-protocol http --ip 127.0.0.1 --port 8787
# Terminal 2
npm run dev -- --host localhost --port 5173 --strictPort
```

Open **http://localhost:5173**, retaining the same browser/origin enrollment.
An alternative built-app HTTPS run is `npm run dev:worker -- --local-protocol https`
and https://localhost:8787, but that origin has separate enrollment. Do not run
an HTTPS Worker behind Vite's HTTP proxy.

## Six-step manual smoke test

1. Open http://localhost:5173, log in and unlock your existing local vault.
2. Drag/drop a PNG or JPEG below 2 MiB/4 million pixels (other files up to 8 MiB).
3. Reload and unlock the same vault; confirm the name/local preview returns.
4. Click Download and wait for verification/save.
5. Check the original filename and compare/open the saved content.
6. Delete the item, then refresh to confirm it is gone.

Before recovery/QR integration: trusted descriptor/server-vault coordination,
actual-browser capability testing, encrypted enrollment/recovery/pairing UI wiring
and the frozen pairing physical-comparison ceremony still need their scoped phases.
They are not implemented here. No commit, push or remote deployment was performed.

Final validation: build, Worker typecheck and all 122 tests passed; tracked and
untracked whitespace checks passed. Migration 0004 was applied locally. A live
http://localhost:5173 -> Worker -> local D1/R2 app-code test passed login, encrypted
image upload, local preview URL, verified original bytes, opaque wire metadata and
delete. Both local servers remain running. Browser rendering/save UI is not claimed
verified by that Node/API test.
