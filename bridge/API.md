# Perch bridge — phone downloader API

`perch-bridge.py` runs in Termux on the phone: yt-dlp behind a small HTTP server on
`http://127.0.0.1:47821`. Perch (in Chrome on the same phone) calls it to download a shared link
on the phone itself. Version 1: Perch copies the file and uploads it to Drive like any other video
from the phone. Version 2: Perch can also hand over a short-lived Drive token, and the bridge uploads the
file and its request JSON to the "Perch Inbox" folder itself, so Perch doesn't have to stay open (see "Upload").

## Access

- Listens on 127.0.0.1 only.
- Every request except `OPTIONS` needs the header `X-Perch-Token: <token>`. The token is made by
  the installer and handed to Perch once through `https://fadil004.github.io/perch/#bridge=<token>`
  (Perch saves it in localStorage `perch.bridge` as `{ token }` and strips the hash).
- Browser requests must come from an allowed origin (`https://fadil004.github.io`, plus any in
  `PERCH_ORIGINS`, comma-separated, for development). Others get 403.
- CORS: `Access-Control-Allow-Origin: <origin>`, allowed headers `X-Perch-Token, Content-Type, Range`,
  methods `GET, POST, DELETE, OPTIONS`, exposed `Content-Length, Content-Range, Content-Disposition`,
  and `Access-Control-Allow-Private-Network: true` on preflights.
- Chrome asks the user once to let the site reach this device (loopback network permission).

Errors: JSON `{ "error": "<message for people>", "code": "<code>" }` with a 4xx/5xx status.
Codes: `auth` (401 bad/missing token), `origin` (403), `notfound` (404), `bad` (400).

## Endpoints

`GET /ping` →
```json
{ "ok": true, "app": "perch-bridge", "version": 2, "upload": true, "ytdlp": "2026.10.22",
  "node": true, "ffmpeg": true, "busy": 0,
  "cookies": { "present": true, "count": 41, "sites": ["instagram.com", "x.com"],
               "source": "drive", "sourceTime": "2026-11-11T10:00:00Z", "updated": "2026-11-11T12:00:00Z" } }
```
`cookies.present` false → the other cookie fields are null/empty.
`version` ≥ 2 and `upload: true` → the bridge can upload to Drive. Version 1 has neither field.

`POST /download` body `{ "url": "https://…", "upload": { … } }` → `{ "id": "<job id>", "status": "queued" }`.
`upload` is optional (see "Upload"); an `upload` that can't be used is 400 `bad`, one that has already expired
is ignored. The same URL while a job for it is still active returns that job (and gets the `upload`, if it had none).

`GET /job/<id>` →
```json
{ "id": "…", "url": "…", "site": "instagram.com",
  "status": "queued | downloading | processing | done | error",
  "progress": 0.42, "downloaded": 1234567, "total": 2940000, "speed": 850000, "eta": 3,
  "title": "…", "usedCookies": true,
  "files": [ { "n": 0, "name": "Title [id].mp4", "size": 2940000, "type": "video/mp4" } ],
  "upload": { "state": "none", "progress": null, "stems": [], "error": "" },
  "error": "", "code": "" }
```
- `progress`/`total`/`speed`/`eta` may be null when unknown. `progress` never goes down and stays below 1
  until `done`. `processing` = merging/remuxing.
- `files` is filled when `status` is `done` (a carousel/post can give several files, at most 10).
- Job error codes: `login` (needs cookies/login), `unsupported` (site or link not supported),
  `unavailable` (private, removed, region-locked), `novideo` (post has no video, or only audio), `network`,
  `nofile` (yt-dlp finished without a file), `unknown`.
  `error` is a short sentence for people.

`GET /file/<id>/<n>` → the file. Supports `Range` (206). `Content-Type` from the extension,
`Content-Disposition: attachment; filename*=UTF-8''<name>`.

