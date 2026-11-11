#!/usr/bin/env python3
"""Perch phone downloader ("bridge").

yt-dlp behind a small HTTP server on 127.0.0.1, so Perch (in Chrome on the same phone) can download a
shared link on the phone itself. Runs in Termux; runs on a computer too, for testing.
The API is described in bridge/API.md next to this file.

Environment (all optional):
  PERCH_PORT        port (47821)
  PERCH_HOME        data folder (~/.perch): token, cookies, downloads
  PERCH_ORIGINS     extra allowed browser origins, comma-separated (development)
  PERCH_FFMPEG      path to ffmpeg when it isn't on PATH
  PERCH_NO_UPDATE   1 = don't update yt-dlp in the background
"""
import http.server
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid

VERSION = 1
PORT = int(os.environ.get('PERCH_PORT') or 47821)
HOME = os.path.expanduser(os.environ.get('PERCH_HOME') or '~/.perch')
DOWNLOADS = os.path.join(HOME, 'downloads')
TOKEN_FILE = os.path.join(HOME, 'token')
COOKIES = os.path.join(HOME, 'cookies.txt')
COOKIES_META = os.path.join(HOME, 'cookies.json')
ORIGINS = {'https://fadil004.github.io'} | {
    o.strip().rstrip('/') for o in (os.environ.get('PERCH_ORIGINS') or '').split(',') if o.strip()}
MAX_FILES = 10            # a post/carousel gives at most this many files
KEEP_SECONDS = 24 * 3600  # unclaimed downloads are deleted after a day
MAX_PARALLEL = 2
MAX_BODY = 4 * 1024 * 1024
UPDATE_EVERY = 24 * 3600

# Same choices as Video Grabber on the computer: social sites serve combined streams, the rest is
# merged up to 1080p. Within a resolution prefer H.264/AAC in MP4, which plays everywhere (phone, Eagle).
SOCIAL = re.compile(r'(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|threads\.net|threads\.com)$', re.I)
FORMAT_SOCIAL = 'best[ext=mp4]/best/bestvideo+bestaudio'
FORMAT_OTHER = ('bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/'
                'best[height<=1080][ext=mp4]/best[height<=1080]/best')
FORMAT_SORT = ['res:1080', 'vcodec:h264', 'acodec:aac', 'ext:mp4:m4a']
# TikTok often has 1080p only as HEVC next to a 720p H.264 at a higher bitrate: take the H.264 one.
FORMAT_SORT_SOCIAL = ['vcodec:h264', 'res:1080', 'acodec:aac', 'ext:mp4:m4a']

ALIASES = {
    'youtu.be': 'youtube.com', 'fb.watch': 'facebook.com', 'twitter.com': 'x.com', 'instagr.am': 'instagram.com',
    'threads.com': 'threads.net', 'pin.it': 'pinterest.com', 'redd.it': 'reddit.com', 'vm.tiktok.com': 'tiktok.com',
}

MESSAGES = {
    'login': 'This video needs you to be signed in. Add cookies in Perch → Phone downloader.',
    'unsupported': 'This site or link isn’t supported.',
    'unavailable': 'The video is private, removed or not available here.',
    'novideo': 'There’s no video in this post.',
    'network': 'Network problem — check the connection and try again.',
    'nofile': 'Nothing was downloaded.',
}

lock = threading.RLock()
jobs = {}
slots = threading.Semaphore(MAX_PARALLEL)
TOKEN = ''


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def now_iso(t=None):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t if t is not None else time.time()))


# ── sites and cookies ─────────────────────────────────────────────────────────

def registrable(host):
    host = (host or '').lower().strip('.')
    host = re.sub(r'^(www|m|mobile|vm|vt)\.', '', host)
    if host in ALIASES:
        return ALIASES[host]
    parts = host.split('.')
    base = '.'.join(parts[-3:]) if len(parts) >= 3 and len(parts[-2]) <= 3 and len(parts[-1]) == 2 else '.'.join(parts[-2:])
    return ALIASES.get(base, base)


def site_of(url):
    try:
        return registrable(urllib.parse.urlsplit(url).hostname or '')
    except ValueError:
        return ''


