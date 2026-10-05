# Browser file-I/O capability spike

Evidence checked 2026-10-05. This is a conditional transport recommendation,
not a supported-browser certification. No production code or crypto format changed.

## Upload recommendation

**A is preferred where verified:** read `file.slice(offset, offset + 1 MiB)` and
call `arrayBuffer()` on that slice only; feed the existing single-use encryptor.
Adapt its iterator to a pull-driven `ReadableStream<Uint8Array>` with at most one
queued record, then `fetch` with `duplex: 'half'`. Await every pull/encryption;
do not use an eager `start()` loop, `tee()`, whole-file `arrayBuffer()`, base64,
or an array of records. Application working memory is O(chunk size), with several
temporary chunk-sized copies in the existing core/Web Crypto; total browser RSS
is **not measured or guaranteed** by this reasoning.

Chromium requires HTTP/2 or HTTP/3 for streamed uploads, does not expose the
response until sending finishes, and restricts redirects. Use the final same-origin
URL, reject redirects, and do not use `keepalive`. A Request-constructor probe is
only a preliminary gate: verify that the actual endpoint receives a first block
before closing the producer, using a separate status request. Proxies/CDNs can
buffer even when the browser supports A. These constraints are documented by
[Chrome](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests).
No deployed endpoint was tested here.

**B is the fallback where A is unavailable or identical ciphertext retries matter:**
sequentially write the bounded encrypted records to a unique OPFS temporary file,
await each write, close/flush the writer, obtain `handle.getFile()`, then pass the
File itself to fetch. Do not pass `file.stream()` on browsers without A. A File
body does not need the stream-body `duplex` workaround. This avoids an explicit
whole-file JS buffer, but does not prove the browser streams its internal File
representation with bounded memory. Keep the immutable encrypted stage until the
operation finishes; retries read those same bytes. Direct-upload failures burn the
encryption handle: restart with a fresh item/key, never re-encrypt with the old handle.

OPFS is not universally usable just because `getDirectory` exists. Probe actual
create/write/close/read/delete operations and quota. Prefer `createWritable` where
available; older Safari can use `createSyncAccessHandle` in a dedicated worker,
with one bounded transferable block per acknowledged write, handling short writes,
flush and close. That worker fallback is a recommendation, **not implemented or
tested**. No new protocol or server chunk API is needed.

## Download recommendation

**C:** check HTTP status and authenticated envelope/context, consume
`response.body` through `getReader()` (do not assume stream async iteration), and
incrementally decrypt into a unique OPFS plaintext stage. Adapt transport blocks
into views no larger than `1 MiB + 128` before passing them to the current core;
network block sizes are not a crypto framing contract. A received oversized block
can still occupy browser memory before splitting: this needs measurement.

Await writes for backpressure. The existing decryptor authenticates each chunk,
but only successful iterator completion checks all expected chunks and exact EOF.
Close the output and permit export **only after completion**. Never collect a
whole response into `blob()`/`arrayBuffer()` or construct a Blob from all chunks.
After verification, use the stage's backing File for object-URL download where
tested, or copy it incrementally to a user-selected writable file on supporting
Chromium desktop. Obtain picker permission during a user gesture. OPFS itself
does not supply a user-visible save dialog. Avoid direct decryption into a visible
destination: interruption can leave a partial file presented to the user.

On Firefox/Safari/iPhone the File/object-URL download or File share export needs
real-device validation, including completion and memory behavior. Clicking an
anchor is not proof the browser finished reading its File: retain the stage until
an explicit safe release/retry lifecycle, then revoke URLs and delete it. Do not
immediately delete/revoke after the click or claim a timeout proves completion.
Plaintext staging is local exposure; JS cannot guarantee physical disk erasure.

## Documented compatibility (none locally browser-tested)

