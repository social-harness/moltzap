#!/bin/bash
# Decide whether a push skips, resumes, bumps, or retries notification.
# Arguments: last release commit (or empty), packages still owed (or empty).
# GITHUB_SHA names the push head; origin/main must be freshly fetched. The plan
# owns completeness checks and resumption. Release-commit pushes always skip,
# and a stale push with nothing to resume exits successfully. Fragment and wire
# comparisons use committed trees, so a queued run cannot reuse consumed notes.
# GITHUB_RUN_ATTEMPT defaults to 1. RETRY_RELEASE_COMMIT, when present, comes
# from this run's saved plan; it ties a notification retry to its own release.
# Output: skip, resume, notify, or bump on stdout; reset notices on stderr.
set -euo pipefail

release_commit="$1"
unfinished="$2"
subject=$(git log -1 --format=%s "$GITHUB_SHA")
if [[ "$subject" == 'chore(release): moltzap@'* ]]; then
  echo skip
  exit 0
fi
if [[ -n "$unfinished" ]]; then
  echo resume
  exit 0
fi
if [[ -n "$release_commit" && "${GITHUB_RUN_ATTEMPT:-1}" -gt 1 ]] &&
  { [[ "$release_commit" == "${RETRY_RELEASE_COMMIT:-}" ]] ||
    [[ "$release_commit" == "$GITHUB_SHA" ]] ||
    [[ "$(git log -1 --format=%P "$release_commit")" == "$GITHUB_SHA" ]]; }; then
  echo notify
  exit 0
fi
if [[ "$(git rev-parse origin/main)" != "$GITHUB_SHA" ]]; then
  echo skip
  exit 0
fi
fragments=$(git ls-tree -r --name-only "$GITHUB_SHA" -- changelog.d/)
if ! grep -qvFx 'changelog.d/template.md' <<<"${fragments:-changelog.d/template.md}"; then
  echo skip
  exit 0
fi
if [[ -z "$release_commit" ]]; then
  echo '::notice::No release wire baseline exists; use workflow_dispatch.' >&2
  echo skip
  exit 0
fi
wire_path=packages/client/src/identity/wire-version.ts
head_wire=$(git show "$GITHUB_SHA:$wire_path" |
  sed -nE 's/^export const WIRE_VERSION = "([^"]+)";$/\1/p')
release_wire=$(git show "$release_commit:$wire_path" |
  sed -nE 's/^export const WIRE_VERSION = "([^"]+)";$/\1/p')
if [[ -z "$head_wire" || -z "$release_wire" || "$head_wire" != "$release_wire" ]]; then
  echo '::notice::WIRE_VERSION differs from the last release or cannot be read; reset releases require workflow_dispatch.' >&2
  echo skip
  exit 0
fi
echo bump
