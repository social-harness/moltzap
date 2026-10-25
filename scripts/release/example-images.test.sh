#!/usr/bin/env bash
# Exercise Compose pinning, completeness and normalization without Docker or a registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/example-images.sh"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
REGISTRY="ghcr.io/social-harness/registry@sha256:$(printf 'a%.0s' {1..64})"
ROUTER="ghcr.io/social-harness/router@sha256:$(printf 'b%.0s' {1..64})"
NEW_REGISTRY="ghcr.io/social-harness/registry@sha256:$(printf 'c%.0s' {1..64})"
NEW_ROUTER="ghcr.io/social-harness/router@sha256:$(printf 'd%.0s' {1..64})"
FILE="$TEMP_DIR/compose.yaml"
PASS=0
FAIL=0

check() {
  local name="$1" expected_exit="$2" expected_output="$3"
  shift 3
  local status=0 output
  output=$("$@" 2>/dev/null) || status=$?
  if [[ "$status" == "$expected_exit" && "$output" == "$expected_output" ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name — expected exit $expected_exit and '$expected_output', got $status and '$output'"
    FAIL=$((FAIL + 1))
  fi
}

main() {
  cat > "$FILE" <<YAML
services:
  registry:
    image: \${SHARNESS_REGISTRY_IMAGE:-$REGISTRY}
  router:
    image: \${SHARNESS_ROUTER_IMAGE:-$ROUTER}
    ports: [3002:3002]
YAML
  local original normalized
  original=$(cat "$FILE")
  normalized=$(printf '%s\n' "$original" | sed -E 's#@sha256:[a-f0-9]{64}#@DIGEST#g')
  check "both references are returned in service order" 0 "$REGISTRY"$'\n'"$ROUTER" "$SCRIPT" refs "$FILE"
  check "normalization preserves the rest of Compose" 0 "$normalized" "$SCRIPT" normalize "$FILE"
  check "Registry pin succeeds" 0 "" "$SCRIPT" pin "$FILE" registry "$NEW_REGISTRY"
  check "Router pin succeeds" 0 "" "$SCRIPT" pin "$FILE" router "$NEW_ROUTER"
  check "pins replace both references" 0 "$NEW_REGISTRY"$'\n'"$NEW_ROUTER" "$SCRIPT" refs "$FILE"
  check "normalization ignores only digest changes" 0 "$normalized" "$SCRIPT" normalize "$FILE"
  printf '\n# another setting\n' >> "$FILE"
  check "normalization retains non-digest changes" 0 "$normalized"$'\n\n# another setting' "$SCRIPT" normalize "$FILE"
  check "cross-service pin is refused" 1 "" "$SCRIPT" pin "$FILE" registry "$NEW_ROUTER"
  check "tag-only pin is refused" 1 "" "$SCRIPT" pin "$FILE" registry ghcr.io/social-harness/registry:latest
  printf '%s\n' "$REGISTRY" > "$FILE"
  check "missing Router fails completeness" 1 "" "$SCRIPT" refs "$FILE"
  check "missing Router fails normalization" 1 "" "$SCRIPT" normalize "$FILE"
  check "pin with no reference to replace fails" 1 "" "$SCRIPT" pin "$FILE" router "$NEW_ROUTER"
  check "a failed pin preserves the file" 0 "$REGISTRY" cat "$FILE"
  printf '%s\n%s\n%s\n' "$REGISTRY" "$ROUTER" "$ROUTER" > "$FILE"
  check "duplicate identical digests fail" 1 "" "$SCRIPT" refs "$FILE"
  check "duplicate pins fail" 1 "" "$SCRIPT" pin "$FILE" router "$NEW_ROUTER"
  printf '%s\n%s\n%s\n' "$REGISTRY" "$ROUTER" "$NEW_ROUTER" > "$FILE"
  check "different digests for one service fail" 1 "" "$SCRIPT" refs "$FILE"
  printf '%s\n%s0\n' "$REGISTRY" "$ROUTER" > "$FILE"
  check "overlong digests fail" 1 "" "$SCRIPT" refs "$FILE"
  printf '%s\n%s-invalid\n' "$REGISTRY" "$ROUTER" > "$FILE"
  check "digest suffixes fail" 1 "" "$SCRIPT" refs "$FILE"
  printf '%s\n%s\n' "$REGISTRY" "${ROUTER%?}" > "$FILE"
  check "short digests fail" 1 "" "$SCRIPT" refs "$FILE"
  printf 'services: {}\n' > "$FILE"
  check "no references fails completeness" 1 "" "$SCRIPT" refs "$FILE"
  printf '%s\n' "$ROUTER" > "$FILE"
  check "missing Registry fails completeness" 1 "" "$SCRIPT" refs "$FILE"
  local example="$SCRIPT_DIR/../../examples/two-agents/compose.yaml"
  local placeholder
  placeholder=$(printf '0%.0s' {1..64})
  check "the example's Compose file names each image once" 0 \
    "ghcr.io/social-harness/registry@sha256:$placeholder"$'\n'"ghcr.io/social-harness/router@sha256:$placeholder" \
    "$SCRIPT" refs "$example"
  cp "$example" "$FILE"
  check "the example's Compose file pins the Registry" 0 "" "$SCRIPT" pin "$FILE" registry "$NEW_REGISTRY"
  check "the pinned example keeps the Router" 0 "$NEW_REGISTRY"$'\n'"ghcr.io/social-harness/router@sha256:$placeholder" "$SCRIPT" refs "$FILE"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  [[ "$FAIL" -eq 0 ]]
}

main "$@"
