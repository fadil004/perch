#!/usr/bin/env python3
"""Generate Perch's PWA icons with the stdlib only.
Mark: a small dot perched right of centre on a thin line, off-white on black. 4x4 supersampled.
Usage: python3 tools/make_icons.py  -> perch/icons/*.png
"""
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
FG = (245, 245, 247)
BG = (0, 0, 0)


def png(w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def capsule(u, v, x0, x1, y, r):
    cx = min(max(u, x0), x1)
    return math.hypot(u - cx, v - y) - r


def coverage(u, v):
    # unit square, centred mark (matches the inline SVG in js/icons.js: 48-unit box)
    d_dot = math.hypot(u - 29.5 / 48, v - 21.5 / 48) - 5.5 / 48
    d_line = capsule(u, v, 9 / 48, 39 / 48, 31 / 48, 1.3 / 48)
    return min(d_dot, d_line) < 0


def render(size, scale):
    rows = []
    n = 4
    for y in range(size):
        row = bytearray()
        for x in range(size):
            hits = 0
            for sy in range(n):
                for sx in range(n):
                    u = ((x + (sx + 0.5) / n) / size - 0.5) / scale + 0.5
                    v = ((y + (sy + 0.5) / n) / size - 0.5) / scale + 0.5
                    hits += coverage(u, v)
            a = hits / (n * n)
            row += bytes(int(BG[i] + (FG[i] - BG[i]) * a) for i in range(3))
        rows.append(row)
    return rows


def write(name, size, scale):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(png(size, size, render(size, scale)))
    print("wrote", name)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write("icon-192.png", 192, 1.25)
    write("icon-512.png", 512, 1.25)
    write("icon-maskable-512.png", 512, 0.95)
    write("apple-touch-icon.png", 180, 1.2)
