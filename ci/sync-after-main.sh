#!/usr/bin/env bash
# Notifies the memory service that main moved.
#
# Safe as the only trigger: a repository that has never been indexed falls back
# to a full index, and a head that is not a descendant of the last indexed SHA
# does the same. The service queues writes and joins a run already in flight for
# the same commit, so concurrent pipelines cannot interleave two index runs.
#
# Required: FRONTEND_MEMORY_URL, MEMORY_REPOSITORY_NAME, and a commit (either
# MEMORY_COMMIT_SHA or Jenkins' own GIT_COMMIT).
# Recommended: MEMORY_WEBHOOK_SECRET, which the service requires from any host
# that is not loopback.
set -euo pipefail

: "${FRONTEND_MEMORY_URL:?FRONTEND_MEMORY_URL is required}"
: "${MEMORY_REPOSITORY_NAME:?MEMORY_REPOSITORY_NAME is required}"
COMMIT="${MEMORY_COMMIT_SHA:-${GIT_COMMIT:-}}"
: "${COMMIT:?MEMORY_COMMIT_SHA or GIT_COMMIT is required}"

if [[ ! "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Expected a full 40-character commit SHA, got: $COMMIT" >&2
  exit 1
fi

# wait=1 so the build fails when indexing fails, rather than reporting success
# for a snapshot the engine never took.
curl --fail --silent --show-error --max-time "${MEMORY_SYNC_TIMEOUT:-900}" \
  -X POST "${FRONTEND_MEMORY_URL}/webhook?wait=1" \
  -H 'content-type: application/json' \
  ${MEMORY_WEBHOOK_SECRET:+-H "x-memory-token: ${MEMORY_WEBHOOK_SECRET}"} \
  -d "{\"repository\":\"${MEMORY_REPOSITORY_NAME}\",\"commit\":\"${COMMIT}\"}"
