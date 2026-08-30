#!/bin/bash
# Keep Chrome NTP windows hidden so Tilda login stays visible
export DISPLAY=:99
while true; do
  for win in $(xdotool search --name "New Tab - Google Chrome" 2>/dev/null); do
    wmctrl -i -r "$win" -b add,below 2>/dev/null
    xdotool windowminimize "$win" 2>/dev/null
  done
  # Raise Tilda if it exists and NTP is not active
  tilda_win=$(xdotool search --name "Sign in - Tilda" 2>/dev/null | head -1)
  if [ -n "$tilda_win" ]; then
    wmctrl -i -r "$tilda_win" -b add,above 2>/dev/null
    active=$(xdotool getactivewindow 2>/dev/null)
    active_name=$(xdotool getwindowname "$active" 2>/dev/null)
    if echo "$active_name" | grep -q "New Tab"; then
      xdotool windowactivate "$tilda_win" 2>/dev/null
    fi
  fi
  sleep 1
done
