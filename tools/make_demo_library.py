#!/usr/bin/env python3
"""Build demo/*.library in the exact Eagle 4 on-disk format (stdlib only; MP4s via Swift/AVFoundation).
Usage: python3 tools/make_demo_library.py   -> perch/demo/{Demo,Archive,Sketches}.library
"""
import os, sys, json, math, random, shutil, struct, zlib, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.join(os.path.dirname(HERE), "demo")
NOW = 1762800000000  # fixed "now" in ms so output is stable
LONG = 600           # long side of main images
ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

# ---------------------------------------------------------------- encoders
def png_bytes(w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def ch(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b"")


def downscale2(w, h, rows):
    nw, nh = w // 2, h // 2
    out = []
    for y in range(nh):
        a, b = rows[2 * y], rows[2 * y + 1]
        r = bytearray(nw * 3)
        for x in range(nw):
            i, j = 6 * x, 3 * x
            for c in range(3):
                r[j + c] = (a[i + c] + a[i + 3 + c] + b[i + c] + b[i + 3 + c]) >> 2
        out.append(r)
    return nw, nh, out


def gif_bytes(w, h, palette, frames, delay=6):
    """Uncompressed-style GIF: a clear code every 60 symbols keeps the code size at 7 bits."""
    out = bytearray(b"GIF89a")
    out += struct.pack("<HHBBB", w, h, 0xF5, 0, 0)
    for r, g, b in palette:
        out += bytes((r, g, b))
    out += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    for fr in frames:
        out += b"\x21\xF9\x04\x04" + struct.pack("<H", delay) + b"\x00\x00"
        out += b"\x2C" + struct.pack("<HHHHB", 0, 0, w, h, 0)
        out += bytes((6,))
        bits, nb, data = 0, 0, bytearray()
        def emit(c):
            nonlocal bits, nb
            bits |= c << nb
            nb += 7
            while nb >= 8:
                data.append(bits & 255); bits >>= 8; nb -= 8
        emit(64)
        n = 0
        for px in fr:
            emit(px); n += 1
            if n == 60:
                emit(64); n = 0
        emit(65)
        if nb: data.append(bits & 255)
        for i in range(0, len(data), 255):
            blk = data[i:i + 255]
            out += bytes((len(blk),)) + blk
        out += b"\x00"
    out += b"\x3B"
    return bytes(out)

# ---------------------------------------------------------------- image synthesis
def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)

def hsv(h, s, v):
    h = (h % 1.0) * 6; i = int(h); f = h - i
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    r, g, b = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i % 6]
    return (r * 255, g * 255, b * 255)

def render(w, h, rnd):
    hue = rnd.random()
    mood = rnd.choice(["dusk", "pastel", "mono", "neon", "earth", "ice"])
    if mood == "dusk":   cols = [hsv(hue, .55, .95), hsv(hue + .1, .65, .5), hsv(hue + .2, .6, .1)]
    elif mood == "pastel": cols = [hsv(hue, .25, 1), hsv(hue + .08, .3, .95), hsv(hue + .16, .35, .8)]
    elif mood == "mono": cols = [hsv(hue, .04, .95), hsv(hue, .06, .45), hsv(hue, .1, .08)]
    elif mood == "neon": cols = [hsv(hue, .9, 1), hsv(hue + .45, .9, .55), hsv(hue + .6, .8, .08)]
    elif mood == "earth": cols = [hsv(.08 + hue * .06, .5, .9), hsv(.05, .45, .45), hsv(.1, .4, .12)]
    else: cols = [hsv(.55 + hue * .1, .3, 1), hsv(.6, .55, .7), hsv(.65, .6, .15)]
    ang = rnd.random() * math.pi * 2
    ca, sa = math.cos(ang), math.sin(ang)
    m = min(w, h)
    blobs = [(rnd.random(), rnd.random(), .12 + rnd.random() * .3, hsv(hue + rnd.random() * .5, .5 + rnd.random() * .4, 1), .35 + rnd.random() * .5) for _ in range(3)]
    style = rnd.choice(["none", "ring", "bars", "dots", "ring"])
    rcx, rcy, rr = .3 + rnd.random() * .4, .3 + rnd.random() * .4, .14 + rnd.random() * .16
    rows = []
    tot = [0, 0, 0]
    for y in range(h):
        row = bytearray(w * 3)
        v = y / h
        for x in range(w):
            u = x / w
            t = (u * ca + v * sa) * .5 + .5
            t = 0 if t < 0 else 1 if t > 1 else t
            c = mix(cols[0], cols[1], t * 2) if t < .5 else mix(cols[1], cols[2], t * 2 - 1)
            for bx, by, br, bc, bs in blobs:
                d = math.hypot((u - bx) * w, (v - by) * h) / (br * m)
                if d < 1:
                    k = (1 - d * d) ** 2 * bs
                    c = mix(c, bc, k)
            if style == "ring":
                d = abs(math.hypot((u - rcx) * w, (v - rcy) * h) / m - rr)
                if d < .006: c = mix(c, (255, 255, 255), .85 * (1 - d / .006))
            elif style == "bars":
                if .12 < u < .88 and int(u * 40) % 3 == 0 and v > .62: c = mix(c, (255, 255, 255), .25)
            elif style == "dots":
                if (x % 24) < 3 and (y % 24) < 3: c = mix(c, (255, 255, 255), .3)
            e = (u - .5) ** 2 + (v - .5) ** 2
            k = 1 - e * .55
            j = x * 3
            row[j] = max(0, min(255, int(c[0] * k)))
            row[j + 1] = max(0, min(255, int(c[1] * k)))
            row[j + 2] = max(0, min(255, int(c[2] * k)))
        rows.append(row)
        tot[0] += sum(row[0::3][::8]); tot[1] += sum(row[1::3][::8]); tot[2] += sum(row[2::3][::8])
    n = h * len(range(0, w, 8))
    avg = [int(tot[i] / n) for i in range(3)]
    pal = [{"color": avg, "ratio": 38.0}] + [{"color": [int(v) for v in c], "ratio": r} for c, r in zip(cols + [blobs[0][3]], (30.0, 18.0, 8.0, 6.0))]
    return rows, pal