def parse_cookies(text):
    """Netscape cookies.txt → (clean text, set of sites). Ignores anything that isn't a cookie line."""
    out = ['# Netscape HTTP Cookie File', '# Stored by Perch bridge', '']
    sites = set()
    for raw in (text or '').replace('\r', '').split('\n'):
        line = raw.strip('﻿')
        if not line or (line.startswith('#') and not line.startswith('#HttpOnly_')):
            continue
        f = line.split('\t')
        if len(f) != 7 or not f[0] or not f[5]:
            continue
        domain = f[0][len('#HttpOnly_'):] if f[0].startswith('#HttpOnly_') else f[0]
        sites.add(registrable(domain))
        out.append(line)
    return '\n'.join(out) + '\n', sites


def cookie_info():
    try:
        with open(COOKIES_META) as fh:
            meta = json.load(fh)
        if os.path.getsize(COOKIES) > 0:
            return meta
    except (OSError, ValueError):
        pass
    return None


def cookie_sites():
    meta = cookie_info()
    return set(meta.get('sites') or []) if meta else set()


# ── downloads ────────────────────────────────────────────────────────────────

def classify(msg):
    m = (msg or '').lower()
    if 'unsupported url' in m or 'no suitable extractor' in m:
        return 'novideo' if re.search(r'tiktok\.com/@[^/\s]*/photo/', m) else 'unsupported'   # TikTok photo posts
    if re.search(r'no video (formats|in this|could be found)|there is no video|no media found|does not contain (a )?video', m):
        return 'novideo'
    if re.search(r'tls fingerprint|impersonat', m):   # wants curl_cffi ("…security/cookies…" isn't a login problem)
        return 'unknown'
    if 'private video' in m:   # YouTube: "Private video. … please sign in. Use --cookies …"
        return 'unavailable'
    if re.search(r'log ?in|sign ?in|cookies|authenticat|not a bot|rate-limit reached|age-restricted|confirm your age|nsfw', m):
        return 'login'
    if re.search(r'private|unavailable|not available|removed|deleted|does not exist|no longer|blocked|404|geo|region|copyright|terminated', m):
        return 'unavailable'
    if re.search(r'timed? ?out|connection|network|name resolution|temporary failure|unreachable|ssl|'
                 r'nodename nor servname|name or service not known|no address associated', m):
        return 'network'
    return 'unknown'


def friendly(code, msg):
    if code in MESSAGES:
        return MESSAGES[code]
    m = (msg or '').lower()
    if re.search(r'tls fingerprint|impersonat', m):
        return 'This site blocks the phone downloader.'
    if 'drm protected' in m:
        return 'This video is DRM-protected and can’t be downloaded.'
    if 'ffmpeg is not installed' in m or 'ffmpeg not found' in m:
        return 'ffmpeg is missing on the phone. Run the Perch installer again.'
    if 'unable to extract' in m or 'please report this issue' in m:   # the site changed; a yt-dlp update usually fixes it
        return 'Couldn’t read this page (the site may have changed). Try again later.'
    http = re.search(r'HTTP Error (\d{3})', msg or '')
    if http:
        return 'The site refused the download (HTTP %s).' % http.group(1)
    line = re.sub(r'^\s*ERROR:\s*', '', (msg or 'Download failed').strip().split('\n')[0])
    line = re.sub(r'\[[\w:]+\]\s*[\w-]+:\s*', '', line)   # "[Instagram] abc123: " prefixes
    line = re.sub(r'\s*\(caused by .*$', '', line)
    return line[:200] or 'Download failed'


def tidy_title(t):
    """Facebook and Instagram put counters in front of titles ("9.9K views · 340 reactions | …")."""
    t = re.sub(r'^\s*([\d.,]+[KMB]?\s+(views?|reactions?|likes?|comments?|shares?|plays?)\s*[·|•-]\s*)+', '', t or '', flags=re.I)
    t = re.sub(r'^\s*[|·•-]\s*', '', t)
    return t.strip()[:150]


def public(job):
    keys = ('id', 'url', 'site', 'status', 'progress', 'downloaded', 'total', 'speed', 'eta', 'title',
            'usedCookies', 'files', 'error', 'code')
    return {k: job.get(k) for k in keys}


def save_meta(job):
    try:
        with open(os.path.join(job['dir'], 'meta.json'), 'w') as fh:
            json.dump({k: v for k, v in job.items() if k not in ('cancel', 'parts')}, fh)
    except OSError:
        pass


def tools():
    ffmpeg = os.environ.get('PERCH_FFMPEG') or shutil.which('ffmpeg')
    node = shutil.which('node')
    return ffmpeg, node


