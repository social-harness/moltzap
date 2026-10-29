#!/usr/bin/env bash
# The native hook runtime must supply wake/silent helpers. The installed
# wrapper supplies absolute command and state paths. This detector needs no
# Client credential and emits event references only. One receiver waits on one
# delivery; an array also permits an old attempt to overlap its replacement.
set -euo pipefail

source "${HATCH_HOOK_RUNTIME:?Muse hook runtime is required. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/muse#native-hook}"
: "${SHARNESS_MUSE_COMMAND:?The installed command path is required. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/muse#native-hook}"
: "${SHARNESS_MUSE_STATE_DIR:?The state directory is required. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/muse#native-hook}"
: "${SHARNESS_NODE_EXECUTABLE:?The Node executable is required. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/muse#native-hook}"

if ! references="$(SHARNESS_MUSE_OPERATION=detect \
  "${SHARNESS_NODE_EXECUTABLE}" "${SHARNESS_MUSE_COMMAND}")"; then
  silent "Muse detector unavailable. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/muse#handoff-failed" '{}'
  exit 1
fi

if [[ -z "${references}" ]]; then
  silent "Social Harness idle" '{}'
else
  payload="$(jq -cs '{references: .}' <<< "${references}")"
  wake "Social Harness incoming work" "${payload}"
fi
