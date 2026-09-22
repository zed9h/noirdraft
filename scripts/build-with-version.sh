#!/usr/bin/env bash
# Wraps electron-builder to stamp the build number (total commits on the
# current branch) and, off main, the branch name into the artifact filename
# via the BUILD_SUFFIX env var consumed by build.artifactName in package.json.
set -euo pipefail

BUILD_NUMBER=$(git rev-list --count HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$BRANCH" = "main" ]; then
  export BUILD_SUFFIX="$BUILD_NUMBER"
else
  export BUILD_SUFFIX="$BUILD_NUMBER-$BRANCH"
fi

exec electron-builder "$@"
