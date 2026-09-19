#!/usr/bin/env bash
# Install CI auto-fixer into a target GitHub repository.
#
# Usage:
#   ./scripts/install-ci-fixer.sh <owner/repo> [--ci-workflow "CI Workflow Name"]
#
# What it does:
#   1. Clones the target repo to a temp dir
#   2. Copies auto-fix-ci.yml, ci-fix-cleanup.yml, scripts/autofix-openrouter.mjs
#   3. Adjusts the CI workflow trigger name if --ci-workflow is provided
#   4. Creates a branch + commit + PR in the target repo
#
# Required: gh CLI authenticated, OPENROUTER_API_KEY set as a repo secret (see output)

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-}"
CI_WORKFLOW_NAME="CI"

# Parse --ci-workflow flag
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci-workflow)
      CI_WORKFLOW_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TARGET_REPO" ]; then
  echo "Usage: $0 <owner/repo> [--ci-workflow 'Workflow Name']"
  echo ""
  echo "Examples:"
  echo "  $0 trained-assist/trained-assist-tg-bot --ci-workflow 'CI'"
  echo "  $0 myorg/my-web-app --ci-workflow 'Build and Test'"
  exit 1
fi

echo "Installing CI auto-fixer into $TARGET_REPO"
echo "  CI workflow to watch: \"$CI_WORKFLOW_NAME\""
echo ""

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Clone target repo
echo "Cloning $TARGET_REPO..."
gh repo clone "$TARGET_REPO" "$TMPDIR/repo" -- --depth=1 --quiet

cd "$TMPDIR/repo"

# Detect default branch
DEFAULT_BRANCH=$(git symbolic-ref --short HEAD)
echo "Default branch: $DEFAULT_BRANCH"

# Create install branch
INSTALL_BRANCH="ci-fixer/install-$(date +%s)"
git checkout -b "$INSTALL_BRANCH"

# Create .github/workflows/ if needed
mkdir -p .github/workflows scripts

# ── Copy and adapt auto-fix-ci.yml ──────────────────────────────────────────
sed "s/workflows: \[\"CI + Deploy\"\]/workflows: [\"${CI_WORKFLOW_NAME}\"]/" \
  "$SOURCE_DIR/.github/workflows/auto-fix-ci.yml" \
  > .github/workflows/auto-fix-ci.yml

# ── Copy ci-fix-cleanup.yml (identical for all repos) ────────────────────────
cp "$SOURCE_DIR/.github/workflows/ci-fix-cleanup.yml" .github/workflows/ci-fix-cleanup.yml

# ── Copy the autofix script ──────────────────────────────────────────────────
cp "$SOURCE_DIR/scripts/autofix-openrouter.mjs" scripts/autofix-openrouter.mjs

# ── Commit and push ───────────────────────────────────────────────────────────
git add .github/workflows/auto-fix-ci.yml \
        .github/workflows/ci-fix-cleanup.yml \
        scripts/autofix-openrouter.mjs

git -c user.name="CI Fixer Installer" \
    -c user.email="autofix@trained-assist.bot" \
    commit -m "ci: add CI auto-fixer (auto-fix + new-PR flow)

Watches \"${CI_WORKFLOW_NAME}\" failures. On failure:
- Diagnoses root cause via 3 free OpenRouter models
- Creates fix/ci-* branch + PR (never touches the original branch)
- Auto-merges fix PR when CI passes
- Closes original PR automatically

Requires OPENROUTER_API_KEY secret — see scripts/autofix-openrouter.mjs"

git push origin "$INSTALL_BRANCH"

# ── Create PR ────────────────────────────────────────────────────────────────
PR_URL=$(gh pr create \
  --repo "$TARGET_REPO" \
  --base "$DEFAULT_BRANCH" \
  --head "$INSTALL_BRANCH" \
  --title "ci: add CI auto-fixer" \
  --body "$(cat <<'EOF'
## CI Auto-Fixer

Adds automatic CI failure recovery using free OpenRouter models.

### How it works

1. When CI fails on a PR, `auto-fix-ci.yml` triggers
2. 3-stage OpenRouter pipeline (deepseek-r1 → gemini-flash-lite → qwen3) diagnoses and patches
3. Creates a new `fix/ci-*` branch + PR — **never pushes to the original branch**
4. Enables auto-merge on the fix PR
5. Comments on the original PR with a link to the fix
6. `ci-fix-cleanup.yml` closes the original PR after the fix PR merges

### Race conditions handled
- Original PR closed/merged before fix starts → abort
- Fix PR already exists for this branch → skip (no duplicates)
- Fix branch is itself a `fix/ci-*` → skip (no meta-loops)

### Required secret

Add `OPENROUTER_API_KEY` to repo **Settings → Secrets → Actions**.
Get a free key at https://openrouter.ai — the models used are all free tier.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)")

echo ""
echo "✅ Done! PR created: $PR_URL"
echo ""
echo "⚠️  One required step:"
echo "   Add OPENROUTER_API_KEY to $TARGET_REPO repo secrets:"
echo "   https://github.com/$TARGET_REPO/settings/secrets/actions"
echo ""
echo "   Get a free key at: https://openrouter.ai"
