#!/usr/bin/env bash
# Exercise the installed host executables without starting a provider session.
set -euo pipefail
readonly IMAGE="${1:?local OpenClaw image required}"
docker run --rm --network none --entrypoint node "${IMAGE}" /app/openclaw.mjs --version
docker run --rm --network none --entrypoint /home/node/.local/bin/claude "${IMAGE}" --version
