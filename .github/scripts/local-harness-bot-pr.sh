#!/usr/bin/env bash
# Commit what the caller staged to ONE bot branch and open, or refresh, its ONE
# pull request — for the local-harness revocation list
# (`local-harness-revocations.yml`). Pack pins no longer use it: they ride in
# the version PR that `prepare-release.yml` opens.
#
#   bash .github/scripts/local-harness-bot-pr.sh '<{"branch","title","body"} JSON>'
#
# The branch is rebuilt from the checked-out commit and force-pushed every
# time: a newer run's pin replaces an older one, so there is never more than
# one OPEN PR per harness and never a stale pin stacked under a fresh one.
# Auto-merge is requested; the approval rule on main still applies — that
# review is the one human gate on what users download.
#
# An approval belongs to the bytes it saw. The rulesets on main keep approvals
# across pushes, so force-pushing a different pin onto an approved PR would
# let it merge on the old approval. A run whose tree differs from the open
# PR's therefore closes that PR and opens a fresh one; a re-run with the same
# tree keeps the PR and its approval.
#
# Needs GH_TOKEN set to a token whose pushes start workflows (RELEASE_PUSH_TOKEN):
# GitHub runs no checks for a push made with GITHUB_TOKEN, and a PR without its
# required checks can never merge.
set -euo pipefail

text="$1"
branch="$(jq -r .branch <<<"$text")"
title="$(jq -r .title <<<"$text")"
body="$(jq -r .body <<<"$text")"
case "$branch" in
  bot/local-harness-pack-*) ;;
  *) echo "refusing to push $branch: not a local-harness pack bot branch" >&2; exit 1 ;;
esac

if git diff --cached --quiet; then
  echo "nothing staged: main already carries this"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -C "$branch"
git commit -m "$title"
# The checkout persisted no credential (so nothing an install script ran could
# read one); authenticate git for this push from GH_TOKEN, here and only here.
gh auth setup-git

existing="$(gh pr list --head "$branch" --base main --state open --json number --jq '.[0].number // empty')"
if [ -n "$existing" ]; then
  previous_tree=""
  if git fetch --quiet origin "refs/heads/$branch" 2>/dev/null; then
    previous_tree="$(git rev-parse 'FETCH_HEAD^{tree}')"
  fi
  if [ "$previous_tree" != "$(git rev-parse 'HEAD^{tree}')" ]; then
    # Closed BEFORE the push, so no moment exists where the new pin sits under
    # the old approval with auto-merge armed.
    gh pr merge "$existing" --disable-auto >/dev/null 2>&1 || true
    gh pr close "$existing" --comment "Superseded by a newer pin from the pack pipeline. An approval covers the bytes it reviewed, so the new pin opens as a new PR."
    existing=""
  fi
fi

git push --force origin "HEAD:refs/heads/$branch"

if [ -n "$existing" ]; then
  gh pr edit "$existing" --title "$title" --body "$body"
  number="$existing"
else
  url="$(gh pr create --base main --head "$branch" --title "$title" --body "$body")"
  number="${url##*/}"
fi
url="$(gh pr view "$number" --json url --jq .url)"

# Merges itself once approved and green. Not fatal: a repository without
# auto-merge enabled still has a reviewable PR.
if ! gh pr merge "$number" --auto --squash; then
  echo "::warning::could not enable auto-merge on $url; merge it once approved"
fi
echo "Bot PR: $url" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "$url"