RATIOS = [(9, 16), (16, 9), (1, 1), (4, 5), (21, 9), (3, 4), (4, 3), (9, 16), (4, 5), (2, 3), (1, 1), (3, 2)]

def dims(ratio, long=LONG):
    a, b = ratio
    if a >= b: return long, max(2, int(round(long * b / a / 2)) * 2)
    return max(2, int(round(long * a / b / 2)) * 2), long

# ---------------------------------------------------------------- library writer
class Lib:
    def __init__(self, name, seed):
        self.name, self.rnd = name, random.Random(seed)
        self.root = os.path.join(DEMO, name)
        self.items, self.mtimes, self.folders = [], {}, []
        shutil.rmtree(self.root, ignore_errors=True)
        os.makedirs(os.path.join(self.root, "images"))
        self.used = set()

    def nid(self, n=13):
        while True:
            s = "".join(self.rnd.choice(ALPH) for _ in range(n))
            if s not in self.used:
                self.used.add(s); return s

    def folder(self, name, color=None, children=None, password="", tips=""):
        f = {"id": self.nid(), "name": name, "description": "", "children": children or [], "modificationTime": NOW,
             "tags": [], "password": password, "passwordTips": tips}
        if color: f["iconColor"] = color
        return f

    def add(self, name, ext, files, size=None, **extra):
        """files: dict filename -> bytes; first must be main (optional)"""
        iid = self.nid()
        d = os.path.join(self.root, "images", iid + ".info")
        os.makedirs(d)
        total = 0
        for fn, data in files.items():
            with open(os.path.join(d, fn), "wb") as f: f.write(data)
            total += len(data)
        ts = NOW - self.rnd.randint(3, 400) * 86400000
        meta = {"id": iid, "name": name, "size": size or total, "btime": ts, "mtime": ts, "ext": ext, "tags": [], "folders": [],
                "isDeleted": False, "url": "", "annotation": "", "modificationTime": ts, "height": 0, "width": 0, "lastModified": ts, "palettes": []}
        meta.update(extra)
        self.items.append((iid, d, meta))
        self.mtimes[iid] = ts
        return meta

    def finish(self, tree, tags_hist, tags_star):
        for iid, d, meta in self.items:
            if meta.pop("_skipmeta", False): continue
            with open(os.path.join(d, "metadata.json"), "w") as f: json.dump(meta, f, ensure_ascii=False)
        md = {"folders": tree, "smartFolders": [], "quickAccess": [], "tagsGroups": [], "modificationTime": NOW, "applicationVersion": "4.0.0"}
        self.write("metadata.json", md)
        self.write("tags.json", {"historyTags": tags_hist, "starredTags": tags_star})
        self.write("mtime.json", dict(self.mtimes, all=len(self.mtimes)))
        for fn in ("actions.json", "saved-filters.json"): self.write(fn, [] if "saved" in fn else {})
        os.makedirs(os.path.join(self.root, "backup"), exist_ok=True)
        with open(os.path.join(self.root, "images", ".DS_Store"), "wb") as f: f.write(b"\x00\x00\x00\x01Bud1" + bytes(64))
        print(f"{self.name}: {len(self.items)} .info folders")

    def write(self, fn, obj):
        with open(os.path.join(self.root, fn), "w") as f: json.dump(obj, f, ensure_ascii=False)

