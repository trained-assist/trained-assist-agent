#!/bin/sh
# Systemic dead-tenant hygiene — REPORT ONLY, never deletes.
# Tenant data is small (biggest dead one ~9MB) and deletion is irreversible, so
# this sweep only classifies and records. A human (or the LLM adjudicator for the
# ambiguous band) approves actual archival/deletion separately.
#
# Classification:
#   junk      : name matches an obvious test/throwaway pattern
#   stale     : real-looking name, idle > STALE_D days      -> archive candidate
#   ambiguous : real-looking name, IDLE_LO..STALE_D days    -> needs judgement
#   live      : idle <= IDLE_LO days
# Output: appends a timestamped block to the ledger and prints archive candidates.
USERS=/home/vova/users
LEDGER=/home/vova/dead-tenant-report.txt
STALE_D=21
IDLE_LO=7
now=$(date +%s)
ts=$(date '+%Y-%m-%d %H:%M:%S')

is_junk() {
  case "$1" in
    test|test_*|*_test|testuser|testuser_*|smoketest|pwtest|zemtest|admin) return 0 ;;
    *) return 1 ;;
  esac
}

{
  echo "===== dead-tenant sweep $ts  (STALE>${STALE_D}d, ambiguous ${IDLE_LO}-${STALE_D}d) ====="
  printf "%-32s %-10s %-8s %s\n" "TENANT" "CLASS" "IDLE" "SIZE"
  for p in "$USERS"/*/; do
    t=$(basename "$p")
    last=$(find "$p" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1); last=${last%.*}
    [ -z "$last" ] && last=0
    days=$(( (now - last) / 86400 ))
    sz=$(du -sh "$p" 2>/dev/null | cut -f1)
    if is_junk "$t"; then cls="junk"
    elif [ "$last" -eq 0 ] || [ "$days" -gt "$STALE_D" ]; then cls="stale"
    elif [ "$days" -gt "$IDLE_LO" ]; then cls="ambiguous"
    else cls="live"; fi
    printf "%-32s %-10s %-8s %s\n" "$t" "$cls" "${days}d" "$sz"
  done
} | tee -a "$LEDGER"

echo
echo "Ledger: $LEDGER"
echo "This sweep DELETED NOTHING. To archive a candidate reversibly:"
echo "  tar czf /home/vova/_graveyard/<tenant>.tgz -C $USERS <tenant> && rm -rf $USERS/<tenant>"
exit 0
