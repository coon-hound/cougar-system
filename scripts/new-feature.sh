#!/usr/bin/env bash
# Create an isolated git worktree + feature branch off master, so an agent (or
# you) can build one feature without disturbing any other in-flight work.
#
#   scripts/new-feature.sh <type> <slug>
#   e.g. scripts/new-feature.sh feat training-programs-ui
#
# Types: feat | fix | chore. The worktree lands at .worktrees/<slug> (git-ignored)
# and the branch is <type>/<slug>. Remove it after merge with:
#   git worktree remove .worktrees/<slug> && git branch -D <type>/<slug>
set -euo pipefail

type="${1:?usage: new-feature.sh <feat|fix|chore> <slug>}"
slug="${2:?usage: new-feature.sh <feat|fix|chore> <slug>}"
case "$type" in feat|fix|chore) ;; *) echo "type must be feat|fix|chore" >&2; exit 2;; esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

wt=".worktrees/${slug}"
branch="${type}/${slug}"

if git show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "branch ${branch} already exists" >&2; exit 1
fi

git worktree add "$wt" -b "$branch" master
echo
echo "  worktree : $root/$wt"
echo "  branch   : $branch (off master)"
echo "  next     : cd $wt  →  make changes  →  bash scripts/verify.sh $slug"