NAMES_A = ["Chrome", "Velvet", "Static", "Halo", "Drift", "Paper", "Signal", "Ember", "Glass", "Orbit", "Tide", "Neon", "Soft", "Grain", "Bloom", "Pulse", "Quiet", "Fold", "Mono", "Lumen"]
NAMES_B = ["Bloom", "Grid", "Wave", "Study", "Loop", "Frame", "Field", "Cut", "Type", "Light", "Shift", "Mark", "Stack", "Echo", "Trace", "Mesh"]

def pick_name(lib):
    return f"{lib.rnd.choice(NAMES_A)} {lib.rnd.choice(NAMES_B)} {lib.rnd.randint(1, 99):02d}"

def add_image(lib, ratio, folders, tags, star=None, annotation=""):
    r = lib.rnd
    w, h = dims(ratio)
    rows, pal = render(w, h, r)
    nm = pick_name(lib)
    tw, th, trows = downscale2(w, h, rows)
    base = nm.replace(" ", "_")
    meta = lib.add(nm, "png", {base + ".png": png_bytes(w, h, rows), base + "_thumbnail.png": png_bytes(tw, th, trows)},
                   width=w, height=h, palettes=pal, folders=folders, tags=tags, annotation=annotation)
    if star: meta["star"] = star
    return meta

def add_gif(lib, w, h, folders, tags, hue):
    nm = pick_name(lib) + " GIF"
    pal = [tuple(int(v) for v in mix(hsv(hue, .7, .15), hsv(hue + .25, .6, 1), i / 63)) for i in range(64)]
    n = 12
    frames = []
    for k in range(n):
        p = 2 * math.pi * k / n
        fr = bytearray()
        for y in range(h):
            for x in range(w):
                v = math.sin(x * .045 + p) + math.sin(y * .05 - p) + math.sin((x + y) * .03 + 2 * p) + math.sin(math.hypot(x - w / 2, y - h / 2) * .06 - p)
                fr.append(max(0, min(63, int((v + 4) / 8 * 63))))
        frames.append(bytes(fr))
    g = gif_bytes(w, h, pal, frames)
    rows = [bytearray(b"".join(bytes(pal[frames[0][y * w + x]]) for x in range(w))) for y in range(h)]
    tw, th, trows = downscale2(w, h, rows) if w >= 400 else (w, h, rows)
    base = nm.replace(" ", "_")
    meta = lib.add(nm, "gif", {base + ".gif": g, base + "_thumbnail.png": png_bytes(tw, th, trows)}, width=w, height=h,
                   palettes=[{"color": list(pal[32]), "ratio": 60.0}, {"color": list(pal[10]), "ratio": 25.0}, {"color": list(pal[58]), "ratio": 15.0}],
                   folders=folders, tags=tags, duration=0.72)
    return meta

def add_url(lib, ratio, folders, tags, url, medium=None, vid=None, dur=None):
    r = lib.rnd
    w, h = dims(ratio, 480)
    rows, pal = render(w, h, r)
    nm = pick_name(lib)
    extra = {}
    if medium: extra.update(medium=medium, videoID=vid)
    if dur is not None: extra["duration"] = str(dur)
    base = nm.replace(" ", "_")
    shortcut = ("[InternetShortcut]\r\nURL=" + url + "\r\n").encode()
    return lib.add(nm, "url", {base + ".url": shortcut, base + "_thumbnail.png": png_bytes(w, h, rows)}, size=len(shortcut), width=w, height=h, palettes=pal,
                   folders=folders, tags=tags, url=url, **extra)

