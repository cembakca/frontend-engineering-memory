#!/usr/bin/env bash
set -euo pipefail

: "${FRONTEND_MEMORY_URL:?FRONTEND_MEMORY_URL is required}"
: "${MEMORY_REPOSITORY_NAME:?MEMORY_REPOSITORY_NAME is required}"
: "${MEMORY_COMMIT_SHA:?MEMORY_COMMIT_SHA is required}"

curl --fail --silent --show-error \
  -X POST "$FRONTEND_MEMORY_URL/sync" \
  -H 'content-type: application/json' \
  -d "{\"repository\":\"$MEMORY_REPOSITORY_NAME\",\"commit\":\"$MEMORY_COMMIT_SHA\"}"
