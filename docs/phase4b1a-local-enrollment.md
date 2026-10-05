# Phase 4B.1A: local browser vault enrollment

This phase adds local enrollment after Phase 3 authentication. No Worker, D1/R2,
item/text/file payload, pairing, recovery UI or Google-auth behavior is changed.
Existing cloud drops are still plaintext; the UI explicitly says so. Each browser
can create an independent local vault here; no server-side authoritative vault
selection or cross-device discovery is implemented yet.

## Storage and local format

IndexedDB database `aegis-drop-local-vault`, database version 1, has one object
store `enrollment` without indexes, keyed by `current`. One record contains:

| Field | Representation |
| --- | --- |
| version | Exactly 1 |
| createdAt | Nonnegative safe-integer UTC milliseconds |
| deviceKey | Native non-extractable AES-256-GCM CryptoKey, encrypt/decrypt only |
| vaultId / epochId | 16 bytes each |
| descriptor | Existing canonical 100-byte vault descriptor |
| descriptorHash | SHA-256 of the entire descriptor, 32 bytes |
| iv | Fresh CSPRNG 96-bit IV |
| encryptedRoot | 132-byte root bundle plus 16-byte GCM tag, 148 bytes |

The plaintext root bundle is the existing M32 + descriptor100 representation.
Local AES-GCM AAD uses the existing unambiguous tuple codec:
`tuple(UTF8("local-root/v1"), u16be(1), vaultId, epochId, descriptorHash, u64be(createdAt))`.
This is a local enrollment format, separate from the frozen item/recovery/pairing
protocols. Ldevice is generated independently and used only for this root wrap.
No plaintext M or access credential is stored. IDs, descriptor and timestamp are
public. Same-origin hostile code can use the persisted Ldevice to unwrap M;
this is not independent protection against XSS or browser profile compromise.

## Bootstrap, reload, unlock and lock

Authentication starts a read/validation check, never automatic creation. A missing
record offers explicit creation. Bootstrap generates M/IDs through the existing
CSPRNG core, creates the descriptor, wraps the root under a fresh device key and
validates keyCheck. One readwrite transaction checks the store is empty and adds
the whole record. Concurrent creators cannot overwrite the winner. No await is
performed inside the transaction; success waits for transaction completion.
The saved record is read back through IndexedDB and unlocked, checking key persistence
and serialization before reporting success.

Reload leaves enrollment locked. Explicit unlock snapshots and validates version,
key type/purpose/non-extractability, lengths, IDs and descriptor/hash; decrypts the
root; validates its keyCheck and exact pinned descriptor; imports M as a
non-extractable native HKDF key. Only an opaque public-identity handle is returned.
The root CryptoKey stays in a private WeakMap; neither it nor raw M enters React
snapshots. Scratch plaintext/M buffers are cleared in finally blocks. Returned
identity views are copies.

Lock drops the live root handle/key reference and hides/unmounts the app, clearing
the existing item cache. Successful logout/session expiry does this synchronously
through the auth subscription, retaining encrypted enrollment. Generation checks
release late handles and prevent pending operations from reopening a locked or
unauthenticated session. An already-running IndexedDB commit can finish after
logout; its encrypted enrollment remains locked, without returning live root material.
Native Web Crypto operations are not cancellable; their scratch is cleared when
they settle. JavaScript/native implementations cannot guarantee physical memory wiping.

## UI and failure states

Unauthenticated retains the existing access-key screen. Authenticated states are:
checking, no local vault (Create), enrolled/locked (Unlock), unlocked (Lock vault),
damaged enrollment, and unavailable storage. Sign out is separate from vault lock.
Damage is surfaced for missing/wrong device keys, invalid versions/lengths,
descriptor/hash/identity mismatches, null/partial/orphan records, invalid AEAD,
failed keyCheck and unsupported database versions. No repair/delete/recovery action
or silent replacement exists. Storage failure has a retry check; no plaintext or
in-memory-only persistence fallback is used.

## Security review and test coverage

- Null/partial records must not masquerade as an empty store; damaged states block
  bootstrap. Creation rechecks at action time and atomically rejects existing data.
- Both native CryptoKey non-extractability and purpose are validated on reload.
- Mutable byte views are copied before awaits; plaintext is not published on failure.
- Lock/logout invalidate async completion and clear cached application plaintext.
- Blocked IndexedDB opens close any eventual late connection. Transactions persist
  key/ciphertext together and reject uncloneable data without partial records.
- No vault logs, secret-bearing error causes, auth credentials or network calls
  occur in local crypto/storage. Existing API behavior remains unchanged.

`tests/local-vault.test.mjs` uses development-only fake-indexeddb because Node has
no browser IndexedDB. It exercises transaction aborts/concurrent creators and native
Web Crypto/structured-clone serialization, not canned storage return values, except
for controlled asynchronous barriers. Tests cover bootstrap, reload, lock/unlock,
all corruption cases, valid AEAD with invalid keyCheck/pinned descriptor, no plaintext
M persisted, aliasing, logout/expiry retention, stale async completion, unavailable
storage and absence of logging.

Real-browser CryptoKey persistence and visual UI behavior are not verified in this
environment. No browser compatibility claim is inferred from fake-indexeddb.

Final validation: build and Worker typecheck passed; all 100 tests passed (the
original 81 plus 18 enrollment subtests and their parent test), with no failures
or skips. Tracked and untracked whitespace checks passed. The browser tool reported
no enabled browsers. The npm install audit reported zero vulnerabilities. No
frozen crypto-core files, Worker, migrations or API payloads changed; no commit or
push was performed.
