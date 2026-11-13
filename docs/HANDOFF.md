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

## v12 — phone videos show in the library at once

`js/pending.js`: videos sent from the phone that Eagle hasn't added yet appear as normal tiles at the top
of "All" (only there), built from the upload queue plus inbox `kind:'file'` requests for the open library.
Local frame thumbnail (`thumbStore` `pend:<stem>`), else Drive `thumbnailLink`/`videoMediaMetadata`.
Plays from the phone copy (`local:<stem>`) until uploaded, then from Drive (`media/<fileId>`). A request
turning `done` removes the tile and triggers a sync; never shown twice (`notInLibrary()`). The only marker
is a tiny dot; the viewer's info panel says where it is. Download/Save buttons stay disabled while the
link field is empty.

## v13 — delete from the phone

Trash button in the viewer (needs Drive write access, else `askWrite`). The item leaves at once; a toast offers
Undo for 5 s; then `Perch Inbox/<stem>.json` `{ v: 1, kind: "delete", item, name, library, sentAt, from, status }`
is written and plugin 1.5.0 moves the item to Eagle's Trash (`moveToTrash` only). Perch keeps it hidden
(`perch.deleted.<modeKey>.<libId>`, filtered before the `Library` model is built) until a sync no longer has it;
a failed write retries with `refreshPending`/`online`; plugin `status: 'error'` shows it again; 30 days unprocessed
→ shown again. A pending phone video is never sent: its upload stops (`uploader.cancel`) or its inbox files go to
Drive's bin (`drive.trash`). Delete requests come back from the same inbox listing (`inboxRequests`).
Plugin: a delete without `library` is rejected; at most 25 per scan; not found → retried for 3 days.

### v13 — review fixes (three read-only reviews, then two fix batches)

Reliability (main.js, uploads.js, inbox.js, drive.js, auth.js, store.js, eagle.js, bridge.js, sw.js):
- `perch.share` is a queue (`[{ url, t, pc, job }]`, kept 24 h). Phone downloads are followed by a module-level
  watcher (`W`, `watchLink`/`watchJob`/`pollJob`/`claimJob`) whether the Save sheet is open or not; the sheet only
  draws the watcher's entries. A failed copy-in keeps the bridge job (Retry). Bridge files stream straight into
  the share cache (`stashStream`), never through memory.
- `wipeAll()` no longer deletes `perch-share`; sign-out confirms when videos are waiting.
- Uploads: failure kind + backoff, soft retry on resume/online/renew; request JSON checked before create and
  deduped by stem; library fixed per stem at share time (`perch.up.lib`); 45 s stall watchdog on PUT and API calls.
- Auth: `WRITE_KEY` follows the scope Google returned; a frame timeout is not a frame failure; offline with an
  expired token shows "Offline · saved library" and renews on `online`.
- Sync: a missing `.info`/`metadata.json` is retried after 10 min instead of skipped for good; a sync finishing
  while the viewer is open is applied on close (`S.snapLater`); snapshot written to IndexedDB only when changed.
- `navigator.storage.persist()` at boot.

Viewer / touch (viewer.js, grid.js, css): track springs home after an interrupted swipe; close maps to the tile
by id and the grid keeps its place by item id; cancelled dismiss doesn't start a paused video; "This format can't
play on the phone" for decode errors; unknown-size videos use `it.ratio` and `object-fit: contain`; pointercancel
is not a tap; video pauses when hidden; next video starts within 2 px of the swipe target; one seek in flight
while scrubbing; prefetch one at a time after `canplaythrough` (the service worker answers a prefetch only when
the file is cached).

Tests live outside the repo (session scratch): `run.sh` runs batch A (19), v13 delete (20), v11, v10, v9;
`runb.sh` runs 39 touch checks. None of this has run on the real phone yet.

## v14 — quick share

Sharing a link to Perch (Instagram, YouTube…) no longer leaves the person inside Perch. `js/quick.js` shows a one-line
card ("Saving to Eagle…" → "Downloading on your phone ✓" / "Saved for your computer ✓"), hands the link on, and
`main.js` (`quickShareAndClose`) calls `window.close()` ~900 ms later so Android returns to the app the link came from.
Links only; shared files keep the old flow. The link is queued first (`queuePut`) and leaves the queue only after the
bridge accepted it or the link is saved.

