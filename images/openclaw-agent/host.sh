#!/usr/bin/env bash
# Host command for the OpenClaw agent image: import the pairing seed, bind
# the run's Claude Code token profile or import its Codex login, then become
# the gateway.
#
# The bootstrap writes `devices/paired.json` at every Pod start, and the
# gateway reads paired devices only from OpenClaw's SQLite state; OpenClaw
# leaves importing file state to `doctor`, which its own image entrypoint
# runs before the gateway. `doctor` imports the devices that state lacks and
# archives the file as `paired.json.migrated`. Without `--fix` it leaves
# openclaw.json as configured. After the bootstrap merge and before doctor,
# configure-channel.ts selects the channel load path in the host settings.
#
# OpenClaw forwards a subscription token to the `claude` child only from a
# stored auth profile, and it rejects a token reference written into
# openclaw.json. So when the launcher delivers a secrets plan
# (OPENCLAW_SECRETS_PLAN), this script applies it once against the fresh
# per-pod state before the gateway exists. The plan names an environment
# variable and never carries a value.
#
# OpenClaw's Codex harness authenticates only from an `openai` profile in
# the agent's own auth store; it never reads a Codex CLI login in
# `$CODEX_HOME/auth.json`. When the run delivers that login (the
# CODEX_AUTH_JSON credential, a ChatGPT subscription sign-in), this script
# imports it with OpenClaw's Codex migration, once: after that OpenClaw owns
# the refresh token, and importing the delivered file again would replace a
# token OpenClaw refreshed with the older one. The import skips OpenClaw's
# pre-migration backup, which would copy the login into an archive in the
# state directory.
#
# A failed step ends the host with that step's exit status, so the run
# reports an agent start failure instead of a gateway that cannot
# authenticate. The gateway then replaces this shell, so it receives the
# entrypoint's signals and reports its own exit status with no relay in
# between. OPENCLAW_ENTRY stands in for OpenClaw in the tests.
set -euo pipefail

readonly ENTRY="${OPENCLAW_ENTRY:-/app/openclaw.mjs}"
readonly CODEX_LOGIN_HOME="${CODEX_HOME:-${HOME}/.codex}"

if ! node "$(dirname "${BASH_SOURCE[0]}")/configure-channel.ts"; then
  echo "[social harness openclaw host] channel configuration failed; not starting OpenClaw" >&2
  exit 1
fi

#######################################
# Run one OpenClaw command before the gateway, ending the host if it fails.
# Arguments:
#   The step's name for the error message, then OpenClaw's arguments.
# Outputs:
#   Writes a failed step's exit status to STDERR.
#######################################
prepare() {
  local -r step="$1"
  shift
  local status=0
  node "${ENTRY}" "$@" || status=$?
  if ((status != 0)); then
    echo "[social harness openclaw host] ${step} exited ${status}; not starting the gateway" >&2
    exit "${status}"
  fi
}

#######################################
# Whether the agent's auth store already holds an `openai` profile.
# Globals:
#   ENTRY
# Returns:
#   0 when it does, nonzero when it does not or the listing fails.
#######################################
has_openai_profile() {
  node "${ENTRY}" models auth list --provider openai --json 2>/dev/null \
    | node --input-type=module --eval \
      'const { profiles } = JSON.parse(await new Response(process.stdin).text());
       process.exit(profiles.length > 0 ? 0 : 1);'
}

prepare doctor doctor --non-interactive
if [[ -f "${CODEX_LOGIN_HOME}/auth.json" ]] && ! has_openai_profile; then
  prepare "codex login import" migrate apply codex \
    --from "${CODEX_LOGIN_HOME}" --item auth:openai --include-secrets \
    --no-backup --force --yes
fi
if [[ -n "${OPENCLAW_SECRETS_PLAN:-}" ]]; then
  prepare "secrets apply" secrets apply --from "${OPENCLAW_SECRETS_PLAN}"
fi

exec node "${ENTRY}" gateway run --allow-unconfigured --port 18789
