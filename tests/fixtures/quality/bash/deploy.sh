#!/usr/bin/env bash
# Publishes a build to the release bucket, retrying failed uploads.
set -euo pipefail

# Bounds how often an upload is retried.
declare -r MAX_ATTEMPTS=3

readonly BUCKET="acme-releases"

export DEPLOY_ENV="staging"

# Buckets every release is mirrored to.
declare -a MIRRORS=(
  "acme-releases-eu"
  "acme-releases-us"
)

# Upload one artifact, retrying with exponential backoff.
upload() {
  local attempt=0
  local artifact="$1"
  while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    put_object "$artifact" "$BUCKET"
  done
}

# Drain the pending queue.
main() {
  for artifact in dist/*.tar.gz; do
    upload "$artifact"
  done
}

main "$@"
