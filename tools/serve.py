#!/usr/bin/env python3
"""Dev server for Perch: static files + HTTP Range (so <video> can seek) + optional dev-only mounts.

Usage:
  python3 tools/serve.py [port] [--mount /__fixture=/abs/path/to/dir ...]

Serves the perch/ folder (the parent of tools/). A mount maps a URL prefix to a folder outside the
app, so local test libraries can be served without ever being copied into the deployable folder.
"""
import os, re, sys, mimetypes, posixpath, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOUNTS = {}  # "/__fixture/" -> "/abs/dir"

for ext, typ in {".webmanifest": "application/manifest+json", ".js": "text/javascript", ".mjs": "text/javascript",
                 ".json": "application/json", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
                 ".webm": "video/webm", ".webp": "image/webp", ".svg": "image/svg+xml", ".url": "text/plain"}.items():
    mimetypes.add_type(typ, ext)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        clean = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        for prefix, base in MOUNTS.items():
            if clean.startswith(prefix):
                rel = posixpath.normpath(clean[len(prefix):]).lstrip("/")
                if rel.startswith(".."):
                    return os.path.join(base, "__forbidden__")
                return os.path.join(base, *rel.split("/"))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass

    def send_head(self):
        self._left = None
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m:
            return super().send_head()
        size = os.path.getsize(path)
        a, b = m.groups()
        if a == "" and b == "":
            return super().send_head()
        if a == "":
            start, end = max(0, size - int(b)), size - 1
        else:
            start, end = int(a), (int(b) if b else size - 1)
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self._left = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._left))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        left = self._left
        try:
            if left is None:
                return super().copyfile(source, outputfile)
            while left > 0:
                chunk = source.read(min(65536, left))
                if not chunk:
                    break
                outputfile.write(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    args, port = sys.argv[1:], 8780
    while args:
        a = args.pop(0)
        if a == "--mount":
            prefix, _, path = args.pop(0).partition("=")
            prefix = "/" + prefix.strip("/") + "/"
            MOUNTS[prefix] = os.path.abspath(os.path.expanduser(path))
        elif a.isdigit():
            port = int(a)
    print(f"Perch dev server on http://localhost:{port}/")
    for p, d in MOUNTS.items():
        print(f"  mount {p} -> {d}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
