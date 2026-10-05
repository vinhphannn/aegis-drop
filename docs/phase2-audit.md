# Phase 2 architecture/security audit

This audit originally reviewed five-item retention. The subsequent product change
removes automatic retention; descriptions below now reflect persistent history.

Reviewed the actual uncommitted diff, Worker/storage code, frontend API/store,
SQL migration, Wrangler config, and tests. No Phase 3 changes, production resource
operations, commits, or pushes were performed.

## Findings and fixes

| Severity | Finding | Evidence and fix |
| --- | --- | --- |
| HIGH | Upload compensation could delete a committed file after a lost D1 acknowledgement. | A test executes the real D1 insert, then throws a transport error. Before the fix the listed file downloaded as 404. Compensation now checks ownership by generated R2 key, including pending rows; uncertain ownership preserves bytes. The same test now downloads the original bytes. |
| MEDIUM | Early R2 rejection left the producer blocked on FixedLengthStream backpressure. | An injected put error before consumption caused the actual request to time out. An AbortController now cancels the producer/source when put fails, and both promises settle. Size checks are explicit and bounded; storage errors return 500 rather than blaming client input. |
| MEDIUM | Successful mutations could be reported as failures, encouraging duplicate sends. | A cleanup-scan error returned 500 after a committed text insertion. A failed GET after a successful POST rejected the store action even when reconciliation succeeded. Cleanup scanning is now best effort; confirmed-success mutations resolve and report refresh failure separately, allowing the UI to clear the sent draft. |
| MEDIUM | Cleanup could exceed Free-plan per-invocation budgets. | A 50-row batch needed 51 D1 queries before the list query, plus up to 50 R2 deletes. Batches now process at most ten rows (11 cleanup D1 queries and ten R2 deletes), leaving headroom for the primary operation. Backlog draining is verified against actual local objects and rows. |
| MEDIUM | A malformed 200 item-list response could replace items with invalid data and crash rendering. | The API used only a TypeScript cast. A regression now supplies a malformed list; runtime validation rejects it before cache replacement and preserves usable items. |
| LOW | JSON MIME matching accepted `application/jsonp`; fixed endpoints could return invalid-ID errors for unsupported methods, without Allow headers. | Exact, case-insensitive JSON media-type matching and consistent 405/Allow responses are tested. |
| LOW | A text drop could modify a disabled composer while a send was pending, then be erased on completion. | Form-level drop handling now honors the same loading/busy guard as the composer. |

The test-loader sourceURL addition only makes regression stack traces readable;
it changes no application behavior. No new dependencies were added for the audit.

## R2/D1 consistency

- File bytes are streamed to a generated UUID key before the D1 insertion. Proven SQL failures preserve prior rows and compensate R2.
  An acknowledgement/ownership failure no longer licenses deletion of owned bytes.
- Explicit delete marks a row pending before deleting bytes. Pending rows cannot
  be listed or downloaded. Metadata is physically removed only after R2 deletion
  succeeds. Failure of either R2 delete or the metadata delete leaves retry state.
- Keys are generated server-side, unique in D1, not derived from filenames, and
  never mutable through the API. No wrong-object deletion was found in those paths.
- Each insert is independent; no retention SQL or eviction transaction remains.
  The collision test forces equal timestamps for 12 concurrent mixed uploads,
  then compares every paginated ID with an independent descending-ID sort and
  checks all corresponding R2 objects and downloaded bytes. All items persist.
- Concurrent repeated deletes yield one successful transition and subsequent 404s.
  A simultaneous upload remains intact; cleanup deletion is idempotent.
- Cleanup is bounded and request-driven. GET/create/delete retry pending work;
  downloads do not run cleanup. Permanently failing oldest tombstones can delay
  newer cleanup, and no requests means no progress. No background service added.

## Streaming and runtime limits

The frontend passes a File directly to fetch. The Worker routes the request body
through a counting TransformStream and FixedLengthStream into R2. Counting uses
only byte totals and forwards chunks; there is no full-file arrayBuffer, Blob,
base64, tee, or chunk collection on this path. Downloads return R2's body stream.
The only payload buffering in production code is the bounded small text request.
Test-loader base64 is executable test source, not file data.

