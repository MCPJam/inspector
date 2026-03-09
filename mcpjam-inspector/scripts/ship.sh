#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { echo -e "\n${CYAN}${BOLD}[$1]${RESET} $2"; }
success() { echo -e "${GREEN}✓${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; exit 1; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
dim() { echo -e "${DIM}$1${RESET}"; }

# ── Preflight checks ────────────────────────────────────────────────
step "Preflight" "Checking prerequisites..."

for cmd in gt gh node npm; do
  command -v "$cmd" &>/dev/null || fail "'$cmd' is not installed. Install it before running this script."
done
success "All required CLIs found (gt, gh, node, npm)"

# Ensure we're in a git repo
git rev-parse --is-inside-work-tree &>/dev/null || fail "Not inside a git repository."

# Ensure working tree is clean (allow untracked files)
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "You have uncommitted changes."
  read -rp "Continue anyway? (y/N): " CONTINUE
  [[ "$CONTINUE" =~ ^[Yy]$ ]] || exit 0
fi

BRANCH=$(git branch --show-current)
echo -e "  Branch: ${BOLD}${BRANCH}${RESET}"

# ── Step 1: Gather user input ───────────────────────────────────────
step "1/4" "How would you like to ship this?"

echo ""
echo -e "  ${BOLD}a)${RESET} Create a new PR (opens editor for title/description)"
echo -e "  ${BOLD}b)${RESET} Create a new PR with AI-generated title/description"
echo -e "  ${BOLD}c)${RESET} Update an existing PR (push latest changes)"
echo -e "  ${BOLD}d)${RESET} Submit as part of a stack"
echo ""
read -rp "Choose [a/b/c/d] (default: a): " SHIP_MODE
SHIP_MODE=${SHIP_MODE:-a}

GT_ARGS=()

case "$SHIP_MODE" in
  a)
    GT_ARGS+=(--edit)
    ;;
  b)
    GT_ARGS+=(--ai --no-edit)
    ;;
  c)
    GT_ARGS+=(--update-only --no-edit)
    ;;
  d)
    GT_ARGS+=(--stack --edit)
    read -rp "Use AI-generated title/description? (y/N): " USE_AI
    if [[ "$USE_AI" =~ ^[Yy]$ ]]; then
      # Replace --edit with --ai --no-edit
      GT_ARGS=(--stack --ai --no-edit)
    fi
    ;;
  *)
    fail "Invalid option: $SHIP_MODE"
    ;;
esac

# Ask about reviewers
read -rp "Add reviewers? (comma-separated GitHub handles, or press Enter to skip): " REVIEWERS
if [[ -n "$REVIEWERS" ]]; then
  GT_ARGS+=(--reviewers "$REVIEWERS")
fi

# Draft or ready?
read -rp "Submit as draft? (y/N): " AS_DRAFT
[[ "$AS_DRAFT" =~ ^[Yy]$ ]] && GT_ARGS+=(--draft)

# ── Step 2: Run tests ───────────────────────────────────────────────
step "2/4" "Running tests..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if npm run test --prefix "$PROJECT_DIR" 2>&1; then
  success "All tests passed"
else
  fail "Tests failed. Fix them before shipping."
fi

# ── Step 3: Submit PR via Graphite ──────────────────────────────────
step "3/4" "Submitting PR via Graphite..."

dim "Running: gt submit --publish ${GT_ARGS[*]:-}"

if gt submit --publish "${GT_ARGS[@]}" 2>&1; then
  success "PR submitted via Graphite"
else
  fail "gt submit failed. Check the output above."
fi

# ── Step 4: Trigger CodeRabbit review ───────────────────────────────
step "4/4" "Requesting CodeRabbit review..."

# Get the PR number for the current branch
PR_NUMBER=$(gh pr view "$BRANCH" --json number --jq '.number' 2>/dev/null || echo "")

if [[ -n "$PR_NUMBER" ]]; then
  gh pr comment "$PR_NUMBER" --body "@coderabbitai review" 2>&1
  success "CodeRabbit review requested on PR #${PR_NUMBER}"
else
  warn "Could not find PR number — you may need to trigger CodeRabbit manually."
fi

# ── Done ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Ship complete!${RESET}"
if [[ -n "$PR_NUMBER" ]]; then
  PR_URL=$(gh pr view "$PR_NUMBER" --json url --jq '.url' 2>/dev/null || echo "")
  [[ -n "$PR_URL" ]] && echo -e "  PR: ${CYAN}${PR_URL}${RESET}"
fi
echo ""
