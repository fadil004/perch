#!/data/data/com.termux/files/usr/bin/bash
# Perch phone downloader — installer for Termux (Android).
#
#   curl -fsSL https://fadil004.github.io/perch/bridge/install.sh | bash
#
# Installs Python, ffmpeg, Node (YouTube needs it) and yt-dlp, puts perch-bridge.py in ~/.perch,
# makes it start whenever Termux opens (and at boot with the Termux:Boot add-on), then opens Perch
# once to pair it. Running it again updates everything and keeps the pairing.
main() {
set -e

BASE="${PERCH_BASE:-https://fadil004.github.io/perch}"
DIR="$HOME/.perch"
PORT="${PERCH_PORT:-47821}"

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }

[ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ] || fail "Run this inside the Termux app."

say "1/4  Updating Termux (a few minutes the first time)…"
export DEBIAN_FRONTEND=noninteractive
pkg update -y </dev/null || fail "Couldn't update Termux. Check the internet connection and run the command again."
pkg upgrade -y -o Dpkg::Options::=--force-confnew </dev/null || true
pkg install -y python ffmpeg curl procps termux-tools </dev/null || fail "Couldn't install Python/ffmpeg."
pkg install -y python-pip </dev/null >/dev/null 2>&1 || true            # pip is its own package on newer Termux
pkg install -y nodejs-lts </dev/null >/dev/null 2>&1 || pkg install -y nodejs </dev/null || true   # JavaScript runtime for YouTube
python -m pip --version >/dev/null 2>&1 || python -m ensurepip >/dev/null 2>&1 || true

say "2/4  Installing yt-dlp…"
PIP="python -m pip install -U --disable-pip-version-check"
$PIP yt-dlp yt-dlp-ejs || $PIP --break-system-packages yt-dlp yt-dlp-ejs || fail "Couldn't install yt-dlp."

say "3/4  Setting up the Perch downloader…"
mkdir -p "$DIR"
curl -fsSL "$BASE/bridge/perch-bridge.py" -o "$DIR/perch-bridge.py.new" || fail "Couldn't download the Perch downloader."
mv "$DIR/perch-bridge.py.new" "$DIR/perch-bridge.py"
if [ ! -s "$DIR/token" ]; then
  python -c "import secrets; print(secrets.token_urlsafe(24))" > "$DIR/token"
fi
chmod 600 "$DIR/token"

cat > "$PREFIX/bin/perch-start" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
# Start the Perch downloader in the background (does nothing if it's already running).
pgrep -f "perch-bridge.py" >/dev/null && exit 0
LOG="$HOME/.perch/log.txt"
[ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1000000 ] && : > "$LOG"
termux-wake-lock >/dev/null 2>&1 || true      # keeps Android from pausing it while the screen is off
nohup python "$HOME/.perch/perch-bridge.py" >> "$LOG" 2>&1 &
EOS
cat > "$PREFIX/bin/perch-stop" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f "perch-bridge.py" && echo "Perch downloader stopped." || echo "It wasn't running."
termux-wake-unlock >/dev/null 2>&1 || true
EOS
cat > "$PREFIX/bin/perch-pair" <<EOS
#!/data/data/com.termux/files/usr/bin/bash
# Open Perch with this phone's pairing key.
termux-open-url "$BASE/#bridge=\$(cat "\$HOME/.perch/token")"
EOS
cat > "$PREFIX/bin/perch-update" <<EOS
#!/data/data/com.termux/files/usr/bin/bash
curl -fsSL "$BASE/bridge/install.sh" | bash
EOS
cat > "$PREFIX/bin/perch-log" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
tail -n "${1:-40}" "$HOME/.perch/log.txt"
EOS
chmod +x "$PREFIX/bin/perch-start" "$PREFIX/bin/perch-stop" "$PREFIX/bin/perch-pair" "$PREFIX/bin/perch-update" "$PREFIX/bin/perch-log"

# Start whenever Termux opens…
touch "$HOME/.bashrc"
grep -q "perch-start" "$HOME/.bashrc" || printf '\n# Perch downloader\nperch-start\n' >> "$HOME/.bashrc"
# …and when the phone starts, if the Termux:Boot add-on is installed.
mkdir -p "$HOME/.termux/boot"
printf '#!/data/data/com.termux/files/usr/bin/bash\nperch-start\n' > "$HOME/.termux/boot/perch"
chmod +x "$HOME/.termux/boot/perch"

say "4/4  Starting…"
pkill -f "perch-bridge.py" >/dev/null 2>&1 || true   # restart so an update takes effect
sleep 1
perch-start
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs -m 2 -H "X-Perch-Token: $(cat "$DIR/token")" "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "The downloader didn't start. Run: perch-log"

say "Done. Opening Perch to connect it…"
echo "If Chrome asks to let the site reach devices / apps on this phone, tap Allow."
echo "Keep Termux in the background. Settings → Apps → Termux → Battery → Unrestricted keeps it alive."
perch-pair
}

# Wrapped in a function so the whole script is read before anything runs (curl | bash).
main "$@"