The integration test generates varying 64 KiB chunks totalling exactly 100 MiB,
hashes the input, uploads through the actual Worker/R2 binding, streams the entire
download into a second hash, and compares byte counts and digests. This verifies
streaming data integrity; it is not a production peak-heap measurement.

Cloudflare documents a 128 MB per-isolate memory limit, a 10 ms Free-plan CPU
budget, 50 Free-plan subrequests, and account-dependent request-body limits
(including 100 MB on Free/Pro). D1 allows 50 queries per Free-plan invocation.
The app's cap is 104,857,600 bytes; local acceptance does not guarantee the same
bytes are accepted by an account's edge configuration. Chunk-processing CPU and
concurrent-upload heap still require production profiling. No edge limits were
emulated or production requests performed.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## HTTP and D1 review

- Filename controls/CRLF/NUL are rejected. Quotes and backslashes in the ASCII
  fallback are replaced; filename* percent-encodes UTF-8 and RFC-sensitive symbols.
  Encoded Unicode, quotes, separators, percent signs, and injection attempts tested.
- Downloads preserve MIME but force attachment, nosniff, sandbox/default-src-none
  CSP, and no-store. HTML/SVG do not receive an inline route or UI preview.
  A file claiming image/png but containing HTML is passed to an image decoder,
  not inserted into an HTML DOM. Actual browser rendering remains unverified.
- IDs are validated before parameterized SQL; malformed routes do not reach object
  keys. Text and file sizes are bounded independently of Content-Length, including
  streamed input with a dishonest declared size. File keys/names are not SQL text.
- Migration checks constrain type-specific fields, required values, pending state,
  and nonnegative size. SQLite's dynamic typing is not a strict-table guarantee;
  the API always supplies validated integer sizes. Strengthening storage for
  arbitrary out-of-band SQL writers is not necessary for the current API.
- The recent index covers pending state and timestamp/ID keyset filtering. Public ID is the
  deterministic timestamp tie-breaker. Migration 0002 replaces the recent index
  without rewriting migration 0001 or deleting existing data.

## Frontend, tests, complexity, and future payloads

UI components know only DropItem and store actions, not D1/R2. Store operations
serialize mutations and loads; startup loads are deduplicated, with no overlapping
load permitted during mutation. Tests check busy duplicate-send rejection and
malformed/error responses. Snapshot state remains usable on failed refresh.
No object URLs remain in the remote path, so there is no local URL lifetime to
manage. File download/preview URLs come from the API boundary.

The existing rollback tests use real SQL abort triggers. Retry tests use actual
D1/R2 with only a deliberate failing transport operation; they inspect both pending
state and later cleanup. Those tests were substantive. The original concurrency
assertion checked counts without proving the ordering or matching keys;
it now verifies the complete persistent history. The original 100 MiB test checked size but not integrity;
it now verifies a streamed roundtrip digest. Tests are still local simulations.

The single-table tombstone state has a correctness benefit; removing it would
lose cleanup keys on errors. The small API, store subscription, and two Worker
modules are retained. No framework, transactions spanning services, upload queue,
scheduler, router, or speculative folder restructuring was introduced.

D1 can store encoded opaque ciphertext in text_content and R2 accepts arbitrary
opaque bytes. Storage/pagination do not parse either. Phase 4 needs client envelope
serialization, ciphertext-overhead budgeting, encrypted metadata handling, and
adjusted presentation/validation; it does not require a new storage architecture.
No encryption implementation was added.

## Intentionally unresolved limitations

- HIGH if publicly exposed: there is no access control, rate limiting, or encryption.
  These remain explicit phase boundaries; authentication was not implemented.
- MEDIUM: abrupt termination after R2 succeeds but before D1 records ownership,
  unavailable ownership checks, or failed rollback deletion can leave orphaned
  objects. Durable upload intents/reconciliation would require additional lifecycle
  work; preserving uncertain bytes is preferable to deleting a committed file.
- MEDIUM: a mutation whose acknowledgement is lost can still be repeated by a user.
  There is no server idempotency key. Confirmed POST-success/GET-failure handling is
  fixed; uncertain outcomes still require refresh before retry.
- Downloads can race explicit deletion and return 404; selection does not reserve an item.
  Persistent cleanup outages can grow tombstones and physical R2 usage beyond active logical bytes.
- Production deployment, edge-size acceptance, CPU/heap profiling, and browser
  clipboard/dialog/download/rendering/layout behavior were not verified here.
