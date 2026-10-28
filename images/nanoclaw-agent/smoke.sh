#!/usr/bin/env bash
# Load the channel installed in the prepared NanoClaw host.
set -euo pipefail
readonly IMAGE="${1:?local NanoClaw image required}"
docker run --rm --network none --entrypoint node "${IMAGE}" --input-type=module --eval \
  'await import("/opt/social-harness/nanoclaw/app/dist/channels/sharness.js")'