def options(job, use_cookies, hook, pphook):
    ffmpeg, node = tools()
    social = bool(SOCIAL.search(job['site'] or ''))
    opts = {
        'outtmpl': os.path.join(job['dir'], '%(title).70B [%(id)s].%(ext)s'),
        'format': FORMAT_SOCIAL if social else FORMAT_OTHER,
        'format_sort': FORMAT_SORT_SOCIAL if social else FORMAT_SORT,
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'playlistend': MAX_FILES,
        'windowsfilenames': True,   # the file ends up on a Windows PC too (title is capped in outtmpl)
        'concurrent_fragment_downloads': 8,
        'retries': 3,
        'fragment_retries': 3,
        'socket_timeout': 30,
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,
        'progress_hooks': [hook],
        'postprocessor_hooks': [pphook],
    }
    if ffmpeg:
        opts['ffmpeg_location'] = ffmpeg
    if node:
        opts['js_runtimes'] = {'node': {'path': node}}   # YouTube needs a JavaScript runtime
    if use_cookies:
        opts['cookiefile'] = COOKIES
    if job['site'] == 'vimeo.com':
        opts['http_headers'] = {'Referer': 'https://vimeo.com/'}   # the player embed checks it
    return opts


def vimeo_player(url):
    """vimeo.com/<id>[/<hash>] → https://player.vimeo.com/video/<id>[?h=<hash>] (None for other links)."""
    if not re.search(r'(^|[/.])vimeo\.com/', url or '', re.I) or re.search(r'player\.vimeo\.com', url, re.I):
        return None
    m = (re.search(r'vimeo\.com/.*?/videos?/(\d+)()', url, re.I) or   # groups/…/videos/<id>, showcase/…/video/<id>
         re.search(r'vimeo\.com/(?:[a-z][\w-]*/)*?(\d+)(?:/([0-9a-f]{6,}))?(?=[/?#]|$)', url, re.I))
    return m and 'https://player.vimeo.com/video/%s%s' % (m.group(1), '?h=' + m.group(2) if m.group(2) else '')


def vimeo_login_error(msg):   # same test as Video Grabber's isVimeoLoginError
    return bool(re.search(r'vimeo', msg or '', re.I) and re.search(
        r'only works when logged.?in|OAuth token|HTTP Error 40[13]|\bUnauthorized\b|requires? (a )?(login|account|sign.?in)', msg, re.I))


class Cancelled(Exception):
    pass


def files_in(folder):
    out = []
    for name in sorted(os.listdir(folder), key=lambda n: os.path.getmtime(os.path.join(folder, n))):
        p = os.path.join(folder, name)
        if name == 'meta.json' or name.startswith('.') or not os.path.isfile(p):
            continue
        if re.search(r'\.(part|ytdl|temp|tmp)$|\.part-Frag\d+|\.f\d+\.\w+$', name):
            continue
        out.append(name)
    return out[:MAX_FILES]


def attempt(job, use_cookies, url=None):
    import yt_dlp
    job['parts'] = {}

    def hook(d):
        if job.get('cancel'):
            raise Cancelled()
        if d.get('status') == 'downloading':
            fn = d.get('filename') or d.get('tmpfilename') or '?'
            done = d.get('downloaded_bytes') or 0
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            job['parts'][fn] = (done, total)
            tot = sum(t for _, t in job['parts'].values())
            got = sum(b for b, _ in job['parts'].values())
            with lock:
                job['status'] = 'downloading'
                job['downloaded'] = got
                job['total'] = int(tot) if tot else None
                if tot:   # never backwards (the audio part starts after the video one), 100% only when done
                    job['progress'] = max(job.get('progress') or 0, round(min(0.99, got / tot), 3))
                job['speed'] = int(d['speed']) if d.get('speed') else None
                job['eta'] = int(d['eta']) if d.get('eta') is not None else None
                info = d.get('info_dict') or {}
                if info.get('title') and not job.get('title'):
                    job['title'] = info['title']

    def pphook(d):
        if d.get('status') == 'started':
            with lock:
                job['status'] = 'processing'

    with yt_dlp.YoutubeDL(options(job, use_cookies, hook, pphook)) as ydl:
        info = ydl.extract_info(url or job['url'], download=True)
    title = (info or {}).get('title') or ''
    if not title and info and info.get('entries'):
        first = next((e for e in info['entries'] if e), None)
        title = (first or {}).get('title') or ''
    return title


