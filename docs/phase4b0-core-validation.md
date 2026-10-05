# Phase 4B.0 focused core validation

Scope: format, keys, itemCrypto and fileCrypto only. Existing pairing/recovery
source and vectors remain untouched. No integration, browser capability work,
local data reset, commit, push or deployment occurs in this validation task.

## Findings fixed

- MEDIUM: buffer-backed views could be decoded from the wrong underlying offset;
  slices could alias caller storage. Reader/sized outputs now make Uint8Array
  copies and numeric views honor byte offsets. File opening snapshots the envelope.
- MEDIUM: HKDF retained mutable salt/info across asynchronous key import. Both
  are copied before the first await; a regression mutates the original inputs
  while derivation is pending and compares with the independent reference.
- LOW: default UTF-8 decoding stripped a leading BOM, rejecting legitimate text.
  Fatal decoding now preserves literal U+FEFF; lone surrogates/invalid UTF-8 remain
  rejected. The envelope maximum is the exact 65,698 bytes rather than a padded
  bound. Boundary, unsafe-u64 and oversized declared-length cases are exercised.
- LOW: file-key creation now uses the authenticated header snapshot rather than
  rereading a caller-mutable manifest kind after asynchronous encryption.
- Test corrections: compare binary content rather than Buffer/Uint8Array class
  identity; resolve test modules sequentially so the shared loader does not race.

## Reviewed invariants

HKDF purpose labels and fixed length-prefixed tuples separate wrapping, manifests,
file chunks and keyCheck; vault/epoch/item context is included. No JSON is AAD.
The wrapping and manifest keys are distinct. Random per-item secret and IVs
continue to originate from Web Crypto CSPRNG; no test-entropy API was added to
source. Envelope authentication does not depend on the encrypted file body, so
using its digest in chunk AAD does not create a circular dependency.

File IV is zero64 || u32 index under one fresh derived file key. Each chunk index
is reserved before awaiting encryption. A single-use file handle is consumed
before its first output, including cancelled/failed attempts. Concurrent/repeated
use fails. Changed content requires a new item secret/operation; retries replay
already frozen ciphertext. These guards apply to the provided operation API,
not arbitrary hostile code reimporting key material through low-level Web Crypto.
No persistent encryption-resume capability is provided.

Record lengths/counts are bounded by the authenticated manifest. Decryption
checks header/envelope digest, per-chunk authentication, declared lengths and exact
EOF. Authenticated prefixes may be yielded incrementally; a caller must finish
iteration successfully before treating output as a complete file. Reordered,
duplicated, missing, truncated or trailing data fails rather than being accepted.

See `tests/vectors/README.md` for reproducible inputs and independent reference
coverage. Node verification does not establish browser-platform support or remove
the accepted trusted-client/endpoint and cryptographic-review assumptions.
