#!/bin/sh
# keeper's nightly run, from the memory repo. Usage: .keeper/run.sh [nightly|audit]
# The same script runs from cron on your machine and from the GitHub Action.
# It commits; it never pushes. The caller decides whether to push or open a pull request.
set -u
cd "$(dirname "$0")/.." || exit 1
mode=${1:-nightly}
day=$(date +%F)
mkdir -p log/keeper

export KEEPER_OFF=1   # the keeper's own session is not one of yours: no rules, no corrections captured
prompt="$(cat .keeper/KEEPER.md)

Tonight is $day. Mode: $mode."
claude -p "$prompt" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(ls:*),Bash(rm inbox/*)" \
  > "log/keeper/$day-$mode.out" 2>&1
rc=$?

# what the keeper may not change, put back whatever it did
git checkout -q HEAD -- gates.json .keeper 2>/dev/null
git add -A
if git diff --cached --quiet; then echo "keeper $mode: nothing changed (claude exit $rc)"; exit $rc; fi
git commit -qm "keeper: $mode $day" && echo "keeper $mode: committed (claude exit $rc)"
exit $rc
