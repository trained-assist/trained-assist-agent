#!/bin/sh
# Class-level disk safety net for the prod box.
# Supersedes chrome-metrics-cap.sh. Two tiers:
#   Tier 1 (always, hourly): reclaim throwaway Chrome telemetry/cache with an
#           age guard so a live browser's current files are untouched.
#   Tier 2 (emergency, only when the root fs crosses THRESH%): reclaim the same
#           classes ignoring age, because a full disk (ENOSPC) breaks every
#           command on the box. This is the guard that stops a repeat of the
#           2026-09-13 incident (BrowserMetrics .pma filled 178G).
# Only ever touches KNOWN-throwaway paths (UMA .pma, Crashpad dumps, GPU/shader
# caches). Never touches tenant data, session stores, or profile prefs.
LOG=/home/vova/disk-guard.log
THRESH=85
ts() { date '+%Y-%m-%d %H:%M:%S'; }
usep() { df -P / | awk 'NR==2{gsub("%","",$5); print $5}'; }

# Throwaway glob classes across every Chrome profile location on the box.
metrics_dirs() {
  for d in /home/vova/users/*/chrome/BrowserMetrics \
           /home/vova/users/*/*/chrome/BrowserMetrics \
           /home/vova/chrome-profiles/*/BrowserMetrics; do
    [ -d "$d" ] && echo "$d"
  done
}
cache_dirs() {
  for d in /home/vova/users/*/chrome/Crashpad \
           /home/vova/chrome-profiles/*/Crashpad \
           /home/vova/users/*/chrome/*/GPUCache \
           /home/vova/users/*/chrome/*/ShaderCache \
           /home/vova/users/*/chrome/GrShaderCache; do
    [ -d "$d" ] && echo "$d"
  done
}

before=$(usep)
total=0

# --- Tier 1: age-guarded (>120 min) .pma reclaim ---
for d in $(metrics_dirs); do
  n=$(find "$d" -type f -name '*.pma' -mmin +120 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || continue
  find "$d" -type f -name '*.pma' -mmin +120 -delete 2>/dev/null
  total=$((total + n)); echo "$(ts) T1 purged $n .pma from $d" >> "$LOG"
done

# --- Tier 2: emergency — disk over threshold, reclaim ignoring age ---
if [ "$before" -ge "$THRESH" ]; then
  echo "$(ts) !!! EMERGENCY disk ${before}% >= ${THRESH}% — aggressive reclaim" >> "$LOG"
  for d in $(metrics_dirs); do
    n=$(find "$d" -type f -name '*.pma' 2>/dev/null | wc -l)
    [ "$n" -gt 0 ] && find "$d" -type f -name '*.pma' -delete 2>/dev/null && \
      total=$((total + n)) && echo "$(ts) T2 purged ALL $n .pma from $d" >> "$LOG"
  done
  for d in $(cache_dirs); do
    find "$d" -mindepth 1 -delete 2>/dev/null && echo "$(ts) T2 cleared cache $d" >> "$LOG"
  done
fi

after=$(usep)
if [ "$total" -gt 0 ] || [ "$before" -ge "$THRESH" ]; then
  echo "$(ts) SUMMARY purged=$total files, disk ${before}%->${after}%" >> "$LOG"
fi
exit 0