def add_mp4(lib, bins, ratio_wh, folders, tags, hue, star=None):
    W, H = ratio_wh
    nm = pick_name(lib) + " Loop"
    tmp = tempfile.mkdtemp()
    out, th = os.path.join(tmp, "o.mp4"), os.path.join(tmp, "t.png")
    res = subprocess.run([bins, out, th, str(W), str(H), str(hue), "2.5"], capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(res.stdout + res.stderr)
    tb = open(th, "rb").read()
    wth, hth = struct.unpack(">II", tb[16:24])
    # palette from the dominant hue
    pal = [{"color": [int(v) for v in hsv(hue + .1, .6, .55)], "ratio": 50.0}, {"color": [int(v) for v in hsv(hue, .55, .95)], "ratio": 30.0}, {"color": [int(v) for v in hsv(hue + .25, .6, .12)], "ratio": 20.0}]
    base = nm.replace(" ", "_")
    meta = lib.add(nm, "mp4", {base + ".mp4": open(out, "rb").read(), base + "_thumbnail.png": tb}, width=W, height=H, palettes=pal,
                   folders=folders, tags=tags, duration=2.5, resolutionWidth=W, resolutionHeight=H)
    if star: meta["star"] = star
    shutil.rmtree(tmp)
    return meta

def build_demo(bins):
    lib = Lib("Demo.library", 7)
    loops = lib.folder("Loops", "aqua"); trans = lib.folder("Transitions", "blue")
    motion = lib.folder("Motion", "blue", [loops, trans])
    typo = lib.folder("Typography", "purple"); color = lib.folder("Color", "orange"); nature = lib.folder("Nature", "green")
    private = lib.folder("Private", "red", password="demo", tips="four letters")
    links = lib.folder("Links", "pink")
    tree = [motion, typo, color, nature, private, links]
    r = lib.rnd
    T = ["type", "grid", "gradient", "3d", "glass", "minimal", "loop", "poster", "neon", "texture", "dark", "pastel"]
    def tg(*must):
        return list(dict.fromkeys(list(must) + r.sample(T, r.randint(1, 3))))
    n_img = 0
    plan = []  # (ratio, folders)
    for i in range(36):
        f = r.choice([[motion["id"]], [loops["id"]], [trans["id"]], [typo["id"]], [typo["id"]], [color["id"]], [color["id"]], [nature["id"]], [nature["id"]], [], [typo["id"], color["id"]]])
        plan.append((RATIOS[i % len(RATIOS)], f))
    r.shuffle(plan)
    for k, (ratio, f) in enumerate(plan):
        ann = "ريفرنس للحركة والإضاءة، لون دافئ مع تدرج ناعم" if k == 3 else ("مرجع للتايبوغرافي العربي" if k == 11 else "")
        add_image(lib, ratio, f, tg(), star=(k % 9 == 0 and r.randint(3, 5)) or None, annotation=ann)
    # private items
    for ratio in [(4, 5), (1, 1), (16, 9)]:
        add_image(lib, ratio, [private["id"]], tg("private"))
    # gifs
    add_gif(lib, 240, 240, [loops["id"]], tg("loop"), .62)
    add_gif(lib, 320, 180, [motion["id"]], tg("loop", "gradient"), .05)
    add_gif(lib, 200, 260, [], tg("loop"), .85)
    # videos
    vids = ["skipped"]
    try:
        add_mp4(lib, bins, (854, 480), [loops["id"]], tg("loop", "video"), .6, star=5)
        add_mp4(lib, bins, (480, 854), [trans["id"]], tg("video"), .02)
        add_mp4(lib, bins, (480, 480), [motion["id"], loops["id"]], tg("video", "loop"), .78, star=3)
    except Exception as e:
        print("MP4 generation failed:", e)
    # links
    add_url(lib, (16, 9), [links["id"]], ["link", "video"], "https://vimeo.com/76979871", "vimeo", "76979871", 96)
    add_url(lib, (16, 9), [links["id"]], ["link", "video"], "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "youtube", "aqz-KE-bpKQ", 634)
    add_url(lib, (4, 5), [links["id"]], ["link", "poster"], "https://example.com/gallery/typography-study")
    add_url(lib, (1, 1), [], ["link"], "https://example.org/motion-reference")
    # one deleted item and one empty .info
    m = add_image(lib, (1, 1), [], ["trash"]); m["isDeleted"] = True
    d = os.path.join(lib.root, "images", lib.nid() + ".info"); os.makedirs(d)
    lib.mtimes[os.path.basename(d)[:-5]] = NOW
    os.makedirs(os.path.join(lib.root, "images", lib.nid() + ".info"))  # orphan folder, not in mtime.json
    lib.finish(tree, ["loop", "type", "gradient", "minimal", "3d", "video", "poster"], ["loop", "video", "gradient", "type"])

def build_small(name, seed, n, fnames):
    lib = Lib(name, seed)
    fs = [lib.folder(f, c) for f, c in fnames]
    r = lib.rnd
    for i in range(n):
        add_image(lib, RATIOS[(i + seed) % len(RATIOS)], [r.choice(fs)["id"]] if i % 4 else [], r.sample(["study", "light", "texture", "soft"], 2))
    lib.finish(fs, ["study", "light"], ["texture"])

if __name__ == "__main__":
    t0 = time.time()
    os.makedirs(DEMO, exist_ok=True)
    bindir = tempfile.mkdtemp()
    bins = os.path.join(bindir, "make_mp4")
    cp = subprocess.run(["swiftc", "-O", os.path.join(HERE, "make_mp4.swift"), "-o", bins], capture_output=True, text=True)
    if cp.returncode != 0:
        print("swiftc failed; MP4 items will be skipped:\n", cp.stderr[:400])
        bins = "/nonexistent"
    build_demo(bins)
    build_small("Archive.library", 3, 14, [("Posters", "yellow"), ("Packaging", "aqua"), ("Stills", None)])
    build_small("Sketches.library", 5, 8, [("Rough", "pink"), ("Final", "green")])
    shutil.rmtree(bindir, ignore_errors=True)
    print(f"done in {time.time() - t0:.1f}s")
