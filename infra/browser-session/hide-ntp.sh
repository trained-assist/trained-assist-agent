#!/bin/bash
# Keep Chrome NTP windows hidden so Tilda login stays visible.
# Runs every 0.3s — Chrome aggressively restores its main window, we need to match it.
export DISPLAY=:99
while true; do
  for win in $(xdotool search --name "New Tab" 2>/dev/null); do
    wmctrl -i -r "$win" -b add,below 2>/dev/null
    xdotool windowminimize "$win" 2>/dev/null
  done
  tilda=$(xdotool search --name "Sign in - Tilda" 2>/dev/null | head -1)
  if [ -n "$tilda" ]; then
    wmctrl -i -r "$tilda" -b add,above 2>/dev/null
    active=$(xdotool getactivewindow 2>/dev/null)
    active_name=$(xdotool getwindowname "$active" 2>/dev/null)
    if echo "$active_name" | grep -q "New Tab"; then
      xdotool windowactivate "$tilda" 2>/dev/null
    fi
  fi
  sleep 0.3
done