- Paired + bridge version ≥ 2 (`/ping` has `upload: true`): `POST /download { url, upload: { token, expires, folder,
  library, from: 'Perch' } }` and `rememberJob`. Token = the current one if it has ≥ 10 min left, else a hidden-frame
  renew capped at 4 s; folder = the Perch Inbox id (`withInbox`, capped at 4 s). No usable token, no write scope or no
  library opened yet → no quick share (today's flow), so a video never waits unseen in the downloader.
- Not paired: `saveLink` (needs token + write scope), capped at 10 s.
- Signed out, no write scope where Google must be asked, bridge off or v1, any error: the card goes away and today's flow
  runs unchanged (the link is still in the queue). A v1 bridge also gets a note in the Phone downloader sheet:
  "Update the phone downloader: open Termux and type perch-update".
- If the page is still alive 400 ms after `window.close()` (blocked), Perch carries on quietly: a toast, no Save sheet;
  the watcher and the tiles work as before.
- Watcher (`pollJob`): job `upload.state` `done` → `uploadedByBridge` (forget job, `DELETE /job`, refresh pending: the tile
  comes from the inbox, never copied in); `waiting`/`uploading` → "Sending to Drive…" and keep polling; `failed`/`none`/absent
  → the old claim path (`copyIn` + uploader). Never both for one job.
- Bridge v2 (`bridge/perch-bridge.py`, API in `bridge/API.md`): keeps the token in memory only, uploads each file (resumable,
  8 MiB chunks) and writes the same `<stem>.json` request `saveFileRequest` writes, one upload at a time, retries with
  backoff, deletes the local files on `done`; on failure keeps only the files that didn't reach Drive and removes a video
  whose request JSON couldn't be written. Finished jobs nobody claims are kept 7 days (failed ones 24 h). `POST /job/<id>/upload` attaches or replaces the sign-in (also revives a failed
  upload). The daily updater also replaces the script itself (`py_compile` check, `.bak`, restart when idle), so later bridge
  changes need no `perch-update`. `PERCH_NO_UPDATE=1`, `PERCH_BASE`, `PERCH_DRIVE_BASE` (tests) are env switches.
- `sw.js` `VERSION = 'perch-v14'`; `js/quick.js` is in the shell list.

Tests (session scratch, `v14-quick/`): `run14.sh` runs `bridge14.py` (the real bridge, yt-dlp from a local HTTP server, a fake
Drive, in-process self-update) and `quick14.mjs` (Perch in headless Brave on the in-page mock Drive, mock bridge v2 and v1, a fake
auth page for the renew). `window.close()` itself can only be confirmed on the phone.

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

Plugin 1.4.0 (`perch-inbox.js`):
- Finds the inbox in every Drive root: macOS `~/Library/CloudStorage/GoogleDrive-*` (and the
  `~/<account> - Google Drive` alias, deduped by realpath), Windows drive letters D–Z one level down
  (so a localized "My Drive" works), and the user folder (mirror mode, `Google Drive\My Drive`).
  The user's library can live in a different Google account from the one Perch signs in with
  (the user's case: library in one account, Perch Inbox in another); both accounts must then be in Drive for desktop.
- Two computers on one library: each writes `computer-<host>.txt` (heartbeat, 2 min) and claims a
  request with `<stem>.claim-<host>.txt` before taking it. Alone → takes it at once; with a live peer
  on the same library → waits 60 s and the earliest claim wins. Claims expire after 10 min.
- A link request for a post that was also sent as a video is marked done ("Already sent from the phone").
- Copies uploads out with a stream; if Drive sends nothing for 2 min it backs off 3 min (not a failed try).
- Logs "Watching the phone inbox: …" or "Can't find the Perch Inbox folder…" in the plugin window.
- Tests that run the plugin must inject a fake `os.homedir()`/`env` and a path-guarded fs: on the dev Mac the
  real home contains the live inbox.

## Open items

- Confirm the background renew on the phone (no more "Refreshing…" flashes after an hour).
- Testing mode still forces a full reconnect every 7 days; "Publish app" (unverified) would lift that.
- A refresh-token backend (e.g. a free Cloudflare Worker holding the client secret) would remove
  hourly renewals entirely; not built.
- Dropbox support: agreed for after Drive, not started.
