# Phase 4B.1B: encrypted text in the app

Text uses the frozen AGD1 text envelope, generated in the browser. The native,
non-extractable root HKDF key remains behind the existing opaque vault handle.
HKDF/item helpers now accept that native key as well as the original raw-key test
interface; serialization, algorithms, AAD and deterministic vectors are unchanged.
Fresh item IDs/keys are generated for each send; no automatic encryption retries.

`POST /api/items/text` accepts exactly `{id, envelope}`. ID is canonical lowercase
UUIDv4 and envelope is canonical unpadded base64url. The Worker bounds the request
to 90,000 bytes, decodes the existing frozen framing, rejects wrong versions/kinds,
malformed lengths and ID substitutions, and inserts the envelope only. Plaintext
`{text: ...}` and extra fields reject. Existing IDs reject rather than overwrite.
Server-created time, timestamp/ID ordering, pagination, auth and delete remain.
The server cannot verify AEAD without M: authentication/context checking happens
in the browser, and an authenticated malicious client can still upload junk.

Migration `0003_text_e2ee.sql` drops the old active plaintext column and discards
old plaintext text rows, preserving file metadata. The active column is
`text_envelope`; old migration 0001 remains history only. This is an intentionally
destructive pre-deployment text reset, not a compatibility/migration-decryption path.
No plaintext text item cache is persisted in IndexedDB or web storage. SQLite file
remnants/backups are not guaranteed erased by dropping the old table/column.

The existing API boundary decrypts each envelope before putting a text view in
the in-memory item store. One invalid envelope produces a safe failure card,
without plaintext or a Copy action; Delete remains available. Copy uses exactly
the authenticated plaintext, preserving Unicode/whitespace. A lock releases the
root capability, clears the cache and unmounts the composer. Late crypto/list
completion cannot repopulate it. Unlock/reload fetches and decrypts again.
Empty text is supported by the crypto/API; the existing composer still requires
nonblank input. No text body or M is logged/persisted on the server. Files retain
their existing plaintext path and are explicitly labelled not encrypted yet.

## Exact local run

Run from the repository directory with Node 22+. Local D1/R2 bindings are supplied
by Wrangler; no separate database/bucket daemon or remote resources are needed.
If `.dev.vars` already exists, retain it and use your existing local access key.
Otherwise run this **once** in your terminal. It prints a fresh local-only access
key for login, and stores only its verifier plus a separate session secret in the
gitignored `.dev.vars` (never a vault key):

```sh
node --input-type=module <<'JS'
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const key = randomBytes(32).toString('hex');
writeFileSync('.dev.vars', `ACCESS_KEY_SHA256="${createHash('sha256').update(key).digest('hex')}"\nSESSION_SECRET="${randomBytes(32).toString('hex')}"\n`, { flag: 'wx', mode: 0o600 });
console.log('Local access key (save for login):', key);
JS
npm install
npm run build
npm run db:migrate:local
npm run dev:worker -- --local-protocol https --ip 127.0.0.1 --port 8787
```

Open **https://localhost:8787**. Wrangler serves both the built frontend and Worker
on this origin, with local state under `.wrangler/state`. A local development
certificate prompt may require browser confirmation. Do not switch host/origin:
IndexedDB enrollment is origin-specific. Rebuild after frontend edits. Optional
Vite hot reload uses two terminals after stopping the HTTPS Worker:

```sh
# Terminal 1
npm run dev:worker -- --local-protocol http --ip 127.0.0.1 --port 8787
# Terminal 2
npm run dev -- --host localhost --port 5173 --strictPort
```

Open `http://localhost:5173`. The HTTP proxy cannot talk to an HTTPS Worker on
8787. Same-origin frontend Origin headers are translated to the backend origin;
foreign origins are preserved/rejected. The HTTPS built-app command above remains
the reference if your browser will not accept Secure cookies on HTTP localhost.

## Manual smoke test (six steps)

1. Open https://localhost:8787 and authenticate with your local access key.
2. Create a local vault, or unlock the saved vault in this browser.
3. Submit `Xin chào 🌿 — private text`; use Copy and paste to check exact text.
4. Reload the page, then unlock the same saved local vault when prompted.
5. Confirm the original text is decrypted again; Lock vault hides it, and Unlock restores it.
6. Delete it and reload/unlock to confirm it is gone.

Automated integration uses the actual app vault/API/store with native Web Crypto,
fake-indexeddb serialization and the actual Worker against workerd D1/R2. It checks
Unicode/empty/maximum text, ciphertext-only HTTP/D1, rejected plaintext inputs,
wrong vault, tampering, copy, pagination, delete and late-load/lock behavior.
Real browser visual/clipboard behavior is left to the manual smoke test.

File E2EE still needs a verified browser streaming/staging/export path, opaque
file metadata/storage integration and large-file lifecycle testing. Pairing/recovery
UI and server vault coordination are outside this text-only phase. Clearing this
browser's enrollment makes its text unreadable here; another independent local
vault correctly fails to decrypt it. Hostile delivered client code remains a threat
boundary, as documented in the approved design.
