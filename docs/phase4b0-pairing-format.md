# V1 isolated pairing crypto: frozen format and local contract

This implements crypto and local safety gates only. There is no relay endpoint,
D1 pairing state, capability-token storage, QR, UI, enrollment persistence or
streaming change. The approved algorithms and existing v1 vector bytes are
unchanged. This is implementation validation, not an external professional audit.

## Ephemeral keys and opaque contexts

`generateEphemeral()` uses native Web Crypto ECDH P-256 `generateKey` with a
non-extractable private key. The returned frozen handle exposes only a copied
65-byte public point. Private keys stay in a module-private WeakMap and cannot be
serialized through the handle. The private-key reference is dropped after
transcript key derivation. Native import validates peer curve points; v1
accepts only uncompressed SEC1 encoding (04 || 32-byte x || 32-byte y).

Optional `deriveSharedSecret()` provides a local 32-byte scratch secret for
primitive validation, never transport. Callers must discard/clear it after use.
It binds the ephemeral handle to one peer. `derivePairKeys()` synchronously
reserves that handle for one transcript before awaiting; retries/reuse require a
fresh key pair. It returns a frozen opaque context with SAS and copied public
transcript/hash only, not encryption/MAC keys. Do not clone or persist the handle.

## Canonical transcript

Exactly `318 + L` bytes, where L is canonical HTTPS-origin UTF-8 byte length
(9–512 bytes). Every integer is unsigned big-endian, u64 values are restricted to
JavaScript safe integers, and arrays are exact-length raw bytes.

| Offset | Field | Size / accepted value |
| ---: | --- | --- |
| 0 | Protocol magic/domain | 4, ASCII `AGP1` |
| 4 | Protocol version | 2, u16 exactly 1 |
| 6 | Suite | 1, exactly 1 (P-256/HKDF-SHA-256/AES-256-GCM/HMAC-SHA-256) |
| 7 | Reserved | 1, exactly 0 |
| 8 | L | 2, u16 |
| 10 | Origin | L, must equal URL.origin and use https |
| 10+L | vaultId | 16 |
| 26+L | epochId | 16 |
| 42+L | Authoritative descriptor hash | 32 |
| 74+L | pairId | 32 |
| 106+L | New-device role | 1, exactly 1 |
| 107+L | PN | 65, uncompressed P-256 point |
| 172+L | NN | 32 |
| 204+L | Trusted-device role | 1, exactly 2 |
| 205+L | PT | 65, uncompressed P-256 point |
| 270+L | NT | 32 |
| 302+L | Created UTC seconds | 8, u64 |
| 310+L | Expires UTC seconds | 8, u64, exactly created + 300 |

Reject unsupported version/suite/reserved/role values, extra or truncated bytes,
noncanonical origin (including credentials, path, query, uppercase-normalized
host or explicit default port), reflected PN/PT, repeated NN/NT and inconsistent
lengths. The codec checks point representation; native ECDH import additionally
checks mathematical validity. Local public point must match the transcript role.
No JSON, implicit concatenation, curve fallback or algorithm negotiation is used.
Caller must source the origin and trusted descriptor from its own trusted context;
canonical parsing alone does not make server-provided context authoritative.

## Derived keys and SAS

Z is native P-256 ECDH's 32-byte shared result. TH = SHA-256(canonical transcript).
Each HKDF-SHA-256 derivation uses IKM=Z, salt=TH and info:

`tuple(UTF8 "AEGIS-pair", u16(1), UTF8 purpose, TH)`

Purpose is exactly `provision` (32 bytes), `confirm` (32 bytes) or `sas` (8 bytes).
Tuple means u16 field count followed by u32 length and bytes per field.
Provision uses AES-256-GCM; confirmation uses HMAC-SHA-256. Native keys are
non-extractable and role-restricted: trusted encrypts/verifies, new decrypts/signs.
Raw derivation buffers are cleared best effort after import.

SAS is the first 60 most-significant bits of the eight-byte SAS output, encoded
as 12 RFC 4648 base32 characters A–Z/2–7 and displayed `XXXX XXXX XXXX`.
Comparison requires exactly that uppercase grouping. It derives from secret Z
and the entire transcript, not public information alone. It is a human comparison
mechanism, not a server credential, bearer token or proof that a human compared it.

## MACs, approval and release gates

The explicit local call `approvePairing(context, observedSas)` declares that the
caller/user compared the two physical codes and approved. The helper rejects a
mismatch; it cannot itself verify a physical user action. Future UI must invoke
it only after the approved ceremony, never auto-approve using its own displayed
code. No QR/UI implementation is included here.