| Capability | Chromium desktop | Firefox desktop | Safari / iPhone |
| --- | --- | --- | --- |
| A: fetch ReadableStream request | Chrome 105+, with half duplex and HTTP/2+ constraints | Stable support not established; Mozilla tracker remains open | Not established; Request stream acceptance alone is insufficient |
| OPFS root / backing File | Chrome 86+ | Firefox 111+ | OPFS from Safari/iOS 15.2; WebKit documents getFile from macOS 12.4/iOS 15.4 |
| OPFS async createWritable | Chrome 86+ | Firefox 111+ | Safari/iOS 26+; earlier releases require another sink |
| OPFS sync access handle | Dedicated worker; Chrome 102+ | Dedicated worker; Firefox 111+ | Dedicated worker; Safari/iOS 15.2+; runtime probe required |
| User-selected showSaveFilePicker | Chrome 86+ | Not documented supported | Not documented supported |
| Response stream consumption | Documented modern-browser capability | Documented modern-browser capability | Documented modern-browser capability; prefer getReader |
| B upload / C export at 100 MiB with bounded RSS | Unverified | Unverified | Unverified |

Sources: [Request compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/Request.json),
[Mozilla streaming-upload tracker](https://bugzilla.mozilla.org/show_bug.cgi?id=1387483),
[OPFS root data](https://github.com/mdn/browser-compat-data/blob/main/api/StorageManager.json),
[file handle data](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json),
[save picker data](https://github.com/mdn/browser-compat-data/blob/main/api/Window.json),
[WebKit OPFS](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/),
[Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes),
[response streams](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream).
The compatibility data distinguishes individual APIs; it does not certify these
combined pipelines. Firefox preview work is not a stable-support claim.

## Failure handling, fallback and remaining gates

Use one AbortController for transport and bounded loops. Check its signal between
reads/writes; call iterator.return(), cancel/release readers, abort async writers
or close sync handles, and remove partial stages in finally. Do not delete a file
while its writer is still open. A failed close/abort/delete needs a tracked cleanup
retry. Keep a dedicated temporary directory with unique names and startup cleanup
of abandoned files; do not purge another tab's active operation. Page termination
can skip finally, so cleanup cannot depend only on unload handlers.

Check `estimate()` with overhead/headroom, handle quota failures throughout, and
optionally request persistence. Estimates/persistence do not reserve space or
guarantee non-eviction. Safari storage pressure/private mode/background suspension
must be tested. See [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
and the [File System Standard](https://fs.spec.whatwg.org/).

If A fails its capability gate, try B only after its storage/File-upload gate passes.
If neither works, disable large-file upload; if safe staging/export is unavailable,
disable large-file download. Do not silently buffer the entire file. No arbitrary
small-file RAM threshold was selected in this spike.

Real-device acceptance still needs: empty/partial/1 MiB/1 MiB+1/100 MiB files;
slow network and receiver; RSS/heap across increasing sizes; first-byte-before-EOF
for A; exact exported size/hash for B/C; tag/truncation/trailing-byte failures;
cancel during read/encrypt/write/upload/export; quota exhaustion, restart cleanup,
private mode, two tabs and iPhone backgrounding. Also verify request-size overhead
against the eventual account/proxy limits: 100 MiB plaintext produces
104,859,692 ciphertext-object bytes, before any envelope/transport prefix.

## What was actually checked

The browser tool reported **no enabled browsers/tabs**. No Chromium, Firefox,
Safari or iPhone pipeline, OPFS operation, download or memory measurement ran.
No mock/Node behavior is presented as browser evidence. Reviewed the actual
`fileCrypto.ts` bounded source contract, single-use encryption and EOF requirement;
checked current vendor/spec/compatibility sources. No isolated executable harness
was added because it could not be exercised in this environment.

Repository validation: `npm run build` and `npm run typecheck:worker` passed;
`npm test` passed all 81 tests (0 failed/skipped). `git diff --check` and additional
whitespace checks on untracked Phase 4 files passed. No warnings/errors were
reported by these checks. Only this report was added in this task; the existing
untracked Phase 4 docs, crypto core and tests remain uncommitted. Tracked diff is
empty. No commit, push, deployment or integration was performed.
