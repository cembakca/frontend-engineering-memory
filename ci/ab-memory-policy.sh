#!/usr/bin/env bash
# RCE-002 live A/B helper.
#
# The pilot's CLAUDE.md is `@AGENTS.md`, so the memory-first policy block loads
# into every Claude Code session in that repository. A baseline (memory-off) run
# must not carry an instruction to use a server it cannot reach, so the block is
# parked in a backup file for the duration of the baseline sessions.
#
#   ci/ab-memory-policy.sh off   # before the 5 baseline sessions
#   ci/ab-memory-policy.sh on    # restore before the 5 context-engine sessions
#
# Only the frontend-engineering-memory block is touched. The Next.js agent-rules
# block and every other uncommitted change stay exactly as they are.
set -euo pipefail

PILOT="${PILOT_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hangikredi.aboutus.fe.next" && pwd)}"
AGENTS="$PILOT/AGENTS.md"
PARKED="$PILOT/.agents-memory-block.parked"

[ -f "$AGENTS" ] || { echo "AGENTS.md not found: $AGENTS" >&2; exit 1; }

case "${1:-}" in
  off)
    [ -f "$PARKED" ] && { echo "already off"; exit 0; }
    python3 "$(dirname "${BASH_SOURCE[0]}")/ab-memory-policy.py" park "$AGENTS" "$PARKED"
    echo "memory-first policy parked -> $PARKED"
    ;;
  on)
    [ -f "$PARKED" ] || { echo "already on"; exit 0; }
    python3 "$(dirname "${BASH_SOURCE[0]}")/ab-memory-policy.py" restore "$AGENTS" "$PARKED"
    rm "$PARKED"
    echo "memory-first policy restored in $AGENTS"
    ;;
  *)
    echo "usage: $0 off|on" >&2; exit 2
    ;;
esac
