# Handoff — picking Perch up in a new session

Start a new Claude Code session in a clone of this repo and ask it to read this file first.

## What Perch is

A static PWA (vanilla JS, no build step) that shows Eagle reference libraries stored in Google Drive.
Live at GitHub Pages (`main` branch, repo root). Google Cloud only holds the OAuth client ID
(Testing mode, test users); the app itself is not hosted there.

- `js/main.js` boot, screens, sync, sheets, token renewal, Save to Eagle
- `js/auth.js` OAuth implicit flow: redirect sign-in, hidden-frame silent renew, `drive.file` opt-in
- `js/drive.js` Drive v3 client (reads, folder/file create, 401 self-heal); `js/mockdrive.js` demo stand-in
- `js/inbox.js` link inbox (My Drive / Perch Inbox)
- `js/viewer.js` full-screen viewer (video, frame step, rotate); `js/grid.js` the grid
- `sw.js` shell cache, Drive media streaming with Range, media cache + prefetch. **Bump `VERSION` on every deploy.**

Run locally: `python3 tools/serve.py 8780`, open `http://localhost:8780/?demo=1`.
`http://perch.localhost:8780/` behaves like production (service worker caching on).

## v8 (this handoff)

1. **Background token renew.** `renewInFrame()` loads Google's `prompt=none` URL in a hidden iframe;
   Google redirects the frame back to the app with the token in the hash, and the inline script at the
   end of `index.html` posts it to the parent (the app never boots inside the frame). Verified that
   Google answers inside a frame (error path, no session). Falls back to the old page redirect when
   the frame fails; if the frame fails but the redirect then succeeds, the frame is skipped for 3 days.
   **Still to confirm on the Android phone** with a real session.
2. **Faster video.** Shell is cache-first. Videos ≤ 30 MB are kept whole in `perch-media` (LRU 600 MB);
   the viewer prefetches the next/previous video (`X-Perch-Prefetch`).
3. **Save to Eagle.** Android share target (`manifest.webmanifest`) + "⋯ → Save a link to Eagle".
   Each link becomes `My Drive/Perch Inbox/<13-digit ms>-<id>.json`:
   `{ v: 1, url, library, sentAt, from: "Perch", status: "pending" }`.
   The plugin writes back `status` (`queued` | `downloading` | `done` | `error`), `by`, `title`, `error`, `doneAt`.

## Video Grabber plugin (Eagle) — not in this repo

The user's own plugin (Eagle 4 service plugin with yt-dlp, Telegram queue, browser extension for
cookies). The Perch-enabled copy adds `perch-inbox.js` and a few hooks in `index.html`
(`TelegramQueue.downloadAll` reports state, tag `perch`, `PerchInbox.start()` in `onPluginCreate`).
It finds the inbox by walking up from `eagle.library.path` (the library lives in My Drive via Google
Drive for desktop), plus Drive roots (`~/Library/CloudStorage/GoogleDrive-*` on macOS, drive letters
and the user folder on Windows). It only takes links whose `library` matches the open library, polls
every 20 s, and deletes finished requests after 7 days (errors after 14).

Install on a computer: Eagle → Plugins → Developer options → Import plugin → the
`eagle-video-downloader` folder. Needs Google Drive for desktop signed in to the same account as Perch.

## Open items

- Confirm the background renew on the phone (no more "Refreshing…" flashes after an hour).
- Testing mode still forces a full reconnect every 7 days; "Publish app" (unverified) would lift that.
- A refresh-token backend (e.g. a free Cloudflare Worker holding the client secret) would remove
  hourly renewals entirely; not built.
- Dropbox support: agreed for after Drive, not started.
