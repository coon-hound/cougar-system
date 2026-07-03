#!/usr/bin/env bash
# Verify → commit → push → open a PR carrying the evidence. Run inside a worktree.
#
#   scripts/ship.sh "<commit/PR title>"
#
# Refuses to push if the verification gate fails, so a red branch never becomes a
# PR. The PR body is EVIDENCE.md (captured test output + manual-test steps), which
# is also committed to the branch as the durable "one-look" artifact.
set -euo pipefail

title="${1:?usage: ship.sh \"<title>\"}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
branch="$(git rev-parse --abbrev-ref HEAD)"
slug="$(echo "$branch" | sed 's#.*/##')"

bash scripts/verify.sh "$slug"

git add -A
git commit -m "$title" || echo "(nothing to commit — already committed)"
git push -u origin "$branch"

if command -v gh >/dev/null 2>&1; then
  gh pr create --title "$title" --body-file EVIDENCE.md --base master --head "$branch" \
    || gh pr edit "$branch" --body-file EVIDENCE.md
  gh pr view "$branch" --web >/dev/null 2>&1 || true
else
  echo "gh not found — pushed $branch; open the PR manually."
fi
