# Phase 3 authentication

One access credential unlocks the same private history on every device. There are
no users, registrations, roles, or session tables. Authentication and any future
client-side encryption keys must remain cryptographically independent. Neither
access-key material nor session-signing material is an encryption key. The server
still sees plaintext content and filenames.

## Secrets and verification

The Worker requires two server-only secret bindings:

- `ACCESS_KEY_SHA256`: lowercase 64-character hexadecimal SHA-256 of the access
  key, encoded as UTF-8 without a trailing newline.
- `SESSION_SECRET`: an independently generated random 32-byte key, encoded as
  lowercase 64-character hexadecimal.

Use a randomly generated high-entropy access key (at least 32 random bytes, e.g.
`openssl rand -hex 32`), kept in your password manager. SHA-256 is appropriate for
this random credential, not for a weak human-chosen password. Login computes a
32-byte digest and uses Workers' native constant-time `crypto.subtle.timingSafeEqual`
to compare fixed-length digests. Bounded input validation and hashing time depend
on input length, but comparison does not reveal matching prefixes. No key is
logged, returned, put into a cookie, or written to D1/client persistent storage.

Login accepts only JSON and bounds its body to 8 KiB and key to 1024 characters.
Missing or invalid configuration fails closed with 503, never an open API.

## Local setup (owner-run)

These commands have not been run to create actual credentials. Do not use a
production credential in local development. Create an ignored `.dev.vars` beside
`wrangler.jsonc` with this format, replacing both placeholders:

```dotenv
ACCESS_KEY_SHA256="<64 lowercase hex characters>"
SESSION_SECRET="<64 independently generated lowercase hex characters>"
```

Generate the signing secret separately with `openssl rand -hex 32`. To calculate
the access-key verifier without embedding the key in a command/history, in Bash:

```bash
read -r -s -p 'Access key: ' aegis_access_key
printf '\n'
printf '%s' "$aegis_access_key" | openssl dgst -sha256
unset aegis_access_key
```

Copy only the digest after `=` into `.dev.vars`. This prints the verifier, not
the plaintext key. `.dev.vars` and environment files are gitignored. Never use
`VITE_*` variables for either secret. Run the built app with:

```sh
npm run build
npm run db:migrate:local
npm run dev:worker -- --https
```

Use `https://localhost:8787`, accepting Wrangler's local development certificate
if required. Cookie security attributes are never weakened for HTTP development.
Vite's existing HTTP localhost proxy remains optional and browser-dependent for
Secure cookies; the HTTPS Worker flow is the reference. Clipboard/visual/browser
cookie behavior still needs actual browser QA.

## Production setup (later; not executed)

Serve exclusively over HTTPS, redirect HTTP at the edge, and configure login rate
limiting before exposure. Provision the two secret bindings through the Cloudflare
Worker settings or these owner-run commands:

```sh
npx wrangler secret put ACCESS_KEY_SHA256
npx wrangler secret put SESSION_SECRET
```

These are future operational commands: `wrangler secret put` may deploy a Worker
version. No resource, secret, or deployment was created in this task.

A Cloudflare edge rate-limiting rule scoped to `/api/auth/login` is the deployment
requirement. Choose a conservative per-client attempt threshold and action using
the capabilities of your account; verify spoofing/IP/proxy and distributed-attempt
behavior. Application code does not currently throttle login. No D1 counters or
per-isolate counters with misleading durability guarantees were introduced.

## Session and HTTP behavior

The cookie is `__Host-aegis-session`, host-only (no Domain), with `HttpOnly`,
`Secure`, `SameSite=Strict`, `Path=/`, and `Max-Age=2592000` (30 days).
The token is `v1.issued.expires.randomNonce.signature`; its random nonce is 16
bytes and signature is HMAC-SHA-256. Payloads contain no credential, verifier,
file metadata, or content. Web Crypto verifies the MAC. Server checks shape,
size, duplicate cookie names, timestamps, exact lifetime and expiration. Sessions
are not renewed on each request. Signing includes a domain separator and the
current verifier; changing either secret invalidates all old sessions.

All existing and future non-auth `/api/*` routes are gated before storage calls.
GET session returns a boolean; POST logout clears the cookie with the same
attributes and immediate expiration. APIs, errors, attachments and auth responses
use `Cache-Control: no-store`. Static app assets contain no private data and keep
their existing asset-cache behavior.

Mutations (including login/logout) check Origin when present against the request
origin and reject Fetch Metadata indicating cross-site or same-site subdomain
requests. Browser cookie requests also rely on SameSite=Strict and host-only
cookies; an absent Origin is allowed for non-browser clients, which must still
possess a valid cookie for data operations. No CORS headers or cross-origin
preflight support are enabled. There is no separate CSRF-token subsystem.

The frontend checks the session before loading history. It keeps the access key
only in the password field's ephemeral React state, clears it after success/status
changes, and does not persist it. Fetch requests explicitly use same-origin
credentials. A 401 locks the interface, discards cached history, and requires
unlocking; generation guards prevent late responses restoring a prior cache or
an old 401 locking a freshly authenticated session. Failed logout retains the
unlocked state and reports the error rather than pretending the cookie was cleared.

## Limits and verification

Stateless logout clears this browser cookie but cannot revoke a copied token.
Such a token works until expiry or global secret rotation. Per-device revocation,
idempotency, rate limiting, XSS-resistant frontend deployment hardening, and
content encryption are not implemented here. HttpOnly does not prevent same-origin
malicious script from making requests; authentication does not protect content
from the server. The existing R2/D1 orphan and request-driven cleanup limitations
remain unchanged. No production edge behavior or browser rendering is claimed.

Tests use real workerd authentication and D1/R2, with random test-only credentials.
They cover valid/wrong/malformed login, cookie properties, no credential disclosure,
valid/forged/expired/future/malformed/duplicate cookies, both-secret rotation,
missing configuration, every unauthenticated item route, authenticated Phase 2
behavior, logout, no-store and origin rejection. Frontend tests cover startup,
errors, cookie usage, expiry, late requests, and cache reset. All Phase 2 tests
remain; no dependencies, D1 schema, or storage lifecycle were added for auth.

References: [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
