#!/bin/bash
# One-shot: after Chrome starts, push NTP out of view permanently.
# CDP removes the page; wmctrl "always below" + minimize handles the X11 shell window.

export DISPLAY=:99
CDP="http://127.0.0.1:9224"

# Wait up to 15s for Chrome CDP to be ready
for i in $(seq 1 15); do
  curl -sf "$CDP/json" >/dev/null 2>&1 && break
  sleep 1
done

# Close NTP tab via CDP (safe: Tilda app window keeps Chrome alive)
curl -sf "$CDP/json" | python3 -c "
import json, sys, urllib.request
for t in json.load(sys.stdin):
    if t.get('type') == 'page' and 'newtab' in t.get('url', ''):
        urllib.request.urlopen('$CDP/json/close/' + t['id'], timeout=5)
" 2>/dev/null

# Give Chrome a moment to process, then handle the leftover X11 shell window
sleep 2

for win in $(xdotool search --name "New Tab" 2>/dev/null); do
  wmctrl -i -r "$win" -b add,below 2>/dev/null   # force below all other windows (WM-enforced)
  xdotool windowminimize "$win" 2>/dev/null
done

# Ensure Tilda is on top and focused
tilda=$(xdotool search --name "Sign in - Tilda" 2>/dev/null | head -1)
if [ -n "$tilda" ]; then
  wmctrl -i -r "$tilda" -b add,above 2>/dev/null
  xdotool windowactivate "$tilda" 2>/dev/null
fi
