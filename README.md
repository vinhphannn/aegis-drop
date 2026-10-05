# AEGIS Drop Simple

A static, dark React app for directly sending text, screenshots and files between
two browsers using WebRTC DataChannel. No accounts, application server, database,
cloud history or custom vault encryption. WebRTC provides transport encryption.
GitHub Pages hosts the frontend only; files never go to an application server.

## Run

Use Node 22+:

```sh
npm install
npm run dev -- --host localhost --port 5173 --strictPort
```

Open **http://localhost:5173/aegis-drop/** in two tabs or browsers. For phone/computer
use the HTTPS Pages site; plain HTTP on a LAN IP may lack secure browser APIs.

## Connect and transfer

1. In tab A, click **Create connection** and copy the complete offer.
2. In tab B, click **Join connection**, paste the offer, then **Generate answer**.
3. Copy B's answer into A's answer field and click **Connect**.
4. Wait until both show **Connected to device**; send text in both directions.
5. Paste a screenshot, drop a small PNG, or use **Add files**. Check B's preview
   and download. Send a binary file and compare its saved bytes to the original.
6. Keep both pages open. Disconnect/reload clears received items and releases URLs.

Manual copy/paste is the only signaling flow; no QR or signaling service is added.
Exchange codes only with your intended device. Codes contain network candidates;
do not post them publicly. A public Google STUN service discovers candidates,
but receives no file/text payload. There is **no TURN relay**: restrictive NAT,
firewalls, VPNs or cellular networks may prevent a connection. Try the same Wi-Fi
or a different network. No connection across every network is promised.

## Bounds and memory

- Text: <=12 KiB UTF-8, with a <=16 KiB encoded control-message bound.
- Files: <=32 MiB each; 16 KiB binary ArrayBuffer chunks, never whole-file base64.
- Sender reads one slice at a time; bufferedAmount high/low water marks are
  256/64 KiB, with bufferedamountlow/close/error handling and stall timeout.
- Receiver buffers one bounded file, requires exact declared length before Blob
  creation, and acknowledges completion. Both directions work independently.
- Received history: newest five items, <=64 MiB payload total, in memory only.
- PNG/JPEG previews: <=2 MiB and <=4 million declared pixels, no APNG preview.
  SVG/HTML and other formats stay downloads. Save URLs use generic binary MIME.
- Remove/eviction/disconnect revokes URLs. Interrupted transfers never become a
  completed received item. No IndexedDB/localStorage/sessionStorage item cache.

## GitHub Pages

Vite production base is `/aegis-drop/` for:
**https://vinhphannn.github.io/aegis-drop/**.

```sh
npm run build
npm test
git push -u origin simple
```

In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
The official Pages workflow in `.github/workflows/pages.yml` builds/deploys on
pushes to `simple`. If the `github-pages` environment restricts branches, allow
`simple` in its deployment branch rules. No cloud bindings or auth secrets are
required. Only `dist` is published; the native WebRTC test runtime is dev-only.

## Validation and preservation

Tests use two real native WebRTC peers (node-webrtc, local ICE without STUN) for
manual offer/answer exchange, encrypted DTLS/SCTP channels, Unicode text in both
directions, PNG/empty/binary/chunk boundaries, simultaneous file transfers, exact
saved bytes, progress and cleanup. Hostile/oversized/session-mixed messages reject;
a controlled queue-pressure test checks the actual send loop's backpressure.
This is not a browser visual/clipboard/phone-NAT certification. Run the two-tab
manual flow above in your browsers before relying on a network combination.

The previous cloud implementation is preserved unchanged on branch `cloud-v1`.
Deployment/config work is preserved in named stash `cloud-deploy-wip`. All Simple
work is confined to branch `simple`; existing remote Cloudflare resources were
not deleted or used. There is no Simple backend/billing requirement.
