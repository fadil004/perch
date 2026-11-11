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

How caching works: the app page and `config.js` load network-first and fall back to the cache after 3 s or when offline, so a newly filled-in client ID arrives right away. Other files are served from cache and refreshed in the background (stale-while-revalidate). On `localhost` everything is always fresh.

## Privacy and limits

- **Access:**
  - Scope is `drive.readonly`. Perch never writes to Drive or Eagle.
  - The OAuth token lives in this browser only: localStorage, plus the Cache API so the service worker can stream video.
  - Tokens expire after an hour and there is no refresh token. Perch renews silently (`prompt=none` with `login_hint` = the account's email, learned from Drive after sign-in) at launch, on resume when under 10 minutes are left, and after any 401. It saves the screen state first (library, folder, search, scroll, open item, video time) and restores it after the redirect. At most one silent attempt per 2 minutes. **Reconnect** only appears when Google says the user must act (`interaction_required`, `login_required`, `consent_required`, `account_selection_required`).
  - **Sign out** revokes the token and deletes all cached data on the device.
- **Folder passwords:** compared on-device against the value Eagle stores in `metadata.json`.
- **Not supported yet:** smart folders (their rules aren't evaluated).
- **Needs a real phone to confirm:** iOS standalone-mode behaviour (OAuth redirect inside the home-screen app, safe areas, inline video through the service worker).