def run(job):
    with slots:
        if job.get('cancel'):
            return
        have = cookie_info() is not None
        plan = [job['site'] in cookie_sites()] if have else [False]
        last = None
        tried = set()
        first = via = None   # Vimeo: the error that sent us to the player embed, and the embed URL to try
        while plan:
            use = plan.pop(0)
            tried.add(use)
            url, via = via, None   # None = the job's own link (job['url'] always stays the original)
            if job.get('cancel'):   # deleted while a failed attempt was finishing
                return
            for name in os.listdir(job['dir']):   # leftovers of a failed attempt
                if name != 'meta.json':
                    try:
                        os.remove(os.path.join(job['dir'], name))
                    except OSError:
                        pass
            try:
                with lock:
                    job.update(status='downloading', usedCookies=use, progress=None, downloaded=0, total=None, speed=None, eta=None)
                log('download', job['id'], job['site'], 'with cookies' if use else 'without cookies', 'via ' + url if url else '')
                title = attempt(job, use, url)
                names = files_in(job['dir'])
                if not names:
                    raise RuntimeError('nofile')
                if all((mimetypes.guess_type(n)[0] or '').startswith('audio/') for n in names):
                    raise RuntimeError('There is no video in this page (audio only).')
                with lock:
                    job['files'] = [{'n': i, 'name': n, 'size': os.path.getsize(os.path.join(job['dir'], n)),
                                     'type': mimetypes.guess_type(n)[0] or 'application/octet-stream'} for i, n in enumerate(names)]
                    job['title'] = tidy_title(job.get('title') or title or os.path.splitext(names[0])[0])
                    job.update(status='done', progress=1.0, error='', code='', speed=None, eta=0)
                save_meta(job)
                log('done', job['id'], len(names), 'file(s)')
                return
            except Cancelled:
                log('cancelled', job['id'])
                return
            except Exception as e:   # yt-dlp raises DownloadError and friends
                msg = 'nofile' if str(e) == 'nofile' else str(e)
                code = 'nofile' if msg == 'nofile' else classify(msg)
                log('failed', job['id'], code, msg.split('\n')[0][:200])
                if url and 'drm' not in msg.lower():   # the player embed failed too: go on with the first error
                    code, msg = first
                last = (code, msg)
                if code in ('unsupported', 'novideo'):
                    break
                # Vimeo's site wants a login for everything now, but public (and unlisted, with the hash)
                # videos still play through the player embed, as in Video Grabber. Once, before the cookie retries.
                if first is None and vimeo_login_error(msg) and vimeo_player(job['url']):
                    first, via = last, vimeo_player(job['url'])
                    plan.insert(0, use)
                    continue
                # Signed-in content: try the stored cookies; failing with cookies: try once without.
                # At most one attempt each way (it used to bounce with/without up to four times).
                if not plan and have:
                    if not use and code == 'login' and True not in tried:
                        plan.append(True)
                    elif use and False not in tried:
                        plan.append(False)
        code, msg = last or ('unknown', '')
        with lock:
            job.update(status='error', code=code, error=friendly(code, msg), speed=None, eta=None)
        save_meta(job)


def start_job(url):
    site = site_of(url)
    with lock:
        for j in jobs.values():
            if j['url'] == url and j['status'] in ('queued', 'downloading', 'processing'):
                return j
        jid = uuid.uuid4().hex[:12]
        job = {'id': jid, 'url': url, 'site': site, 'status': 'queued', 'progress': None, 'downloaded': 0,
               'total': None, 'speed': None, 'eta': None, 'title': '', 'usedCookies': False, 'files': [],
               'error': '', 'code': '', 'created': time.time(), 'dir': os.path.join(DOWNLOADS, jid)}
        os.makedirs(job['dir'], exist_ok=True)
        jobs[jid] = job
    threading.Thread(target=guarded, args=(run, job), daemon=True).start()
    return job


def guarded(fn, *a):
    try:
        fn(*a)
    except Exception:
        traceback.print_exc()
        job = a[0] if a else None
        if isinstance(job, dict) and 'status' in job:
            with lock:
                job.update(status='error', code='unknown', error='The downloader hit an error.')


def drop_job(jid):
    with lock:
        job = jobs.pop(jid, None)
    if not job:
        return False
    job['cancel'] = True
    shutil.rmtree(job['dir'], ignore_errors=True)
    return True


def busy():
    with lock:
        return sum(1 for j in jobs.values() if j['status'] in ('queued', 'downloading', 'processing'))


