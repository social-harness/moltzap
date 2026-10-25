#!/bin/bash
# Exercise push admission against committed-tree responses without git or network.
# The git stub exposes only subject, tip, fragment paths and wire source; assertions
# cover release policy rather than the command sequence used to read that state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
PASS=0
FAIL=0
export GITHUB_SHA=head SUBJECT='fix: user-visible change' TIP=head
export FRAGMENTS=$'changelog.d/template.md\nchangelog.d/+fix.Fixed.md'
export GITHUB_RUN_ATTEMPT=1 RELEASE_PARENT=head RETRY_RELEASE_COMMIT=
export HEAD_WIRE=2026.1021.3 RELEASE_WIRE=2026.1021.3
cat > "$TEMP_DIR/git" <<'MOCK'
#!/bin/bash
set -euo pipefail
case "$1" in
  log)
    if [[ "$3" == --format=%P ]]; then
      printf '%s\n' "$RELEASE_PARENT"
    else
      printf '%s\n' "$SUBJECT"
    fi ;;

  rev-parse) printf '%s\n' "$TIP" ;;
  ls-tree) printf '%s\n' "$FRAGMENTS" ;;
  show)
    case "$2" in
      head:*) printf 'export const WIRE_VERSION = "%s";\n' "$HEAD_WIRE" ;;
      release:*) printf 'export const WIRE_VERSION = "%s";\n' "$RELEASE_WIRE" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$TEMP_DIR/git"
export PATH="$TEMP_DIR:$PATH"

# Compare the admission decision and optional notice with a successful exit.
# Arguments: case name, expected decision, last release, unfinished packages,
# optional notice substring. Globals: SCRIPT_DIR, TEMP_DIR, PASS and FAIL.
check() {
  local name="$1" expected="$2" release="$3" unfinished="$4" notice="${5:-}"
  local actual status=0
  actual=$(bash "$SCRIPT_DIR/push-gate.sh" "$release" "$unfinished" \
    2>"$TEMP_DIR/notice") || status=$?
  if [[ "$status" == 0 && "$actual" == "$expected" ]] &&
    { [[ -z "$notice" ]] || grep -qF "$notice" "$TEMP_DIR/notice"; }; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name — expected $expected with notice '$notice', got $status '$actual'"
    cat "$TEMP_DIR/notice"
    FAIL=$((FAIL + 1))
  fi
}

main() {
  check 'fragment and unchanged wire admit a new release' bump release ''
  FRAGMENTS=changelog.d/template.md check 'template alone skips' skip release ''
  FRAGMENTS='' check 'no fragments skips' skip release ''
  SUBJECT='chore(release): moltzap@2026.1025.1' \
    check 'App release push skips even while publication is unfinished' skip release client
  HEAD_WIRE=2026.1025.0 \
    check 'reset requires a manual dispatch and emits a notice' skip release '' workflow_dispatch
  HEAD_WIRE='' \
    check 'unreadable wire cannot admit a release' skip release '' workflow_dispatch
  check 'missing release baseline requires manual dispatch' skip '' '' workflow_dispatch
  check 'unfinished npm release resumes instead of bumping' resume release client
  FRAGMENTS='' HEAD_WIRE=2026.1025.0 \
    check 'unfinished release resumes despite newer reset changes and no notes' resume release client
  TIP=newer check 'queued push exits cleanly after main moves' skip release ''
  TIP=release check 'queued push resumes a release that overtook it' resume release client
  FRAGMENTS=changelog.d/template.md \
    check 'completed release with consumed fragments does not republish' skip release ''
  check 'next tip with new fragments admits the next version' bump release ''
  GITHUB_RUN_ATTEMPT=2 TIP=newer FRAGMENTS='' \
    check 'completed release rerun retries notification' notify release ''
  GITHUB_RUN_ATTEMPT=2 RELEASE_PARENT=older \
    check 'bump failure rerun retries the new release' bump release ''
  GITHUB_RUN_ATTEMPT=2 RELEASE_PARENT=older RETRY_RELEASE_COMMIT=release \
    check 'publication rerun after main advances retries its notification' notify release ''
  GITHUB_RUN_ATTEMPT=2 \
    check 'unfinished release rerun still resumes publication' resume release client
  GITHUB_RUN_ATTEMPT=2 SUBJECT='chore(release): moltzap@2026.1025.1' \
    check 'App push rerun remains a no-op' skip release ''
  echo "$PASS passed, $FAIL failed"
  [[ "$FAIL" == 0 ]]
}

main "$@"
