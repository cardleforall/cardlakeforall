#!/usr/bin/env bash
# Replaces this copy's code with a newer Cardlake, for the "Update Cardlake"
# workflow (.github/workflows/update-cardlake.yml).
#
#   scripts/update_from_upstream.sh <cardlake-commit> [--overwrite]
#
# A copy made with the Deploy button shares no history with Cardlake, so
# this doesn't merge. Instead it checks that the copy's files are exactly
# those of some Cardlake version, meaning the owner hasn't changed them, and
# then commits the new version's files on top. --overwrite updates anyway
# and loses the owner's changes.
#
# Workflow files are left as they are: the workflow's token isn't allowed
# to change them. The Deploy button's copy starts without them and without
# .env.example, so neither counts as a change.
set -euo pipefail

upstream="${1:?usage: update_from_upstream.sh <cardlake-commit> [--overwrite]}"
overwrite="${2:-}"
workflows='.github/workflows'

say() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

# A fingerprint of every file's path and content in a commit, except the
# workflows and .env.example. File modes are left out, in case a copy didn't
# keep them.
fingerprint() {
  git ls-tree -r "$1" | cut -d' ' -f3- \
    | { grep -v -F -e "$(printf '\t')$workflows/" -e "$(printf '\t').env.example" || true; } \
    | git hash-object --stdin
}

mine="$(fingerprint HEAD)"
if [ "$mine" = "$(fingerprint "$upstream")" ]; then
  say "Your Cardlake is already up to date."
  exit 0
fi

if [ "$overwrite" != "--overwrite" ]; then
  known=no
  for commit in $(git rev-list --max-count=2000 "$upstream"); do
    if [ "$(fingerprint "$commit")" = "$mine" ]; then known=yes; break; fi
  done
  if [ "$known" = no ]; then
    say "Nothing was updated: the code in your copy has been changed, and updating would erase those changes. To update anyway and lose them, run Update Cardlake again and tick \"Update even though I changed the code\"."
    exit 3
  fi
fi

# Take the new version's files, including deletions, then put this copy's
# workflows back.
git read-tree -u --reset "$upstream"
git rm -r -q --cached --ignore-unmatch -- "$workflows"
rm -rf -- "$workflows"
if [ -n "$(git ls-tree HEAD -- "$workflows")" ]; then
  git checkout HEAD -- "$workflows"
fi
git commit -q -m "Update Cardlake to $(git rev-parse --short "$upstream")"
say "Updated Cardlake to $(git rev-parse --short "$upstream"). Vercel deploys it in a minute or two."

if ! git diff --quiet HEAD "$upstream" -- "$workflows"; then
  say "Cardlake's own GitHub workflows (in $workflows) changed too, and this update can't change those. Your Cardlake works without them; to get them, copy those files from Cardlake's repository into yours."
fi
