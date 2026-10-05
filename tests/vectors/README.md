# Isolated core vectors (v1)

`e2ee-v1.json` is public **test-only** material. Its master, item secret, IVs,
and derived keys must never protect real data. Production functions call Web
Crypto CSPRNG directly; deterministic entropy is substituted only by the test
harness, then restored.

The focused validation uses the `identity`, `entropy`, `texts`, `files`, and
`vault` sections. The recovery validation additionally checks `recovery`, including
its independently reproduced package, checksum and grouped human key. The isolated pairing validation now also checks `pairing`: transcript, ECDH,
HKDF purposes, SAS, confirmations and provisioning bytes. Fixed private scalars
are test-only and are substituted only in the test harness.

Coverage:

- UTF-8 text and empty text; complete envelope/wrapped-secret bytes.
- Header/AAD, HKDF-derived wrap/manifest/file keys, vault descriptor/keyCheck.
- Encrypted file manifests and files of 0, 37, 1,048,576, 1,048,577 and
  2,097,189 plaintext bytes.
- Each file's framing prefix, record lengths, per-record digest/tag/AAD,
  whole-object digest/length and plaintext digest.

Large ciphertext is represented by SHA-256 digests and tags rather than megabytes
of hex. Reproduce its input byte at offset i as `(17 * i + 3) mod 256` and use the
fixed item secret/IVs/context in the fixture. All integers are big-endian. A tuple
is u16 field count followed by u32 byte length and bytes per field. The envelope
includes a u32 encrypted-manifest byte length after the manifest IV.

`tests/protocol-reference.mjs` uses separate codecs and Node/OpenSSL HKDF, AES-GCM
and hashing APIs, with no application imports. Tests reproduce the reference
output and compare Web Crypto output against the persisted bytes/digests, not
just against its own decryption. This is independent implementation cross-checking,
not an independent professional security audit; both runtimes may use OpenSSL.

Run the focused checks directly with `node tests/crypto.test.mjs`, or with the
existing `npm test` suite. No browser, transport, UI or cloud storage is involved.
