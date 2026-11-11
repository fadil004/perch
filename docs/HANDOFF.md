# Handoff — picking Perch up in a new session

Start a new Claude Code session in a clone of this repo and ask it to read this file first.

## What Perch is

A static PWA (vanilla JS, no build step) that shows Eagle reference libraries stored in Google Drive.
Live at GitHub Pages (`main` branch, repo root). Google Cloud only holds the OAuth client ID
(Testing mode, test users); the app itself is not hosted there.

- `js/main.js` boot, screens, sync, sheets, token renewal, Save to Eagle
- `js/auth.js` OAuth implicit flow: redirect sign-in, hidden-frame silent renew, `drive.file` opt-in
- `js/drive.js` Drive v3 client (reads, folder/file create, 401 self-heal); `js/mockdrive.js` demo stand-in
- `js/inbox.js` the inbox (My Drive / Perch Inbox): link and file requests
- `js/uploads.js` videos sent from the phone: kept in the `perch-share` cache, resumable upload to the inbox
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

## v9

**Phone downloads, no computer download.** A web app can't fetch videos from Instagram/TikTok/YouTube
itself (CORS, and those sites need yt-dlp), so the phone downloads with an Android yt-dlp app
(YTDLnis recommended) and shares the file to Perch.
- `manifest.webmanifest` share target is now `POST multipart/form-data` to `./share-target` with
  `files` (video/*, image/*) plus the old title/text/url params. `sw.js` `receiveShare()` keeps files in
  the `perch-share` cache and redirects to `./?shared=n`; a link alone redirects to `./?share_url=…` (old flow).
- `js/uploads.js` uploads one file at a time: Drive resumable session (`drive.startUpload` /
  `drive.sendUpload`, XHR for progress; probes with `bytes */N` and resumes; a 400 after the browser
  resends a cut PUT triggers a probe; 404/410 → new session). Session URL kept in `perch.up.<id>`.
- Inbox gets `<stem>.<ext>` (the video) + `<stem>.json`
  `{ v: 1, kind: "file", file, name, size, mimeType, url, library, sentAt, from, status: "pending" }`.
- Plugin 1.3.0 (`perch-inbox.js` `importUpload`): waits until the synced file has the full size, copies
  it to a temp folder, `eagle.item.addFromPath` (tag `perch`, website = source link if shared with one),
  deletes the inbox video, marks the request done. 3 tries, then `error`.
- Tested: headless Brave (share POST, picker, reload mid-upload, dropped connection against a fake
  Google endpoint) and a Node test of the plugin. **Not yet on the real phone, real Drive, or real Eagle.**

## v10 — phone downloader (Termux bridge)

The user wants one share → download on the phone → watch → Drive → Eagle, free, most sites.
A web page can't fetch from Instagram/TikTok/YouTube (CORS), so yt-dlp runs in Termux:
- `bridge/perch-bridge.py` (stdlib-only Python + yt-dlp): HTTP API on `127.0.0.1:47821`, contract in
  `bridge/API.md`. Origin allow-list + pairing token (`~/.perch/token`, handed to Perch via
  `#bridge=<token>`). Jobs, progress, Range file serving, cookies (`~/.perch/cookies.txt`, phone only),
  retry with/without cookies, daily `pip install -U yt-dlp yt-dlp-ejs` + re-exec when idle.
  Node is used as yt-dlp's JavaScript runtime (YouTube needs one since yt-dlp 2025.11).
- `bridge/install.sh`: `curl -fsSL https://fadil004.github.io/perch/bridge/install.sh | bash` in Termux.
  Helpers `perch-start|stop|pair|log|update`; starts from `~/.bashrc` and `~/.termux/boot/`.
  Tested only in a simulated Termux on macOS (stub `pkg`, real Python/yt-dlp), not on a phone.
- Chrome's Local Network Access asks once to let the site reach loopback; verified from the live
  https origin in headless Brave that requests work once the permission is granted (and fail before).
- Cookies are deliberately NOT synced through Drive (login cookies shouldn't sit in cloud storage);
  the user adds a cookies.txt on the phone (Perch → Phone downloader → Add cookies file).

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