`POST /job/<id>/upload` body = the `upload` object (or `{ "upload": { … } }`) → `{ "ok": true, "upload": { …state… } }`.
Attaches (or replaces) the Drive sign-in of a job that was started without one, or whose upload failed (it tries
again with what is left). 404 `notfound` for an unknown job, 400 `bad` for unusable details or a failed download.

`DELETE /job/<id>` → `{ "ok": true }`. Deletes the files. Perch calls it once the files are safely
stored on the phone (stashed for upload). Finished jobs nobody claims are deleted after 7 days, failed ones after 24 hours.

`POST /cookies` body `{ "text": "<Netscape cookies.txt>", "source": "file", "sourceTime": "<ISO or ''>" }`
→ `{ "ok": true, "count": 41, "sites": ["instagram.com", …] }`. Replaces the stored cookies.
400 `bad` if no valid cookie line is found.

`DELETE /cookies` → `{ "ok": true }`.

## Upload (version 2)

`upload` object: `{ "token": "<Drive access token>", "expires": <ms since epoch>, "folder": "<Perch Inbox folder id>",
"library": "<library name>", "from": "Perch" }`. Perch sends it when it holds a token that is good for at least
10 more minutes and may write to Drive (`drive.file`). Without it the bridge only downloads, and Perch copies the
file in the next time it opens, as in version 1.

- The sign-in is kept in memory only: never written to disk (not in `meta.json`), never logged (anything
  logged is scrubbed of it). It is dropped when the job's uploads end (`done` or `failed`), at `expires`, or when the job is deleted.
- When the download is done, each file in order: a Drive resumable upload (`uploadType=resumable`, 8 MiB chunks,
  metadata `{ name: "<stem>.<ext>", parents: [folder] }`), then `<stem>.json`, the same request
  `saveFileRequest` in `js/inbox.js` writes (`v`, `kind: "file"`, `file`, `name`, `size`, `mimeType`, `url` = the
  shared link, `library` without `.library`, `sentAt`, `from`, `status: "pending"`). `<stem>` = 13-digit ms + `-` + 6 chars
  `[a-z0-9]`, the ms rising per file. One upload at a time (across jobs). Network errors and 429/5xx are retried
  with backoff (2, 5, 15, 45, 90 s) and a cut connection continues from the byte Drive has.
- Job JSON field `upload`: `state` is `none` (no sign-in), `waiting` (sign-in held, file not uploaded yet), `uploading`
  (`progress` 0–1 over all files), `done` (the local files are deleted; the job record stays 7 days, like any finished job)
  or `failed` (`error` says why). `stems` lists the files delivered so far.
- Failure (401/403, sign-in expired, retries used up): `failed`, and the files that didn't reach Drive stay on the
  phone (renumbered `n` from 0), so Perch's fallback (copy in + its own uploader) sends exactly those. A file that
  reached Drive without its request JSON is removed from Drive again first (`files.delete`, same token), so the
  fallback never makes a duplicate. A restart of the bridge turns `waiting`/`uploading` into `failed` (the sign-in is gone).
- Env `PERCH_DRIVE_BASE` points the bridge at another Drive address (tests only).

## Self-update

Once a day (with the yt-dlp update) the bridge fetches `$PERCH_BASE/bridge/perch-bridge.py`. If it differs and
compiles (`py_compile`) it replaces itself atomically (the old one stays as `perch-bridge.py.bak`) and restarts when
nothing is downloading or uploading. `PERCH_NO_UPDATE=1` turns both updates off. After the first time
(`perch-update` on version 1), later bridge changes need no typing.

## Cookies

The bridge uses the stored cookies for a link when they hold cookies for that site; when a download
fails with a login error and it didn't use cookies, it retries with them; when it fails with cookies,
it retries once without. Cookies only ever come from the phone itself: the user adds a cookies.txt
file in Perch (Phone downloader → Add cookies file), which Perch posts here. They are stored in
`~/.perch/cookies.txt` (mode 600) and never leave the phone.
