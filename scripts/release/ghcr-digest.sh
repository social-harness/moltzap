#!/usr/bin/env bash
# Print the digest a ghcr.io tag names, telling absence apart from a registry
# that could not answer.
#
# Usage: ghcr-digest.sh ghcr.io/<owner>/<name>:<tag>
# Exit 0: the tag exists; its digest is on stdout. Exit 1: ghcr has no such
# tag, or no such package yet. Exit 2: any other failure, reported on stderr.
# The images workflow treats only a confirmed absence as "missing": a failed
# lookup read as missing would rebuild an image and retag a key that already
# names one.
#
# A tag missing from an existing package answers "not found". A package that
# does not exist yet, before an image's first publication, answers like a
# denied pull, so that answer counts as absent only when the GitHub packages
# API also answers 404 for the package. That call uses GH_TOKEN.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 ghcr.io/<owner>/<name>:<tag>" >&2; exit 2; }
if [[ ! "$1" =~ ^ghcr\.io/([a-z0-9-]+)/([a-z0-9._-]+):[A-Za-z0-9._-]+$ ]]; then
  echo "not a ghcr.io tag reference: $1" >&2
  exit 2
fi
owner=${BASH_REMATCH[1]}
name=${BASH_REMATCH[2]}

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT

if digest=$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}' 2>"$errors"); then
  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "ghcr answered $1 with an unreadable digest: $digest" >&2
    exit 2
  fi
  echo "$digest"
  exit 0
fi
if grep -Eqi 'manifest unknown|: not found' "$errors"; then
  exit 1
fi
if grep -Eqi 'denied|forbidden|unauthorized' "$errors"; then
  if ! answer=$(gh api "orgs/$owner/packages/container/$name" --silent 2>&1); then
    if grep -q 'HTTP 404' <<<"$answer"; then
      exit 1
    fi
  fi
fi
echo "ghcr lookup of $1 failed without a confirmed absence: $(tr '\n' ' ' <"$errors")" >&2
exit 2
