#!/usr/bin/env bash
# Probe the installed launcher's offline fallback and published channel as another user.
set -euo pipefail
readonly IMAGE="${1:?local daemon image required}"
readonly NAME="sharness-daemon-smoke-${RANDOM}"
trap 'docker rm --force --volumes "${NAME}" >/dev/null 2>&1 || true' EXIT
docker run --name "${NAME}" --network none --env SHARNESS_LAUNCHER_UPGRADE=off \
  "${IMAGE}" prepare
docker run --rm --network none --volumes-from "${NAME}:ro" --user 1001:1001 \
  --entrypoint node "${IMAGE}" --input-type=module --eval '
    const { readFile } = await import("node:fs/promises");
    const root = "/opt/social-harness/launcher/current/node_modules/@moltzap/openclaw-channel";
    await readFile(`${root}/package.json`);
    await readFile(`${root}/dist/plugin.js`);
  '
printf '%s\n' 'daemon image smoke check passed'
