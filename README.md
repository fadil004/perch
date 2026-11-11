# Perch

A minimal, read-only mobile viewer for an [Eagle](https://eagle.cool) reference library that lives in Google Drive.
It's a static PWA: install it from Safari/Chrome to the home screen and it behaves like an app. There's no server and no build step.

- Reads Eagle 4 libraries straight from Drive (`*.library` folders synced by Google Drive for desktop) and switches between several libraries.
- Masonry grid in 2 or 3 columns (pinch or **More → Columns**). The layout is exact before images load, placeholders use each item's dominant colour, and the grid is virtualized so thousands of items stay smooth.
- Folders tree with Eagle's folder colours and counts. *All* and *Uncategorized* views. Password folders stay hidden until unlocked.
- Search by name, tag, note, link or file type, with starred/recent tag chips.
- Fullscreen viewer:
  - shared-element open and close
  - swipe between items, swipe down to dismiss
  - pinch and double-tap zoom
  - MP4/MOV/WebM stream with seeking (no full download)
  - frame-by-frame stepping while paused (the frame rate is measured from the video itself)
  - a rotate button for landscape media: real orientation lock on Android/Chrome (works with the system rotation lock on), a 90° CSS rotation elsewhere
  - GIFs animate
  - Vimeo/YouTube links embed
  - an info sheet with palette (tap to copy hex), tags, folders, source and notes
- Cache-first: opens instantly from IndexedDB, works offline with the last synced library, and syncs in the background (pull to refresh).

## Files

```
index.html, manifest.webmanifest, sw.js, config.js
css/app.css
js/main.js       screens, sync orchestration, folders/search/more sheets
js/eagle.js      library discovery, first + incremental sync, model (folders, counts, search)
js/drive.js      Drive v3 client (pagination, retries, concurrency limit; injectable backend)
js/mockdrive.js  in-browser Drive mock used by demo mode (same code path as production)
js/auth.js       Google OAuth (implicit flow, full-page redirect)
js/grid.js       virtualized masonry
js/viewer.js     fullscreen viewer, gestures, video controls, info sheet
js/framestep.js  frame-rate detection and exact one-frame stepping
js/sheet.js      bottom sheets      js/thumbs.js  thumbnail cache      js/store.js  IndexedDB + SW values
icons/           app icons (tools/make_icons.py)
demo/            synthetic Eagle libraries + manifest for demo mode
tools/           dev server and generators (Python 3 stdlib; MP4s via Swift/AVFoundation)
```

## Run locally

```bash
python3 tools/serve.py 8780
```

Open <http://localhost:8780>. The server supports HTTP Range so video seeking works.

**Demo mode** runs the real sync code against an in-browser mock of Drive:

| URL | What it does |
| --- | --- |
| `/?demo=1` | the bundled demo Drive (3 libraries) |
| `/?demo=1&scale=3000` | clones items to 3,000 for stress testing |
| `/?demo=1&mutate=1` | simulates 2 edited + 1 deleted item, to watch an incremental sync |
| `/?demo=1&latency=40` | sets the mock's network latency (ms) |
| `/?demo=<url-of-manifest.json>` | any other mock manifest |
| `/?install=ios\|ios-inapp\|android\|android-noprompt` | forces an "Install as app" variant (dev hosts only: `localhost`, `*.localhost`) |
| `/?rotate=css` | forces the CSS fallback of the rotate button (dev hosts only) |

To test against a copy of a real library without putting it in the app folder:

```bash
python3 tools/make_mock_manifest.py --url-prefix /__fixture/ --url-root /path/to/dir /path/to/dir/My.library /path/to/dir/manifest.json
python3 tools/serve.py 8780 --mount /__fixture=/path/to/dir
# then open /?demo=/__fixture/manifest.json
```

To regenerate the demo data: `python3 tools/make_demo_library.py`, then `python3 tools/make_mock_manifest.py demo/Demo.library demo/Archive.library demo/Sketches.library demo/manifest.json`.

## Connect Google Drive (one-time, about 10 minutes)

Perch talks to Drive from the phone with your own Google OAuth client. Nothing goes through a third-party server.

1. Open <https://console.cloud.google.com/> and create a project (any name, e.g. "Perch").
2. Enable the API: **APIs & Services → Library → Google Drive API → Enable**.
3. Configure the consent screen: **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding / Audience / Data access**).
   - User type **External**, app name "Perch", your email as support/developer contact.
   - Under **Audience → Test users**, add the Google account that owns the Drive with your Eagle library.
   - Under **Data access**, add the scope `https://www.googleapis.com/auth/drive.readonly`.
   - Leave the app in **Testing**. Google will show an "unverified app" notice the first time: choose *Continue*.
4. Create the client: **Credentials (Clients) → Create credentials → OAuth client ID → Web application**.
   - **Authorized JavaScript origins:**
     - `http://localhost:8780`
     - your hosted origin, e.g. `https://YOUR-USER.github.io`
   - **Authorized redirect URIs.** These must match exactly, trailing slash included:
     - `http://localhost:8780/`
     - your hosted app URL, e.g. `https://YOUR-USER.github.io/perch/`
5. Copy the client ID into `config.js`:
   ```js
   export const GOOGLE_CLIENT_ID = "1234567890-abc….apps.googleusercontent.com";
   ```
6. Open the app and tap **Connect Google Drive**. Perch finds every `*.library` folder in that Drive. If yours sits in a shared folder, use **Paste a folder link**.

The first sync reads every item's `metadata.json` (about 1–2 minutes for a few thousand items). After that, Perch only diffs Eagle's `mtime.json` and fetches what changed.

