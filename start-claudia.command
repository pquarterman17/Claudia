#!/bin/bash
# Double-clickable launcher for macOS (and usable as a plain script on Linux).

# Run from the repo root no matter where this was launched from.
cd "$(dirname "$0")" || exit 1

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    # nc is the fallback where lsof is missing.
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

open_ui() {
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:4318"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:4318"
  fi
}

# Already running? Just show it rather than failing on a port clash.
if port_busy 4317; then
  echo "Claudia is already running - opening it."
  open_ui
  sleep 1
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found on PATH."
  echo "  Install it from https://nodejs.org then run this again."
  echo
  read -r -p "  Press return to close. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  First run - installing dependencies. This takes a minute or two."
  echo
  if ! npm install; then
    echo
    echo "  npm install failed. See the messages above."
    echo
    read -r -p "  Press return to close. "
    exit 1
  fi
fi

# Open the browser the moment the UI answers, rather than after a fixed wait.
# A flat sleep here made every start feel four seconds slower than it was.
(
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null --max-time 1 "http://localhost:4318" 2>/dev/null; then break; fi
    sleep 0.25
  done
  open_ui
) &

cat <<'BANNER'

  Claudia is starting.
  UI:     http://localhost:4318
  Server: http://127.0.0.1:4317

  Press Ctrl+C to stop it.

BANNER

npm run dev

echo
echo "  Claudia stopped."
echo
read -r -p "  Press return to close. "