Normal flow:

1. New endpoint declares approval, then signs `new-ready`.
2. Trusted endpoint verifies ready through native `crypto.subtle.verify` and
   independently declares approval.
3. Trusted may seal the root only with both gates satisfied in the active state.
4. New may open only after its approval and generation of ready.
5. After successful opening, new signs `new-consumed`; trusted verifies it against
   the exact ciphertext it sealed. Identical consumed-ack retries are idempotent.

MAC inputs are tuple(UTF8 `new-ready`, TH), or tuple(UTF8 `new-consumed`, TH,
SHA-256(complete sealed-response bytes)). Verification uses native HMAC verify;
never replace it with a JavaScript comparison of two MACs. Consumed MAC generation
requires a successful root open and exact accepted-response hash; verification
requires a sealed response and matching sent-response hash. Role, phase, expiry
and current state are checked before/after asynchronous operations.

Contexts enforce UTC created <= now < expires and a monotonic deadline fixed at
initialization to the remaining lifetime, capped at five minutes. A backward
wall-clock adjustment cannot extend it. Expired/future contexts fail closed.
Once a context observes invalid/expired time, it permanently fails; a later wall-clock
correction cannot revive it. Clock disagreement requires restarting; no hidden
grace period is assumed.

## Provisioning: exactly 168 bytes

| Offset | Field | Bytes / accepted value |
| ---: | --- | --- |
| 0 | Magic | 4, ASCII `AGS1` |
| 4 | Version | 2, u16 exactly 1 |
| 6 | Reserved | 2, u16 exactly 0 |
| 8 | IV | 12, fresh native CSPRNG bytes |
| 20 | Encrypted root bundle | 132 ciphertext bytes |
| 152 | GCM tag | 16 bytes |

AES-256-GCM AAD = tuple(UTF8 `provision/v1`, TH). The fixed plaintext bundle is
M (32 bytes) followed by the complete authoritative vault descriptor (100 bytes),
identical to recovery's internal root bundle. Validate keyCheck, IDs and descriptor
hash before accepting it. Unsupported headers, lengths or trailing bytes reject.
Only one seal/open operation is permitted per context; reservation happens before
any await. Failure consumes the operation and returns no partially recovered root.
Retries resend frozen ciphertext rather than reseal. Successful open is not replayable.

The core cannot force a malicious relay to erase data, authenticate a human action,
stop hostile same-origin JavaScript, or guarantee physical key erasure. It does
protect its normal API from accidental early root release, mutable context changes,
repeated operations and late asynchronous completion. Native keys are released
by dropping local handles; WeakMap/JavaScript lifetime is not a hardware-erasure claim.

## Findings fixed and verification coverage

- HIGH correctness boundary: draft helpers lacked full role/approval/ready/consumed
  and live-session gating. Opaque local contexts now enforce the approved sequence;
  forged handles and wrong-role operations reject.
- MEDIUM: draft transcript/hash/descriptor inputs could change across awaits or be
  edited on the returned key object. Inputs are copied and public views return copies.
- MEDIUM: ephemeral reuse and rederivation could create multiple key contexts and
  bypass per-CryptoKey single-use tracking. A handle is reserved once per transcript;
  seal/open reserve synchronously against concurrent calls.
- MEDIUM: expired contexts and valid ciphertext replay had no mandatory local release
  gate. UTC plus monotonic deadlines and one-time opening are now enforced.
- LOW: pending confirmations could finish after the local phase advanced. The phase
  is rechecked after native crypto, without rolling state back.

Persisted test-only vectors reproduce both sides' transcript/ECDH, derived keys,
SAS, MAC inputs/outputs, IV and complete provisioning bytes. The independent
Node/OpenSSL reference uses separate codecs/APIs; native Web Crypto ciphertext
and MAC outputs are compared directly, not just self-roundtripped.

Adversarial checks cover every context field, PN/PT substitution, wrong local
private-key handle, roles, malformed/off-curve points, version/suite, origin,
SAS, MAC purpose/hash/signature, ciphertext/framing, invalid inner roots,
mutable views, parallel reuse, expired/rolled-back clocks, expiry during decrypt,
late confirmations, no partial output, and absence of secret-bearing logs/errors.
Fixed scalars, IVs and clocks are test-harness substitutions only; production
contains no deterministic entropy or time override mechanism.

The subsequent [adversarial review](phase4b0-pairing-adversarial-review.md) records
proven expiry/bounds fixes, MITM/replay tests and the limits of the 60-bit SAS claim.
