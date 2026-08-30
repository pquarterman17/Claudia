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
    open "http://127.0.0.1:4317"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:4317"
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

# The SERVER opens the browser, from the callback where it starts listening.
# This was a curl loop polling the port from out here — a guess about something
# the server knows exactly, duplicated once per platform, and wrong on Windows.
export CLAUDIA_OPEN=1

cat <<'BANNER'

  Claudia is starting.
  http://127.0.0.1:4317

  Press Ctrl+C to stop it.

BANNER

npm start

echo
echo "  Claudia stopped."
echo
read -r -p "  Press return to close. "