## Deploy to GitHub Pages

1. Create a repository (e.g. `perch`) and push the contents of this folder to it. `index.html` must be at the repo root.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. After a minute the app is live at `https://YOUR-USER.github.io/perch/`. Add that origin and URL to the OAuth client (step 4 above).
4. On the phone, open the URL:
   - iPhone: Safari → Share → **Add to Home Screen**
   - Android: Chrome → ⋮ → **Install app**

Any static host works (Netlify, Cloudflare Pages, Vercel). It must be HTTPS, and the redirect URI must match the app URL.

**Bump `VERSION` in `sw.js` on every deploy** (e.g. `perch-v2` → `perch-v3`). Without the bump, installed phones keep serving old cached files.

How caching works: the app shell (page, scripts, `config.js`) is served from the cache at once and refreshed in the background (stale-while-revalidate), so the app opens instantly, also on the way back from Google. A deploy installs a new service worker that precaches the new files; the next launch runs them. On `localhost` everything is always fresh.

Videos: small files (≤ 30 MB) are kept whole in a media cache (LRU, 600 MB). The first play streams and fills the cache from the same download; replays and seeks then come from the phone, and the viewer asks for the next and previous videos ahead of time so swiping to them starts at once. Skipped on Data Saver and 2G.

## Save to Eagle (from the phone)

Two ways, both through **My Drive / Perch Inbox**, which the **Video Grabber** Eagle plugin (with its Perch inbox support) finds through Google Drive for desktop. Each item is a small JSON request; the plugin writes the outcome back into it and Perch shows it under **Recent**. Items go into the library that was open in Perch; if Eagle has another library open, they wait until that library is opened.

- **A video the phone already has** (no computer download): download it on the phone (e.g. with YTDLnis, a free yt-dlp app for Android), then share the file to **Perch**, or open **⋯ → Save to Eagle → Upload a video from this phone**. Perch uploads it to the inbox (resumable: a dropped connection or a closed app carries on from the last byte Drive has) and writes its request next to it. When Eagle opens, the plugin adds the file straight from the synced folder (tag `perch`) and removes it from the inbox.
- **A link:** share a video page to Perch or paste it. Video Grabber downloads it with yt-dlp the next time Eagle is open on the computer.

Notes:
- The first save asks Google once for `drive.file`: Perch can create files and see only the files it created. Reading the library stays `drive.readonly`.
- Shared files wait in the `perch-share` cache until they are in Drive, so nothing is lost if Perch closes mid-upload. Uploads only run while Perch is open.
- The share-sheet entry needs the app installed from Chrome (Android). After an update that changes it, removing and re-adding the app applies it at once (Chrome otherwise updates it within about a day).

## Phone downloader (Termux)

So one share is enough on Android: share a video link to Perch, the phone downloads it, you can watch it right away, and it goes to Drive and then into Eagle when the computer is on. A web page can't fetch videos from Instagram, TikTok or YouTube itself, so the download runs in **Termux** (a free Linux terminal app) with **yt-dlp** — the same downloader Video Grabber uses on the computer.

- `bridge/perch-bridge.py`: yt-dlp behind a tiny HTTP server on `127.0.0.1:47821`, usable only by Perch (origin check + a pairing token). API in `bridge/API.md`.
- `bridge/install.sh`: one command in Termux — `curl -fsSL https://fadil004.github.io/perch/bridge/install.sh | bash`. Installs Python, ffmpeg, Node (YouTube needs a JavaScript runtime) and yt-dlp, starts the downloader whenever Termux opens (and at boot with Termux:Boot), and opens Perch once to pair. Run it again (or `perch-update`) to update; yt-dlp also updates itself daily.
- Helper commands in Termux: `perch-start`, `perch-stop`, `perch-pair`, `perch-log`, `perch-update`.
- Chrome asks once to let Perch reach apps on the phone; allow it. Set Termux's battery use to Unrestricted so Android doesn't stop it.
- Signed-in posts (some Instagram, X, Facebook): add a cookies.txt in **Phone downloader → Add cookies file**. Cookies stay on the phone (`~/.perch/cookies.txt`).
- If the downloader is off or a download fails, Perch saves the link for the computer instead (Video Grabber downloads it when Eagle is open).

## Privacy and limits

- **Access:**
  - Scope is `drive.readonly`. The only writes are the inbox (`drive.file`, asked for the first time something is saved): Perch can only create files and see the ones it made. It never changes your library.
  - The OAuth token lives in this browser only: localStorage, plus the Cache API so the service worker can stream video.
  - Tokens expire after an hour and there is no refresh token. Perch renews silently (`prompt=none` with `login_hint` = the account's email, learned from Drive after sign-in) shortly before expiry, at launch, on resume when under 10 minutes are left, and after any 401 (the failed request is then retried). The renew runs in a hidden frame first, so the app stays on screen; where the frame can't see the Google session (third-party cookies blocked, e.g. iOS), it falls back to a page redirect that saves the screen state first (library, folder, search, scroll, open item, video time) and restores it after. At most one redirect attempt per 2 minutes. **Reconnect** only appears when Google says the user must act (`interaction_required`, `login_required`, `consent_required`, `account_selection_required`).
  - **Sign out** revokes the token and deletes all cached data on the device.
- **Folder passwords:** compared on-device against the value Eagle stores in `metadata.json`.
- **Not supported yet:** smart folders (their rules aren't evaluated).
- **Needs a real phone to confirm:** iOS standalone-mode behaviour (OAuth redirect inside the home-screen app, safe areas, inline video through the service worker).
