#!/usr/bin/env bash
# Show accumulated mainstream tester bugs, grouped by type.
# Usage: ./scripts/mainstream-bugs.sh
set -euo pipefail

echo "=== Mainstream Tester Bug Report ==="
echo ""

TOTAL=0

# Find all bugs files
mapfile -t FILES < <(find "$HOME/agent-data" -name "bugs.jsonl" -path "*/mainstream-test*" 2>/dev/null | sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No bug files found yet in ~/agent-data/mainstream-test*/"
  exit 0
fi

for file in "${FILES[@]}"; do
  COUNT=$(wc -l < "$file" 2>/dev/null || echo 0)
  [[ "$COUNT" -gt 0 ]] && echo "  $file → $COUNT bugs"
  TOTAL=$((TOTAL + COUNT))
done

echo ""
echo "Total bugs accumulated: $TOTAL"

echo ""
echo "By type:"
find "$HOME/agent-data" -name "bugs.jsonl" -path "*/mainstream-test*" \
  | xargs -r cat 2>/dev/null \
  | python3 -c "
import sys, json, collections
counts = collections.Counter()
for line in sys.stdin:
    try:
        d = json.loads(line)
        counts[d.get('type', 'unknown')] += 1
    except: pass
for t, c in counts.most_common():
    print(f'  {t}: {c}')
"

echo ""
echo "Last 10 bugs:"
find "$HOME/agent-data" -name "bugs.jsonl" -path "*/mainstream-test*" \
  | xargs -r cat 2>/dev/null | tail -10 \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        step = d.get('step', '?')
        task = d.get('task', '')[:40]
        detail = d.get('detail', '')[:100]
        print(f'  [{d.get(\"type\",\"\")}] step={step} task=\"{task}\" | {detail}')
    except: pass
"