def housekeeping():
    """Delete what nobody picked up; bring back finished jobs after a restart."""
    os.makedirs(DOWNLOADS, exist_ok=True)
    cutoff = time.time() - KEEP_SECONDS
    for jid in os.listdir(DOWNLOADS):
        d = os.path.join(DOWNLOADS, jid)
        if not os.path.isdir(d):
            continue
        with lock:
            known = jobs.get(jid)
        if known:
            if known['created'] < cutoff and known['status'] in ('done', 'error'):
                drop_job(jid)
            continue
        meta = None
        try:
            with open(os.path.join(d, 'meta.json')) as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            pass
        if meta and meta.get('status') == 'done' and meta.get('created', 0) > cutoff and meta.get('id') == jid:
            meta['dir'] = d
            with lock:
                jobs[jid] = meta
        elif os.path.getmtime(d) < time.time() - 600:
            shutil.rmtree(d, ignore_errors=True)


# ── yt-dlp updates (sites change; a day-old yt-dlp is usually fine, a month-old one often isn't) ──

def ytdlp_version():
    try:
        from importlib.metadata import version
        return version('yt-dlp')
    except Exception:
        try:
            import yt_dlp.version
            return yt_dlp.version.__version__
        except Exception:
            return ''


def updater():
    if os.environ.get('PERCH_NO_UPDATE') == '1':
        return
    time.sleep(30)
    while True:
        before = ytdlp_version()
        cmd = [sys.executable, '-m', 'pip', 'install', '-U', '--quiet', '--disable-pip-version-check', 'yt-dlp', 'yt-dlp-ejs']
        ok = subprocess.run(cmd, capture_output=True).returncode == 0
        if not ok:
            ok = subprocess.run(cmd + ['--break-system-packages'], capture_output=True).returncode == 0
        after = subprocess.run([sys.executable, '-c', 'from importlib.metadata import version; print(version("yt-dlp"))'],
                               capture_output=True, text=True).stdout.strip()
        if ok and after and after != before:
            log('yt-dlp updated', before, '→', after, '— restarting when idle')
            while busy():
                time.sleep(5)
            os.execv(sys.executable, [sys.executable] + sys.argv)
        time.sleep(UPDATE_EVERY)


def janitor():
    while True:
        time.sleep(1800)
        try:
            housekeeping()
        except Exception:
            traceback.print_exc()


