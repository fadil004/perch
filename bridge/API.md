# Perch bridge — phone downloader API

`perch-bridge.py` runs in Termux on the phone: yt-dlp behind a small HTTP server on
`http://127.0.0.1:47821`. Perch (in Chrome on the same phone) calls it to download a shared link
on the phone itself, then uploads the file to Drive like any other video from the phone.

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
{ "ok": true, "app": "perch-bridge", "version": 1, "ytdlp": "2026.10.22",
  "node": true, "ffmpeg": true, "busy": 0,
  "cookies": { "present": true, "count": 41, "sites": ["instagram.com", "x.com"],
               "source": "drive", "sourceTime": "2026-11-11T10:00:00Z", "updated": "2026-11-11T12:00:00Z" } }
```
`cookies.present` false → the other cookie fields are null/empty.

`POST /download` body `{ "url": "https://…" }` → `{ "id": "<job id>", "status": "queued" }`.
The same URL while a job for it is still active returns that job.

`GET /job/<id>` →
```json
{ "id": "…", "url": "…", "site": "instagram.com",
  "status": "queued | downloading | processing | done | error",
  "progress": 0.42, "downloaded": 1234567, "total": 2940000, "speed": 850000, "eta": 3,
  "title": "…", "usedCookies": true,
  "files": [ { "n": 0, "name": "Title [id].mp4", "size": 2940000, "type": "video/mp4" } ],
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

`DELETE /job/<id>` → `{ "ok": true }`. Deletes the files. Perch calls it once the files are safely
stored on the phone (stashed for upload). Unclaimed jobs are deleted after 24 hours.

`POST /cookies` body `{ "text": "<Netscape cookies.txt>", "source": "file", "sourceTime": "<ISO or ''>" }`
→ `{ "ok": true, "count": 41, "sites": ["instagram.com", …] }`. Replaces the stored cookies.
400 `bad` if no valid cookie line is found.

`DELETE /cookies` → `{ "ok": true }`.

## Cookies

The bridge uses the stored cookies for a link when they hold cookies for that site; when a download
fails with a login error and it didn't use cookies, it retries with them; when it fails with cookies,
it retries once without. Cookies only ever come from the phone itself: the user adds a cookies.txt
file in Perch (Phone downloader → Add cookies file), which Perch posts here. They are stored in
`~/.perch/cookies.txt` (mode 600) and never leave the phone.
