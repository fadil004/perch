#!/usr/bin/env python3
"""Emit a fake Drive tree for local Eagle libraries.
Usage: make_mock_manifest.py [--url-prefix /__fixture/ --url-root DIR] <X.library> [<Y.library> ...] <out.json>
Every library is nested under one fake parent folder ("Eagle", id demo-root). Ids are stable (sha1 of path).
File 'url' values are relative to the directory that holds out.json, or prefix + path relative to --url-root
(use that for libraries served from a serve.py --mount outside the app folder)."""
import os, sys, json, hashlib, mimetypes, datetime

MIME = {".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
FOLDER = "application/vnd.google-apps.folder"


def fid(path):
    return "1" + hashlib.sha1(path.encode()).hexdigest()[:32]  # 33 chars, like real Drive ids


def mtime(path):
    """Real modification time of a file or folder, in Drive's RFC 3339 format."""
    return datetime.datetime.utcfromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    args, prefix, uroot = sys.argv[1:], None, None
    while args and args[0].startswith("--"):
        flag, val, args = args[0], args[1], args[2:]
        if flag == "--url-prefix": prefix = val
        elif flag == "--url-root": uroot = os.path.abspath(val)
    libs, out = args[:-1], args[-1]
    outdir = os.path.dirname(os.path.abspath(out))
    newest = max((os.path.abspath(l.rstrip("/")) for l in libs), key=os.path.getmtime)
    files = [{"id": "demo-root", "name": "Eagle", "mimeType": FOLDER, "parents": ["demo-my-drive"], "modifiedTime": mtime(newest)}]
    for lib in libs:
        lib = os.path.abspath(lib.rstrip("/"))
        base = os.path.dirname(lib)
        for dirpath, dirnames, filenames in os.walk(lib):
            dirnames.sort()
            rel = os.path.relpath(dirpath, base)
            pid = "demo-root" if dirpath == lib else fid(rel)
            if dirpath == lib:
                files.append({"id": fid(rel), "name": os.path.basename(lib), "mimeType": FOLDER, "parents": ["demo-root"], "modifiedTime": mtime(lib)})
                pid = fid(rel)
            for d in dirnames:
                p = os.path.join(rel, d)
                files.append({"id": fid(p), "name": d, "mimeType": FOLDER, "parents": [pid], "modifiedTime": mtime(os.path.join(dirpath, d))})
            for fn in sorted(filenames):
                p = os.path.join(rel, fn)
                full = os.path.join(dirpath, fn)
                ext = os.path.splitext(fn)[1].lower()
                files.append({"id": fid(p), "name": fn, "mimeType": MIME.get(ext, "application/octet-stream"), "parents": [pid],
                              "size": str(os.path.getsize(full)),
                              "modifiedTime": mtime(full),
                              "url": (prefix + os.path.relpath(full, uroot) if prefix else os.path.relpath(full, outdir)).replace(os.sep, "/")})
    with open(out, "w") as f:
        json.dump({"rootId": "demo-root", "files": files}, f)
    print(f"{out}: {len(files)} entries")

main()
