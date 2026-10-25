#!/usr/bin/env bash
# Operate on the example's canonical Registry and Router digest references.
# pin <file> <service> <ref@digest> edits exactly one existing service reference.
# refs <file> prints Registry then Router, requiring exactly one digest each.
# normalize <file> prints a complete file with digest placeholders for comparison.
# Only shell builtins, grep, sed and mv run here: the release push job installs nothing.
set -euo pipefail

# Require one complete digest reference, including when duplicate values agree.
# Arguments: file, service. Outputs: reference on stdout or error on stderr.
service_ref() {
  local file="$1" service="$2" matches
  matches=$(grep -oE "ghcr[.]io/social-harness/$service@[^[:space:]\"'\}]+" "$file") || return 1
  if [[ ! "$matches" =~ ^ghcr\.io/social-harness/$service@sha256:[a-f0-9]{64}$ ]]; then
    echo "ERROR: $file must contain exactly one $service digest reference" >&2
    return 1
  fi
  printf '%s\n' "$matches"
}

main() {
  if [[ $# -lt 2 ]]; then
    echo "usage: $0 {pin <file> <service> <ref@digest>|refs <file>|normalize <file>}" >&2
    return 1
  fi
  local operation="$1" file="$2" service ref
  [[ -r "$file" ]] || return 1
  case "$operation" in
    pin)
      [[ $# -eq 4 ]] || return 1
      service="$3"
      [[ "$service" == registry || "$service" == router ]] || return 1
      [[ "$4" =~ ^ghcr\.io/social-harness/$service@sha256:[a-f0-9]{64}$ ]] || return 1
      ref=$(service_ref "$file" "$service") || return 1
      local temporary="$file.tmp.$$.$RANDOM"
      (set -o noclobber; sed "s#${ref/ghcr.io/ghcr[.]io}#$4#" "$file" > "$temporary")
      mv "$temporary" "$file"
      ;;
    refs|normalize)
      [[ $# -eq 2 ]] || return 1
      local registry router
      registry=$(service_ref "$file" registry) || return 1
      router=$(service_ref "$file" router) || return 1
      if [[ "$operation" == refs ]]; then
        printf '%s\n%s\n' "$registry" "$router"
      else
        sed -E 's#(ghcr[.]io/social-harness/(registry|router))@sha256:[a-f0-9]{64}#\1@DIGEST#g' "$file"
      fi
      ;;
    *) return 1 ;;
  esac
}

main "$@"
