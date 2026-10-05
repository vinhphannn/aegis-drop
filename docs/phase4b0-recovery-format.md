# V1 recovery crypto: frozen format and validation

Recovery remains an isolated client module. No UI, server storage, pairing,
QR, browser streaming or enrollment persistence is integrated by this work.
The approved algorithms/protocol are unchanged; this freezes their byte layout.

## Package: exactly 248 bytes

All integers are unsigned big-endian. Parsers require exactly this length,
magic/version/reserved values, and no trailing bytes. There are no variable
length fields to reinterpret and no JSON in cryptographic AAD.

| Offset | Field | Bytes / validation |
| ---: | --- | --- |
| 0 | Magic | 4, ASCII `AGR1` |
| 4 | Format version | 2, u16 exactly 1 |
| 6 | Reserved | 2, u16 exactly 0 |
| 8 | vaultId | 16, raw public identifier |
| 24 | epochId | 16, raw public identifier |
| 40 | Recovery salt | 16, fresh CSPRNG bytes |
| 56 | Authoritative descriptor hash | 32, SHA-256 of complete descriptor |
| 88 | AES-GCM IV | 12, fresh CSPRNG bytes |
| 100 | Encrypted root bundle + tag | 148 = 132 ciphertext + 16 authentication tag |

Generate R independently using `crypto.getRandomValues`, exactly 32 bytes.
Krecovery is 32 bytes from HKDF-SHA-256: IKM=R, salt=the 16-byte package salt,
info=tuple(UTF8 `AEGIS-Drop`, u16(1), UTF8 `recovery/v1`, vaultId, epochId).
This is separate from the vault/item HKDF domains and authentication secrets.
Each wrap generates fresh R, salt and IV; callers cannot supply an encryption IV
or a user-chosen recovery password.

AES-256-GCM uses a 128-bit tag. AAD is tuple(UTF8 `recovery/v1`, the first
88 package bytes). A tuple is u16 field count, then u32 byte length and raw bytes
for each field. Field boundaries are explicit; no implicit string concatenation.

Decrypted bundle is exactly M (32 bytes) followed by the complete authoritative
vault descriptor (100 bytes). The descriptor has `AGV1`, version=1, reserved=0,
vaultId, epochId, IV and encrypted keyCheck. Validate it using the recovered M,
then require its IDs and SHA-256 hash to match the recovery header. Only then
return M, descriptor, IDs and hash. Even a correctly authenticated outer package
with invalid inner material is rejected without returning partial secrets.

The package contains neither plaintext R nor plaintext M. The root bundle exists
only as transient encryption/decryption input; it is not a persistence/file format.
R is deliberately returned to the caller for the explicit user-held representation.
Recovered M is deliberately returned after validation for local vault use.

## Human key: exactly 81 ASCII characters

Compute checksum = first four bytes of SHA-256(tuple(UTF8 `recovery-check/v1`, R)).
Encode R || checksum (36 bytes) in RFC 4648 base32 using `A-Z2-7`, without `=`
padding. Result has 58 symbols; unused final two bits must be zero.

Canonical text is `AEGIS-R1-` followed by fourteen four-symbol groups and a final
two-symbol group, joined by ASCII hyphens. The prefix identifies the representation
version. The encoder emits uppercase; the decoder also accepts ASCII lowercase
or mixed case, with otherwise identical grouping. It rejects spaces, newlines,
missing/misplaced separators, Unicode lookalikes, padding, incorrect lengths,
unsupported prefixes and numeric 0/1 aliases. It does not substitute ambiguous
characters. Both final pad bits and the four-byte checksum must validate.

The checksum detects transcription errors; it is not authentication. Possessing
a correctly formatted key is not proof of authorization or correct vault identity.
The package's AES-GCM tag and inner keyCheck provide the cryptographic validation.
A complete kit (R plus package) conveys vault-key authority and must be user-held.

## Review and tests

Fixed mutable-input races in the draft: root/descriptor/package/key bytes are
copied before awaiting validation, derivation or hashing. Buffer-backed views do
not alias live caller storage or get reread as AAD. Failure paths use generic
errors without keys, underlying causes or secret-bearing logs. Internal plaintext
and failed recovered-key copies are cleared best effort; JavaScript does not
promise physical erasure. Successful output does not alias the caller's inputs.

`tests/vectors/e2ee-v1.json` contains public test-only recovery entropy, derived
key, full package hex, checksum and human key. `tests/protocol-reference.mjs`
reproduces these using independent codecs and Node/OpenSSL APIs; its base32
implementation uses BigInt rather than the production bit accumulator.
Production code has no deterministic-entropy parameter.

Tests cover exact roundtrip/root/identity/descriptor/keyCheck, fresh production
entropy, human representation/checksum/canonical padding, every public/package
field, wrong keys, truncation/trailing bytes/length/version errors, valid outer
AEAD with invalid inner roots/IDs/hash/descriptor, input mutation/offsets, generic
errors and absence of logging. Existing item/file/auth/storage checks remain.
No independent professional crypto audit or browser support claim is implied.
