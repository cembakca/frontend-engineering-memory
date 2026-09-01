#!/usr/bin/env bash
# Triggers an incremental sync for one repository at one commit.
#
# Safe as the only trigger: a repository that has never been indexed falls back
# to a full index, and a head that is not a descendant of the last indexed SHA
# does the same. The service queues writes, so concurrent pipelines cannot
# interleave two index runs.
set -euo pipefail

: "${FRONTEND_MEMORY_URL:?FRONTEND_MEMORY_URL is required}"
: "${MEMORY_REPOSITORY_NAME:?MEMORY_REPOSITORY_NAME is required}"
COMMIT="${MEMORY_COMMIT_SHA:-${GIT_COMMIT:-}}"
: "${COMMIT:?MEMORY_COMMIT_SHA or GIT_COMMIT is required}"

if [[ ! "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Expected a full 40-character commit SHA, got: $COMMIT" >&2
  exit 1
fi

# Indexing clones or fetches, so allow it real time before giving up.
curl --fail --silent --show-error --max-time "${MEMORY_SYNC_TIMEOUT:-900}" \
  -X POST "$FRONTEND_MEMORY_URL/sync" \
  -H 'content-type: application/json' \
  -d "{\"repository\":\"$MEMORY_REPOSITORY_NAME\",\"commit\":\"$COMMIT\"}"
