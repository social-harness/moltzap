#!/usr/bin/env bash
# Tests for ghcr-digest.sh against a mock docker and gh on PATH.
#
# The mock docker answers `docker buildx imagetools inspect` from DOCKER_EXIT,
# DOCKER_STDOUT and DOCKER_STDERR only for the requested Router tag. The mock
# gh answers only the Router package path, from GH_EXIT and GH_STDERR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/ghcr-digest.sh"
DIGEST="sha256:$(printf 'a%.0s' {1..64})"
REF="ghcr.io/social-harness/router:inputs-$(printf 'b%.0s' {1..64})"
PASS=0
FAIL=0

check() {
  local test_name="$1" expected_exit="$2" expected_stdout="$3"
  shift 3
  local actual_exit=0 actual_stdout
  actual_stdout=$("$@" 2>/dev/null) || actual_exit=$?
  if [ "$expected_exit" = "$actual_exit" ] && [ "$expected_stdout" = "$actual_stdout" ]; then
    echo "PASS: $test_name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $test_name — expected exit $expected_exit and '$expected_stdout', got $actual_exit and '$actual_stdout'"
    FAIL=$((FAIL + 1))
  fi
}

MOCK_DIR=$(mktemp -d)
cat > "$MOCK_DIR/docker" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1 $2 $3" != "buildx imagetools inspect" || "$4" != "$EXPECTED_REF" ]]; then
  echo "unexpected image reference: $*" >&2
  exit 2
fi
printf '%s' "${DOCKER_STDOUT:-}"
printf '%s' "${DOCKER_STDERR:-}" >&2
exit "${DOCKER_EXIT:-0}"
MOCK
cat > "$MOCK_DIR/gh" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1 $2" != "api orgs/social-harness/packages/container/router" ]]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
printf '%s' "${GH_STDERR:-}" >&2
exit "${GH_EXIT:-0}"
MOCK
chmod +x "$MOCK_DIR/docker" "$MOCK_DIR/gh"
export PATH="$MOCK_DIR:$PATH"
export EXPECTED_REF="$REF"

cleanup() { rm -rf "$MOCK_DIR"; }
trap cleanup EXIT

DOCKER_EXIT=0 DOCKER_STDOUT="$DIGEST" \
  check "an existing tag prints its digest" 0 "$DIGEST" "$SCRIPT" "$REF"
DOCKER_EXIT=0 DOCKER_STDOUT="latest" \
  check "an unreadable digest is a failure" 2 "" "$SCRIPT" "$REF"
DOCKER_EXIT=1 DOCKER_STDERR="ERROR: $REF: not found" \
  check "a missing tag is absent" 1 "" "$SCRIPT" "$REF"
DOCKER_EXIT=1 DOCKER_STDERR="ERROR: failed to authorize: 403 Forbidden" GH_EXIT=1 GH_STDERR="gh: Not Found (HTTP 404)" \
  check "a package that does not exist yet is absent" 1 "" "$SCRIPT" "$REF"
DOCKER_EXIT=1 DOCKER_STDERR="ERROR: failed to authorize: 403 Forbidden" GH_EXIT=0 \
  check "a denied pull of an existing package is a failure" 2 "" "$SCRIPT" "$REF"
DOCKER_EXIT=1 DOCKER_STDERR="ERROR: denied: denied" GH_EXIT=1 GH_STDERR="gh: Bad credentials (HTTP 401)" \
  check "a denied pull the API cannot confirm is a failure" 2 "" "$SCRIPT" "$REF"
DOCKER_EXIT=1 DOCKER_STDERR="ERROR: dial tcp: i/o timeout" \
  check "a registry that cannot answer is a failure" 2 "" "$SCRIPT" "$REF"
check "a reference outside ghcr.io is refused" 2 "" "$SCRIPT" "docker.io/library/node:24"
check "a digest reference is refused" 2 "" "$SCRIPT" "ghcr.io/social-harness/router@$DIGEST"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