# ── HTTP ─────────────────────────────────────────────────────────────────────

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'PerchBridge/%d' % VERSION
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):   # quiet by default; PERCH_DEBUG=1 logs requests (never tokens)
        if os.environ.get('PERCH_DEBUG') == '1':
            log(self.command, urllib.parse.urlsplit(self.path).path, self.headers.get('Origin') or '-', args[1] if len(args) > 1 else '')

    def cors(self):
        origin = self.headers.get('Origin')
        if origin and origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition')

    def reply(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def fail(self, status, code, message):
        self.reply(status, {'error': message, 'code': code})

    def allowed(self):
        origin = self.headers.get('Origin')
        if origin and origin not in ORIGINS:
            self.fail(403, 'origin', 'This site may not use the Perch downloader.')
            return False
        given = self.headers.get('X-Perch-Token') or ''
        if not TOKEN or not secrets.compare_digest(given.encode(), TOKEN.encode()):
            self.fail(401, 'auth', 'Perch isn’t paired with this downloader.')
            return False
        return True

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            self.close_connection = True   # the unread body would otherwise be taken for the next request
            raise ValueError('too large')
        raw = self.rfile.read(n) if n else b''
        data = json.loads(raw.decode('utf-8') or '{}')
        if not isinstance(data, dict):   # [1,2] or "x" used to drop the connection (AttributeError on .get)
            raise ValueError('not an object')
        return data

    def do_OPTIONS(self):
        origin = self.headers.get('Origin')
        if not origin or origin not in ORIGINS:
            self.send_response(403)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Perch-Token, Content-Type, Range')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def route(self):
        return [p for p in urllib.parse.urlsplit(self.path).path.split('/') if p]

    def do_GET(self):
        if not self.allowed():
            return
        r = self.route()
        if r == ['ping']:
            ffmpeg, node = tools()
            meta = cookie_info()
            cookies = {'present': bool(meta), 'count': (meta or {}).get('count', 0), 'sites': sorted((meta or {}).get('sites') or []),
                       'source': (meta or {}).get('source'), 'sourceTime': (meta or {}).get('sourceTime'), 'updated': (meta or {}).get('updated')}
            return self.reply(200, {'ok': True, 'app': 'perch-bridge', 'version': VERSION, 'ytdlp': ytdlp_version(),
                                    'node': bool(node), 'ffmpeg': bool(ffmpeg), 'busy': busy(), 'cookies': cookies})
        if len(r) == 2 and r[0] == 'job':
            with lock:
                job = jobs.get(r[1])
                data = public(job) if job else None
            return self.reply(200, data) if data else self.fail(404, 'notfound', 'No such download.')
        if len(r) == 3 and r[0] == 'file' and r[2].isdigit():
            return self.send_file(r[1], int(r[2]))
        self.fail(404, 'notfound', 'Not found.')

    def do_POST(self):
        if not self.allowed():
            return
        r = self.route()
        try:
            data = self.body()
        except (ValueError, UnicodeDecodeError):
            return self.fail(400, 'bad', 'Send JSON.')
        if r == ['download']:
            url = str(data.get('url') or '').strip()
            if not re.match(r'^https?://[^\s/]+\.[^\s]+$', url, re.I) or len(url) > 2000:
                return self.fail(400, 'bad', 'That doesn’t look like a link.')
            job = start_job(url)
            return self.reply(200, {'id': job['id'], 'status': job['status']})
        if r == ['cookies']:
            text, sites = parse_cookies(str(data.get('text') or ''))
            count = text.count('\n') - 3
            if count <= 0:
                return self.fail(400, 'bad', 'No cookies found in that file.')
            os.makedirs(HOME, exist_ok=True)
            tmp = COOKIES + '.new'
            with open(tmp, 'w') as fh:
                fh.write(text)
            os.chmod(tmp, 0o600)
            os.replace(tmp, COOKIES)
            meta = {'count': count, 'sites': sorted(s for s in sites if s), 'source': data.get('source') or 'file',
                    'sourceTime': data.get('sourceTime') or '', 'updated': now_iso()}
            with open(COOKIES_META, 'w') as fh:
                json.dump(meta, fh)
            log('cookies stored:', count, 'for', ', '.join(meta['sites'][:8]))
            return self.reply(200, {'ok': True, 'count': count, 'sites': meta['sites']})
        self.fail(404, 'notfound', 'Not found.')

    def do_DELETE(self):
        if not self.allowed():
            return
        r = self.route()
        if len(r) == 2 and r[0] == 'job':
            drop_job(r[1])
            return self.reply(200, {'ok': True})
        if r == ['cookies']:
            for p in (COOKIES, COOKIES_META):
                try:
                    os.remove(p)
                except OSError:
                    pass
            return self.reply(200, {'ok': True})
        self.fail(404, 'notfound', 'Not found.')

    def send_file(self, jid, n):
        with lock:
            job = jobs.get(jid)
            f = job['files'][n] if job and job.get('status') == 'done' and n < len(job.get('files') or []) else None
        if not f:
            return self.fail(404, 'notfound', 'No such file.')
        path = os.path.join(job['dir'], os.path.basename(f['name']))
        try:
            size = os.path.getsize(path)
        except OSError:
            return self.fail(404, 'notfound', 'The file is gone.')
        start, end = 0, size - 1
        rng = re.match(r'^bytes=(\d*)-(\d*)$', self.headers.get('Range') or '')
        partial = False
        if rng and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start = int(rng.group(1))
                end = min(int(rng.group(2)), size - 1) if rng.group(2) else size - 1
            else:
                start = max(0, size - int(rng.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.cors()
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            partial = True
        self.send_response(206 if partial else 200)
        self.cors()
        self.send_header('Content-Type', f['type'])
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + urllib.parse.quote(f['name']))
        self.send_header('Cache-Control', 'no-store')
        if partial:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        try:
            with open(path, 'rb') as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(262144, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def load_token():
    os.makedirs(HOME, exist_ok=True)
    try:
        with open(TOKEN_FILE) as fh:
            t = fh.read().strip()
        if len(t) >= 16:
            return t
    except OSError:
        pass
    t = secrets.token_urlsafe(24)
    with open(TOKEN_FILE, 'w') as fh:
        fh.write(t + '\n')
    os.chmod(TOKEN_FILE, 0o600)
    return t


def main():
    global TOKEN
    TOKEN = load_token()
    housekeeping()
    try:
        httpd = Server(('127.0.0.1', PORT), Handler)
    except OSError as e:
        log('Port', PORT, 'is busy — is the Perch downloader already running?', e)
        sys.exit(1)
    ffmpeg, node = tools()
    log('Perch downloader ready on 127.0.0.1:%d · yt-dlp %s · ffmpeg %s · node %s'
        % (PORT, ytdlp_version() or 'missing', 'yes' if ffmpeg else 'no', 'yes' if node else 'no'))
    threading.Thread(target=updater, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
