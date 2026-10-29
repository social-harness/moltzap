#!/usr/bin/env bash
# Install dependencies and build package outputs in a fresh worktree.
#
# Workspace packages resolve each other through built outputs. Run this after
# creating a worktree, using the repository's Node and pnpm versions.
#
# Usage:
#   git worktree add ../social-harness-feature -b feature origin/main
#   cd ../social-harness-feature
#   bin/setup-worktree.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> pnpm install (root: $ROOT)"
pnpm install

echo "==> pnpm build"
pnpm build

echo
echo "Worktree ready. node_modules populated and dist/ built."
