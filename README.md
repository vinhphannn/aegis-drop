# AEGIS Drop — Phase 1

Minimal local clipboard built with Vite, React, and TypeScript.

```sh
npm install
npm run dev
npm run build
npm test
npm run preview
```

Type or paste text and click **Send text** (Ctrl/Cmd + Enter also works).
Paste a clipboard image into the text box, drop files onto the composer, or use
**Add files**. Ordinary Enter inserts a newline. Recent drops support copy,
download, and delete; supported raster images also show a preview.

The five newest text/file items share one list. Batch files are added in selection
order, with the last file newest. Adding a sixth item discards the oldest.
Everything stays in memory in the current tab: refreshing clears the list, and
other devices/tabs do not sync. Clipboard copy needs localhost or HTTPS.

`src/store.ts` owns the discriminated item model, actions, subscription, retention,
and object URL cleanup. UI components consume that boundary. Object URLs are
revoked on deletion/eviction; the browser releases the remaining URLs when the
document closes. No file content is sent to a server.

Phase 1 includes no backend, authentication, encryption, routing, or persistence.

`npm test` checks mixed-item retention, file metadata, subscriber behavior, and
exactly-once object URL cleanup using the built-in Node test runner. Browser
clipboard, drag-and-drop, picker, download, and visual layout need browser checks.
