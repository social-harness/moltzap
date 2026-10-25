#!/bin/bash
# Decide whether Social Harness needs a release from GITHUB_SHA's tree.
# origin/main must be freshly fetched; RELEASE_PACKAGES names published packages.
# Output: release or skip on stdout, the reason on stderr. Unreadable metadata
# fails instead of silently suppressing a release. Only the dispatch plan owns
# resumption, version selection and notification retries.
set -euo pipefail

if [[ "$(git rev-parse origin/main)" != "$GITHUB_SHA" ]]; then
  echo '::notice::A queued run releases the newer main tip.' >&2
  echo skip
  exit 0
fi
subject=$(git log -1 --format=%s "$GITHUB_SHA")
if [[ "$subject" == 'chore(release): moltzap@'* ]]; then
  echo '::notice::The release commit dispatches its own publication.' >&2
  echo skip
  exit 0
fi
fragments=$(git ls-tree -r --name-only "$GITHUB_SHA" -- changelog.d/)
fragments=$(grep -vFx 'changelog.d/template.md' <<<"$fragments" || true)
if [[ -z "$fragments" ]]; then
  echo '::notice::No changelog fragments need a release.' >&2
  echo skip
  exit 0
fi
release_line=$(git log origin/main --format='%H %s' |
  grep -m1 ' chore(release): moltzap@' || true)
release_commit=${release_line%% *}
if [[ -z "$release_commit" ]]; then
  echo '::notice::No release wire baseline exists; use workflow_dispatch.' >&2
  echo skip
  exit 0
fi
wire_path=packages/client/package.json
if ! head_wire=$(git show "$GITHUB_SHA:$wire_path" |
  jq -er '.sharnessWireVersion | strings | select(length > 0)') ||
  ! release_wire=$(git show "$release_commit:$wire_path" |
    jq -er '.sharnessWireVersion | strings | select(length > 0)'); then
  echo "ERROR: Cannot read sharnessWireVersion from $wire_path. Docs: https://docs.moltzap.xyz/spec/layer-interfaces#publication-and-versions" >&2
  exit 1
fi
if [[ "$head_wire" != "$release_wire" ]]; then
  echo '::notice::WIRE_VERSION differs from the last release; reset releases require workflow_dispatch.' >&2
  echo skip
  exit 0
fi
deleted=$(git diff-tree --root --no-commit-id --name-only -r \
  --no-renames --diff-filter=D "$release_commit" -- changelog.d/)
while IFS= read -r fragment; do
  if grep -qxF "$fragment" <<<"$deleted"; then
    echo "::notice::Restored release fragment $fragment; skipping a reverted release." >&2
    echo skip
    exit 0
  fi
done <<<"$fragments"
for pkg in $RELEASE_PACKAGES; do
  manifest="packages/$pkg/package.json"
  if ! head_version=$(git show "$GITHUB_SHA:$manifest" | jq -er '.version | strings') ||
    ! release_version=$(git show "$release_commit:$manifest" | jq -er '.version | strings'); then
    echo "ERROR: Cannot read version from $manifest. Docs: https://docs.moltzap.xyz/spec/layer-interfaces#publication-and-versions" >&2
    exit 1
  fi
  if [[ "$head_version" != "$release_version" &&
    "$(printf '%s\n' "$head_version" "$release_version" | sort -V | head -n1)" == "$head_version" ]]; then
    echo "::notice::$manifest is older than the last release; skipping a reverted release." >&2
    echo skip
    exit 0
  fi
done
echo '::notice::Changelog fragments need a Social Harness release.' >&2
echo release
